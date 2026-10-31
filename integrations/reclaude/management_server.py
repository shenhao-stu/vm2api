"""Loopback management API using the existing main panel's live admin auth."""
import argparse
import http.server
import json
import os
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
            manager = self.server.manager
            self.server.authorize(self.headers.get("Authorization", ""))
            path = PREFIX + "/" + manager.config["id"]
            if self.command == "GET" and self.path == PREFIX:
                return self.send(200, {"ok": True, "items": [manager.status()]})
            if self.command == "GET" and self.path == path + "/logs":
                return self.send(200, {"ok": True, "data": manager.logs()})
            if self.command == "POST" and self.path in (path + "/start", path + "/stop"):
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
                value = manager.action(self.path.rsplit("/", 1)[1], body["operation_id"])
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
        super().__init__(address, Handler)
        self.manager = manager
        self.authorize = authorize or (lambda value: panel_admin(manager.config["panel_me_url"], value))
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
    parser.add_argument("--config", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    with open(args.config) as file:
        manager = Manager(json.load(file))
    server = Server(("127.0.0.1", args.port), manager)
    stopped = threading.Event()

    def monitor():
        while not stopped.is_set():
            try:
                manager.refresh()
            except Exception:
                manager.cached = None
            stopped.wait(30)

    threading.Thread(target=monitor, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stopped.set()
        server.server_close()


if __name__ == "__main__":
    main()
