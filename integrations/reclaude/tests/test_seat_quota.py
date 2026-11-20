import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
import uuid

from management import ManagementError, Manager, seat_quota


def stamp(at):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(at)) + ".%03dZ" % (at % 1 * 1000)


class SeatQuotaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = time.time()
        self.config = {
            "id": "native-fixture", "name": "Fixture", "node": "isolated",
            "state_dir": str(self.root / "management"), "guard_source": "runtime",
            "guard_revision": "original", "expected_ip": "203.0.113.1", "binding": 1,
            "sub_account": 42, "concurrency": 10, "models": ["claude-fable-5-1"],
            "origin": "https://console.example", "runtime_command": ["runtime"], "sub_command": ["sub"],
            "official_quota": {"path": str(self.root / "quota.json"), "account_id": 3, "org_id": 2},
            "usage_ledger": {"path": str(self.root / "kin.db"), "account_id": "ek_a"},
        }
        with sqlite3.connect(self.root / "kin.db") as db:
            db.execute("create table usage_logs (created_at, account_id, final_account_id, attempt_count, total_cost)")
        self.r = {"ok": True, "http_active": True, "http_ready": True, "failed_checks": [],
                  "revoked": False, "auth_latched": False, "container_running": True,
                  "exit_guard": {"ready": True, "latched": False, "revision": "original",
                                 "expected_ip": "203.0.113.1", "observed_ip": "203.0.113.1",
                                 "checked_at": stamp(self.now)}}
        self.s = {"ok": True, "schedulable": True}
        self.calls = []
        self.fail = None
        self.manager = Manager(self.config, self.call)
        self.marker = self.root / "management/seat-quota-pause.json"

    def tearDown(self):
        self.temp.cleanup()

    def call(self, argv, action):
        self.calls.append((argv[0], action))
        if self.fail == (argv[0], action):
            raise ManagementError("fixture_failed", 503)
        if argv == ["sub"]:
            if action in ("pause", "resume"):
                self.s["schedulable"] = action == "resume"
            return copy.deepcopy(self.s)
        return copy.deepcopy(self.r)

    def reading(self, used, *, age=60, resets_in=86400):
        (self.root / "quota.json").write_text(json.dumps({
            "binding": 1, "org_id": 2, "account_id": 3, "used_usd": used, "quota_usd": 600,
            "observed_at_ms": int((self.now - age) * 1000), "resets_at_ms": int((self.now + resets_in) * 1000)}))

    def metered(self, cost, ago):
        with sqlite3.connect(self.root / "kin.db") as db:
            db.execute("insert into usage_logs values (?, 'ek_a', 'ek_a', 1, ?)", (stamp(self.now - ago), cost))

    def events(self):
        path = self.root / "management/audit.jsonl"
        return [json.loads(line)["event"] for line in path.read_text().splitlines()] if path.exists() else []

    def test_fresh_reading_is_used_as_is(self):
        self.reading(300)
        self.metered(50, 30)
        seat = seat_quota(self.config, self.now)
        self.assertEqual((seat["source"], seat["used_usd"], seat["remaining"]), ("official", 300, 0.5))

    def test_stale_reading_is_carried_forward_with_metered_cost(self):
        self.reading(300, age=3600)
        self.metered(100, 1800)
        self.metered(999, 7200)  # already inside the official figure
        seat = seat_quota(self.config, self.now)
        self.assertEqual(seat["source"], "estimated")
        self.assertAlmostEqual(seat["used_usd"], 405)
        self.assertFalse(seat["cycle_reset"])

    def test_after_the_reset_only_the_new_cycle_counts(self):
        self.reading(603, age=7200, resets_in=-3600)
        self.metered(40, 5400)  # previous cycle
        self.metered(20, 600)
        seat = seat_quota(self.config, self.now)
        self.assertTrue(seat["cycle_reset"])
        self.assertAlmostEqual(seat["used_usd"], 21)
        self.assertIsNone(seat["resets_at_ms"])

    def test_no_figure_at_the_reset_instant_cycles_later_or_without_a_ledger(self):
        self.reading(603, age=7200, resets_in=-60)
        self.assertIsNone(seat_quota(self.config, self.now))
        self.reading(603, age=9 * 86400, resets_in=-8 * 86400)
        self.assertIsNone(seat_quota(self.config, self.now))
        self.reading(300, age=3600)
        self.assertIsNone(seat_quota({**self.config, "usage_ledger": None}, self.now))
        self.assertIsNone(seat_quota({**self.config, "official_quota": None}, self.now))

    def test_exhausted_seat_is_paused_once_and_not_resumed_within_the_cycle(self):
        self.reading(596)
        state = self.manager.refresh()
        self.assertFalse(state["sub"]["schedulable"])
        self.assertTrue(state["seat_quota_paused"])
        self.assertEqual(json.loads(self.marker.read_text())["source"], "official")
        self.manager.refresh()
        self.assertEqual(self.calls.count(("sub", "pause")), 1)
        self.assertNotIn(("sub", "resume"), self.calls)
        self.assertNotIn(("runtime", "stop"), self.calls)
        self.assertEqual(self.events(), ["seat_quota_paused"])

    def test_estimate_pauses_when_the_reader_is_away(self):
        self.reading(500, age=7200)
        self.metered(95, 600)
        self.assertFalse(self.manager.refresh()["sub"]["schedulable"])
        self.assertEqual(json.loads(self.marker.read_text())["source"], "estimated")

    def test_seat_with_quota_left_is_untouched(self):
        self.reading(590)
        self.assertTrue(self.manager.refresh()["sub"]["schedulable"])
        self.assertEqual(self.calls, [("runtime", "status"), ("sub", "status")])

    def test_reset_resumes_our_own_pause_after_checking_the_exit(self):
        self.reading(603)
        self.manager.refresh()
        self.reading(603, age=7200, resets_in=-3600)
        state = self.manager.refresh()
        self.assertTrue(state["sub"]["schedulable"])
        self.assertFalse(state["seat_quota_paused"])
        self.assertFalse(self.marker.exists())
        self.assertLess(self.calls.index(("runtime", "verify_exit")), self.calls.index(("sub", "resume")))
        self.assertEqual(self.events(), ["seat_quota_paused", "seat_quota_resumed"])

    def test_fresh_reading_of_a_new_cycle_resumes_but_a_nearly_full_one_does_not(self):
        self.reading(603)
        self.manager.refresh()
        self.reading(580)
        self.assertFalse(self.manager.refresh()["sub"]["schedulable"])
        self.reading(12)
        self.assertTrue(self.manager.refresh()["sub"]["schedulable"])

    def test_unhealthy_relay_is_not_resumed_until_it_recovers(self):
        self.reading(603)
        self.manager.refresh()
        self.reading(0)
        self.r["http_ready"] = False
        self.assertFalse(self.manager.refresh()["sub"]["schedulable"])
        self.assertTrue(self.marker.exists())
        self.reading(0, age=3600)  # the reader went away again in the meantime
        self.metered(10, 60)
        self.r["http_ready"] = True
        self.assertTrue(self.manager.refresh()["sub"]["schedulable"])

    def test_failed_exit_check_does_not_resume_and_is_not_repeated_at_once(self):
        self.reading(603)
        self.manager.refresh()
        self.reading(0)
        self.fail = ("runtime", "verify_exit")
        self.manager.refresh()
        self.fail = None
        self.assertFalse(self.manager.refresh()["sub"]["schedulable"])
        self.assertEqual(self.calls.count(("runtime", "verify_exit")), 1)
        self.manager.exit_retry_at = 0
        self.assertTrue(self.manager.refresh()["sub"]["schedulable"])

    def test_operator_pause_is_never_resumed_by_a_reset(self):
        self.s["schedulable"] = False
        self.reading(603)
        self.manager.refresh()
        self.assertFalse(self.marker.exists())
        self.reading(0)
        self.assertFalse(self.manager.refresh()["sub"]["schedulable"])
        self.assertNotIn(("sub", "resume"), self.calls)

    def test_operator_pause_after_ours_takes_over(self):
        self.reading(603)
        self.manager.refresh()
        self.manager.action("pause_schedule", str(uuid.uuid4()))
        self.assertFalse(self.marker.exists())
        self.reading(0)
        self.assertFalse(self.manager.refresh()["sub"]["schedulable"])
        self.assertIn("seat_quota_pause_superseded", self.events())
        self.assertNotIn("seat_quota_resumed", self.events())

    def test_operator_cannot_schedule_an_exhausted_seat(self):
        self.reading(603)
        self.manager.refresh()
        for action in ("resume_schedule", "start"):
            with self.assertRaises(ManagementError) as raised:
                self.manager.action(action, str(uuid.uuid4()))
            self.assertEqual(raised.exception.code, "seat_quota_exhausted")
        self.assertNotIn(("sub", "resume"), self.calls)
        self.assertNotIn(("runtime", "start"), self.calls)
        self.assertTrue(self.marker.exists())  # the reset still brings it back

    def test_resume_outside_the_manager_ends_our_pause(self):
        self.reading(603)
        self.manager.refresh()
        self.reading(300)
        self.s["schedulable"] = True
        state = self.manager.refresh()
        self.assertTrue(state["sub"]["schedulable"])
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.events(), ["seat_quota_paused", "seat_quota_pause_superseded"])


if __name__ == "__main__":
    unittest.main()
