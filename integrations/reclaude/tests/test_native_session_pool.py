import json
from pathlib import Path
import tempfile
import threading
import unittest
import native_session_pool as pool_module

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
        self.assertEqual(self.pool.snapshot()["busy"], 0)
        self.assertEqual(self.pool.snapshot()["pending_tools_sessions"], 1)
        self.time = 30
        self.assertEqual(self.pool.expire(), 0)
        self.assertFalse(a.closed)
        a.failed = True
        self.assertEqual(self.pool.expire(), 1)
        self.assertTrue(a.closed)

    def test_long_residency_extends_both_idle_windows_with_bounds(self):
        self.pool.close()
        self.pool = SessionPool(self.temp.name, FixtureSession, capacity=10,
                                idle_seconds=7200, prepared_idle_seconds=1800,
                                clock=lambda: self.time)
        with self.pool.lease("warm", self.body) as warm:
            warm.prepared = True
        with self.pool.lease("used", self.body) as used:
            pass
        self.time = 150
        self.assertEqual(self.pool.expire(), 0)
        self.time = 1801
        self.assertEqual(self.pool.expire(), 1)
        self.assertTrue(warm.closed)
        self.assertFalse(used.closed)
        self.time = 7201
        self.assertEqual(self.pool.expire(), 1)
        for value in [float('nan'), float('inf'), -1, 86401]:
            with self.assertRaises(ValueError):
                SessionPool(self.temp.name, FixtureSession, idle_seconds=value)

    def test_memory_pressure_reclaims_oldest_idle_and_protects_live_work(self):
        self.pool.capacity = 10
        self.pool.recover = FixtureSession
        created = []
        self.pool.under_pressure = lambda: sum(not x.closed for x in created) >= 2
        with self.pool.lease("old", self.body) as old:
            pass
        self.time = 1
        with self.pool.lease("busy", self.body) as busy:
            with self.pool.lease("tool", self.body) as tool:
                tool.pending_ids = {"real_caller_tool"}
            created.extend([old, busy, tool])
            self.assertEqual(self.pool.expire(), 1)
            self.assertTrue(old.closed)
            self.assertFalse(busy.closed)
            self.assertFalse(tool.closed)
            with self.assertRaisesRegex(ContractError, "native_memory_pressure"):
                with self.pool.lease("new", self.body):
                    pass
        tool.pending_ids.clear()
        self.assertEqual(self.pool.expire(), 1)
        self.assertEqual(sum(not x.closed for x in created), 1)

    def test_memory_pressure_is_checked_even_below_session_capacity(self):
        self.pool.capacity = 10
        self.pool.recover = FixtureSession
        with self.pool.lease("old", self.body) as old:
            pass
        self.pool.under_pressure = lambda: not old.closed
        with self.pool.lease("new", self.body) as new:
            self.assertTrue(old.closed)
            self.assertIsNot(old, new)

    def test_unreadable_memory_blocks_admission_without_destroying_sessions(self):
        with self.pool.lease("old", self.body) as old:
            pass
        def unavailable():
            raise ContractError("native_memory_not_ready")
        self.pool.under_pressure = unavailable
        with self.assertRaisesRegex(ContractError, "native_memory_not_ready"):
            with self.pool.lease("new", self.body):
                pass
        self.assertEqual(len(self.pool.entries), 1)
        self.assertFalse(old.closed)

    def test_hot_request_does_not_synchronously_expire_unrelated_cli(self):
        with self.pool.lease("expired", self.body) as expired:
            pass
        self.time = 5
        with self.pool.lease("hot", self.body) as hot:
            pass
        self.time = 11
        acquired, finish_close = threading.Event(), threading.Event()
        def slow_close(**kwargs):
            finish_close.wait(2)
            expired.closed = True
        expired.close = slow_close
        def reuse():
            with self.pool.lease("hot", self.body) as current:
                self.assertIs(current, hot)
                acquired.set()
        worker = threading.Thread(target=reuse)
        worker.start()
        try:
            self.assertTrue(acquired.wait(.2), "hot request waited for unrelated CLI expiry")
        finally:
            finish_close.set()
            worker.join(3)

    def test_cgroup_pressure_uses_real_bytes_and_fails_closed(self):
        path = Path(self.temp.name) / "memory.current"
        for text, pressure in [("99", False), ("100", True), ("101", True)]:
            path.write_text(text)
            self.assertEqual(pool_module.memory_pressure(path, 100), pressure)
        for text in ["", "max", "-1", "garbage"]:
            path.write_text(text)
            with self.assertRaisesRegex(ContractError, "native_memory_not_ready"):
                pool_module.memory_pressure(path, 100)
        path.unlink()
        with self.assertRaisesRegex(ContractError, "native_memory_not_ready"):
            pool_module.memory_pressure(path, 100)
        self.assertFalse(pool_module.memory_pressure(path, 0))

    def test_reclaimable_file_cache_matches_vm2api_working_set(self):
        root = Path(self.temp.name)
        (root / "memory.current").write_text("150")
        (root / "memory.stat").write_text("anon 50\ninactive_file 100\n")
        self.assertFalse(pool_module.memory_pressure(root / "memory.current", 100))
        for text in ["inactive_file -1", "inactive_file invalid", "inactive_file 200"]:
            (root / "memory.stat").write_text(text)
            self.assertTrue(pool_module.memory_pressure(root / "memory.current", 100))

    def test_invalid_new_history_does_not_evict_healthy_residents(self):
        self.pool.recover = FixtureSession
        with self.pool.lease("one", self.body) as one:
            pass
        with self.pool.lease("two", self.body) as two:
            pass
        wrong = {**self.body, "messages": [{"role": "assistant", "content": "unknown"}]}
        with self.assertRaisesRegex(ContractError, "history_not_imported"):
            with self.pool.lease("third", wrong):
                pass
        self.assertFalse(one.closed)
        self.assertFalse(two.closed)


if __name__ == "__main__":
    unittest.main()
