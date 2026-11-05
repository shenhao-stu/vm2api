"""Real unmodified CLI, synthetic SSE and profiles, OS-denied provider access.

NATIVE_CLI selects the official executable. NATIVE_COMPAT_OUTPUT must be a new
directory. No ReClaude login, OAuth, live relay, or provider is used here.
"""
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.environ.get('NATIVE_BRIDGE_DIR', str(Path(__file__).resolve().parents[1])))
from native_bridge_session import ContractError, Session

os.umask(0o077)
output = os.environ.get('NATIVE_COMPAT_OUTPUT')
root = Path(output) if output else Path(tempfile.mkdtemp(prefix='native-cache-ttl-'))
if output:
    root.mkdir(mode=0o700, parents=True)
calls, sessions, checks = [], [], {}
lock = threading.Lock()


def markers(body):
    """Only protocol annotations; never descend into tool input/schema data."""
    found = []

    def blocks(items, path):
        for i, block in enumerate(items if isinstance(items, list) else []):
            name = f'{path}.{i}'
            if 'cache_control' in block:
                found.append({'path': name, **block['cache_control']})
            if block.get('type') in {'tool_result', 'search_result'}:
                blocks(block.get('content'), name + '.content')

    blocks(body.get('system'), 'system')
    blocks(body.get('tools'), 'tools')
    for i, message in enumerate(body.get('messages', [])):
        blocks(message.get('content'), f'messages.{i}.content')
    return found


class Fixture(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def deny(self):
        self.send_response(403)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()

    do_GET = do_HEAD = do_CONNECT = deny

    def do_POST(self):
        if self.path.split('?')[0] != '/v1/messages':
            return self.deny()
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            calls.append(body)
            index = len(calls)
        tool = 'FIXTURE_TOOL_FIRST' in json.dumps(body['messages']) and not any(
            b.get('type') == 'tool_result'
            for m in body['messages'] for b in m['content'] if isinstance(b, dict))
        block = ({'type': 'tool_use', 'id': f'tool_{index}',
                  'name': 'mcp__caller__Read', 'input': {'path': 'fixture'}}
                 if tool else {'type': 'text', 'text': ''})
        # Deliberately mixed synthetic usage proves that no TTL bucket is renamed.
        usage = {'input_tokens': 101, 'output_tokens': 0,
                 'cache_creation_input_tokens': 5, 'cache_read_input_tokens': 7,
                 'cache_creation': {'ephemeral_5m_input_tokens': 2,
                                    'ephemeral_1h_input_tokens': 3}}
        events = [
            {'type': 'message_start', 'message': {'type': 'message', 'role': 'assistant',
             'id': f'msg_{index}', 'model': body['model'], 'content': [],
             'stop_reason': None, 'usage': usage}},
            {'type': 'content_block_start', 'index': 0, 'content_block': block},
        ]
        if not tool:
            events.append({'type': 'content_block_delta', 'index': 0,
                           'delta': {'type': 'text_delta', 'text': 'FIXTURE_ONLY'}})
        events.extend([
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if tool else 'end_turn'},
             'usage': {'output_tokens': 11}},
            {'type': 'message_stop'},
        ])
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        try:
            for event in events:
                self.wfile.write(('event: ' + event['type'] + '\ndata: '
                                 + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = 'http://127.0.0.1:' + str(server.server_port)
env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'),
       'CLAUDE_CONFIG_DIR': str(root / 'profile'), 'ANTHROPIC_BASE_URL': url,
       'ANTHROPIC_AUTH_TOKEN': 'offline-fixture-only', 'HTTP_PROXY': url,
       'HTTPS_PROXY': url, 'NO_PROXY': '127.0.0.1,localhost,::1', 'LANG': 'C.UTF-8',
       'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
       'ENABLE_PROMPT_CACHING_1H': '1', 'FORCE_PROMPT_CACHING_5M': '1'}
cli = Path(os.environ['NATIVE_CLI']).resolve(strict=True)
if platform.system() == 'Darwin':
    command = ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)'
               '(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
               str(cli), '--setting-sources', '']
elif platform.system() == 'Linux':
    assert os.environ.get('NATIVE_NETWORK_ISOLATED') == '1'
    assert {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}
    command = [str(cli), '--setting-sources', '']
else:
    raise RuntimeError('Outbound OS isolation required')


def body(ttl=None, text='FIXTURE_USER'):
    control = {'type': 'ephemeral', **({'ttl': ttl} if ttl else {})}
    return {'model': 'claude-fable-5-1', 'max_tokens': 1024,
            'system': [{'type': 'text', 'text': 'FIXTURE_SYSTEM', 'cache_control': control}],
            'tools': [{'name': 'Read', 'input_schema': {'type': 'object',
                       'properties': {'path': {'type': 'string'}}}}],
            'messages': [{'role': 'user', 'content': text}]}


def start(name, request, restore=False):
    session = Session(root / name, command, env, request, timeout=30,
                      restore=restore, history_profile=root / 'profile')
    sessions.append(session)
    return session


