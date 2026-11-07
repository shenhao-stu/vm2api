"""A terminal tool-use response must not own all future caller history."""
import copy
import unittest

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, initial_request
from test_native_paid_sibling import evidence, tool, result, user, assistant


class PendingContextTests(unittest.TestCase):
    setUp = fixtures.ChannelTests.setUp
    tearDown = fixtures.ChannelTests.tearDown
    new_pool = fixtures.ChannelTests.new_pool
    completed = fixtures.ChannelTests.completed

    def pending(self, body, name):
        with self.pool.lease('tenant-a', body) as active:
            history = self.completed(active, body, [tool(name)], [name])
            return active.directory, history

    def test_two_lost_tool_branches_do_not_reject_new_caller_owned_history(self):
        body = {**self.body, 'messages': [user('anchor'), assistant('earlier answer'), user('request')]}
        parent, history = self.pending(body, 'first_tool')
        alternate = {**body, 'messages': body['messages'] + [assistant('external answer'), user('Continue')]}
        child, _ = self.pending(alternate, 'second_tool')
        before = {path: evidence(path) for path in (parent, child)}
        changed = copy.deepcopy(alternate)
        changed['messages'][1] = assistant('caller corrected an earlier answer')
        changed['messages'][-1] = user('new continuation after history changed')
        self.pool.close(); self.pool = self.new_pool()
        with self.pool.lease('tenant-a', changed) as active:
            self.assertNotIn(active.directory, before)
            imported, tail = initial_request(changed, True)
            self.assertEqual(imported, history_shape(changed['messages'][:-1]))
            self.assertEqual(tail, history_shape(changed['messages'])[-1]['content'])
            self.completed(active, changed)
        for path, content in before.items():
            self.assertEqual(evidence(path), content)
        for request in (body, alternate, changed):
            with self.assertRaisesRegex(ContractError, 'already_consumed'):
                with self.pool.lease('tenant-a', request): pass
        # The pending tool is still owned by its original native transcript.
        resume = {**body, 'messages': history + [user([result('first_tool')])]}
        with self.pool.lease('tenant-a', resume) as active:
            self.assertEqual(active.directory, parent)

    def test_other_provider_tool_graph_can_be_imported_without_resending_native_tools(self):
        parent, history = self.pending(self.body, 'native_tool')
        fresh = {**self.body, 'messages': [*self.body['messages'],
            assistant([tool('external_tool')]), user([result('external_tool')])]}
        with self.pool.lease('tenant-a', fresh) as active:
            self.assertNotEqual(active.directory, parent)
            self.completed(active, fresh)
        forged = copy.deepcopy(fresh)
        forged['messages'][-2]['content'][0]['id'] = 'native_tool'
        forged['messages'][-1]['content'][0]['tool_use_id'] = 'native_tool'
        forged['messages'][0] = user('edited input before the native tool')
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', forged): pass


if __name__ == '__main__':
    unittest.main()
