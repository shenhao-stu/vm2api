import json
from pathlib import Path
import tempfile
import unittest

from native_http import NativeHealth


class NativeHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.rec = self.home / ".rec"
        account = self.rec / "claude/accounts/123/config"
        account.mkdir(parents=True)
        (account / ".credentials.json").write_text("{}")
        (self.rec / "claude/current").write_text("123")
        (self.rec / "logs").mkdir()
        self.log = self.rec / "logs/daemon.log"
        self.log.write_text("")
        self.state = {
            "daemon": {
                "running": True,
                "pid": 42,
                "leak_report": True,
                "started_at_ms": 1793400000000,
            },
            "identities": {
                "claude": {
                    "gateway": {"healthy": True},
                    "last_error": None,
                    "bindings": {"123": {"device_id": 123}},
                }
            },
        }
        self.write_state()
        self.health = NativeHealth(self.home, 123)

    def tearDown(self):
        self.temp.cleanup()

    def write_state(self):
        (self.rec / "state.json").write_text(json.dumps(self.state))

    def test_global_revocation_blocks_even_when_account_is_healthy(self):
        self.log.write_text(
            "2026-10-30 22:41:21.123 reclaude intercept sync: "
            'unexpected status 401: {"error":{"code":"device_revoked"}}\n'
        )
        self.assertTrue(self.health.authorization_revoked())
        self.assertIn(
            "native_control_authorization_revoked", self.health.failed_health_checks()
        )

    def test_restart_does_not_reuse_historic_revocation(self):
        self.log.write_text(
            "2026-10-30 20:15:21.123 reclaude intercept sync: "
            'unexpected status 401: {"error":{"code":"device_revoked"}}\n'
        )
        self.assertFalse(self.health.authorization_revoked())
        self.assertEqual(self.health.failed_health_checks(), [])

    def test_daemon_must_match_current_binding(self):
        self.state["identities"]["claude"]["bindings"] = {"122": {"device_id": 122}}
        self.write_state()
        self.assertIn("native_binding_mismatch", self.health.failed_health_checks())

    def test_native_default_binding_must_match(self):
        (self.rec / "claude/current").write_text("122")
        self.assertIn("native_binding_mismatch", self.health.failed_health_checks())


if __name__ == "__main__":
    unittest.main()
