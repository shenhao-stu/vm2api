"""Failure and recovery tests for a sibling of a paid native tool turn."""
import unittest
from unittest.mock import patch

import test_native_configuration_channels as channel_fixture
from native_bridge_session import ContractError
from native_channel_store import read_json, write_json


def assistant(tool_id):
    return {'role': 'assistant', 'content': [
        {'type': 'tool_use', 'id': tool_id, 'name': 'Read', 'input': {}}]}


def tool_result(tool_id):
    return {'role': 'user', 'content': [
        {'type': 'tool_result', 'tool_use_id': tool_id, 'content': 'Synthetic result'}]}


class PaidSiblingFailureTests(unittest.TestCase):
    def setUp(self):
        fixtures = self.fixture = channel_fixture.ChannelTests()
        fixtures.setUp()
        self.addCleanup(fixtures.tearDown)
        self.body = {**fixtures.body, 'tools': [{'name': 'Read', 'input_schema': {'type': 'object'}}]}
        with fixtures.pool.lease('tenant-a', self.body) as session:
            self.parent_key = session.directory.name
            history = fixtures.completed(session, self.body, assistant('original')['content'], pending=('original',))
        self.parent_turn = {**self.body, 'messages': [*history, tool_result('original')]}
        self.child_turn = {**self.body, 'messages': [
            *self.body['messages'], assistant('elsewhere'), tool_result('elsewhere'),
            {'role': 'assistant', 'content': 'Caller-owned history'},
            {'role': 'user', 'content': 'The next turn'},
        ]}

    def restart(self):
        self.fixture.pool.close()
        self.fixture.pool = self.fixture.new_pool()

    def test_pre_dispatch_factory_failure_leaves_the_original_recoverable(self):
        def fail(path, body):
            path.mkdir(mode=0o700)
            (path / 'partial').write_text('no grant')
            raise OSError('synthetic factory failure')

        with patch.object(self.fixture.pool, 'factory', fail), self.assertRaisesRegex(OSError, 'synthetic factory'):
            with self.fixture.pool.lease('tenant-a', self.child_turn):
                self.fail('factory failure admitted a session')
        self.restart()
        self.assertEqual(set(self.fixture.pool.channel_store.document(self.parent_key)['channels']), {self.parent_key})
        with self.fixture.pool.lease('tenant-a', self.parent_turn) as parent:
            self.assertEqual(parent.directory.name, self.parent_key)
        with self.fixture.pool.lease('tenant-a', self.child_turn) as child:
            self.assertNotEqual(child.directory.name, self.parent_key)
            self.assertFalse(list((child.directory / 'dispatch').glob('*.consumed.json')))

    def test_unpublished_prepared_child_recovers_only_without_dispatch_evidence(self):
        store = self.fixture.pool.channel_store
        with patch.object(store, 'register', side_effect=OSError('synthetic pre-publication failure')):
            with self.assertRaises(OSError):
                with self.fixture.pool.lease('tenant-a', self.child_turn):
                    self.fail('publication failure admitted a session')
        targets = [p for p in store.root.iterdir() if p.is_dir() and not p.name.startswith('.') and p.name != self.parent_key]
        self.assertEqual(len(targets), 1)
        directory = targets[0]
        self.assertEqual(read_json(directory / 'continuation.json')['status'], 'prepared')
        dispatch = directory / 'dispatch'
        dispatch.mkdir(exist_ok=True)
        unknown = dispatch / 'synthetic.consumed.json'
        write_json(unknown, {'id': 'unverified'}, exclusive=True)
        self.restart()
        with self.assertRaisesRegex(ContractError, 'native_channel_evidence_unknown'):
            with self.fixture.pool.lease('tenant-a', self.child_turn):
                self.fail('unregistered consumed evidence was ignored')
        self.assertTrue(unknown.is_file())
        with self.fixture.pool.lease('tenant-a', self.parent_turn) as parent:
            self.assertEqual(parent.directory.name, self.parent_key)

    def test_unpublished_child_without_any_grant_can_recover_its_prepared_directory(self):
        store = self.fixture.pool.channel_store
        with patch.object(store, 'register', side_effect=OSError):
            with self.assertRaises(OSError):
                with self.fixture.pool.lease('tenant-a', self.child_turn):
                    self.fail('unpublished sibling admitted')
        self.restart()
        with self.fixture.pool.lease('tenant-a', self.child_turn) as child:
            self.assertTrue(child.prepared)
            self.assertEqual(child.directory.name, read_json(child.directory / '.configuration-channel.json')['channel'])
            self.assertEqual(list((child.directory / 'caller-grants').glob('*.json')), [])

    def test_child_pending_allows_independent_context_and_both_sides_recover(self):
        h = self.fixture
        with h.pool.lease('tenant-a', self.child_turn) as child:
            child_key = child.directory.name
            history = h.completed(child, self.child_turn, assistant('childPending')['content'], pending=('childPending',))
        self.restart()
        with h.pool.lease('tenant-a', self.parent_turn) as parent:
            self.assertEqual(parent.directory.name, self.parent_key)
            parent_history = h.completed(parent, self.parent_turn)
        unrelated = {**self.body, 'model': 'sonnet', 'messages': [{'role': 'user', 'content': 'Independent task'}]}
        with h.pool.lease('tenant-a', unrelated) as independent:
            self.assertNotIn(independent.directory.name, {child_key, self.parent_key})
        self.assertEqual(len(h.pool.channel_store.document(self.parent_key)['channels']), 3)
        self.restart()
        with h.pool.lease('tenant-a', {**self.body, 'messages': [*history, tool_result('childPending')]}) as child:
            self.assertEqual(child.directory.name, child_key)
            self.assertEqual(child.pending_ids, {'childPending'})
        with h.pool.lease('tenant-a', {**self.body, 'messages': [*parent_history, {'role':'user','content':'Continue'}]}) as parent:
            self.assertEqual(parent.directory.name, self.parent_key)

    def test_modified_first_request_witness_cannot_select_the_child(self):
        store = self.fixture.pool.channel_store
        with self.fixture.pool.lease('tenant-a', self.child_turn) as child:
            key = child.directory.name
        path = store.directory / (self.parent_key + '.json')
        document = read_json(path)
        document['channels'][key]['paid_sibling'] = {
            'parent': self.parent_key, 'paid_input': '0' * 64, 'paid_history': '0' * 64,
            'alternate_assistant': '0' * 64, 'assistant_offset': 0, 'user_blocks': 0,
            'first_request': '0' * 64}

        write_json(path, document)
        self.restart()
        with self.assertRaisesRegex(ContractError, 'native_channel_evidence_unknown'):
            with self.fixture.pool.lease('tenant-a', self.child_turn):
                self.fail('invalid first-request witness admitted')


if __name__ == '__main__':
    unittest.main()
