"""Offline: an identical caller request is answered again without a second dispatch.

Production 2026-11-20 (Ciry/HAO relays): one automated caller repeated byte-identical
streaming requests while the original was still running or had just completed, and
also sent non-streaming twins. Each repeat got 400 request_already_consumed or
native_request_in_flight_no_replay although the answer already existed.
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
from native_bridge_session import ContractError, RequestRejected, history_shape, signature
from native_http import NativeServer
from native_reply_cache import ReplyCache, ZERO_USAGE

try:
    from test_native_http import FixtureSession, Health
except ImportError:  # run as tests.test_native_reply_cache
    from tests.test_native_http import FixtureSession, Health


class ConsumingSession(FixtureSession):
    """Like the genuine session: a history it already ran is never run again."""

    def __init__(self, path, body):
        super().__init__(path, body)
        self.seen = set()
        self.started = threading.Event()

    def request(self, body):
        request = signature(history_shape(body["messages"]))
        if request in self.seen:
            raise RequestRejected("request_already_consumed")
        self.seen.add(request)
        self.started.set()
        yield from super().request(body)


class ReplyCacheHTTP(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.created = []
        self.release = None
        self.refusal = False
        self.incomplete = False

        def factory(path, body):
            session = ConsumingSession(path, body)
            session.wait, session.refusal, session.incomplete = self.release, self.refusal, self.incomplete
            self.created.append(session)
            return session

        self.server = NativeServer(
            ("127.0.0.1", 0), Health(), "k" * 40, self.root, factory,
            limits=Limits(models=("claude-sonnet-5-5", "claude-fable-5-1"), concurrency=2))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.identity = str(uuid.uuid4())

    def tearDown(self):
        if self.release:
            self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def body(self, **changes):
        return {"model": "claude-sonnet-5-5", "max_tokens": 1024, "stream": False,
                "metadata": {"user_id": self.identity},
                "messages": [{"role": "user", "content": "fixture"}], **changes}

    def request(self, body):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=8)
        connection.request("POST", "/v1/messages", json.dumps(body),
                           {"Content-Type": "application/json", "Authorization": "Bearer " + "k" * 40})
        response = connection.getresponse()
        result = response.status, response.read()
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

    def dispatches(self):
        return len(list(self.root.rglob("*.consumed.json")))

    def events(self, raw):
        return [json.loads(line[6:]) for line in raw.decode().splitlines() if line.startswith("data: ")]

    def test_identical_repeat_gets_the_same_answer_with_no_second_dispatch(self):
        status, first = self.request(self.body())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(first)["usage"]["output_tokens"], 5)
        status, again = self.request(self.body())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(again)["content"], json.loads(first)["content"])
        self.assertEqual(json.loads(again)["id"], json.loads(first)["id"])
        self.assertEqual(json.loads(again)["stop_reason"], "end_turn")
        self.assertEqual(json.loads(again)["usage"], ZERO_USAGE)
        self.assertEqual(self.dispatches(), 1)
        row = self.audit(2)[1]
        self.assertEqual((row["status"], row["attempts"], row["complete"]), (200, 0, True))
        self.assertTrue(row["replayed"])
        self.assertEqual(row["replay_of"], "request_already_consumed")
        self.assertNotIn("error", row)

    def test_streaming_and_non_streaming_twins_share_one_dispatch(self):
        for first, second in ((False, True), (True, False)):
            self.identity = str(uuid.uuid4())
            before = self.dispatches()
            self.assertEqual(self.request(self.body(stream=first))[0], 200)
            status, raw = self.request(self.body(stream=second))
            self.assertEqual(status, 200)
            if second:
                events = self.events(raw)
                self.assertEqual([e["type"] for e in events][0], "message_start")
                self.assertEqual([e["type"] for e in events][-1], "message_stop")
                self.assertEqual(events[0]["message"]["usage"], ZERO_USAGE)
                delta = next(e for e in events if e["type"] == "message_delta")
                self.assertEqual((delta["delta"]["stop_reason"], delta["usage"]), ("end_turn", ZERO_USAGE))
                text = "".join(e["delta"]["text"] for e in events if e["type"] == "content_block_delta")
                self.assertEqual(text, "fixture")
            else:
                self.assertEqual(json.loads(raw)["content"][0]["text"], "fixture")
            self.assertEqual(self.dispatches(), before + 1)

    def test_another_session_model_or_history_is_never_served_this_answer(self):
        self.assertEqual(self.request(self.body())[0], 200)
        original = self.identity
        self.identity = str(uuid.uuid4())
        self.assertEqual(self.request(self.body())[0], 200)  # a different caller session runs its own turn
        self.assertEqual(self.dispatches(), 2)
        self.identity = original
        changed = self.body(messages=[{"role": "user", "content": "other"}])
        self.assertEqual(self.request(changed)[0], 200)  # a different history is a new turn
        self.assertEqual(self.dispatches(), 3)
        # Same history recorded under another model: the session refuses it and nothing is replayed.
        scope = self.audit(1)[0]["session_pool_key"]
        request = signature(history_shape(self.body()["messages"]))
        self.assertIsNone(self.server.replies.load(scope, request, "claude-fable-5-1"))
        self.assertIsNotNone(self.server.replies.load(scope, request, "claude-sonnet-5-5"))

    def test_refused_or_incomplete_turn_is_not_replayed(self):
        self.refusal = True
        self.assertEqual(self.request(self.body())[0], 200)
        status, raw = self.request(self.body())
        self.assertEqual(status, 400)
        self.assertIn(b"request_already_consumed", raw)
        self.identity, self.refusal, self.incomplete = str(uuid.uuid4()), False, True
        self.request(self.body())
        scope = self.audit(3)[2]["session_pool_key"]
        self.assertIsNone(self.server.replies.load(
            scope, signature(history_shape(self.body()["messages"])), "claude-sonnet-5-5"))

    def test_expired_answer_keeps_the_original_rejection(self):
        self.assertEqual(self.request(self.body())[0], 200)
        self.server.replies.clock = lambda: time.time() + self.server.replies.ttl_seconds + 1
        status, raw = self.request(self.body())
        self.assertEqual(status, 400)
        self.assertIn(b"request_already_consumed", raw)
        self.assertEqual(self.dispatches(), 1)

    def in_flight(self, fail=False):
        """Start one blocked original; identical repeats are refused as in flight by the channel."""
        self.release = threading.Event()
        self.incomplete = fail
        original = {}
        worker = threading.Thread(target=lambda: original.update(result=self.request(self.body())))
        worker.start()
        for _ in range(200):
            if self.created and self.created[0].started.is_set():
                break
            time.sleep(.01)
        genuine = self.server.pool.lease

        def lease(tenant, body):
            if self.created[0].started.is_set() and not self.release.is_set():
                raise ContractError("native_request_in_flight_no_replay")
            return genuine(tenant, body)

        self.server.pool.lease = lease
        return worker, original

    def test_repeat_of_a_running_request_waits_and_gets_its_answer(self):
        worker, original = self.in_flight()
        joined = {}
        waiter = threading.Thread(target=lambda: joined.update(result=self.request(self.body(stream=True))))
        waiter.start()
        for _ in range(200):
            if self.server.replies.waiting:
                break
            time.sleep(.01)
        self.assertEqual(len(self.server.replies.waiting), 1)
        # A second identical repeat does not pile up behind the first.
        status, raw = self.request(self.body())
        self.assertEqual(status, 400)
        self.assertIn(b"native_request_in_flight_no_replay", raw)
        self.release.set()
        worker.join(8)
        waiter.join(8)
        self.assertEqual(original["result"][0], 200)
        status, raw = joined["result"]
        self.assertEqual(status, 200)
        events = self.events(raw)
        self.assertEqual(events[-1]["type"], "message_stop")
        self.assertEqual(events[0]["message"]["usage"], ZERO_USAGE)
        self.assertEqual(self.dispatches(), 1)
        self.assertEqual(self.server.replies.waiting, set())
        self.assertEqual(self.server.replies.running, {})
        # Every execution slot was returned exactly once.
        permits = [self.server.inference.acquire(False) for _ in range(3)]
        self.assertEqual(permits, [True, True, False])
        for _ in range(2):
            self.server.inference.release()

    def test_repeat_of_a_running_request_that_fails_keeps_its_rejection(self):
        worker, original = self.in_flight(fail=True)
        joined = {}
        waiter = threading.Thread(target=lambda: joined.update(result=self.request(self.body())))
        waiter.start()
        for _ in range(200):
            if self.server.replies.waiting:
                break
            time.sleep(.01)
        self.release.set()
        worker.join(8)
        waiter.join(8)
        status, raw = joined["result"]
        self.assertEqual(status, 400)
        self.assertIn(b"native_request_in_flight_no_replay", raw)
        self.assertEqual(self.dispatches(), 1)
        permits = [self.server.inference.acquire(False) for _ in range(3)]
        self.assertEqual(permits, [True, True, False])
        for _ in range(2):
            self.server.inference.release()


class ReplyCacheStore(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = [1000.0]
        self.cache = ReplyCache(Path(self.temp.name), ttl_seconds=60, per_scope=2, max_bytes=2000,
                                clock=lambda: self.now[0])
        self.scope = "a" * 64
        self.message = {"id": "msg_1", "content": [], "stop_reason": "end_turn"}

    def tearDown(self):
        self.temp.cleanup()

    def test_rejects_unsafe_keys_and_oversized_or_unfinished_answers(self):
        for scope, request in (("../x", "b" * 64), (self.scope, "B" * 64), (self.scope, "b" * 63), (None, "b" * 64)):
            self.assertFalse(self.cache.store(scope, request, "m", self.message, []))
            self.assertIsNone(self.cache.load(scope, request, "m"))
        self.assertFalse(self.cache.store(self.scope, "b" * 64, "m", {**self.message, "stop_reason": None}, []))
        self.assertFalse(self.cache.store(self.scope, "b" * 64, "m", {**self.message, "stop_reason": "refusal"}, []))
        self.assertFalse(self.cache.store(self.scope, "b" * 64, "m", self.message, ["x" * 3000]))
        self.assertEqual(list(Path(self.temp.name).rglob("*.json")), [])

    def test_keeps_only_recent_answers_and_sweeps_expired_sessions(self):
        for index, request in enumerate(("1" * 64, "2" * 64, "3" * 64)):
            self.assertTrue(self.cache.store(self.scope, request, "m", self.message, []))
            path = self.cache.path(self.scope, request)
            # Distinct modification times make the retention order deterministic.
            import os
            os.utime(path, (time.time() + index, time.time() + index))
            self.cache.prune(path.parent)
        self.assertIsNone(self.cache.load(self.scope, "1" * 64, "m"))
        self.assertIsNotNone(self.cache.load(self.scope, "3" * 64, "m"))
        self.assertEqual(oct(self.cache.path(self.scope, "3" * 64).stat().st_mode & 0o777), "0o600")
        self.now[0] += 61
        self.assertIsNone(self.cache.load(self.scope, "3" * 64, "m"))
        self.cache.clock = lambda: time.time() + 3600
        self.assertEqual(self.cache.sweep(), 1)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
