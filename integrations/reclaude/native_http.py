"""Candidate native-CLI backend; keep outside shared routing until accepted.

Reuses the existing relay's HTTP limits, authentication and bounded audit.
This supported subset requires an explicit caller session and text history.
"""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import signal
import threading
import time
from urllib.parse import urlsplit

from adapter import Limits, Rejection, RelayHandler, RelayServer, load_relay_key
from native_bridge_session import ContractError, RequestRejected, Session, Turn
from native_session_pool import SessionPool, memory_pressure
from native_health import NativeHealth, validate_official


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
            limits.concurrency,
            idle_seconds,
            recover=recover,
            prepared_idle_seconds=prepared_idle_seconds,
            under_pressure=lambda: memory_pressure(memory_current_file, memory_high_bytes),
        )
        self.memory_high_bytes = memory_high_bytes
        self.maintenance_error = None
        self.tenant = hashlib.sha256(key.encode()).hexdigest()
        self.proof = proof
        self.allow_prewarm = allow_prewarm
        self.stop_reaper = threading.Event()
        self.max_requests = max_requests
        self.accepted = 0
        self.counter_lock = threading.Lock()
        self.active_requests = 0
        self.management_pause = root / "management-paused"
        self.reaper = threading.Thread(target=self.reap, daemon=True)
        self.reaper.start()

    def reap(self):
        while not self.stop_reaper.wait(30):
            self.maintain_pool()

    def maintain_pool(self):
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


class NativeHandler(RelayHandler):
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
            "memory_high_bytes": self.server.memory_high_bytes,
        })

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
                raise Rejection(503, "native_not_ready")
            context = self.server.pool.lease(self.server.tenant, body)
            lease_started = time.monotonic()
            session = context.__enter__()
            record["pool_lease_ms"] = round((time.monotonic() - lease_started) * 1000)
            process = getattr(session, "process", None)
            record["native_cli_reused"] = process is not None and process.poll() is None
            lease = context
            before = set((session.directory / "dispatch").glob("*.consumed.json"))
            if prewarm:
                result = session.prepare_request(body)
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
            iterator = session.request(body)
            first = next(iterator)
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
                session.failed = True
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
            status = (
                exc.status
                if isinstance(exc, Rejection)
                else (
                    429
                    if code in {"session_busy", "native_session_capacity", "native_memory_pressure"}
                    else (
                        400
                        if code
                        in {
                            "native_session_expired_no_replay",
                            "native_session_failed_no_replay",
                            "native_session_incomplete_no_replay",
                            "native_session_recovery_unavailable",
                            "history_prefix_mismatch",
                            "session_configuration_changed",
                            "request_already_consumed",
                        }
                        else (
                            504
                            if expired.is_set()
                            else (
                                503
                                if "not_ready" in code
                                else 502 if code.startswith("native_") else 400
                            )
                        )
                    )
                )
            )
            consumed = (
                set((session.directory / "dispatch").glob("*.consumed.json")) - before
                if session else set()
            )
            if not committed and consumed:
                # A 5xx can make an upstream pool redispatch this paid turn.
                # An inadmissible turn must not be retried by a pool or SDK.
                record["native_error"] = code
                status, code = 400, "native_request_consumed_no_replay"
            record.update({"error": code, "status": 499 if disconnected else status})
            if not committed:
                try:
                    self.send_error_json(status, code)
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
                                    "error": {"type": "api_error", "message": code},
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
    p.add_argument("--reclaude", default="/opt/native/reclaude")
    p.add_argument("--private-host")
    p.add_argument("--proof-file", type=Path)
    p.add_argument("--max-requests", type=int)
    p.add_argument("--session-budget-usd", type=float)
    p.add_argument("--idle-seconds", type=float, default=1800)
    p.add_argument("--allow-prewarm", action="store_true")
    p.add_argument("--prepared-idle-seconds", type=float, default=120)
    p.add_argument("--memory-high-bytes", type=int, default=0)
    p.add_argument("--memory-current-file", type=Path, default=Path("/sys/fs/cgroup/memory.current"))
    args = p.parse_args()
    limits = Limits(models=tuple(args.model), concurrency=args.concurrency)
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
            dispatch_proxy=args.dispatch_proxy,
            restore=True,
            session_budget_usd=args.session_budget_usd,
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
                "models": args.model,
                "idle_seconds": args.idle_seconds,
                "prepared_idle_seconds": server.pool.prepared_idle_seconds,
                "memory_high_bytes": args.memory_high_bytes,
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
