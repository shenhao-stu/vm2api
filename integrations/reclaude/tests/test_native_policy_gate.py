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


if __name__ == "__main__":
    unittest.main()
