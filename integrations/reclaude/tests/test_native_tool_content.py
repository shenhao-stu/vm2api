import copy
import unittest

import native_bridge_session as bridge


class ToolContentTests(unittest.TestCase):
    def body(self, content):
        return {"model": "fixture", "max_tokens": 128,
                "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
                "messages": [{"role": "user", "content": [{
                    "type": "tool_result", "tool_use_id": "tool_fixture", "content": content}]}]}

    def test_native_supported_tool_results_are_not_text_only(self):
        for block in [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}},
            {"type": "document", "source": {"type": "text", "media_type": "text/plain", "data": "document"}},
            {"type": "search_result", "title": "title", "source": "https://example.com/", "content": [{"type": "text", "text": "result"}]},
            {"type": "tool_reference", "tool_name": "Read"},
        ]:
            with self.subTest(kind=block["type"]):
                body = self.body([block]); before = copy.deepcopy(body)
                bridge.native_options(body)
                self.assertEqual(body, before)
                self.assertEqual(bridge.native_blocks(body["messages"][0]["content"])[0]["content"], [block])

    def test_malformed_nested_content_rejects_before_session_creation(self):
        for content in [None, [None], [{"type": "image"}], [{"type": "text"}],
                        [{"type": "tool_reference", "tool_name": "Unknown"}],
                        [{"type": "tool_result", "tool_use_id": "nested", "content": "bad"}]]:
            with self.subTest(content=content), self.assertRaises(bridge.ContractError):
                bridge.native_options(self.body(content))

    def test_tool_namespace_mapping_does_not_rewrite_arguments_or_text(self):
        blocks = [{"type": "tool_use", "name": "Read", "id": "tool_1", "input": {"tool_name": "Read"}},
                  {"type": "tool_result", "tool_use_id": "tool_1", "content": [
                      {"type": "text", "text": "Read"}, {"type": "tool_reference", "tool_name": "Read"}]}]
        before = copy.deepcopy(blocks)
        mapped = [bridge.dispatch_blocks([block])[0] for block in blocks]
        self.assertEqual(mapped[0]["name"], "mcp__caller__Read")
        self.assertEqual(mapped[1]["content"][1]["tool_name"], "mcp__caller__Read")
        self.assertEqual(mapped[0]["input"], {"tool_name": "Read"})
        self.assertEqual(mapped[1]["content"][0]["text"], "Read")
        self.assertEqual(blocks, before)
