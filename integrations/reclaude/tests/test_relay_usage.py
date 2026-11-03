from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import tempfile
import unittest
from management import relay_usage


class RelayUsageTests(unittest.TestCase):
    def test_rolling_cost_across_keys_with_final_backend_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'usage.db'
            with sqlite3.connect(path) as db:
                db.execute('create table usage_logs(created_at, account_id, final_account_id, attempt_count, total_cost)')
                db.executemany('insert into usage_logs values (?,?,?,?,?)', [
                    ('2026-11-02T18:59:59.999Z', 'a', 'a', 1, 3),
                    ('2026-11-02T19:00:00.000Z', 'b', 'a', 2, 2),
                    ('2026-11-02T23:01:00.000Z', 'a', None, 1, .5),
                    ('2026-11-02T23:02:00.000Z', 'a', 'b', 2, 13),
                    ('2026-11-02T23:03:00.000Z', 'a', 'a', 1, None),
                    ('2026-11-02T23:04:00.000Z', None, None, 0, 0),
                ])
            usage = relay_usage({'usage_ledger': {'path': str(path), 'account_id': 'a'}},
                                datetime(2026, 11, 3, tzinfo=timezone.utc))
            self.assertEqual((usage['total_usd'], usage['last_5h_usd'], usage['unpriced_requests']),
                             (5.5, 2.5, 1))

    def test_unavailable_is_distinct_from_zero_and_does_not_create_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'missing.db'
            self.assertIsNone(relay_usage({'usage_ledger': {'path': str(path), 'account_id': 'a'}}))
            self.assertFalse(path.exists())


class OfficialQuotaTests(unittest.TestCase):
    def test_scope_reset_and_exhaustion(self):
        import json
        from management import official_quota
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'quota.json'
            config = {'binding': 1, 'official_quota': {'path': str(path), 'account_id': 3, 'org_id': 2}}
            data = {'binding': 1, 'org_id': 2, 'account_id': 3, 'used_usd': 81.5, 'quota_usd': 80,
                    'observed_at_ms': 1000, 'resets_at_ms': 5000}
            path.write_text(json.dumps(data))
            self.assertFalse(official_quota(config, 2)['stale'])
            self.assertEqual(official_quota(config, 2)['used_usd'], 81.5)
            self.assertTrue(official_quota(config, 5)['stale'])
            self.assertIsNone(official_quota({**config, 'binding': 5}, 2))
            path.write_text(json.dumps({**data, 'used_usd': float('nan')}))
            self.assertIsNone(official_quota(config, 2))

    def test_publisher_rejects_wrong_scope_and_replay(self):
        from publish_official_quota import publish
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'quota.json'
            config = {'binding': 1, 'official_quota': {'path': str(path), 'account_id': 3, 'org_id': 2}}
            record = {'binding': 1, 'org_id': 2, 'account_id': 3, 'used_usd': 0, 'quota_usd': 80,
                      'observed_at_ms': 1000, 'resets_at_ms': None}
            publish(config, record, 1500)
            saved = path.read_bytes()
            for wrong in (record, {**record, 'binding': 4}, {**record, 'observed_at_ms': 9999999},
                          {**record, 'quota_usd': False}, {**record, 'unexpected': 'private'}):
                with self.assertRaises(ValueError):
                    publish(config, wrong, 1500)
                self.assertEqual(path.read_bytes(), saved)
