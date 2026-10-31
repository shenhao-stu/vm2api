"""Experimental native-CLI backend with an explicit supported Messages subset.

Run an actual CLI and carry caller tools over MCP. There is no credential,
identity, telemetry, request-header or native executable rewrite in this module.
The caller must supply a fresh session; unsupported history is rejected.
"""

from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import select
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid
import urllib.request


class ContractError(ValueError):
    pass


class RequestRejected(ContractError):
    """Invalid input rejected before changing a native conversation."""


def native_options(body):
    """Accept only the tested native CLI contract; never silently ignore controls."""
    fields = {
        "model",
        "messages",
        "system",
        "tools",
        "metadata",
        "max_tokens",
        "stream",
        "thinking",
        "output_config",
        "context_management",
        "tool_choice",
    }
    if not isinstance(body, dict) or set(body) - fields:
        raise ContractError("unsupported_request_parameter")
    maximum = body.get("max_tokens")
    if type(maximum) is not int or not 1 <= maximum <= 128000:
        raise ContractError("unsupported_max_tokens")
    if body.get("thinking") not in [
        None,
        {"type": "adaptive"},
        {"type": "adaptive", "display": "updates"},
    ]:
        raise ContractError("unsupported_thinking_configuration")
    context = {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]}
    if body.get("context_management") not in [None, context]:
        raise ContractError("unsupported_context_management")
    if body.get("tool_choice") not in [None, {"type": "auto"}]:
        raise ContractError("unsupported_tool_choice")
    output = body.get("output_config", {})
    if (
        not isinstance(output, dict)
        or set(output) - {"effort"}
        or output.get("effort", "medium")
        not in {"low", "medium", "high", "xhigh", "max"}
    ):
        raise ContractError("unsupported_output_configuration")
    if type(body.get("stream", False)) is not bool:
        raise ContractError("invalid_stream")
    if not isinstance(body.get("metadata", {}), dict):
        raise ContractError("invalid_metadata")
    tool_schema(body.get("tools", []))
    systems = text_blocks(body.get("system", ""))
    if any(block["type"] != "text" for block in systems):
        raise ContractError("unsupported_system_content")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ContractError("messages_required")
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {
            "user",
            "assistant",
            "system",
        }:
            raise ContractError("invalid_message")
        text_blocks(message.get("content"))
    return {"CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(maximum)}, [
        "--effort",
        output.get("effort", "medium"),
    ]


def configuration(body):
    result = copy.deepcopy(
        {k: v for k, v in body.items() if k not in {"messages", "metadata", "stream"}}
    )
    for tool in result.get("tools", []):
        tool.pop("cache_control", None)
    if isinstance(result.get("system"), list):
        for block in result["system"]:
            block.pop("cache_control", None)
    return result


def canonical(value):
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        return [canonical(x) for x in value]
    return value


