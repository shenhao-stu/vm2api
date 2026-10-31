import copy, json, os, tempfile, unittest, uuid
from pathlib import Path
from native_bridge_session import Session, ContractError


class ContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "session"
        self.body = {
            "model": "fixture",
            "max_tokens": 1024,
            "tools": [],
            "system": "original system",
            "messages": [{"role": "user", "content": "private text"}],
        }
        self.env = {"PATH": os.environ["PATH"]}
        self.session = Session(self.path, ["unused"], self.env, self.body)
        self.session.history = self.body["messages"] + [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "private reply"}],
            }
        ]
        self.session.assistants["msg_fixture"] = str(uuid.uuid4())
        self.session.checkpoint("idle", "request-hash", "msg_fixture")
        self.follow = {
            **self.body,
            "messages": self.session.history
            + [{"role": "user", "content": "new turn"}],
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_native_resume_uses_verified_history_without_serializing_text(self):
        saved = (self.path / "continuation.json").read_text()
        self.assertNotIn("private text", saved)
        self.assertNotIn("private reply", saved)
        recovered = Session(self.path, ["unused"], self.env, self.follow, restore=True)
        self.assertEqual(recovered.native_id, self.session.native_id)
        self.assertEqual(recovered.history, self.session.history)
        self.assertEqual((self.path / "system.txt").read_text(), "original system")

    def test_changed_history_and_configuration_cannot_restore_or_alter_checkpoint(self):
        saved = (self.path / "continuation.json").read_bytes()
        for body in [copy.deepcopy(self.follow), {**self.follow, "model": "different"}]:
            if body["model"] == "fixture":
                body["messages"][0]["content"] = "not owned"
            with self.assertRaisesRegex(ContractError, "history_prefix_mismatch"):
                Session(self.path, ["unused"], self.env, body, restore=True)
            self.assertEqual((self.path / "continuation.json").read_bytes(), saved)

    def test_unknown_paid_outcome_and_failed_session_never_restore(self):
        for state in ["in_flight", "failed", "native_resume_point_missing"]:
            self.session.checkpoint(state)
            with self.assertRaisesRegex(ContractError, "incomplete_no_replay"):
                Session(self.path, ["unused"], self.env, self.follow, restore=True)

    def test_invalid_followup_does_not_destroy_a_healthy_session(self):
        saved = (self.path / "continuation.json").read_bytes()
        changed = copy.deepcopy(self.follow)
        changed["messages"][0]["content"] = "wrong history"
        for body in [changed, {**self.follow, "model": "different"}]:
            with self.assertRaises(ContractError):
                list(self.session.request(body))
            self.assertFalse(self.session.failed)
            self.assertEqual((self.path / "continuation.json").read_bytes(), saved)

    def test_invalid_nested_tool_result_preserves_native_session(self):
        saved = (self.path / "continuation.json").read_bytes()
        self.session.pending_ids = {"tool_fixture"}
        for content in [[None], ["invalid"], [{"type": "text"}], None]:
            changed = copy.deepcopy(self.follow)
            changed["messages"][-1]["content"] = [{
                "type": "tool_result", "tool_use_id": "tool_fixture",
                "content": content,
            }]
            with self.subTest(content=content), self.assertRaises(ContractError):
                list(self.session.request(changed))
            self.assertFalse(self.session.failed)
            self.assertEqual(self.session.pending_ids, {"tool_fixture"})
            self.assertEqual((self.path / "continuation.json").read_bytes(), saved)


if __name__ == "__main__":
    unittest.main()
