"""Real CLI + SessionPool with synthetic loopback responses, never paid traffic."""
from pathlib import Path
import os

fixture = Path(__file__).with_name('offline_pending_input.py')
source = fixture.read_text()
source = source[:source.index('\ntry:\n', source.index('def run('))]
exec(compile(source, str(fixture), 'exec'))

from types import SimpleNamespace
from native_session_pool import SessionPool
from native_channel_store import read_json, write_json


class OfflineSession(Session):
    def start_dispatch_proxy(self):
        self.dispatch_address = url
        (self.directory / 'dispatch').mkdir(exist_ok=True)

    def authorize_dispatch(self):
        # Real grant/claim publisher; the synthetic provider consumes one grant.
        self.dispatch_process = SimpleNamespace(poll=lambda: None)
        try:
            super().authorize_dispatch()
            grant = read_json(self.directory / 'dispatch/grant.json')
            write_json(self.directory / 'dispatch' / (grant['id'] + '.consumed.json'),
                       grant, exclusive=True)
        finally:
            self.dispatch_process = None


def factory(path, body):
    return OfflineSession(path, command, env, body, timeout=30, restore=True,
                          dispatch_proxy='synthetic-provider', history_profile=root / 'profile')


def new_pool():
    return SessionPool(root / 'pool', factory, recover=factory, capacity=2,
                       allow_history_import=True, configuration_channels=True)


def evidence(path):
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob('*.json')
            if p.name == 'continuation.json' or p.parent.name in {'caller-grants', 'dispatch'}}


pool = new_pool()
try:
    base['metadata'] = {'user_id': str(uuid.uuid4())}
    with pool.lease('tenant-a', base) as parent:
        run(parent, base)
        common = copy.deepcopy(parent.history)
        parent_path = parent.directory
    background = {**base, 'messages': common + [{'role': 'user', 'content': 'EXCLUDED_BACKGROUND'}]}
    with pool.lease('tenant-a', background) as parent:
        run(parent, background)
        parent_history = copy.deepcopy(parent.history)
        parent_id = parent.native_id
    original = evidence(parent_path)
    edited = {**base, 'messages': copy.deepcopy(common) + [
        {'role': 'user', 'content': 'NEW_CALLER_TURN_AFTER_REWIND'}]}
    edited['messages'][1]['content'] = 'CALLER_EDITED_CONTEXT'
    reply[0] = 'tools'
    with pool.lease('tenant-a', edited) as child:
        wire = run(child, edited)
        child_path = child.directory
        assert child_path != parent_path and child.native_id != parent_id
        assert 'EXCLUDED_BACKGROUND' not in json.dumps(wire['messages'])
        assert 'CALLER_EDITED_CONTEXT' in json.dumps(wire['messages'])
        assert len(child.pending_ids) == 2
        following = {**base, 'messages': copy.deepcopy(child.history) + [{'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': tid, 'content': 'SYNTHETIC_CALLER_RESULT'}
            for tid in sorted(child.pending_ids)]}]}
    reply[0] = 'text'
    with pool.lease('tenant-a', following) as child:
        run(child, following)
        history = copy.deepcopy(child.history)
    assert evidence(parent_path) == original
    pool.close()
    pool = new_pool()
    media = {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png',
             'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}}
    visual = {**base, 'messages': history + [{'role': 'user', 'content': [media]}]}
    with pool.lease('tenant-a', visual) as child:
        assert child.directory == child_path
        wire = run(child, visual)
        assert any(isinstance(b, dict) and b.get('type') == 'image'
                   for m in wire['messages'] for b in m['content'])
        history = copy.deepcopy(child.history)
    doc = {**base, 'messages': history + [{'role': 'user', 'content': [{'type': 'document',
        'source': {'type': 'text', 'media_type': 'text/plain', 'data': 'SYNTHETIC_DOCUMENT'}}]}]}
    with pool.lease('tenant-a', doc) as child:
        assert 'SYNTHETIC_DOCUMENT' in json.dumps(run(child, doc)['messages'])
    assert evidence(parent_path) == original
    parent_next = {**base, 'messages': parent_history + [{'role': 'user', 'content': 'ORIGINAL_BRANCH_NEXT'}]}
    with pool.lease('tenant-a', parent_next) as parent:
        assert parent.directory == parent_path
        wire = run(parent, parent_next)
        assert 'CALLER_EDITED_CONTEXT' not in json.dumps(wire['messages'])
    with pool.lease('tenant-b', edited) as other:
        assert other.directory not in {child_path, parent_path}
        run(other, edited)
    for duplicate in (base, background, edited, following):
        try:
            with pool.lease('tenant-a', duplicate):
                raise AssertionError('paid request admitted twice')
        except ContractError as error:
            assert 'already_consumed' in str(error)
    assert len(calls) == 8
    print(json.dumps({'ok': True, 'cli_sha256': cli_hash, 'paid_provider_requests': 0,
        'cli_stream_terminals': len(calls), 'image_and_document_input': True,
        'one_mock_dispatch_per_turn': True, 'original_checkpoint_retained': True,
        'child_continued': True, 'account_isolation': True, 'pool_restart': True,
        'history_rewind_and_edit': True, 'tools_completed': 2,
        'usage_verified_each_turn': checks['unique_final_and_cache_usage_on_every_turn']}))
finally:
    pool.close()
    server.shutdown()
    server.server_close()
