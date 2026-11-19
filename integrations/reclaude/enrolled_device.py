"""Authenticated console view of a bound native device awaiting an inference endpoint."""
import time

from management import Manager, ManagementError, guard_status


class EnrolledDevice(Manager):
    def __init__(self, config, **kwargs):
        if config.get("sub_account") is not None or "sub_command" in config or config["concurrency"] != 0:
            raise ValueError("enrolled device cannot own a scheduler")
        super().__init__(config, **kwargs)

    def _refresh(self):
        report = self.runtime()
        if (report.get("org"), report.get("device")) != (self.config["org"], self.config["binding"]):
            raise ManagementError("native_device_scope_mismatch", 503)
        view = {k: self.config[k] for k in ("id", "name", "node", "binding", "sub_account", "concurrency", "models")}
        self.cached = {
            **view, "kind": "reclaude_native", "enrollment_only": True, "observed_at": time.time(),
            "guard": guard_status(self.config, report["guard"]), "authorization_latched": False,
            "runtime": {"container_running": report["running"], "failed_checks": report["failed_checks"],
                        "official_windows": report["windows"], "http_active": False, "http_ready": False,
                        "active_requests": 0, "revoked": report["revoked"], "auth_latched": False},
            "official_quota": report["seat"], "usage": None,
            "sub": {"schedulable": False, "shared_policy_matches": False},
        }
        return self.cached

    def logs(self):
        status = self.status()
        return {"runtime": [{"at": status["observed_at"], "event": "device_status",
                             "failed_checks": status["runtime"]["failed_checks"]}], "management": []}

    def action(self, operation, operation_id):
        raise ManagementError("native_inference_endpoint_not_configured", 409)
