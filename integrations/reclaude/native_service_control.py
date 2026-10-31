"""systemd helpers for the independent HTTP worker; never stop native OAuth."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import time

from native_health import NativeHealth


def check_bind(host, port):
    with socket.socket() as sock:
        # Match HTTPServer.allow_reuse_address: a completed health connection's
        # TIME_WAIT is not an active listener. Do not enable SO_REUSEPORT.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))


def prepare(root, home, binding, host, port):
    if NativeHealth(home, binding).failed_health_checks() or (root / "auth-latch.json").exists():
        raise RuntimeError("native_not_ready")
    check_bind(host, port)
    for name in ("server.ready.safe.json", "server.stopped.safe.json"):
        (root / name).unlink(missing_ok=True)


def stop(root):
    ready = root / "server.ready.safe.json"
    if not ready.exists():
        return
    pid = json.loads(ready.read_text())["pid"]
    if type(pid) is not int or pid <= 1:
        raise ValueError("invalid_http_pid")
    process = Path("/proc") / str(pid)
    if not process.exists():
        return
    args = (process / "cmdline").read_bytes().split(b"\0")
    if b"native_http.py" not in args or str(root).encode() not in args:
        raise RuntimeError("http_pid_identity_mismatch")
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 60
    while process.exists() and time.monotonic() < deadline:
        time.sleep(.2)
    if process.exists():
        raise RuntimeError("http_stop_incomplete")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "stop"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--binding", type=int, required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.root, args.home, args.binding, args.host, args.port)
    else:
        stop(args.root)
