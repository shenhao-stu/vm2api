import copy
import json
from pathlib import Path
import tempfile
import unittest
from official_windows import normalize_windows
from publish_official_windows import publish

NOW = 1793728000000
CFG = {'binding': 54076, 'account_windows': {'org': 424032, 'account_id': 7995}}
DATA = {'ok': True, 'binding': 54076, 'org': 424032, 'account_id': 7995,
        'observed_at_ms': NOW, 'source_updated': NOW - 1000,
        'windows': {'five_hour': {'used_percent': 0, 'resets_at': None},
                    'seven_day': {'used_percent': 100, 'resets_at': '2026-11-04T17:59:59.733379+00:00'}}}

class OfficialWindowsTests(unittest.TestCase):
    def test_zero_with_no_active_reset_keeps_weekly_limit(self):
        result = normalize_windows(CFG, DATA, NOW)
        self.assertEqual(result['five_hour'], {'used_percent': 0, 'resets_at_ms': None})
        self.assertEqual(result['seven_day']['used_percent'], 100)
        self.assertFalse(result['stale'])

    def test_active_window_needs_reset(self):
        data = copy.deepcopy(DATA)
        data['windows']['five_hour']['used_percent'] = 15
        with self.assertRaisesRegex(ValueError, 'missing_active_reset'):
            normalize_windows(CFG, data, NOW)

    def test_account_and_device_are_isolated(self):
        for key in ('binding', 'org', 'account_id'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                normalize_windows(CFG, {**DATA, key: DATA[key] + 1}, NOW)

    def test_expired_observation_remains_stale_not_zero(self):
        result = normalize_windows(CFG, DATA, NOW + 900001)
        self.assertTrue(result['stale'])
        self.assertEqual(result['seven_day']['used_percent'], 100)

    def test_invalid_usage_does_not_overwrite_valid_windows(self):
        for value in (-1, float('nan'), float('inf'), True, '100'):
            data = copy.deepcopy(DATA)
            data['windows']['seven_day']['used_percent'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_windows(CFG, data, NOW)

    def test_publisher_rejects_replay_and_binding_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); current = root / '.rec/claude/current'
            current.parent.mkdir(parents=True); current.write_text('54076')
            path = root / 'window.json'
            config = {**CFG, 'home': directory, 'account_windows': {**CFG['account_windows'], 'path': str(path)}}
            publish(config, DATA, NOW)
            self.assertEqual(json.loads(path.read_text()), DATA)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(ValueError, 'out_of_order'):
                publish(config, DATA, NOW)
            current.write_text('54457')
            with self.assertRaisesRegex(ValueError, 'binding_changed'):
                publish(config, {**DATA, 'observed_at_ms': NOW + 1}, NOW + 1)
            self.assertEqual(json.loads(path.read_text()), DATA)
