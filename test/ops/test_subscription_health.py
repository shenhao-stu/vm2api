import copy
import importlib.util
import pathlib
import socket
import threading
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'scripts/subscription-health.py'
SPEC = importlib.util.spec_from_file_location('subscription_health', SOURCE)
patrol = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patrol)
NOW = 2000000000
TARGET = {'vm_id': 'vm-dynamic', 'proxy_id': 'px-test', 'profile_id': 'sub-test'}
REASON = 'subscription_health:px-test'
OK = {'ok': True, 'security': False, 'ip': '1.1.1.1'}
FAIL = {'ok': False, 'security': False, 'code': 'https_probe_28'}


class Native:
    def __init__(self):
        self.vm = {'id': 'vm-dynamic', 'proxy': {'id': 'px-test'}, 'status': 'running',
                   'schedulable': True, 'account_uuid': 'account-a', 'has_token': True}
        self.guard = {'required': False, 'expected_ip': None, 'revision': 'revision-a', 'state': {}}
        self.node = {'id': 'node-a', 'profile_id': 'sub-test', 'retained': False}
        self.subs = {'profiles': [{'id': 'sub-test', 'updated_at': '2033-05-18T03:33:00Z'}]}
        self.results = [OK]
        self.actions = []
        self.busy = False
        self.refresh_error = False
        self.after_refresh = lambda: None
        self.after_probe = lambda: None

    def view(self, target):
        return copy.deepcopy((self.vm, self.guard, self.node, self.subs))

    def idle(self):
        return not self.busy

    def check(self, target, both=False):
        self.actions.append(('check', both))
        self.after_probe()
        return copy.deepcopy(self.results)

    def hold(self, target, reason):
        self.actions.append(('hold', reason))
        self.vm.update(schedulable=False, schedule_disabled_reason=reason)

    def resume(self, target):
        self.actions.append(('resume',))
        self.vm.update(schedulable=True, schedule_disabled_reason=None)

    def refresh(self, target):
        self.actions.append(('refresh',))
        if self.refresh_error:
            raise TimeoutError()
        self.after_refresh()


