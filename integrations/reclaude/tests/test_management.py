from datetime import datetime, timezone
import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid

from management import ManagementError, Manager, guard_status
from management_server import Server


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = {
            "id": "native-fixture", "name": "Fixture", "node": "isolated",
            "state_dir": str(self.root / "management"),
            "guard_file": str(self.root / "guard.json"), "guard_revision": "original",
            "expected_ip": "203.0.113.1", "binding": 1, "sub_account": 42,
            "concurrency": 10, "models": ["claude-fable-5-1"],
            "origin": "https://console.example", "runtime_command": ["runtime"],
            "sub_command": ["sub"],
        }
        self.guard = {"ready": True, "latched": False, "revision": "original",
                      "expected_ip": "203.0.113.1", "observed_ip": "203.0.113.1",
                      "checked_at": datetime.now(timezone.utc).isoformat()}
        self.save_guard()
        self.r = {"ok": True, "http_active": True, "http_ready": True, "failed_checks": [],
                  "revoked": False, "auth_latched": False, "container_running": True}
        self.s = {"ok": True, "schedulable": True}
        self.calls = []
        self.fail = None
        self.manager = Manager(self.config, self.call)

    def tearDown(self):
        self.temp.cleanup()

    def save_guard(self):
        Path(self.config["guard_file"]).write_text(json.dumps(self.guard))

    def call(self, argv, action):
        self.calls.append((argv[0], action))
        if self.fail == (argv[0], action):
            raise ManagementError("fixture_failed", 503)
        if argv == ["sub"]:
            if action in ("pause", "resume"):
                self.s["schedulable"] = action == "resume"
            return copy.deepcopy(self.s)
        if action in ("start", "stop"):
            self.r["http_active"] = self.r["http_ready"] = action == "start"
        if action == "logs":
            return {"ok": True, "items": []}
        return copy.deepcopy(self.r)

    def action(self, action):
        return self.manager.action(action, str(uuid.uuid4()))

    def test_stop_pauses_before_stopping_and_never_calls_native_container_lifecycle(self):
        self.action("stop")
        mutations = [x for x in self.calls if x[1] != "status"]
        self.assertEqual(mutations, [("sub", "pause"), ("runtime", "stop")])
        self.assertFalse(self.manager.status()["sub"]["schedulable"])

    def test_start_verifies_exit_then_worker_then_sub(self):
        self.s["schedulable"] = False
        self.r["http_active"] = self.r["http_ready"] = False
        result = self.action("start")
        self.assertTrue(result["sub"]["schedulable"])
        self.assertEqual([x for x in self.calls if x[1] != "status"],
                         [("runtime", "verify_exit"), ("runtime", "start"), ("sub", "resume")])

    def test_changed_ip_failed_probe_stale_or_rearmed_revision_cannot_start(self):
        for change in ({"observed_ip": "203.0.113.2"}, {"ready": False}, {"latched": True},
                       {"revision": "replacement"}, {"checked_at": "2000-01-01T00:00:00Z"}):
            original = self.guard.copy()
            self.guard.update(change)
            self.save_guard()
            self.calls.clear()
            with self.assertRaises(ManagementError):
                self.action("start")
            self.assertTrue(all(x[1] == "status" for x in self.calls))
            self.guard = original

    def test_failed_live_exit_probe_does_not_start_or_resume(self):
        self.fail = ("runtime", "verify_exit")
        with self.assertRaises(ManagementError):
            self.action("start")
        self.assertNotIn(("runtime", "start"), self.calls)
        self.assertNotIn(("sub", "resume"), self.calls)

    def test_revocation_pauses_first_then_persists_and_never_auto_recovers(self):
        self.r["revoked"] = True
        self.manager.refresh()
        evidence = self.manager.root / "authorization-latch.json"
        self.assertTrue(json.loads(evidence.read_text())["paused"])
        self.assertFalse(self.s["schedulable"])
        self.r["revoked"] = False
        self.calls.clear()
        with self.assertRaises(ManagementError):
            self.action("start")
        self.assertTrue(all(x[1] == "status" for x in self.calls))
        self.assertTrue(evidence.exists())

    def test_pause_failure_cannot_claim_paused_or_stop(self):
        self.fail = ("sub", "pause")
        with self.assertRaises(ManagementError):
            self.action("stop")
        self.assertNotIn(("runtime", "stop"), self.calls)
        self.r["revoked"] = True
        with self.assertRaises(ManagementError):
            self.manager.refresh()
        self.assertFalse((self.manager.root / "authorization-latch.json").exists())

    def test_inflight_refusal_preserves_worker_and_pauses_sub(self):
        self.fail = ("runtime", "stop")
        with self.assertRaises(ManagementError):
            self.action("stop")
        self.assertFalse(self.s["schedulable"])
        self.assertTrue(self.r["http_active"])

    def test_operation_is_not_replayed_after_failure(self):
        operation = str(uuid.uuid4())
        self.fail = ("runtime", "stop")
        with self.assertRaises(ManagementError):
            self.manager.action("stop", operation)
        self.fail = None
        self.calls.clear()
        with self.assertRaisesRegex(ManagementError, "already_consumed"):
            self.manager.action("stop", operation)
        self.assertEqual(self.calls, [])

    def test_no_client_command_paths_ids_or_shell(self):
        for action, operation in [("rearm", str(uuid.uuid4())), ("start", "../../file"),
                                  ("start", "$(touch /tmp/no)")]:
            with self.assertRaises(ManagementError):
                self.manager.action(action, operation)
        self.assertEqual(self.calls, [])

    def test_no_guard_file_fails_closed(self):
        Path(self.config["guard_file"]).unlink()
        self.assertFalse(guard_status(self.config)["ready"])

    def test_http_auth_origin_unknown_target_and_success(self):
        def auth(value):
            if value != "Bearer admin-fixture":
                raise ManagementError("unauthorized", 401)
        server = Server(("127.0.0.1", 0), self.manager, auth)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(path, method="GET", authorized=True, origin=None, body=None):
            c = http.client.HTTPConnection(*server.server_address, timeout=3)
            headers = {"Content-Type": "application/json"}
            if authorized:
                headers["Authorization"] = "Bearer admin-fixture"
            if origin:
                headers["Origin"] = origin
            c.request(method, path, json.dumps(body) if body else None, headers)
            r = c.getresponse()
            result = r.status, json.loads(r.read())
            c.close()
            return result
        prefix = "/api/panel/native-relays"
        try:
            self.assertEqual(request(prefix, authorized=False)[0], 401)
            self.assertEqual(request(prefix + "/other/stop", "POST")[0], 404)
            body = {"operation_id": str(uuid.uuid4())}
            self.assertEqual(request(prefix + "/native-fixture/stop", "POST", body=body)[0], 403)
            self.assertTrue(self.s["schedulable"])
            status, data = request(prefix)
            self.assertEqual(status, 200)
            self.assertEqual(data["items"][0]["models"], ["claude-fable-5-1"])
            self.assertEqual(request(prefix + "/native-fixture/stop", "POST", origin=self.config["origin"], body=body)[0], 200)
            self.assertFalse(self.s["schedulable"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
