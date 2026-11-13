"""Real parent CLI and builtin Agent over the API relay; run with network=none."""

import fcntl
import json
import os
import pty
import re
import select
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid
from pathlib import Path

from interactive_http_acceptance import Harness
from native_api_http import initialize_api_profile


def run(root, cli):
    harness = Harness(root, cli)
    process = master = None
    home = root / "outer-home"
    profile = initialize_api_profile(home)
    cwd = root / "outer-work"
    cwd.mkdir(mode=0o700)
    hooks = root / "outer-hooks.py"
    hooks.write_text(
        'import json,sys,pathlib\ne=json.load(sys.stdin)\np=pathlib.Path(sys.argv[1])/((e.get("hook_event_name")or"event")+".json")\np.write_text(json.dumps(e))\n'
    )
    settings = {
        "hooks": {
            e: [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": shlex.join(
                                [sys.executable, str(hooks), str(root)]
                            ),
                        }
                    ]
                }
            ]
            for e in ("SessionStart", "Stop", "SubagentStart", "SubagentStop")
        }
    }
    env = {
        "HOME": str(home),
        "CLAUDE_CONFIG_DIR": str(profile),
        "PATH": os.environ["PATH"],
        "LANG": "C.UTF-8",
        "TERM": "xterm-256color",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:" + str(harness.server.server_port),
        "ANTHROPIC_AUTH_TOKEN": harness.client,
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "256",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
        "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0",
    }
    argv = [
        cli,
        "--setting-sources",
        "",
        "--settings",
        json.dumps(settings),
        "--session-id",
        str(uuid.uuid4()),
        "--model",
        "claude-opus-5-5",
        "--tools",
        "Agent",
        "--allowedTools",
        "Agent",
        "--system-prompt",
        "This is an isolated fixture. Invoke probe once, then return the result. Do not inspect files.",
        "--agents",
        json.dumps(
            {
                "probe": {
                    "description": "Return marker only.",
                    "prompt": "Return OFFLINE_CHILD_OK exactly; do not use tools.",
                    "tools": [],
                    "model": "inherit",
                }
            }
        ),
        "--permission-mode",
        "manual",
        "--disable-slash-commands",
        "--no-chrome",
        "--debug-file",
        str(root / "outer-debug.private.log"),
    ]
    try:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        tail, answered, sent, follow = "", set(), False, False
        started = time.monotonic()
        cues = [
            ("DetectedacustomAPIkey", b"\x1b[A\r"),
            ("Choosethetextstyle", b"\r"),
            ("Securitynotes:", b"\r"),
            ("Accessingworkspace:", b"\x1b[B\r"),
        ]
        with (root / "outer-terminal.private.log").open("ab") as terminal:
            while time.monotonic() - started < 125:
                if process.poll() is not None:
                    break
                if select.select([master], [], [], 0.05)[0]:
                    raw = os.read(master, 65536)
                    terminal.write(raw)
                    terminal.flush()
                    tail = (tail + raw.decode("utf8", "replace"))[-16384:]
                    compact = re.sub(
                        r"\s+", "", re.sub(r"\x1b\[[0-9;?<>]*[ -/]*[@-~]", "", tail)
                    )
                    for cue, answer in cues:
                        if cue in compact and cue not in answered:
                            answered.add(cue)
                            time.sleep(0.3)
                            if answer != b"\r":
                                os.write(master, answer[:-1])
                                time.sleep(0.2)
                            os.write(master, b"\r")
                            tail = ""
                            break
                if not sent and (root / "SessionStart.json").exists():
                    time.sleep(0.4)
                    send(
                        master,
                        "Use Agent with subagent_type probe to return OFFLINE_CHILD_OK. Return its result.",
                    )
                    sent = True
                stop = root / "Stop.json"
                if (
                    stop.exists()
                    and (root / "SubagentStop.json").exists()
                    and not harness.server.active_requests
                    and time.time() - stop.stat().st_mtime > 0.8
                ):
                    if follow:
                        break
                    (root / "Stop.json").rename(root / "FirstStop.private.json")
                    time.sleep(0.3)
                    send(master, "Continue: repeat OFFLINE_CHILD_OK without a tool.")
                    follow = True
        harness.idle()
        rows = harness.audit()
        summary = {
            "sent": sent,
            "continuation_sent": follow,
            "parent_stopped": (root / "Stop.json").exists(),
            "subagent_started": (root / "SubagentStart.json").exists(),
            "subagent_stopped": (root / "SubagentStop.json").exists(),
            "requests": [
                {
                    k: row.get(k)
                    for k in ("status", "error", "complete", "attempts", "usage")
                }
                for row in rows
            ],
            "distinct_sessions": len({s.native_id for s in harness.created}),
            "dispatches": harness.dispatches(),
            "real_provider_calls": 0,
            "fixture_usage_only": True,
        }
        (root / "result.safe.json").write_text(json.dumps(summary))
        print(json.dumps(summary), flush=True)
        assert (
            summary["parent_stopped"]
            and summary["subagent_started"]
            and summary["subagent_stopped"]
        )
        # A background Agent completion may add a legitimate notification turn.
        assert 4 <= len(rows) <= 6 and harness.dispatches() == len(rows), summary
        assert len({r["request_sha256"] for r in rows}) == len(rows), summary
        assert summary["distinct_sessions"] == 2, summary
        assert all(
            r["status"] == 200 and r["complete"] and r["attempts"] == 1 for r in rows
        ), summary
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        if master is not None:
            os.close(master)
        harness.close()


def send(master, text):
    os.write(master, b"\x1b[200~" + text.encode() + b"\x1b[201~")
    time.sleep(0.05)
    os.write(master, b"\r")


if __name__ == "__main__":
    os.umask(0o077)
    if len(sys.argv) == 3:
        path = Path(sys.argv[2])
        path.mkdir(mode=0o700, exist_ok=True)
        run(path, sys.argv[1])
    else:
        with tempfile.TemporaryDirectory(prefix="airoam-agent-isolation-") as tmp:
            run(Path(tmp), sys.argv[1])
