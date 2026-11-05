"""Synthetic CLI and dispatch health only; no provider or production access."""
import copy
import http.client
import io
import json
import sys
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
import uuid

from native_bridge_session import ContractError, RequestRejected, Session
from native_session_pool import SessionPool


class Process:
    def __init__(self, writer=None, running=False):
        self.stdin, self.stdout = writer, None
        self.code = None if running else 0

    def poll(self):
        return self.code

    def terminate(self):
        self.code = 0

    def wait(self, timeout=None):
        self.code = 0


class Writer(io.StringIO):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback

    def write(self, text):
        self.callback(json.loads(text))
        return super().write(text)


class InitializationRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.body = {"model": "fixture", "max_tokens": 64, "system": "owner context",
                     "metadata": {"user_id": str(uuid.uuid4())},
                     "messages": [{"role": "user", "content": "first input"}]}
        self.stats = {"upstream_attempts": 0, "denied": 0, "requests": 0}
        self.inputs, self.sessions = [], []
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
        self.pool = SessionPool(self.root / "pool", self.factory, recover=self.factory,
                                allow_history_import=True)

    def tearDown(self):
        self.pool.close()
        for session in self.sessions:
            session.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def factory(self, directory, body):
        session = Session(directory, ["synthetic-cli"], {}, body, timeout=.01,
                          require_policy=True, dispatch_proxy="synthetic-proxy", restore=True,
                          history_profile=self.root / "profile")
        self.sessions.append(session)
        return session

    def proxy(self, session):
        directory = session.directory / "dispatch"
        directory.mkdir(exist_ok=True)
        session.dispatch_process = Process()
        session.dispatch_address = "http://%s:%s" % self.server.server_address
        (directory / "ready.safe.json").write_text(json.dumps({
            "session_id": session.native_id, "listen": "%s:%s" % self.server.server_address}))

    def fail_initialize(self, session):
        self.proxy(session)
        session.process = Process(Writer(self.inputs.append))
        session.initialize_native()

    def succeed(self, session):
        self.proxy(session)
        session.dispatch_process.code = None

        def receive(message):
            self.inputs.append(message)
            if message["type"] != "user":
                return
            grant = json.loads((session.directory / "dispatch/grant.json").read_text())
            (session.directory / "dispatch" / (grant["id"] + ".consumed.json")).write_text("{}")
            session.assistants["msg_fixture"] = str(uuid.uuid4())
            events = [
                {"type": "message_start", "message": {"id": "msg_fixture", "role": "assistant",
                 "model": "fixture", "content": [], "usage": {"input_tokens": 1, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "new input"}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}},
                {"type": "message_stop"},
            ]
            for event in events:
                session.events.put(event)

        session.process = Process(Writer(receive), running=True)

    def fail_initialization_request(self, body=None):
        with self.pool.lease("tenant-A", body or self.body) as session:
            with patch.object(Session, "prepare", lambda s: self.fail_initialize(s)):
                with self.assertRaisesRegex(ContractError, "native_initialize_not_ready_no_dispatch"):
                    list(session.request(body or self.body))
        return session

    def test_failed_initialize_preserves_unconsumed_boundary_for_next_customer_request(self):
        first = self.fail_initialization_request()
        saved = json.loads((first.directory / "continuation.json").read_text())
        self.assertEqual(saved["status"], "prepared")
        self.assertFalse(first.failed)
        self.assertEqual(self.pool.snapshot()["resident"], 0)
        self.assertEqual([x["type"] for x in self.inputs], ["control_request"])
        follow = copy.deepcopy(self.body)
        follow["messages"][0]["content"] = "genuinely new customer request"
        with self.pool.lease("tenant-A", follow) as recovered:
            self.assertNotEqual(recovered.native_id, first.native_id)
            with patch.object(Session, "prepare", lambda s: self.succeed(s)):
                self.assertEqual(list(recovered.request(follow))[-1]["type"], "message_stop")
            consumed = list((recovered.directory / "dispatch").glob("*.consumed.json"))
            self.assertEqual(len(consumed), 1)
            with self.assertRaisesRegex(ContractError, "request_already_consumed"):
                list(recovered.request(follow))
            self.assertEqual(len(list((recovered.directory / "dispatch").glob("*.consumed.json"))), 1)
            recovered.process.code = recovered.dispatch_process.code = 0
        self.assertEqual(sum(x["type"] == "user" for x in self.inputs), 1)

    def test_imported_caller_context_is_rebuilt_only_by_the_next_request(self):
        body = copy.deepcopy(self.body)
        body["messages"] = [{"role": "user", "content": "earlier"},
                            {"role": "assistant", "content": "complete answer"},
                            {"role": "user", "content": "new turn"}]
        first = self.fail_initialization_request(body)
        self.assertEqual(json.loads((first.directory / "continuation.json").read_text())["status"], "prepared")
        with self.pool.lease("tenant-A", body) as recovered:
            self.assertEqual(recovered.history, [])
            self.assertIsNone(recovered.resume_uuid)
            self.assertNotEqual(recovered.native_id, first.native_id)
        self.assertFalse(any(x["type"] == "user" for x in self.inputs))

    def test_existing_paid_boundaries_survive_new_cli_initialization_failure(self):
        for pending in [False, True]:
            with self.subTest(pending=pending):
                resident_before = self.pool.snapshot()["resident"]
                self.body["metadata"]["user_id"] = str(uuid.uuid4())
                with self.pool.lease("tenant-A", self.body) as session:
                    reply = [{"type": "tool_use", "id": "tool_old", "name": "Read", "input": {}}] if pending else [{"type": "text", "text": "delivered answer"}]
                    session.history = self.body["messages"] + [{"role": "assistant", "content": reply}]
                    session.assistants["msg_old"] = str(uuid.uuid4())
                    session.checkpoint("awaiting_tools" if pending else "idle", "paid-request", "msg_old")
                    session.seen = {"paid-request"}
                    session.pending_ids = {"tool_old"} if pending else set()
                    session.suspended = pending
                    d = session.directory / "dispatch"
                    d.mkdir()
                    for i in range(11):
                        (d / (str(i) + ".consumed.json")).write_text("paid evidence " + str(i))
                    (d / "grant.json").write_text("old consumed grant")
                    evidence = {f.name: f.read_bytes() for f in d.iterdir()}
                    checkpoint = (session.directory / "continuation.json").read_bytes()
                    native_id = session.native_id
                    follow = {**self.body, "messages": copy.deepcopy(session.history) + [{
                        "role": "user", "content": [{"type": "tool_result", "tool_use_id": "tool_old", "content": "new result"}] if pending else "new customer turn"}]}
                    with patch.object(Session, "prepare", lambda s: self.fail_initialize(s)):
                        with self.assertRaisesRegex(RequestRejected, "native_initialize_not_ready_no_dispatch"):
                            list(session.request(follow))
                    self.assertFalse(session.failed)
                    self.assertEqual(session.seen, {"paid-request"})
                    self.assertEqual((session.directory / "continuation.json").read_bytes(), checkpoint)
                    self.assertEqual(session.native_id, native_id)
                    self.assertEqual({f.name: f.read_bytes() for f in d.iterdir() if f.name in evidence}, evidence)
                    self.assertFalse(list(session.directory.glob("*.result.json")))
                self.assertEqual(self.pool.snapshot()["resident"], resident_before)
                with self.pool.lease("tenant-A", follow) as recovered:
                    self.assertEqual(recovered.native_id, native_id)
                    self.assertEqual(recovered.pending_ids, {"tool_old"} if pending else set())
                    self.assertEqual(recovered.seen, {"paid-request"})

    def test_checkpoint_or_grant_change_during_initialize_prevents_recovery(self):
        for kind in ["checkpoint", "grant", "consumed"]:
            self.body["metadata"]["user_id"] = str(uuid.uuid4())
            original = self.fail_initialize

            def changed(session):
                if kind == "checkpoint":
                    session.checkpoint("in_flight")
                else:
                    d = session.directory / "dispatch"
                    d.mkdir(exist_ok=True)
                    (d / ("grant.json" if kind == "grant" else "unexpected.consumed.json")).write_text("keep")
                original(session)

            with self.pool.lease("tenant-A", self.body) as session:
                with patch.object(Session, "prepare", changed):
                    with self.assertRaises(ContractError):
                        list(session.request(self.body))
            self.assertTrue(session.failed)
            self.assertEqual(json.loads((session.directory / "continuation.json").read_text())["status"], "failed")

    def test_http_handler_keeps_retryable_initialization_distinct_from_paid_failure(self):
        from adapter import Limits
        from native_http import NativeServer

        class Health:
            def failed_health_checks(self):
                return []

            def authorization_revoked(self):
                return False

        server = NativeServer(("127.0.0.1", 0), Health(), "k" * 40, self.root / "http",
                              self.factory, recover=self.factory,
                              limits=Limits(models=("fixture",), concurrency=2), allow_history_import=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for prepare, expected in [(self.fail_initialize, 503), (self.succeed, 200)]:
                body = copy.deepcopy(self.body)
                body["messages"][0]["content"] = "new caller input " + str(expected)
                with patch.object(Session, "prepare", lambda s: prepare(s)):
                    conn = http.client.HTTPConnection(*server.server_address, timeout=5)
                    conn.request("POST", "/v1/messages", json.dumps(body), {
                        "Authorization": "Bearer " + "k" * 40, "Content-Type": "application/json"})
                    response = conn.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                    conn.close()
            rows = [json.loads(l) for l in (self.root / "http/audit.jsonl").read_text().splitlines()]
            self.assertEqual([r["attempts"] for r in rows], [0, 1])
            self.assertEqual([r["status"] for r in rows], [503, 200])
            self.assertEqual(sum(x["type"] == "user" for x in self.inputs), 1)
        finally:
            for session in self.sessions:
                if session.process:
                    session.process.code = 0
                if session.dispatch_process:
                    session.dispatch_process.code = 0
            server.shutdown()
            server.server_close()
            thread.join()

    def test_prewarm_failure_is_retired_without_sending_a_user_turn(self):
        with self.pool.lease("tenant-A", self.body) as session:
            with patch.object(Session, "prepare", lambda s: self.fail_initialize(s)):
                with self.assertRaisesRegex(RequestRejected, "native_initialize_not_ready_no_dispatch"):
                    session.prepare_request(self.body)
            self.assertFalse(session.failed)
        self.assertEqual(self.pool.snapshot()["resident"], 0)
        self.assertFalse(any(x["type"] == "user" for x in self.inputs))

    def test_actual_child_initialize_error_has_no_user_input_and_is_stopped(self):
        child = self.root / "child.py"
        child.write_text("import json,sys,pathlib\nfor line in sys.stdin:\n m=json.loads(line)\n pathlib.Path('received.jsonl').open('a').write(line)\n if m['type']=='control_request':\n  print(json.dumps({'type':'control_response','response':{'subtype':'error','request_id':m['request_id'],'error':'synthetic configuration timeout'}}),flush=True)\n")
        with self.pool.lease("tenant-A", self.body) as session:
            session.command = [sys.executable, str(child)]
            session.timeout = 2
            session.personal_max_profile = self.root / "profile"
            with patch.object(Session, "start_dispatch_proxy", lambda s: self.proxy(s)):
                with self.assertRaisesRegex(RequestRejected, "native_initialize_not_ready_no_dispatch"):
                    list(session.request(self.body))
            received = [json.loads(l) for l in (session.directory / "received.jsonl").read_text().splitlines()]
            self.assertEqual([r["type"] for r in received], ["control_request"])
            self.assertIsNotNone(session.process.poll())
            self.assertFalse(session.failed)
        self.assertEqual(self.pool.snapshot()["resident"], 0)

    def test_completed_caller_history_advance_preserves_prior_paid_checkpoint(self):
        with self.pool.lease("tenant-A", self.body) as session:
            session.history = self.body["messages"] + [{"role": "assistant", "content": "delivered"}]
            session.assistants["msg_old"] = str(uuid.uuid4())
            session.checkpoint("idle", "paid-request", "msg_old")
            session.seen = {"paid-request"}
            original_id = session.native_id
            saved = (session.directory / "continuation.json").read_bytes()
            d = session.directory / "dispatch"
            d.mkdir()
            (d / "old.consumed.json").write_text("paid evidence")
            follow = {**self.body, "messages": copy.deepcopy(session.history) + [
                {"role": "user", "content": "completed elsewhere"},
                {"role": "assistant", "content": "caller-owned complete reply"},
                {"role": "user", "content": "new request"}]}
            with patch.object(Session, "prepare", lambda s: self.fail_initialize(s)):
                with self.assertRaisesRegex(RequestRejected, "native_initialize_not_ready_no_dispatch"):
                    list(session.request(follow))
            self.assertEqual(session.native_id, original_id)
            self.assertEqual(session.seen, {"paid-request"})
            self.assertEqual((session.directory / "continuation.json").read_bytes(), saved)
            self.assertEqual((d / "old.consumed.json").read_text(), "paid evidence")

    def test_unknown_or_nonzero_dispatch_observation_never_becomes_prepared(self):
        for stats in [{}, {"upstream_attempts": 1, "denied": 0},
                      {"upstream_attempts": 0, "denied": 1},
                      {"upstream_attempts": False, "denied": 0}]:
            with self.subTest(stats=stats):
                self.body["metadata"]["user_id"] = str(uuid.uuid4())
                self.stats = stats
                failed = self.fail_initialization_request()
                self.assertTrue(failed.failed)
                self.assertEqual(json.loads((failed.directory / "continuation.json").read_text())["status"], "failed")

    def test_existing_grant_or_consumed_marker_is_never_removed_or_recovered(self):
        for name in ["grant.json", "paid.consumed.json"]:
            self.body["metadata"]["user_id"] = str(uuid.uuid4())
            original = self.fail_initialize

            def fail_with_evidence(session):
                self.proxy(session)
                (session.directory / "dispatch" / name).write_text("protected")
                original(session)

            with self.pool.lease("tenant-A", self.body) as session:
                with patch.object(Session, "prepare", fail_with_evidence):
                    with self.assertRaises(ContractError):
                        list(session.request(self.body))
            self.assertTrue(session.failed)
            self.assertEqual((session.directory / "dispatch" / name).read_text(), "protected")

    def test_legacy_failed_checkpoint_cannot_be_automatically_migrated(self):
        with self.pool.lease("tenant-A", self.body) as session:
            session.checkpoint("failed")
        self.pool.close()
        with self.assertRaisesRegex(ContractError, "incomplete_no_replay"):
            self.factory(session.directory, self.body)

    def test_other_tenant_never_inherits_recoverable_state(self):
        first = self.fail_initialization_request()
        with self.pool.lease("tenant-B", self.body) as other:
            self.assertNotEqual(other.directory, first.directory)
            self.assertNotEqual(other.native_id, first.native_id)
            self.assertFalse(other.prepared)