def signature(value):
    return hashlib.sha256(
        json.dumps(canonical(value), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def difference_path(a, b, path="$"):
    a, b = canonical(a), canonical(b)
    if type(a) is not type(b):
        return path + ":type"
    if isinstance(a, dict):
        if set(a) != set(b):
            return path + ":keys:" + ",".join(sorted(set(a) ^ set(b)))
        return next(
            (difference_path(a[k], b[k], path + "." + k) for k in a if a[k] != b[k]),
            None,
        )
    if isinstance(a, list):
        if len(a) != len(b):
            return path + ":length"
        return next(
            (
                difference_path(x, y, path + "[" + str(i) + "]")
                for i, (x, y) in enumerate(zip(a, b))
                if x != y
            ),
            None,
        )
    return path + ":value" if a != b else None


def text_blocks(content):
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list):
        raise ContractError("invalid_content")
    for block in content:
        if (
            not isinstance(block, dict)
            or not isinstance(block.get("type"), str)
            or block["type"] == "text" and not isinstance(block.get("text"), str)
        ):
            raise ContractError("invalid_content_block")
        if block["type"] == "tool_result":
            inner = block.get("content", "")
            if (
                not isinstance(block.get("tool_use_id"), str)
                or type(block.get("is_error", False)) is not bool
                or not isinstance(inner, (str, list))
                or isinstance(inner, list) and any(
                    not isinstance(item, dict)
                    or item.get("type") != "text"
                    or not isinstance(item.get("text"), str)
                    for item in inner
                )
            ):
                raise ContractError("invalid_text_tool_result")
    return copy.deepcopy(content)


def fresh_prompt(messages):
    if not messages or any(m.get("role") not in {"user", "system"} for m in messages):
        raise ContractError("native_session_history_not_imported")
    blocks = [
        b
        for m in messages
        if m["role"] == "user"
        for b in text_blocks(m.get("content"))
    ]
    if any(b.get("type") != "text" for b in blocks):
        raise ContractError("prototype_only_accepts_initial_text")
    return blocks


def message_shape(message):
    result = copy.deepcopy(message)
    result["content"] = text_blocks(result.get("content"))
    for block in result["content"]:
        block.pop("cache_control", None)
        if block.get("type") == "tool_use" and block.get("caller") == {
            "type": "direct"
        }:
            block.pop("caller")
        if block.get("type") == "tool_result" and isinstance(block.get("content"), str):
            block["content"] = text_blocks(block["content"])
        if block.get("type") == "tool_result" and isinstance(
            block.get("content"), list
        ):
            for item in block["content"]:
                item.pop("cache_control", None)
    return canonical(result)


def history_shape(messages):
    return [message_shape(message) for message in messages]


def tool_schema(tools):
    if not isinstance(tools, list):
        raise ContractError("invalid_tools")
    names = set()
    result = []
    for tool in tools:
        if not isinstance(tool, dict) or not isinstance(
            tool.get("description", ""), str
        ):
            raise ContractError("invalid_tool")
        name = tool.get("name", "")
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name)
            or name in names
        ):
            raise ContractError("invalid_or_duplicate_tool_name")
        if not isinstance(tool.get("input_schema"), dict):
            raise ContractError("missing_tool_schema")
        names.add(name)
        result.append(
            {
                "name": name,
                "description": tool.get("description", ""),
                "inputSchema": tool["input_schema"],
            }
        )
    return result


class Turn:
    """Collect genuine native API events, changing only registered MCP tool names."""

    def __init__(self, tools):
        self.names = {"mcp__caller__" + name: name for name in tools}
        self.message = None
        self.inputs = {}

    def event(self, source):
        event = copy.deepcopy(source)
        kind = event.get("type")
        if kind == "message_start":
            self.message = copy.deepcopy(event["message"])
        elif kind == "content_block_start":
            block = event["content_block"]
            if block["type"] == "tool_use":
                if block["name"] not in self.names:
                    raise ContractError("native_requested_an_unregistered_tool")
                block["name"] = self.names[block["name"]]
                self.inputs[event["index"]] = ""
            self.message["content"].append(copy.deepcopy(block))
        elif kind == "content_block_delta":
            block = self.message["content"][event["index"]]
            delta = event["delta"]
            if delta["type"] == "input_json_delta":
                self.inputs[event["index"]] += delta["partial_json"]
            elif delta["type"] in {"text_delta", "thinking_delta", "signature_delta"}:
                field = delta["type"].removesuffix("_delta")
                block[field] = block.get(field, "") + delta[field]
            else:
                raise ContractError("unsupported_stream_delta")
        elif kind == "content_block_stop" and event["index"] in self.inputs:
            self.message["content"][event["index"]]["input"] = json.loads(
                self.inputs[event["index"]] or "{}"
            )
        elif kind == "message_delta":
            self.message.update(event.get("delta", {}))
            self.message.setdefault("usage", {}).update(event.get("usage", {}))
        return event


