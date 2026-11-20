import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import uuid

import onboarding_runner
from onboarding_happy import StepFailed
from onboarding_runner import LOGIN_POLL_GAPS, Runner
from onboarding_store import STEPS, Store


class FakeHappy:
    def __init__(self, hosts, folder):
        self.hosts, self.folder = hosts, Path(folder)

    def paths(self, seat):
        key = self.folder / (seat + ".key")
        key.write_text("client-key-" + seat)
        return {"client_key": key}

    def __getattr__(self, name):
        return lambda *arguments, **fields: self.hosts.call("happy", name, *arguments)


class FakeHosts:
    """Records every host call in order; individual calls can be made to fail or to answer differently."""

    def __init__(self, folder):
        self.calls, self.failures, self.login = [], {}, []
        self.happy = FakeHappy(self, folder)
        self.answers = {
            ("nas", "selfcheck"): {"passed": True, "checks": {}},
            ("nas", "options"): {"options": [{"id": "direct", "label": "Direct", "expected_ip": "192.0.2.7"}]},
            ("nas", "prepare"): {"allocation": {"port": 18850}, "guard_revision": "rev"},
            ("nas", "native_start"): {"binding": 57100, "org": 419000},
            ("nas", "relay_key"): {"relay_key": "w" * 48},
            ("nas", "manager_install"): {"agent": "/a.py", "config": "/c.json", "guard_file": "/g.json",
                                         "guard_revision": "rev", "binding": 57100},
            ("sub", "sub_create"): {"account_id": 34100, "group_id": 130},
            ("happy", "gateway"): {"ledger_account": "ek_1", "client_key": "hidden"},
            ("happy", "manager"): {"relay_id": "reclaude-agentnas-seat"},
        }

    def call(self, host, action, *arguments, **fields):
        self.calls.append((host, action))
        failure = self.failures.get((host, action))
        if failure:
            if failure[0] > 0:
                failure[0] -= 1
                raise StepFailed(failure[1], "detail")
        if (host, action) == ("nas", "login_status"):
            return self.login.pop(0) if len(self.login) > 1 else self.login[0]
        return self.answers.get((host, action), {})

    def nas(self, action, **fields):
        return self.call("nas", action, **fields)

    def sub(self, action, **fields):
        return self.call("sub", action, **fields)

    def verify_manager(self, config):
        return {}

    def fail(self, host, action, code, times=1):
        self.failures[(host, action)] = [times, code]


