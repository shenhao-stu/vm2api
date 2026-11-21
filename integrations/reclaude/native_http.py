"""Candidate native-CLI backend; keep outside shared routing until accepted.

Reuses the existing relay's HTTP limits, authentication and bounded audit.
This supported subset requires an explicit caller session and text history.
"""

import argparse
import hashlib
import ipaddress
import json
import os
import re
from pathlib import Path
import select
import signal
import socket
import threading
import time
from urllib.parse import urlsplit

from adapter import Limits, Rejection, RelayHandler, RelayServer, load_relay_key, request_trace
from native_bridge_session import ContractError, NativeProviderError, NativeRateLimit, RequestRejected, Session, Turn
from native_session_pool import SessionPool, memory_pressure, session_key
from native_health import NativeHealth, validate_official
from native_bridge_session import history_shape, signature
from native_reply_cache import REPLAYABLE, ZERO_USAGE, ReplyCache, without_usage
from native_launch_backoff import LAUNCH_REFUSED, LaunchBackoff
from native_terminal_error import unbilled_gateway_failure

# Refusals that start nothing and clear once another turn on this relay ends.
ADMISSION_WAIT_CODES = frozenset({"session_busy", "native_session_capacity"})


class NativeServer(RelayServer):
    request_queue_size = 32

    def __init__(
        self,
        address,
        health,
        key,
        root,
        factory,
        *,
        limits,
        proof=lambda: True,
        idle_seconds=1800,
        private_host=None,
        max_requests=None,
        recover=None,
        allow_prewarm=False,
        prepared_idle_seconds=120,
        memory_high_bytes=0,
        memory_current_file=Path("/sys/fs/cgroup/memory.current"),
        allow_history_import=False,
        configuration_channels=False,
        require_principal=False,
        resident_capacity=None,
    ):
        if type(memory_high_bytes) is not int or memory_high_bytes < 0:
            raise ValueError("invalid_memory_high_bytes")
        root = Path(root)
        root.mkdir(mode=0o700, exist_ok=True)
        if private_host:
            host = ipaddress.ip_address(private_host)
            if not host.is_private or host.is_unspecified or host.is_multicast:
                raise ValueError("explicit private host required")
        super().__init__(
            address,
            health,
            key,
            root / "audit.jsonl",
            limits=limits,
            latch_file=root / "auth-latch.json",
            allowed_bind_hosts=(private_host,) if private_host else (),
        )
        self.RequestHandlerClass = NativeHandler
        self.pool = SessionPool(
            root / "sessions",
            factory,
            limits.concurrency if resident_capacity is None else resident_capacity,
            idle_seconds,
            recover=recover,
            prepared_idle_seconds=prepared_idle_seconds,
            under_pressure=lambda: memory_pressure(memory_current_file, memory_high_bytes),
            allow_history_import=allow_history_import,
            configuration_channels=configuration_channels,
        )
        self.memory_high_bytes = memory_high_bytes
        self.maintenance_error = None
        self.tenant = hashlib.sha256(key.encode()).hexdigest()
        self.require_principal = require_principal
        self.proof = proof
        self.allow_prewarm = allow_prewarm
        self.stop_reaper = threading.Event()
        self.max_requests = max_requests
        self.accepted = 0
        self.counter_lock = threading.Lock()
        self.active_requests = 0
        self.management_pause = root / "management-paused"
        self.replies = ReplyCache(root / "replies")
        self.launches = LaunchBackoff()
        # A caller whose conversation is mid-turn, or whose relay has no free CLI,
        # waits here for a bounded time instead of being refused. Waiters keep their
        # execution permit; the caps stop one conversation from holding all of them.
        self.admission_wait_seconds = 45.0
        self.admission_waiters_per_session = 3
        self.admission_waiters_total = max(1, limits.concurrency // 2)
        self.admission_lock = threading.Lock()
        self.admission_waiting = {}
        self.reaper = threading.Thread(target=self.reap, daemon=True)
        self.reaper.start()

    def reap(self):
        while not self.stop_reaper.wait(30):
            self.maintain_pool()

    def maintain_pool(self):
        self.replies.sweep()
        reclaimed, error = 0, None
        try:
            reclaimed = self.pool.expire()
        except ContractError as exc:
            error = str(exc)
        if reclaimed or error != self.maintenance_error:
            self.audit({"at": time.time(), "operation": "pool_maintenance",
                        "attempts": 0, "retired": reclaimed, "error": error,
                        "status": 503 if error else 200})
        self.maintenance_error = error

    def server_close(self):
        self.stop_reaper.set()
        self.reaper.join(timeout=1)
        self.pool.close()
        super().server_close()


def collect(observation, event):
    if event["type"] == "message_start":
        observation.message = json.loads(json.dumps(event["message"]))
    elif event["type"] == "content_block_start":
        block = event["content_block"]
        observation.message["content"].append(json.loads(json.dumps(block)))
        if block["type"] == "tool_use":
            observation.inputs[event["index"]] = ""
    else:
        observation.event(event)


def safe_thinking_summary(thinking):
    """Bounded diagnostic enums only; never retain arbitrary caller values or keys."""
    if not isinstance(thinking, dict):
        return {"shape": "other"}
    keys = sorted(key for key in ("type", "display", "budget_tokens") if key in thinking)
    result = {"shape": "object", "keys": keys, "unknown_key_count": len(thinking) - len(keys)}
    for field, allowed in (
        ("type", ("adaptive", "enabled", "disabled")),
        ("display", ("summarized", "omitted", "updates", "highlights")),
    ):
        value = thinking.get(field)
        result["mode" if field == "type" else field] = (
            "absent" if field not in thinking else value if value in allowed else "other"
        )
    return result


def consumed_gateway_status(receipts):
    """Only the grant consumed by this HTTP request can explain its failure."""
    if len(receipts) != 1:
        return None
    receipt = next(iter(receipts))
    grant = receipt.name.removesuffix(".consumed.json")
    try:
        witness = json.loads(receipt.with_name(grant + ".gateway-error.json").read_bytes())
        if (not isinstance(witness, dict) or witness.get("id") != grant
                or json.loads(receipt.read_bytes()).get("id") != grant):
            return None
        status = witness.get("status")
        return status if type(status) is int and status in (502, 503, 504) else None
    except (OSError, ValueError, AttributeError):
        return None


def refused_unbilled(session):
    """This turn's own failure is already proved to be an unbilled gateway refusal."""
    try:
        directory = session.directory
        state = json.loads((directory / "continuation.json").read_bytes())
        claims = {path.stem: json.loads(path.read_bytes())
                  for path in (directory / "caller-grants").glob("*.json")}
        request = unbilled_gateway_failure(directory, state, claims)
        return request is not None and request == session.caller_request_sha
    except (OSError, ValueError, AttributeError):
        return False


def failure_status(error, code, expired=False):
    """Conversation evidence failures must not invite another account to retry."""
    if isinstance(error, Rejection):
        return error.status
    if code in {'session_busy', 'native_session_capacity', 'native_memory_pressure', 'native_rate_limit'}:
        return 429
    if (code.endswith('_no_replay') or code in {
        'request_already_consumed', 'history_prefix_mismatch', 'session_configuration_changed',
        'native_session_recovery_unavailable', 'native_session_history_not_imported',
        'native_session_evidence_unknown', 'native_channel_evidence_unknown',
        'native_pending_tools_no_branch', 'native_channel_ambiguous', 'native_channel_collision',
    }):
        return 400
    if expired:
        return 504
    if 'not_ready' in code:
        return 503
    return 400 if isinstance(error, RequestRejected) or not code.startswith('native_') else 502


class NativeHandler(RelayHandler):
    def lease_session(self, tenant, body):
        return self.server.pool.lease(tenant, body)

    def authenticated_tenant(self):
        tenant = self.server.tenant
        if self.server.require_principal:
            principals = self.headers.get_all('X-Native-Relay-Principal', [])
            if len(principals) != 1 or not re.fullmatch(r'[0-9a-f]{64}', principals[0]):
                raise Rejection(400, 'authenticated_relay_principal_required')
            tenant = hashlib.sha256((tenant + ':' + principals[0]).encode()).hexdigest()
        return tenant

    def send_json(self, status, body):
        if not getattr(self, "request_body_read", False):
            return super().send_json(status, body)
        # Close-delimited JSON makes EOF follow accounting and lease release.
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
        self.wfile.flush()

    def do_GET(self):
        if self.path != "/healthz":
            return self.send_error_json(404, "not_found")
        failed = self.server.relay.failed_health_checks()
        if "native_device_revoked" in failed:
            self.server.latch()
        if self.server.latched:
            failed.append("authentication_latched")
        if self.server.maintenance_error:
            failed.append(self.server.maintenance_error)
        with self.server.counter_lock:
            paused = self.server.management_pause.exists()
            active = self.server.active_requests
        self.send_json(503 if failed or paused else 200, {
            "ok": not failed and not paused, "failed": failed,
            "management_paused": paused, "active_requests": active,
            "pool": self.server.pool.snapshot(),
            "execution_slots": self.server.limits.concurrency,
            "models": list(self.server.limits.models),
            "memory_high_bytes": self.server.memory_high_bytes,
            "history_import_enabled": self.server.pool.allow_history_import,
            "launch_backoff": self.server.launches.snapshot(),
        })

    def caller_gone(self):
        """The body was read whole and nothing may follow it on this connection,
        so a readable socket can only mean the caller closed its side."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def join_admission_queue(self, key):
        server = self.server
        with server.admission_lock:
            waiting = server.admission_waiting.get(key, 0)
            if (waiting >= server.admission_waiters_per_session
                    or sum(server.admission_waiting.values()) >= server.admission_waiters_total):
                return False
            server.admission_waiting[key] = waiting + 1
            return True

    def leave_admission_queue(self, key):
        server = self.server
        with server.admission_lock:
            left = server.admission_waiting[key] - 1
            if left:
                server.admission_waiting[key] = left
            else:
                del server.admission_waiting[key]

    def lease_when_admitted(self, tenant, body, record, started, expired, may_wait):
        """Enter the conversation's lease, waiting while it is busy or the relay is full.

        Both refusals come before anything is started and clear when another turn
        on this relay ends, so the caller would only retry them. Waiting dispatches
        nothing, is bounded by half the request budget, and stops for a caller who
        has gone away.
        """
        server = self.server
        key = record["session_pool_key"]
        queued = False
        waited_from = deadline = None
        delay = 0.05
        try:
            while True:
                context = self.lease_session(tenant, body)
                try:
                    return context, context.__enter__()
                except ContractError as error:
                    if (not may_wait or str(error) not in ADMISSION_WAIT_CODES
                            or expired.is_set()):
                        raise
                    now = time.monotonic()
                    if waited_from is None:
                        waited_from = now
                        record["admission_wait_code"] = str(error)
                        budget = server.limits.request_seconds / 2 - (now - started)
                        deadline = now + min(server.admission_wait_seconds, budget)
                        queued = self.join_admission_queue(key)
                        if not queued:
                            record["admission_queue_full"] = True
                            raise
                    if now >= deadline:
                        raise
                    pause = min(delay, deadline - now)
                time.sleep(pause)
                delay = min(1.0, delay * 2)
                if self.caller_gone():
                    raise Rejection(499, "caller_disconnected_while_waiting")
        finally:
            if queued:
                self.leave_admission_queue(key)
            if waited_from is not None:
                record["admission_wait_ms"] = round((time.monotonic() - waited_from) * 1000)

    def serve_replay(self, body, record, code, started):
        """Answer an identical repeat from the completed turn. Never dispatches."""
        try:
            scope, model = record["session_pool_key"], body["model"]
            request = signature(history_shape(body["messages"]))
        except (KeyError, TypeError, ContractError):
            return False
        replies = self.server.replies
        reply = replies.load(scope, request, model)
        if reply is None and code == "native_request_in_flight_no_replay":
            # A waiting repeat runs nothing, so it gives its execution slot back.
            self.server.inference.release()
            self.permit_released = True
            remaining = self.server.limits.request_seconds - (time.monotonic() - started) - 5
            reply = replies.join(scope, request, model, remaining)
        if reply is None:
            return False
        record.update(replayed=True, replay_of=code, usage=dict(ZERO_USAGE),
                      message_id=reply["message"].get("id"))
        try:
            self.send_response(200)
            self.send_header("Connection", "close")
            if body.get("stream"):
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                for event in reply["events"]:
                    event = without_usage(event)
                    encoded = ("event: " + event["type"] + "\ndata: "
                               + json.dumps(event, separators=(",", ":")) + "\n\n").encode()
                    record["response_bytes"] += len(encoded)
                    self.wfile.write(encoded)
            else:
                encoded = json.dumps({**reply["message"], "usage": dict(ZERO_USAGE)}).encode()
                record["response_bytes"] += len(encoded)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(encoded)
            self.wfile.flush()
            record.update(status=200, complete=True)
        except OSError:
            record["status"] = 499
        return True

    def do_POST(self):
        self.request_body_read = False
        parsed = urlsplit(self.path)
        prewarm = parsed.path == "/v1/messages/prepare" and self.server.allow_prewarm
        if parsed.path != "/v1/messages" and not prewarm:
            return self.send_error_json(404, "not_found")
        if not self.authorized():
            return self.send_error_json(401, "invalid_relay_key")
        if (
            parsed.query not in {"", "beta=true"}
            or parsed.scheme
            or parsed.netloc
            or parsed.fragment
        ):
            return self.send_error_json(400, "invalid_query")
        if self.server.latched:
            return self.send_error_json(503, "upstream_authentication_latched")
        with self.server.counter_lock:
            if self.server.management_pause.exists():
                return self.send_error_json(503, "native_not_ready")
            if not self.server.inference.acquire(False):
                return self.send_error_json(429, "relay_concurrency_limit")
            self.server.active_requests += 1
        self.close_connection = True
        record = {
            "at": time.time(),
            "attempts": 0,
            "complete": False,
            "response_bytes": 0,
            "operation": "prepare" if prewarm else "messages",
        }
        request_id = self.headers.get("X-Request-ID", "")
        if re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", request_id):
            record["gateway_request_id"] = request_id
        started = time.monotonic()
        committed = False
        disconnected = False
        session = None
        iterator = None
        timer = None
        before = set()
        expired = threading.Event()
        observation = Turn([])
        lease = None
        body = None
        reply_key = None
        request_signature = None
        sent_events = []
        self.permit_released = False
        launch_epoch = None
        launch_settled = False

        def expire():
            expired.set()
            if session:
                session.failed = True
                session.close()
            try:
                self.connection.shutdown(2)
            except OSError:
                pass

        timer = threading.Timer(self.server.limits.request_seconds, expire)
        timer.daemon = True
        timer.start()
        try:
            raw, body = self.read_message()
            self.request_body_read = True
            tenant = self.authenticated_tenant()
            record.update(request_trace(body, len(raw)))
            record["session_pool_key"] = session_key(tenant, body)
            record.update(
                {
                    "model": body["model"],
                    "stream": body.get("stream", False),
                    "request_sha256": hashlib.sha256(raw).hexdigest(),
                }
            )
            failed = self.server.relay.failed_health_checks()
            if "native_device_revoked" in failed:
                self.server.latch()
            if failed or not self.server.proof():
                record["readiness_failures"] = failed or ["official_proof_unavailable"]
                raise Rejection(503, "native_not_ready")
            launch_epoch, launch_wait = self.server.launches.admit()
            if launch_epoch is None:
                # A recent launch got no policy confirmation. Start nothing, but a
                # turn this relay already finished can still be answered again.
                record["launch_backoff_seconds"] = launch_wait
                if not prewarm and self.serve_replay(
                        body, record, "request_already_consumed", started):
                    return
                # The pause is about starting CLIs. A conversation whose own CLI
                # is already running starts nothing, so it is still served. Its
                # outcome neither ends nor lengthens the pause.
                if prewarm or not self.server.pool.running(tenant, body):
                    raise Rejection(503, LAUNCH_REFUSED)
                record["launch_backoff_bypassed"] = True
            lease_started = time.monotonic()
            # A launch probe decides whether launches resume; it is never held back.
            lease, session = self.lease_when_admitted(
                tenant, body, record, started, expired,
                may_wait=not prewarm and launch_epoch in (None, 0))
            record["pool_lease_ms"] = round((time.monotonic() - lease_started) * 1000)
            process = getattr(session, "process", None)
            record["native_cli_reused"] = process is not None and process.poll() is None
            before = set((session.directory / "dispatch").glob("*.consumed.json"))
            if launch_epoch is None and not record["native_cli_reused"]:
                # The CLI went away between the check and the lease.
                raise Rejection(503, LAUNCH_REFUSED)
            if ("admission_wait_ms" in record and launch_epoch == 0
                    and not record["native_cli_reused"] and self.server.launches.snapshot()["failures"]):
                # A launch failed while this caller waited; its pause covers this launch too.
                raise Rejection(503, LAUNCH_REFUSED)
            if prewarm:
                result = session.prepare_request(body)
                if not result["reused"]:
                    # Only a launch that just happened proves the provider answered.
                    self.server.launches.succeeded()
                    launch_settled = True
                result["idle_ttl_seconds"] = (
                    self.server.pool.prepared_idle_seconds
                    if session.prepared else self.server.pool.idle_seconds
                )
                self.send_json(200, result)
                record.update(status=200, complete=True, reused=result["reused"])
                return
            with self.server.counter_lock:
                if (
                    self.server.max_requests is not None
                    and self.server.accepted >= self.server.max_requests
                ):
                    raise Rejection(429, "canary_budget_consumed")
                self.server.accepted += 1
            request_signature = signature(history_shape(body["messages"]))
            reply_key = self.server.replies.begin(record["session_pool_key"], request_signature)
            iterator = session.request(body)
            first = next(iterator)
            if launch_epoch is not None:
                self.server.launches.succeeded()
                launch_settled = True
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.send_header("X-Accel-Buffering", "no")
                committed = True
                try:
                    self.end_headers()
                except OSError:
                    disconnected = True

            def events():
                yield first
                yield from iterator

            for event in events():
                if (
                    "first_content_ms" not in record
                    and event.get("type") == "content_block_delta"
                    and event.get("delta", {}).get("type") == "text_delta"
                    and event["delta"].get("text")
                ):
                    record["first_content_ms"] = round((time.monotonic() - started) * 1000)
                collect(observation, event)
                sent_events.append(event)
                encoded = (
                    "event: "
                    + event["type"]
                    + "\ndata: "
                    + json.dumps(event, separators=(",", ":"))
                    + "\n\n"
                ).encode()
                record["response_bytes"] += len(encoded)
                if record["response_bytes"] > self.server.limits.response_bytes:
                    raise Rejection(502, "upstream_response_too_large")
                if body.get("stream") and not disconnected:
                    try:
                        self.wfile.write(encoded)
                        self.wfile.flush()
                    except OSError:
                        disconnected = True
                if observation.message:
                    record.update(
                        {
                            "message_id": observation.message["id"],
                            "usage": observation.message.get("usage", {}),
                        }
                    )
                if event["type"] == "message_stop":
                    record["complete"] = True
            if record["complete"]:
                self.server.replies.store(record["session_pool_key"], request_signature,
                                          body["model"], observation.message, sent_events)
            if not body.get("stream") and not disconnected:
                try:
                    encoded = json.dumps(observation.message).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Connection", "close")
                    committed = True
                    self.end_headers()
                    self.wfile.write(encoded)
                    self.wfile.flush()
                except OSError:
                    disconnected = True
            record["status"] = 499 if disconnected else 200
            if disconnected:
                # The generator has committed its genuine terminal checkpoint.
                # Retire the transport, retaining history and consumed grants.
                session.suspended = True
                session.close(graceful=True)
        except Exception as exc:
            if session and not isinstance(exc, RequestRejected):
                session.failed = True
                session.close()
            code = (
                exc.code
                if isinstance(exc, Rejection)
                else (
                    str(exc).split(" ", 1)[0]
                    if isinstance(exc, ContractError)
                    else "native_transport_error"
                )
            )
            if expired.is_set():
                code = "native_request_deadline"
            if code == LAUNCH_REFUSED and launch_epoch is not None and not launch_settled:
                self.server.launches.failed(launch_epoch)
                launch_settled = True
            if (code in REPLAYABLE and not committed and not prewarm
                    and self.serve_replay(body, record, code, started)):
                return
            error_details = dict(exc.details) if isinstance(exc, (NativeRateLimit, NativeProviderError)) else None
            if error_details:
                record["upstream_error"] = error_details
            if code == "unsupported_thinking_configuration" and isinstance(body, dict):
                record["thinking"] = safe_thinking_summary(body.get("thinking"))
            if code == "unsupported_request_parameter" and isinstance(body, dict):
                # Only public API field names, never arbitrary keys or values.
                known = {'model', 'messages', 'system', 'tools', 'metadata', 'max_tokens',
                         'stream', 'thinking', 'output_config', 'context_management',
                         'tool_choice', 'temperature', 'cache_control', 'top_p', 'top_k',
                         'stop_sequences', 'service_tier', 'betas', 'extra_body',
                         'speed', 'inference_geo', 'container', 'mcp_servers'}
                record['parameter_keys'] = sorted(set(body) & known)
                record['unknown_parameter_count'] = len(set(body) - known)
            status = failure_status(exc, code, expired.is_set())
            consumed = (
                set((session.directory / "dispatch").glob("*.consumed.json")) - before
                if session else set()
            )
            if code == "native_request_consumed_no_replay":
                error_details = {"no_replay": True}
                record["no_replay"] = True
            if not committed and consumed:
                # A 5xx can make an upstream pool redispatch this paid turn.
                # An inadmissible turn must not be retried by a pool or SDK.
                upstream_status = consumed_gateway_status(consumed)
                if upstream_status is not None:
                    code = "native_upstream_gateway_error"
                    error_details = {"upstream_type": "gateway_error", "upstream_status": upstream_status}
                    record["upstream_error"] = error_details
                record["native_error"] = code
                if upstream_status in (502, 503) and refused_unbilled(session):
                    # Nothing was produced or counted, so the same request is
                    # admitted again. Still a 400: the caller decides to resend,
                    # a pool must not move the turn to another account by itself.
                    status = 400
                    error_details = {**error_details, "retry": "same_request"}
                    record["retry_same_request"] = True
                else:
                    status, code = 400, "native_request_consumed_no_replay"
                    record['no_replay'] = True
                    if error_details:
                        error_details = {**error_details, "no_replay": True}
                if self.server.relay.authorization_revoked():
                    self.server.latch()
                    code = 'device_revoked'
            record.update({"error": code, "status": 499 if disconnected else status})
            if not committed:
                try:
                    self.send_error_json(status, code, error_details)
                except OSError:
                    record["status"] = 499
            elif not disconnected and not record["complete"]:
                try:
                    self.wfile.write(
                        (
                            "event: error\ndata: "
                            + json.dumps(
                                {
                                    "type": "error",
                                    "error": {"type": "api_error", "message": code,
                                              **({"details": error_details} if error_details else {})},
                                }
                            )
                            + "\n\n"
                        ).encode()
                    )
                    self.wfile.flush()
                except OSError:
                    pass
        finally:
            if timer:
                timer.cancel()
            try:
                if iterator:
                    iterator.close()
                if session:
                    consumed = set(
                        (session.directory / "dispatch").glob("*.consumed.json")
                    )
                    record["attempts"] = len(consumed - before)
                if self.server.relay.authorization_revoked():
                    self.server.latch()
                record["duration_ms"] = round((time.monotonic() - started) * 1000)
                record["authentication_latched"] = self.server.latched
                self.server.audit(record)
            finally:
                try:
                    if lease:
                        lease.__exit__(None, None, None)
                finally:
                    self.server.replies.finish(reply_key)
                    if launch_epoch is not None and not launch_settled:
                        self.server.launches.release(launch_epoch)
                    if not self.permit_released:
                        self.server.inference.release()
                    with self.server.counter_lock:
                        self.server.active_requests -= 1


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument("--home", type=Path, required=True)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--key-file", type=Path, required=True)
    p.add_argument("--dispatch-proxy", type=Path, required=True)
    p.add_argument("--binding", type=int, required=True)
    p.add_argument("--org", type=int, required=True)
    p.add_argument("--model", action="append", required=True)
    p.add_argument("--port", type=int, default=18786)
    p.add_argument("--concurrency", type=int, default=1)
    p.add_argument("--max-body-mib", type=int, choices=range(1, 33), default=8)
    p.add_argument("--reclaude", default="/opt/native/reclaude")
    p.add_argument("--private-host")
    p.add_argument("--proof-file", type=Path)
    p.add_argument("--max-requests", type=int)
    p.add_argument("--session-budget-usd", type=float)
    p.add_argument("--idle-seconds", type=float, default=1800)
    p.add_argument("--recognize-personal-max", action="store_true")
    p.add_argument("--allow-prewarm", action="store_true")
    p.add_argument("--allow-history-import", action="store_true")
    p.add_argument("--prepared-idle-seconds", type=float, default=120)
    p.add_argument("--memory-high-bytes", type=int, default=0)
    p.add_argument("--memory-current-file", type=Path, default=Path("/sys/fs/cgroup/memory.current"))
    p.add_argument("--configuration-channels", action="store_true")
    args = p.parse_args()
    if args.configuration_channels and args.session_budget_usd is not None:
        p.error("configuration channels require an account budget, not a per-CLI session budget")
    limits = Limits(models=tuple(args.model), concurrency=args.concurrency,
                    body_bytes=args.max_body_mib * 1024 * 1024)
    health = NativeHealth(args.home, args.binding)
    env = {
        "HOME": str(args.home),
        "USER": "reclaude",
        "LOGNAME": "reclaude",
        "PATH": "/opt/native:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "TZ": "UTC",
        "TERM": "dumb",
    }

    def factory(directory, body):
        return Session(
            directory,
            [args.reclaude, "--org", str(args.org), "cli"],
            env,
            body,
            timeout=limits.request_seconds,
            require_policy=True,
            personal_max_profile=(args.home / ".rec/claude/accounts" / str(args.binding) / "config"
                                  if args.recognize_personal_max else None),
            dispatch_proxy=args.dispatch_proxy,
            restore=True,
            session_budget_usd=args.session_budget_usd,
            history_profile=(args.home / '.rec/claude/accounts' / str(args.binding) / 'config'
                             if args.allow_history_import else None),
        )

    def proof():
        if args.proof_file is None:
            return True

        try:
            validate_official(
                json.loads(args.proof_file.read_text()),
                args.binding,
                args.org,
                time.time() * 1000,
            )
            return True
        except (OSError, ValueError, KeyError, TypeError):
            return False

    server = NativeServer(
        (args.private_host or "127.0.0.1", args.port),
        health,
        load_relay_key(args.key_file),
        args.root,
        factory,
        limits=limits,
        proof=proof,
        private_host=args.private_host,
        max_requests=args.max_requests,
        idle_seconds=args.idle_seconds,
        recover=factory,
        allow_prewarm=args.allow_prewarm,
        prepared_idle_seconds=args.prepared_idle_seconds,
        memory_high_bytes=args.memory_high_bytes,
        memory_current_file=args.memory_current_file,
        allow_history_import=args.allow_history_import,
        configuration_channels=args.configuration_channels,
    )

    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    (args.root / "server.ready.safe.json").write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "listen": server.server_address,
                "concurrency": args.concurrency,
                "max_body_bytes": limits.body_bytes,
                "models": args.model,
                "idle_seconds": args.idle_seconds,
                "prepared_idle_seconds": server.pool.prepared_idle_seconds,
                "memory_high_bytes": args.memory_high_bytes,
                "history_import_enabled": args.allow_history_import,
                "configuration_channels_enabled": args.configuration_channels,
            }
        )
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()
        (args.root / "server.stopped.safe.json").write_text(
            json.dumps({"accepted_requests": server.accepted})
        )


if __name__ == "__main__":
    main()
