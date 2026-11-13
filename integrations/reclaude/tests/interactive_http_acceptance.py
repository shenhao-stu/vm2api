"""Network-isolated real CLI/API tests. Fixture usage never enters a real ledger."""

import copy
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapter import Limits
from native_api_http import APIHandler, initialize_api_profile
from native_http import NativeServer
from native_interactive_session import InteractiveSession


class OfflineHealth:
    def failed_health_checks(self):
        return []

    def authorization_revoked(self):
        return False


class Harness:
    def __init__(self, root, cli):
        self.root, self.cli = root, cli
        self.profile = initialize_api_profile(root / "home")
        self.gateway, self.client = "g" * 40, "c" * 40
        self.created = []
        self.start()

    def factory(self, path, body):
        env = {
            "HOME": str(self.root / "home"),
            "CLAUDE_CONFIG_DIR": str(self.profile),
            "PATH": os.environ["PATH"],
            "ANTHROPIC_API_KEY": "sk-offline-fixture-no-money",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
        }
        session = InteractiveSession(
            path,
            [self.cli, "--setting-sources", ""],
            env,
            body,
            timeout=20,
            dispatch_proxy=Path(__file__).with_name("interactive_fixture_guard.py"),
            api_base="https://offline.invalid",
            history_profile=self.profile,
            restore=True,
        )
        self.created.append(session)
        return session

    def start(self):
        self.server = NativeServer(
            ("127.0.0.1", 0),
            OfflineHealth(),
            self.gateway,
            self.root / "state",
            self.factory,
            limits=Limits(
                models=("claude-opus-5-5",), concurrency=4, request_seconds=40
            ),
            recover=self.factory,
            allow_history_import=True,
            configuration_channels=True,
            require_principal=True,
        )
        self.server.client_key = self.client
        self.server.RequestHandlerClass = APIHandler
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def request(self, body, principal="a" * 64, client=False, disconnect=False):
        c = http.client.HTTPConnection(*self.server.server_address, timeout=45)
        c.request(
            "POST",
            "/v1/messages",
            json.dumps(body),
            {
                "Authorization": "Bearer " + (self.client if client else self.gateway),
                "X-Native-Relay-Principal": principal,
                "Content-Type": "application/json",
            },
        )
        r = c.getresponse()
        if disconnect:
            r.read(32)
            c.close()
            return r.status, None
        raw = r.read()
        c.close()
        return r.status, raw if body.get("stream") else json.loads(raw)

    def audit(self):
        return [
            json.loads(l)
            for l in (self.root / "state/audit.jsonl").read_text().splitlines()
            if json.loads(l).get("operation") == "messages"
        ]

    def dispatches(self):
        return len(list((self.root / "state").rglob("*.consumed.json")))

    def idle(self):
        deadline = time.monotonic() + 30
        while self.server.active_requests and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not self.server.active_requests


def body(sid=None, text="Isolated synthetic call."):
    return {
        "model": "claude-opus-5-5",
        "max_tokens": 128,
        "stream": False,
        "metadata": {"user_id": str(sid or uuid.uuid4())},
        "system": "Use echo once then respond.",
        "tools": [
            {
                "name": "echo",
                "description": "Echo on caller only.",
                "input_schema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
            }
        ],
        "messages": [{"role": "user", "content": text}],
    }


def follow(request, reply, text="Continue synthetic conversation."):
    result = copy.deepcopy(request)
    result["messages"].append({"role": "assistant", "content": reply["content"]})
    tools = [b for b in reply["content"] if b["type"] == "tool_use"]
    content = [
        {"type": "tool_result", "tool_use_id": b["id"], "content": "SYNTHETIC"}
        for b in tools
    ] or text
    result["messages"].append({"role": "user", "content": content})
    return result


