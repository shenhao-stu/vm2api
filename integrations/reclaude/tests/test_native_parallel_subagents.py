"""Subagents share their parent's session id; each runs on a channel of its own.

Only a turn that could belong to a busy channel waits for it: a repeat of the
running request (on any model), a turn of a busy channel's own configuration,
or tool results that no idle channel is waiting for.
"""
from contextlib import ExitStack
import unittest

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, signature
from test_native_paid_sibling import user


def results(*ids):
    return {'role': 'user', 'content': [
        {'type': 'tool_result', 'tool_use_id': i, 'content': 'done'} for i in ids]}


def calls(*ids):
    return [{'type': 'tool_use', 'id': i, 'name': 'Task', 'input': {'prompt': i}} for i in ids]


class ParallelSubagentTests(unittest.TestCase):
    new_pool = fixtures.ChannelTests.new_pool
    completed = fixtures.ChannelTests.completed
    tearDown = fixtures.ChannelTests.tearDown

    def setUp(self):
        fixtures.ChannelTests.setUp(self)
        self.body['messages'] = [user('main request')]

    def subagent(self, n, model=None):
        return {**self.body, 'model': model or self.body['model'], 'system': 'subagent system',
                'messages': [user('subtask %d' % n)]}

    def busy(self):
        return self.pool.snapshot()['busy']

    def test_many_subagents_run_beside_their_busy_parent(self):
        with ExitStack() as stack:
            parent = stack.enter_context(self.pool.lease('tenant', self.body))
            children = [stack.enter_context(self.pool.lease('tenant', self.subagent(n)))
                        for n in range(8)]
            self.assertEqual(self.busy(), 9)
            self.assertEqual(len({s.directory for s in [parent, *children]}), 9)
            for n, child in enumerate(children):
                self.completed(child, self.subagent(n), 'subtask %d answer' % n)
            self.completed(parent, self.body, 'main answer')
        self.assertEqual(self.busy(), 0)
        self.pool.close()
        self.pool = self.new_pool()
        for request in [self.body, *(self.subagent(n) for n in range(8))]:
            with self.assertRaisesRegex(ContractError, 'already_consumed'):
                with self.pool.lease('tenant', request):
                    self.fail('a completed turn was leased again')

    def test_a_repeat_of_a_running_request_waits_on_every_model(self):
        with self.pool.lease('tenant', self.body) as parent:
            for repeat in (self.body, {**self.body, 'model': 'sonnet'},
                           {**self.body, 'system': 'changed system'}):
                with self.subTest(repeat=repeat.get('model'), system=repeat.get('system')):
                    with self.assertRaisesRegex(ContractError, '^session_busy$'):
                        with self.pool.lease('tenant', repeat):
                            self.fail('the running request was dispatched twice')
            self.completed(parent, self.body)
            for repeat in (self.body, {**self.body, 'model': 'sonnet'}):
                with self.assertRaisesRegex(ContractError, '^native_request_in_flight_no_replay$'):
                    with self.pool.lease('tenant', repeat):
                        self.fail('a claimed request was dispatched twice')
        self.assertEqual(len(list(parent.directory.glob('caller-grants/*.json'))), 1)

    def test_a_turn_of_the_busy_configuration_waits(self):
        with self.pool.lease('tenant', self.body) as parent:
            history = self.completed(parent, self.body, 'main answer')
        follow = {**self.body, 'messages': history + [user('next main input')]}
        with self.pool.lease('tenant', follow):
            branch = {**self.body, 'messages': history + [user('another main input')]}
            with self.assertRaisesRegex(ContractError, '^session_busy$'):
                with self.pool.lease('tenant', branch):
                    self.fail('two turns of one configuration ran at once')

    def test_parent_takes_finished_task_results_while_other_subagents_run(self):
        with self.pool.lease('tenant', self.body) as parent:
            history = self.completed(parent, self.body, calls('task_a', 'task_b'),
                                     pending=('task_a', 'task_b'))
        follow = {**self.body, 'messages': history + [results('task_a', 'task_b')]}
        with self.pool.lease('tenant', self.subagent(1)) as child:
            with self.pool.lease('tenant', follow) as resumed:
                self.assertEqual(resumed.directory, parent.directory)
                self.assertNotEqual(resumed.directory, child.directory)
                self.assertEqual(self.busy(), 2)

    def test_results_for_a_busy_channels_tools_wait_for_it_on_another_model(self):
        body = self.subagent(1, model='haiku')
        with self.pool.lease('tenant', body) as child:
            history = self.completed(child, body, calls('read_1'), pending=('read_1',))
        follow = {**body, 'messages': history + [results('read_1')]}
        with self.pool.lease('tenant', follow):
            answer = results('read_1')
            answer['content'].append({'type': 'text', 'text': 'and one more thing'})
            switched = {**body, 'model': 'sonnet', 'messages': history + [answer]}
            with self.assertRaisesRegex(ContractError, '^session_busy$'):
                with self.pool.lease('tenant', switched):
                    self.fail('results owned by a busy channel were decided without it')

    def test_subagent_continues_its_own_tools_while_its_parent_runs(self):
        body = self.subagent(1, model='haiku')
        with self.pool.lease('tenant', body) as child:
            history = self.completed(child, body, calls('read_1'), pending=('read_1',))
        with self.pool.lease('tenant', self.body) as parent:
            follow = {**body, 'messages': history + [results('read_1')]}
            with self.pool.lease('tenant', follow) as resumed:
                self.assertEqual(resumed.directory, child.directory)
                self.assertNotEqual(resumed.directory, parent.directory)
                self.completed(resumed, follow, 'subtask done')
            self.completed(parent, self.body, 'main answer')
        claims = [signature(history_shape(r['messages'])) for r in (body, follow)]
        self.assertEqual(sorted(p.stem for p in child.directory.glob('caller-grants/*.json')),
                         sorted(claims))


if __name__ == '__main__':
    unittest.main()