def turn(session, request, ttl):
    events = list(session.request(request))
    assert events[-1]['type'] == 'message_stop'
    usage = next(e['message']['usage'] for e in events if e['type'] == 'message_start')
    assert usage['cache_creation'] == {'ephemeral_5m_input_tokens': 2, 'ephemeral_1h_input_tokens': 3}
    assert next(e['usage']['output_tokens'] for e in events if e['type'] == 'message_delta') == 11
    # The billing/session metadata connects this actual native wire to this CLI.
    matches = [w for w in calls if w.get('metadata', {}).get('user_id', '').find(session.native_id) >= 0]
    assert matches, 'Native session identifier not found on fixture wire'
    wire = matches[-1]
    points = markers(wire)
    assert points and all(p.get('ttl', '5m') == ttl for p in points), points
    return events


try:
    short_body, long_body = body('5m'), body()
    short, long = start('short', short_body), start('long', long_body)
    with ThreadPoolExecutor(max_workers=2) as workers:
        jobs = [workers.submit(turn, short, short_body, '5m'),
                workers.submit(turn, long, long_body, '1h')]
        for job in jobs:
            job.result()
    checks['concurrent_ttl_and_session_isolation'] = short.native_id != long.native_id
    checks['explicit_5m_and_missing_default_1h_actual_wire'] = True
    pid = short.process.pid
    following = {**short_body, 'messages': copy.deepcopy(short.history) +
                 [{'role': 'user', 'content': 'FIXTURE_SAME_TTL_NEXT'}]}
    turn(short, following, '5m')
    checks['same_ttl_reuses_cli'] = short.process.pid == pid

    # The default configuration retains the pre-TTL fixed hash; resume it at 5m.
    original = long.native_id
    long.close(graceful=True)
    following = {**body('5m'), 'messages': copy.deepcopy(long.history) +
                 [{'role': 'user', 'content': 'FIXTURE_AFTER_EVICTION'}]}
    resumed = start('long', following, restore=True)
    turn(resumed, following, '5m')
    checks['old_default_checkpoint_resumes_same_native_id'] = resumed.native_id == original

    tool_body = body('5m', 'FIXTURE_TOOL_FIRST')
    tool = start('tool', tool_body)
    turn(tool, tool_body, '5m')
    pid, original = tool.process.pid, tool.native_id
    dispatch = tool.directory / 'dispatch'
    dispatch.mkdir(exist_ok=True)
    sentinel = dispatch / 'fixture.consumed.json'
    sentinel.write_text('synthetic consumed boundary; never clear')
    sentinel_bytes = sentinel.read_bytes()
    following = {**body('1h'), 'messages': copy.deepcopy(tool.history) +
                 [{'role': 'user', 'content': [{'type': 'tool_result',
                   'tool_use_id': value, 'content': 'FIXTURE_TOOL_RESULT'}
                  for value in sorted(tool.pending_ids)]}]}
    turn(tool, following, '1h')
    checks['tool_ttl_change_resumes_same_session_at_boundary'] = tool.native_id == original and tool.process.pid != pid
    checks['consumed_sentinel_preserved'] = sentinel.read_bytes() == sentinel_bytes
    checks['synthetic_usage_buckets_preserved'] = True

    before = len(calls)
    state_bytes = (tool.directory / 'continuation.json').read_bytes()
    mixed = {**following, 'messages': copy.deepcopy(tool.history) + [{'role': 'user',
             'content': [{'type': 'text', 'text': 'FIXTURE_REJECT',
                          'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}]}]}
    try:
        list(tool.request(mixed))
        raise AssertionError('Mixed TTL silently accepted')
    except ContractError as exc:
        assert str(exc) == 'cache_ttl_mixed_unsupported', str(exc)
    checks['mixed_rejects_without_dispatch_or_poison'] = not tool.failed and len(calls) == before and (tool.directory / 'continuation.json').read_bytes() == state_bytes
    # Cancellation after an actual fixture POST remains consumed/failed; a TTL
    # change never provides a way to retry or clear that boundary.
    cancelled = {**body('5m'), 'messages': copy.deepcopy(tool.history) +
                 [{'role': 'user', 'content': 'FIXTURE_CANCEL_ONLY'}]}
    iterator = tool.request(cancelled)
    assert next(iterator)['type'] == 'message_start'
    iterator.close()
    before = len(calls)
    try:
        list(tool.request(cancelled))
        raise AssertionError('Cancelled turn replayed')
    except ContractError as exc:
        assert str(exc) == 'session_failed_no_replay', str(exc)
    checks['cancel_keeps_failure_and_consumed_boundary'] = tool.failed and len(calls) == before and sentinel.read_bytes() == sentinel_bytes
    checks['exactly_seven_synthetic_model_posts'] = len(calls) == 7
    receipt = {'checks': checks, 'real_provider_calls': 0, 'fixture_calls': len(calls),
               'cli_sha256': hashlib.sha256(cli.read_bytes()).hexdigest(),
               'wire_cache_controls': [markers(w) for w in calls],
               'ok': all(checks.values())}
    (root / 'receipt.safe.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
    assert receipt['ok']
finally:
    for session in sessions:
        session.close()
    server.shutdown()
    server.server_close()
