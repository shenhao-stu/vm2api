#!/usr/bin/env python3
"""Offline fake provider; synthetic numbers must never enter a customer ledger."""

import argparse, hashlib, http.server, json, os, pathlib, sys, time, uuid

p = argparse.ArgumentParser()
p.add_argument("--directory", type=pathlib.Path)
p.add_argument("--session")
p.add_argument("--listen")
p.add_argument("--api-base")
a = p.parse_args()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        b = json.dumps(
            {
                "upstream_attempts": len(list(a.directory.glob("*.consumed.json"))),
                "denied": 0,
            }
        ).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        try:
            g = json.loads((a.directory / "grant.json").read_text())
            assert json.loads(body["metadata"]["user_id"])["session_id"] == a.session
            assert g["model"] == body["model"]
            assert os.environ.get("FIXTURE_AGENT_MODE") or any(
                t.get("name") == "mcp__caller__echo" for t in body.get("tools", [])
            ), "caller tools absent"
            with (a.directory / (g["id"] + ".consumed.json")).open("x") as f:
                json.dump({**g, "body_sha256": hashlib.sha256(raw).hexdigest()}, f)
        except Exception:
            self.send_error(400)
            return
        (a.directory / (g["id"] + ".request.private.json")).write_bytes(raw)
        (a.directory / (g["id"] + ".api-request.private.json")).write_bytes(raw)
        tool_count = sum(b.get("type") == "tool_use" for m in body["messages"]
                         if m["role"] == "assistant" and isinstance(m.get("content"), list)
                         for b in m["content"])
        tool_name = "Agent" if os.environ.get("FIXTURE_AGENT_MODE") else "echo"
        tool = tool_count < int(os.environ.get("FIXTURE_TOOL_TURNS", "1")) and any(
            t.get("name") == "mcp__caller__" + tool_name for t in body.get("tools", [])
        )
        tool_input = {"subagent_type": "probe", "description": "Isolated child check",
                      "prompt": "Return OFFLINE_CHILD_OK only."} if tool_name == "Agent" else {"text": "SYNTHETIC"}
        mid = "msg_" + uuid.uuid4().hex
        events = [
            {
                "type": "message_start",
                "message": {
                    "id": mid,
                    "type": "message",
                    "role": "assistant",
                    "model": body["model"],
                    "content": [],
                    "stop_reason": None,
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 0,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0,
                    },
                },
            },
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_fixture_" + a.session + "_" + str(tool_count),
                    "name": tool_name if os.environ.get("FIXTURE_RAW_TOOL_NAMES") else "mcp__caller__" + tool_name,
                    "input": {},
                }
                if tool
                else {"type": "text", "text": ""},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": json.dumps(tool_input),
                }
                if tool
                else {"type": "text_delta", "text": "OFFLINE_CHILD_OK" if tool_name == "Agent" else "INTERACTIVE_OK"},
            },
            {"type": "content_block_stop", "index": 0},
            {
                "type": "message_delta",
                "delta": {
                    "stop_reason": "tool_use" if tool else "end_turn",
                    "stop_sequence": None,
                },
                "usage": {"output_tokens": 5},
            },
            {"type": "message_stop"},
        ]
        if "FIXTURE_PARTIAL_TERMINAL" in json.dumps(body["messages"]):
            events = events[:-1]
        # Gives concurrent HTTP tests a deterministic in-flight overlap.
        if "FIXTURE_DELAY" in json.dumps(body["messages"]):
            time.sleep(0.5)
        data = b"".join(
            ("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n").encode()
            for e in events
        )
        with (a.directory / (g["id"] + ".api-stream.private")).open("xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        (a.directory / (g["id"] + ".api-terminal.json")).write_text(
            json.dumps({"grant_id": g["id"], "status": 200, "complete": True, "bytes": len(data)})
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        if os.environ.get("FIXTURE_RAW_TOOL_NAMES"):
            sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
            from native_interactive_recovery import caller_tool_stream
            data = caller_tool_stream(data, [{"name": tool_name}])
        self.wfile.write(data)
        self.wfile.flush()
        self.close_connection = True


s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(
    json.dumps({"listen": "127.0.0.1:" + str(s.server_port), "session_id": a.session}),
    flush=True,
)
s.serve_forever()
