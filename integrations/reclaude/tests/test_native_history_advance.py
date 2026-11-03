import copy
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from native_bridge_session import ContractError, Session


class HistoryAdvanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.body = {'model': 'fixture', 'system': 'owner system', 'max_tokens': 128,
                     'tools': [{'name': 'Read', 'input_schema': {'type': 'object'}}],
                     'messages': [{'role': 'user', 'content': 'owned request'}]}
        self.session = Session(self.root / 'session', ['unused'], {}, self.body,
                               history_profile=self.root / 'profile')
        self.session.history = copy.deepcopy(self.body['messages']) + [
            {'role': 'assistant', 'content': 'completed owned answer'}]
        self.session.assistants['msg_paid'] = str(uuid.uuid4())
        self.session.checkpoint('idle', 'paid-request', 'msg_paid')
        self.follow = {**self.body, 'messages': copy.deepcopy(self.session.history) + [
            {'role': 'user', 'content': 'completed elsewhere'},
            {'role': 'assistant', 'content': 'external answer'},
            {'role': 'user', 'content': 'one new turn'}]}

    def tearDown(self):
        self.session.close()
        self.temp.cleanup()

    def test_only_verified_extension_is_imported_without_dispatch(self):
        saved = (self.session.directory / 'continuation.json').read_bytes()
        imported, tail = self.session.continuation_import(self.follow)
        self.assertEqual(len(imported), 4)
        self.assertEqual(tail, [{'type': 'text', 'text': 'one new turn'}])
        self.assertIsNone(self.session.process)
        self.assertEqual((self.session.directory / 'continuation.json').read_bytes(), saved)

    def test_changed_prefix_invalid_graph_and_disabled_import_are_rejected(self):
        changed = copy.deepcopy(self.follow)
        changed['messages'][0]['content'] = 'other owner'
        bad_graph = copy.deepcopy(self.follow)
        bad_graph['messages'][3]['content'] = [
            {'type': 'tool_use', 'id': 't', 'name': 'Read', 'input': {}}]
        for body in [changed, bad_graph, {**self.follow, 'messages': self.follow['messages'][:-1]}]:
            with self.assertRaises(ContractError):
                self.session.continuation_import(body)
        self.session.history_profile = None
        with self.assertRaisesRegex(ContractError, 'unsupported_history_tail'):
            self.session.continuation_import(self.follow)

    def test_pending_boundary_can_restore_complete_external_tool_history(self):
        self.session.history[-1]['content'] = [
            {'type': 'tool_use', 'id': 'owned_tool', 'name': 'Read', 'input': {}}]
        self.session.pending_ids = {'owned_tool'}
        self.session.checkpoint('awaiting_tools', 'paid-request', 'msg_paid')
        follow = {**self.follow, 'messages': copy.deepcopy(self.session.history) + [
            {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 'owned_tool', 'content': 'external result'}]},
            {'role': 'assistant', 'content': 'completed externally'},
            {'role': 'user', 'content': 'one new turn'}]}
        recovered = Session(self.session.directory, ['unused'], {}, follow, restore=True,
                            history_profile=self.root / 'profile')
        self.assertEqual(recovered.native_id, self.session.native_id)
        self.assertEqual(recovered.pending_ids, {'owned_tool'})
        imported, tail = recovered.continuation_import(follow)
        self.assertEqual(len(imported), 4)
        self.assertEqual(tail, [{'type': 'text', 'text': 'one new turn'}])
        changed = copy.deepcopy(follow)
        changed['messages'][2]['content'][0]['tool_use_id'] = 'different_tool'
        with self.assertRaises(ContractError):
            Session(self.session.directory, ['unused'], {}, changed, restore=True,
                    history_profile=self.root / 'profile')

    def test_unfinished_paid_turn_cannot_be_replaced_by_caller_history(self):
        for status in ['failed', 'in_flight', 'native_resume_point_missing']:
            self.session.checkpoint(status)
            with self.assertRaisesRegex(ContractError, 'incomplete_no_replay'):
                Session(self.session.directory, ['unused'], {}, self.follow, restore=True,
                        history_profile=self.root / 'profile')


if __name__ == '__main__':
    unittest.main()
