"""Offline: an unconfirmed policy pauses new launches instead of repeating them.

Production 2026-11-20 (one relay): the provider answered every call of one account
with 429 for hours. Each caller request still launched a native CLI, which made
24-60 rejected calls before giving up, and the next request did the same.
"""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid

from adapter import Limits
from native_bridge_session import RequestRejected
from native_http import NativeServer
from native_launch_backoff import LAUNCH_REFUSED, PROBE_WAIT_SECONDS, LaunchBackoff
from native_reply_cache import ZERO_USAGE

try:
    from test_native_http import FixtureSession, Health
except ImportError:  # run as tests.test_native_launch_backoff
    from tests.test_native_http import FixtureSession, Health


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Backoff(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.gate = LaunchBackoff(base_seconds=30, max_seconds=900, clock=self.clock)

    def test_nothing_is_refused_before_a_failure(self):
        self.assertEqual([self.gate.admit() for _ in range(5)], [(0, 0)] * 5)
        self.assertEqual(self.gate.snapshot(), {"failures": 0, "retry_in_seconds": 0, "probing": False})

    def test_a_failure_pauses_then_admits_exactly_one_probe(self):
        epoch, _ = self.gate.admit()
        self.gate.failed(epoch)
        self.assertEqual(self.gate.admit(), (None, 30))
        self.clock.now += 29.5
        self.assertEqual(self.gate.admit(), (None, 1))
        self.clock.now += 0.5
        self.assertEqual(self.gate.admit(), (1, 0))
        self.assertEqual(self.gate.admit(), (None, PROBE_WAIT_SECONDS))

    def test_each_failed_probe_doubles_the_pause_up_to_the_cap(self):
        pauses = []
        for _ in range(8):
            epoch, wait = self.gate.admit()
            self.assertEqual(wait, 0)
            self.gate.failed(epoch)
            pauses.append(self.gate.admit()[1])
            self.clock.now += pauses[-1]
        self.assertEqual(pauses, [30, 60, 120, 240, 480, 900, 900, 900])

    def test_a_success_clears_the_pause(self):
        self.gate.failed(self.gate.admit()[0])
        self.clock.now += 30
        self.assertEqual(self.gate.admit(), (1, 0))
        self.gate.succeeded()
        self.assertEqual([self.gate.admit() for _ in range(3)], [(0, 0)] * 3)

    def test_launches_that_fail_together_count_once(self):
        epochs = [self.gate.admit()[0] for _ in range(5)]
        for epoch in epochs:
            self.gate.failed(epoch)
        self.assertEqual(self.gate.snapshot()["failures"], 1)
        self.assertEqual(self.gate.admit(), (None, 30))

    def test_a_probe_that_learned_nothing_hands_over_to_the_next_request(self):
        self.gate.failed(self.gate.admit()[0])
        self.clock.now += 30
        epoch, _ = self.gate.admit()
        self.gate.release(epoch)
        self.assertEqual(self.gate.admit(), (1, 0))
        self.assertEqual(self.gate.snapshot()["failures"], 1)

    def test_invalid_limits_are_rejected(self):
        for base, cap in ((0, 10), (20, 10), (-1, 10)):
            with self.assertRaises(ValueError):
                LaunchBackoff(base_seconds=base, max_seconds=cap)


class PolicySession(FixtureSession):
    """A launch that the provider does not confirm leaves the conversation untouched."""

    def request(self, body):
        self.owner.launches += 1
        if self.owner.unconfirmed:
            raise RequestRejected(LAUNCH_REFUSED)
        yield from super().request(body)

    def prepare_request(self, body):
        self.owner.launches += 1
        if self.owner.unconfirmed:
            raise RequestRejected(LAUNCH_REFUSED)
        return super().prepare_request(body)


class BackoffHTTP(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.launches = 0
        self.unconfirmed = False
        self.created = []

        def factory(path, body):
            session = PolicySession(path, body)
            session.owner = self
            self.created.append(session)
            return session

        self.server = NativeServer(
            ("127.0.0.1", 0), Health(), "k" * 40, self.root, factory,
            limits=Limits(models=("claude-sonnet-5-5",), concurrency=2), allow_prewarm=True)
        self.clock = Clock()
        self.server.launches = LaunchBackoff(clock=self.clock)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.identity = str(uuid.uuid4())

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def body(self, **changes):
        return {"model": "claude-sonnet-5-5", "max_tokens": 1024, "stream": False,
                "metadata": {"user_id": self.identity},
                "messages": [{"role": "user", "content": "fixture"}], **changes}

    def request(self, body=None, path="/v1/messages"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=8)
        connection.request("POST", path, json.dumps(body or self.body()),
                           {"Content-Type": "application/json", "Authorization": "Bearer " + "k" * 40})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def health(self):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=8)
        connection.request("GET", "/healthz")
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def audit(self, count):
        path = self.root / "audit.jsonl"
        for _ in range(100):
            rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
            if len(rows) >= count:
                return rows
            time.sleep(.02)
        self.fail("audit rows missing")

    def code(self, response):
        return response[0], response[1]["error"]["message"]

    def test_after_an_unconfirmed_launch_other_requests_are_refused_without_launching(self):
        self.unconfirmed = True
        self.assertEqual(self.code(self.request()), (503, LAUNCH_REFUSED))
        self.assertEqual((self.launches, len(self.created)), (1, 1))
        for _ in range(3):
            self.identity = str(uuid.uuid4())  # other conversations are refused as well
            self.assertEqual(self.code(self.request()), (503, LAUNCH_REFUSED))
        self.assertEqual((self.launches, len(self.created)), (1, 1))
        rows = self.audit(4)
        self.assertNotIn("launch_backoff_seconds", rows[0])
        self.assertEqual([r["launch_backoff_seconds"] for r in rows[1:]], [30, 30, 30])
        self.assertEqual([(r["status"], r["error"], r["attempts"]) for r in rows[1:]],
                         [(503, LAUNCH_REFUSED, 0)] * 3)
        # Refusals made by the pause itself do not lengthen it.
        self.assertEqual(self.server.launches.snapshot(), {"failures": 1, "retry_in_seconds": 30, "probing": False})

    def test_one_probe_runs_after_the_pause_and_a_confirmed_launch_reopens_the_relay(self):
        self.unconfirmed = True
        self.request()
        self.clock.now += 30
        self.unconfirmed = False
        status, answer = self.request()
        self.assertEqual((status, answer["content"][0]["text"]), (200, "fixture"))
        self.assertEqual(self.server.launches.snapshot()["failures"], 0)
        self.identity = str(uuid.uuid4())
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.launches, 3)

    def test_a_probe_that_is_not_confirmed_doubles_the_pause(self):
        self.unconfirmed = True
        self.request()
        self.clock.now += 30
        self.assertEqual(self.code(self.request()), (503, LAUNCH_REFUSED))
        self.assertEqual(self.launches, 2)
        self.assertEqual(self.server.launches.snapshot(), {"failures": 2, "retry_in_seconds": 60, "probing": False})
        self.clock.now += 59
        self.assertEqual(self.code(self.request()), (503, LAUNCH_REFUSED))
        self.assertEqual(self.launches, 2)

    def test_a_probe_rejected_for_another_reason_leaves_the_next_request_to_probe(self):
        self.unconfirmed = True
        self.request()
        self.clock.now += 30
        self.unconfirmed = False
        invalid = self.body(metadata={"user_id": "not-a-session"})
        self.assertEqual(self.request(invalid)[0], 400)
        self.assertEqual(self.server.launches.snapshot(), {"failures": 1, "retry_in_seconds": 0, "probing": False})
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.server.launches.snapshot()["failures"], 0)

    def test_a_finished_answer_is_still_repeated_during_the_pause(self):
        status, first = self.request()
        self.assertEqual(status, 200)
        finished = self.identity
        self.unconfirmed = True
        self.identity = str(uuid.uuid4())
        self.assertEqual(self.code(self.request()), (503, LAUNCH_REFUSED))
        self.identity = finished
        launches = self.launches
        status, again = self.request()
        self.assertEqual((status, again["id"], again["usage"]), (200, first["id"], ZERO_USAGE))
        self.assertEqual(self.launches, launches)
        row = self.audit(3)[2]
        self.assertTrue(row["replayed"])
        self.assertEqual(row["launch_backoff_seconds"], 30)

    def test_prepare_requests_follow_the_same_pause(self):
        self.unconfirmed = True
        self.assertEqual(self.code(self.request(path="/v1/messages/prepare")), (503, LAUNCH_REFUSED))
        self.assertEqual(self.code(self.request(path="/v1/messages/prepare")), (503, LAUNCH_REFUSED))
        self.assertEqual(self.launches, 1)
        self.clock.now += 30
        self.unconfirmed = False
        self.assertEqual(self.request(path="/v1/messages/prepare")[0], 200)
        self.assertEqual(self.server.launches.snapshot()["failures"], 0)

    def test_health_reports_the_pause_without_changing_readiness(self):
        self.assertEqual(self.health()[1]["launch_backoff"], {"failures": 0, "retry_in_seconds": 0, "probing": False})
        self.unconfirmed = True
        self.request()
        status, health = self.health()
        self.assertEqual((status, health["ok"], health["failed"]), (200, True, []))
        self.assertEqual(health["launch_backoff"], {"failures": 1, "retry_in_seconds": 30, "probing": False})


if __name__ == "__main__":
    unittest.main()
