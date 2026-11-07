import copy
import io
import json
import unittest
import uuid
from unittest.mock import Mock

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, initial_request
from native_channel_store import read_json, write_json


def user(content):
    return {'role': 'user', 'content': content}


def assistant(content):
    return {'role': 'assistant', 'content': content}


def tool(call):
    return {'type': 'tool_use', 'id': call, 'name': 'Read', 'input': {'path': 'fixture'}}


def result(call):
    return {'type': 'tool_result', 'tool_use_id': call, 'content': 'fixture result'}


def evidence(directory):
    paths = [directory / 'continuation.json', *directory.glob('caller-grants/*.json'),
             *directory.glob('dispatch/*.consumed.json')]
    return {p.relative_to(directory): p.read_bytes() for p in paths}


class PaidSiblingTests(unittest.TestCase):
    new_pool = fixtures.ChannelTests.new_pool
    completed = fixtures.ChannelTests.completed
    tearDown = fixtures.ChannelTests.tearDown

    def setUp(self):
        fixtures.ChannelTests.setUp(self)
        self.body.update(tools=[{'name': 'Read', 'input_schema': {'type': 'object'}}],
                         messages=[user('shared anchor'), assistant('shared answer'), user('paid input')])
        with self.pool.lease('tenant-a', self.body) as parent:
            self.parent_history = self.completed(parent, self.body, [tool('parent_call')], ['parent_call'])
            self.parent = parent.directory
            self.parent_id = parent.native_id
        self.alternate = {**self.body, 'messages': self.body['messages'] + [
            assistant([tool('alternate_call')]), user([result('alternate_call')]),
            assistant('alternate finished'), user('new tail')]}
        self.original = {**self.body, 'messages': self.parent_history + [user([result('parent_call')])]}

    def restart(self):
        self.pool.close()
        self.pool = self.new_pool()

    def bill_one_turn(self, session, body):
        # Use the real request/CLI-import/checkpoint/grant path; replace the network provider.
        stdin, message_id = io.StringIO(), 'msg_' + uuid.uuid4().hex
        authorize = session.authorize_dispatch
        def prepare_cli():
            session.process = Mock(stdin=stdin, poll=lambda: None)
            session.dispatch_process = Mock(poll=lambda: None)
            (session.directory / 'dispatch').mkdir(exist_ok=True)

        def provider():
            authorize()
            grant = read_json(session.directory / 'dispatch/grant.json')
            write_json(session.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant, exclusive=True)
            session.assistants[message_id] = str(uuid.uuid4())
            for event in [
                {'type': 'message_start', 'message': {'type': 'message', 'id': message_id, 'role': 'assistant',
                    'model': 'opus', 'content': [], 'usage': {'input_tokens': 7, 'output_tokens': 0}}},
                {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'finished'}},
                {'type': 'content_block_stop', 'index': 0},
                {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 3}},
                {'type': 'message_stop'}]:
                session.events.put(event)

        session.prepare = prepare_cli
        session.authorize_dispatch = provider
        try:
            events = list(session.request(body))
            self.assertEqual(events[-1]['type'], 'message_stop')
            sent = [json.loads(line) for line in stdin.getvalue().splitlines()]
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0]['message']['content'], initial_request(body, True)[1])
            self.assertEqual(history_shape(session.history[:-1]), history_shape(body['messages']))
            claim = read_json(session.directory / 'caller-grants' / (session.caller_request_sha + '.json'))
            self.assertEqual(claim['terminal_usage'], {'input_tokens': 7, 'output_tokens': 3})
            return copy.deepcopy(session.history)
        finally:
            session.process = session.dispatch_process = None

    def refused(self, body):
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', body):
                self.fail('must reject before a CLI is leased')

    def test_new_tool_history_gets_one_independent_dispatch_and_both_histories_survive_restart(self):
        old_evidence = evidence(self.parent)
        self.restart()
        with self.pool.lease('tenant-a', self.alternate) as child:
            self.assertNotEqual(child.directory, self.parent)
            self.assertNotEqual(child.native_id, self.parent_id)
            child_path, child_id = child.directory, child.native_id
            child_history = self.bill_one_turn(child, self.alternate)
        self.assertEqual(evidence(self.parent), old_evidence)
        self.restart()
        self.refused(self.body)
        self.refused(self.alternate)
        with self.pool.lease('tenant-a', self.original) as original:
            self.assertEqual((original.directory, original.native_id), (self.parent, self.parent_id))
            self.assertEqual(original.pending_ids, {'parent_call'})
            self.assertEqual(original.history_prefix(self.original['messages']), len(self.parent_history))
        following = {**self.alternate, 'messages': child_history + [user('child followup')]}
        with self.pool.lease('tenant-a', following) as child:
            self.assertEqual((child.directory, child.native_id), (child_path, child_id))
            self.assertFalse(child.pending_ids)
            self.bill_one_turn(child, following)
        self.assertEqual(len(list((child_path / 'dispatch').glob('*.consumed.json'))), 2)
        self.assertEqual(evidence(self.parent), old_evidence)
        child_evidence = evidence(child_path)
        self.restart()
        with self.pool.lease('tenant-a', self.original) as original:
            self.bill_one_turn(original, self.original)
        self.assertEqual(evidence(child_path), child_evidence)
        self.assertEqual(len(list((self.parent / 'dispatch').glob('*.consumed.json'))), 2)
        for path, data in old_evidence.items():
            if path.name != 'continuation.json':
                self.assertEqual((self.parent / path).read_bytes(), data)

    def test_external_history_edits_and_results_are_context_but_invalid_graph_is_rejected(self):
        before = evidence(self.parent)
        changed = copy.deepcopy(self.alternate)
        changed['messages'][2]['content'] = 'modified earlier input'
        incomplete = copy.deepcopy(self.alternate)
        incomplete['messages'][4]['content'] = [result('foreign_tool')]
        self.refused(incomplete)
        result_tail = {**self.alternate, 'messages': self.alternate['messages'][:-2]}
        for valid in (changed, result_tail):
            with self.pool.lease('tenant-a', valid) as active:
                self.assertNotEqual(active.directory, self.parent)
                self.bill_one_turn(active, valid)
        self.assertEqual(evidence(self.parent), before)

    def test_unknown_prior_charge_cannot_start_a_sibling(self):
        next((self.parent / 'dispatch').glob('*.consumed.json')).unlink()
        self.refused(self.alternate)
        self.assertEqual(len([p for p in self.parent.parent.iterdir() if p.is_dir() and not p.name.startswith('.')]), 1)

    def extension(self, body, text='Continue after delivery failed'):
        body = copy.deepcopy(body)
        last = body['messages'][-1]
        content = last['content']
        if isinstance(content, str):
            content = [{'type': 'text', 'text': content}]
        last['content'] = content + [{'type': 'text', 'text': text}]
        return body

    def test_new_user_text_after_lost_response_does_not_replay_the_paid_turn(self):
        body = self.extension(self.body)
        before = evidence(self.parent)
        with self.pool.lease('tenant-a', body) as child:
            child_path = child.directory
            self.assertNotEqual(child_path, self.parent)
            history = self.bill_one_turn(child, body)
        self.assertEqual(evidence(self.parent), before)
        self.restart()
        self.refused(self.body)
        self.refused(body)
        following = {**body, 'messages': history + [user('next turn')]}
        with self.pool.lease('tenant-a', following) as child:
            self.assertEqual(child.directory, child_path)
            self.bill_one_turn(child, following)
        self.assertEqual(len(list(child_path.glob('dispatch/*.consumed.json'))), 2)
        self.assertEqual(evidence(self.parent), before)

    def test_new_user_extension_can_follow_an_already_proven_sibling(self):
        with self.pool.lease('tenant-a', self.alternate) as child:
            self.completed(child, self.alternate, [tool('lost_child')], ['lost_child'])
            child_path = child.directory
        before = {p: evidence(p) for p in (self.parent, child_path)}
        self.restart()
        extended = self.extension(self.alternate)
        with self.pool.lease('tenant-a', extended) as grandchild:
            self.assertNotIn(grandchild.directory, before)
            self.bill_one_turn(grandchild, extended)
        self.restart()
        for p, value in before.items():
            self.assertEqual(evidence(p), value)
        for old in (self.body, self.alternate, extended):
            self.refused(old)

    def test_blank_extension_is_not_a_new_turn_but_caller_edit_is(self):
        changed = self.extension(self.body)
        changed['messages'][0] = user('different old input')
        bad = [self.extension(self.body, ''), self.extension(self.body, '  ')]
        for body in bad:
            with self.subTest(body=body['messages'][-1]):
                self.refused(body)
        with self.pool.lease('tenant-a', changed) as active:
            self.assertNotEqual(active.directory, self.parent)
            self.bill_one_turn(active, changed)

    def test_merged_tool_results_continue_and_new_system_controls_retain_their_semantics(self):
        body = {**self.body, 'metadata': {'user_id': str(uuid.uuid4())}, 'messages': [
            user('new anchor'), {'role': 'system', 'content': 'same policy'},
            assistant([tool('previous')]), user([result('previous')]),
            {'role': 'system', 'content': 'old turn hint'}]}
        with self.pool.lease('tenant-a', body) as parent:
            self.completed(parent, body, [tool('lost_response')], ['lost_response'])
            before = evidence(parent.directory)
        extended = copy.deepcopy(body)
        extended['messages'][1]['output_config'] = {'effort': 'high'}
        extended['messages'][-2]['content'].append({'type': 'text', 'text': 'Continue'})
        extended['messages'][-1]['content'] = 'new turn hint'
        with self.pool.lease('tenant-a', extended) as child:
            self.bill_one_turn(child, extended)
            self.assertEqual(child.history[1]['output_config'], {'effort': 'high'})
            self.assertEqual(child.history[-2]['content'], 'new turn hint')
        self.assertEqual(evidence(parent.directory), before)


if __name__ == '__main__':
    unittest.main()
