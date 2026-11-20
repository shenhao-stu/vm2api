import json
from pathlib import Path
import tempfile
import unittest
import uuid

from onboarding_store import OnboardingError, STEPS, Store, new_session, public_view


def operation():
    return str(uuid.uuid4())


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = [1000.0]
        self.store = Store(self.temp.name, clock=lambda: self.now[0])
        self.store.prepare()
        (Path(self.temp.name) / "options.json").write_text(json.dumps(
            [{"id": "direct", "label": "Direct", "expected_ip": "192.0.2.7"}, {"id": "../x", "label": "bad", "expected_ip": "x"}]))

    def code(self, call, *arguments):
        with self.assertRaises(OnboardingError) as raised:
            call(*arguments)
        return raised.exception.code

    def test_only_listed_exits_and_plain_values_start_a_session(self):
        self.assertEqual([row["id"] for row in self.store.options()], ["direct"])
        for name, egress, org, expected in (
                ("", "direct", 5, "invalid_name"), ("a/b", "direct", 5, "invalid_name"), (" lead", "direct", 5, "invalid_name"),
                ("x" * 25, "direct", 5, "invalid_name"), ("Seat", "socks9", 5, "unknown_egress"),
                ("Seat", "direct", "5", "invalid_org"), ("Seat", "direct", True, "invalid_org"), ("Seat", "direct", 0, "invalid_org")):
            with self.subTest(name=name, egress=egress, org=org):
                self.assertEqual(self.code(self.store.start, operation(), name, egress, org), expected)
        self.assertEqual(self.code(self.store.start, "not-a-uuid", "Seat", "direct", 5), "invalid_operation_id")
        self.assertEqual(list(self.store.spool.iterdir()), [])

    def test_start_queues_one_request_with_the_confirmed_address(self):
        view = self.store.start(operation(), "新席位 A", "direct", 419000)
        self.assertRegex(view["seat"], r"^[0-9a-f]{8}$")
        self.assertEqual((view["status"], view["expected_ip"], len(view["steps"])), ("queued", "192.0.2.7", len(STEPS)))
        request = self.store.take()
        self.assertEqual({key: request[key] for key in ("action", "seat", "name", "egress", "expected_ip", "org")},
                         {"action": "start", "seat": view["seat"], "name": "新席位 A", "egress": "direct",
                          "expected_ip": "192.0.2.7", "org": 419000})
        self.assertIsNone(self.store.take())

    def test_an_operation_id_is_consumed_once(self):
        first = operation()
        self.store.start(first, "Seat", "direct", 5)
        self.store.take()
        self.assertEqual(self.code(self.store.submit, {"id": first, "action": "abandon", "seat": "0" * 8}), "operation_already_consumed")

    def test_one_open_session_at_a_time(self):
        view = self.store.start(operation(), "Seat", "direct", 5)
        self.assertTrue(self.store.view()["busy"])
        self.assertEqual(self.code(self.store.start, operation(), "Other", "direct", 6), "onboarding_in_progress")
        session = new_session(view["seat"], "Seat", "direct", "192.0.2.7", 5, 1000.0)
        self.store.take()
        for status, allowed in (("failed", False), ("awaiting_authorization", False), ("abandoned", True), ("live", True)):
            session["status"] = status
            self.store.save(session)
            with self.subTest(status=status):
                if allowed:
                    self.store.start(operation(), "Other", "direct", 6)
                    self.store.take()
                else:
                    self.assertEqual(self.code(self.store.start, operation(), "Other", "direct", 6), "onboarding_in_progress")

    def test_retry_needs_a_retriable_failure_and_closed_sessions_stay_closed(self):
        session = new_session("ab12cd34", "Seat", "direct", "192.0.2.7", 5, 1000.0)
        self.store.save(session)
        self.assertEqual(self.code(self.store.change, operation(), "ab12cd34", "retry"), "retry_not_available")
        session.update(status="failed", error={"step": "login", "code": "login_ended", "retriable": False})
        self.store.save(session)
        self.assertEqual(self.code(self.store.change, operation(), "ab12cd34", "retry"), "retry_not_available")
        session["error"]["retriable"] = True
        self.store.save(session)
        self.store.change(operation(), "ab12cd34", "retry")
        self.store.change(operation(), "ab12cd34", "abandon")
        self.assertEqual([request["action"] for request in self.store.pending()], ["retry", "abandon"])
        self.assertEqual(self.code(self.store.change, operation(), "ab12cd34", "restart"), "not_found")
        self.assertEqual(self.code(self.store.change, operation(), "ffffffff", "abandon"), "not_found")
        for status in ("live", "abandoned", "abandoning"):
            session["status"] = status
            self.store.save(session)
            self.assertEqual(self.code(self.store.change, operation(), "ab12cd34", "abandon"), "session_closed")

    def test_take_can_pick_a_matching_request_and_drops_unreadable_files(self):
        (self.store.spool / "junk.json").write_text("{")
        (self.store.spool / (operation() + ".json")).write_text(json.dumps({"id": operation(), "action": "abandon", "seat": "0" * 8}))
        session = new_session("ab12cd34", "Seat", "direct", "192.0.2.7", 5, 1000.0)
        session["status"] = "failed"
        self.store.save(session)
        self.store.change(operation(), "ab12cd34", "abandon")
        self.assertIsNone(self.store.take(lambda request: request["seat"] == "ffffffff"))
        taken = self.store.take(lambda request: request["action"] == "abandon")
        self.assertEqual(taken["seat"], "ab12cd34")
        self.assertEqual(list(self.store.spool.iterdir()), [])

    def test_a_file_that_vanishes_while_the_spool_is_listed_is_skipped(self):
        # The two services add and remove spool files while the other one lists them. A name
        # whose file is already gone behaves exactly like this dangling link.
        (self.store.spool / "gone.json").symlink_to(self.store.spool / "missing")
        (self.store.spool / ".being-written").write_text("{")
        self.store.start(operation(), "Seat", "direct", 5)
        self.assertEqual([request["action"] for request in self.store.pending()], ["start"])
        self.assertTrue(self.store.view()["busy"])
        self.assertEqual(self.store.take()["action"], "start")
        self.assertIsNone(self.store.take())
        self.assertTrue((self.store.spool / ".being-written").exists())

    def test_the_browser_view_has_no_internal_facts_and_forgets_old_closed_sessions(self):
        session = new_session("ab12cd34", "Seat", "direct", "192.0.2.7", 5, 1000.0)
        session["facts"]["ledger_account"] = "ek_private"
        session["status"] = "live"
        self.store.save(session)
        view = self.store.view()
        self.assertNotIn("facts", view["sessions"][0])
        self.assertNotIn("ek_private", json.dumps(view))
        self.assertEqual([step["key"] for step in public_view(session)["steps"]], list(STEPS))
        self.now[0] += 90000
        self.assertEqual(self.store.view()["sessions"], [])
        self.assertEqual(self.store.load("../ab12cd34"), None)


if __name__ == "__main__":
    unittest.main()
