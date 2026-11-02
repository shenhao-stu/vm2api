"""Messages API system turns must keep their role and chronological position."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from native_bridge_session import (ContractError, Session, effective_effort, history_shape, initial_request,
                                   initial_system, native_options)
from native_history import trailing_system_text, write_transcript


class SystemHistoryTests(unittest.TestCase):
    def body(self, messages):
        return {'model': 'claude-opus-5-5', 'max_tokens': 128,
                'system': 'GLOBAL_POLICY', 'messages': messages}

    def test_import_keeps_historical_system_between_user_and_assistant(self):
        body = self.body([
            {'role': 'user', 'content': 'EARLIER_USER'},
            {'role': 'system', 'content': 'LATER_POLICY'},
            {'role': 'assistant', 'content': 'EARLIER_ANSWER'},
            {'role': 'user', 'content': 'NEW_USER'},
        ])
        original = copy.deepcopy(body)
        prefix, tail = initial_request(body, True)
        self.assertEqual([m['role'] for m in prefix], ['user', 'system', 'assistant'])
        self.assertEqual(prefix[1]['content'], [{'type': 'text', 'text': 'LATER_POLICY'}])
        self.assertEqual(tail, [{'type': 'text', 'text': 'NEW_USER'}])
        self.assertEqual(body, original)

    def test_import_accepts_system_after_new_user_without_demoting_it(self):
        body = self.body([
            {'role': 'user', 'content': 'EARLIER_USER'},
            {'role': 'assistant', 'content': 'EARLIER_ANSWER'},
            {'role': 'user', 'content': 'NEW_USER'},
            {'role': 'system', 'content': 'NEW_POLICY'},
        ])
        prefix, tail = initial_request(body, True)
        self.assertEqual([m['role'] for m in prefix], ['user', 'assistant'])
        self.assertEqual(tail, [{'type': 'text', 'text': 'NEW_USER'}])
        self.assertEqual(trailing_system_text(history_shape(body['messages'])), ['NEW_POLICY'])

    def test_mid_conversation_system_does_not_move_to_initial_system(self):
        body = self.body([
            {'role': 'user', 'content': 'USER'},
            {'role': 'system', 'content': 'LATER_POLICY'},
        ])
        self.assertEqual(initial_system(body), 'GLOBAL_POLICY')

    def test_history_writer_uses_native_system_attachment_and_preserves_parents(self):
        body = self.body([
            {'role': 'user', 'content': 'USER'},
            {'role': 'system', 'content': 'HISTORICAL_POLICY'},
            {'role': 'assistant', 'content': 'ANSWER'},
            {'role': 'user', 'content': 'NEW_USER'},
        ])
        prefix, _ = initial_request(body, True)
        with tempfile.TemporaryDirectory() as root:
            profile = Path(root) / 'profile'
            write_transcript(profile, Path(root) / 'session', str(uuid.uuid4()), prefix)
            rows = [json.loads(line) for line in next(profile.glob('projects/*/*.jsonl')).read_text().splitlines()]
        self.assertEqual([r['type'] for r in rows], ['user', 'attachment', 'assistant'])
        self.assertEqual(rows[1]['renderedRole'], 'system')
        self.assertEqual(rows[1]['rendered'], [{'content': 'HISTORICAL_POLICY'}])
        self.assertEqual(rows[2]['parentUuid'], rows[1]['uuid'])
        self.assertEqual(rows[1]['parentUuid'], rows[0]['uuid'])
        self.assertFalse(any('usage' in r for r in rows))

    def test_unsupported_system_controls_cannot_be_silently_dropped(self):
        for extra in [{'output_config': {'timing': 'now'}}, {'clear_at': 'next_user_message'}]:
            body = self.body([{'role': 'user', 'content': 'USER'},
                              {'role': 'system', 'content': 'POLICY', **extra}])
            with self.assertRaisesRegex(ContractError, 'unsupported_system_message_control'):
                native_options(body)

    def test_effort_only_system_controls_apply_to_the_new_turn(self):
        body = self.body([{'role': 'user', 'content': 'USER'},
                          {'role': 'assistant', 'content': 'ANSWER'},
                          {'role': 'system', 'content': [], 'output_config': {'effort': 'high'}},
                          {'role': 'user', 'content': 'NEXT'}])
        _, options = native_options(body)
        self.assertEqual(options, ['--effort', 'high'])
        prefix, tail = initial_request(body, True)
        self.assertEqual(tail, [{'type': 'text', 'text': 'NEXT'}])

    def test_history_effort_is_recorded_per_assistant_without_inventing_usage(self):
        body = self.body([
            {'role': 'system', 'content': [], 'output_config': {'effort': 'low'}},
            {'role': 'user', 'content': 'USER1'}, {'role': 'assistant', 'content': 'ANSWER1'},
            {'role': 'system', 'content': [], 'output_config': {'effort': 'high'}},
            {'role': 'user', 'content': 'USER2'}, {'role': 'assistant', 'content': 'ANSWER2'},
            {'role': 'user', 'content': 'USER3'},
            {'role': 'system', 'content': [], 'output_config': {'effort': 'medium'}},
        ])
        prefix, _ = initial_request(body, True)
        self.assertEqual(effective_effort(body), 'medium')
        self.assertEqual(effective_effort(body, leading_only=True), 'low')
        with tempfile.TemporaryDirectory() as root:
            profile = Path(root) / 'profile'
            write_transcript(profile, Path(root) / 'session', str(uuid.uuid4()), prefix,
                             initial_effort=effective_effort(body, leading_only=True))
            rows = [json.loads(line) for line in next(profile.glob('projects/*/*.jsonl')).read_text().splitlines()]
        self.assertEqual([r['perTurnEffort'] for r in rows if r['type'] == 'assistant'], ['low', 'high'])
        self.assertEqual([r['type'] for r in rows], ['user', 'assistant', 'user', 'assistant'])
        self.assertFalse(any('usage' in r or 'usage' in r.get('message', {}) for r in rows))

    def test_invalid_effort_type_is_a_contract_error_before_dispatch(self):
        for effort in [None, [], {}, True, 3, 'unknown']:
            for field in ['top', 'message']:
                body = self.body([{'role': 'user', 'content': 'USER'}])
                if field == 'top':
                    body['output_config'] = {'effort': effort}
                else:
                    body['messages'].append({'role': 'system', 'content': [], 'output_config': {'effort': effort}})
                with self.subTest(effort=effort, field=field), self.assertRaises(ContractError):
                    native_options(body)

    def test_consecutive_effort_and_text_share_text_placement_rules(self):
        body = self.body([{'role': 'user', 'content': 'USER'},
                          {'role': 'assistant', 'content': 'ANSWER'},
                          {'role': 'system', 'content': [], 'output_config': {'effort': 'high'}},
                          {'role': 'system', 'content': 'WRONG_POSITION'},
                          {'role': 'user', 'content': 'NEXT'}])
        with self.assertRaisesRegex(ContractError, 'invalid_system_message_position'):
            native_options(body)

    def test_effort_after_only_tool_results_waits_for_new_user_input(self):
        body = self.body([
            {'role': 'user', 'content': 'USER'},
            {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 't', 'name': 'Read', 'input': {}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 't', 'content': 'RESULT'}]},
            {'role': 'system', 'content': [], 'output_config': {'effort': 'high'}},
        ])
        body['output_config'] = {'effort': 'low'}
        self.assertEqual(native_options(body)[1], ['--effort', 'low'])
        body['messages'] += [{'role': 'assistant', 'content': 'RESULT_ANSWER'},
                             {'role': 'user', 'content': 'NEW_INPUT'}]
        self.assertEqual(native_options(body)[1], ['--effort', 'high'])
        body['messages'] += [{'role': 'assistant', 'content': 'NEW_ANSWER'},
                             {'role': 'user', 'content': 'NEXT_INPUT'}]
        prefix, _ = initial_request(body, True)
        with tempfile.TemporaryDirectory() as root:
            profile = Path(root) / 'profile'
            write_transcript(profile, Path(root) / 'session', str(uuid.uuid4()), prefix,
                             initial_effort=effective_effort(body, leading_only=True))
            rows = [json.loads(line) for line in next(profile.glob('projects/*/*.jsonl')).read_text().splitlines()]
        self.assertEqual([r['perTurnEffort'] for r in rows if r['type'] == 'assistant'], ['low', 'low', 'high'])

    def test_system_cannot_split_tool_use_from_its_result_or_create_a_new_user_turn(self):
        for messages in [
            [{'role': 'user', 'content': 'USER'}, {'role': 'assistant', 'content': 'ANSWER'},
             {'role': 'system', 'content': 'WRONG_POSITION'}, {'role': 'user', 'content': 'USER2'}],
            [{'role': 'user', 'content': 'USER'}, {'role': 'system', 'content': 'POLICY'},
             {'role': 'user', 'content': 'USER2'}],
        ]:
            with self.assertRaisesRegex(ContractError, 'invalid_system_message_position'):
                native_options(self.body(messages))

    def test_system_after_tool_results_keeps_tool_graph_validation(self):
        messages = [{'role': 'user', 'content': 'USER'},
                    {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 't', 'name': 'Read', 'input': {}}]},
                    {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 't', 'content': 'RESULT'}]},
                    {'role': 'system', 'content': 'NEW_POLICY'}]
        prefix, tail = initial_request(self.body(messages), True)
        self.assertEqual(tail[0]['tool_use_id'], 't')
        self.assertEqual(trailing_system_text(history_shape(messages)), ['NEW_POLICY'])
        messages[2]['content'][0]['tool_use_id'] = 'unrelated'
        with self.assertRaisesRegex(ContractError, 'imported_tool_result_set_mismatch'):
            initial_request(self.body(messages), True)

    def test_existing_idle_session_keeps_its_native_system_and_history(self):
        body = self.body([{'role': 'user', 'content': 'USER'},
                          {'role': 'system', 'content': 'MID_POLICY'}])
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'session'
            session = Session(directory, ['unused'], {}, body)
            # An earlier build had lifted this instruction into its native system.
            (directory / 'system.txt').write_text('GLOBAL_POLICY\nMID_POLICY')
            session.history = body['messages'] + [{'role': 'assistant', 'content': 'ANSWER'}]
            session.assistants['msg_fixture'] = str(uuid.uuid4())
            session.checkpoint('idle', 'consumed_hash', 'msg_fixture')
            saved = (directory / 'continuation.json').read_bytes()
            follow = {**body, 'messages': session.history + [{'role': 'user', 'content': 'NEXT'}]}
            restored = Session(directory, ['unused'], {}, follow, restore=True)
            self.assertEqual(restored.native_id, session.native_id)
            self.assertEqual(restored.history, session.history)
            self.assertEqual((directory / 'continuation.json').read_bytes(), saved)
            self.assertEqual((directory / 'system.txt').read_text(), 'GLOBAL_POLICY\nMID_POLICY')
            self.assertEqual(restored.seen, {'consumed_hash'})

    def test_older_prepared_system_hash_cannot_be_reinterpreted(self):
        body = self.body([{'role': 'user', 'content': 'USER'},
                          {'role': 'system', 'content': 'MID_POLICY'}])
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'session'
            session = Session(directory, ['unused'], {}, body)
            (directory / 'system.txt').write_text('GLOBAL_POLICY\nMID_POLICY')
            session.checkpoint('prepared')
            saved = (directory / 'continuation.json').read_bytes()
            with self.assertRaisesRegex(ContractError, 'native_session_incomplete_no_replay'):
                Session(directory, ['unused'], {}, body, restore=True)
            self.assertEqual((directory / 'continuation.json').read_bytes(), saved)
