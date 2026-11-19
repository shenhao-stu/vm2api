"""Offline: one caller session alternating between relay accounts.

Production 2026-11-18 (34050): a sub-agent turn ended at a tool_use on this
relay, the caller completed the next turn on another account, then returned.
The resumed CLI exited during ReClaude's config sync with zero dispatches, yet
the channel was retired as failed and every later request in the caller session
received native_session_evidence_unknown / native_session_failed_no_replay.
"""
import copy
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import Mock, patch
import uuid

from native_bridge_session import ContractError, RequestRejected, Session, history_shape, signature
from native_channel_store import read_json, write_json
from native_session_pool import SessionPool


class Process:
    def __init__(self, running=False):
        self.stdin = self.stdout = None
        self.code = None if running else 0

    def poll(self):
        return self.code

    def terminate(self):
        self.code = 0

    def wait(self, timeout=None):
        self.code = 0


class CrossAccountSwitch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stats = {"upstream_attempts": 0, "denied": 0, "requests": 0}
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(fixture.stats).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.tools = [{"name": "Bash", "input_schema": {"type": "object"}}]
        self.body = {"model": "opus", "max_tokens": 64, "system": "owned system",
                     "tools": self.tools, "metadata": {"user_id": str(uuid.uuid4())},
                     "messages": [{"role": "user", "content": "sub-agent task"}]}
        self.pool = self.new_pool()

    def tearDown(self):
        self.pool.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def new_pool(self):
        def factory(path, body):
            return Session(path, ["synthetic-cli"], {}, body, timeout=.01, restore=True,
                           require_policy=True, dispatch_proxy="synthetic-proxy",
                           history_profile=self.root / "profile")
        return SessionPool(self.root / "sessions", factory, recover=factory,
                           allow_history_import=True, configuration_channels=True)

    def completed(self, session, body, content, pending=()):
        session.caller_request_sha = signature(history_shape(body["messages"]))
        session.dispatch_process = Mock(poll=lambda: None)
        (session.directory / "dispatch").mkdir(exist_ok=True)
        session.authorize_dispatch()
        grant = read_json(session.directory / "dispatch/grant.json")
        write_json(session.directory / "dispatch" / (grant["id"] + ".consumed.json"), grant,
                   exclusive=True)
        session.history = copy.deepcopy(body["messages"]) + [{"role": "assistant", "content": content}]
        session.pending_ids = set(pending)
        message = str(uuid.uuid4())
        session.assistants[message] = str(uuid.uuid4())
        session.checkpoint("awaiting_tools" if pending else "idle", session.caller_request_sha, message)
        session.channel_store.complete(session, session.caller_request_sha,
                                       {"input_tokens": 3, "output_tokens": 2})
        session.dispatch_process = None
        session.process_has_turn = True
        return copy.deepcopy(session.history)

    def proxy(self, session):
        directory = session.directory / "dispatch"
        directory.mkdir(exist_ok=True)
        session.dispatch_process = Process()
        session.dispatch_address = "http://%s:%s" % self.server.server_address
        (directory / "ready.safe.json").write_text(json.dumps({
            "session_id": session.native_id, "listen": "%s:%s" % self.server.server_address}))

    def fail_policy(self, session):
        # ReClaude's launcher exits during "Syncing config" before the CLI exists.
        self.proxy(session)
        session.process = Process()
        session.reader = None
        session.policy_log = self.root / "missing-native-policy.log"
        session.await_native_policy()

    def tool_turn(self):
        with self.pool.lease("tenant-a", self.body) as session:
            history = self.completed(session, self.body, [
                {"type": "thinking", "thinking": "plan", "signature": "sig-a"},
                {"type": "tool_use", "id": "toolu_here", "name": "Bash", "input": {"command": "ls"}}],
                pending=("toolu_here",))
        return session, history

    def returning_body(self, history):
        # The tool result and the next model turn were completed on another account.
        messages = history + [
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_here",
                                          "content": "a.txt"}]},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "elsewhere", "signature": "sig-b"},
                {"type": "tool_use", "id": "toolu_elsewhere", "name": "Bash",
                 "input": {"command": "cat a.txt"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_elsewhere",
                                          "content": "hello"}]}]
        return {**self.body, "messages": messages}

    def assert_resumable(self, original, returning):
        with self.pool.lease("tenant-a", returning) as again:
            self.assertEqual(again.directory, original.directory)
            self.assertFalse(again.failed)

    def test_policy_sync_exit_on_return_keeps_tool_checkpoint(self):
        original, history = self.tool_turn()
        checkpoint = (original.directory / "continuation.json").read_bytes()
        returning = self.returning_body(history)
        with self.pool.lease("tenant-a", returning) as session:
            self.assertIs(session, original)
            with patch.object(Session, "prepare", lambda s: self.fail_policy(s)):
                with self.assertRaisesRegex(RequestRejected, "native_policy_not_ready_no_dispatch"):
                    list(session.request(returning))
            self.assertFalse(session.failed)
        self.assertEqual((original.directory / "continuation.json").read_bytes(), checkpoint)
        # The very same caller request must still be admissible: nothing was dispatched.
        self.assert_resumable(original, returning)

    def test_policy_sync_exit_on_return_survives_pool_restart(self):
        original, history = self.tool_turn()
        returning = self.returning_body(history)
        with self.pool.lease("tenant-a", returning) as session:
            with patch.object(Session, "prepare", lambda s: self.fail_policy(s)):
                with self.assertRaises(RequestRejected):
                    list(session.request(returning))
        self.pool.close()
        self.pool = self.new_pool()
        self.assert_resumable(original, returning)


