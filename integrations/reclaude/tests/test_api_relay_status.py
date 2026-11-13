import threading
import unittest
import urllib.error
import urllib.request

from api_relay_status import PATH, Server, relay_status
from management import ManagementError
from unittest.mock import patch
from io import BytesIO


class APIStatusTests(unittest.TestCase):
    def test_execution_and_resident_capacity_are_independent(self):
        health = b'{"ok":true,"management_paused":false,"active_requests":2,"execution_slots":4,"pool":{"resident":7,"capacity":8},"models":["actual"]}'
        with patch("urllib.request.OpenerDirector.open", return_value=BytesIO(health)):
            result = relay_status("http://127.0.0.1:1/healthz", ["fallback"])
        self.assertEqual((result["execution_slots"], result["resident_capacity"]), (4, 8))
        self.assertEqual(result["models"], ["actual"])
        self.assertEqual(result["state"], "ready")

    def test_route_authorizes_before_reading_and_has_no_mutation(self):
        reads = []

        def authorize(token):
            if token != "Bearer admin":
                raise ManagementError("admin_required", 403)

        with Server(0, authorize, lambda: reads.append(1) or {"state": "ready"}) as server:
            worker = threading.Thread(target=server.serve_forever)
            worker.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}{PATH}"
                with self.assertRaises(urllib.error.HTTPError) as rejection:
                    urllib.request.urlopen(url, timeout=2)
                self.assertEqual(rejection.exception.code, 403)
                headers = {"Authorization": "Bearer admin"}
                with self.assertRaises(urllib.error.HTTPError) as rejection:
                    urllib.request.urlopen(urllib.request.Request(url, b"{}", headers=headers), timeout=2)
                self.assertEqual(rejection.exception.code, 501)
                self.assertEqual(reads, [])
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=2) as res:
                    self.assertEqual(res.status, 200)
                    self.assertEqual(res.headers["Cache-Control"], "no-store")
                self.assertEqual(reads, [1])
            finally:
                server.shutdown()
                worker.join(2)
