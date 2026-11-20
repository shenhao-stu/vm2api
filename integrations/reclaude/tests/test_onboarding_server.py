import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from types import SimpleNamespace

from management import ManagementError
from management_server import Server
from onboarding_store import Store, new_session

ORIGIN = "https://console.example"


def relay(number, folder):
    config = dict(id=f"relay-{number}", name=f"Relay {number}", binding=number, sub_account=100 + number, node="test",
                  concurrency=10, models=["m"], expected_ip="192.0.2.1", state_dir=f"{folder}/state-{number}", origin=ORIGIN,
                  runtime_command=["remote", str(number)], sub_command=["broker", str(number)])
    return SimpleNamespace(config=config, root=Path(config["state_dir"]), cached=None)


class OnboardingRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        self.store.prepare()
        self.store.beat()
        (Path(self.temp.name) / "options.json").write_text(json.dumps([{"id": "direct", "label": "Direct", "expected_ip": "192.0.2.7"}]))
        self.admin = True
        self.server = self.serve(self.store)

    def serve(self, store):
        def authorize(_):
            if not self.admin:
                raise ManagementError("admin_required", 403)
        server = Server(("127.0.0.1", 0), [relay(1, self.temp.name)], authorize, onboarding=store)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def call(self, verb, path="", body=None, origin=ORIGIN, server=None, content="application/json"):
        connection = http.client.HTTPConnection(*(server or self.server).server_address, timeout=3)
        try:
            data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
            connection.request(verb, "/api/panel/native-relays/onboarding" + path, data,
                               headers={"Origin": origin, "Content-Type": content})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def start(self, **changes):
        return self.call("POST", body={"operation_id": str(uuid.uuid4()), "name": "Seat A", "egress": "direct", "org": 419000, **changes})

    def test_the_view_lists_exits_and_sessions(self):
        status, body = self.call("GET")
        self.assertEqual((status, body["data"]), (200, {"options": [{"id": "direct", "label": "Direct", "expected_ip": "192.0.2.7"}],
                                                        "sessions": [], "busy": False, "runner_alive": True}))

    def test_nothing_is_queued_while_the_runner_is_not_running(self):
        (Path(self.temp.name) / "runner.alive").unlink()
        self.assertEqual(self.call("GET")[1]["data"]["runner_alive"], False)
        status, body = self.start()
        self.assertEqual((status, body["error"]["code"]), (503, "runner_not_running"))
        self.assertEqual(self.store.pending(), [])

    def test_start_queues_a_request_and_a_second_start_is_refused(self):
        status, body = self.start()
        self.assertEqual((status, body["data"]["status"], body["data"]["name"]), (200, "queued", "Seat A"))
        self.assertEqual(len(self.store.pending()), 1)
        self.assertEqual(self.call("GET")[1]["data"]["busy"], True)
        status, body = self.start()
        self.assertEqual((status, body["error"]["code"]), (409, "onboarding_in_progress"))

    def test_bodies_are_strict_and_come_from_the_console_origin(self):
        cases = (
            (dict(origin="https://elsewhere.example"), 403, "origin_required"),
            (dict(content="text/plain"), 415, "json_required"),
            (dict(body=b"{"), 400, "invalid_body"),
            (dict(body={"operation_id": str(uuid.uuid4()), "name": "Seat", "egress": "direct", "org": 5, "host": "x"}), 400, "invalid_body"),
            (dict(body={"operation_id": str(uuid.uuid4()), "name": "Seat", "egress": "direct"}), 400, "invalid_body"),
            (dict(body={"operation_id": str(uuid.uuid4()), "name": "x" * 600, "egress": "direct", "org": 5}), 400, "invalid_body"),
            (dict(body={"operation_id": str(uuid.uuid4()), "name": "../x", "egress": "direct", "org": 5}), 400, "invalid_name"),
            (dict(body={"operation_id": str(uuid.uuid4()), "name": "Seat", "egress": "other", "org": 5}), 400, "unknown_egress"),
            (dict(body={"operation_id": "1", "name": "Seat", "egress": "direct", "org": 5}), 400, "invalid_operation_id"),
        )
        for arguments, status, code in cases:
            with self.subTest(code=code):
                got, body = self.call("POST", **{"body": {"operation_id": str(uuid.uuid4()), "name": "Seat", "egress": "direct", "org": 5},
                                                 **arguments})
                self.assertEqual((got, body["error"]["code"]), (status, code))
        self.assertEqual(self.store.pending(), [])

    def test_retry_and_abandon_follow_the_session_state(self):
        session = new_session("ab12cd34", "Seat", "direct", "192.0.2.7", 5, 1.0)
        session.update(status="failed", error={"step": "worker", "code": "worker_not_healthy", "detail": "", "retriable": True})
        session["facts"]["secret"] = "internal"
        self.store.save(session)
        status, body = self.call("GET")
        self.assertNotIn("internal", json.dumps(body))
        self.assertEqual(body["data"]["sessions"][0]["error"]["code"], "worker_not_healthy")
        operation = {"operation_id": str(uuid.uuid4())}
        self.assertEqual(self.call("POST", "/ab12cd34/retry", operation)[0], 200)
        self.assertEqual(self.call("POST", "/ab12cd34/retry", operation), (409, {"ok": False, "error": {
            "code": "operation_already_consumed", "message": "operation_already_consumed"}}))
        self.assertEqual(self.call("POST", "/ab12cd34/abandon", {"operation_id": str(uuid.uuid4())})[0], 200)
        self.assertEqual([request["action"] for request in self.store.pending()], ["retry", "abandon"])
        for path, status in (("/ab12cd34/delete", 404), ("/ffffffff/abandon", 404), ("/ab12cd34/abandon/extra", 404), ("/..%2f/abandon", 404)):
            self.assertEqual(self.call("POST", path, {"operation_id": str(uuid.uuid4())})[0], status)
        self.assertEqual(self.call("GET", "/ab12cd34/retry")[0], 404)

    def test_only_administrators_reach_onboarding_and_it_is_absent_unless_enabled(self):
        self.admin = False
        self.assertEqual(self.call("GET")[0], 403)
        self.assertEqual(self.start()[0], 403)
        self.admin = True
        plain = self.serve(None)
        self.assertEqual(self.call("GET", server=plain), (404, {"ok": False, "error": {"code": "not_found", "message": "not_found"}}))
        self.assertEqual(self.start()[0], 200)


class FollowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / "manager-configs"
        self.folder.mkdir()
        self.server = Server(("127.0.0.1", 0), [relay(1, self.temp.name)], lambda _: True)
        self.addCleanup(self.server.server_close)
        self.create = lambda config: SimpleNamespace(config=config, root=Path(config["state_dir"]), cached=None)

    def publish(self, number, **changes):
        config = {**relay(number, self.temp.name).config, **changes}
        (self.folder / f"seat{number}.json").write_text(json.dumps(config))
        return config

    def test_new_entries_are_served_and_removed_ones_dropped_without_a_restart(self):
        self.assertEqual(self.server.follow_onboarded(self.folder, self.create), [])
        self.publish(2)
        registry = self.server.managers
        added = self.server.follow_onboarded(self.folder, self.create)
        self.assertEqual([manager.config["id"] for manager in added], ["relay-2"])
        self.assertEqual(sorted(self.server.managers), ["relay-1", "relay-2"])
        self.assertEqual(sorted(registry), ["relay-1"], "a registry in use is replaced, never changed in place")
        self.assertEqual(self.server.follow_onboarded(self.folder, self.create), [])
        (self.folder / "seat2.json").unlink()
        self.server.follow_onboarded(self.folder, self.create)
        self.assertEqual(sorted(self.server.managers), ["relay-1"])

    def test_entries_that_conflict_with_a_served_relay_are_ignored(self):
        self.publish(2, binding=1)
        self.publish(3, id="onboarding")
        self.publish(4, origin="https://elsewhere.example")
        self.publish(5, sub_command=["broker", "1"])
        (self.folder / "seat6.json").write_text("{")
        (self.folder / ".seat7.json").write_text(json.dumps(relay(7, self.temp.name).config))
        self.assertEqual(self.server.follow_onboarded(self.folder, self.create), [])
        self.assertEqual(sorted(self.server.managers), ["relay-1"])
        self.publish(2)
        self.assertEqual(len(self.server.follow_onboarded(self.folder, self.create)), 1)

    def test_configured_relays_are_never_dropped(self):
        self.publish(2)
        self.server.follow_onboarded(self.folder, self.create)
        for path in self.folder.iterdir():
            path.unlink()
        self.server.follow_onboarded(self.folder, self.create)
        self.assertEqual(sorted(self.server.managers), ["relay-1"])


if __name__ == "__main__":
    unittest.main()