class PatrolTest(unittest.TestCase):
    def setUp(self):
        self.native, self.state, self.saved = Native(), {}, []

    def tick(self, now=NOW):
        patrol.tick(TARGET, self.state, self.native,
                    lambda: self.saved.append(copy.deepcopy(self.state)), now)

    def open(self):
        self.native.results = [FAIL, FAIL]
        self.tick()
        self.assertFalse(self.native.vm['schedulable'])
        self.assertEqual(self.state['status'], 'open')

    def test_healthy_costs_one_check_no_refresh(self):
        self.tick()
        self.assertEqual(self.native.actions, [('check', False)])

    def test_one_probe_provider_down_does_not_block(self):
        self.native.results = [FAIL, OK]
        self.tick()
        self.assertTrue(self.native.vm['schedulable'])

    def test_two_failed_providers_hold_only_this_slot(self):
        self.open()
        self.assertTrue(self.saved[-1]['hold_intent'])
        self.assertEqual(self.native.vm['schedule_disabled_reason'], REASON)

    def test_recovery_needs_refresh_and_two_checks(self):
        self.open()
        self.native.results = [OK, OK]
        self.tick(NOW + 301)
        self.assertIn(('refresh',), self.native.actions)
        self.assertIn(('check', True), self.native.actions)
        self.assertTrue(self.native.vm['schedulable'])

    def test_busy_workers_defer_refresh_and_resume(self):
        self.open()
        self.native.busy, self.native.results = True, [OK, OK]
        self.tick(NOW + 301)
        self.assertNotIn(('refresh',), self.native.actions)
        self.assertFalse(self.native.vm['schedulable'])

    def test_failed_refresh_never_authorizes_recovery(self):
        self.open()
        self.native.refresh_error, self.native.results = True, [OK, OK]
        self.tick(NOW + 301)
        self.assertFalse(self.native.vm['schedulable'])

    def test_three_failed_recovery_attempts_require_human(self):
        self.open()
        for delta in (301, 1202, 4803):
            self.tick(NOW + delta)
        self.assertEqual(self.state['recovery_attempts'], 3)
        self.assertTrue(self.state['manual'])
        self.native.results = [OK, OK]
        self.tick(NOW + 50000)
        self.assertFalse(self.native.vm['schedulable'])

    def test_tls_failure_requires_manual_recovery(self):
        self.native.results = [{'ok': False, 'security': True}]
        self.tick()
        self.assertTrue(self.state['manual'])
        self.assertFalse(self.native.vm['schedulable'])

    def test_fixed_ip_policy_never_probed_or_mutated(self):
        self.native.guard.update(required=True, expected_ip='48.47.26.34')
        self.tick()
        self.assertEqual(self.native.actions, [])

    def test_changed_fixed_policy_during_refresh_not_held(self):
        self.native.subs['profiles'][0]['updated_at'] = '2000-01-01T00:00:00Z'
        self.native.after_refresh = lambda: self.native.guard.update(required=True, expected_ip='1.1.1.1')
        self.tick()
        self.assertEqual(self.native.actions, [('refresh',)])

    def test_other_operator_hold_wins(self):
        self.open()
        self.native.vm['schedule_disabled_reason'] = 'disabled'
        self.tick(NOW + 301)
        self.assertEqual(self.state['status'], 'external_hold')
        self.assertNotIn(('resume',), self.native.actions)

    def test_operator_hold_during_probe_wins(self):
        self.native.results = [FAIL, FAIL]
        self.native.after_probe = lambda: self.native.vm.update(schedulable=False, schedule_disabled_reason='disabled')
        self.tick()
        self.assertNotIn(('hold', REASON), self.native.actions)

    def test_account_or_binding_replacement_never_resumed(self):
        self.open()
        self.native.vm['account_uuid'] = 'account-b'
        self.tick(NOW + 301)
        self.assertNotIn(('resume',), self.native.actions)

    def test_revoked_credential_not_resumed(self):
        self.open()
        self.native.results = [OK, OK]
        self.native.vm['refresh_error'] = 'oauth_revoked'
        self.tick(NOW + 301)
        self.assertFalse(self.native.vm['schedulable'])

    def test_retained_node_needs_manual_binding(self):
        self.native.subs['profiles'][0]['updated_at'] = '2000-01-01T00:00:00Z'
        self.native.after_refresh = lambda: self.native.node.update(retained=True)
        self.tick()
        self.assertTrue(self.state['manual'])
        self.assertFalse(self.native.vm['schedulable'])

    def test_healthy_refresh_error_keeps_working_last_good_config(self):
        self.native.subs['profiles'][0]['updated_at'] = '2000-01-01T00:00:00Z'
        self.native.refresh_error = True
        self.tick()
        self.assertTrue(self.native.vm['schedulable'])
        self.assertEqual(self.state['issue'], 'refresh_TimeoutError')
        self.assertGreater(self.state['next_refresh'], NOW)

    def test_actual_curl_sends_hostname_to_socks_without_direct_fallback(self):
        seen = []
        server = socket.socket()
        server.bind(('127.0.0.1', 0))
        server.listen(1)
        server.settimeout(5)

        def socks():
            with server:
                client, _ = server.accept()
                with client:
                    client.settimeout(5)
                    greeting = client.recv(64)
                    seen.append(greeting[0])
                    client.sendall(b'\x05\x00')
                    header = client.recv(5)
                    seen.append(header[3])
                    seen.append(client.recv(header[4] + 2)[:-2].decode())
                    client.sendall(b'\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00')

        thread = threading.Thread(target=socks)
        thread.start()
        result = patrol.probe('socks5://127.0.0.1:' + str(server.getsockname()[1]),
                              'https://subscription-health.invalid')
        thread.join(6)
        self.assertFalse(thread.is_alive())
        self.assertEqual(seen, [5, 3, 'subscription-health.invalid'])
        self.assertFalse(result['ok'])
        self.assertFalse(result['security'])


if __name__ == '__main__':
    unittest.main()
