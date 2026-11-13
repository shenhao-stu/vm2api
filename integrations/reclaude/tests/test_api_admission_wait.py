"""Bounded pre-admission waiting must never retry an inference invocation."""

import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from native_api_http import APIHandler
from native_bridge_session import ContractError
from native_session_pool import SessionPool


class AdmissionWaitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.created = []

        def factory(path, body):
            path.mkdir(mode=0o700)
            session = SimpleNamespace(
                directory=path, failed=False, close=lambda **kwargs: None
            )
            self.created.append(session)
            return session

        self.pool = SessionPool(Path(self.temp.name), factory, capacity=1)
        self.addCleanup(self.pool.close)
        self.handler = object.__new__(APIHandler)
        self.handler.server = SimpleNamespace(pool=self.pool)
        self.handler.lease_wait_seconds = 0.3
        self.body = {
            "model": "fixture",
            "max_tokens": 128,
            "messages": [{"role": "user", "content": "synthetic"}],
            "metadata": {"user_id": "11111111-2222-4333-8444-555555555555"},
        }

    def test_wait_rechecks_original_pool_after_lease_release(self):
        waiting = threading.Event()

        def acquire():
            waiting.set()
            with self.handler.lease_session("tenant", self.body) as session:
                return session

        with ThreadPoolExecutor(1) as workers:
            with self.pool.lease("tenant", self.body) as original:
                future = workers.submit(acquire)
                self.assertTrue(waiting.wait(1))
                time.sleep(0.05)
                self.assertFalse(future.done())
            self.assertIs(future.result(1), original)
        self.assertEqual(len(self.created), 1)

    def test_exhausted_wait_leaves_busy_session_and_capacity_unchanged(self):
        self.handler.lease_wait_seconds = 0.03
        with self.pool.lease("tenant", self.body):
            with self.assertRaisesRegex(ContractError, "session_busy"):
                with self.handler.lease_session("tenant", self.body):
                    self.fail("admitted")
            self.assertEqual(self.pool.snapshot()["busy"], 1)
        self.assertEqual(len(self.created), 1)

    def test_nonbusy_rejections_are_never_retried(self):
        for code in (
            "request_already_consumed",
            "native_request_in_flight_no_replay",
            "native_session_evidence_unknown",
            "native_memory_pressure",
        ):
            calls = []

            @contextmanager
            def reject(*args):
                calls.append(1)
                raise ContractError(code)
                yield

            self.handler.server.pool = SimpleNamespace(lease=reject)
            with self.assertRaisesRegex(ContractError, code):
                with self.handler.lease_session("tenant", self.body):
                    self.fail("admitted")
            self.assertEqual(len(calls), 1)

    def test_error_after_admission_is_not_reinvoked(self):
        with self.assertRaisesRegex(ContractError, "session_busy"):
            with self.handler.lease_session("tenant", self.body):
                raise ContractError("session_busy")
        self.assertEqual(len(self.created), 1)
        self.assertEqual(self.pool.snapshot()["busy"], 0)