def run(root, cli):
    h = Harness(root, cli)
    checks = []

    def success(request, **kwargs):
        status, reply = h.request(request, **kwargs)
        assert status == 200, (status, reply)
        assert reply["usage"] == {
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        }, reply
        return reply

    try:
        parent = body()
        first = success(parent)
        after = h.dispatches()
        assert h.request(parent)[0] == 400 and h.dispatches() == after
        checks.append("duplicate_zero_dispatch")
        continuation = follow(parent, first)
        reminder = "<system-reminder>OFFLINE_AGENT_RESULT</system-reminder>"
        continuation["messages"][-1]["content"].append({"type": "text", "text": reminder})
        wrong = copy.deepcopy(continuation)
        wrong["messages"][-1]["content"][0]["tool_use_id"] = "another_session_tool"
        assert h.request(wrong)[0] == 400 and h.dispatches() == after
        # Invalid input must not destroy the valid waiting parent.
        assert not h.created[0].failed, "bad tool result poisoned pending session"
        checks.append("bad_tool_result_preserves_parent")
        child = body(text="Isolated child synthetic call.")
        child_first = success(child)
        child_done = success(follow(child, child_first))
        assert child_done["stop_reason"] == "end_turn"
        foreign = success(parent, principal="b" * 64)
        dedicated = success(parent, client=True, principal="a" * 64)
        assert (
            len(
                {
                    first["content"][0]["id"],
                    foreign["content"][0]["id"],
                    dedicated["content"][0]["id"],
                }
            )
            == 3
        )
        checks.append("child_and_three_tenant_isolation")
        before = h.dispatches()
        h.close()
        h.start()
        result = success(continuation)
        success(follow(parent, foreign), principal="b" * 64)
        success(follow(parent, dedicated), client=True, principal="f" * 64)
        assert h.dispatches() == before + 3
        native_requests = [json.loads(p.read_text())
                           for p in (root / "state").rglob("*.api-request.private.json")]
        matches = [b for request in native_requests for m in request["messages"] if m["role"] == "user"
                   and isinstance(m["content"], list) for b in m["content"] if b.get("text") == reminder]
        assert matches == [{"type": "text", "text": reminder}]
        checks.append("http_restart_pending_isolated_three_tenants")
        next_turn = follow(continuation, result, "FIXTURE_DELAY: independent follow-up")
        before = h.dispatches()
        with ThreadPoolExecutor(2) as pool:
            replies = list(pool.map(lambda _: h.request(next_turn), range(2)))
        assert sum(s == 200 for s, _ in replies) == 1, replies
        assert all(s in (200, 400, 429) for s, _ in replies)
        assert h.dispatches() == before + 1
        checks.append("concurrent_duplicate_single_dispatch")
        ok = next(r for s, r in replies if s == 200)
        next_turn = follow(next_turn, ok)
        stream = {**next_turn, "stream": True}
        before = h.dispatches()
        assert h.request(stream, disconnect=True)[0] == 200
        h.idle()
        rows = h.audit()
        latest = rows[-1]
        assert latest["complete"] and latest["usage"]["output_tokens"] == 5, latest
        assert h.dispatches() == before + 1
        assert h.request(stream)[0] == 400 and h.dispatches() == before + 1
        checks.append("disconnect_terminal_usage_preserved_no_retry")
        partial = body(text="FIXTURE_PARTIAL_TERMINAL")
        before = h.dispatches()
        status, _ = h.request(partial)
        assert status == 400 and h.dispatches() == before + 1
        assert h.request(partial)[0] == 400 and h.dispatches() == before + 1
        assert not h.audit()[-2]["complete"]
        checks.append("missing_terminal_no_fabrication_no_redispatch")
        rows = h.audit()
        assert sum(r["attempts"] for r in rows) == h.dispatches()
        assert all(not r.get("usage") for r in rows if r["attempts"] == 0)
        checks.append("per_request_attempts_and_usage_reconciled")
        return {
            "checks": checks,
            "requests": len(rows),
            "dispatches": h.dispatches(),
            "local_recoveries": len(
                list((root / "state").rglob("recovery-*/result.safe.json"))
            ),
            "real_provider_calls": 0,
            "fixture_usage_only": True,
        }
    finally:
        h.close()


if __name__ == "__main__":
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="airoam-http-isolation-") as tmp:
        print(json.dumps(run(Path(tmp), sys.argv[1])))
