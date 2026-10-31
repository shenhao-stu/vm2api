"""Fixed-target NAS agent. Stops only the HTTP worker; native OAuth stays alive."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

from management import read_tail
from native_health import NativeHealth


def run(args, timeout=15):
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def health(config):
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(config["health_url"], timeout=5) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        return json.load(exc)
    except (OSError, ValueError):
        return {"ok": False}


def status(config):
    native = NativeHealth(config["home"], config["binding"])
    inspection = json.loads(run(["docker", "inspect", config["container"]]))[0]
    active = subprocess.run(["systemctl", "is-active", "--quiet", config["unit"]]).returncode == 0
    h = health(config) if active else {"ok": False, "active_requests": 0}
    state = native.state()
    return {"ok": True, "container_running": inspection["State"]["Running"],
            "container_started_at": inspection["State"]["StartedAt"],
            "memory_limit_bytes": inspection["HostConfig"]["Memory"],
            "daemon_pid": state.get("daemon", {}).get("pid"),
            "daemon_started_at_ms": state.get("daemon", {}).get("started_at_ms"),
            "failed_checks": native.failed_health_checks(), "revoked": native.authorization_revoked(),
            "auth_latched": any(Path(p).exists() for p in config["auth_latches"]),
            "http_active": active, "http_ready": h.get("ok") is True,
            "management_paused": (Path(config["state_dir"]) / "management-paused").exists(),
            "active_requests": h.get("active_requests")}


def execute(config, action):
    if action == "status":
        return status(config)
    if action == "logs":
        fields = {"at", "model", "status", "complete", "attempts", "error", "native_error",
                  "duration_ms", "usage", "message_id", "authentication_latched"}
        return {"ok": True, "items": [{k: v for k, v in row.items() if k in fields}
                                      for row in read_tail(Path(config["state_dir"]) / "audit.jsonl")]}
    if action == "verify_exit":
        ips = [run(["docker", "exec", config["container"], "curl", "--noproxy", "*", "-fsS",
                    "--max-time", "18", url], 20)
               for url in ["https://api.ipify.org", "https://checkip.amazonaws.com"]]
        if ips != [config["expected_ip"], config["expected_ip"]]:
            raise ValueError("exit_mismatch")
        return {"ok": True, "ips": ips}
    if action not in ("start", "stop"):
        raise ValueError("unknown_action")
    before = status(config)
    pause = Path(config["state_dir"]) / "management-paused"
    if action == "stop":
        was_paused = pause.exists()
        pause.touch(mode=0o600)
        until = time.monotonic() + 55
        while before["http_active"]:
            h = health(config)
            pending = h.get("pool", {}).get("pending_tools_sessions")
            if type(pending) is not int or pending != 0:
                if not was_paused:
                    pause.unlink(missing_ok=True)
                raise ValueError("pending_tool_sessions_unknown" if type(pending) is not int
                                 else "pending_tool_sessions")
            if h.get("active_requests") == 0:
                break
            if time.monotonic() > until:
                raise ValueError("drain_pending")
            time.sleep(.5)
        run(["sudo", "-n", "systemctl", "stop", config["unit"]], 20)
    else:
        if (before["failed_checks"] or before["auth_latched"] or before["revoked"]
                or not before["container_running"]):
            raise ValueError("native_not_ready")
        pause.unlink(missing_ok=True)
        try:
            run(["sudo", "-n", "systemctl", "start", config["unit"]], 20)
            until = time.monotonic() + 15
            while not health(config).get("ok"):
                if time.monotonic() > until:
                    raise ValueError("http_not_ready")
                time.sleep(.2)
        except Exception:
            pause.touch(mode=0o600)
            raise
    after = status(config)
    if any(before[k] != after[k] for k in ("container_started_at", "daemon_pid", "daemon_started_at_ms")):
        raise ValueError("native_lifecycle_changed")
    return after


if __name__ == "__main__":
    os.umask(0o077)
    try:
        with open(sys.argv[1]) as file:
            config = json.load(file)
        request = json.loads(sys.stdin.read(256))
        if set(request) != {"action"}:
            raise ValueError("invalid_request")
        print(json.dumps(execute(config, request["action"])))
    except Exception:
        print(json.dumps({"ok": False, "error": "native_management_failed"}))
        sys.exit(1)
