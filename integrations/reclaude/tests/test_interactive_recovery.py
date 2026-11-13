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


class DurableRecoveryEvidenceTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        import uuid
        from native_bridge_session import signature

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.dispatch = self.root / "dispatch"
        self.dispatch.mkdir()
        self.sid, self.grant = str(uuid.uuid4()), str(uuid.uuid4())
        self.body = {
            "model": "fixture",
            "metadata": {"user_id": json.dumps({"session_id": self.sid})},
            "messages": [{"role": "user", "content": "fixture"}],
            "max_tokens": 64,
        }
        self.path("api-request.private.json").write_text(json.dumps(self.body))
        self.path("consumed.json").write_text(
            json.dumps(
                {
                    "body_sha256": hashlib.sha256(
                        self.path("api-request.private.json").read_bytes()
                    ).hexdigest()
                }
            )
        )
        self.assistant = [
            {
                "type": "tool_use",
                "id": "tool_owned",
                "name": "echo",
                "input": {"text": "fixture"},
            }
        ]
        self.events = [
            {
                "type": "message_start",
                "message": {
                    "id": "msg_fixture",
                    "type": "message",
                    "role": "assistant",
                    "model": "fixture",
                    "content": [],
                    "usage": {
                        "input_tokens": 7,
                        "output_tokens": 0,
                        "cache_creation_input_tokens": 11,
                        "cache_creation": {"ephemeral_1h_input_tokens": 11},
                    },
                },
            },
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {**self.assistant[0], "input": {}},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": '{"text":"fixture"}',
                },
            },
            {"type": "content_block_stop", "index": 0},
            {
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use"},
                "usage": {"output_tokens": 3},
            },
            {"type": "message_stop"},
        ]
        self.plan = {
            "version": 1,
            "native_id": self.sid,
            "base_history": [],
            "tools": [{"name": "echo"}],
            "steps": [
                {"grant_id": self.grant, "assistant_sha256": signature(self.assistant),
                 "input": [{"type": "text", "text": "synthetic"}]}
            ],
        }
        self.write_stream()

    def path(self, extension):
        return self.dispatch / (self.grant + "." + extension)

    def write_stream(self):
        data = b"".join(
            ("data: " + json.dumps(e) + "\n\n").encode() for e in self.events
        )
        self.path("api-stream.private").write_bytes(data)
        self.path("api-terminal.json").write_text(
            json.dumps(
                {
                    "grant_id": self.grant,
                    "status": 200,
                    "complete": True,
                    "bytes": len(data),
                }
            )
        )

    def load(self):
        from native_interactive_recovery import load_steps

        return load_steps(self.root, self.plan, self.sid)

    def test_valid_evidence_preserves_original_bytes_and_usage(self):
        original = self.path("api-stream.private").read_bytes()
        step = self.load()[0]
        self.assertEqual(step["pending"], self.assistant)
        self.assertIn(b'"ephemeral_1h_input_tokens": 11', step["stream"])
        self.assertEqual(self.path("api-stream.private").read_bytes(), original)

    def test_missing_or_changed_request_evidence_cannot_restore(self):
        self.path("api-request.private.json").write_text('{"model":"changed"}')
        with self.assertRaisesRegex(RecoveryError, "digest_mismatch"):
            self.load()
        self.path("api-request.private.json").unlink()
        with self.assertRaises(FileNotFoundError):
            self.load()

    def test_complete_transport_without_semantic_terminal_is_not_final_usage(self):
        self.events.pop()
        self.write_stream()
        with self.assertRaisesRegex(RecoveryError, "terminal_mismatch"):
            self.load()

    def test_tool_argument_change_is_not_accepted_by_matching_tool_id(self):
        self.events[2]["delta"]["partial_json"] = '{"text":"tampered"}'
        self.write_stream()
        with self.assertRaisesRegex(RecoveryError, "terminal_mismatch"):
            self.load()

    def test_failed_incomplete_or_other_grant_receipt_is_rejected(self):
        original = json.loads(self.path("api-terminal.json").read_bytes())
        for change in (
            {"complete": False},
            {"status": 429},
            {"grant_id": "foreign"},
            {"bytes": 0},
        ):
            with self.subTest(change=change):
                self.path("api-terminal.json").write_text(
                    json.dumps({**original, **change})
                )
                with self.assertRaises(RecoveryError):
                    self.load()

    def test_other_native_session_and_path_traversal_are_rejected(self):
        self.plan["native_id"] = "other"
        with self.assertRaises(RecoveryError):
            self.load()
        self.plan["native_id"] = self.sid
        self.plan["steps"][0]["grant_id"] = "../../foreign"
        with self.assertRaises(ValueError):
            self.load()


if __name__ == "__main__":
    unittest.main()
