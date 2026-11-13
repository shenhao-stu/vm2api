"""Experimental PTY driver. Provider SSE, never terminal text, carries usage."""

import fcntl
import json
import os
import pty
import queue
import re
import select
import shlex
import struct
import subprocess
import sys
import termios
import threading
import time
import uuid
from pathlib import Path

import native_bridge_session as native
from native_interactive_recovery import (
    RecoveryError,
    RecoveryGate,
    caller_tool_event,
    load_steps,
    private_json,
    project_tool_text,
)


def prompt_text(blocks):
    if not blocks or any(b.get("type") != "text" for b in blocks):
        raise native.ContractError("interactive_prompt_requires_text")
    text = "\n".join(b["text"] for b in blocks)
    if (
        not text.strip()
        or len(text.encode()) > 1024 * 1024
        or any(ord(c) < 32 and c not in "\n\t" for c in text)
    ):
        raise native.ContractError("interactive_prompt_invalid")
    return text


class TerminalInput:
    def __init__(self, master):
        self.master, self.closed = master, False

    def write(self, raw):
        record = json.loads(raw)
        if (
            record.get("type") != "user"
            or record.get("message", {}).get("role") != "user"
        ):
            raise native.ContractError("interactive_control_not_supported")
        text = prompt_text(record["message"]["content"])
        # Bracketed paste prevents embedded newlines from becoming extra turns.
        payload = b"\x1b[200~" + text.encode() + b"\x1b[201~"
        while payload:
            payload = payload[os.write(self.master, payload) :]
        time.sleep(0.05)
        os.write(self.master, b"\r")

    def flush(self):
        pass

    def close(self):
        self.closed = True


