#!/usr/bin/env python3
"""Single-account, loopback-only Messages relay through a native ReClaude daemon.

Adapted from the reviewed reclaude2api server handoff (2026-10-28).
No request retries, fabricated client identity, conversation storage or direct fallback.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import socket
import ssl
import threading
import time
import zlib
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Mapping
from urllib.parse import urlsplit

OAUTH_BETA = "oauth-2025-04-20"
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
              "te", "trailer", "transfer-encoding", "upgrade"}
USAGE_KEYS = {"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"}
AUTH_ERRORS = {"device_revoked", "invalid_sk", "authentication_error", "auth_revoked"}


@dataclass(frozen=True)
class Config:
    credentials: Path
    ca_file: Path
    key_file: Path
    proxy_url: str | None
    identity_file: Path | None = None
    upstream_host: str = "api.anthropic.com"
    upstream_port: int = 443
    socket_timeout: float = 120
    state_file: Path | None = None


@dataclass(frozen=True)
class Limits:
    body_bytes: int = 8 * 1024 * 1024
    response_bytes: int = 64 * 1024 * 1024
    request_seconds: float = 600
    receive_seconds: float = 20
    models: tuple[str, ...] = ("claude-sonnet-4-6",)
    concurrency: int = 1

    def __post_init__(self):
        if min(self.body_bytes, self.response_bytes, self.request_seconds, self.receive_seconds) <= 0:
            raise ValueError("limits must be positive")
        if not self.models or any(not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", m) for m in self.models):
            raise ValueError("an explicit model allowlist is required")
        if type(self.concurrency) is not int or not 1 <= self.concurrency <= 32:
            raise ValueError("concurrency must be an integer from 1 to 32")


class Rejection(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)


def load_access_token(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    oauth = data.get("claudeAiOauth", data)
    token = oauth.get("accessToken") or oauth.get("access_token")
    if not isinstance(token, str) or not token.strip():
        raise ValueError("authorization JSON has no access token")
    return token.strip()


def load_relay_key(path: Path) -> str:
    if path.stat().st_mode & 0o077:
        raise ValueError("relay key permissions must be 0600 or stricter")
    key = path.read_text(encoding="utf-8").strip()
    if len(key) < 32 or not key.isascii():
        raise ValueError("relay key must contain at least 32 ASCII characters")
    return key


def load_account_uuid(path: Path) -> str:
    account = json.loads(path.read_text(encoding="utf-8")).get("oauthAccount", {})
    value = account.get("accountUuid") or account.get("account_uuid")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("identity JSON has no account UUID")
    return value.strip()


def discover_binding(rec_home: Path) -> tuple[Path, Path]:
    found = sorted((rec_home / "claude/accounts").glob("*/config/.credentials.json"))
    if len(found) != 1:
        raise ValueError("expected exactly one credentialed ReClaude binding")
    return found[0], found[0].parent / ".claude.json"


def native_authorization_revoked(state_file: Path | None) -> bool:
    if state_file is None:
        return False
    state = json.loads(state_file.read_text(encoding="utf-8"))
    error = json.dumps(state.get("last_error"), separators=(",", ":"))
    return re.search(r"\b(?:device_revoked|invalid_sk)\b", error) is not None


def complete_account_uuid(body: bytes, account_uuid: str) -> bytes:
    """Fill the absent gateway-token account UUID; never replace caller device/session IDs."""
    try:
        data = json.loads(body)
        user_id = data.get("metadata", {}).get("user_id")
        parsed = json.loads(user_id) if isinstance(user_id, str) else None
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        return body
    if not isinstance(parsed, dict) or parsed.get("account_uuid") or parsed.get("accountUuid"):
        return body
    parsed["account_uuid"] = account_uuid
    data["metadata"]["user_id"] = json.dumps(parsed, separators=(",", ":"))
    return json.dumps(data, separators=(",", ":")).encode()


def proxy_address(proxy_url: str) -> tuple[str, int]:
    parsed = urlsplit(proxy_url)
    if (parsed.scheme != "http" or parsed.username or parsed.password or parsed.path
            or parsed.query or parsed.fragment or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}):
        raise ValueError("ReClaude daemon must be an unauthenticated loopback HTTP proxy")
    return parsed.hostname, parsed.port or 80


def current_proxy_address(config: Config) -> tuple[str, int]:
    if config.proxy_url:
        return proxy_address(config.proxy_url)
    if config.state_file is None:
        raise ValueError("native daemon state is required")
    daemon = json.loads(config.state_file.read_text(encoding="utf-8")).get("daemon", {})
    port = daemon.get("port")
    if daemon.get("running") is not True or type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("native daemon is not ready")
    return "127.0.0.1", port


def open_tls_tunnel(config: Config, on_socket=lambda _socket: None) -> ssl.SSLSocket:
    sock = socket.create_connection(current_proxy_address(config), timeout=10)
    try:
        on_socket(sock)
        target = f"{config.upstream_host}:{config.upstream_port}"
        sock.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode("ascii"))
        response = bytearray()
        while not response.endswith(b"\r\n\r\n"):
            byte = sock.recv(1)
            if not byte or len(response) > 65536:
                raise ConnectionError("invalid daemon CONNECT response")
            response.extend(byte)
        status = bytes(response).split(b"\r\n", 1)[0].split(b" ", 2)
        if len(status) < 2 or status[1] != b"200":
            raise ConnectionError("daemon CONNECT rejected")
        context = ssl.create_default_context(cafile=str(config.ca_file))
        tls = context.wrap_socket(sock, server_hostname=config.upstream_host)
        on_socket(tls)
        tls.settimeout(config.socket_timeout)
        return tls
    except Exception:
        sock.close()
        raise


def include_oauth_beta(value: str) -> str:
    betas = [x.strip() for x in value.split(",") if x.strip()]
    return ",".join(betas if OAUTH_BETA in betas else [*betas, OAUTH_BETA])


def hop_headers(headers: Mapping[str, str]) -> set[str]:
    connection = next((v for k, v in headers.items() if k.lower() == "connection"), "")
    return HOP_BY_HOP | {x.strip().lower() for x in connection.split(",")}


def upstream_headers(headers: Mapping[str, str], token: str) -> dict[str, str]:
    blocked = hop_headers(headers) | {"host", "content-length", "accept-encoding", "authorization", "x-api-key", "cookie",
                                    "forwarded", "x-real-ip", "x-admin-token"}
    result = {k: v for k, v in headers.items() if k.lower() not in blocked and not k.lower().startswith("x-forwarded-")}
    beta = next((k for k in result if k.lower() == "anthropic-beta"), "anthropic-beta")
    result[beta] = include_oauth_beta(result.get(beta, ""))
    if not any(k.lower() == "anthropic-version" for k in result):
        result["anthropic-version"] = "2023-06-01"
    result["Authorization"] = f"Bearer {token}"
    result["Accept-Encoding"] = "identity"
    return result


def response_chunks(response, limit: int):
    """Decode before SSE inspection; cap expanded bytes and retain incremental delivery."""
    encoding = response.getheader("content-encoding", "").strip().lower()
    if encoding not in {"", "identity", "gzip"}:
        raise Rejection(502, "upstream_encoding_unsupported")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == "gzip" else None

    def chunks():
        total = 0
        while packet := response.read1(65536):
            while True:
                cap = min(65536, limit - total + 1)
                try:
                    decoded = decoder.decompress(packet, cap) if decoder else packet
                except zlib.error:
                    raise Rejection(502, "upstream_compression_invalid") from None
                total += len(decoded)
                if total > limit:
                    raise Rejection(502, "upstream_response_too_large")
                if decoder and decoder.unused_data:
                    raise Rejection(502, "upstream_compression_invalid")
                if decoded:
                    yield decoded
                if not decoder:
                    break
                packet = decoder.unconsumed_tail
                if not packet and len(decoded) < cap:
                    break
        if decoder and not decoder.eof:
            raise Rejection(502, "upstream_compression_incomplete")
    return chunks()


def validate_body(body: bytes, limits: Limits) -> dict:
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise Rejection(400, "invalid_json") from None
    if not isinstance(data, dict):
        raise Rejection(400, "invalid_message_request")
    if data.get("model") not in limits.models:
        raise Rejection(400, "model_not_supported")
    if not isinstance(data.get("messages"), list) or not data["messages"]:
        raise Rejection(400, "messages_required")
    if type(data.get("max_tokens")) is not int or data["max_tokens"] <= 0:
        raise Rejection(400, "invalid_max_tokens")
    if type(data.get("stream", False)) is not bool:
        raise Rejection(400, "invalid_stream")
    return data


def request_trace(data: dict, body_size: int) -> dict:
    """Only bounded counters and an opaque session digest, never prompts or headers."""
    identity = data.get("metadata", {}).get("user_id") if isinstance(data.get("metadata"), dict) else None
    return {"model": data["model"], "stream": data.get("stream", False), "input_bytes": body_size,
            "messages": len(data["messages"]), "tools": len(data.get("tools", [])) if isinstance(data.get("tools", []), list) else 0,
            "identity_sha256": hashlib.sha256(identity.encode()).hexdigest() if isinstance(identity, str) else None}


def usage_counters(value: object) -> dict:
    return {k: v for k, v in value.items() if k in USAGE_KEYS and type(v) is int and v >= 0} if isinstance(value, dict) else {}


def authentication_error(value: object) -> bool:
    return isinstance(value, dict) and any(
        isinstance(value.get(k), str) and value[k] in AUTH_ERRORS for k in ("code", "type"))


class StreamObservation:
    """Bounded SSE metadata observer; forwards original response bytes unchanged."""
    def __init__(self):
        self.buffer = b""
        self.dropping = False
        self.terminal = False
        self.error = False
        self.auth_error = False
        self.usage = {}

    def feed(self, chunk: bytes):
        self.buffer = (self.buffer + chunk).replace(b"\r\n", b"\n")
        while b"\n\n" in self.buffer:
            frame, self.buffer = self.buffer.split(b"\n\n", 1)
            if not self.dropping and len(frame) <= 262144:
                raw = b"\n".join(x[5:].lstrip() for x in frame.split(b"\n") if x.startswith(b"data:"))
                try:
                    data = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    data = None
                if isinstance(data, dict):
                    self.terminal |= data.get("type") == "message_stop"
                    self.error |= data.get("type") == "error"
                    error = data.get("error", {})
                    self.auth_error |= authentication_error(error)
                    self.usage.update(usage_counters(data.get("usage")))
                    message = data.get("message")
                    if isinstance(message, dict):
                        self.usage.update(usage_counters(message.get("usage")))
            self.dropping = False
        if len(self.buffer) > 262144:
            self.buffer = self.buffer[-2:]
            self.dropping = True


class ReClaudeRelay:
    def __init__(self, config: Config):
        self.config = config

    def authorization_revoked(self):
        return native_authorization_revoked(self.config.state_file)

    def failed_health_checks(self) -> list[str]:
        failed = []
        for name, operation in [("credentials", lambda: load_access_token(self.config.credentials)),
                                ("identity", lambda: load_account_uuid(self.config.identity_file) if self.config.identity_file else None),
                                ("ca", lambda: ssl.create_default_context(cafile=str(self.config.ca_file))),
                                ("proxy", lambda: socket.create_connection(current_proxy_address(self.config), timeout=2).close())]:
            try:
                operation()
            except (OSError, ValueError, AttributeError):
                failed.append(name)
        try:
            if self.authorization_revoked():
                failed.append("native_device_revoked")
        except (OSError, ValueError, AttributeError):
            failed.append("native_state_unavailable")
        return failed

    def open_upstream(self, method: str, path: str, headers: Mapping[str, str], body: bytes, *, on_socket=lambda _socket: None):
        token = load_access_token(self.config.credentials)
        if self.config.identity_file:
            body = complete_account_uuid(body, load_account_uuid(self.config.identity_file))
        tls = open_tls_tunnel(self.config, on_socket)
        connection = http.client.HTTPConnection(self.config.upstream_host, self.config.upstream_port)
        connection.sock = tls
        connection.relay_socket = tls  # HTTPConnection may clear .sock for a Connection: close response.
        try:
            connection.request(method, path, body=body, headers=upstream_headers(headers, token))
            return connection, connection.getresponse()
        except Exception:
            connection.close()
            raise


def shutdown_socket(sock):
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class RelayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, relay, relay_key, trace_file=None, *, limits=Limits(), latch_file=None):
        if address[0] not in {"127.0.0.1", "::1", "localhost"}:
            raise ValueError("relay must listen on loopback")
        self.relay, self.relay_key, self.limits = relay, relay_key, limits
        self.latch_file = latch_file
        self.latched = bool(latch_file and latch_file.exists())
        self.inference = threading.BoundedSemaphore(limits.concurrency)
        self.connections = threading.BoundedSemaphore(limits.concurrency + 8)
        self.trace_handler = None
        if trace_file:
            fd = os.open(trace_file, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.fchmod(fd, 0o600)
            os.close(fd)
            self.trace_handler = RotatingFileHandler(trace_file, maxBytes=5*1024*1024, backupCount=3, encoding="utf-8")
        super().__init__(address, RelayHandler)

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(self.limits.receive_seconds)
        return sock, address

    def process_request(self, request, client_address):
        if not self.connections.acquire(False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def latch(self):
        self.latched = True
        if self.latch_file:
            try:
                with os.fdopen(os.open(self.latch_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as f:
                    json.dump({"at": time.time(), "code": "upstream_authentication_failed"}, f)
            except FileExistsError:
                pass

    def audit(self, record):
        if self.trace_handler:
            message = json.dumps(record, separators=(",", ":"))
            self.trace_handler.handle(logging.LogRecord("relay.audit", logging.INFO, "", 0, message, (), None))

    def server_close(self):
        super().server_close()
        if self.trace_handler:
            self.trace_handler.close()


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ReClaudeRelay/1.0"
    server: RelayServer

    def log_message(self, *_args):
        pass  # Base handler includes untrusted paths/headers; bounded audit records replace it.

    def do_GET(self):
        if self.path != "/healthz":
            return self.send_error_json(404, "not_found")
        failed = self.server.relay.failed_health_checks()
        if self.server.latched:
            failed.append("authentication_latched")
        self.send_json(503 if failed else 200, {"ok": not failed, "failed": failed})

    def authorized(self):
        supplied = []
        for name in ["Authorization", "x-api-key"]:
            values = self.headers.get_all(name, [])
            if len(values) > 1:
                return False
            if values:
                value = values[0]
                if name == "Authorization":
                    if not value.lower().startswith("bearer "):
                        return False
                    value = value[7:].strip()
                supplied.append(value)
        return bool(supplied) and all(len(x) <= 512 and hmac.compare_digest(x.encode(), self.server.relay_key.encode()) for x in supplied)

    def read_message(self):
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
            raise Rejection(400, "content_length_required")
        if self.headers.get_content_type() != "application/json" or self.headers.get("Content-Encoding"):
            raise Rejection(415, "json_required")
        try:
            length = int(self.headers["Content-Length"])
        except ValueError:
            raise Rejection(400, "invalid_content_length") from None
        if length <= 0 or length > self.server.limits.body_bytes:
            raise Rejection(413, "request_body_too_large")
        body = self.rfile.read(length)
        if len(body) != length:
            raise Rejection(400, "incomplete_request_body")
        return body, validate_body(body, self.server.limits)

    def do_POST(self):
        parsed = urlsplit(self.path)
        if parsed.path != "/v1/messages":
            return self.send_error_json(404, "not_found")
        if not self.authorized():
            return self.send_error_json(401, "invalid_relay_key")
        if parsed.query not in {"", "beta=true"} or parsed.scheme or parsed.netloc or parsed.fragment:
            return self.send_error_json(400, "invalid_query")
        if self.server.latched:
            return self.send_error_json(503, "upstream_authentication_latched")
        if not self.server.inference.acquire(False):
            return self.send_error_json(429, "relay_concurrency_limit")
        started = time.monotonic()
        record = {"at": time.time(), "attempts": 0, "response_bytes": 0, "complete": False}
        connection = response = None
        committed = False
        streaming = False
        expired = threading.Event()
        observation = StreamObservation()
        transport = [None]
        def register(sock):
            transport[0] = sock
            if expired.is_set():
                shutdown_socket(sock)
        def expire():
            expired.set()
            shutdown_socket(transport[0])
            shutdown_socket(getattr(connection, "relay_socket", None))
            shutdown_socket(self.connection)
        timer = threading.Timer(self.server.limits.request_seconds, expire)
        timer.daemon = True
        timer.start()
        try:
            body, data = self.read_message()
            record.update(request_trace(data, len(body)))
            if self.server.relay.authorization_revoked():
                self.server.latch()
                raise Rejection(503, "upstream_authentication_latched")
            record["attempts"] = 1
            connection, response = self.server.relay.open_upstream("POST", self.path, self.headers, body, on_socket=register)
            if expired.is_set():
                raise TimeoutError()
            record["status"] = response.status
            request_id = response.getheader("request-id", "") or ""
            record["upstream_request_id"] = request_id if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id) else None
            record["ttfb_ms"] = round((time.monotonic() - started) * 1000)
            if response.status == 401:
                self.server.latch()
            streaming = response.getheader("content-type", "").split(";", 1)[0].strip().lower() == "text/event-stream"
            chunks = response_chunks(response, self.server.limits.response_bytes)
            self.send_response(response.status)
            blocked = hop_headers(dict(response.getheaders())) | {"content-length", "content-encoding", "set-cookie"}
            for name, value in response.getheaders():
                if name.lower() not in blocked:
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            committed = self.close_connection = True
            json_body = bytearray()
            for chunk in chunks:
                record["response_bytes"] += len(chunk)
                if streaming:
                    observation.feed(chunk)
                    if observation.auth_error:
                        self.server.latch()
                else:
                    if len(json_body) + len(chunk) > self.server.limits.body_bytes:
                        raise Rejection(502, "upstream_json_too_large")
                    json_body.extend(chunk)
                self.wfile.write(chunk)
                self.wfile.flush()
            if expired.is_set():
                raise TimeoutError()
            if streaming:
                record["usage"] = observation.usage
                record["complete"] = observation.terminal and not observation.error
                if response.status < 400 and not observation.terminal and not observation.error:
                    raise Rejection(502, "upstream_stream_incomplete")
                if observation.error:
                    record["error"] = "upstream_stream_error"
            else:
                payload = json.loads(json_body)
                if isinstance(payload, dict):
                    record["usage"] = usage_counters(payload.get("usage"))
                    record["complete"] = payload.get("type") == "message" and bool(payload.get("stop_reason"))
                    error = payload.get("error", {})
                    if authentication_error(error):
                        self.server.latch()
                if response.status < 400 and not record["complete"]:
                    record["error"] = "upstream_json_incomplete"
        except Exception as error:
            code = error.code if isinstance(error, Rejection) else (
                "request_deadline" if expired.is_set() else "transport_timeout" if isinstance(error, TimeoutError) else "transport_error")
            record["error"] = code
            if not committed:
                status = error.status if isinstance(error, Rejection) else 504 if isinstance(error, TimeoutError) else 502
                try:
                    self.send_error_json(status, code)
                except OSError:
                    pass
            elif streaming and not observation.terminal:
                payload = {"type": "error", "error": {"type": "api_error", "code": code, "message": code}}
                try:
                    self.wfile.write(b"event: error\ndata: " + json.dumps(payload).encode() + b"\n\n")
                    self.wfile.flush()
                except OSError:
                    pass
        finally:
            timer.cancel()
            for resource in [response, connection]:
                if resource:
                    try:
                        resource.close()
                    except OSError:
                        record["cleanup_error"] = True
            record["duration_ms"] = round((time.monotonic() - started) * 1000)
            record["authentication_latched"] = self.server.latched
            try:
                self.server.audit(record)
            finally:
                self.server.inference.release()

    def send_error_json(self, status, code):
        self.send_json(status, {"type": "error", "error": {"type": "api_error", "code": code, "message": code}})

    def send_json(self, status, value):
        payload = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(payload)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rec-home", type=Path, required=True)
    parser.add_argument("--ca-file", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--proxy-url", help="Explicit loopback daemon URL; otherwise read its current native state on every request")
    parser.add_argument("--port", type=int, default=18786)
    parser.add_argument("--trace-file", type=Path, required=True)
    parser.add_argument("--latch-file", type=Path, required=True)
    parser.add_argument("--model", action="append", required=True)
    parser.add_argument("--concurrency", type=int, default=1)
    args = parser.parse_args()
    credentials, identity = discover_binding(args.rec_home)
    config = Config(credentials, args.ca_file, args.key_file, args.proxy_url, identity,
                    state_file=args.rec_home / "state.json")
    current_proxy_address(config)
    relay = ReClaudeRelay(config)
    if relay.failed_health_checks():
        raise SystemExit("ReClaude local readiness failed")
    server = RelayServer(("127.0.0.1", args.port), relay, load_relay_key(args.key_file), args.trace_file,
                         limits=Limits(models=tuple(args.model), concurrency=args.concurrency), latch_file=args.latch_file)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
