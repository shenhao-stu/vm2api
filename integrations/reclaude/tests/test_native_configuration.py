import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch, Mock

from native_bridge_session import Session, ContractError, configuration, legacy_configuration, signature


class ConfigurationCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'session'
        self.body = {'model': 'fixture', 'max_tokens': 1024, 'system': 'system',
                     'messages': [{'role': 'user', 'content': 'prompt'}], 'tools': []}
        self.session = Session(self.path, ['unused'], {}, self.body)

    def tearDown(self):
        self.session.close()
        self.temp.cleanup()

    def checkpoint(self, pending=False):
        content = [{'type': 'tool_use', 'id': 'tool_fixture', 'name': 'Read', 'input': {}}] if pending else [{'type': 'text', 'text': 'reply'}]
        self.session.history = self.body['messages'] + [{'role': 'assistant', 'content': content}]
        self.session.assistants['msg_fixture'] = str(uuid.uuid4())
        self.session.checkpoint('awaiting_tools' if pending else 'idle', 'request-hash', 'msg_fixture')
        if pending:
            self.session.pending_ids = {'tool_fixture'}
        return {**self.body, 'messages': self.session.history + [{'role': 'user', 'content': 'next'}]}

    def test_equivalent_defaults_and_cache_annotations_do_not_change_configuration(self):
        equivalent = {**self.body, 'system': [{'type': 'text', 'text': 'system', 'cache_control': {'type': 'ephemeral'}}],
                      'output_config': {'effort': 'medium'}, 'thinking': {'type': 'adaptive'},
                      'tool_choice': {'type': 'auto'}, 'context_management': {'edits': [{'type': 'clear_thinking_20251015', 'keep': 'all'}]}}
        self.assertEqual(configuration(self.body), configuration(equivalent))
        self.session.validate_configuration(equivalent)

    def test_turn_controls_are_validated_without_locking_to_initial_values(self):
        follow = self.checkpoint()
        self.session.validate_configuration({**follow, 'max_tokens': 2048, 'output_config': {'effort': 'high'}})

    def test_changed_history_rejects_before_reconfiguration_or_checkpoint_mutation(self):
        follow = self.checkpoint()
        follow = copy.deepcopy(follow)
        follow['max_tokens'] = 2048
        follow['messages'][0]['content'] = 'wrong owner history'
        saved = (self.path / 'continuation.json').read_bytes()
        with patch.object(self.session, 'close', wraps=self.session.close) as close:
            with self.assertRaisesRegex(ContractError, 'history_prefix_mismatch'):
                list(self.session.request(follow))
            close.assert_not_called()
        self.assertFalse(self.session.failed)
        self.assertEqual((self.path / 'continuation.json').read_bytes(), saved)

    def test_checkpoint_tracks_latest_actual_native_assistant(self):
        self.checkpoint()
        first = self.session.resume_uuid
        latest = str(uuid.uuid4())
        self.session.assistants['next_message'] = latest
        self.session.checkpoint('awaiting_tools', 'second-request', 'next_message')
        self.assertEqual(self.session.resume_uuid, latest)
        self.assertNotEqual(first, latest)
        self.assertEqual(json.loads((self.path / 'continuation.json').read_text())['status'], 'awaiting_tools')

    def test_restore_allows_valid_mutable_controls_but_not_identity_or_context_changes(self):
        follow = self.checkpoint()
        recovered = Session(self.path, ['unused'], {}, {**follow, 'max_tokens': 2048, 'output_config': {'effort': 'high'}}, restore=True)
        self.assertEqual(recovered.native_id, self.session.native_id)
        self.assertEqual(recovered.environment['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '2048')
        self.assertIn('high', recovered.options)
        for change in [{'model': 'different'}, {'system': 'different'}, {'tools': [{'name': 'Other', 'input_schema': {'type': 'object'}}]}]:
            with self.assertRaisesRegex(ContractError, 'history_prefix_mismatch'):
                Session(self.path, ['unused'], {}, {**follow, **change}, restore=True)

    def test_pending_mixed_results_require_exact_ids_before_any_mutation(self):
        follow = self.checkpoint(pending=True)
        follow['max_tokens'] = 2048
        follow['messages'][-1]['content'] = [{'type': 'tool_result', 'tool_use_id': 'another_session', 'content': 'result'}, {'type': 'text', 'text': 'user text'}]
        saved = (self.path / 'continuation.json').read_bytes()
        with self.assertRaisesRegex(ContractError, 'tool_result_set_mismatch'):
            list(self.session.request(follow))
        self.assertEqual(self.session.pending_ids, {'tool_fixture'})
        self.assertFalse(self.session.failed)
        self.assertEqual((self.path / 'continuation.json').read_bytes(), saved)

    def test_legacy_checkpoint_requires_exact_old_configuration_before_migration(self):
        follow = self.checkpoint()
        state = json.loads((self.path / 'continuation.json').read_text())
        state.update(version=1, configuration=signature(legacy_configuration(self.body)))
        state.pop('fixed_configuration')
        state.pop('message_id')
        (self.path / 'continuation.json').write_text(json.dumps(state))
        for change in [{'max_tokens': 2048}, {'system': [{'type': 'text', 'text': 'system'}]}]:
            with self.assertRaisesRegex(ContractError, 'history_prefix_mismatch'):
                Session(self.path, ['unused'], {}, {**follow, **change}, restore=True)
        recovered = Session(self.path, ['unused'], {}, follow, restore=True)
        # A restored CLI can be prewarmed without having dispatched a model.
        recovered.process = Mock()
        recovered.process.poll.return_value = None
        with patch.object(recovered, 'close') as close:
            recovered.restart_for_request({**follow, 'max_tokens': 2048})
            close.assert_called_once()
        self.assertEqual(recovered.native_id, self.session.native_id)
        self.assertIsNone(recovered.process)
        self.assertFalse(recovered.failed)
        self.assertEqual(recovered.environment['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '2048')

    def test_pending_checkpoint_never_restores_as_an_empty_or_completed_session(self):
        follow = self.checkpoint(pending=True)
        with self.assertRaisesRegex(ContractError, 'incomplete_no_replay'):
            Session(self.path, ['unused'], {}, follow, restore=True)


if __name__ == '__main__':
    unittest.main()
