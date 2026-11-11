import copy
import os
from pathlib import Path
import tempfile
import unittest

from native_bridge_session import ContractError, RequestRejected
from native_interactive_session import InteractiveSession, prompt_text


class InteractiveContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.body = {
            "model": "claude-opus-5-5",
            "max_tokens": 128,
            "messages": [{"role": "user", "content": "synthetic"}],
        }
        self.session = InteractiveSession(
            self.root / "session",
            ["/bin/false"],
            {"HOME": str(self.root), "PATH": os.environ["PATH"]},
            self.body,
            api_base="https://example.invalid",
            dispatch_proxy=Path("/bin/false"),
            history_profile=self.root / "profile",
        )
        self.addCleanup(self.session.close)

    def assert_not_dispatched(self):
        self.assertIsNone(self.session.process)
        self.assertIsNone(self.session.dispatch_process)
        self.assertEqual(self.session.seen, set())

    def test_terminal_control_sequences_reject_before_dispatch(self):
        for value in ["\x1b[200~attack", "\x04", " \n\t"]:
            body = copy.deepcopy(self.body)
            body["messages"][0]["content"] = value
            with self.assertRaises(ContractError):
                list(self.session.request(body))
            self.assert_not_dispatched()
        self.assertEqual(
            prompt_text([{"type": "text", "text": "line1\nline2"}]), "line1\nline2"
        )

    def test_pending_restart_does_not_convert_results_to_text_or_replay(self):
        body = copy.deepcopy(self.body)
        body["messages"] += [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "tool_owned",
                        "name": "echo",
                        "input": {},
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tool_owned",
                        "content": "real result",
                    }
                ],
            },
        ]
        for pending, suspended in [(set(), False), ({"tool_owned"}, True)]:
            self.session.pending_ids = pending
            self.session.suspended = suspended
            original = copy.deepcopy(body)
            with self.assertRaisesRegex(
                RequestRejected, "interactive_resume_tool_results_not_supported"
            ):
                list(self.session.request(body))
            self.assertEqual(body, original)
            self.assert_not_dispatched()

    def test_media_and_structured_output_reject_before_dispatch(self):
        body = copy.deepcopy(self.body)
        body["messages"][0]["content"] = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "aGVsbG8=",
                },
            }
        ]
        with self.assertRaises(ContractError):
            list(self.session.request(body))
        self.assert_not_dispatched()
        body = copy.deepcopy(self.body)
        body["output_config"] = {
            "format": {"type": "json_schema", "schema": {"type": "object"}}
        }
        with self.assertRaisesRegex(
            RequestRejected, "interactive_structured_output_not_supported"
        ):
            list(self.session.request(body))
        self.assert_not_dispatched()


if __name__ == "__main__":
    unittest.main()
