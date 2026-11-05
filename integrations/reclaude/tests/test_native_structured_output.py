import copy
import json
import tempfile
import unittest
import uuid
from unittest.mock import patch
from pathlib import Path
from native_bridge_session import native_options, configuration, fixed_configuration, ContractError, Session, Turn

SCHEMA = {'type': 'object', 'properties': {'ok': {'type': 'boolean'}}, 'required': ['ok'], 'additionalProperties': False}
BASE = {'model': 'fixture', 'max_tokens': 1024, 'messages': [{'role': 'user', 'content': 'synthetic'}]}

class StructuredOptionsTests(unittest.TestCase):
    def test_native_cli_receives_the_exact_schema_and_default_effort(self):
        body = {**BASE, 'output_config': {'format': {'type': 'json_schema', 'schema': SCHEMA}}}
        before = copy.deepcopy(body)
        _, args = native_options(body)
        self.assertEqual(json.loads(args[args.index('--json-schema') + 1]), SCHEMA)
        self.assertEqual(args[args.index('--effort') + 1], 'medium')
        self.assertEqual(body, before)
        self.assertEqual(configuration(body)['output_config']['format'], body['output_config']['format'])
        self.assertEqual(fixed_configuration(body), fixed_configuration(BASE))

    def test_unsupported_or_ambiguous_format_is_not_silently_dropped(self):
        for fmt in [None, {}, {'type':'text'}, {'type':'json_schema','schema':True}, {'type':'json_schema','schema':{},'unknown':True}]:
            with self.subTest(format=fmt), self.assertRaises(ContractError):
                native_options({**BASE,'output_config':{'format':fmt}})

    def test_schema_resources_are_bounded_before_dispatch(self):
        deep = {}
        for _ in range(66):
            deep = {"properties": {"next": deep}}
        for schema in [{"$ref": "https://example.invalid/schema"},
                       {"$ref": "file:///private/schema"},
                       {"$dynamicRef": "other.json#value"},
                       {"description": "x" * 65537}, {"const": float("nan")}, deep]:
            with self.subTest(schema_kind=next(iter(schema))), self.assertRaises(ContractError):
                native_options({**BASE, "output_config": {"format": {"type": "json_schema", "schema": schema}}})
        local = {"$defs": {"object": {"type": "object"}}, "$ref": "#/$defs/object"}
        _, args = native_options({**BASE, "output_config": {"format": {"type": "json_schema", "schema": local}}})
        self.assertEqual(json.loads(args[-1]), local)


