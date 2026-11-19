"""Read one enrolled device's status and official quota. Accept no lifecycle commands."""
import json
from pathlib import Path
import subprocess
import sys
import time

from management import official_quota
from official_windows import normalize_windows


def read_status(config):
    home = Path(config["home"])
    binding = str(config["binding"])
    state = json.loads((home / "state.json").read_bytes())
    identity = state.get("identities", {}).get("claude", {})
    running = subprocess.check_output(
        ["docker", "inspect", "--format={{.State.Running}}", config["container"]],
        text=True, timeout=8).strip() == "true"
    current = (home / "claude/current").read_text().strip()
    checks = []
    if current != binding or binding not in (identity.get("bindings") or {}):
        checks.append("binding_missing")
    if not state.get("daemon", {}).get("running") or not identity.get("gateway", {}).get("healthy"):
        checks.append("native_not_ready")
    error = identity.get("last_error") or state.get("last_error")
    if error:
        checks.append("native_reported_error")
    windows = None
    try:
        data = json.loads(Path(config["account_windows"]["path"]).read_bytes())
        if data.get("ok") is True:
            windows = normalize_windows(config, data, int(time.time() * 1000))
    except (ValueError, KeyError, TypeError, OSError):
        pass
    guard = json.loads(Path(config["guard_file"]).read_bytes())
    allowed = ("ready", "latched", "expected_ip", "observed_ip", "revision", "checked_at")
    return {"ok": True, "device": config["binding"], "org": config["account_windows"]["org"],
            "running": running, "failed_checks": checks, "revoked": "device_revoked" in str(error),
            "guard": {k: guard.get(k) for k in allowed}, "windows": windows, "seat": official_quota(config)}


if __name__ == "__main__":
    if json.load(sys.stdin) != {"action": "status"}:
        sys.exit(2)
    print(json.dumps(read_status(json.loads(Path(sys.argv[1]).read_bytes()))))
