"""No provider access: assert no input reaches a child before its policy is ready."""

import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

from native_bridge_session import ContractError, Session

CHILD = """
import json,pathlib,sys,time
log=pathlib.Path(sys.argv[sys.argv.index('--debug-file')+1])
if __import__('os').environ.get('FIXTURE_POLICY_READY'):
 time.sleep(.25)
 log.write_text('Policy limits: Cache still valid (304 Not Modified)\\n')
for line in sys.stdin:
 message=json.loads(line)
 if message['type']=='control_request':
  print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':message['request_id'],'response':{}}}),flush=True)
 else:
  pathlib.Path('received.json').write_text(line)
"""


class PolicyGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.child = self.root / "child.py"
        self.child.write_text(CHILD)
        self.sessions = []

    def tearDown(self):
        for session in self.sessions:
            session.close()
        self.temp.cleanup()

    def session(self, ready):
        env = {"PATH": os.environ["PATH"]}
        if ready:
            env["FIXTURE_POLICY_READY"] = "1"
        body = {
            "model": "fixture",
            "messages": [{"role": "user", "content": "one actual turn"}],
            "max_tokens": 1024,
            "tools": [],
        }
        s = Session(
            self.root / "session",
            [sys.executable, str(self.child)],
            env,
            body,
            timeout=0.6,
            require_policy=True,
        )
        self.sessions.append(s)
        return s

    def test_unavailable_policy_sends_no_input(self):
        s = self.session(False)
        with self.assertRaisesRegex(
            ContractError, "native_policy_not_ready_no_dispatch"
        ):
            s.start([{"type": "text", "text": "MUST NOT SEND"}])
        self.assertFalse((s.directory / "received.json").exists())
        self.assertTrue(s.failed)
        self.assertIsNotNone(s.process.poll())

    def test_prepare_has_no_input_and_reuses_one_process(self):
        s = self.session(True)
        s.prepare()
        pid = s.process.pid
        self.assertFalse((s.directory / "received.json").exists())
        s.start([{"type": "text", "text": "genuine test input"}])
        deadline = time.monotonic() + 2
        while (
            not (s.directory / "received.json").exists() and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        self.assertEqual(s.process.pid, pid)
        data = json.loads((s.directory / "received.json").read_text())
        self.assertEqual(data["message"]["content"][0]["text"], "genuine test input")

    def test_prewarm_has_no_prompt_grant_and_reuses_initialized_process(self):
        s = self.session(True)
        body = {"model": "fixture", "messages": [{"role": "user", "content": "draft"}],
                "max_tokens": 1024, "tools": []}
        self.assertFalse(s.prepare_request(body)["reused"])
        pid = s.process.pid
        self.assertTrue(s.prepare_request(body)["reused"])
        self.assertEqual(s.process.pid, pid)
        self.assertFalse((s.directory / "received.json").exists())
        self.assertEqual(s.history, [])
        self.assertEqual(s.seen, set())
        self.assertIsNone(s.last_grant_id)

    def test_prewarm_rejects_changed_configuration_without_poisoning(self):
        s = self.session(True)
        body = {"model": "other", "messages": [{"role": "user", "content": "draft"}],
                "max_tokens": 1024, "tools": []}
        with self.assertRaisesRegex(ContractError, "session_configuration_changed"):
            s.prepare_request(body)
        self.assertFalse(s.failed)
        self.assertIsNone(s.process)
        body["model"] = "fixture"
        body["messages"].append({"role": "system", "content": "different startup context"})
        with self.assertRaisesRegex(ContractError, "session_configuration_changed"):
            s.prepare_request(body)
        self.assertFalse(s.failed)


if __name__ == "__main__":
    unittest.main()
