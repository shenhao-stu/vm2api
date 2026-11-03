import json
import unittest
from unittest.mock import patch

from quota_sync_mac import APP, billing_tab


class BillingBrowserTests(unittest.TestCase):
    def test_failed_read_releases_tab_and_only_logs_the_bridge_code(self):
        calls = []

        def reply(_bridge, _seq, _method, request):
            name = request['name']
            calls.append((name, request['arguments']))
            data = {
                'browser_profiles': {'profiles': [{'id': 'profile', 'connected': True, 'paused': False}]},
                'browser_open': {'id': 9, 'expectedUrl': APP, 'created': True},
                'browser_evaluate': {'code': 'JAVASCRIPT_ERROR', 'message': 'private page details'},
                'browser_release': {'released': 1},
            }[name]
            return {'isError': name == 'browser_evaluate', 'content': [{'text': json.dumps(data)}]}

        with patch('quota_sync_mac.rpc', side_effect=reply):
            with self.assertRaisesRegex(RuntimeError, '^browser_evaluate_JAVASCRIPT_ERROR$'):
                with billing_tab(None, 'profile') as read:
                    read('0')
        self.assertEqual([name for name, _ in calls].count('browser_evaluate'), 1)
        self.assertEqual(calls[-1][0], 'browser_release')
        self.assertTrue(calls[-1][1]['closeCreated'])