class StructuredFailureTests(unittest.TestCase):
    def run_failure(self, ending, overflow=False):
        with tempfile.TemporaryDirectory() as temp:
            body = {**BASE, "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}}}
            session = Session(Path(temp)/"session", ["unused"], {}, body, timeout=0.01)
            events = [
                {"type": "message_start", "message": {"id": "msg-fixture", "content": [], "usage": {"input_tokens": 7, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "x" * (4096 if overflow else 2)}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 11}},
            ]
            if ending != "timeout":
                events.append(None if ending == "eof" else {"type": "message_stop"})
            def start(_):
                self.assertEqual(json.loads((session.directory / "continuation.json").read_text())["status"], "in_flight")
                session.authorize_dispatch()
                for e in events:
                    session.events.put(e)
            actual = []
            tracked = []
            original_event = Turn.event
            def observe(turn, event):
                tracked.append(event)
                return original_event(turn, event)
            with patch.object(session, "prepare"), patch.object(session, "dispatch_user_input", side_effect=start), patch.object(session, "authorize_dispatch") as grant, patch("native_bridge_session.STRUCTURED_RESPONSE_LIMIT", 2048), patch.object(Turn, "event", observe):
                with self.assertRaises(ContractError):
                    for event in session.request(body):
                        actual.append(event)
                grant.assert_called_once()
            self.assertEqual(actual[-1], {"type": "message_delta", "delta": {}, "usage": {"input_tokens": 7, "output_tokens": 11}})
            self.assertEqual([e["type"] for e in actual], ["message_start", "message_delta"])
            self.assertTrue(session.failed)
            self.assertEqual(json.loads((session.directory/"continuation.json").read_text())["status"], "failed")
            if overflow:
                self.assertFalse(any(e.get("delta", {}).get("text", "").startswith("xxx") for e in tracked))

    def test_usage_survives_eof_before_message_stop(self):
        self.run_failure("eof")

    def test_usage_survives_timeout_before_message_stop(self):
        self.run_failure("timeout")

    def test_oversized_content_is_not_accumulated_but_real_usage_is_retained(self):
        self.run_failure("stop", overflow=True)


class RestoreClassificationTests(unittest.TestCase):
    def test_resident_and_restored_rejections_match_without_dispatch(self):
        for version in (2, 3):
            for change in ("unchanged", "max_tokens", "tools", "model", "system", "history"):
                with self.subTest(version=version, change=change), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    body = {**copy.deepcopy(BASE), "system": "owner", "tools": [{"name": "Read", "input_schema": {"type": "object"}}]}
                    s = Session(root/"session", ["unused"], {}, body, history_profile=root/"profile")
                    s.history = copy.deepcopy(body["messages"]) + [{"role": "assistant", "content": "complete"}]
                    s.assistants["paid"] = str(uuid.uuid4())
                    s.structured_checkpoint = version == 3
                    s.checkpoint("idle", "paid-request", "paid")
                    following = {**copy.deepcopy(body), "messages": copy.deepcopy(s.history) + [{"role": "user", "content": "new"}]}
                    if change == "max_tokens": following["max_tokens"] = 256
                    if change == "tools": following["tools"][0]["input_schema"]["description"] = "new"
                    if change in ("model", "system"): following[change] = "different"
                    if change == "history": following["messages"][0]["content"] = "not owned"
                    saved = (s.directory/"continuation.json").read_bytes()
                    expected = "session_configuration_changed" if change in ("model", "system") else "history_prefix_mismatch" if change == "history" else None
                    with patch.object(Session, "authorize_dispatch") as grant:
                        if expected:
                            with self.assertRaisesRegex(ContractError, expected):
                                s.validate_configuration(following); s.continuation_import(following)
                            with self.assertRaisesRegex(ContractError, expected):
                                Session(root/"session", ["unused"], {}, following, history_profile=root/"profile", restore=True)
                            self.assertEqual((s.directory/"continuation.json").read_bytes(), saved)
                        else:
                            s.validate_configuration(following); s.continuation_import(following)
                            recovered = Session(root/"session", ["unused"], {}, following, history_profile=root/"profile", restore=True)
                            self.assertEqual(recovered.structured_checkpoint, version == 3)
                        grant.assert_not_called()


class ValidatedProjectionTests(unittest.TestCase):
    def test_projection_preserves_usage_from_every_observed_delta(self):
        with tempfile.TemporaryDirectory() as temp:
            s = Session(Path(temp)/"session", ["unused"], {}, BASE)
            turn = Turn([], structured=True)
            events = [
                {"type":"message_start", "message":{"id":"fixture", "content":[], "usage":{"input_tokens":7,"output_tokens":0}}},
                {"type":"content_block_start", "index":0, "content_block":{"type":"tool_use","id":"internal","name":"StructuredOutput","input":{"ok":True}}},
                {"type":"message_delta", "delta":{}, "usage":{"cache_read_input_tokens":3}},
                {"type":"message_delta", "delta":{"stop_reason":"tool_use"}, "usage":{"output_tokens":11}},
                {"type":"message_stop"},
            ]
            converted = [turn.event(e) for e in events]
            s.result_message_id = "fixture"
            s.result = {"structured_output":{"ok":True}, "is_error":False}
            output = s.structured_events(turn, converted[1:], 512)
            self.assertEqual(output[-2]["usage"], {"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":3})
            self.assertEqual(turn.message["content"], [{"type":"text","text":"{\"ok\":true}"}])
            self.assertTrue(s.structured_checkpoint)

    def test_native_result_comparison_does_not_conflate_boolean_and_number(self):
        with tempfile.TemporaryDirectory() as temp:
            s = Session(Path(temp)/"session", ["unused"], {}, BASE)
            turn = Turn([], structured=True)
            turn.message = {"id":"fixture", "content":[{"type":"tool_use","input":{"ok":True}}], "stop_reason":"tool_use"}
            turn.structured_indices = {0}
            s.result_message_id = "fixture"
            s.result = {"structured_output":{"ok":1}, "is_error":False}
            with self.assertRaisesRegex(ContractError, "native_structured_output_invalid_no_replay"):
                s.structured_events(turn, [], 512)
            self.assertFalse(s.structured_checkpoint)
