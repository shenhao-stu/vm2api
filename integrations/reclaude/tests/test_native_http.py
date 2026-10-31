import http.client
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest
import uuid

from adapter import Limits
from native_bridge_session import ContractError, RequestRejected
from native_http import NativeServer


class Health:
    def __init__(self):
        self.revoked = False

    def failed_health_checks(self):
        return ["native_device_revoked"] if self.revoked else []

    def authorization_revoked(self):
        return self.revoked


class FixtureSession:
    def __init__(self, path, body):
        self.directory = path
        path.mkdir(mode=0o700)
        (path / "dispatch").mkdir()
        self.failed = False
        self.closed = False
        self.wait = None
        self.incomplete = False
        self.reject = False
        self.refusal = False
        self.fail_before_event = False

    def close(self, **kwargs):
        self.closed = True

    def request(self, body):
        if self.reject:
            raise RequestRejected("history_prefix_mismatch")
        (
            self.directory / "dispatch" / (str(uuid.uuid4()) + ".consumed.json")
        ).write_text("{}")
        if self.fail_before_event:
            raise ContractError("native_stream_incomplete")
        yield {
            "type": "message_start",
            "message": {
                "id": "msg_fixture",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": [],
                "stop_reason": None,
                "usage": {"input_tokens": 2, "output_tokens": 0},
            },
        }
        if self.wait:
            self.wait.wait(3)
        if self.refusal:
            yield {
                "type": "message_delta",
                "delta": {
                    "stop_reason": "refusal",
                    "stop_details": {"type": "refusal", "category": "cyber"},
                },
                "usage": {"input_tokens": 2, "output_tokens": 0},
            }
            yield {"type": "message_stop"}
            return
        yield {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        }
        yield {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": body["messages"][0]["content"]},
        }
        if self.incomplete:
            raise ContractError("native_stream_incomplete")
        yield {"type": "content_block_stop", "index": 0}
        yield {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 5},
        }
        yield {"type": "message_stop"}


class NativeHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.health = Health()
        self.created = []
        self.release = None
        self.incomplete = False
        self.refusal = False
        self.fail_before_event = False

        def factory(path, body):
            s = FixtureSession(path, body)
            s.wait = self.release
            s.incomplete = self.incomplete
            s.refusal = self.refusal
            s.fail_before_event = self.fail_before_event
            self.created.append(s)
            return s

        self.server = NativeServer(
            ("127.0.0.1", 0),
            self.health,
            "k" * 40,
            self.root,
            factory,
            limits=Limits(models=("claude-sonnet-5-5",), concurrency=2),
        )
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
        return {
            "model": "claude-sonnet-5-5",
            "max_tokens": 1024,
            "stream": False,
            "metadata": {"user_id": self.identity},
            "messages": [{"role": "user", "content": "fixture"}],
            **changes,
        }

    def request(self, body=None, key=None):
        c = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        c.request(
            "POST",
            "/v1/messages",
            json.dumps(body or self.body()),
            {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + (key or "k" * 40),
            },
        )
        r = c.getresponse()
        result = (r.status, r.read())
        c.close()
        return result

    def audit(self, expected=1):
        deadline = time.monotonic() + 1
        while True:
            rows = [
                json.loads(line)
                for line in (self.root / "audit.jsonl").read_text().splitlines()
            ]
            if len(rows) >= expected or time.monotonic() >= deadline:
                return rows
            time.sleep(0.01)

    def test_rejections_have_zero_dispatch(self):
        self.assertEqual(self.request(key="wrong")[0], 401)
        self.assertEqual(self.request(self.body(model="unknown"))[0], 400)
        self.assertEqual(self.request(self.body(metadata={}))[0], 400)
        self.assertEqual(self.request(self.body(temperature=0.5))[0], 400)
        self.assertFalse(self.created)
        self.assertTrue(all(row["attempts"] == 0 for row in self.audit()))

    def test_invalid_initial_shapes_do_not_poison_the_session(self):
        invalid = [
            {"metadata": []},
            {"tools": {}},
            {"tools": [None]},
            {"tools": [{"name": "Read", "input_schema": {}, "description": 1}]},
            {"system": 7},
            {"system": [{"type": "text", "text": None}]},
            {"messages": ["invalid"]},
            {"messages": [{"role": "user", "content": [{"type": "text"}]}]},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                self.assertEqual(self.request(self.body(**changes))[0], 400)
                self.assertEqual(self.created, [])
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(len(self.created), 1)

    def test_rejected_followup_preserves_healthy_session(self):
        self.assertEqual(self.request()[0], 200)
        session = self.created[0]
        session.reject = True
        self.assertEqual(self.request()[0], 400)
        self.assertFalse(session.failed)
        self.assertFalse(session.closed)
        session.reject = False
        self.assertEqual(self.request()[0], 200)
        self.assertEqual([r["attempts"] for r in self.audit(3)], [1, 0, 1])

    def test_json_terminal_usage_and_fresh_session_isolation(self):
        status, data = self.request()
        self.assertEqual(status, 200)
        reply = json.loads(data)
        self.assertEqual(reply["content"][0]["text"], "fixture")
        self.assertEqual(reply["usage"], {"input_tokens": 2, "output_tokens": 5})
        self.identity = str(uuid.uuid4())
        status, data = self.request(
            self.body(messages=[{"role": "user", "content": "other"}])
        )
        self.assertEqual(json.loads(data)["content"][0]["text"], "other")
        self.assertEqual(len(self.created), 2)
        self.assertNotEqual(self.created[0].directory, self.created[1].directory)
        self.assertEqual([r["attempts"] for r in self.audit(2)], [1, 1])

    def test_sse_has_one_terminal(self):
        status, data = self.request(self.body(stream=True))
        self.assertEqual(status, 200)
        self.assertEqual(data.count(b"event: message_stop"), 1)
        self.assertEqual(self.audit()[0]["usage"]["output_tokens"], 5)

    def test_provider_refusal_is_terminal_without_retry_or_auth_latch(self):
        self.refusal = True
        for stream in (False, True):
            with self.subTest(stream=stream):
                self.identity = str(uuid.uuid4())
                status, data = self.request(self.body(stream=stream))
                self.assertEqual(status, 200)
                if stream:
                    events = [
                        json.loads(line[5:])
                        for line in data.decode().splitlines()
                        if line.startswith("data:")
                    ]
                    self.assertEqual(events[-1], {"type": "message_stop"})
                    terminal = next(e for e in events if e["type"] == "message_delta")
                    self.assertEqual(terminal["delta"]["stop_reason"], "refusal")
                else:
                    reply = json.loads(data)
                    self.assertEqual(reply["stop_reason"], "refusal")
                    self.assertEqual(reply["content"], [])
                    self.assertEqual(reply["stop_details"]["category"], "cyber")
        rows = self.audit(2)
        self.assertTrue(all(r["complete"] and r["attempts"] == 1 for r in rows))
        self.assertTrue(all(r["usage"]["output_tokens"] == 0 for r in rows))
        self.assertFalse(self.server.latched)

    def test_incomplete_stream_is_never_success_or_retried(self):
        self.incomplete = True
        status, data = self.request(self.body(stream=True))
        self.assertEqual(status, 200)
        self.assertIn(b"event: error", data)
        self.assertNotIn(b"event: message_stop", data)
        row = self.audit()[0]
        self.assertEqual(row["attempts"], 1)
        self.assertFalse(row["complete"])
        self.assertEqual(row["status"], 502)
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(len(self.created), 1)

    def test_incomplete_json_is_a_json_error_with_non_success_status(self):
        self.incomplete = True
        status, data = self.request()
        self.assertEqual(status, 400)
        self.assertIn(b"native_request_consumed_no_replay", data)
        self.assertEqual(self.audit()[0]["attempts"], 1)

    def test_consumed_preheader_failure_cannot_trigger_5xx_failover(self):
        self.fail_before_event = True
        for stream in (False, True):
            self.identity = str(uuid.uuid4())
            status, data = self.request(self.body(stream=stream))
            self.assertEqual(status, 400)
            self.assertIn(b"native_request_consumed_no_replay", data)
            self.assertEqual(self.request(self.body(stream=stream))[0], 400)
        rows = self.audit(4)
        self.assertEqual([row["attempts"] for row in rows], [1, 0, 1, 0])
        self.assertFalse(any(row["complete"] for row in rows))

    def test_exhausted_canary_does_not_count_previous_dispatches(self):
        self.server.max_requests = 1
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request()[0], 429)
        rows = self.audit(2)
        self.assertEqual([row["attempts"] for row in rows], [1, 0])

    def test_revocation_persists_and_does_not_auto_recover(self):
        self.health.revoked = True
        self.assertEqual(self.request()[0], 503)
        self.health.revoked = False
        self.assertEqual(self.request()[0], 503)
        self.assertTrue((self.root / "auth-latch.json").exists())
        self.assertFalse(self.created)

    def test_disconnect_drains_terminal_and_keeps_one_lease(self):
        self.release = threading.Event()
        raw = json.dumps(self.body(stream=True)).encode()
        sock = socket.create_connection(self.server.server_address, timeout=3)
        sock.sendall(
            b"POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer "
            + b"k" * 40
            + b"\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(raw)).encode()
            + b"\r\n\r\n"
            + raw
        )
        received = b""
        while b"event: message_start" not in received:
            chunk = sock.recv(4096)
            self.assertTrue(chunk, "connection ended before the fixture stream began")
            received += chunk
        self.assertEqual(self.request()[0], 429)
        self.assertEqual(len(self.created), 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        sock.close()
        self.release.set()
        deadline = time.monotonic() + 2
        while len(self.audit()) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        row = next(r for r in self.audit() if r["attempts"] == 1)
        self.assertTrue(row["complete"])
        self.assertEqual(row["status"], 499)
        self.assertEqual(row["usage"]["output_tokens"], 5)


if __name__ == "__main__":
    unittest.main()
