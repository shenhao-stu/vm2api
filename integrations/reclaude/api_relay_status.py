"""Read-only VM panel status for the independently deployed Airoam relay."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time
import urllib.error
import urllib.request

from management import ManagementError
from management_server import panel_admin

PATH = "/api/panel/airoam-relay"


def relay_status(url, legacy_models):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(url, timeout=2)
    except urllib.error.HTTPError as exc:
        if exc.code != 503:
            raise
        response = exc
    with response:
        health = json.loads(response.read(8192))
    pool = health["pool"]
    slots = health.get("execution_slots", pool["capacity"])
    active = health["active_requests"]
    resident, capacity = pool["resident"], pool["capacity"]
    models = health.get("models", legacy_models)
    if (
        type(health["ok"]) is not bool or type(health["management_paused"]) is not bool
        or not isinstance(models, list) or not models or len(models) > 32
        or any(not isinstance(m, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", m) for m in models)
        or any(type(x) is not int for x in (slots, active, resident, capacity))
        or not 0 <= active <= slots <= 32 or not 0 <= resident <= capacity <= 500
    ):
        raise ValueError("invalid relay health")
    return {
        "state": "paused" if health["management_paused"] else ("ready" if health["ok"] else "unavailable"),
        "models": models, "active_requests": active, "execution_slots": slots,
        "resident_sessions": resident, "resident_capacity": capacity,
        "observed_at": time.time(),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.connection.settimeout(8)
        if self.path != PATH:
            return self.send_json(404, {"error": {"code": "not_found"}})
        try:
            self.server.authorize(self.headers.get("Authorization", ""))
        except ManagementError as exc:
            return self.send_json(exc.status, {"error": {"code": exc.code}})
        try:
            return self.send_json(200, self.server.read_status())
        except (OSError, ValueError, KeyError, TypeError):
            return self.send_json(200, {"state": "unknown", "models": []})

    def send_json(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, authorize, read_status):
        super().__init__(("127.0.0.1", port), Handler)
        self.authorize = authorize
        self.read_status = read_status
        self.connections = threading.BoundedSemaphore(8)

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--panel-port", type=int, required=True)
    parser.add_argument("--relay-port", type=int, required=True)
    parser.add_argument("--legacy-model", action="append", required=True)
    args = parser.parse_args()
    with Server(
        args.port,
        lambda auth: panel_admin(f"http://127.0.0.1:{args.panel_port}/api/panel/me", auth),
        lambda: relay_status(f"http://127.0.0.1:{args.relay_port}/healthz", args.legacy_model),
    ) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
