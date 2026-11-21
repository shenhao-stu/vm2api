"""A conversation that is mid-turn, or a relay with no free CLI, holds the caller
back for a bounded time instead of refusing it. Waiting starts nothing."""

import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from adapter import Limits
from native_http import NativeServer
from native_launch_backoff import LAUNCH_REFUSED
from test_native_http import FixtureSession, Health


class AdmissionQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.created = []
        self.hold = threading.Event()

        def factory(path, body):
            session = FixtureSession(path, body)
            session.wait = self.hold
            self.created.append(session)
            return session

        self.server = NativeServer(
            ("127.0.0.1", 0), Health(), "k" * 40, self.root, factory,
            limits=Limits(models=("claude-sonnet-5-5",), concurrency=4),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.identity = str(uuid.uuid4())

    def tearDown(self):
        self.hold.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def body(self, text, identity=None):
        return {"model": "claude-sonnet-5-5", "max_tokens": 64, "stream": False,
                "metadata": {"user_id": identity or self.identity},
                "messages": [{"role": "user", "content": text}]}

    def request(self, body):
        c = http.client.HTTPConnection(*self.server.server_address, timeout=10)
        c.request("POST", "/v1/messages", json.dumps(body),
                  {"Content-Type": "application/json", "Authorization": "Bearer " + "k" * 40})
        r = c.getresponse()
        result = (r.status, r.read())
        c.close()
        return result

    def background(self, body):
        result = []
        worker = threading.Thread(target=lambda: result.append(self.request(body)))
        worker.start()
        return worker, result

    def until(self, condition, seconds=3):
        deadline = time.monotonic() + seconds
        while not condition():
            if time.monotonic() > deadline:
                self.fail("condition not reached")
            time.sleep(0.01)

    def rows(self):
        path = self.root / "audit.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def row(self, error=None, status=None):
        self.until(lambda: any(r.get("error") == error and (status is None or r["status"] == status)
                               for r in self.rows()))
        return next(r for r in self.rows() if r.get("error") == error
                    and (status is None or r["status"] == status))

    def consumed(self):
        return len(list(self.root.rglob("*.consumed.json")))

    def start_running_turn(self):
        worker, result = self.background(self.body("first"))
        self.until(lambda: self.server.pool.snapshot()["busy"] == 1)
        return worker, result

    def waiting(self):
        with self.server.admission_lock:
            return sum(self.server.admission_waiting.values())

    def fill_relay(self):
        self.hold.set()
        for _ in range(self.server.pool.capacity):
            self.assertEqual(self.request(self.body("fill", str(uuid.uuid4())))[0], 200)
        self.hold.clear()

    def free_one_cli(self):
        with self.server.pool.lock:
            self.server.pool.entries.pop(next(iter(self.server.pool.entries)))

    def test_turn_of_a_busy_conversation_is_served_once_the_running_turn_ends(self):
        first, first_result = self.start_running_turn()
        second, second_result = self.background(self.body("second"))
        self.until(lambda: self.waiting() == 1)
        time.sleep(0.2)
        self.assertEqual(second_result, [])
        self.hold.set()
        first.join(5)
        second.join(5)
        self.assertEqual(first_result[0][0], 200)
        self.assertEqual(second_result[0][0], 200)
        self.assertEqual(json.loads(second_result[0][1])["content"][0]["text"], "second")
        served = next(r for r in self.rows() if "admission_wait_ms" in r)
        self.assertEqual((served["status"], served["attempts"]), (200, 1))
        self.assertEqual(served["admission_wait_code"], "session_busy")
        self.assertGreaterEqual(served["admission_wait_ms"], 150)
        self.assertEqual(len(self.created), 1)
        self.assertEqual(self.consumed(), 2)
        self.assertEqual(self.server.admission_waiting, {})

    def test_wait_is_bounded_and_ends_in_the_same_refusal_without_dispatch(self):
        self.server.admission_wait_seconds = 0.3
        first, first_result = self.start_running_turn()
        started = time.monotonic()
        status, raw = self.request(self.body("second"))
        elapsed = time.monotonic() - started
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(raw)["error"]["code"], "session_busy")
        self.assertGreaterEqual(elapsed, 0.25)
        self.assertLess(elapsed, 2)
        refused = self.row("session_busy")
        self.assertEqual(refused["attempts"], 0)
        self.assertGreaterEqual(refused["admission_wait_ms"], 250)
        self.assertEqual(self.consumed(), 1)
        self.hold.set()
        first.join(5)
        self.assertEqual(first_result[0][0], 200)
        self.assertEqual(self.server.admission_waiting, {})

    def test_every_waiting_turn_of_a_conversation_is_served_without_a_cap(self):
        first, first_result = self.start_running_turn()
        waiting = [self.background(self.body("turn %d" % n)) for n in range(3)]
        self.until(lambda: self.waiting() == 3)
        self.assertFalse(any(r.get("admission_queue_full") for r in self.rows()))
        self.hold.set()
        first.join(5)
        for worker, _ in waiting:
            worker.join(10)
        self.assertEqual([first_result[0][0]] + [r[0][0] for _, r in waiting], [200] * 4)
        self.assertEqual(self.consumed(), 4)
        self.assertEqual(self.server.admission_waiting, {})

    def test_turn_refused_for_memory_pressure_starts_once_memory_is_free(self):
        relieved = threading.Event()
        self.server.pool.under_pressure = lambda: not relieved.is_set()
        self.hold.set()
        worker, result = self.background(self.body("under pressure"))
        self.until(lambda: self.waiting() == 1)
        relieved.set()
        worker.join(5)
        self.assertEqual(result[0][0], 200)
        served = next(r for r in self.rows() if "admission_wait_ms" in r)
        self.assertEqual(served["admission_wait_code"], "native_memory_pressure")

    def test_caller_that_left_while_waiting_is_never_dispatched(self):
        first, first_result = self.start_running_turn()
        c = http.client.HTTPConnection(*self.server.server_address, timeout=10)
        c.request("POST", "/v1/messages", json.dumps(self.body("second")),
                  {"Content-Type": "application/json", "Authorization": "Bearer " + "k" * 40})
        self.until(lambda: self.waiting() == 1)
        c.close()
        left = self.row("caller_disconnected_while_waiting")
        self.assertEqual((left["status"], left["attempts"]), (499, 0))
        self.assertEqual(self.waiting(), 0)
        self.hold.set()
        first.join(5)
        self.assertEqual(first_result[0][0], 200)
        self.assertEqual(self.consumed(), 1)

    def test_launch_probe_is_not_held_back(self):
        first, first_result = self.start_running_turn()
        with patch.object(self.server.launches, "admit", return_value=(1, 0)):
            started = time.monotonic()
            self.assertEqual(self.request(self.body("second"))[0], 429)
            self.assertLess(time.monotonic() - started, 1)
        self.assertNotIn("admission_wait_ms", self.row("session_busy"))
        self.hold.set()
        first.join(5)
        self.assertEqual(first_result[0][0], 200)

    def test_new_conversation_on_a_full_relay_starts_when_a_cli_is_freed(self):
        self.fill_relay()
        self.hold.set()
        worker, result = self.background(self.body("late", str(uuid.uuid4())))
        self.until(lambda: self.waiting() == 1)
        self.free_one_cli()
        worker.join(5)
        self.assertEqual(result[0][0], 200)
        served = [r for r in self.rows() if "admission_wait_ms" in r]
        self.assertEqual(len(served), 1)
        self.assertEqual(served[0]["admission_wait_code"], "native_session_capacity")
        self.assertEqual(served[0]["status"], 200)

    def test_launch_failure_during_the_wait_keeps_the_new_cli_from_starting(self):
        self.fill_relay()
        worker, result = self.background(self.body("late", str(uuid.uuid4())))
        self.until(lambda: self.waiting() == 1)
        self.server.launches.failed(0)
        self.free_one_cli()
        worker.join(5)
        self.assertEqual(result[0][0], 503)
        refused = self.row(LAUNCH_REFUSED)
        self.assertEqual(refused["attempts"], 0)
        self.assertEqual(refused["admission_wait_code"], "native_session_capacity")
        self.assertEqual(self.consumed(), self.server.pool.capacity)


if __name__ == "__main__":
    unittest.main()
