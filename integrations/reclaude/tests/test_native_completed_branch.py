"""A background request cannot advance the caller's main transcript."""
import copy
import unittest

import test_native_configuration_channels as fixtures
import test_native_paid_sibling as paid
from test_native_paid_sibling import evidence, user, assistant
from native_bridge_session import ContractError, history_shape
from native_channel_store import read_json


class CompletedBranchTests(unittest.TestCase):
    new_pool = fixtures.ChannelTests.new_pool
    completed = fixtures.ChannelTests.completed
    tearDown = fixtures.ChannelTests.tearDown
    bill_one_turn = paid.PaidSiblingTests.bill_one_turn

    def setUp(self):
        fixtures.ChannelTests.setUp(self)
        self.body['messages'] = [user('main request')]
        with self.pool.lease('tenant', self.body) as session:
            self.common = self.completed(session, self.body, 'main answer')
            self.parent = session.directory
        self.background = {**self.body, 'messages': self.common + [user('background task')]}
        with self.pool.lease('tenant', self.background) as session:
            self.side_history = self.completed(session, self.background, 'background answer')
        self.follow = {**self.body, 'messages': self.common + [user('new main input')]}

    def restart(self):
        self.pool.close()
        self.pool = self.new_pool()

    def test_completed_background_and_main_are_independent_after_restart(self):
        original = evidence(self.parent)
        self.restart()
        with self.pool.lease('tenant', self.follow) as child:
            self.assertNotEqual(child.directory, self.parent)
            path = child.directory
            history = self.bill_one_turn(child, self.follow)
        self.assertEqual(evidence(self.parent), original)
        self.restart()
        next_main = {**self.follow, 'messages': history + [user('next main input')]}
        with self.pool.lease('tenant', next_main) as child:
            self.assertEqual(child.directory, path)
            self.assertEqual(history_shape(child.history), history_shape(history))
        side = {**self.background, 'messages': self.side_history + [user('next background input')]}
        with self.pool.lease('tenant', side) as parent:
            self.assertEqual(parent.directory, self.parent)
        for duplicate in (self.body, self.background, self.follow):
            with self.assertRaisesRegex(ContractError, 'already_consumed'):
                with self.pool.lease('tenant', duplicate):
                    self.fail('replayed completed request')

    def test_more_background_turns_can_fork_without_losing_older_branches(self):
        with self.pool.lease('tenant', self.follow) as first:
            first_path = first.directory
            main = self.completed(first, self.follow, 'new main answer')
        second_background = {**self.body, 'messages': main + [user('second background')]}
        with self.pool.lease('tenant', second_background) as first:
            self.completed(first, second_background, 'second background answer')
        following = {**self.body, 'messages': main + [user('second new main')]}
        self.restart()
        with self.pool.lease('tenant', following) as second:
            self.assertNotEqual(second.directory, first_path)
            self.assertNotEqual(second.directory, self.parent)
            self.assertEqual(second.pending_ids, set())
            self.bill_one_turn(second, following)
        self.assertEqual(len(list((self.pool.root / '.configuration-channels').glob('*.json'))), 1)

    def test_history_edit_gets_a_new_transcript_without_changing_paid_evidence(self):
        changed = copy.deepcopy(self.follow)
        changed['messages'][1] = assistant('edited paid answer')
        original = evidence(self.parent)
        with self.pool.lease('tenant', changed) as child:
            self.assertNotEqual(child.directory, self.parent)
            self.assertFalse(child.history)
            self.bill_one_turn(child, changed)
        self.assertEqual(evidence(self.parent), original)

    def test_missing_terminal_receipt_blocks_branch(self):
        claim = read_json(next((self.parent / 'caller-grants').glob('*.json')))
        (self.parent / 'dispatch' / (claim['grant_id'] + '.consumed.json')).unlink()
        with self.assertRaisesRegex(ContractError, 'evidence_unknown'):
            with self.pool.lease('tenant', self.follow):
                self.fail('unconfirmed completion')

    def test_other_tenant_gets_no_branch_or_native_identity_from_owner(self):
        with self.pool.lease('other-tenant', self.follow) as other:
            self.assertNotEqual(other.directory, self.parent)
            self.assertFalse(other.history)

    def test_busy_or_unknown_scope_cannot_fork(self):
        with self.pool.lease('tenant', {**self.background, 'messages': self.side_history + [user('next')]}) as parent:
            with self.assertRaisesRegex(ContractError, 'session_busy'):
                with self.pool.lease('tenant', self.follow):
                    self.fail('concurrent branch')
            parent.failed = True
            parent.checkpoint('failed')
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant', self.follow):
                self.fail('failed scope')


if __name__ == '__main__':
    unittest.main()
