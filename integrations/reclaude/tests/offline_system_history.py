"""Exercise real native CLI against a synthetic loopback provider, never a model.

Set NATIVE_CLI to an unmodified binary, optionally NATIVE_BRIDGE_DIR to the
bridge directory and NATIVE_COMPAT_OUTPUT to a NEW evidence directory.
macOS uses sandbox-exec to deny non-loopback outbound traffic. Linux requires
NATIVE_NETWORK_ISOLATED=1 inside a container started with --network=none; the
script also checks that only the loopback network interface is present.
All profiles, history and credentials are newly synthetic.
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

def follow(s, **fields):
    return {**base, **fields, 'messages': copy.deepcopy(s.history) + [{'role': 'user', 'content': 'SYNTHETIC_FOLLOW'}]}

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
try:
    fresh = {**base, 'messages': [{'role': 'user', 'content': 'FRESH_USER_MARKER'}, {'role': 'system', 'content': 'FRESH_SYSTEM_MARKER'}]}
    f = start('fresh-system', fresh)
    wire = run(f, fresh)
    assert_system(wire, 'FRESH_SYSTEM_MARKER')
    assert_order(wire, ['FRESH_USER_MARKER', 'FRESH_SYSTEM_MARKER'])
    checks['fresh_user_system_preserves_priority_and_order'] = True
    imported = {**base, 'messages': [{'role': 'user', 'content': 'HISTORY_USER_ONE'}, {'role': 'system', 'content': 'HISTORY_SYSTEM_ONE'}, {'role': 'assistant', 'content': 'HISTORY_ASSISTANT_ONE'}, {'role': 'user', 'content': 'HISTORY_USER_TWO'}, {'role': 'system', 'content': 'HISTORY_SYSTEM_TWO'}, {'role': 'assistant', 'content': 'HISTORY_ASSISTANT_TWO'}, {'role': 'user', 'content': 'NEW_USER_THREE'}, {'role': 'system', 'content': 'NEW_TAIL_SYSTEM'}]}
    s = start('history-system', imported)
    before = len(calls)
    s.prepare_request(imported)
    assert len(calls) == before
    checks['prepare_zero_dispatch'] = True
    wire = run(s, imported)
    native = s.native_id
    for marker in ['HISTORY_SYSTEM_ONE', 'HISTORY_SYSTEM_TWO', 'NEW_TAIL_SYSTEM']:
        assert_system(wire, marker)
    assert_order(wire, ['HISTORY_USER_ONE', 'HISTORY_SYSTEM_ONE', 'HISTORY_ASSISTANT_ONE', 'HISTORY_USER_TWO', 'HISTORY_SYSTEM_TWO', 'HISTORY_ASSISTANT_TWO', 'NEW_USER_THREE', 'NEW_TAIL_SYSTEM'])
    checks['imported_systems_exact_order_priority'] = True
    following = {**base, 'messages': copy.deepcopy(s.history) + [{'role': 'user', 'content': 'NEXT_USER_FOUR'}, {'role': 'system', 'content': 'NEXT_SYSTEM_FOUR'}]}
    wire = run(s, following)
    for marker in ['HISTORY_SYSTEM_ONE', 'HISTORY_SYSTEM_TWO', 'NEW_TAIL_SYSTEM', 'NEXT_SYSTEM_FOUR']:
        assert_system(wire, marker)
    assert_order(wire, ['NEW_USER_THREE', 'NEW_TAIL_SYSTEM', 'NEXT_USER_FOUR', 'NEXT_SYSTEM_FOUR'])
    checks['same_session_next_turn_no_hoist_or_duplicate'] = s.native_id == native
    resumed = {**base, 'messages': copy.deepcopy(s.history) + [{'role': 'user', 'content': 'AFTER_EVICTION_USER'}]}
    s.close(graceful=True)
    s = start('history-system', resumed, True)
    wire = run(s, resumed)
    for marker in ['HISTORY_SYSTEM_ONE', 'HISTORY_SYSTEM_TWO', 'NEW_TAIL_SYSTEM', 'NEXT_SYSTEM_FOUR']:
        assert_system(wire, marker)
    assert_order(wire, ['NEW_USER_THREE', 'NEW_TAIL_SYSTEM', 'NEXT_USER_FOUR', 'NEXT_SYSTEM_FOUR', 'AFTER_EVICTION_USER'])
    checks['resume_systems_stay_original_position'] = s.native_id == native
    pending = {**base, 'messages': [{'role': 'user', 'content': 'HIST_TOOL_USER'}, {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'tool_system_history', 'name': 'Read', 'input': {'path': 'synthetic_only'}}]}, {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'tool_system_history', 'content': 'HIST_TOOL_RESULT'}]}, {'role': 'system', 'content': 'SYSTEM_AFTER_TOOL_RESULT'}]}
    z = start('tool-result-system', pending)
    wire = run(z, pending)
    assert_system(wire, 'SYSTEM_AFTER_TOOL_RESULT')
    assert_order(wire, ['HIST_TOOL_RESULT', 'SYSTEM_AFTER_TOOL_RESULT'])
    uses = [b for m in wire['messages'] for b in (m['content'] if isinstance(m['content'], list) else []) if b.get('type') == 'tool_use']
    results = [b for m in wire['messages'] for b in (m['content'] if isinstance(m['content'], list) else []) if b.get('type') == 'tool_result']
    assert len(uses) == len(results) == 1 and uses[0]['id'] == results[0]['tool_use_id'] == 'tool_system_history'
    checks['tool_result_pair_and_system_preserved'] = True
    other = {**base, 'messages': [{'role': 'user', 'content': 'OTHER_TENANT_ONLY'}]}
    o = start('isolated', other)
    wire = run(o, other)
    assert all((x not in json.dumps(wire['messages']) for x in ['HISTORY_SYSTEM', 'NEW_TAIL_SYSTEM', 'NEXT_SYSTEM', 'HIST_TOOL_RESULT']))
    checks['other_session_isolation'] = o.native_id != native
    before = len(calls)
    try:
        list(s.request(resumed))
    except ContractError as exc:
        checks['duplicate_rejected_without_dispatch'] = 'request_already_consumed' in str(exc) and len(calls) == before
    def effort_steps(wire):
        return [m['output_config']['effort'] for m in wire['messages']
                if m.get('role') == 'system' and 'effort' in m.get('output_config', {})]

    assert effort_steps(wire) == ['medium'], effort_steps(wire)
    checks['no_explicit_effort_keeps_default'] = True
    leading = {**base, 'messages': [
        {'role': 'system', 'content': [], 'output_config': {'effort': 'low'}},
        {'role': 'user', 'content': 'LEADING_EFFORT_USER'}]}
    le = start('leading-effort', leading)
    wire = run(le, leading)
    assert effort_steps(wire) == ['low'], effort_steps(wire)
    checks['leading_effort_applies_to_first_turn'] = True

    effort_history = {**base, 'output_config': {'effort': 'high'}, 'messages': [
        {'role': 'system', 'content': [], 'output_config': {'effort': 'low'}},
        {'role': 'user', 'content': 'EFFORT_LOW_USER'},
        {'role': 'assistant', 'content': 'EFFORT_LOW_ASSISTANT'},
        {'role': 'user', 'content': 'EFFORT_HIGH_USER'},
        {'role': 'system', 'content': 'EFFORT_HIGH_SYSTEM', 'output_config': {'effort': 'high'}},
        {'role': 'assistant', 'content': 'EFFORT_HIGH_ASSISTANT'},
        {'role': 'user', 'content': 'EFFORT_MEDIUM_USER'},
        {'role': 'system', 'content': [], 'output_config': {'effort': 'medium'}}]}
    es = start('effort-history', effort_history)
    wire = run(es, effort_history)
    effort_native = es.native_id
    assert effort_steps(wire) == ['low', 'high', 'medium'], effort_steps(wire)
    assert_system(wire, 'EFFORT_HIGH_SYSTEM')
    assert_order(wire, ['EFFORT_LOW_USER', 'EFFORT_LOW_ASSISTANT', 'EFFORT_HIGH_USER', 'EFFORT_HIGH_SYSTEM', 'EFFORT_HIGH_ASSISTANT', 'EFFORT_MEDIUM_USER'])
    checks['historical_effort_boundaries_preserved'] = True

    effort_follow = {**base, 'output_config': {'effort': 'high'}, 'messages': copy.deepcopy(es.history) + [
        {'role': 'system', 'content': [], 'output_config': {'effort': 'high'}},
        {'role': 'user', 'content': 'NEXT_EFFORT_HIGH_USER'}]}
    wire = run(es, effort_follow)
    assert effort_steps(wire) == ['low', 'high', 'medium', 'high'], effort_steps(wire)
    assert es.native_id == effort_native
    checks['changed_effort_before_user_preserves_session_and_history'] = True

    effort_inherit = {**base, 'messages': copy.deepcopy(es.history) + [
        {'role': 'user', 'content': 'INHERIT_EFFORT_HIGH_USER'}]}
    wire = run(es, effort_inherit)
    assert effort_steps(wire) == ['low', 'high', 'medium', 'high'], effort_steps(wire)
    checks['omitted_tail_effort_inherits_last_explicit_control'] = True

    effort_resume = {**base, 'messages': copy.deepcopy(es.history) + [
        {'role': 'user', 'content': 'RESUME_EFFORT_LOW_USER'},
        {'role': 'system', 'content': [], 'output_config': {'effort': 'low'}}]}
    es.close(graceful=True)
    es = start('effort-history', effort_resume, True)
    wire = run(es, effort_resume)
    assert effort_steps(wire) == ['low', 'high', 'medium', 'high', 'low'], effort_steps(wire)
    assert es.native_id == effort_native
    checks['resumed_effort_changes_keep_original_history_and_native_id'] = True

    tool_effort = copy.deepcopy(pending)
    tool_effort['messages'][-1]['output_config'] = {'effort': 'low'}
    te = start('tool-result-effort', tool_effort)
    wire = run(te, tool_effort)
    assert effort_steps(wire) == ['medium'], effort_steps(wire)
    assert wire['output_config']['effort'] == 'medium'
    assert_system(wire, 'SYSTEM_AFTER_TOOL_RESULT')
    uses = [b for m in wire['messages'] for b in (m['content'] if isinstance(m['content'], list) else []) if b.get('type') == 'tool_use']
    results = [b for m in wire['messages'] for b in (m['content'] if isinstance(m['content'], list) else []) if b.get('type') == 'tool_result']
    assert len(uses) == len(results) == 1 and uses[0]['id'] == results[0]['tool_use_id'] == 'tool_system_history'
    checks['tool_result_only_defers_effort_and_preserves_pair'] = True
    tool_native = te.native_id
    deferred_follow = {**base, 'messages': copy.deepcopy(te.history) + [
        {'role': 'user', 'content': 'DEFERRED_EFFORT_NOW_APPLIES'}]}
    wire = run(te, deferred_follow)
    assert effort_steps(wire) == ['medium', 'low'], effort_steps(wire)
    assert wire['output_config']['effort'] == 'low'
    assert te.native_id == tool_native
    assert_system(wire, 'SYSTEM_AFTER_TOOL_RESULT')
    checks['deferred_effort_activates_only_at_new_user_input'] = True

    mixed_effort = copy.deepcopy(tool_effort)
    mixed_effort['messages'][-2]['content'].append({'type': 'text', 'text': 'NEW_INPUT_WITH_TOOL_RESULT'})
    mixed_session = start('mixed-tool-result-effort', mixed_effort)
    wire = run(mixed_session, mixed_effort)
    assert effort_steps(wire) == ['medium', 'low'], effort_steps(wire)
    assert wire['output_config']['effort'] == 'low'
    assert_system(wire, 'SYSTEM_AFTER_TOOL_RESULT')
    assert_order(wire, ['NEW_INPUT_WITH_TOOL_RESULT', 'SYSTEM_AFTER_TOOL_RESULT'])
    checks['mixed_tool_result_and_text_activates_new_effort'] = True
    before = len(calls)
    try:
        list(es.request(effort_resume))
    except ContractError as exc:
        checks['effort_duplicate_rejected_without_dispatch'] = 'request_already_consumed' in str(exc) and len(calls) == before
    assert len(calls) == 14
    checks['fourteen_new_synthetic_requests_no_replay'] = True

    # Explicit thinking displays are mutable controls on the same real native
    # conversation. Returning to the legacy default must drop the old flag.
    td = start('thinking-display', base)
    wire = run(td, base)
    native_default = copy.deepcopy(wire.get('thinking'))
    thinking_native = td.native_id
    default_environment = copy.deepcopy(td.environment)
    previous_pid = td.process.pid
    summarized = {**follow(td), 'thinking': {'type': 'adaptive', 'display': 'summarized'}}
    summarized['messages'][-1]['content'] = 'THINKING_SUMMARIZED_USER'
    wire = run(td, summarized)
    assert wire['thinking']['type'] == 'adaptive' and wire['thinking']['display'] == 'summarized'
    assert wire['output_config']['effort'] == 'medium'
    assert td.native_id == thinking_native and td.process.pid != previous_pid
    assert_order(wire, ['SYNTHETIC_ORIGINAL', 'SYNTHETIC_REPLY_15', 'THINKING_SUMMARIZED_USER'])
    checks['summarized_display_resumes_same_native_history_without_effort_change'] = True

    reply[0] = 'tools'
    omitted = {**follow(td), 'thinking': {'type': 'adaptive', 'display': 'omitted'}}
    omitted['messages'][-1]['content'] = 'THINKING_OMITTED_TOOL_USER'
    wire = run(td, omitted)
    assert wire['thinking']['display'] == 'omitted'
    assert td.native_id == thinking_native and len(td.pending_ids) == 2
    checks['omitted_display_preserves_real_native_tool_use'] = True

    pending_ids = sorted(td.pending_ids)
    previous_pid = td.process.pid
    pure_results = {**follow(td), 'thinking': {'type': 'adaptive', 'display': 'summarized'}}
    pure_results['messages'][-1]['content'] = [
        {'type': 'tool_result', 'tool_use_id': identifier, 'content': 'THINKING_PURE_RESULT_' + str(index)}
        for index, identifier in enumerate(pending_ids)
    ]
    wire = run(td, pure_results)
    assert wire['thinking']['display'] == 'summarized'
    assert td.native_id == thinking_native and td.process.pid != previous_pid
    results = [b for m in wire['messages'] if m['role'] == 'user'
               for b in (m['content'] if isinstance(m['content'], list) else [])
               if b['type'] == 'tool_result' and b['tool_use_id'] in pending_ids]
    assert sorted(b['tool_use_id'] for b in results) == pending_ids
    assert all('THINKING_PURE_RESULT_' + str(i) in json.dumps(results) for i in range(2))
    checks['display_change_on_text_only_tool_results_restarts_without_losing_results'] = True

    pending_ids = sorted(td.pending_ids)
    mixed_display = {**follow(td), 'thinking': {'type': 'adaptive', 'display': 'omitted'}}
    mixed_display['messages'][-1]['content'] = [
        {'type': 'tool_result', 'tool_use_id': identifier, 'content': 'THINKING_RESULT_' + str(index)}
        for index, identifier in enumerate(pending_ids)
    ] + [{'type': 'text', 'text': 'THINKING_MIXED_USER_TEXT'}]
    reply[0] = 'text'
    wire = run(td, mixed_display)
    assert wire['thinking']['display'] == 'omitted'
    results = [b for m in wire['messages'] if m['role'] == 'user'
               for b in (m['content'] if isinstance(m['content'], list) else [])
               if b['type'] == 'tool_result' and b['tool_use_id'] in pending_ids]
    assert sorted(b['tool_use_id'] for b in results) == pending_ids
    assert all('THINKING_RESULT_' + str(i) in json.dumps(results) for i in range(2))
    assert positions(wire, 'THINKING_MIXED_USER_TEXT')[-1][1] == 'user'
    assert td.native_id == thinking_native and not td.pending_ids
    checks['display_change_on_tools_keeps_results_ids_and_user_text'] = True

    default_follow = follow(td)
    default_follow['messages'][-1]['content'] = 'THINKING_DEFAULT_USER'
    wire = run(td, default_follow)
    assert wire.get('thinking') == native_default
    assert '--thinking-display' not in td.native_cli_argv
    assert td.environment == default_environment and td.native_id == thinking_native
    checks['return_to_native_default_has_no_display_flag_or_environment_residue'] = True

    previous_pid = td.process.pid
    legacy_updates = {**follow(td), 'thinking': {'type': 'adaptive', 'display': 'updates'}}
    legacy_updates['messages'][-1]['content'] = 'THINKING_LEGACY_UPDATES_USER'
    wire = run(td, legacy_updates)
    assert wire.get('thinking') == native_default
    assert '--thinking-display' not in td.native_cli_argv and td.process.pid == previous_pid
    assert_order(wire, ['THINKING_SUMMARIZED_USER', 'THINKING_OMITTED_TOOL_USER',
                        'THINKING_MIXED_USER_TEXT', 'THINKING_DEFAULT_USER',
                        'THINKING_LEGACY_UPDATES_USER'])
    checks['legacy_updates_keeps_existing_native_default_without_remapping'] = True

    restored_display = {**follow(td), 'thinking': {'type': 'adaptive', 'display': 'omitted'}}
    restored_display['messages'][-1]['content'] = 'THINKING_RESTORED_DISPLAY_USER'
    td.close(graceful=True)
    td = start('thinking-display', restored_display, True)
    wire = run(td, restored_display)
    assert wire['thinking']['display'] == 'omitted' and td.native_id == thinking_native
    assert_order(wire, ['THINKING_SUMMARIZED_USER', 'THINKING_OMITTED_TOOL_USER',
                        'THINKING_MIXED_USER_TEXT', 'THINKING_DEFAULT_USER',
                        'THINKING_LEGACY_UPDATES_USER', 'THINKING_RESTORED_DISPLAY_USER'])
    checks['default_checkpoint_restores_explicit_display_with_original_history_and_native_id'] = True
    assert len(calls) == 22
    checks['twenty_two_new_synthetic_requests_no_replay'] = True
    td.close(graceful=True)

    # A non-default inherited value also survives an omitted-display round trip.
    updates_key = 'CLAUDE_CODE_THINKING_DISPLAY_UPDATES'
    inherited_environment = {**env, updates_key: 'false'}
    inherited = start('thinking-inherited-env', base, environment=inherited_environment)
    wire = run(inherited, base)
    inherited_default = copy.deepcopy(wire.get('thinking'))
    inherited_native = inherited.native_id
    for display in ('omitted', 'summarized'):
        request = {**follow(inherited), 'thinking': {'type': 'adaptive', 'display': display}}
        request['messages'][-1]['content'] = 'THINKING_INHERITED_' + display.upper()
        wire = run(inherited, request)
        assert wire['thinking']['display'] == display
        assert wire['output_config']['effort'] == 'medium' and inherited.native_id == inherited_native
        assert inherited.environment[updates_key] == ('0' if display == 'omitted' else 'false')
    wire = run(inherited, follow(inherited))
    assert wire.get('thinking') == inherited_default
    assert inherited.environment[updates_key] == inherited_environment[updates_key] == 'false'
    assert '--thinking-display' not in inherited.native_cli_argv
    checks['explicit_nondefault_inherited_environment_survives_display_round_trip'] = True
    assert len(calls) == 26
    checks['twenty_six_new_synthetic_requests_no_replay'] = True
    summary = {'checks': checks, 'fixture_calls': len(calls), 'real_provider_calls': 0, 'os_denies_non_loopback_network': True, 'ok': all(checks.values()), 'cli_sha256': cli_hash, 'candidate_sha256': source_hashes}
    (root / 'calls.synthetic.private.json').write_text(json.dumps(calls, indent=2))
    (root / 'receipt.safe.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))
    assert summary['ok']
finally:
    (root / 'calls.synthetic.private.json').write_text(json.dumps(calls, indent=2))
    for s in sessions:
        s.close()
    server.shutdown()
    server.server_close()
