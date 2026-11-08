"""Caller history/model edits may transfer a completed tool boundary exactly once."""
import copy
import unittest
from unittest.mock import Mock

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, signature
from native_channel_store import read_json, write_json
from test_native_paid_sibling import evidence, tool, result, user, assistant


class ToolHandoffTests(unittest.TestCase):
    setUp = fixtures.ChannelTests.setUp
    tearDown = fixtures.ChannelTests.tearDown
    new_pool = fixtures.ChannelTests.new_pool
    completed = fixtures.ChannelTests.completed

    def pending(self):
        body = {**self.body, 'messages': [user('anchor'), assistant('old answer'), user('request')]}
        with self.pool.lease('tenant-a', body) as active:
            history = self.completed(active, body, [tool('owned_tool')], ['owned_tool'])
            parent = active.directory
        follow = {**body, 'messages': history + [user([result('owned_tool')])]}
        return parent, follow

    def test_changed_caller_context_and_model_transfer_only_new_tool_result(self):
        for change in ('model', 'system', 'anchor', 'earlier', 'assistant_text'):
            with self.subTest(change=change):
                self.body['metadata']['user_id'] = str(__import__('uuid').uuid4())
                parent, follow = self.pending()
                original = evidence(parent)
                changed = copy.deepcopy(follow)
                if change in ('model', 'system'): changed[change] = 'caller changed ' + change
                elif change == 'anchor': changed['messages'][0] = user('revised anchor')
                elif change == 'earlier': changed['messages'][1] = assistant('revised answer')
                else: changed['messages'][-2]['content'].insert(0, {'type': 'text', 'text': 'caller annotation'})
                self.pool.close(); self.pool = self.new_pool()
                with self.pool.lease('tenant-a', changed) as active:
                    self.assertNotEqual(active.directory, parent)
                    self.assertFalse(active.history, 'new native transcript imports only caller history')
                    history = self.completed(active, changed)
                self.assertEqual(evidence(parent), original)
                self.pool.close(); self.pool = self.new_pool()
                for duplicate in (follow, changed, {**changed, 'model': 'alternate'}):
                    with self.assertRaises(ContractError):
                        with self.pool.lease('tenant-a', duplicate): self.fail('tool result replayed')
                with self.pool.lease('tenant-a', {**changed, 'messages': history + [user('fresh turn')]}) as active:
                    self.completed(active, {**changed, 'messages': history + [user('fresh turn')]})

    def test_prepared_transfer_can_resume_but_other_variant_cannot_take_it(self):
        parent, follow = self.pending()
        changed = {**follow, 'model': 'other-model'}
        with self.pool.lease('tenant-a', changed) as child: path = child.directory
        self.pool.close(); self.pool = self.new_pool()
        with self.pool.lease('tenant-a', changed) as child:
            self.assertEqual(child.directory, path)
            with self.assertRaisesRegex(ContractError, 'session_busy'):
                with self.pool.lease('tenant-a', follow): pass
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', follow): pass

    def test_forged_names_and_incomplete_results_cannot_transfer(self):
        _, follow = self.pending()
        for change in ('name', 'id', 'result_id', 'duplicate_result'):
            bad = copy.deepcopy(follow); bad['model'] = 'changed'
            if change in ('name', 'id'): bad['messages'][-2]['content'][0][change] = 'other'
            elif change == 'result_id': bad['messages'][-1]['content'][0]['tool_use_id'] = 'other'
            else: bad['messages'][-1]['content'] *= 2
            with self.subTest(change=change), self.assertRaises(ContractError):
                with self.pool.lease('tenant-a', bad): pass

    def test_unknown_dispatch_cannot_transfer_or_cross_tenant(self):
        parent, follow = self.pending()
        changed = {**follow, 'model': 'other-model'}
        with self.pool.lease('tenant-a', changed) as child:
            self.assertNotEqual(child.directory, parent)
            child.caller_request_sha = signature(history_shape(changed['messages']))
            child.dispatch_process = Mock(poll=lambda: None)
            (child.directory / 'dispatch').mkdir(exist_ok=True)
            child.authorize_dispatch()
            grant = read_json(child.directory / 'dispatch/grant.json')
            write_json(child.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant)
            child.dispatch_process = None
        for duplicate in (follow, changed):
            with self.assertRaises(ContractError):
                with self.pool.lease('tenant-a', duplicate): pass
        with self.pool.lease('tenant-b', changed) as other:
            self.assertNotIn(other.directory, (parent, child.directory))


if __name__ == '__main__': unittest.main()
