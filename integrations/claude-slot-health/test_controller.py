import unittest
from controller import cycle
from test_policy import ACCOUNT, BINDING, NOW, SLOT


class Adapter:
    def __init__(self, slot=SLOT, account=None):
        self.slot = slot
        self.account = account or dict(ACCOUNT, id=1, priority=24, status='active')
        self.writes = []

    def snapshot(self):
        return {'captured_at': NOW, 'slots': [self.slot]}

    def accounts(self):
        return {1: self.account}

    def pause(self, change, before):
        self.writes.append(('pause', change['account_id']))

    def priority(self, aid, before, after):
        self.writes.append(('priority', aid, before, after))


class ControllerTests(unittest.TestCase):
    config = {'bindings': [dict(BINDING, weekly_priority=True)], 'priority_base': 20}

    def test_fatal_slot_only_pauses_and_never_reprioritizes(self):
        a = Adapter(dict(SLOT, refresh_error='refresh_failed'))
        cycle(a, self.config, NOW)
        self.assertEqual(a.writes, [('pause', 1)])

    def test_healthy_manual_stop_never_resumes_or_reprioritizes(self):
        a = Adapter(account=dict(ACCOUNT, id=1, priority=24, schedulable=False))
        cycle(a, self.config, NOW)
        self.assertEqual(a.writes, [])

    def test_weekly_rank_reaches_last_after_reset_without_touching_schedule(self):
        a = Adapter(dict(SLOT, reset_7d=NOW - 1))
        cycle(a, self.config, NOW)
        self.assertEqual(a.writes, [('priority', 1, 24, 27)])

    def test_stale_or_changed_binding_writes_nothing(self):
        a = Adapter(account=dict(ACCOUNT, id=1, priority=24, concurrency=5))
        with self.assertRaises(ValueError): cycle(a, self.config, NOW)
        self.assertEqual(a.writes, [])

    def test_operator_priority_outside_owned_band_is_preserved(self):
        a = Adapter(account=dict(ACCOUNT, id=1, priority=10))
        cycle(a, self.config, NOW)
        self.assertEqual(a.writes, [])
