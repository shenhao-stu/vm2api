import copy
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from native_bridge_session import ContractError, Session, initial_request
from native_history import HistoryError, import_plan, write_transcript
from native_session_pool import SessionPool


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.body = {'model': 'fixture', 'max_tokens': 128,
                     'metadata': {'user_id': str(uuid.uuid4())}, 'messages': [
                         {'role': 'user', 'content': 'earlier user'},
                         {'role': 'assistant', 'content': 'earlier answer'},
                         {'role': 'user', 'content': 'new turn'}]}

    def tearDown(self):
        self.temp.cleanup()

    def test_import_is_opt_in_and_does_not_create_or_read_other_sessions(self):
        with self.assertRaisesRegex(ContractError, 'history_not_imported'):
            initial_request(self.body)
        before = copy.deepcopy(self.body)
        prefix, tail = initial_request(self.body, True)
        self.assertEqual([m['role'] for m in prefix], ['user', 'assistant'])
        self.assertEqual(tail, [{'type': 'text', 'text': 'new turn'}])
        self.assertEqual(self.body, before)
        pool = SessionPool(self.root / 'pool',
                           lambda p, b: Session(p, ['unused'], {}, b, history_profile=self.root / 'profile'),
                           allow_history_import=True)
        with pool.lease('tenant-A', self.body) as a, pool.lease('tenant-B', self.body) as b:
            self.assertNotEqual(a.native_id, b.native_id)
            self.assertNotEqual(a.directory, b.directory)
            self.assertIsNone(a.process)
            self.assertEqual(a.history, [])
        pool.close()

    def test_imported_context_never_replaces_a_failed_or_inflight_session(self):
        directory = self.root / 'same'
        s = Session(directory, ['unused'], {}, self.body, history_profile=self.root / 'profile')
        for status in ['in_flight', 'failed', 'awaiting_tools']:
            s.checkpoint(status)
            with self.assertRaises(ContractError):
                Session(directory, ['unused'], {}, self.body, restore=True, history_profile=self.root / 'profile')

    def test_import_requires_exact_complete_tool_results_and_valid_order(self):
        body = copy.deepcopy(self.body)
        body['messages'][1]['content'] = [{'type': 'tool_use', 'id': 't', 'name': 'Read', 'input': {}}]
        for content in ['missing result', [{'type': 'tool_result', 'tool_use_id': 'other', 'content': ''}],
                        [{'type': 'text', 'text': 'bad order'}, {'type': 'tool_result', 'tool_use_id': 't', 'content': ''}]]:
            body['messages'][-1]['content'] = content
            with self.assertRaises(ContractError):
                initial_request(body, True)
        body['messages'][-1]['content'] = [{'type': 'tool_result', 'tool_use_id': 't', 'content': ''}]
        prefix, tail = initial_request(body, True)
        self.assertEqual(tail[0]['tool_use_id'], 't')
        self.assertEqual(prefix[-1]['role'], 'assistant')

    def test_transcript_is_exclusive_private_and_contains_no_reconstructed_telemetry(self):
        identifier = str(uuid.uuid4()); prefix, _ = initial_request(self.body, True)
        last = write_transcript(self.root / 'profile', self.root / 'session', identifier, prefix)
        path = next((self.root / 'profile/projects').glob('*/*.jsonl'))
        rows = [json.loads(x) for x in path.read_text().splitlines()]
        self.assertEqual(rows[-1]['uuid'], last)
        self.assertEqual(rows[1]['parentUuid'], rows[0]['uuid'])
        self.assertEqual([r['message'] for r in rows], prefix)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(any(k in r for r in rows for k in ['usage', 'version', 'machine', 'entrypoint']))
        saved = path.read_bytes()
        with self.assertRaises(FileExistsError):
            write_transcript(self.root / 'profile', self.root / 'session', identifier, prefix)
        self.assertEqual(path.read_bytes(), saved)

    def test_invalid_final_roles_reject_instead_of_regenerating_old_turn(self):
        for messages in [self.body['messages'][:-1], self.body['messages'][1:]]:
            with self.assertRaises(ContractError):
                initial_request({**self.body, 'messages': messages}, True)