def hook(directory):
    event = json.load(sys.stdin)
    if event.get("hook_event_name") not in {"SessionStart", "Stop"}:
        return
    value = {
        k: event[k]
        for k in ("session_id", "hook_event_name", "transcript_path")
        if k in event
    }
    target = Path(directory) / ("interactive-" + event["hook_event_name"] + ".json")
    tmp = target.with_suffix(".tmp")
    with tmp.open("w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, target)


class InteractiveSession(native.Session):
    def __init__(self, *args, **kwargs):
        self.master = None
        self.ui_ready = threading.Event()
        self.read_stop = threading.Event()
        self.recovery_gate = None
        self.recovery_steps = None
        super().__init__(*args, **kwargs)
        if not self.api_base or self.require_policy:
            raise native.ContractError("interactive_api_provider_only")

    def request(self, body):
        # Reject content the interactive MCP bridge cannot represent.
        changed = native.signature(native.configuration(body)) != self.body_signature
        tail = native.native_blocks(
            next(m for m in reversed(body["messages"]) if m["role"] == "user")[
                "content"
            ]
        )
        tool_results = any(b.get("type") == "tool_result" for b in tail)
        if not tool_results:
            prompt_text(tail)
        elif (
            not self.pending_ids
            or changed
            or any(b.get("type") not in {"tool_result", "text"} for b in tail)
            or any(
                c["type"] != "text"
                for b in tail
                if b["type"] == "tool_result"
                for c in native.text_blocks(b.get("content", ""))
            )
        ):
            raise native.RequestRejected(
                "interactive_resume_tool_results_not_supported"
            )
        if native.output_format(body) is not None:
            raise native.RequestRejected("interactive_structured_output_not_supported")
        if tool_results and (
            self.suspended
            or self.process is not None
            and self.process.poll() is not None
        ):
            self.recover_pending(body)
        for event in super().request(body):
            if event.get("type") == "message_stop" and self.pending_ids:
                self.remember_pending(body, tail, tool_results)
            yield event

    def remember_pending(self, body, tail, tool_results):
        path = self.directory / "interactive-recovery.private.json"
        if tool_results:
            # Old sessions without a recovery record remain protected, rather
            # than guessing which prior provider response belongs to them.
            if not path.exists():
                return
            plan = json.loads(path.read_bytes())
        else:
            plan = {
                "version": 1,
                "native_id": self.native_id,
                "base_history": body["messages"][:-1],
                "tools": self.tools,
                "configuration": self.body_signature,
                "steps": [],
            }
        if len(plan["steps"]) >= 64:
            return
        plan["steps"].append(
            {
                "grant_id": self.last_grant_id,
                "input": tail,
                "assistant_sha256": native.signature(self.history[-1]["content"]),
                "message_id": self.resume_message_id,
            }
        )
        plan["history_sha256"] = native.signature(native.history_shape(self.history))
        private_json(path, plan)

    def start_dispatch_proxy(self):
        super().start_dispatch_proxy()
        if self.recovery_gate is None:
            self.recovery_gate = RecoveryGate(
                self.dispatch_address, self.native_id, self.recovery_steps,
                self.project_tool_text, self.reject_projection,
            )
            self.dispatch_address = "http://127.0.0.1:" + str(
                self.recovery_gate.server_port
            )

    def tool_results_need_restart(self, blocks, results):
        # The MCP results still pass through the native CLI. Its private gate
        # rejoins the caller's trailing user text at the exact tool boundary.
        return False

    def project_tool_text(self, data):
        messages = native.history_shape(self.history)
        if not any(
            message["role"] == "user"
            and any(b["type"] == "tool_result" for b in message["content"])
            and any(b["type"] == "text" for b in message["content"])
            for message in messages
        ):
            return data
        body = project_tool_text(json.loads(data), messages)
        return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()

    def reject_projection(self, code):
        self.events.put(native.ContractError(code))

    def recover_pending(self, body):
        if not self.lock.acquire(blocking=False):
            raise native.RequestRejected("session_busy")
        try:
            self.validate_configuration(body)
            self.history_prefix(body["messages"])
            plan = json.loads(
                (self.directory / "interactive-recovery.private.json").read_bytes()
            )
            if plan.get("configuration") != self.body_signature or plan.get(
                "history_sha256"
            ) != native.signature(native.history_shape(self.history)):
                raise RecoveryError("recovery_boundary_changed")
            steps = load_steps(self.directory, plan, self.native_id)
            attempt = self.prepare_recovery_runtime(plan, steps, body)
            for index, step in enumerate(steps):
                self.restore_pending_step(index, step)
            self.recovery_gate.activate()
            state = json.loads((self.directory / "continuation.json").read_bytes())
            self.checkpoint(
                "awaiting_tools", state["request_sha256"], steps[-1]["message_id"]
            )
            if not self.resume_uuid:
                raise RecoveryError("recovery_assistant_boundary_missing")
            self.suspended = False
            self.process_has_turn = True
            private_json(
                attempt / "result.safe.json",
                {
                    "restored": True,
                    "local_responses": len(steps),
                    "upstream_dispatches": 0,
                },
            )
        except (OSError, ValueError, KeyError, TypeError, native.ContractError) as exc:
            self.close()
            self.suspended = True
            raise native.RequestRejected(
                "interactive_pending_recovery_unavailable_no_replay"
            ) from exc
        finally:
            self.recovery_steps = None
            self.lock.release()

    def prepare_recovery_runtime(self, plan, steps, body):
        self.close()
        if self.reader and self.reader.is_alive():
            raise RecoveryError("recovery_reader_still_running")
        attempt = self.directory / ("recovery-" + uuid.uuid4().hex)
        attempt.mkdir(mode=0o700)
        project_key = re.sub(r"[^a-zA-Z0-9]", "-", str(self.directory.resolve()))
        transcript = (
            self.history_profile
            / "projects"
            / project_key
            / (self.native_id + ".jsonl")
        )
        if transcript.exists():
            os.rename(transcript, attempt / "original-transcript.private.jsonl")
        for pattern in ("*.pending.json", "*.result.json"):
            for path in self.directory.glob(pattern):
                os.rename(path, attempt / path.name)
        self.process = self.reader = self.dispatch_process = None
        self.last_grant_id = self.dispatch_address = None
        self.events = queue.Queue()
        self.result = self.result_message_id = self.last_native_message_id = None
        self.resume_uuid = self.resume_message_id = None
        self.assistants.clear()
        if plan["base_history"]:
            self.resume_uuid = native.write_transcript(
                self.history_profile,
                self.directory,
                self.native_id,
                [
                    {
                        **m,
                        "content": native.dispatch_blocks(
                            native.native_blocks(m["content"])
                        ),
                    }
                    for m in plan["base_history"]
                ],
                initial_effort=native.effective_effort(body, leading_only=True),
            )
        self.recovery_steps = steps
        self.prepare()
        return attempt

    def restore_pending_step(self, index, step):
        if index == 0:
            self.process.stdin.write(
                json.dumps(
                    {
                        "type": "user",
                        "message": {"role": "user", "content": step["input"]},
                    }
                )
            )
        else:
            for result in step["input"]:
                if result.get("type") == "text":
                    continue
                if result.get("type") != "tool_result":
                    raise RecoveryError("recovery_tool_result_invalid")
                private_json(
                    self.directory / (result["tool_use_id"] + ".result.json"),
                    {
                        "content": native.text_blocks(result.get("content", "")),
                        "isError": bool(result.get("is_error", False)),
                    },
                )
        deadline = time.monotonic() + min(30, self.timeout)
        while True:
            if self.recovery_gate.error or self.process.poll() is not None:
                raise RecoveryError(self.recovery_gate.error or "recovery_cli_stopped")
            pending = []
            for tool in step["pending"]:
                path = self.directory / (tool["id"] + ".pending.json")
                try:
                    value = json.loads(path.read_bytes())
                except (FileNotFoundError, json.JSONDecodeError):
                    # MCP creates this file before its JSON write completes.
                    continue
                if (
                    value.get("name") != tool["name"]
                    or value.get("arguments") != tool["input"]
                ):
                    raise RecoveryError("recovery_tool_arguments_changed")
                pending.append(tool["id"])
            if self.recovery_gate.index == index + 1 and len(pending) == len(
                step["pending"]
            ):
                break
            if time.monotonic() > deadline:
                raise RecoveryError("recovery_tool_wait_not_restored")
            time.sleep(0.02)

    def prepare(self):
        if self.process is not None:
            if self.process.poll() is not None or self.failed:
                raise native.ContractError("native_process_not_reusable")
            return
        (self.directory / "interactive-mcp-ready.json").unlink(missing_ok=True)
        (self.directory / "interactive-mcp-required").touch(mode=0o600)
        self.start_dispatch_proxy()
        module = str(Path(__file__).resolve())
        context = shlex.join(
            [
                sys.executable,
                str(Path(native.__file__).resolve()),
                "--context-hook",
                str(self.directory),
            ]
        )
        lifecycle = shlex.join([sys.executable, module, "--hook", str(self.directory)])
        settings = {
            "hooks": {
                **{
                    e: [{"hooks": [{"type": "command", "command": context}]}]
                    for e in ("PostToolBatch", "UserPromptSubmit")
                },
                **{
                    e: [{"hooks": [{"type": "command", "command": lifecycle}]}]
                    for e in ("SessionStart", "Stop")
                },
            },
            "env": {"ANTHROPIC_BASE_URL": self.dispatch_address},
        }
        mcp = {
            "mcpServers": {
                "caller": {
                    "command": sys.executable,
                    "args": [
                        str(Path(native.__file__).resolve()),
                        "--mcp",
                        str(self.directory),
                    ],
                }
            }
        }
        argv = [
            *self.command,
            "--settings",
            json.dumps(settings),
            "--strict-mcp-config",
            "--mcp-config",
            json.dumps(mcp),
            "--tools",
            "",
            "--allowedTools",
            *["mcp__caller__" + t["name"] for t in self.tools],
            "--system-prompt-file",
            str(self.directory / "system.txt"),
            "--system-prompt-snapshot",
            "off",
            "--permission-mode",
            "manual",
            "--model",
            self.model,
            "--disable-slash-commands",
            "--no-chrome",
            "--debug-file",
            str(self.directory / "interactive-debug.private.log"),
            *(
                ["--resume", self.native_id, "--resume-session-at", self.resume_uuid]
                if self.resume_uuid
                else ["--session-id", self.native_id]
            ),
            *self.options,
        ]
        if any(
            x in argv for x in ("-p", "--print", "--input-format", "--output-format")
        ):
            raise native.ContractError("interactive_driver_forbids_print_mode")
        self.native_cli_argv = argv
        # The CLI checks its provider before loading workspace settings on a
        # fresh profile. Give that bootstrap the same guarded endpoint; never
        # allow an onboarding request to escape to the default provider.
        env = {
            **self.environment,
            "ANTHROPIC_BASE_URL": self.dispatch_address,
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
        }
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.read_stop.clear()
        self.ui_ready.clear()
        for event in ("SessionStart", "Stop"):
            (self.directory / f"interactive-{event}.json").unlink(missing_ok=True)
        try:
            self.process = subprocess.Popen(
                argv,
                cwd=self.directory,
                env=env,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                start_new_session=True,
            )
        finally:
            os.close(slave)
        self.process.stdin = TerminalInput(self.master)
        self.reader = threading.Thread(target=self.read_output, daemon=True)
        self.reader.start()
        if not self.ui_ready.wait(min(30, self.timeout)):
            self.close()
            raise native.ContractError("interactive_not_ready_no_dispatch")

    def initialize_native(self):
        if not self.ui_ready.is_set():
            raise native.ContractError("interactive_not_ready_no_dispatch")

    def authorize_dispatch(self):
        (self.directory / "interactive-Stop.json").unlink(missing_ok=True)
        super().authorize_dispatch()

    def transcript(self):
        for kind in ("SessionStart", "Stop"):
            path = self.directory / f"interactive-{kind}.json"
            try:
                value = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if value.get("session_id") != self.native_id:
                raise native.ContractError("interactive_session_mismatch")
            transcript = Path(value["transcript_path"]).resolve()
            if self.history_profile.resolve() not in transcript.parents:
                raise native.ContractError("interactive_transcript_outside_profile")
            return transcript
        return None

    def native_assistants(self):
        path = self.transcript()
        if not path or not path.exists():
            return
        with path.open() as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if (
                    event.get("sessionId") != self.native_id
                    or event.get("type") != "assistant"
                ):
                    continue
                message = event.get("message", {})
                if message.get("id") and event.get("uuid"):
                    with self.assistant_ready:
                        self.assistants[message["id"]] = event["uuid"]
                        self.last_native_message_id = message["id"]
                        self.assistant_ready.notify_all()
        stop = self.directory / "interactive-Stop.json"
        if stop.exists() and self.last_native_message_id:
            with self.control_ready:
                self.result = {"is_error": False, "source": "interactive_stop_hook"}
                self.result_message_id = self.last_native_message_id
                self.control_ready.notify_all()

    def read_output(self):
        offsets, buffers, completed = {}, {}, set()
        terminal_tail = ""
        answered = set()
        cues = [
            ("DetectedacustomAPIkey", b"\x1b[A\r"),
            ("Choosethetextstyle", b"\r"),
            ("Securitynotes:", b"\r"),
            ("Accessingworkspace:", b"\x1b[B\r"),
        ]
        try:
            while not self.read_stop.is_set() and self.process.poll() is None:
                if select.select([self.master], [], [], 0.04)[0]:
                    raw = os.read(self.master, 65536)
                    with (self.directory / "interactive-terminal.private.log").open(
                        "ab"
                    ) as log:
                        log.write(raw)
                    terminal_tail = (terminal_tail + raw.decode("utf8", "replace"))[
                        -16384:
                    ]
                    plain = re.sub(r"\x1b\[[0-9;?<>]*[ -/]*[@-~]", "", terminal_tail)
                    compact = re.sub(r"\s+", "", plain)
                    for cue, answer in cues:
                        if cue in compact and cue not in answered:
                            answered.add(cue)
                            time.sleep(0.3)
                            if answer != b"\r":
                                os.write(self.master, answer[:-1])
                                time.sleep(0.2)
                            os.write(self.master, b"\r")
                            terminal_tail = ""
                            break
                if (self.directory / "interactive-SessionStart.json").exists() and (
                    not self.tools
                    or (self.directory / "interactive-mcp-ready.json").exists()
                ):
                    self.ui_ready.set()
                self.native_assistants()
                grant = self.last_grant_id
                if not grant or grant in completed:
                    continue
                path = self.directory / "dispatch" / f"{grant}.api-stream.private"
                final = path.with_name(f"{grant}.api-terminal.json")
                if not path.exists():
                    continue
                with path.open("rb") as stream:
                    stream.seek(offsets.get(grant, 0))
                    data = stream.read(1024 * 1024)
                    offsets[grant] = stream.tell()
                buffer = buffers.get(grant, b"") + data
                while separator := re.search(rb"\r?\n\r?\n", buffer):
                    frame, rest = buffer[: separator.start()], buffer[separator.end() :]
                    payload = b"\n".join(
                        l[5:].lstrip()
                        for l in frame.splitlines()
                        if l.startswith(b"data:")
                    )
                    if not payload:
                        buffer = rest
                        continue
                    event = json.loads(payload)
                    if event.get("type") == "message_stop":
                        if not final.exists():
                            break
                        finish = json.loads(final.read_text())
                        if (
                            not finish.get("complete")
                            or finish.get("grant_id") != grant
                        ):
                            raise native.ContractError(
                                "interactive_stream_incomplete_no_replay"
                            )
                        completed.add(grant)
                    self.events.put(caller_tool_event(event, self.tools))
                    buffer = rest
                buffers[grant] = buffer
                if len(buffer) > 2 * 1024 * 1024:
                    raise native.ContractError("interactive_event_too_large")
                if final.exists() and grant not in completed:
                    finish = json.loads(final.read_text())
                    if finish.get("grant_id") != grant:
                        raise native.ContractError(
                            "interactive_receipt_mismatch_no_replay"
                        )
                    if finish.get("status") != 200:
                        status = finish.get("status")
                        raise native.NativeProviderError(
                            status
                            if type(status) is int and 400 <= status <= 599
                            else 502
                        )
                    if offsets[grant] >= finish.get("bytes", path.stat().st_size):
                        raise native.ContractError(
                            "interactive_stream_incomplete_no_replay"
                        )
        except Exception as exc:
            self.events.put(
                exc
                if isinstance(exc, native.ContractError)
                else native.ContractError("interactive_reader_failed")
            )
        finally:
            self.events.put(None)

    def _close(self, graceful=False):
        # Closing a Python stdin wrapper cannot deliver EOF to a PTY. At an
        # already verified idle boundary use the CLI's normal Ctrl-D exit.
        if (
            graceful
            and self.master is not None
            and self.process
            and self.process.poll() is None
        ):
            try:
                os.write(self.master, b"\x04")
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        self.read_stop.set()
        try:
            super()._close(graceful)
        finally:
            if self.recovery_gate is not None:
                self.recovery_gate.close()
                self.recovery_gate = None
            if self.master is not None:
                os.close(self.master)
                self.master = None


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--hook":
    hook(sys.argv[2])
