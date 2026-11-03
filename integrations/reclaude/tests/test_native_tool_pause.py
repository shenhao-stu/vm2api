import copy
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from native_bridge_session import ContractError, Session
from native_session_pool import Entry, idle


class ToolPauseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'session'
        self.body = {
            'model': 'fixture', 'max_tokens': 128, 'system': 'owner system',
            'tools': [{'name': 'Read', 'input_schema': {'type': 'object'}}],
            'messages': [{'role': 'user', 'content': 'new request'}],
        }
        self.session = Session(self.path, ['unused'], {}, self.body)
        self.session.history = self.body['messages'] + [{'role': 'assistant', 'content': [
            {'type': 'tool_use', 'id': 'tool_owned', 'name': 'Read', 'input': {}},
        ]}]
        self.session.pending_ids = {'tool_owned'}
        self.session.assistants['msg_paid'] = str(uuid.uuid4())
        self.session.checkpoint('awaiting_tools', 'paid-request', 'msg_paid')
        self.follow = {**self.body, 'messages': copy.deepcopy(self.session.history) + [
            {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 'tool_owned', 'content': 'new result'},
            ]},
        ]}

    def tearDown(self):
        self.session.close()
        self.temp.cleanup()

    def test_completed_tool_wait_suspends_without_destroying_paid_boundary(self):
        saved = (self.path / 'continuation.json').read_bytes()
        self.session.expire_tool_wait()
        self.assertFalse(self.session.failed)
        self.assertTrue(self.session.suspended)
        self.assertEqual(self.session.pending_ids, {'tool_owned'})
        self.assertEqual((self.path / 'continuation.json').read_bytes(), saved)
        self.assertTrue(idle(Entry(self.session, 0)))
        self.assertFalse(idle(Entry(self.session, 0, busy=True)))

    def test_restore_preserves_pending_results_and_native_identity(self):
        recovered = Session(self.path, ['unused'], {}, self.follow, restore=True)
        self.assertEqual(recovered.pending_ids, {'tool_owned'})
        self.assertTrue(recovered.suspended)
        self.assertEqual(recovered.native_id, self.session.native_id)
        self.assertEqual(recovered.resume_uuid, self.session.resume_uuid)
        self.assertEqual(recovered.seen, {'paid-request'})
        self.assertIsNone(recovered.process)

    def test_changed_history_or_unknown_paid_state_cannot_resume(self):
        changed = copy.deepcopy(self.follow)
        changed['messages'][0]['content'] = 'different owner history'
        with self.assertRaisesRegex(ContractError, 'history_prefix_mismatch'):
            Session(self.path, ['unused'], {}, changed, restore=True)
        for status in ['in_flight', 'failed']:
            self.session.checkpoint(status)
            with self.assertRaisesRegex(ContractError, 'incomplete_no_replay'):
                Session(self.path, ['unused'], {}, self.follow, restore=True)

    def test_pending_checkpoint_without_tool_calls_does_not_restore(self):
        self.session.history[-1]['content'] = [{'type': 'text', 'text': 'finished'}]
        self.session.checkpoint('awaiting_tools', 'paid-request', 'msg_paid')
        body = {**self.follow, 'messages': self.session.history + self.follow['messages'][-1:]}
        with self.assertRaisesRegex(ContractError, 'incomplete_no_replay'):
            Session(self.path, ['unused'], {}, body, restore=True)


if __name__ == '__main__':
    unittest.main()
