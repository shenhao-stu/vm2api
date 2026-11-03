"""Loopback management API using the existing main panel's live admin auth."""
import argparse
import http.server
import json
import os
import re
import time
from pathlib import Path
import threading
import urllib.error
import urllib.request

from management import ManagementError, Manager

PREFIX = "/api/panel/native-relays"


def panel_admin(url, authorization):
    if not authorization.startswith("Bearer ") or len(authorization) > 4096:
        raise ManagementError("panel_login_required", 401)
    request = urllib.request.Request(url, headers={"Authorization": authorization})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5) as response:
            result = json.load(response)
        if result.get("data", result).get("role") != "admin":
            raise ManagementError("admin_required", 403)
    except urllib.error.HTTPError as exc:
        raise ManagementError("panel_login_required", 401 if exc.code == 401 else 403) from None
    except (OSError, ValueError):
        raise ManagementError("panel_auth_unavailable", 503) from None


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def handle_request(self):
        self.connection.settimeout(10)
        try:
            self.server.authorize(self.headers.get("Authorization", ""))
            if self.command == "GET" and self.path == PREFIX:
                return self.send(200, {"ok": True, "items": self.server.statuses()})
            parts = self.path.removeprefix(PREFIX + "/").split("/")
            if not self.path.startswith(PREFIX + "/") or len(parts) != 2:
                raise ManagementError("not_found", 404)
            manager = self.server.managers.get(parts[0])
            if manager is None:
                raise ManagementError("not_found", 404)
            operation = parts[1]
            if self.command == "GET" and operation == "logs":
                return self.send(200, {"ok": True, "data": manager.logs()})
            if self.command == "POST" and operation in ("start", "stop", "pause_schedule", "resume_schedule"):
                if self.headers.get("Origin") != manager.config["origin"]:
                    raise ManagementError("origin_required", 403)
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise ManagementError("json_required", 415)
                if self.headers.get("Transfer-Encoding"):
                    raise ManagementError("invalid_body", 400)
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size <= 256:
                        raise ValueError()
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict) or set(body) != {"operation_id"}:
                        raise ValueError()
                except (ValueError, TypeError):
                    raise ManagementError("invalid_body", 400) from None
                value = manager.action(operation, body["operation_id"])
                return self.send(200, {"ok": True, "data": value})
            raise ManagementError("not_found", 404)
        except ManagementError as exc:
            self.send(exc.status, {"ok": False, "error": {"code": exc.code, "message": exc.code}})
        except Exception:
            self.send(503, {"ok": False, "error": {"code": "management_unavailable", "message": "management_unavailable"}})

    do_GET = do_POST = handle_request


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, manager, authorize=None):
        if address[0] != "127.0.0.1":
            raise ValueError("management must bind loopback")
        entries = manager if isinstance(manager, (list, tuple)) else [manager]
        if not entries:
            raise ValueError("at least one native relay is required")
        configs = [entry.config for entry in entries]
        for field in ("id", "binding", "sub_account", "state_dir"):
            values = [str(Path(c[field]).resolve()) if field == "state_dir" else c[field] for c in configs]
            if len(set(values)) != len(values):
                raise ValueError("duplicate native relay " + field)
        for field in ("runtime_command", "sub_command"):
            if len({tuple(c[field]) for c in configs}) != len(configs):
                raise ValueError("duplicate native relay " + field)
        if any(not re.fullmatch(r"[A-Za-z0-9_-]+", c["id"]) for c in configs):
            raise ValueError("invalid native relay id")
        if any(c.get("panel_me_url") != configs[0].get("panel_me_url")
               or c["origin"] != configs[0]["origin"] for c in configs):
            raise ValueError("native relays must share the panel authentication boundary")
        super().__init__(address, Handler)
        self.managers = {entry.config["id"]: entry for entry in entries}
        self.authorize = authorize or (lambda value: panel_admin(configs[0]["panel_me_url"], value))
        self.connections = threading.BoundedSemaphore(8)

    def statuses(self):
        if len(self.managers) == 1:
            return [next(iter(self.managers.values())).status()]
        # Independent monitors perform SSH I/O. A slow account cannot stall the list.
        items = []
        for manager in self.managers.values():
            cached = manager.cached
            if cached and time.time() - cached["observed_at"] < 90:
                items.append(cached)
                continue
            item = {key: manager.config[key] for key in
                    ("id", "name", "node", "binding", "sub_account", "concurrency", "models")}
            items.append({**item, "kind": "reclaude_native", "observed_at": 0,
                          "authorization_latched": (manager.root / "authorization-latch.json").exists(),
                          "guard": {"ready": False, "expected_ip": manager.config["expected_ip"]},
                          "runtime": {"failed_checks": ["management_unavailable"], "http_ready": False},
                          "sub": {"schedulable": None}, "management_unavailable": True})
        return items

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
    parser.add_argument("--config", required=True, action="append")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    managers = [Manager(json.loads(Path(path).read_text())) for path in args.config]
    server = Server(("127.0.0.1", args.port), managers)
    stopped = threading.Event()

    def monitor(manager):
        while not stopped.is_set():
            try:
                manager.refresh()
            except Exception:
                manager.cached = None
            stopped.wait(30)

    for manager in managers:
        threading.Thread(target=monitor, args=(manager,), daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stopped.set()
        server.server_close()


if __name__ == "__main__":
    main()