WAITING = {"url": None, "bound": False, "running": True, "problems": [], "guard_ok": True}
LINKED = {**WAITING, "url": "https://login.example/cli/auth?state=abc"}
BOUND = {**LINKED, "bound": True, "binding": 57100, "running": False}


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = [1000.0]
        self.store = Store(self.temp.name, clock=lambda: self.now[0])
        self.store.prepare()
        self.store.beat()
        self.hosts = FakeHosts(self.temp.name)
        self.hosts.login = [WAITING, LINKED, BOUND]
        self.seen = []
        self.runner = Runner(self.store, self.hosts, ["ssh", "broker"], clock=lambda: self.now[0],
                             sleep=self.sleep, login_wait=900)
        self.runner.publish_options()

    def sleep(self, seconds):
        self.now[0] += seconds
        session = self.session()
        if session:
            self.seen.append((session["status"], (session["authorization"] or {}).get("url")))

    def session(self):
        saved = self.store.saved()
        return saved[-1] if saved else None

    def start(self):
        view = self.store.start(str(uuid.uuid4()), "Seat A", "direct", 419000)
        self.runner.tick()
        return view["seat"]

    def request(self, seat, action):
        self.store.change(str(uuid.uuid4()), seat, action)
        self.runner.tick()

    def done(self):
        return [key for key in STEPS if self.session()["steps"][key]["status"] == "done"]

    def test_a_session_runs_every_step_in_order_and_goes_live(self):
        self.start()
        session = self.session()
        self.assertEqual((session["status"], session["error"], session["authorization"]), ("live", None, None))
        self.assertEqual(self.done(), list(STEPS))
        self.assertEqual(session["result"], {"binding": 57100, "sub_account": 34100, "relay_id": "reclaude-agentnas-seat"})
        calls = self.hosts.calls
        order = [calls.index(call) for call in (
            ("nas", "selfcheck"), ("sub", "preflight"), ("happy", "preflight"), ("nas", "prepare"), ("nas", "prelogin"),
            ("nas", "login_start"), ("nas", "native_start"), ("nas", "worker_install"), ("nas", "ingress_install"),
            ("nas", "canary"), ("happy", "gateway"), ("sub", "block_public"), ("happy", "route"), ("sub", "sub_create"),
            ("happy", "open_gates"), ("sub", "sub_canary"), ("nas", "manager_install"), ("happy", "manager"),
            ("sub", "promote"), ("nas", "mark_live"), ("sub", "mark_live"), ("happy", "mark_live"))]
        self.assertEqual(order, sorted(order))
        self.assertEqual(calls.count(("nas", "canary")), 1)
        self.assertEqual(calls.count(("sub", "sub_canary")), 1)
        self.assertNotIn("w" * 48, json.dumps(session))
        self.assertNotIn("client-key", json.dumps(session))

    def test_the_link_is_shown_while_waiting_and_cleared_once_the_device_is_bound(self):
        self.start()
        self.assertIn(("awaiting_authorization", LINKED["url"]), self.seen)
        self.assertEqual(self.seen[0], ("running", None))
        self.assertIsNone(self.session()["authorization"])

    def test_a_failed_step_stops_the_session_and_retry_resumes_from_that_step(self):
        self.hosts.fail("nas", "worker_install", "worker_not_healthy")
        seat = self.start()
        session = self.session()
        self.assertEqual(session["status"], "failed")
        self.assertEqual(session["error"], {"step": "worker", "code": "worker_not_healthy", "detail": "detail", "retriable": True})
        self.assertEqual(self.done(), list(STEPS[:5]))
        self.assertNotIn(("happy", "gateway"), self.hosts.calls)
        before = len(self.hosts.calls)
        self.request(seat, "retry")
        self.assertEqual(self.session()["status"], "live")
        again = self.hosts.calls[before:]
        self.assertEqual(again[0], ("nas", "worker_install"))
        for repeated in (("nas", "prepare"), ("nas", "login_start"), ("nas", "native_start")):
            self.assertNotIn(repeated, again)

    def test_failures_before_authorization_and_exhausted_canaries_cannot_be_retried(self):
        for host, action, code, step in (("nas", "prepare", "egress_probe_failed", "prepare"),
                                         ("nas", "canary", "canary_attempts_exhausted", "native_canary"),
                                         ("sub", "sub_canary", "canary_attempts_exhausted", "sub_canary")):
            with self.subTest(step=step):
                self.setUp()
                self.hosts.fail(host, action, code)
                seat = self.start()
                self.assertEqual(self.session()["error"], {"step": step, "code": code, "detail": "detail", "retriable": False})
                with self.assertRaises(Exception):
                    self.store.change(str(uuid.uuid4()), seat, "retry")

    def test_the_exit_must_still_show_the_confirmed_address(self):
        view = self.store.start(str(uuid.uuid4()), "Seat A", "direct", 419000)
        self.hosts.answers[("nas", "options")] = {"options": [{"id": "direct", "label": "Direct", "expected_ip": "198.51.100.9"}]}
        self.runner.tick()
        self.assertEqual(self.session()["error"]["code"], "egress_ip_changed")
        self.assertEqual(self.session()["seat"], view["seat"])
        self.assertNotIn(("nas", "prepare"), self.hosts.calls)

    def test_an_unapproved_link_times_out_without_touching_later_steps(self):
        self.hosts.login = [LINKED]
        self.start()
        session = self.session()
        self.assertEqual((session["status"], session["error"]["code"], session["error"]["retriable"]),
                         ("failed", "authorization_timeout", False))
        self.assertNotIn(("nas", "native_start"), self.hosts.calls)

    def test_a_login_that_ends_without_a_device_fails_after_looking_again(self):
        self.hosts.login = [{**LINKED, "running": False, "problems": ["device_limit"]}]
        self.start()
        self.assertEqual(self.session()["error"]["code"], "login_ended")
        self.assertEqual(self.session()["error"]["detail"], "device_limit")
        self.assertEqual(self.hosts.calls.count(("nas", "login_status")), 3)

    def test_a_changed_exit_during_the_wait_stops_the_login(self):
        self.hosts.login = [{**LINKED, "guard_ok": False}]
        self.start()
        self.assertEqual(self.session()["error"]["code"], "exit_guard_not_ready")

    def test_abandoning_while_waiting_cancels_the_wait_and_cleans_up_in_order(self):
        self.hosts.login = [LINKED]
        view = self.store.start(str(uuid.uuid4()), "Seat A", "direct", 419000)
        original = self.runner.sleep

        def abandon_once(seconds):
            original(seconds)
            if not any(request["action"] == "abandon" for request in self.store.pending()) and self.session()["status"] == "awaiting_authorization":
                self.store.change(str(uuid.uuid4()), view["seat"], "abandon")
        self.runner.sleep = abandon_once
        self.runner.tick()
        session = self.session()
        self.assertEqual((session["status"], session["authorization"], session["error"]), ("abandoned", None, None))
        self.assertEqual(self.hosts.calls[-3:], [("sub", "abandon"), ("happy", "abandon"), ("nas", "abandon")])
        self.assertEqual(self.store.pending(), [])
        self.store.start(str(uuid.uuid4()), "Seat B", "direct", 419001)

    def test_a_failed_clean_up_can_be_asked_for_again(self):
        self.hosts.fail("nas", "canary", "native_canary_failed")
        seat = self.start()
        self.hosts.fail("happy", "abandon", "nginx_busy")
        self.request(seat, "abandon")
        session = self.session()
        self.assertEqual((session["status"], session["error"]["step"], session["error"]["retriable"]), ("failed", "abandon", False))
        self.assertNotIn(("nas", "abandon"), self.hosts.calls)
        self.request(seat, "abandon")
        self.assertEqual(self.session()["status"], "abandoned")
        self.assertEqual(self.hosts.calls[-1], ("nas", "abandon"))

    def test_a_live_seat_is_never_abandoned_or_restarted(self):
        seat = self.start()
        before = list(self.hosts.calls)
        for action in ("abandon", "retry"):
            self.store.submit({"id": str(uuid.uuid4()), "action": action, "seat": seat})
            self.runner.tick()
        self.assertEqual(self.hosts.calls, before)
        self.assertEqual(self.session()["status"], "live")

    def test_requests_are_checked_again_by_the_runner(self):
        for request in ({"seat": "../../etc", "name": "Seat", "egress": "direct", "org": 5},
                        {"seat": "ab12cd34", "name": "a/b", "egress": "direct", "org": 5},
                        {"seat": "ab12cd34", "name": "Seat", "egress": "Direct;rm", "org": 5},
                        {"seat": "ab12cd34", "name": "Seat", "egress": "direct", "org": "5"}):
            self.store.submit({"id": str(uuid.uuid4()), "action": "start", "expected_ip": "192.0.2.7", **request})
            self.runner.tick()
        self.assertEqual(self.store.saved(), [])
        self.assertEqual([call for call in self.hosts.calls if call != ("nas", "options")], [])

    def test_a_second_start_is_dropped_while_a_session_is_open(self):
        self.hosts.fail("nas", "prelogin", "exit_address_mismatch")
        self.start()
        self.store.submit({"id": str(uuid.uuid4()), "action": "start", "seat": "ab12cd34", "name": "Other",
                           "egress": "direct", "expected_ip": "192.0.2.7", "org": 6})
        self.runner.tick()
        self.assertEqual(len(self.store.saved()), 1)

    def test_after_a_restart_running_steps_stop_and_a_pending_authorization_keeps_waiting(self):
        self.hosts.fail("nas", "worker_install", "worker_not_healthy")
        seat = self.start()
        session = self.session()
        session["status"] = "running"
        session["error"] = None
        session["steps"]["worker"]["status"] = "running"
        self.store.save(session)
        self.runner.recover()
        self.assertEqual(self.session()["error"], {"step": "worker", "code": "runner_interrupted",
                                                   "detail": "the runner restarted during this step", "retriable": True})
        self.request(seat, "retry")
        self.assertEqual(self.session()["status"], "live")

        self.setUp()
        self.hosts.login = [LINKED]
        self.runner.login_wait = 5
        self.start()
        session = self.session()
        session.update(status="awaiting_authorization", error=None, authorization={"url": LINKED["url"], "expires_at": 0})
        session["steps"]["login"]["status"] = "running"
        session["facts"]["login_deadline"] = self.now[0] + 600
        self.store.save(session)
        self.hosts.login = [LINKED, BOUND]
        before = len(self.hosts.calls)
        self.runner.recover()
        self.assertEqual(self.session()["status"], "live")
        self.assertNotIn(("nas", "prepare"), self.hosts.calls[before:])

    def test_short_gaps_in_reaching_the_container_host_do_not_end_the_wait(self):
        self.hosts.login = [LINKED, BOUND]
        self.hosts.fail("nas", "login_status", "host_unreachable", times=LOGIN_POLL_GAPS)
        self.start()
        self.assertEqual(self.session()["status"], "live")
        self.assertEqual(self.hosts.calls.count(("nas", "login_start")), 1)

        for code, times, polls in (("host_timeout", LOGIN_POLL_GAPS + 1, LOGIN_POLL_GAPS + 1), ("seat_not_prepared", 1, 1)):
            with self.subTest(code=code):
                self.setUp()
                self.hosts.login = [LINKED, BOUND]
                self.hosts.fail("nas", "login_status", code, times=times)
                self.start()
                error = self.session()["error"]
                self.assertEqual((error["step"], error["code"], error["retriable"]), ("login", code, False))
                self.assertEqual(self.hosts.calls.count(("nas", "login_status")), polls)

    def test_abandoning_a_running_session_is_heard_before_the_next_step(self):
        view = self.store.start(str(uuid.uuid4()), "Seat A", "direct", 419000)

        def gateway(*arguments, **fields):
            self.hosts.calls.append(("happy", "gateway"))
            self.store.change(str(uuid.uuid4()), view["seat"], "abandon")
            return {"ledger_account": "ek_1"}
        self.hosts.happy.gateway = gateway
        self.runner.tick()
        session = self.session()
        self.assertEqual((session["status"], session["error"]), ("abandoned", None))
        self.assertEqual(self.done(), list(STEPS[:8]))
        self.assertNotIn(("sub", "block_public"), self.hosts.calls)
        self.assertEqual(self.hosts.calls[-3:], [("sub", "abandon"), ("happy", "abandon"), ("nas", "abandon")])
        self.assertEqual(self.store.pending(), [])

    def test_an_error_outside_a_step_neither_ends_the_service_nor_strands_a_session(self):
        ticks, recovered = [], []

        def tick():
            ticks.append(1)
            if len(ticks) == 1:
                raise OSError("no space left on device")
            raise KeyboardInterrupt()
        self.runner.tick = tick
        self.runner.recover = lambda: recovered.append(1)
        log = io.StringIO()
        with self.assertRaises(KeyboardInterrupt), contextlib.redirect_stderr(log):
            self.runner.run_forever()
        self.assertEqual((len(ticks), len(recovered)), (2, 2))
        self.assertEqual(log.getvalue(), "onboarding runner: OSError while handling a request\n")

    def test_the_liveness_mark_is_written_again_after_a_write_failed(self):
        marks = []

        class Flaky:
            def beat(self):
                marks.append(1)
                if len(marks) == 1:
                    raise OSError("no space left on device")
        with mock.patch.object(onboarding_runner.time, "sleep", side_effect=[None, None, KeyboardInterrupt()]):
            with self.assertRaises(KeyboardInterrupt):
                onboarding_runner.keep_marking(Flaky())
        self.assertEqual(len(marks), 3)

    def test_unexpected_errors_are_reported_by_type_only(self):
        def explode(*arguments, **fields):
            raise RuntimeError("/private/path secret")
        self.hosts.happy.gateway = explode
        self.start()
        error = self.session()["error"]
        self.assertEqual((error["step"], error["code"], error["detail"], error["retriable"]),
                         ("gateway", "runner_error", "RuntimeError", True))


if __name__ == "__main__":
    unittest.main()
