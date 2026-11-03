import copy
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from native_bridge_session import (ContractError, Session, caller_system, signature,
                                   tool_schema)


class ToolConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'session'
        self.body = {'model': 'fixture', 'max_tokens': 128, 'system': 'original system',
                     'tools': [], 'messages': [{'role': 'user', 'content': 'owned history'}]}
        self.session = Session(self.path, ['unused'], {}, self.body)
        self.session.history = self.body['messages'] + [{'role': 'assistant', 'content': 'done'}]
        self.session.assistants['msg_owned'] = str(uuid.uuid4())
        self.session.checkpoint('idle', 'paid-request', 'msg_owned')
        self.follow = {**self.body,
                       'tools': [{'name': 'Read', 'input_schema': {'type': 'object'}}],
                       'messages': copy.deepcopy(self.session.history) + [{'role': 'user', 'content': 'next'}]}

    def tearDown(self):
        self.session.close()
        self.temp.cleanup()

    def test_new_tools_are_applied_only_at_a_verified_turn_boundary(self):
        self.assertTrue(self.session.validate_configuration(self.follow))
        self.session.restart_for_request(self.follow)
        self.assertEqual(self.session.tools, tool_schema(self.follow['tools']))
        self.assertEqual(json.loads((self.path / 'tools.json').read_text()), self.session.tools)
        self.assertEqual(self.session.native_id, json.loads((self.path / 'continuation.json').read_text())['native_id'])
        self.assertFalse(self.session.failed)

    def test_version_two_checkpoint_verifies_the_saved_tools_before_upgrading(self):
        state = json.loads((self.path / 'continuation.json').read_text())
        state.update(version=2, fixed_configuration=signature({
            'model': self.body['model'], 'system': caller_system(self.body['system']),
            'tools': tool_schema(self.body['tools']),
        }))
        (self.path / 'continuation.json').write_text(json.dumps(state))
        original_tools = (self.path / 'tools.json').read_bytes()
        (self.path / 'tools.json').write_text(json.dumps(tool_schema(self.follow['tools'])))
        with self.assertRaises(ContractError):
            Session(self.path, ['unused'], {}, self.follow, restore=True)
        (self.path / 'tools.json').write_bytes(original_tools)
        recovered = Session(self.path, ['unused'], {}, self.follow, restore=True)
        self.assertEqual(recovered.native_id, self.session.native_id)
        self.assertEqual(recovered.history, self.session.history)
        self.assertEqual(json.loads((self.path / 'continuation.json').read_text())['version'], 2)
        # A crash before the next dispatch must not invalidate the migrated boundary.
        (self.path / 'tools.json').write_text('{interrupted-write')
        again = Session(self.path, ['unused'], {}, self.follow, restore=True)
        self.assertEqual(again.native_id, recovered.native_id)

    def test_new_tools_do_not_relax_model_system_or_history_ownership(self):
        for changed in [{'model': 'another'}, {'system': 'another'}]:
            with self.assertRaisesRegex(ContractError, 'session_configuration_changed'):
                self.session.validate_configuration({**self.follow, **changed})
        changed = copy.deepcopy(self.follow)
        changed['messages'][0]['content'] = 'unowned history'
        saved = (self.path / 'tools.json').read_bytes()
        with self.assertRaisesRegex(ContractError, 'history_prefix_mismatch'):
            list(self.session.request(changed))
        self.assertEqual((self.path / 'tools.json').read_bytes(), saved)


if __name__ == '__main__':
    unittest.main()
