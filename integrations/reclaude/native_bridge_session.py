"""Experimental native-CLI backend with an explicit supported Messages subset.

Run an actual CLI and carry caller tools over MCP. There is no credential,
identity, telemetry, request-header or native executable rewrite in this module.
Caller history import is opt-in and never dispatches historical turns.
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
from native_history import (HistoryError, active_efforts, import_plan, trailing_system_text,
                            validate_system_messages, write_transcript)
import native_history_boundary as boundary


STRUCTURED_RESPONSE_LIMIT = 16 * 1024 * 1024


class ContractError(ValueError):
    pass


class RequestRejected(ContractError):
    """Invalid input rejected before changing a native conversation."""


class NativeRateLimit(ContractError):
    """The native CLI rejected this model; other model windows may remain usable."""

    def __init__(self, model, info=None):
        super().__init__("native_rate_limit")
        self.details = {"upstream_type": "rate_limit_error", "model": model}
        if not isinstance(info, dict) or info.get("status") != "rejected":
            return
        window, reset = info.get("rateLimitType"), info.get("resetsAt")
        if isinstance(window, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", window):
            self.details["rate_limit_type"] = window
        if type(reset) is int and 0 < reset <= 253402300799:
            self.details["reset_at"] = reset


def thinking_configuration(body):
    """Keep legacy native defaults; carry only explicitly representable displays."""
    thinking = body.get("thinking")
    if thinking in [None, {"type": "adaptive"}, {"type": "adaptive", "display": "updates"}]:
        # `updates` was already accepted as the native default. It is not a
        # --thinking-display choice and must not be mapped to another display.
        return None
    if thinking not in [
        {"type": "adaptive", "display": "summarized"},
        {"type": "adaptive", "display": "omitted"},
    ]:
        raise ContractError("unsupported_thinking_configuration")
    return copy.deepcopy(thinking)


def schema_resources(value, depth=0):
    """Bound local validation; schemas must not fetch external references."""
    if depth > 64:
        raise ContractError("unsupported_output_configuration")
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"$ref", "$dynamicRef", "$recursiveRef"} and (
                not isinstance(item, str) or not item.startswith("#")
            ):
                raise ContractError("unsupported_output_configuration")
            schema_resources(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            schema_resources(item, depth + 1)


def output_format(body):
    output = body.get("output_config", {})
    if not isinstance(output, dict) or "format" not in output:
        return None
    fmt = output["format"]
    if (not isinstance(fmt, dict) or set(fmt) != {"type", "schema"}
            or fmt["type"] != "json_schema" or not isinstance(fmt["schema"], dict)):
        raise ContractError("unsupported_output_configuration")
    schema_resources(fmt["schema"])
    try:
        encoded = json.dumps(fmt["schema"], allow_nan=False).encode()
    except (ValueError, TypeError, RecursionError):
        raise ContractError("unsupported_output_configuration") from None
    if len(encoded) > 65536:
        raise ContractError("unsupported_output_configuration")
    return copy.deepcopy(fmt)


def native_cache_ttl(body):
    """The CLI owns breakpoints and can express only one TTL per invocation."""
    def controls(blocks):
        for block in blocks if isinstance(blocks, list) else []:
            if not isinstance(block, dict):
                continue
            if 'cache_control' in block:
                yield block['cache_control']
            if block.get('type') in {'tool_result', 'search_result'}:
                yield from controls(block.get('content'))
            tool = block.get('tool')
            if (block.get('type') == 'tool_addition' and isinstance(tool, dict)
                    and tool.get('type') == 'tool_definition'):
                yield from controls([tool.get('definition')])

    values = list(controls(body.get('tools'))) + list(controls(body.get('system')))
    for message in body.get('messages', []):
        if isinstance(message, dict):
            values.extend(controls(message.get('content')))
    if 'cache_control' in body:
        values.append(body['cache_control'])
    ttls = set()
    for control in values:
        if (not isinstance(control, dict) or control.get('type') != 'ephemeral'
                or control.get('ttl', '1h') not in ('5m', '1h')):
            raise ContractError('invalid_cache_control')
        ttls.add(control.get('ttl', '1h'))
    if len(ttls) > 1:
        raise ContractError('cache_ttl_mixed_unsupported')
    return next(iter(ttls), '1h')


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
        "temperature",
        "cache_control",
    }
    if not isinstance(body, dict) or set(body) - fields:
        raise ContractError("unsupported_request_parameter")
    # Legacy Messages clients (including Sub2API's account test) send the
    # default explicitly. Native CC omits this retired control; both mean 1.
    # Never pretend a non-default sampler can be represented by the CLI.
    temperature = body.get("temperature", 1)
    if type(temperature) not in (int, float) or temperature != 1:
        raise ContractError("unsupported_temperature")
    maximum = body.get("max_tokens")
    if type(maximum) is not int or not 1 <= maximum <= 128000:
        raise ContractError("unsupported_max_tokens")
    thinking = thinking_configuration(body)
    context = {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]}
    if body.get("context_management") not in [None, context]:
        raise ContractError("unsupported_context_management")
    if body.get("tool_choice") not in [None, {"type": "auto"}]:
        raise ContractError("unsupported_tool_choice")
    output = body.get("output_config", {})
    if (
        not isinstance(output, dict)
        or set(output) - {"effort", "format"}
        or not isinstance(output.get("effort", "medium"), str)
        or output.get("effort", "medium")
        not in {"low", "medium", "high", "xhigh", "max"}
    ):
        raise ContractError("unsupported_output_configuration")
    fmt = output_format(body)
    if type(body.get("stream", False)) is not bool:
        raise ContractError("invalid_stream")
    if not isinstance(body.get("metadata", {}), dict):
        raise ContractError("invalid_metadata")
    names = {t['name'] for t in tool_schema(body.get("tools", []))}
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
        blocks = text_blocks(message.get("content"))
        for block in blocks:
            if block['type'] == 'tool_result':
                for child in text_blocks(block.get('content', '')):
                    if child['type'] == 'tool_reference' and child['tool_name'] not in names:
                        raise ContractError('unknown_tool_reference')
    try:
        validate_system_messages(history_shape(messages))
    except HistoryError as exc:
        raise ContractError(str(exc)) from None
    ttl = native_cache_ttl(body)
    environment = {
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(maximum),
        "CLAUDE_CODE_PROMPT_CACHE_TTL": ttl,
        "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL": ttl,
        "FORCE_PROMPT_CACHING_5M": '1' if ttl == '5m' else '0',
    }
    if thinking and thinking["display"] == "omitted":
        # Native CC otherwise upgrades an explicit omitted display to updates.
        environment["CLAUDE_CODE_THINKING_DISPLAY_UPDATES"] = "0"
    return environment, [
        "--effort",
        effective_effort(body),
    ] + (["--thinking", "adaptive", "--thinking-display", thinking["display"]]
         if thinking else []) + (["--json-schema", json.dumps(fmt["schema"])] if fmt else [])


def effective_effort(body, leading_only=False):
    effort = body.get('output_config', {}).get('effort', 'medium')
    if not leading_only:
        for effort in active_efforts(body.get('messages', []), effort):
            pass
        return effort
    for message in body.get('messages', []):
        if message['role'] != 'system':
            break
        effort = message.get('output_config', {}).get('effort', effort)
    return effort


def legacy_configuration(body):
    """Version-one checkpoints can migrate only after their exact hash matches."""
    result = copy.deepcopy(
        {k: v for k, v in body.items()
         if k not in {"messages", "metadata", "stream", "temperature"}}
    )
    for tool in result.get("tools", []):
        tool.pop("cache_control", None)
    if isinstance(result.get("system"), list):
        for block in result["system"]:
            block.pop("cache_control", None)
    return result


def configuration(body):
    """The validated subset's effective native configuration, not JSON spelling."""
    thinking = thinking_configuration(body)
    fmt = output_format(body)
    ttl = native_cache_ttl(body)
    return {
        "model": body.get("model"),
        "system": caller_system(body.get("system", "")),
        "tools": tool_schema(body.get("tools", [])),
        "max_tokens": body.get("max_tokens"),
        "output_config": {"effort": effective_effort(body),
                          **({"format": fmt} if fmt else {})},
        **({"thinking": thinking} if thinking else {}),
        # Keep old default configuration hashes; only 5m adds a mutable control.
        **({"cache_ttl": ttl} if ttl != '1h' else {}),
    }


