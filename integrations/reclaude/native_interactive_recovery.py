"""Local-only reconstruction of a completed API turn's pending MCP wait.

Reconstruction must match the saved provider request before serving its saved
response. It cannot reach the provider or create a dispatch receipt. A mismatch
is a recovery failure, not permission to repeat an inference request.
"""

import copy
import hashlib
import http.client
import http.server
import json
import os
import re
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit


class RecoveryError(ValueError):
    pass


def bounded_bytes(path, limit):
    with Path(path).open("rb") as stream:
        if os.fstat(stream.fileno()).st_size > limit:
            raise RecoveryError("recovery_evidence_limit")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise RecoveryError("recovery_evidence_limit")
    return data


def caller_tool_event(event, tools):
    if event.get("type") != "content_block_start":
        return event
    block = event.get("content_block", {})
    if block.get("name") in {"mcp__caller__" + t["name"] for t in tools}:
        return event
    if block.get("type") != "tool_use" or block.get("name") not in {
        t["name"] for t in tools
    }:
        return event
    event = copy.deepcopy(event)
    event["content_block"]["name"] = "mcp__caller__" + block["name"]
    return event


def caller_tool_stream(stream, tools):
    out = []
    for line in stream.splitlines(keepends=True):
        if line.startswith(b"data:"):
            event = json.loads(line[5:])
            mapped = caller_tool_event(event, tools)
            if mapped != event:
                line = b"data: " + json.dumps(mapped).encode() + b"\n"
        out.append(line)
    return b"".join(out)


def private_json(path, value):
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    with os.fdopen(
        os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w"
    ) as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def semantic_request(body, session_id):
    if not isinstance(body, dict) or not isinstance(body.get("metadata"), dict):
        raise RecoveryError("recovery_invalid_request")
    value = copy.deepcopy(body)
    metadata = value.get("metadata", {})
    try:
        identity = json.loads(metadata["user_id"])
        if identity["session_id"] != session_id:
            raise RecoveryError("recovery_identity_mismatch")
    except (KeyError, ValueError, TypeError):
        raise RecoveryError("recovery_identity_mismatch") from None
    # Compare parsed identity so JSON formatting is immaterial. Do not drop
    # device/account identity, other metadata, or any inference controls.
    metadata["user_id"] = identity
    return value


def load_steps(directory, plan, session_id):
    import native_bridge_session as native

    if not isinstance(plan, dict) or not isinstance(plan.get("steps"), list):
        raise RecoveryError("recovery_plan_invalid")
    if (
        plan.get("version") != 1
        or plan.get("native_id") != session_id
        or not 1 <= len(plan.get("steps", [])) <= 64
    ):
        raise RecoveryError("recovery_plan_invalid")
    steps = []
    total_bytes = 0
    for item in plan["steps"]:
        if not isinstance(item, dict):
            raise RecoveryError("recovery_plan_invalid")
        grant = item["grant_id"]
        if str(uuid.UUID(grant)) != grant:
            raise RecoveryError("recovery_grant_invalid")
        root = Path(directory) / "dispatch"
        receipt = json.loads(
            bounded_bytes(root / (grant + ".api-terminal.json"), 65536)
        )
        if (
            receipt.get("grant_id") != grant
            or receipt.get("status") != 200
            or receipt.get("complete") is not True
        ):
            raise RecoveryError("recovery_terminal_missing")
        stream = bounded_bytes(
            root / (grant + ".api-stream.private"), 64 * 1024 * 1024 - total_bytes
        )
        total_bytes += len(stream)
        if receipt.get("bytes") != len(stream):
            raise RecoveryError("recovery_stream_size_mismatch")
        request_bytes = bounded_bytes(
            root / (grant + ".api-request.private.json"),
            min(16 * 1024 * 1024, 64 * 1024 * 1024 - total_bytes),
        )
        total_bytes += len(request_bytes)
        consumed = json.loads(bounded_bytes(root / (grant + ".consumed.json"), 65536))
        if consumed.get("body_sha256") != hashlib.sha256(request_bytes).hexdigest():
            raise RecoveryError("recovery_request_digest_mismatch")
        request = json.loads(request_bytes)
        expected = semantic_request(request, session_id)
        turn = native.Turn([t["name"] for t in plan["tools"]])
        kinds = []
        for frame in re.split(rb"\r?\n\r?\n", stream):
            payload = b"\n".join(
                line[5:].lstrip()
                for line in frame.splitlines()
                if line.startswith(b"data:")
            )
            if payload:
                event = json.loads(payload)
                kinds.append(event.get("type"))
                turn.event(caller_tool_event(event, plan["tools"]))
        if (
            not kinds
            or kinds[-1] != "message_stop"
            or kinds.count("message_stop") != 1
            or turn.message.get("stop_reason") != "tool_use"
            or native.signature(turn.message["content"]) != item["assistant_sha256"]
        ):
            raise RecoveryError("recovery_tool_terminal_mismatch")
        steps.append(
            {
                **item,
                "expected": expected,
                "stream": caller_tool_stream(stream, plan["tools"]),
                "pending": [
                    b for b in turn.message["content"] if b.get("type") == "tool_use"
                ],
            }
        )
    return steps


