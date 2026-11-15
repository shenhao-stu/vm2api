import unittest
from policy import credential_hold, pause_plan, weekly_priority

NOW = 1794760000
SLOT = {'id': 'slot', 'platform': 'anthropic', 'status': 'running', 'schedulable': True,
        'has_refresh': True, 'expires_at': NOW - 1, 'refresh_error': None}
ACCOUNT = {'schedulable': True, 'key_sha256': 'fixed', 'groups': [8], 'concurrency': 1}
BINDING = {'slot_id': 'slot', 'account_id': 1, 'expected': {'key_sha256': 'fixed', 'groups': [8], 'concurrency': 1}}


class PolicyTests(unittest.TestCase):
    def plan(self, slot=None, account=None, captured=NOW):
        return pause_plan({'captured_at': captured, 'slots': [slot or SLOT]}, {1: account or ACCOUNT}, [BINDING], NOW)

    def test_expired_failed_refresh_pauses_but_does_not_claim_revocation(self):
        self.assertEqual(self.plan(dict(SLOT, refresh_error='refresh_failed'))[0]['reason'], 'credential_refresh_failed')

    def test_retryable_and_unknown_refresh_are_not_fatal(self):
        for error in [None, 'network_error', 'worker_timeout']:
            self.assertEqual(self.plan(dict(SLOT, refresh_error=error)), [])
        self.assertEqual(self.plan(dict(SLOT, refresh_error='refresh_failed', refresh_class='retryable')), [])

    def test_live_access_survives_stale_generic_failure(self):
        self.assertEqual(self.plan(dict(SLOT, refresh_error='refresh_failed', expires_at=NOW + 3600)), [])

    def test_revocation_wins_over_future_expiry(self):
        self.assertEqual(self.plan(dict(SLOT, refresh_error='oauth_revoked', expires_at=NOW + 3600))[0]['reason'], 'credential_rejected')

    def test_no_refresh_expired(self):
        self.assertEqual(credential_hold(dict(SLOT, has_refresh=False), NOW), 'oauth_expired')

    def test_manual_pause_and_stopped_lifecycle_pause_downstream(self):
        self.assertEqual(len(self.plan(dict(SLOT, schedulable=False))), 1)
        self.assertEqual(len(self.plan(dict(SLOT, status='stopped'))), 1)

    def test_never_enables_a_paused_account(self):
        self.assertEqual(self.plan(account=dict(ACCOUNT, schedulable=False)), [])

    def test_quota_is_left_to_native_gate(self):
        self.assertEqual(self.plan(dict(SLOT, cooldown_reason='quota_5h_safety', utilization_5h=1)), [])

    def test_stale_and_future_snapshot_fail_without_mutations(self):
        for at in [NOW - 61, NOW + 6]:
            with self.assertRaises(ValueError): self.plan(captured=at)

    def test_mismatch_in_key_groups_or_capacity_fails_closed(self):
        for field, value in [('key_sha256', 'changed'), ('groups', [25]), ('concurrency', 10)]:
            with self.assertRaises(ValueError): self.plan(account=dict(ACCOUNT, **{field: value}))

    def test_non_claude_is_excluded(self):
        with self.assertRaises(ValueError): self.plan(dict(SLOT, platform='openai'))

    def test_weekly_buckets_and_reset_expiry(self):
        self.assertEqual(weekly_priority({'reset_7d': NOW + 1800}, NOW), 20)
        self.assertEqual(weekly_priority({'reset_7d': NOW + 2 * 86400}, NOW), 21)
        self.assertEqual(weekly_priority({'reset_7d': NOW}, NOW), 27)
        self.assertEqual(weekly_priority({'reset_7d': NOW + 7 * 86400}, NOW), 26)


if __name__ == '__main__': unittest.main()