if __name__ == "__main__":
    unittest.main()


class ForeignThinking(unittest.TestCase):
    def test_only_older_foreign_thinking_is_omitted(self):
        from native_history import without_foreign_thinking
        own_turn = {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "mine", "signature": "relay"},
            {"type": "text", "text": "a"}]}
        foreign = {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "theirs", "signature": "other-org"},
            {"type": "redacted_thinking", "data": "x"},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}
        only_thinking = {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "alone", "signature": "other-org"}]}
        last = {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "latest", "signature": "other-org"},
            {"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}]}
        messages = [{"role": "user", "content": [{"type": "text", "text": "q"}]}, own_turn,
                    {"role": "user", "content": [{"type": "text", "text": "q2"}]}, foreign,
                    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": []}]},
                    only_thinking, {"role": "user", "content": [{"type": "text", "text": "q3"}]}, last]
        own = {signature(own_turn)}
        result = without_foreign_thinking(copy.deepcopy(messages), own, signature)
        self.assertEqual(result[1], own_turn)
        self.assertEqual([b["type"] for b in result[3]["content"]], ["tool_use"])
        self.assertEqual(result[5], only_thinking)  # never emptied
        self.assertEqual(result[7], last)  # a tool loop needs the latest thinking
        self.assertEqual(len(result), len(messages))
        plain_last = {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "latest", "signature": "other-org"},
            {"type": "text", "text": "done"}]}
        tail = without_foreign_thinking(copy.deepcopy(messages[:-1] + [plain_last]), own, signature)
        self.assertEqual([b["type"] for b in tail[-1]["content"]], ["text"])
        self.assertEqual(messages[3], foreign)  # caller input untouched

    def test_cross_account_import_writes_transcript_without_foreign_signatures(self):
        import native_bridge_session as native
        fixture = CrossAccountSwitch("test_policy_sync_exit_on_return_keeps_tool_checkpoint")
        fixture.setUp()
        try:
            original, history = fixture.tool_turn()
            returning = fixture.returning_body(history)
            # After our tool result: a foreign plain turn, then the foreign tool turn.
            at = len(history) + 1
            returning["messages"][at:at] = [
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "foreign", "signature": "sig-foreign"},
                    {"type": "text", "text": "noted"}]},
                {"role": "user", "content": "more"}]
            written = []
            real = native.write_transcript

            def capture(profile, directory, native_id, messages, initial_effort=None):
                written.append(copy.deepcopy(messages))
                return real(profile, directory, native_id, messages, initial_effort)

            with fixture.pool.lease("tenant-a", returning) as session:
                with patch.object(native, "write_transcript", capture), \
                     patch.object(Session, "prepare", lambda s: fixture.fail_policy(s)):
                    with self.assertRaises(RequestRejected):
                        list(session.request(returning))
            self.assertEqual(len(written), 1)
            sigs = [b.get("signature") for m in written[0] if m["role"] == "assistant"
                    for b in m["content"] if b["type"] == "thinking"]
            self.assertIn("sig-a", sigs)          # this relay's own turn is kept
            self.assertNotIn("sig-foreign", sigs)  # older foreign turn omitted
            self.assertIn("sig-b", sigs)          # latest assistant keeps its thinking
        finally:
            fixture.tearDown()


