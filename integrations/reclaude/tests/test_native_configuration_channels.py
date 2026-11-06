import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import uuid

from native_bridge_session import ContractError, Session, history_shape, signature
from native_session_pool import SessionPool
from native_channel_store import write_json, read_json


class ChannelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.body = {'model': 'opus', 'max_tokens': 64, 'system': 'owned system',
                     'messages': [{'role': 'user', 'content': 'auxiliary query'}],
                     'metadata': {'user_id': str(uuid.uuid4())}}
        self.pool = self.new_pool()

    def new_pool(self, capacity=10):
        def factory(path, body):
            return Session(path, ['unused'], {}, body, restore=True,
                           dispatch_proxy='unused', history_profile=self.root / 'profile')
        return SessionPool(self.root / 'sessions', factory, recover=factory,
                           capacity=capacity, allow_history_import=True,
                           configuration_channels=True)

    def tearDown(self):
        self.pool.close()
        self.temp.cleanup()

    def completed(self, session, body, content='synthetic answer', pending=()):
        # Exercise the real one-grant publisher and real checkpoint writer;
        # the only stand-in is the offline provider's consumed/assistant event.
        session.caller_request_sha = signature(history_shape(body['messages']))
        session.dispatch_process = Mock(poll=lambda: None)
        (session.directory / 'dispatch').mkdir(exist_ok=True)
        session.authorize_dispatch()
        grant = read_json(session.directory / 'dispatch/grant.json')
        record = session.directory / 'dispatch' / (grant['id'] + '.consumed.json')
        write_json(record, grant, exclusive=True)
        session.history = copy.deepcopy(body['messages']) + [{'role': 'assistant', 'content': content}]
        session.pending_ids = set(pending)
        message = str(uuid.uuid4())
        session.assistants[message] = str(uuid.uuid4())
        session.checkpoint('awaiting_tools' if pending else 'idle', session.caller_request_sha, message)
        session.channel_store.complete(session, session.caller_request_sha,
                                       {'input_tokens': 3, 'output_tokens': 2})
        session.dispatch_process = None
        return copy.deepcopy(session.history)

    def test_request_generator_commits_only_observed_terminal_usage(self):
        with self.pool.lease('tenant-a', self.body) as session:
            session.prepare = lambda: None
            message_id = 'msg_synthetic'
            session.assistants[message_id] = str(uuid.uuid4())
            session.dispatch_process = Mock(poll=lambda: None)
            (session.directory / 'dispatch').mkdir()
            def dispatch(blocks):
                session.authorize_dispatch()
                grant = read_json(session.directory / 'dispatch/grant.json')
                write_json(session.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant)
            session.dispatch_user_input = dispatch
            events = [
                {'type': 'message_start', 'message': {'id': message_id, 'type': 'message',
                  'role': 'assistant', 'model': 'opus', 'content': [],
                  'stop_reason': None, 'usage': {'input_tokens': 7, 'output_tokens': 0}}},
                {'type': 'content_block_start', 'index': 0, 'content_block': {'type':'text','text':''}},
                {'type': 'content_block_delta', 'index': 0, 'delta': {'type':'text_delta','text':'verified'}},
                {'type': 'content_block_stop', 'index': 0},
                {'type': 'message_delta', 'delta': {'stop_reason':'end_turn'}, 'usage': {'output_tokens': 3}},
                {'type': 'message_stop'}]
            for event in events:
                session.events.put(event)
            got = list(session.request(self.body))
            self.assertEqual(got[-1]['type'], 'message_stop')
            claim = read_json(next((session.directory / 'caller-grants').glob('*.json')))
            self.assertEqual(claim['state'], 'complete')
            self.assertEqual(claim['terminal_usage'], {'input_tokens': 7, 'output_tokens': 3})
            session.dispatch_process = None

    def test_aux_then_main_models_and_return_preserve_history(self):
        with self.pool.lease('tenant-a', self.body) as aux:
            aux_history = self.completed(aux, self.body)
            original = aux.directory
        main = {**self.body, 'model': 'sonnet', 'messages': [{'role': 'user', 'content': 'main query'}]}
        with self.pool.lease('tenant-a', main) as active:
            self.assertNotEqual(active.directory, original)
            history = self.completed(active, main)
        following = {**main, 'model': 'opus', 'messages': history + [{'role': 'user', 'content': 'continue exactly'}]}
        with self.pool.lease('tenant-a', following) as changed:
            imported, tail = changed.continuation_import(following) or __import__('native_bridge_session').initial_request(following, True)
            self.assertEqual(history_shape(imported), history_shape(history))
            history = self.completed(changed, following)
        returning = {**main, 'messages': history + [{'role': 'user', 'content': 'back to sonnet'}]}
        with self.pool.lease('tenant-a', returning) as restored:
            self.assertIs(restored, active)
            imported, tail = restored.continuation_import(returning)
            self.assertEqual(history_shape(imported), history_shape(history))
        self.assertEqual(aux.history, aux_history)

    def test_claim_precedes_publish_and_unknown_blocks_other_model(self):
        with self.pool.lease('tenant-a', self.body) as session:
            session.caller_request_sha = signature(history_shape(self.body['messages']))
            session.dispatch_process = Mock(poll=lambda: None)
            (session.directory / 'dispatch').mkdir()
            with patch('native_bridge_session.os.replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    session.authorize_dispatch()
            session.dispatch_process = None
            self.assertFalse((session.directory / 'dispatch/grant.json').exists())
            self.assertEqual(len(list((session.directory / 'caller-grants').glob('*.json'))), 1)
        with self.assertRaisesRegex(ContractError, 'evidence_unknown'):
            with self.pool.lease('tenant-a', {**self.body, 'model': 'sonnet'}):
                self.fail('claim may not escape via another model')

    def test_duplicates_and_old_history_cannot_escape_by_model_or_system(self):
        with self.pool.lease('tenant-a', self.body) as session:
            history = self.completed(session, self.body)
        for change in [{'model': 'sonnet'}, {'system': 'new'}, {'max_tokens': 2048},
                       {'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}]:
            with self.subTest(change=change), self.assertRaisesRegex(ContractError, 'already_consumed'):
                with self.pool.lease('tenant-a', {**self.body, **change}):
                    pass
        after = {**self.body, 'messages': history + [{'role': 'user', 'content': 'next'}]}
        with self.pool.lease('tenant-a', after) as session:
            self.completed(session, after)
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', {**after, 'model': 'sonnet'}):
                pass

    def test_restart_retains_dedup_and_uses_original_directory(self):
        with self.pool.lease('tenant-a', self.body) as session:
            history = self.completed(session, self.body)
            original = session.directory
        self.pool.close()
        self.pool = self.new_pool()
        with self.assertRaisesRegex(ContractError, 'already_consumed'):
            with self.pool.lease('tenant-a', self.body):
                pass
        after = {**self.body, 'messages': history + [{'role': 'user', 'content': 'next'}]}
        with self.pool.lease('tenant-a', after) as restored:
            self.assertEqual(restored.directory, original)
            self.assertEqual(history_shape(restored.history), history_shape(history))

    def test_cross_model_busy_and_tenant_isolation(self):
        errors = []
        with self.pool.lease('tenant-a', self.body) as original:
            def other():
                try:
                    with self.pool.lease('tenant-a', {**self.body, 'model': 'sonnet'}):
                        errors.append('admitted')
                except ContractError as error:
                    errors.append(str(error))
            thread = threading.Thread(target=other)
            thread.start(); thread.join(2)
            self.assertEqual(errors, ['session_busy'])
            with self.pool.lease('tenant-b', self.body) as another:
                self.assertNotEqual(another.directory, original.directory)

    def test_second_process_pool_root_is_rejected(self):
        with self.assertRaisesRegex(ContractError, 'already_running'):
            self.new_pool()

    def test_pending_tool_cannot_migrate_and_recovers_exact_result(self):
        tool = {'name': 'Read', 'input_schema': {'type': 'object'}}
        body = {**self.body, 'tools': [tool]}
        with self.pool.lease('tenant-a', body) as session:
            content = [{'type': 'tool_use', 'id': 'call_exact', 'name': 'Read', 'input': {}}]
            history = self.completed(session, body, content, ['call_exact'])
        follow = {**body, 'messages': history + [{'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'call_exact', 'content': 'complete tool result'}]}]}
        with self.assertRaisesRegex(ContractError, 'pending_tools'):
            with self.pool.lease('tenant-a', {**follow, 'model': 'sonnet'}):
                pass
        self.pool.close(); self.pool = self.new_pool()
        with self.pool.lease('tenant-a', follow) as recovered:
            self.assertEqual(recovered.pending_ids, {'call_exact'})
            self.assertEqual(recovered.continuation_import(follow), None)

    def test_failed_and_missing_evidence_never_create_branch(self):
        with self.pool.lease('tenant-a', self.body) as session:
            history = self.completed(session, self.body)
        next_body = {**self.body, 'model': 'sonnet', 'messages': history + [{'role':'user','content':'next'}]}
        session.failed = True
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', next_body):
                pass
        session.failed = False
        next((session.directory / 'caller-grants').glob('*.json')).unlink()
        with self.assertRaisesRegex(ContractError, 'evidence_unknown'):
            with self.pool.lease('tenant-a', next_body):
                pass

    def test_capacity_is_shared_across_models(self):
        self.pool.close(); self.pool = self.new_pool(1)
        with self.pool.lease('tenant-a', self.body) as first:
            history = self.completed(first, self.body)
        main = {**self.body, 'model': 'sonnet', 'messages': [{'role': 'user', 'content':'main'}]}
        with self.pool.lease('tenant-a', main):
            self.assertEqual(len(self.pool.entries), 1)
            self.assertTrue((first.directory / 'continuation.json').exists())

    def test_legacy_directory_retains_original_recovery_without_branch(self):
        self.pool.close()
        from native_channel_policy import logical_key
        key = logical_key('old-tenant', self.body['metadata']['user_id'])
        session = Session(self.root / 'sessions' / key, ['unused'], {}, self.body,
                          history_profile=self.root / 'profile')
        session.checkpoint('prepared')
        session.close(); self.pool = self.new_pool()
        with self.pool.lease('old-tenant', self.body) as restored:
            self.assertEqual(restored.directory.name, key)
            self.assertIsNone(restored.channel_store)
        with self.assertRaisesRegex(ContractError, 'configuration_changed'):
            with self.pool.lease('old-tenant', {**self.body, 'model':'sonnet'}) as restored:
                restored.validate_configuration({**self.body, 'model':'sonnet'})

    def test_per_cli_budget_cannot_be_reset_by_configuration_channel(self):
        from native_channel_store import ChannelStore
        session = Session(self.root / 'budgeted', ['unused'], {}, self.body,
                          dispatch_proxy='unused', history_profile=self.root / 'profile',
                          session_budget_usd=1)
        with self.assertRaisesRegex(ContractError, 'session_budget_unsupported'):
            self.pool.channel_store.attach(session, 'a' * 64)
        self.assertFalse((session.directory / '.configuration-channel.json').exists())

    def test_missing_consumed_evidence_blocks_next_model(self):
        with self.pool.lease('tenant-a', self.body) as session:
            history = self.completed(session, self.body)
            next((session.directory / 'dispatch').glob('*.consumed.json')).unlink()
        next_body = {**self.body, 'model': 'sonnet', 'messages': history +
                     [{'role': 'user', 'content': 'continue exactly'}]}
        with self.assertRaisesRegex(ContractError, 'evidence_unknown'):
            with self.pool.lease('tenant-a', next_body):
                self.fail('missing consumed evidence must not open a fresh paid branch')

    def test_withdrawn_turn_system_hint_preserves_verified_history(self):
        for mode in ['resident', 'restart', 'legacy_restart']:
            with self.subTest(mode=mode):
                body = {**self.body, 'metadata': {'user_id': str(uuid.uuid4())}}
                with self.pool.lease('tenant-a', body) as session:
                    first = self.completed(session, body)
                second = {**body, 'messages': first + [
                    {'role': 'user', 'content': 'second input'},
                    {'role': 'system', 'content': 'TRANSIENT_TOOL_HINT'}]}
                with self.pool.lease('tenant-a', second) as session:
                    history = self.completed(session, second)
                    original_directory = session.directory
                follow = {**body, 'messages': [m for m in history
                    if m['role'] != 'system'] + [
                    {'role': 'user', 'content': 'third input'},
                    {'role': 'system', 'content': 'TRANSIENT_TOOL_HINT'}]}
                path = original_directory / 'continuation.json'
                if mode == 'legacy_restart':
                    state = read_json(path)
                    state.pop('history_controls_sha256', None)
                    write_json(path, state)
                frozen = path.read_bytes()
                if mode != 'resident':
                    self.pool.close()
                    self.pool = self.new_pool()
                with self.pool.lease('tenant-a', follow) as continued:
                    self.assertEqual(continued.directory, original_directory)
                    self.assertEqual(history_shape(continued.history), history_shape(history))
                    self.assertIsNone(continued.continuation_import(follow))
                self.assertEqual(path.read_bytes(), frozen)

    def test_withdrawn_hint_preserves_pending_tool_ids_after_restart(self):
        body = {**self.body, 'tools': [{'name': 'Read', 'input_schema': {'type': 'object'}}],
                'messages': self.body['messages'] + [{'role': 'system', 'content': 'old hint'}]}
        with self.pool.lease('tenant-a', body) as session:
            content = [{'type': 'tool_use', 'id': 'call_exact', 'name': 'Read', 'input': {}}]
            history = self.completed(session, body, content, ['call_exact'])
            original = session.directory
        self.pool.close(); self.pool = self.new_pool()
        follow = {**body, 'messages': [m for m in history if m['role'] != 'system'] + [
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'call_exact',
                                         'content': 'complete tool result'}]},
            {'role': 'system', 'content': 'new turn hint'}]}
        bad = copy.deepcopy(follow)
        bad['messages'][-2]['content'][0]['tool_use_id'] = 'wrong_call'
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', bad):
                self.fail('unknown results must not be dispatched')
        with self.pool.lease('tenant-a', follow) as restored:
            self.assertEqual(restored.directory, original)
            self.assertEqual(restored.pending_ids, {'call_exact'})
            self.assertIsNone(restored.continuation_import(follow))
            prefix = restored.history_prefix(follow['messages'])
            self.assertEqual(follow['messages'][prefix:], follow['messages'][-2:])
            self.assertEqual(len(list((original / 'caller-grants').glob('*.json'))), 1)

    def test_corrupt_control_witness_cannot_fall_back_to_legacy(self):
        body = {**self.body, 'messages': self.body['messages'] + [
            {'role': 'system', 'content': 'private hint'}]}
        with self.pool.lease('tenant-a', body) as session:
            history = self.completed(session, body)
            checkpoint = read_json(session.directory / 'continuation.json')
            path = session.directory / 'history-controls' / (checkpoint['history_sha256'] + '.json')
            path.unlink()
        self.pool.close(); self.pool = self.new_pool()
        follow = {**body, 'messages': history + [{'role': 'user', 'content': 'next'}]}
        with self.assertRaisesRegex(ContractError, 'history_controls_unavailable'):
            with self.pool.lease('tenant-a', follow):
                self.fail('lost evidence must fail closed even for exact input')

    def test_request_delivers_current_hint_and_keeps_one_paid_grant(self):
        import io
        body = {**self.body, 'messages': self.body['messages'] + [
            {'role': 'system', 'content': 'old transient hint'}]}
        with self.pool.lease('tenant-a', body) as session:
            history = self.completed(session, body)
        follow = {**body, 'messages': [m for m in history if m['role'] != 'system'] + [
            {'role': 'user', 'content': 'new caller input'},
            {'role': 'system', 'content': 'current transient hint'}]}
        with self.pool.lease('tenant-a', follow) as session:
            session.prepare = lambda: None
            session.process = Mock(stdin=io.StringIO(), poll=lambda: None)
            session.dispatch_process = Mock(poll=lambda: None)
            message_id = 'msg_current'
            session.assistants[message_id] = str(uuid.uuid4())
            events = [
                {'type': 'message_start', 'message': {'id': message_id, 'type': 'message',
                 'role': 'assistant', 'model': 'opus', 'content': [], 'stop_reason': None,
                 'usage': {'input_tokens': 7, 'output_tokens': 0}}},
                {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'done'}},
                {'type': 'content_block_stop', 'index': 0},
                {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 3}},
                {'type': 'message_stop'}]
            authorize = session.authorize_dispatch
            def consume():
                authorize()
                grant = read_json(session.directory / 'dispatch/grant.json')
                write_json(session.directory / 'dispatch' / (grant['id'] + '.consumed.json'),
                           grant, exclusive=True)
            session.authorize_dispatch = consume
            for event in events:
                session.events.put(event)
            self.assertEqual(list(session.request(follow))[-1]['type'], 'message_stop')
            self.assertEqual(read_json(session.directory / 'context.pending.json'),
                             ['current transient hint'])
            sent = json.loads(session.process.stdin.getvalue())
            self.assertEqual(sent['message']['content'], [{'type': 'text', 'text': 'new caller input'}])
            self.assertEqual(len(list((session.directory / 'dispatch').glob('*.consumed.json'))), 2)
            session.process = session.dispatch_process = None

if __name__ == '__main__':
    unittest.main()