def fixed_configuration(body):
    return {k: v for k, v in configuration(body).items()
            if k not in {"max_tokens", "output_config", "thinking", "cache_ttl"}}


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
    non_result_seen = False
    for block in content:
        if (
            not isinstance(block, dict)
            or not isinstance(block.get("type"), str)
            or block["type"] == "text" and not isinstance(block.get("text"), str)
        ):
            raise ContractError("invalid_content_block")
        if block["type"] in {"image", "document"}:
            validate_tool_content(block)
        if block["type"] == "tool_result":
            if non_result_seen:
                raise ContractError("tool_results_must_precede_text")
            inner = block.get("content", "")
            if (
                not isinstance(block.get("tool_use_id"), str)
                or type(block.get("is_error", False)) is not bool
                or not isinstance(inner, (str, list))
            ):
                raise ContractError("invalid_text_tool_result")
            children = text_blocks(inner)
            kinds = {child['type'] for child in children}
            if 'search_result' in kinds and kinds != {'search_result'}:
                raise ContractError('search_results_must_not_mix_content_types')
            for child in children:
                validate_tool_content(child)
        else:
            non_result_seen = True
    return copy.deepcopy(content)


def validate_tool_content(block):
    """Validate data shapes without fetching URLs or converting data to prose."""
    kind = block['type']
    if kind == 'text':
        return
    if kind == 'tool_reference':
        name = block.get('tool_name')
        if isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', name):
            return
    if kind in {'image', 'document'}:
        source = block.get('source')
        if isinstance(source, dict):
            source_type = source.get('type')
            url = source.get('url')
            if source_type == 'url' and isinstance(url, str) and url.startswith('https://'):
                return
            media = source.get('media_type')
            image = (kind == 'image' and source_type == 'base64'
                     and media in ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
            document = (kind == 'document' and (source_type, media) in
                        [('text', 'text/plain'), ('base64', 'application/pdf')])
            if isinstance(source.get('data'), str) and (image or document):
                return
    if kind == 'search_result' and all(isinstance(block.get(k), str) for k in ['source', 'title']):
        content = block.get('content')
        if isinstance(content, list) and all(b['type'] == 'text' for b in text_blocks(content)):
            return
    raise ContractError('unsupported_or_invalid_tool_content')


def fresh_prompt(messages):
    if not messages or any(m.get("role") not in {"user", "system"} for m in messages):
        raise ContractError("native_session_history_not_imported")
    blocks = [
        b
        for m in messages
        if m["role"] == "user"
        for b in native_blocks(m.get("content"))
    ]
    if any(b.get("type") not in {"text", "image", "document"} for b in blocks):
        raise ContractError("unsupported_initial_user_content")
    return blocks


def native_blocks(content):
    """CLI owns cache placement; caller annotations are not conversation data."""
    blocks = text_blocks(content)
    for block in blocks:
        block.pop("cache_control", None)
        if block["type"] == "tool_result":
            block["content"] = native_blocks(block.get("content", ""))
    return blocks


def message_shape(message):
    result = copy.deepcopy(message)
    result["content"] = native_blocks(result.get("content"))
    for block in result["content"]:
        if block.get("type") == "tool_use" and block.get("caller") == {
            "type": "direct"
        }:
            block.pop("caller")
    return canonical(result)


def history_shape(messages):
    return [message_shape(message) for message in messages]


def frozen_history_prefix(messages, length, history_sha, controls=None, pending=None):
    try:
        shaped = history_shape(messages)
        history, prefix = boundary.frozen_prefix(shaped, length, history_sha,
                                                signature, controls, pending)
        if prefix == length and history == shaped[:length]:
            history = messages[:length]
        return history, prefix
    except boundary.BoundaryError as error:
        raise ContractError(str(error)) from None


def checkpoint_controls(directory, state):
    try:
        return boundary.read_controls(directory, state)
    except boundary.BoundaryError as error:
        raise ContractError(str(error)) from None


def checkpoint_pending(directory, state):
    try:
        return boundary.read_pending(directory, state)
    except boundary.BoundaryError as error:
        raise ContractError(str(error)) from None


def caller_system(content):
    """The native CLI must generate its own runtime header, not inherit a caller's."""
    blocks = text_blocks(content)
    if any(block['type'] != 'text' for block in blocks):
        raise ContractError('unsupported_system_content')
    text = '\n'.join(block['text'] for block in blocks)
    first, separator, rest = text.partition('\n')
    if re.fullmatch(r'x-anthropic-billing-header: cc_version=[^;\r\n]+;[^\r\n]*', first):
        return rest if separator else ''
    return text


def initial_system(body):
    systems = [{'type': 'text', 'text': caller_system(body.get('system', ''))}]
    for message in body["messages"]:
        if message.get("role") != "system":
            break
        systems.extend(text_blocks(message.get("content")))
    if any(block.get("type") != "text" for block in systems):
        raise ContractError("prototype_only_accepts_text_system")
    return "\n".join(block["text"] for block in systems)


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


def dispatch_blocks(content):
    """Only protocol tool names cross the MCP namespace, never tool arguments."""
    result = native_blocks(content)
    for block in result:
        if block['type'] == 'tool_use':
            block['name'] = 'mcp__caller__' + block['name']
        elif block['type'] == 'tool_reference':
            block['tool_name'] = 'mcp__caller__' + block['tool_name']
        elif block['type'] == 'tool_result' and isinstance(block.get('content'), list):
            block['content'] = dispatch_blocks(block['content'])
    return result


def initial_request(body, allow_history_import=False):
    if not allow_history_import or not any(m.get('role') == 'assistant' for m in body['messages']):
        return [], fresh_prompt(body['messages'])
    try:
        return import_plan([message_shape(m) for m in body['messages']])
    except HistoryError as exc:
        raise ContractError(str(exc)) from None


class Turn:
    """Collect genuine native API events, changing only registered MCP tool names."""

    def __init__(self, tools, structured=False):
        self.structured_indices = set()
        self.structured = structured
        self.names = {"mcp__caller__" + name: name for name in tools}
        if structured:
            self.names["StructuredOutput"] = "StructuredOutput"
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
                if self.structured and block["name"] == "StructuredOutput":
                    self.structured_indices.add(event["index"])
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


def confirmed_personal_max(profile, initialized):
    """Personal plans do not receive the Team/Enterprise server-settings marker."""
    response = initialized.get("response") or {}
    account = response.get("account") or {}
    if (initialized.get("subtype") != "success" or account.get("apiProvider") != "firstParty"
            or account.get("subscriptionType") != "Claude Max"):
        return False
    try:
        if (profile.parents[2] / "current").read_text().strip() != profile.parent.name:
            return False
        if any((profile / name).exists() for name in ("policy-limits.json", "remote-settings.json")):
            return False
        oauth = json.loads((profile / ".credentials.json").read_text())["claudeAiOauth"]
        return (oauth.get("subscriptionType") == "max"
                and set(("user:inference", "user:profile")).issubset(oauth.get("scopes") or []))
    except (OSError, ValueError, KeyError, TypeError):
        return False


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
        history_profile=None,
        personal_max_profile=None,
    ):
        native_env, self.options = native_options(body)
        self.budget_options = []
        self.directory = Path(directory)
        existed = self.directory.exists()
        self.directory.mkdir(mode=0o700, exist_ok=restore)
        if session_budget_usd is not None:
            if (
                not isinstance(session_budget_usd, (int, float))
                or session_budget_usd <= 0
            ):
                raise ContractError("invalid_session_budget")
            self.budget_options = ["--max-budget-usd", str(session_budget_usd)]
            self.options += self.budget_options
        self.command, self.environment = list(command), dict(environment)
        self.inherited_thinking_display_updates = self.environment.get(
            "CLAUDE_CODE_THINKING_DISPLAY_UPDATES"
        )
        self.environment.pop("CLAUDE_CODE_RETRY_WATCHDOG", None)
        self.environment.update(native_env)
        self.environment.update(
            {
                "CLAUDE_CODE_MAX_RETRIES": "0",
                "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1",
                "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES": "0",
                # Expired provider threads trigger a second POST; each relay grant
                # permits one dispatch, so send the complete caller history.
                "CLAUDE_CODE_TETHER_LIVE": "0",
                "ENABLE_CLAUDEAI_MCP_SERVERS": "false",
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
        self.personal_max_profile = personal_max_profile
        self.personal_max_confirmed = False
        self.dispatch_proxy = dispatch_proxy
        self.history_profile = Path(history_profile) if history_profile else None
        self.dispatch_process = None
        self.dispatch_address = None
        self.dispatch_close_observation = None
        self.last_grant_id = None
        self.channel_store = None
        self.caller_request_sha = None
        self.model = body["model"]
        self.tools = tool_schema(body.get("tools", []))
        self.history = []
        self.body_signature = signature(configuration(body))
        self.fixed_signature = signature(fixed_configuration(body))
        self.checkpoint_configuration = None
        self.seen = set()
        self.pending_ids = set()
        self.events = queue.Queue()
        self.lock = threading.Lock()
        self.close_lock = threading.RLock()
        self.process = None
        self.process_has_turn = False
        self.reader = None
        self.native_id = str(uuid.uuid4())
        self.failed = False
        self.result = None
        self.result_message_id = None
        self.last_native_message_id = None
        self.native_cli_argv = None
        self.resume_uuid = None
        self.resume_message_id = None
        self.suspended = False
        self.assistants = {}
        self.assistant_ready = threading.Condition()
        self.prepared = False
        self.initialize_id = None
        self.initialize_response = None
        self.structured_checkpoint = False
        self.control_ready = threading.Condition()
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
        version = state.get("version")
        self.structured_checkpoint = version == 3 and state.get("structured_output") is True
        if version in (2, 3) and state.get("fixed_configuration") != self.fixed_signature:
            try:
                old_tools = json.loads((self.directory / "tools.json").read_text())
            except (OSError, ValueError):
                raise ContractError("native_session_recovery_unavailable") from None
            expected = signature({**fixed_configuration(body), "tools": old_tools})
        else:
            expected = self.fixed_signature
        matching = (state.get("configuration") == signature(legacy_configuration(body))
                    if version == 1 else (version == 2 or self.structured_checkpoint)
                    and state.get("fixed_configuration") in {expected, self.fixed_signature})
        if state["status"] == "prepared":
            if (
                not matching
                or state.get("system_sha256") != signature(initial_system(body))
                or list((self.directory / "dispatch").glob("*.consumed.json"))
            ):
                raise ContractError("native_session_incomplete_no_replay")
            # No user input or grant existed. Start a new empty native process;
            # never resume an old paid conversation through this branch.
            self.prepared = True
            self.adopt_checkpoint_configuration(state)
            return
        if state["status"] not in {"idle", "awaiting_tools"}:
            raise ContractError("native_session_incomplete_no_replay")
        if not matching:
            raise ContractError("session_configuration_changed")
        history, prefix = frozen_history_prefix(
            body['messages'], state['history_length'], state['history_sha256'],
            checkpoint_controls(self.directory, state), checkpoint_pending(self.directory, state))
        self.native_id = str(uuid.UUID(state["native_id"]))
        self.resume_uuid = str(uuid.UUID(state["assistant_uuid"]))
        self.resume_message_id = state.get("message_id")
        self.checkpoint_configuration = state["configuration"]
        self.history = copy.deepcopy(history)
        self.seen = {state["request_sha256"]}
        if state["status"] == "awaiting_tools":
            blocks = history[-1].get("content", []) if history else []
            ids = [b.get("id") for b in blocks if isinstance(b, dict)
                   and b.get("type") == "tool_use"]
            tail = [m for m in body["messages"][prefix:] if m.get("role") != "system"]
            results = [b.get("tool_use_id") for b in native_blocks(tail[0]["content"])
                       if b.get("type") == "tool_result"] if tail else []
            if (not ids or not tail or tail[0].get("role") != "user"
                    or history[-1].get("role") != "assistant"
                    or len(set(ids)) != len(ids) or set(results) != set(ids)
                    or len(results) != len(ids)):
                raise ContractError("native_session_incomplete_no_replay")
            self.pending_ids = set(ids)
            self.suspended = True
        self.continuation_import(body)
        self.adopt_checkpoint_configuration(state)

    def adopt_checkpoint_configuration(self, state):
        # Commit the verified boundary before tools.json changes. Ordinary
        # sessions retain v2; projected schema turns require v3-aware resume.
        updated = {**state, "version": 3 if self.structured_checkpoint else 2, "configuration": self.body_signature,
                   "fixed_configuration": self.fixed_signature}
        if updated != state:
            self.write_checkpoint(updated)
        self.checkpoint_configuration = self.body_signature

    def checkpoint(self, status, request_sha256=None, message_id=None):
        state = {"version": 3 if self.structured_checkpoint else 2,
                 "status": status, "native_id": self.native_id}
        if self.structured_checkpoint:
            state["structured_output"] = True
        if status == "prepared":
            state.update({
                "configuration": self.body_signature,
                "fixed_configuration": self.fixed_signature,
                "system_sha256": signature((self.directory / "system.txt").read_text()),
            })
        elif status in {"idle", "awaiting_tools"}:
            with self.assistant_ready:
                self.assistant_ready.wait_for(
                    lambda: message_id in self.assistants, timeout=5
                )
                assistant_uuid = self.assistants.get(message_id)
            if not assistant_uuid:
                status = state["status"] = "native_resume_point_missing"
            else:
                self.resume_uuid = str(uuid.UUID(assistant_uuid))
                self.resume_message_id = message_id
                state.update(
                    {
                        "assistant_uuid": assistant_uuid,
                        "message_id": message_id,
                        "configuration": self.body_signature,
                        "fixed_configuration": self.fixed_signature,
                        "history_length": len(self.history),
                        "history_sha256": signature(history_shape(self.history)),
                        "request_sha256": request_sha256,
                    }
                )
                try:
                    controls_sha = boundary.write_controls(
                        self.directory, history_shape(self.history), state['history_sha256'])
                    if status == 'awaiting_tools':
                        state['history_pending_sha256'] = boundary.write_pending(
                            self.directory, history_shape(self.history), state['history_sha256'])
                except boundary.BoundaryError as error:
                    raise ContractError(str(error)) from None
                if controls_sha is not None:
                    state['history_controls_sha256'] = controls_sha
        self.write_checkpoint(state)
        self.checkpoint_configuration = state.get("configuration")

    def write_checkpoint(self, state):
        path = self.directory / "continuation.json"
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
        temp = self.directory / "system.tmp"
        temp.write_text(initial_system(body))
        os.replace(temp, self.directory / "system.txt")

    def validate_configuration(self, body):
        native_options(body)
        fixed = {**fixed_configuration(body), "tools": self.tools}
        if signature(fixed) != self.fixed_signature or (
            not self.history
            and initial_system(body) != (self.directory / "system.txt").read_text()
        ):
            raise RequestRejected("session_configuration_changed")
        return signature(configuration(body)) != self.body_signature

    def continuation_import(self, body):
        """Validate context completed elsewhere after our exact paid boundary."""
        if not self.history:
            return None
        messages = body['messages']
        prefix = self.history_prefix(messages)
        tail = [m for m in messages[prefix:] if m['role'] != 'system']
        normalized = (bool(self.pending_ids) and history_shape(self.history)[-1]
                      != history_shape(messages)[prefix - 1])
        if len(tail) <= 1 and not self.structured_checkpoint and not normalized:
            return None
        if self.history_profile is None:
            raise ContractError('unsupported_history_tail')
        return initial_request(body, allow_history_import=True)

    def history_prefix(self, messages):
        try:
            return boundary.prefix_boundary(history_shape(self.history), history_shape(messages),
                                            allow_pending=bool(self.pending_ids))
        except boundary.BoundaryError as error:
            raise ContractError(str(error)) from None

    def record_pending_adoption(self, body):
        if not self.pending_ids:
            return
        prefix = self.history_prefix(body['messages'])
        previous = history_shape(self.history)[-1]
        current = history_shape(body['messages'])[prefix - 1]
        if previous == current:
            return
        record = {'version': 1, 'channel': self.directory.name,
                  'request_sha256': self.caller_request_sha,
                  'history_length': len(self.history),
                  'history_sha256': signature(history_shape(self.history)),
                  'original_assistant_sha256': signature(previous),
                  'caller_assistant_sha256': signature(current)}
        try:
            record['history_pending_sha256'] = boundary.write_pending(
                self.directory, history_shape(self.history), record['history_sha256'])
            boundary.write_witness(self.directory, self.caller_request_sha, record, 'adoptions')
        except boundary.BoundaryError as error:
            raise ContractError(str(error)) from None

    def restart_for_request(self, body):
        """Resume at a verified assistant boundary; never replay a model turn."""
        if self.history:
            try:
                state = json.loads((self.directory / "continuation.json").read_text())
            except (OSError, ValueError):
                raise ContractError("native_resume_point_missing") from None
            if (
                state.get("status") != ("awaiting_tools" if self.pending_ids else "idle")
                or state.get("native_id") != self.native_id
                or state.get("assistant_uuid") != self.resume_uuid
                or state.get("history_sha256") != signature(history_shape(self.history))
                or state.get("configuration") != self.checkpoint_configuration
            ):
                raise ContractError("native_resume_point_missing")
            if (not self.pending_ids and self.process_has_turn
                    and self.process and self.process.poll() is None):
                with self.control_ready:
                    ready = self.control_ready.wait_for(
                        lambda: self.result_message_id == self.resume_message_id,
                        timeout=min(self.timeout, 5),
                    )
                if not ready or not self.result or self.result.get("is_error"):
                    raise ContractError("native_turn_not_idle")
        self.close()
        if self.reader and self.reader.is_alive():
            raise ContractError("native_reader_not_stopped")
        # No old reader may write an EOF or terminal event into the next turn.
        self.process = self.reader = self.dispatch_process = None
        self.process_has_turn = False
        self.dispatch_address = None
        self.events = queue.Queue()
        self.initialize_id = self.initialize_response = None
        self.result = self.result_message_id = self.last_native_message_id = None
        self.suspended = False
        native_env, options = native_options(body)
        # A turn's omitted-display override must never become the next turn's
        # native default. Restore the constructor's inherited value or absence.
        self.environment.pop("CLAUDE_CODE_THINKING_DISPLAY_UPDATES", None)
        if self.inherited_thinking_display_updates is not None:
            self.environment["CLAUDE_CODE_THINKING_DISPLAY_UPDATES"] = self.inherited_thinking_display_updates
        self.environment.update(native_env)
        self.options = options + self.budget_options
        self.tools = tool_schema(body.get("tools", []))
        self.body_signature = signature(configuration(body))
        self.fixed_signature = signature(fixed_configuration(body))
        if self.history:
            self.adopt_checkpoint_configuration(state)
        elif self.prepared:
            self.checkpoint("prepared")
        (self.directory / "tools.json").write_text(json.dumps(self.tools))

    def prepare_request(self, body):
        """Prepare one caller's CLI without a prompt or model dispatch grant."""
        if not self.lock.acquire(blocking=False):
            raise RequestRejected("session_busy")
        initialization_boundary = None
        try:
            changed = self.validate_configuration(body)
            if not self.history:
                try:
                    initial_request(body, self.history_profile is not None)
                except ContractError as exc:
                    raise RequestRejected(str(exc)) from None
            if self.failed:
                raise ContractError("session_failed_no_replay")
            if changed:
                if self.history:
                    raise RequestRejected("prepare_configuration_change_requires_turn")
                self.restart_for_request(body)
            if not self.history:
                self.prepared = True
                self.checkpoint("prepared")
            initialization_boundary = self.initialization_boundary()
            reused = self.process is not None
            self.prepare()
            if not self.history:
                self.initialize_native()
            return {"ready": True, "reused": reused, "model_dispatches": 0}
        except RequestRejected:
            raise
        except Exception as exc:
            if self.preserve_initialization_boundary(exc, initialization_boundary):
                raise RequestRejected(str(exc)) from None
            self.failed = True
            self.close()
            raise
        finally:
            self.lock.release()

    def initialize_native(self):
        if self.initialize_response is None:
            self.initialize_id = str(uuid.uuid4())
            self.process.stdin.write(json.dumps({
                "type": "control_request",
                "request_id": self.initialize_id,
                "request": {"subtype": "initialize", "hooks": None},
            }) + "\n")
            self.process.stdin.flush()
            with self.control_ready:
                self.control_ready.wait_for(
                    lambda: self.initialize_response is not None
                    or self.process.poll() is not None,
                    timeout=min(self.timeout, 90),
                )
        if not self.initialize_response or self.initialize_response.get("subtype") != "success":
            raise ContractError("native_initialize_not_ready_no_dispatch")

    def prepare(self):
        if self.process is not None:
            if self.process.poll() is not None or self.failed:
                raise ContractError("native_process_not_reusable")
            if self.personal_max_confirmed and not confirmed_personal_max(
                self.personal_max_profile, self.initialize_response or {}
            ):
                raise ContractError("native_account_scope_changed")
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
        self.personal_max_confirmed = False
        if self.require_policy:
            if self.personal_max_profile is not None:
                self.initialize_native()
                self.personal_max_confirmed = confirmed_personal_max(
                    self.personal_max_profile, self.initialize_response or {}
                )
            if not self.personal_max_confirmed:
                self.await_native_policy()

    def start(self, blocks):
        self.prepare()
        self.dispatch_user_input(blocks)

    def dispatch_user_input(self, blocks):
        self.process_has_turn = True
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
        if self.channel_store is not None:
            self.channel_store.bind(self, self.caller_request_sha, self.last_grant_id)
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
        rate_limit_info = None
        rate_limit_error = None
        try:
            with self.process.stdout as stream, (
                self.directory / "stdout.private.jsonl"
            ).open("a") as log:
                for line in stream:
                    log.write(line)
                    log.flush()
                    event = json.loads(line)
                    if event.get("type") == "control_response":
                        response = event.get("response", {})
                        if response.get("request_id") == self.initialize_id:
                            with self.control_ready:
                                self.initialize_response = response
                                self.control_ready.notify_all()
                    elif event.get("type") == "stream_event":
                        self.events.put(event["event"])
                    elif event.get("type") == "rate_limit_event":
                        rate_limit_info = event.get("rate_limit_info")
                    elif event.get("type") == "assistant" and (
                        event.get("error") or event.get("is_api_error_message")
                    ):
                        error = (NativeRateLimit(self.model, rate_limit_info)
                                 if event.get("error") == "rate_limit"
                                 else ContractError("native_api_error"))
                        if isinstance(error, NativeRateLimit):
                            rate_limit_error = error
                        else:
                            self.events.put(error)
                    elif event.get("type") == "assistant" and event.get("uuid"):
                        with self.assistant_ready:
                            self.last_native_message_id = event["message"]["id"]
                            self.assistants[event["message"]["id"]] = event["uuid"]
                            if len(self.assistants) > 16:
                                self.assistants.pop(next(iter(self.assistants)))
                            self.assistant_ready.notify_all()
                    elif event.get("type") == "result":
                        rate_limit_info = None
                        with self.control_ready:
                            self.result = event
                            self.result_message_id = self.last_native_message_id
                            self.control_ready.notify_all()
                        if rate_limit_error is not None:
                            self.events.put(rate_limit_error)
                            rate_limit_error = None
                        elif event.get("is_error"):
                            self.events.put(ContractError("native_cli_error"))
                        # Keep native stream input open for the next genuine user turn.
        except Exception as exc:
            self.events.put(ContractError(type(exc).__name__))
        finally:
            if rate_limit_error is not None:
                self.events.put(rate_limit_error)
            self.events.put(None)
            with self.control_ready:
                self.control_ready.notify_all()

    def initialization_boundary(self):
        if not self.dispatch_proxy or self.failed:
            return None
        try:
            if not self.history:
                if (self.seen or self.pending_ids or self.resume_uuid
                        or self.process_has_turn or self.last_grant_id is not None):
                    return None
                self.checkpoint("prepared")
            raw = (self.directory / "continuation.json").read_bytes()
            state = json.loads(raw)
            if self.history:
                if (state.get("status") != ("awaiting_tools" if self.pending_ids else "idle")
                        or state.get("native_id") != self.native_id
                        or state.get("assistant_uuid") != self.resume_uuid
                        or state.get("message_id") != self.resume_message_id
                        or state.get("configuration") != self.checkpoint_configuration
                        or state.get("history_length") != len(self.history)
                        or state.get("history_sha256") != signature(history_shape(self.history))):
                    return None
            elif state.get("status") != "prepared":
                return None
            directory = self.directory / "dispatch"
            consumed = {p.name: p.read_bytes() for p in directory.glob("*.consumed.json")}
            grant = (directory / "grant.json").read_bytes() if (directory / "grant.json").exists() else None
            if not self.history and (consumed or grant is not None):
                return None
            return {"checkpoint": raw, "consumed": consumed, "grant": grant,
                    "last_grant": self.last_grant_id, "tools": (self.directory / "tools.json").read_bytes(),
                    "native_id": self.native_id, "resume_uuid": self.resume_uuid,
                    "resume_message_id": self.resume_message_id, "pending_ids": self.pending_ids.copy(),
                    "structured_checkpoint": self.structured_checkpoint}
        except (OSError, ValueError, TypeError):
            return None

    def preserve_initialization_boundary(self, exc, boundary):
        if (boundary is None or str(exc) != "native_initialize_not_ready_no_dispatch"
                or self.failed or self.process_has_turn
                or self.last_grant_id != boundary["last_grant"]):
            return False
        # Stop both producers, then require a fresh observation from this proxy.
        self.close()
        stats = self.dispatch_close_observation
        if (self.failed or not self.process or self.process.poll() is None
                or not self.dispatch_process or self.dispatch_process.poll() is None
                or self.reader and self.reader.is_alive()
                or not isinstance(stats, dict)
                or any(type(stats.get(k)) is not int or stats[k] != 0
                       for k in ("upstream_attempts", "denied"))):
            return False
        directory = self.directory / "dispatch"
        try:
            ready = json.loads((directory / "ready.safe.json").read_text())
            consumed = {p.name: p.read_bytes() for p in directory.glob("*.consumed.json")}
            grant = (directory / "grant.json").read_bytes() if (directory / "grant.json").exists() else None
            if (ready.get("session_id") != self.native_id
                    or self.dispatch_address != "http://" + ready.get("listen", "")
                    or consumed != boundary["consumed"] or grant != boundary["grant"]
                    or any(directory.glob("*.tmp"))
                    or (self.directory / "continuation.json").read_bytes() != boundary["checkpoint"]
                    or (self.directory / "tools.json").read_bytes() != boundary["tools"]):
                return False
        except (OSError, ValueError, TypeError):
            return False
        # The verified checkpoint was never replaced with in_flight. Retire this
        # CLI; only the next customer request may resume that same safe boundary.
        for name in ("native_id", "resume_uuid", "resume_message_id", "pending_ids", "structured_checkpoint"):
            setattr(self, name, boundary[name])
        self.prepared = not self.history
        self.suspended = True
        return True

    def request(self, body):
        if not self.lock.acquire(blocking=False):
            raise RequestRejected("session_busy")
        mutation_started = False
        initialization_boundary = None
        try:
            if self.failed:
                raise ContractError("session_failed_no_replay")
            changed = self.validate_configuration(body)
            request_signature = signature(history_shape(body["messages"]))
            self.caller_request_sha = request_signature
            if request_signature in self.seen:
                raise ContractError("request_already_consumed")
            advanced = self.continuation_import(body)
            if advanced is not None:
                self.record_pending_adoption(body)
            if not self.history or advanced is not None:
                imported, blocks = advanced or initial_request(body, self.history_profile is not None)
                mutation_started = True
                if changed or advanced is not None:
                    self.restart_for_request(body)
                initialization_boundary = self.initialization_boundary()
                if advanced is not None:
                    # Preserve the old transcript. Import only caller-owned,
                    # completed context; the sole new dispatch is the final user.
                    self.native_id = str(uuid.uuid4())
                    self.resume_uuid = self.resume_message_id = None
                    self.pending_ids = set()
                    self.structured_checkpoint = False
                if imported:
                    # A new caller-owned transcript; no other native session is read.
                    self.close()
                    self.process = self.reader = self.dispatch_process = None
                    self.dispatch_address = None
                    self.events = queue.Queue()
                    self.initialize_id = self.initialize_response = None
                    self.process_has_turn = False
                    self.resume_uuid = write_transcript(
                        self.history_profile, self.directory, self.native_id,
                        [{**m, 'content': dispatch_blocks(m['content'])} for m in imported],
                        initial_effort=effective_effort(body, leading_only=True),
                    )
                (self.directory / 'context.pending.json').write_text(
                    json.dumps(trailing_system_text(history_shape(body['messages'])))
                )
                self.prepare()
                self.prepared = False
                self.seen.add(request_signature)
                self.history = copy.deepcopy(body["messages"])
                self.checkpoint("in_flight")
                self.dispatch_user_input(dispatch_blocks(blocks))
            else:
                messages = body["messages"]
                tail = messages[self.history_prefix(messages):]
                user_tail = [m for m in tail if m.get('role') != 'system']
                if (
                    not user_tail
                    or user_tail[0].get("role") != "user"
                ):
                    raise ContractError('history_prefix_mismatch')
                if len(user_tail) != 1:
                    raise ContractError("unsupported_history_tail")
                blocks = native_blocks(user_tail[0]["content"])
                ids = [
                    b.get("tool_use_id")
                    for b in blocks
                    if b.get("type") == "tool_result"
                ]
                results = {}
                if self.pending_ids:
                    if (
                        any(b.get("type") not in {"text", "tool_result"} for b in blocks)
                        or len(set(ids)) != len(ids)
                        or set(ids) != self.pending_ids
                    ):
                        raise ContractError("tool_result_set_mismatch")
                    for block in blocks:
                        if block.get("type") == "text":
                            continue
                        content = text_blocks(block.get("content", ""))
                        results[block["tool_use_id"]] = {
                            "content": content,
                            "isError": bool(block.get("is_error", False)),
                        }
                elif any(b.get("type") not in {"text", "image", "document"} for b in blocks):
                    raise ContractError("unexpected_tool_result_or_nontext_followup")
                context_blocks = [
                    b for m in tail if m.get('role') == 'system' for b in text_blocks(m["content"])
                ]
                if any(
                    b.get("type") != "text" or not isinstance(b.get("text"), str)
                    for b in context_blocks
                ):
                    raise ContractError("prototype_only_accepts_text_system")
                contexts = [b["text"] for b in context_blocks]
                mutation_started = True
                # Native stdin treats text arriving during an MCP call as a
                # mid-turn system attachment. Resume at the actual tool-use
                # assistant instead, preserving the caller's whole user message.
                resume_tools = bool(results) and (
                    changed or self.suspended or any(b.get("type") == "text" for b in blocks)
                    or any(c['type'] != 'text' for r in results.values() for c in r['content'])
                )
                if changed or resume_tools or self.suspended:
                    self.restart_for_request(body)
                initialization_boundary = self.initialization_boundary()
                self.prepare()
                self.seen.add(request_signature)
                self.history = copy.deepcopy(messages)
                self.checkpoint("in_flight")
                if self.tool_timer:
                    self.tool_timer.cancel()
                    self.tool_timer = None
                (self.directory / "context.pending.json").write_text(
                    json.dumps(contexts)
                )
                self.authorize_dispatch()
                self.process_has_turn = True
                if results and not resume_tools:
                    for tool_id, result in results.items():
                        pending = self.directory / (tool_id + ".result.tmp")
                        pending.write_text(json.dumps(result))
                        os.replace(pending, self.directory / (tool_id + ".result.json"))
                else:
                    self.process.stdin.write(
                        json.dumps(
                            {
                                "type": "user",
                                "message": {"role": "user", "content": dispatch_blocks(blocks)},
                                "client_composed": True,
                            }
                        )
                        + "\n"
                    )
                    self.process.stdin.flush()
                self.pending_ids = set()
            structured = output_format(body) is not None
            turn = Turn([t["name"] for t in self.tools], structured=structured)
            buffered, buffer_bytes = [], 0
            terminal_usage = None
            try:
                while True:
                    event = self.events.get(timeout=self.timeout)
                    if event is None or isinstance(event, Exception):
                        self.failed = True
                        self.close()
                        if isinstance(event, NativeRateLimit):
                            raise event
                        raise ContractError("native_stream_incomplete")
                    if structured and event.get("type") != "message_start":
                        buffer_bytes += len(json.dumps(event).encode())
                        # Keep collecting real terminal usage after overflow, but
                        # never accumulate more tool JSON or response text.
                        if buffer_bytes > STRUCTURED_RESPONSE_LIMIT and event.get("type", "").startswith("content_block_"):
                            continue
                    converted = turn.event(event)
                    if structured and event.get("type") == "message_delta":
                        terminal_usage = copy.deepcopy(turn.message.get("usage", {}))
                    if structured and event.get("type") != "message_start":
                        if buffer_bytes <= STRUCTURED_RESPONSE_LIMIT:
                            buffered.append(converted)
                        if event.get("type") != "message_stop":
                            continue
                        converted_events = self.structured_events(turn, buffered, buffer_bytes)
                    else:
                        converted_events = [converted]
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
                        self.checkpoint(
                            "awaiting_tools" if self.pending_ids else "idle",
                            request_signature, turn.message["id"],
                        )
                        if self.channel_store is not None:
                            self.channel_store.complete(self, request_signature,
                                                        copy.deepcopy(turn.message.get("usage", {})))
                    yield from converted_events
                    if event.get("type") == "message_stop":
                        return
            except Exception:
                if structured and terminal_usage is not None:
                    # An observed provider delta survives CLI validation errors,
                    # truncated streams and timeouts. This is not a success or a
                    # fabricated final receipt; the request still fails below.
                    yield {"type": "message_delta", "delta": {}, "usage": terminal_usage}
                raise
        except ContractError as exc:
            if self.preserve_initialization_boundary(exc, initialization_boundary):
                raise RequestRejected(str(exc)) from None
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

    def structured_events(self, turn, events, buffer_bytes):
        """Expose only a native-validated structured result, not its private tool."""
        if buffer_bytes > STRUCTURED_RESPONSE_LIMIT:
            raise ContractError("native_structured_output_too_large")
        blocks = turn.message.get("content", [])
        external = [b for i, b in enumerate(blocks)
                    if b.get("type") == "tool_use" and i not in turn.structured_indices]
        if not turn.structured_indices and external:
            return events
        if (len(turn.structured_indices) != 1 or external
                or turn.message.get("stop_reason") != "tool_use"):
            raise ContractError("native_structured_output_incomplete_no_replay")
        with self.control_ready:
            ready = self.control_ready.wait_for(
                lambda: self.result_message_id == turn.message["id"]
                or (self.process and self.process.poll() is not None),
                timeout=min(self.timeout, 15),
            )
        result = self.result
        value = blocks[next(iter(turn.structured_indices))].get("input")
        if (not ready or self.result_message_id != turn.message["id"]
                or not isinstance(result, dict) or result.get("is_error")
                or "structured_output" not in result
                or signature(result["structured_output"]) != signature(value)):
            raise ContractError("native_structured_output_invalid_no_replay")
        text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        turn.message["content"] = [{"type": "text", "text": text}]
        turn.message["stop_reason"] = "end_turn"
        self.structured_checkpoint = True
        delta = next(e for e in reversed(events) if e.get("type") == "message_delta")
        return [
            {"type": "content_block_start", "index": 0,
             "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "text_delta", "text": text}},
            {"type": "content_block_stop", "index": 0},
            {**delta, "delta": {**delta.get("delta", {}), "stop_reason": "end_turn"},
             "usage": copy.deepcopy(turn.message.get("usage", {}))},
            {"type": "message_stop"},
        ]

    def expire_tool_wait(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            if self.pending_ids:
                # The paid turn already ended at a verified tool-use boundary.
                # Stop the idle CLI before its autonomous tool timeout, keeping
                # the checkpoint so only a new caller result can resume it.
                self.suspended = True
                self.close()
        finally:
            self.lock.release()

    def close(self, graceful=False):
        with self.close_lock:
            self._close(graceful)

    def _close(self, graceful=False):
        self.dispatch_close_observation = None
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
                        raw = response.read(4096)
                        (self.directory / "dispatch/final.safe.json").write_bytes(raw)
                        self.dispatch_close_observation = json.loads(raw)
                except (OSError, ValueError):
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