class Session:
    def __init__(
        self,
        directory,
        command,
        environment,
        body,
        timeout=45,
        require_policy=False,
        tool_wait_seconds=300,
        dispatch_proxy=None,
        session_budget_usd=None,
        restore=False,
    ):
        native_env, self.options = native_options(body)
        self.directory = Path(directory)
        existed = self.directory.exists()
        self.directory.mkdir(mode=0o700, exist_ok=restore)
        if session_budget_usd is not None:
            if (
                not isinstance(session_budget_usd, (int, float))
                or session_budget_usd <= 0
            ):
                raise ContractError("invalid_session_budget")
            self.options += ["--max-budget-usd", str(session_budget_usd)]
        self.command, self.environment = list(command), dict(environment)
        self.environment.pop("CLAUDE_CODE_RETRY_WATCHDOG", None)
        self.environment.update(native_env)
        self.environment.update(
            {
                "CLAUDE_CODE_MAX_RETRIES": "0",
                "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1",
                "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES": "0",
                "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0",
                "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT": "360000",
                "MCP_TOOL_TIMEOUT": "360000",
            }
        )
        if not 0 < tool_wait_seconds <= 300:
            raise ContractError("invalid_tool_wait_deadline")
        self.tool_wait_seconds = tool_wait_seconds
        self.tool_timer = None
        self.timeout = timeout
        self.require_policy = require_policy
        self.dispatch_proxy = dispatch_proxy
        self.dispatch_process = None
        self.dispatch_address = None
        self.last_grant_id = None
        self.model = body["model"]
        self.tools = tool_schema(body.get("tools", []))
        self.history = []
        self.body_signature = signature(configuration(body))
        self.seen = set()
        self.pending_ids = set()
        self.events = queue.Queue()
        self.lock = threading.Lock()
        self.close_lock = threading.RLock()
        self.process = None
        self.reader = None
        self.native_id = str(uuid.uuid4())
        self.failed = False
        self.result = None
        self.native_cli_argv = None
        self.resume_uuid = None
        self.suspended = False
        self.assistants = {}
        self.assistant_ready = threading.Condition()
        if existed:
            self.restore(body)
        (self.directory / "tools.json").write_text(json.dumps(self.tools))
        if not existed:
            self.write_system(body)

    def restore(self, body):
        try:
            state = json.loads((self.directory / "continuation.json").read_text())
        except (OSError, ValueError):
            raise ContractError("native_session_recovery_unavailable") from None
        if state["status"] != "idle":
            raise ContractError("native_session_incomplete_no_replay")
        history = body["messages"][: state["history_length"]]
        if (
            state["configuration"] != self.body_signature
            or signature(history_shape(history)) != state["history_sha256"]
        ):
            raise ContractError("history_prefix_mismatch")
        self.native_id = str(uuid.UUID(state["native_id"]))
        self.resume_uuid = str(uuid.UUID(state["assistant_uuid"]))
        self.history = copy.deepcopy(history)
        self.seen = {state["request_sha256"]}

    def checkpoint(self, status, request_sha256=None, message_id=None):
        path = self.directory / "continuation.json"
        state = {"version": 1, "status": status, "native_id": self.native_id}
        if status == "idle":
            with self.assistant_ready:
                self.assistant_ready.wait_for(
                    lambda: message_id in self.assistants, timeout=5
                )
                assistant_uuid = self.assistants.get(message_id)
            if not assistant_uuid:
                status = state["status"] = "native_resume_point_missing"
            else:
                state.update(
                    {
                        "assistant_uuid": assistant_uuid,
                        "configuration": self.body_signature,
                        "history_length": len(self.history),
                        "history_sha256": signature(history_shape(self.history)),
                        "request_sha256": request_sha256,
                    }
                )
        temp = path.with_suffix(".tmp")
        with os.fdopen(
            os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600), "w"
        ) as out:
            json.dump(state, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
        descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def write_system(self, body):
        systems = text_blocks(body.get("system", ""))
        for message in body["messages"]:
            if message.get("role") == "system":
                systems.extend(text_blocks(message.get("content")))
        if any(b.get("type") != "text" for b in systems):
            raise ContractError("prototype_only_accepts_text_system")
        temp = self.directory / "system.tmp"
        temp.write_text("\n".join(b["text"] for b in systems))
        os.replace(temp, self.directory / "system.txt")

    def prepare(self):
        if self.process is not None:
            if self.process.poll() is not None or self.failed:
                raise ContractError("native_process_not_reusable")
            return
        config = {
            "mcpServers": {
                "caller": {
                    "command": sys.executable,
                    "args": [
                        str(Path(__file__).resolve()),
                        "--mcp",
                        str(self.directory),
                    ],
                }
            }
        }
        hook_command = shlex.join(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--context-hook",
                str(self.directory),
            ]
        )
        settings = {
            "hooks": {
                event: [{"hooks": [{"type": "command", "command": hook_command}]}]
                for event in ["PostToolBatch", "UserPromptSubmit"]
            }
        }
        if self.dispatch_proxy:
            self.start_dispatch_proxy()
            settings["env"] = {
                key: self.dispatch_address
                for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
            }
        argv = [
            *self.command,
            "--settings",
            json.dumps(settings),
            "--strict-mcp-config",
            "--mcp-config",
            json.dumps(config),
            "--tools",
            "",
            "--allowedTools",
            *["mcp__caller__" + t["name"] for t in self.tools],
            "--system-prompt-file",
            str(self.directory / "system.txt"),
            "--system-prompt-snapshot",
            "off",
            "--model",
            self.model,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
            *(
                ["--resume", self.native_id, "--resume-session-at", self.resume_uuid]
                if self.resume_uuid
                else ["--session-id", self.native_id]
            ),
            *self.options,
            "-p",
        ]
        if self.require_policy:
            self.policy_log = self.directory / (
                "native.debug." + str(uuid.uuid4()) + ".private.log"
            )
            argv.extend(["--debug-file", str(self.policy_log)])
        self.native_cli_argv = argv
        with (self.directory / "stderr.private.log").open("ab") as stderr:
            self.process = subprocess.Popen(
                argv,
                cwd=self.directory,
                env=self.environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
                start_new_session=True,
            )
        self.reader = threading.Thread(target=self.read_output, daemon=True)
        self.reader.start()
        if self.require_policy:
            self.await_native_policy()

    def start(self, blocks):
        self.prepare()
        self.authorize_dispatch()
        self.process.stdin.write(
            json.dumps({"type": "user", "message": {"role": "user", "content": blocks}})
            + "\n"
        )
        self.process.stdin.flush()

    def start_dispatch_proxy(self):
        home = Path(self.environment["HOME"]) / ".rec"
        state = json.loads((home / "state.json").read_text())
        port = state["daemon"]["port"]
        if type(port) is not int or not 0 < port < 65536:
            raise ContractError("native_proxy_port_invalid")
        directory = self.directory / "dispatch"
        directory.mkdir(mode=0o700, exist_ok=True)
        command = [
            str(self.dispatch_proxy),
            "--listen",
            "127.0.0.1:0",
            "--upstream",
            "127.0.0.1:" + str(port),
            "--directory",
            str(directory),
            "--session",
            self.native_id,
            "--ca",
            str(home / "ca.pem"),
            "--ca-key",
            str(home / "ca.key"),
        ]
        with (directory / "stderr.private.log").open("ab") as log:
            self.dispatch_process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                start_new_session=True,
            )
        if not select.select([self.dispatch_process.stdout], [], [], 5)[0]:
            self.close()
            raise ContractError("native_dispatch_proxy_not_ready")
        ready = json.loads(self.dispatch_process.stdout.readline())
        if (
            not re.fullmatch(r"127\.0\.0\.1:[0-9]+", ready.get("listen", ""))
            or ready.get("session_id") != self.native_id
        ):
            self.close()
            raise ContractError("native_dispatch_proxy_invalid")
        self.dispatch_address = "http://" + ready["listen"]
        (directory / "ready.safe.json").write_text(json.dumps(ready))

    def authorize_dispatch(self):
        if not self.dispatch_proxy:
            return
        if self.dispatch_process.poll() is not None:
            raise ContractError("native_dispatch_proxy_stopped")
        self.last_grant_id = str(uuid.uuid4())
        directory = self.directory / "dispatch"
        temp = directory / (self.last_grant_id + ".tmp")
        grant = {
            "id": self.last_grant_id,
            "session_id": self.native_id,
            "model": self.model,
            "expires_at_ms": int(time.time() * 1000) + 90000,
        }
        with os.fdopen(
            os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w"
        ) as f:
            json.dump(grant, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, directory / "grant.json")

    def await_native_policy(self):
        """Wait for this native process to confirm the real organizational policy."""
        path = self.policy_log
        deadline = time.monotonic() + min(self.timeout, 90)
        ready = (
            "Policy limits: Applied new restrictions successfully",
            "Policy limits: Cache still valid (304 Not Modified)",
        )
        while self.process.poll() is None and time.monotonic() < deadline:
            if path.exists():
                with path.open() as log:
                    text = log.read(2 * 1024 * 1024)
                if any(marker in text for marker in ready):
                    return
            time.sleep(0.05)
        self.failed = True
        self.close()
        raise ContractError("native_policy_not_ready_no_dispatch")

    def read_output(self):
        try:
            with self.process.stdout as stream, (
                self.directory / "stdout.private.jsonl"
            ).open("a") as log:
                for line in stream:
                    log.write(line)
                    log.flush()
                    event = json.loads(line)
                    if event.get("type") == "stream_event":
                        self.events.put(event["event"])
                    elif event.get("type") == "assistant" and (
                        event.get("error") or event.get("is_api_error_message")
                    ):
                        self.events.put(ContractError("native_api_error"))
                    elif event.get("type") == "assistant" and event.get("uuid"):
                        with self.assistant_ready:
                            self.assistants[event["message"]["id"]] = event["uuid"]
                            if len(self.assistants) > 16:
                                self.assistants.pop(next(iter(self.assistants)))
                            self.assistant_ready.notify_all()
                    elif event.get("type") == "result":
                        self.result = event
                        if event.get("is_error"):
                            self.events.put(ContractError("native_cli_error"))
                        # Keep native stream input open for the next genuine user turn.
        except Exception as exc:
            self.events.put(ContractError(type(exc).__name__))
        finally:
            self.events.put(None)

    def request(self, body):
        if not self.lock.acquire(blocking=False):
            raise RequestRejected("session_busy")
        mutation_started = False
        try:
            if self.failed:
                raise ContractError("session_failed_no_replay")
            native_options(body)
            if signature(configuration(body)) != self.body_signature:
                raise ContractError("session_configuration_changed")
            request_signature = signature(history_shape(body["messages"]))
            if request_signature in self.seen:
                raise ContractError("request_already_consumed")
            if not self.history:
                blocks = fresh_prompt(body["messages"])
                mutation_started = True
                self.seen.add(request_signature)
                self.history = copy.deepcopy(body["messages"])
                self.checkpoint("in_flight")
                self.start(blocks)
            else:
                messages = body["messages"]
                tail = messages[len(self.history) :]
                if (
                    not tail
                    or history_shape(messages[: len(self.history)])
                    != history_shape(self.history)
                    or tail[0].get("role") != "user"
                ):
                    raise ContractError(
                        "history_prefix_mismatch "
                        + str(
                            difference_path(
                                history_shape(self.history),
                                history_shape(messages[: len(self.history)]),
                            )
                        )
                    )
                if any(m.get("role") != "system" for m in tail[1:]):
                    raise ContractError("unsupported_history_tail")
                blocks = text_blocks(tail[0]["content"])
                ids = [
                    b.get("tool_use_id")
                    for b in blocks
                    if b.get("type") == "tool_result"
                ]
                results = {}
                if self.pending_ids:
                    if (
                        len(ids) != len(blocks)
                        or len(set(ids)) != len(ids)
                        or set(ids) != self.pending_ids
                    ):
                        raise ContractError("tool_result_set_mismatch")
                    for block in blocks:
                        content = text_blocks(block.get("content", ""))
                        if any(x.get("type") != "text" for x in content):
                            raise ContractError(
                                "prototype_only_accepts_text_tool_results"
                            )
                        results[block["tool_use_id"]] = {
                            "content": content,
                            "isError": bool(block.get("is_error", False)),
                        }
                elif any(b.get("type") != "text" for b in blocks):
                    raise ContractError("unexpected_tool_result_or_nontext_followup")
                context_blocks = [
                    b for m in tail[1:] for b in text_blocks(m["content"])
                ]
                if any(
                    b.get("type") != "text" or not isinstance(b.get("text"), str)
                    for b in context_blocks
                ):
                    raise ContractError("prototype_only_accepts_text_system")
                contexts = [b["text"] for b in context_blocks]
                mutation_started = True
                self.seen.add(request_signature)
                self.history = copy.deepcopy(messages)
                self.checkpoint("in_flight")
                self.prepare()
                if self.tool_timer:
                    self.tool_timer.cancel()
                    self.tool_timer = None
                (self.directory / "context.pending.json").write_text(
                    json.dumps(contexts)
                )
                self.authorize_dispatch()
                if results:
                    for tool_id, result in results.items():
                        pending = self.directory / (tool_id + ".result.tmp")
                        pending.write_text(json.dumps(result))
                        os.replace(pending, self.directory / (tool_id + ".result.json"))
                else:
                    self.process.stdin.write(
                        json.dumps(
                            {
                                "type": "user",
                                "message": {"role": "user", "content": blocks},
                                "client_composed": True,
                            }
                        )
                        + "\n"
                    )
                    self.process.stdin.flush()
                self.pending_ids = set()
            turn = Turn([t["name"] for t in self.tools])
            while True:
                event = self.events.get(timeout=self.timeout)
                if event is None or isinstance(event, Exception):
                    self.failed = True
                    self.close()
                    raise ContractError("native_stream_incomplete")
                converted = turn.event(event)
                if event.get("type") == "message_stop":
                    if not turn.message or not turn.message.get("stop_reason"):
                        self.failed = True
                        self.close()
                        raise ContractError("native_stop_without_terminal_reason")
                    self.history.append(
                        {"role": "assistant", "content": turn.message["content"]}
                    )
                    self.pending_ids = {
                        b["id"]
                        for b in turn.message["content"]
                        if b.get("type") == "tool_use"
                    }
                    if self.pending_ids:
                        self.tool_timer = threading.Timer(
                            self.tool_wait_seconds, self.expire_tool_wait
                        )
                        self.tool_timer.daemon = True
                        self.tool_timer.start()
                    elif (
                        turn.message["stop_reason"] != "end_turn"
                        and self.dispatch_proxy
                    ):
                        # The CLI may autonomously recover from max_tokens. The
                        # consumed network grant blocks it; do not reuse this turn.
                        self.suspended = True
                        self.close(graceful=True)
                    if not self.pending_ids:
                        self.checkpoint("idle", request_signature, turn.message["id"])
                yield converted
                if event.get("type") == "message_stop":
                    return
        except ContractError as exc:
            if not mutation_started:
                raise RequestRejected(str(exc)) from None
            self.failed = True
            self.close()
            raise
        except (queue.Empty, BrokenPipeError):
            self.failed = True
            self.close()
            raise ContractError("native_timed_out_no_replay")
        except GeneratorExit:
            self.failed = True
            self.close()
            raise
        except Exception as exc:
            self.failed = True
            self.close()
            raise ContractError("native_session_" + type(exc).__name__) from None
        finally:
            self.lock.release()

    def expire_tool_wait(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            if self.pending_ids:
                self.failed = True
                self.close()
        finally:
            self.lock.release()

    def close(self, graceful=False):
        with self.close_lock:
            self._close(graceful)

    def _close(self, graceful=False):
        if self.tool_timer:
            self.tool_timer.cancel()
            self.tool_timer = None
        if self.process and self.process.stdin and not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass
        if graceful and self.process and self.process.poll() is None:
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        if self.process and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=5)
        if self.reader and self.reader is not threading.current_thread():
            self.reader.join(timeout=1)
        if self.dispatch_process:
            if self.dispatch_address:
                try:
                    opener = urllib.request.build_opener(
                        urllib.request.ProxyHandler({})
                    )
                    with opener.open(
                        self.dispatch_address + "/healthz", timeout=2
                    ) as response:
                        (self.directory / "dispatch/final.safe.json").write_bytes(
                            response.read(4096)
                        )
                except OSError:
                    pass
            if self.dispatch_process.poll() is None:
                self.dispatch_process.terminate()
                try:
                    self.dispatch_process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.dispatch_process.kill()
                    self.dispatch_process.wait(timeout=3)
            if self.dispatch_process.stdout:
                self.dispatch_process.stdout.close()
        if self.failed:
            self.checkpoint("failed")


