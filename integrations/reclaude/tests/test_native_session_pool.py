import json
from pathlib import Path
import tempfile
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
