import json
from pathlib import Path
import tempfile
import threading
import unittest

from native_bridge_session import ContractError
from native_session_pool import SessionPool, session_identity


class FixtureSession:
    def __init__(self, path, body):
        self.directory = path
        path.mkdir(mode=0o700)
        self.closed = False
        self.failed = False

    def close(self, **kwargs):
        self.closed = True


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.time = 0
        self.pool = SessionPool(
            self.temp.name,
            FixtureSession,
            capacity=2,
            idle_seconds=10,
            clock=lambda: self.time,
        )
        self.body = {
            "model": "fixture",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "fresh"}],
            "metadata": {"user_id": "11111111-2222-3333-4444-555555555555"},
        }

    def tearDown(self):
        self.pool.close()
        self.temp.cleanup()

    def test_tenant_namespace_and_same_session_busy(self):
        with self.pool.lease("first", self.body) as a, self.pool.lease(
            "second", self.body
        ) as b:
            self.assertIsNot(a, b)
            with self.assertRaisesRegex(ContractError, "session_busy"):
                with self.pool.lease("first", self.body):
                    pass
            with self.assertRaisesRegex(ContractError, "native_session_capacity"):
                with self.pool.lease("third", self.body):
                    pass
        with self.pool.lease("first", self.body) as next_a:
            self.assertIs(a, next_a)

    def test_expiration_never_kills_busy_or_replays_history(self):
        with self.pool.lease("first", self.body) as a:
            self.time = 20
            self.assertEqual(self.pool.expire(), 0)
            self.assertFalse(a.closed)
        self.time = 31
        self.assertEqual(self.pool.expire(), 1)
        self.assertTrue(a.closed)
        with self.assertRaisesRegex(ContractError, "native_session_expired_no_replay"):
            with self.pool.lease("first", self.body):
                pass

    def test_unknown_history_and_missing_identity_do_not_spawn(self):
        body = {
            **self.body,
            "messages": [{"role": "assistant", "content": "not imported"}],
        }
        with self.assertRaisesRegex(ContractError, "history_not_imported"):
            with self.pool.lease("first", body):
                pass
        self.assertFalse(self.pool.entries)
        for value in ["../unsafe", "prefix" + self.body["metadata"]["user_id"], None]:
            with self.assertRaises(ContractError):
                session_identity({**self.body, "metadata": {"user_id": value}})

    def test_actual_cli_json_and_legacy_metadata(self):
        identity = self.body["metadata"]["user_id"]
        for value in [
            identity,
            json.dumps({"device_id": "fixture", "session_id": identity}),
            "user_aabb_account_1234_session_" + identity,
        ]:
            self.assertEqual(
                session_identity({**self.body, "metadata": {"user_id": value}}),
                identity,
            )

    def test_failure_and_shutdown_never_create_replacement(self):
        with self.pool.lease("first", self.body) as a:
            a.failed = True
        with self.assertRaisesRegex(ContractError, "failed_no_replay"):
            with self.pool.lease("first", self.body):
                pass
        self.pool.close()
        self.assertTrue(a.closed)
        with self.assertRaisesRegex(ContractError, "native_pool_stopped"):
            with self.pool.lease("other", self.body):
                pass

    def test_expiring_cli_does_not_block_another_live_session(self):
        with self.pool.lease("first", self.body) as first:
            pass
        self.time = 5
        with self.pool.lease("second", self.body):
            pass
        close_started, finish_close, acquired = (threading.Event() for _ in range(3))
        def slow_close(**kwargs):
            close_started.set()
            finish_close.wait(2)
            first.closed = True
        first.close = slow_close
        self.time = 11
        reaper = threading.Thread(target=self.pool.expire)
        reaper.start()
        self.assertTrue(close_started.wait(1))
        def lease_other():
            with self.pool.lease("second", self.body):
                acquired.set()
        other = threading.Thread(target=lease_other)
        other.start()
        try:
            self.assertTrue(acquired.wait(0.2), "slow CLI exit blocked unrelated session")
        finally:
            finish_close.set()
            reaper.join(3)
            other.join(3)

    def test_prepared_sessions_have_short_expiry_and_still_use_pool_capacity(self):
        self.pool.idle_seconds = 1800
        self.pool.prepared_idle_seconds = 120
        with self.pool.lease("first", self.body) as first:
            first.prepared = True
        with self.pool.lease("second", self.body):
            pass
        with self.assertRaisesRegex(ContractError, "native_session_capacity"):
            with self.pool.lease("third", self.body):
                pass
        self.time = 121
        self.assertEqual(self.pool.expire(), 1)
        self.assertTrue(first.closed)
        self.assertEqual(len(self.pool.entries), 1)

    def test_eviction_reserves_capacity_until_the_old_process_exits(self):
        self.pool.recover = FixtureSession
        with self.pool.lease("first", self.body) as first:
            pass
        entered, finish, acquired = (threading.Event() for _ in range(3))
        def slow_close(**kwargs):
            entered.set()
            finish.wait(2)
            first.closed = True
        first.close = slow_close
        def replace():
            with self.pool.lease("third", self.body):
                acquired.set()
        with self.pool.lease("second", self.body):
            worker = threading.Thread(target=replace)
            worker.start()
            self.assertTrue(entered.wait(1))
            try:
                self.assertFalse(acquired.is_set())
                with self.assertRaisesRegex(ContractError, "native_session_capacity"):
                    with self.pool.lease("fourth", self.body):
                        pass
            finally:
                finish.set()
                worker.join(3)
        self.assertTrue(acquired.is_set())

    def test_waiting_for_real_caller_tool_result_is_not_idle_expired(self):
        with self.pool.lease("first", self.body) as a:
            a.pending_ids = {"tool_caller"}
        self.time = 30
        self.assertEqual(self.pool.expire(), 0)
        self.assertFalse(a.closed)
        a.failed = True
        self.assertEqual(self.pool.expire(), 1)
        self.assertTrue(a.closed)


if __name__ == "__main__":
    unittest.main()
