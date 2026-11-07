import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import Mock

from native_bridge_session import ContractError, Session, fresh_prompt


MEDIA = [
    {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': 'aGVsbG8='}},
    {'type': 'document', 'source': {'type': 'text', 'media_type': 'text/plain', 'data': 'synthetic'}},
]


class UserMediaTests(unittest.TestCase):
    def test_initial_media_is_preserved_without_fetching_or_text_conversion(self):
        blocks = [{'type': 'text', 'text': 'inspect'}, *copy.deepcopy(MEDIA)]
        self.assertEqual(fresh_prompt([{'role': 'user', 'content': blocks}]), blocks)

    def test_idle_followup_dispatches_media_once_and_preserves_terminal(self):
        with tempfile.TemporaryDirectory() as temp:
            body = {'model': 'fixture', 'max_tokens': 128,
                    'messages': [{'role': 'user', 'content': 'synthetic'}]}
            session = Session(Path(temp)/'session', ['unused'], {}, body)
            session.history = body['messages'] + [{'role': 'assistant', 'content': 'old reply'}]
            session.assistants['msg_old'] = str(uuid.uuid4())
            session.checkpoint('idle', 'old-paid', 'msg_old')
            follow = {**body, 'messages': copy.deepcopy(session.history) + [
                {'role': 'user', 'content': copy.deepcopy(MEDIA)}]}
            stdin = io.StringIO()
            session.prepare = lambda: None
            session.process = Mock(stdin=stdin, poll=lambda: None)
            session.authorize_dispatch = Mock()
            session.assistants['msg_new'] = str(uuid.uuid4())
            for event in [
                {'type': 'message_start', 'message': {'id': 'msg_new', 'content': [],
                 'usage': {'input_tokens': 7, 'output_tokens': 0}}},
                {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'done'}},
                {'type': 'content_block_stop', 'index': 0},
                {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 3}},
                {'type': 'message_stop'},
            ]:
                session.events.put(event)
            try:
                self.assertEqual(list(session.request(follow))[-1]['type'], 'message_stop')
                session.authorize_dispatch.assert_called_once()
                self.assertEqual(json.loads(stdin.getvalue())['message']['content'], MEDIA)
                self.assertEqual(json.loads((session.directory/'continuation.json').read_text())['status'], 'idle')
                with self.assertRaisesRegex(ContractError, 'request_already_consumed'):
                    list(session.request(follow))
                session.authorize_dispatch.assert_called_once()
            finally:
                session.process = None
                session.close()

    def test_initial_unsolicited_results_and_unknown_blocks_stay_rejected(self):
        for block in [{'type': 'tool_result', 'tool_use_id': 'foreign', 'content': 'unowned'},
                      {'type': 'tool_reference', 'tool_name': 'Read'}, {'type': 'unknown'}]:
            with self.subTest(kind=block['type']), self.assertRaises(ContractError):
                fresh_prompt([{'role': 'user', 'content': [block]}])
