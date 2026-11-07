"""A completed native transcript is a cache, not ownership of caller context."""
import copy
import unittest

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, initial_request


class CallerHistoryTests(unittest.TestCase):
    setUp = fixtures.ChannelTests.setUp
    tearDown = fixtures.ChannelTests.tearDown
    new_pool = fixtures.ChannelTests.new_pool
    completed = fixtures.ChannelTests.completed

    def branches(self):
        with self.pool.lease('tenant-a', self.body) as original:
            history = self.completed(original, self.body)
        long = {**self.body, 'messages': history + [{'role': 'user', 'content': 'later request'}]}
        with self.pool.lease('tenant-a', long) as same:
            full = self.completed(same, long)
        changed = {**self.body, 'messages': copy.deepcopy(history) + [
            {'role': 'user', 'content': 'new input after local context edit'}]}
        changed['messages'][1]['content'] = 'caller-edited prior assistant context'
        return original, long, full, changed

    def test_completed_rewind_imports_only_caller_history_and_keeps_old_evidence(self):
        original, long, full, changed = self.branches()
        before = {p.relative_to(original.directory): p.read_bytes()
                  for p in original.directory.rglob('*') if p.is_file()}
        with self.pool.lease('tenant-a', changed) as branch:
            self.assertNotEqual(branch.directory, original.directory)
            self.assertEqual(branch.history, [])
            imported, tail = initial_request(changed, True)
            self.assertEqual(imported, history_shape(changed['messages'][:-1]))
            self.assertEqual(tail, history_shape(changed['messages'])[-1]['content'])
            self.completed(branch, changed)
        self.assertEqual(before, {p.relative_to(original.directory): p.read_bytes()
                                 for p in original.directory.rglob('*') if p.is_file()})
        for body in (self.body, long, changed, {**changed, 'model': 'other'}):
            with self.assertRaisesRegex(ContractError, 'already_consumed'):
                with self.pool.lease('tenant-a', body):
                    self.fail('paid input replayed')

    def test_both_branches_resume_after_restart_without_context_mixing(self):
        original, _, full, changed = self.branches()
        with self.pool.lease('tenant-a', changed) as branch:
            alternate = self.completed(branch, changed)
            branch_path = branch.directory
        original_path = original.directory
        self.pool.close(); self.pool = self.new_pool()
        for history, expected in [(alternate, branch_path), (full, original_path)]:
            request = {**self.body, 'messages': history + [{'role': 'user', 'content': 'fresh followup'}]}
            with self.pool.lease('tenant-a', request) as restored:
                self.assertEqual(restored.directory, expected)
                self.assertEqual(history_shape(restored.history), history_shape(history))

    def test_pending_tools_and_invalid_graph_cannot_be_rebased(self):
        original, _, full, changed = self.branches()
        malformed = copy.deepcopy(changed)
        malformed['messages'][-1]['content'] = [{'type': 'tool_result', 'tool_use_id': 'unowned', 'content': 'bad'}]
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', malformed): pass
        tool_body = {**self.body, 'messages': full + [{'role': 'user', 'content': 'need a tool'}]}
        with self.pool.lease('tenant-a', tool_body) as active:
            self.completed(active, tool_body, [{'type': 'tool_use', 'id': 'pending',
                                                'name': 'Read', 'input': {}}], ['pending'])
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', changed): pass

    def test_other_authenticated_tenant_cannot_reuse_native_context(self):
        original, _, _, changed = self.branches()
        with self.pool.lease('tenant-b', changed) as other:
            self.assertNotEqual(other.directory, original.directory)
            self.assertEqual(other.history, [])

    def test_each_branch_owns_its_pending_tools_after_restart(self):
        original, _, full, changed = self.branches()
        with self.pool.lease('tenant-a', changed) as child:
            alternate = self.completed(child, changed)
            child_path = child.directory
        for index, (history, expected) in enumerate(((alternate, child_path), (full, original.directory))):
            tool_id = 'branch_tool_' + str(index)
            ask = {**self.body, 'messages': history + [{'role': 'user', 'content': 'use a tool'}]}
            with self.pool.lease('tenant-a', ask) as active:
                self.assertEqual(active.directory, expected)
                pending = self.completed(active, ask, [{'type': 'tool_use', 'id': tool_id,
                    'name': 'Read', 'input': {}}], [tool_id])
            self.pool.close()
            self.pool = self.new_pool()
            result = {**self.body, 'messages': pending + [{'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': tool_id, 'content': 'owned result'}]}]}
            with self.pool.lease('tenant-a', result) as active:
                self.assertEqual(active.directory, expected)
                self.completed(active, result)
