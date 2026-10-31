import copy
import unittest
from native_bridge_session import history_shape, signature, configuration, fresh_prompt, native_blocks


class HistorySemantics(unittest.TestCase):
    def test_sub_account_test_annotations_do_not_reach_cli(self):
        messages = [{"role": "user", "content": [{"type": "text", "text": "hi",
                     "cache_control": {"type": "ephemeral"}}]}]
        before = copy.deepcopy(messages)
        self.assertEqual(fresh_prompt(messages), [{"type": "text", "text": "hi"}])
        self.assertEqual(messages, before)

    def test_followup_and_tool_result_annotations_are_owned_by_cli(self):
        content = [{"type": "tool_result", "tool_use_id": "tool_fixture",
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                    "content": [{"type": "text", "text": "cache_control is user text",
                                 "cache_control": {"type": "ephemeral"}}]}]
        before = copy.deepcopy(content)
        cleaned = native_blocks(content)
        self.assertNotIn("cache_control", cleaned[0])
        self.assertEqual(cleaned[0]["content"], [{"type": "text", "text": "cache_control is user text"}])
        self.assertEqual(native_blocks(cleaned), cleaned)
        self.assertEqual(content, before)

    def test_native_tool_input_named_cache_control_is_not_metadata(self):
        content = [{"type": "tool_use", "id": "t", "name": "Read",
                    "input": {"cache_control": {"ttl": "business-data"}}}]
        self.assertEqual(native_blocks(content), content)

    def setUp(self):
        self.block = {
            "type": "tool_use",
            "id": "toolu_observed",
            "name": "Read",
            "input": {"file_path": "/caller/fixture"},
            "caller": {"type": "direct"},
        }
        self.history = [{"role": "assistant", "content": [self.block]}]

    def test_direct_caller_omission_is_equivalent(self):
        wire = copy.deepcopy(self.history)
        wire[0]["content"][0].pop("caller")
        self.assertEqual(history_shape(wire), history_shape(self.history))

    def test_non_direct_caller_not_ignored(self):
        wire = copy.deepcopy(self.history)
        wire[0]["content"][0]["caller"] = {
            "type": "code_execution_20250825",
            "tool_id": "foreign",
        }
        self.assertNotEqual(history_shape(wire), history_shape(self.history))

    def test_tool_arguments_named_cache_control_are_not_annotations(self):
        first = copy.deepcopy(self.history)
        first[0]["content"][0]["input"]["cache_control"] = "private-A"
        second = copy.deepcopy(first)
        second[0]["content"][0]["input"]["cache_control"] = "private-B"
        self.assertNotEqual(
            signature(history_shape(first)), signature(history_shape(second))
        )

    def test_only_real_block_cache_annotation_is_ignored(self):
        second = copy.deepcopy(self.history)
        second[0]["content"][0]["cache_control"] = {"type": "ephemeral"}
        self.assertEqual(history_shape(second), history_shape(self.history))

    def test_schema_property_named_cache_control_is_preserved(self):
        first = {
            "tools": [
                {
                    "name": "tool",
                    "cache_control": {"type": "ephemeral"},
                    "input_schema": {
                        "properties": {"cache_control": {"type": "string"}}
                    },
                }
            ]
        }
        second = copy.deepcopy(first)
        second["tools"][0]["input_schema"]["properties"]["cache_control"][
            "type"
        ] = "number"
        self.assertNotEqual(configuration(first), configuration(second))


if __name__ == "__main__":
    unittest.main()
