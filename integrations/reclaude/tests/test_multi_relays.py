import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from management_agent import account_windows
from management_server import Server


class RelayRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.managers = []
        for i in (1, 2):
            cfg = dict(
                id=f"relay-{i}",
                name=f"Relay {i}",
                binding=i,
                sub_account=100 + i,
                node="test",
                concurrency=10,
                models=["m"],
                expected_ip="192.0.2.1",
                state_dir=f"{self.temp.name}/{i}",
                origin="https://example.test",
                runtime_command=["remote", str(i)],
                sub_command=["broker", str(i)],
            )
            self.managers.append(
                SimpleNamespace(
                    config=cfg,
                    root=Path(cfg["state_dir"]),
                    cached=None,
                    logs=Mock(return_value={"items": [i]}),
                    action=Mock(return_value={"binding": i}),
                )
            )

    def test_conflicting_accounts_rejected(self):
        for field in (
            "id",
            "binding",
            "sub_account",
            "state_dir",
            "runtime_command",
            "sub_command",
        ):
            with self.subTest(field=field):
                b = copy.deepcopy(self.managers[1])
                b.config[field] = self.managers[0].config[field]
                with self.assertRaises(ValueError):
                    Server(("127.0.0.1", 0), [self.managers[0], b], lambda _: True)

    def test_independent_status_and_actions(self):
        a, b = self.managers
        a.cached = {"id": "relay-1", "observed_at": time.time()}
        srv = Server(("127.0.0.1", 0), [a, b], lambda _: True)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)

        def fetch(path, verb="GET", body=None):
            c = http.client.HTTPConnection(*srv.server_address, timeout=2)
            try:
                c.request(
                    verb,
                    "/api/panel/native-relays" + path,
                    body,
                    headers={
                        "Origin": "https://example.test",
                        "Content-Type": "application/json",
                    },
                )
                result = c.getresponse()
                return result.status, json.load(result)
            finally:
                c.close()

        status, val = fetch("")
        self.assertEqual(status, 200)
        self.assertEqual(val["items"][0], a.cached)
        self.assertTrue(val["items"][1]["management_unavailable"])
        self.assertEqual(fetch("/relay-2/logs")[1]["data"], {"items": [2]})
        self.assertEqual(
            fetch("/relay-2/stop", "POST", '{"operation_id":"op"}')[0], 200
        )
        self.assertEqual(
            fetch("/missing/stop", "POST", '{"operation_id":"op"}')[0], 404
        )
        b.action.assert_called_once_with("stop", "op")
        a.action.assert_not_called()
        a.logs.assert_not_called()

    def test_window_owner_and_unit(self):
        path = Path(self.temp.name) / "quota.json"
        stamp = int(time.time() * 1000) - 100
        row = {"resets_at": "2026-11-04T03:00:00+00:00", "used_percent": 98}
        q = {
            "org": 2,
            "account_id": 10,
            "binding": 22,
            "observed_at_ms": stamp,
            "source_updated": stamp,
            "windows": {"five_hour": row, "seven_day": row},
        }
        path.write_text(json.dumps(q))
        cfg = {
            "binding": 22,
            "account_windows": {"org": 2, "account_id": 10, "path": str(path)},
        }
        self.assertEqual(account_windows(cfg)["seven_day"]["used_percent"], 98)
        cfg["binding"] = 23
        self.assertIsNone(account_windows(cfg))
