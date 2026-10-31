"""Opt-in management of an independent native Relay, not a kin/Pro slot.

Commands and paths come only from an administrator-owned local configuration.
No HTTP input becomes a host, command, path, account ID or authorization change.
"""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid


class ManagementError(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status
        super().__init__(code)


def command(argv, action):
    try:
        p = subprocess.run(argv, input=json.dumps({"action": action}),
                           capture_output=True, text=True, timeout=85)
        if p.returncode:
            raise ManagementError("management_command_failed", 503)
        result = json.loads(p.stdout)
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise ManagementError("management_command_rejected", 503)
        return result
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise ManagementError("management_command_unavailable", 503) from None


def read_tail(path, limit=50):
    try:
        with Path(path).open("rb") as file:
            file.seek(max(0, file.seek(0, 2) - 65536))
            lines = file.read().decode("utf-8", errors="replace").splitlines()
        result = []
        for line in lines[-limit:]:
            try:
                result.append(json.loads(line))
            except ValueError:
                continue
        return result
    except FileNotFoundError:
        return []


def guard_status(config):
    try:
        g = json.loads(Path(config["guard_file"]).read_text())
        age = time.time() - datetime.fromisoformat(g["checked_at"].replace("Z", "+00:00")).timestamp()
        ready = (g.get("ready") is True and g.get("latched") is False
                 and g.get("expected_ip") == g.get("observed_ip") == config["expected_ip"]
                 and g.get("revision") == config["guard_revision"] and 0 <= age < 180)
        return {"ready": ready, "latched": g.get("latched") is not False,
                "expected_ip": config["expected_ip"], "observed_ip": g.get("observed_ip"),
                "checked_at": g.get("checked_at")}
    except (OSError, ValueError, KeyError, TypeError):
        return {"ready": False, "latched": True, "expected_ip": config["expected_ip"]}


class Manager:
    def __init__(self, config, call=command):
        self.config, self.call = config, call
        self.root = Path(config["state_dir"])
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        (self.root / "operations").mkdir(mode=0o700, exist_ok=True)
        self.lock = threading.Lock()
        self.cached = None

    def record(self, event, **data):
        with (self.root / "audit.jsonl").open("a", encoding="utf-8") as file:
            file.write(json.dumps({"at": time.time(), "event": event, **data}) + "\n")

    def runtime(self, action="status"):
        return self.call(self.config["runtime_command"], action)

    def sub(self, action="status"):
        return self.call(self.config["sub_command"], action)

    def refresh(self):
        with self.lock:
            return self._refresh()

    def _refresh(self):
        r = self.runtime()
        sub = self.sub()
        if r.get("revoked") or r.get("auth_latched"):
            # Pause first. No rebind, process restart, guard rearm or model probe.
            if sub.get("schedulable"):
                sub = self.sub("pause")
                if sub.get("schedulable") is not False:
                    raise ManagementError("sub_pause_unconfirmed", 503)
            evidence = self.root / "authorization-latch.json"
            if not evidence.exists():
                data = {"at": time.time(), "binding": self.config["binding"],
                        "sub_account": self.config["sub_account"], "paused": True,
                        "revoked": bool(r.get("revoked")), "auth_latched": bool(r.get("auth_latched"))}
                with evidence.open("x") as file:
                    json.dump(data, file)
                self.record("authorization_latched", **data)
        result = {"id": self.config["id"], "name": self.config["name"],
                  "node": self.config["node"], "kind": "reclaude_native",
                  "binding": self.config["binding"], "sub_account": self.config["sub_account"],
                  "concurrency": self.config["concurrency"], "models": self.config["models"],
                  "observed_at": time.time(), "runtime": r, "guard": guard_status(self.config),
                  "sub": sub, "authorization_latched": (self.root / "authorization-latch.json").exists()}
        self.cached = result
        return result

    def status(self):
        if self.cached and time.time() - self.cached["observed_at"] < 15:
            return self.cached
        return self.refresh()

    def logs(self):
        runtime = self.runtime("logs")
        return {"runtime": runtime.get("items", []), "management": read_tail(self.root / "audit.jsonl")}

    def action(self, action, operation_id):
        if action not in ("start", "stop"):
            raise ManagementError("unknown_action", 404)
        try:
            if str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ManagementError("invalid_operation_id", 400) from None
        if not self.lock.acquire(False):
            raise ManagementError("management_busy")
        try:
            intent = self.root / "operations" / (operation_id + ".json")
            try:
                with intent.open("x") as file:
                    json.dump({"action": action, "at": time.time()}, file)
            except FileExistsError:
                raise ManagementError("operation_already_consumed") from None
            self.record("operation_started", action=action, operation_id=operation_id)
            state = self._refresh()
            if action == "stop":
                paused = self.sub("pause")
                if paused.get("schedulable") is not False:
                    raise ManagementError("sub_pause_unconfirmed", 503)
                # Runtime refuses to stop until in-flight requests have drained.
                self.runtime("stop")
            else:
                r = state["runtime"]
                if (state["authorization_latched"] or r.get("revoked") or r.get("auth_latched")
                        or r.get("failed_checks") or not state["guard"]["ready"]
                        or not r.get("container_running")):
                    raise ManagementError("start_requires_healthy_original_binding_and_exit")
                self.runtime("verify_exit")
                self.runtime("start")
                ready = self._refresh()
                if (not ready["runtime"].get("http_ready") or not ready["guard"]["ready"]
                        or ready["authorization_latched"]):
                    raise ManagementError("relay_not_ready", 503)
                self.sub("resume")
            self.cached = None
            result = self._refresh()
            if action == "start" and not result["sub"].get("schedulable"):
                raise ManagementError("sub_resume_unconfirmed", 503)
            self.record("operation_completed", action=action, operation_id=operation_id)
            return result
        except Exception as exc:
            self.cached = None
            self.record("operation_failed", action=action, operation_id=operation_id,
                        code=exc.code if isinstance(exc, ManagementError) else "management_internal_error")
            raise
        finally:
            self.lock.release()
