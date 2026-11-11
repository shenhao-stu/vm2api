import copy
import http.client
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from native_interactive_recovery import (
    RecoveryError,
    RecoveryGate,
    bounded_bytes,
    caller_tool_event,
    caller_tool_stream,
    semantic_request,
)


class RecoveryBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.session = "12345678-1234-4234-8234-123456789012"
        self.body = {
            "model": "fixture",
            "metadata": {
                "user_id": json.dumps(
                    {"session_id": self.session, "device_id": "original"}
                )
            },
            "messages": [{"role": "user", "content": "synthetic"}],
            "tools": [
                {"name": "mcp__caller__echo", "input_schema": {"type": "object"}}
            ],
            "max_tokens": 64,
            "stream": True,
        }
        self.stream = b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        # A closed target proves every recovery response is served locally.
        self.gate = RecoveryGate(
            "http://127.0.0.1:1",
            self.session,
            [
                {
                    "expected": semantic_request(self.body, self.session),
                    "stream": self.stream,
                }
            ],
        )
        self.addCleanup(self.gate.close)

    def call(self, body):
        client = http.client.HTTPConnection(
            "127.0.0.1", self.gate.server_port, timeout=2
        )
        try:
            client.request(
                "POST",
                "/v1/messages?beta=true",
                json.dumps(body),
                {"Content-Type": "application/json"},
            )
            reply = client.getresponse()
            return reply.status, reply.read()
        finally:
            client.close()

    def test_exact_local_response_then_no_extra_dispatch(self):
        self.assertEqual(self.call(self.body), (200, self.stream))
        self.assertEqual(self.call(self.body)[0], 400)
        self.assertEqual(self.gate.index, 1)
        with self.assertRaises(RecoveryError):
            self.gate.activate()

    def test_changed_input_is_not_replayed(self):
        body = copy.deepcopy(self.body)
        body["messages"][0]["content"] = "different"
        self.assertEqual(self.call(body)[0], 400)
        self.assertEqual(self.gate.index, 0)

    def test_other_session_is_never_replayed(self):
        body = copy.deepcopy(self.body)
        body["metadata"]["user_id"] = json.dumps({"session_id": "other"})
        self.assertEqual(self.call(body)[0], 400)
        self.assertEqual(self.gate.index, 0)

    def test_tool_schema_and_generation_controls_must_match(self):
        for field, value in [
            ("tools", []),
            ("max_tokens", 65),
            ("model", "other"),
            ("system", "injected"),
        ]:
            with self.subTest(field=field):
                body = copy.deepcopy(self.body)
                body[field] = value
                self.assertEqual(self.call(body)[0], 400)
                self.assertEqual(self.gate.index, 0)

    def test_identity_serialization_does_not_change_semantics(self):
        body = copy.deepcopy(self.body)
        body["metadata"]["user_id"] = json.dumps(
            {"device_id": "original", "session_id": self.session}, separators=(",", ":")
        )
        self.assertEqual(self.call(body), (200, self.stream))
        self.gate.activate()
        self.assertTrue(self.gate.live)

    def test_changed_device_identity_is_rejected(self):
        body = copy.deepcopy(self.body)
        body["metadata"]["user_id"] = json.dumps(
            {"session_id": self.session, "device_id": "new"}
        )
        self.assertEqual(self.call(body)[0], 400)
        self.assertEqual(self.gate.index, 0)

    def test_tool_alias_is_exact_and_original_event_is_unchanged(self):
        event = {
            "type": "content_block_start",
            "content_block": {
                "type": "tool_use",
                "name": "Agent",
                "id": "owned",
                "input": {},
            },
        }
        before = copy.deepcopy(event)
        mapped = caller_tool_event(event, [{"name": "Agent"}])
        self.assertEqual(mapped["content_block"]["name"], "mcp__caller__Agent")
        self.assertEqual(event, before)
        self.assertEqual(caller_tool_event(event, [{"name": "Bash"}]), event)
        raw = (
            b"event: content_block_start\ndata: " + json.dumps(event).encode() + b"\n\n"
        )
        self.assertIn(
            b'"mcp__caller__Agent"', caller_tool_stream(raw, [{"name": "Agent"}])
        )
        self.assertEqual(caller_tool_stream(raw, [{"name": "Bash"}]), raw)

    def test_cannot_activate_without_verified_local_response(self):
        with self.assertRaises(RecoveryError):
            self.gate.activate()
        self.assertFalse(self.gate.live)


class EvidenceLimitTests(unittest.TestCase):
    def test_large_archive_is_rejected_before_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "archive"
            with path.open("wb") as stream:
                stream.truncate(128 * 1024 * 1024)
            with self.assertRaisesRegex(RecoveryError, "recovery_evidence_limit"):
                bounded_bytes(path, 1024)
            path.write_bytes(b"abc")
            self.assertEqual(bounded_bytes(path, 3), b"abc")
            with self.assertRaises(RecoveryError):
                bounded_bytes(path, 2)


if __name__ == "__main__":
    unittest.main()