def mcp(directory):
    root = Path(directory)
    tools = json.loads((root / "tools.json").read_text())
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("id") is None:
            continue
        method = request["method"]
        if method == "initialize":
            result = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "vm2api-native-caller-tools-experiment",
                    "version": "0.0.1",
                },
            }
        elif method == "tools/list":
            result = {"tools": tools}
        elif method == "tools/call":
            params = request["params"]
            tool_id = params.get("_meta", {}).get("claudecode/toolUseId", "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", tool_id):
                raise ContractError("missing_native_tool_use_id")
            if params["name"] not in {t["name"] for t in tools}:
                raise ContractError("unknown_tool")
            with (root / (tool_id + ".pending.json")).open("x") as f:
                json.dump(params, f)
            path = root / (tool_id + ".result.json")
            # The owner kills the entire CLI before its native tool timeout.
            # Returning a synthetic tool error here would cause an unrequested
            # autonomous continuation, without a corresponding caller request.
            while not path.exists():
                time.sleep(0.02)
            result = json.loads(path.read_text())
        else:
            result = {}
        print(
            json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}),
            flush=True,
        )


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--context-hook":
        event = json.load(sys.stdin)["hook_event_name"]
        if event not in ["PostToolBatch", "UserPromptSubmit"]:
            raise ContractError("unknown_context_hook")
        path = Path(sys.argv[2]) / "context.pending.json"
        contexts = json.loads(path.read_text()) if path.exists() else []
        if path.exists():
            path.unlink()
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": event,
                        "additionalContext": "\n".join(contexts),
                    }
                }
            )
        )
    elif len(sys.argv) == 3 and sys.argv[1] == "--mcp":
        mcp(sys.argv[2])
    else:
        raise SystemExit(
            "Research library only; no production listener or live credentials."
        )