class GuardDeniedRetry(unittest.TestCase):
    def make(self, details, denied):
        from native_bridge_session import NativeRateLimit
        session = Session.__new__(Session)
        session.dispatch_close_observation = {"upstream_attempts": 1, "denied": denied}
        error = NativeRateLimit("opus")
        error.details.update(details)
        return session, error

    def test_guard_denial_without_provider_window_is_not_a_rate_limit(self):
        session, error = self.make({}, 1)
        self.assertTrue(session.guard_denied_retry(error))

    def test_real_provider_window_stays_a_rate_limit(self):
        for details in ({"reset_at": 1795076400}, {"api_error": "usage_limit_reached"},
                        {"rate_limit_type": "five_hour"}):
            session, error = self.make(details, 1)
            self.assertFalse(session.guard_denied_retry(error))
        session, error = self.make({}, 0)
        self.assertFalse(session.guard_denied_retry(error))


class LaunchRetry(unittest.TestCase):
    def test_sync_exit_relaunches_once_then_reports(self):
        fixture = CrossAccountSwitch("test_policy_sync_exit_on_return_keeps_tool_checkpoint")
        fixture.setUp()
        try:
            launches = []
            with fixture.pool.lease("tenant-a", fixture.body) as session:
                def launch(s):
                    launches.append(1)
                    fixture.fail_policy(s)
                with patch.object(Session, "launch", launch), \
                     patch("native_bridge_session.time.sleep", lambda _: None):
                    with self.assertRaisesRegex(RequestRejected, "native_policy_not_ready_no_dispatch"):
                        list(session.request(fixture.body))
                self.assertEqual(len(launches), 2)
                self.assertFalse(session.failed)

                fixture.stats = {"upstream_attempts": 1, "denied": 0, "requests": 1}
                launches.clear()
                session.process = session.dispatch_process = None
                with patch.object(Session, "launch", launch):
                    with self.assertRaises(ContractError):
                        session.prepare()
                self.assertEqual(len(launches), 1)  # a dispatched attempt is never relaunched
        finally:
            fixture.tearDown()

    def test_second_launch_success_is_used(self):
        fixture = CrossAccountSwitch("test_policy_sync_exit_on_return_keeps_tool_checkpoint")
        fixture.setUp()
        try:
            launches = []
            with fixture.pool.lease("tenant-a", fixture.body) as session:
                def launch(s):
                    launches.append(1)
                    if len(launches) == 1:
                        fixture.fail_policy(s)
                    s.process = Process(running=True)
                with patch.object(Session, "launch", launch), \
                     patch("native_bridge_session.time.sleep", lambda _: None):
                    session.prepare()
                self.assertEqual(len(launches), 2)
                self.assertIsNotNone(session.process)
                session.process.code = 0
        finally:
            fixture.tearDown()