class RecoveryGate(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, target, session_id, steps):
        super().__init__(("127.0.0.1", 0), RecoveryHandler)
        self.target, self.session_id, self.steps = target, session_id, steps
        self.lock = threading.Lock()
        self.index, self.live, self.error = 0, False, None
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def activate(self):
        with self.lock:
            if self.error or self.index != len(self.steps):
                raise RecoveryError("recovery_not_complete")
            self.live = True

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)


class RecoveryHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def answer(self, status, data, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        try:
            size = int(self.headers.get("Content-Length", 0))
            if (
                self.headers.get("Transfer-Encoding")
                or not 0 <= size <= 16 * 1024 * 1024
            ):
                raise RecoveryError("recovery_body_limit")
            data = self.rfile.read(size)
            if len(data) != size:
                raise RecoveryError("recovery_body_incomplete")
            with self.server.lock:
                if not self.server.live:
                    if (
                        self.command != "POST"
                        or urlsplit(self.path).path != "/v1/messages"
                        or self.server.index >= len(self.server.steps)
                    ):
                        raise RecoveryError("recovery_unexpected_request")
                    step = self.server.steps[self.server.index]
                    if (
                        semantic_request(json.loads(data), self.server.session_id)
                        != step["expected"]
                    ):
                        raise RecoveryError("recovery_request_changed")
                    self.server.index += 1
                    self.answer(200, step["stream"], "text/event-stream")
                    return
            target = urlsplit(self.server.target)
            conn = http.client.HTTPConnection(target.hostname, target.port, timeout=370)
            try:
                headers = {
                    k: v
                    for k, v in self.headers.items()
                    if k.lower() not in {"host", "connection", "content-length"}
                }
                conn.request(self.command, self.path, data, headers)
                response = conn.getresponse()
                self.send_response(response.status)
                for key, val in response.getheaders():
                    if key.lower() not in {
                        "connection",
                        "content-length",
                        "transfer-encoding",
                    }:
                        self.send_header(key, val)
                self.send_header("Connection", "close")
                self.end_headers()
                while block := response.read1(65536):
                    self.wfile.write(block)
                    self.wfile.flush()
                self.close_connection = True
            finally:
                conn.close()
        except (RecoveryError, ValueError, KeyError, TypeError) as exc:
            with self.server.lock:
                self.server.error = (
                    str(exc)
                    if isinstance(exc, RecoveryError)
                    else "recovery_invalid_request"
                )
            self.answer(
                400,
                b'{"type":"error","error":{"type":"invalid_request_error","message":"local recovery rejected; no upstream dispatch"}}',
            )
