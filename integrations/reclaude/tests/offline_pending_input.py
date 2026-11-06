"""Real unmodified CLI with synthetic loopback responses and no outbound network.

NATIVE_CLI selects the binary. NATIVE_COMPAT_OUTPUT must be a new directory.
Linux additionally requires NATIVE_NETWORK_ISOLATED=1 and --network=none.
"""
import copy, hashlib, http.server, json, os, platform, sys, tempfile, threading, time, uuid
from pathlib import Path
sys.path.insert(0, os.environ.get('NATIVE_BRIDGE_DIR', str(Path(__file__).resolve().parents[1])))
from native_bridge_session import Session, ContractError
os.umask(63)
output = os.environ.get('NATIVE_COMPAT_OUTPUT')
root = Path(output).resolve() if output else Path(tempfile.mkdtemp(prefix='reclaude-system-fixture-'))
if output:
    root.mkdir(parents=True, mode=448)
calls = []
reply = ['text']
checks = {}

class Fixture(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def deny(self):
        self.send_response(403)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
    do_CONNECT = do_GET = do_HEAD = deny

    def do_POST(self):
        if self.path.split('?')[0] != '/v1/messages':
            return self.deny()
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append(body)
        i = len(calls)
        blocks = [{'type': 'tool_use', 'id': 'tool_A_' + str(i), 'name': 'mcp__caller__Read', 'input': {'path': 'synthetic-A'}}, {'type': 'tool_use', 'id': 'tool_B_' + str(i), 'name': 'mcp__caller__Read', 'input': {'path': 'synthetic-B'}}] if reply[0] == 'tools' else [{'type': 'text', 'text': ''}]
        events = [{'type': 'message_start', 'message': {'id': 'msg_' + str(i), 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 100 + i, 'output_tokens': 0, 'cache_read_input_tokens': i, 'cache_creation_input_tokens': 3 * i, 'cache_creation': {'ephemeral_5m_input_tokens': i, 'ephemeral_1h_input_tokens': 2 * i}}}}]
        for index, block in enumerate(blocks):
            events.append({'type': 'content_block_start', 'index': index, 'content_block': block})
            if block['type'] == 'text':
                events.append({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'text_delta', 'text': 'SYNTHETIC_REPLY_' + str(i)}})
            events.append({'type': 'content_block_stop', 'index': index})
        events += [{'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if reply[0] == 'tools' else 'end_turn'}, 'usage': {'output_tokens': 10 + i}}, {'type': 'message_stop'}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        for e in events:
            self.wfile.write(('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n').encode())
            self.wfile.flush()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = 'http://127.0.0.1:' + str(server.server_port)
env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'CLAUDE_CONFIG_DIR': str(root / 'profile'), 'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_AUTH_TOKEN': 'offline-fixture-only', 'HTTP_PROXY': url, 'HTTPS_PROXY': url, 'NO_PROXY': '127.0.0.1,localhost,::1', 'LANG': 'C.UTF-8', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'CLAUDE_CODE_MAX_RETRIES': '0', 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK': '1', 'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES': '0'}
policy = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
cli = Path(os.environ['NATIVE_CLI']).resolve(strict=True)
if platform.system() == 'Darwin':
    assert Path('/usr/bin/sandbox-exec').is_file(), 'OS outbound sandbox required'
    command = ['/usr/bin/sandbox-exec', '-p', policy, str(cli), '--setting-sources', '']
elif platform.system() == 'Linux':
    assert os.environ.get('NATIVE_NETWORK_ISOLATED') == '1' and {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}, 'Run in an isolated container with --network=none'
    command = [str(cli), '--setting-sources', '']
else:
    raise RuntimeError('Unsupported OS: outbound network isolation required')
source_root = Path(sys.modules[Session.__module__].__file__).resolve().parent
source_hashes = {p: hashlib.sha256((source_root / p).read_bytes()).hexdigest() for p in ['native_history.py', 'native_bridge_session.py']}
cli_hash = hashlib.sha256(cli.read_bytes()).hexdigest()
base = {'model': 'claude-opus-5-5', 'max_tokens': 1024, 'system': 'SYNTHETIC_SYSTEM', 'messages': [{'role': 'user', 'content': 'SYNTHETIC_ORIGINAL'}], 'tools': [{'name': 'Read', 'input_schema': {'type': 'object', 'properties': {'path': {'type': 'string'}}}}]}
sessions = []

def start(name, body, restore=False, environment=None):
    s = Session(root / name, command, env if environment is None else environment, body,
                timeout=30, restore=restore, history_profile=root / 'profile')
    sessions.append(s)
    return s

def run(s, body):
    n = len(calls)
    events = list(s.request(body))
    assert events[-1]['type'] == 'message_stop'
    time.sleep(0.1)
    assert len(calls) == n + 1, (n, len(calls))
    i = n + 1
    usage = next((e['message']['usage'] for e in events if e['type'] == 'message_start'))
    terminal = next((e['usage'] for e in events if e['type'] == 'message_delta'))
    assert usage == {'input_tokens': 100 + i, 'output_tokens': 0, 'cache_read_input_tokens': i, 'cache_creation_input_tokens': 3 * i, 'cache_creation': {'ephemeral_5m_input_tokens': i, 'ephemeral_1h_input_tokens': 2 * i}}, usage
    assert terminal == {'output_tokens': 10 + i}, terminal
    checks['unique_final_and_cache_usage_on_every_turn'] = True
    return calls[-1]

def positions(wire, marker):
    return [(i, m['role']) for i, m in enumerate(wire['messages']) if marker in json.dumps(m.get('content'))]

def assert_system(wire, marker):
    found = positions(wire, marker)
    assert len(found) == 1 and found[0][1] == 'system', (marker, found)
    assert marker not in json.dumps(wire.get('system'))
    return found[0][0]

def assert_order(wire, markers):
    idx = [positions(wire, m)[0][0] for m in markers]
    assert idx == sorted(idx) and len(set(idx)) == len(idx), (markers, idx)
from native_bridge_session import history_shape

try:
    # Read's path is caller-owned just like Bash's command. Exercise the generic
    # protocol boundary without relying on shell-string equivalence heuristics.
    session = start('pending-input', base)
    reply[0] = 'tools'
    run(session, base)
    original_id = session.native_id
    old_history = copy.deepcopy(session.history)
    following = {**base, 'messages': copy.deepcopy(old_history) + [
        {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': tool, 'content': 'CALLER_EXECUTED_RESULT'}
            for tool in sorted(session.pending_ids)]},
        {'role': 'system', 'content': 'NEW_RESULT_CONTEXT'}]}
    following['messages'][-3]['content'][0]['input'] = {'path': 'caller-normalized-A'}
    session.expire_tool_wait()
    session = start('pending-input', following, True)
    assert history_shape(session.history) == history_shape(old_history)
    before_pending = set((root / 'pending-input').glob('*.pending.json'))
    reply[0] = 'text'
    wire = run(session, following)
    checks['one_new_model_request_per_turn'] = len(calls) == 2
    checks['old_tool_not_executed_again'] = set((root / 'pending-input').glob('*.pending.json')) == before_pending
    checks['caller_context_import_uses_new_native_transcript'] = session.native_id != original_id
    uses = [b for m in wire['messages'] if m['role'] == 'assistant' for b in m['content']
            if b.get('type') == 'tool_use']
    results = [b for m in wire['messages'] if m['role'] == 'user' for b in m['content']
               if b.get('type') == 'tool_result']
    checks['new_caller_input_and_exact_tool_graph'] = (
        len(uses) == len(results) == 2 and uses[0]['input'] == {'path': 'caller-normalized-A'}
        and {b['id'] for b in uses} == {b['tool_use_id'] for b in results})
    assert_system(wire, 'NEW_RESULT_CONTEXT')
    checks['new_system_context_retains_priority'] = True
    adoptions = list((root / 'pending-input/history-adoptions').glob('*.json'))
    checks['original_and_adopted_versions_audited'] = len(adoptions) == 1
    before = len(calls)
    for changed in (following, {**following, 'messages': old_history + following['messages'][-2:]}):
        try:
            list(session.request(changed))
            raise AssertionError('old paid boundary replay accepted')
        except ContractError:
            pass
    checks['original_and_variant_cannot_replay_paid_turn'] = len(calls) == before
    following2 = {**base, 'messages': copy.deepcopy(session.history) + [
        {'role': 'user', 'content': 'CONTINUE_AFTER_ADOPTION'}]}
    run(session, following2)
    checks['subsequent_history_continues'] = len(calls) == 3
    receipt = {'checks': checks, 'fixture_calls': len(calls), 'real_provider_calls': 0,
               'ok': all(checks.values()), 'cli_sha256': cli_hash, 'source_hashes': source_hashes}
    (root / 'receipt.safe.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
    assert receipt['ok']
finally:
    for session in sessions:
        session.close()
    server.shutdown()
    server.server_close()
