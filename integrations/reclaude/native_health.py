"""Native account and control-plane readiness; never reauthorize automatically."""

from datetime import datetime, timezone
import json
import math
from pathlib import Path


def current_account_needs_review(error, daemon_started_at):
    if not isinstance(error, dict) or error.get("kind") != "account_sync_failed":
        return False
    observed_at = error.get("at_ms")
    if type(observed_at) is not int or type(daemon_started_at) is not int or observed_at < daemon_started_at:
        return False
    detail = error.get("detail")
    prefix = "sync current account: unexpected status 403: "
    if not isinstance(detail, str) or not detail.startswith(prefix):
        return False
    try:
        response = json.loads(detail[len(prefix):])
    except ValueError:
        return False
    failure = response.get("error") if isinstance(response, dict) else None
    return isinstance(failure, dict) and failure.get("code") == "account_needs_review"


class NativeHealth:
    def __init__(self, home, binding):
        self.home, self.binding = Path(home), str(binding)

    def state(self):
        return json.loads((self.home / ".rec/state.json").read_text())

    def control_authorization_revoked(self, state):
        # This runtime launches the native service with TZ=UTC. Ignore a prior
        # daemon's errors after an explicitly authorized official recovery.
        started = state["daemon"]["started_at_ms"]
        with (self.home / ".rec/logs/daemon.log").open("rb") as log:
            log.seek(max(0, log.seek(0, 2) - 262144))
            lines = log.read().decode("utf-8", errors="replace").splitlines()
        for line in reversed(lines):
            if "reclaude intercept sync:" not in line:
                continue
            try:
                at = (
                    datetime.fromisoformat(line[:23])
                    .replace(tzinfo=timezone.utc)
                    .timestamp()
                    * 1000
                )
            except ValueError:
                continue
            if at < started:
                break
            if any(
                code in line
                for code in ["device_revoked", "invalid_sk", "auth_revoked"]
            ):
                return True
        return False

    def authorization_revoked(self, state=None):
        try:
            state = self.state() if state is None else state
            error = str(state["identities"]["claude"].get("last_error") or "").lower()
            return any(
                code in error
                for code in ["device_revoked", "invalid_sk", "auth_revoked"]
            ) or self.control_authorization_revoked(state)
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def failed_health_checks(self):
        try:
            state = self.state()
            identity = state["identities"]["claude"]
            bindings = sorted(
                p.parent.parent.name
                for p in (self.home / ".rec/claude/accounts").glob(
                    "*/config/.credentials.json"
                )
            )
            failed = []
            if not state["daemon"]["running"] or not identity["gateway"]["healthy"]:
                failed.append("native_unavailable")
            if not state["daemon"].get("leak_report"):
                failed.append("native_reporting_unavailable")
            current = (self.home / ".rec/claude/current").read_text().strip()
            same_binding = bindings == sorted(identity["bindings"]) == [self.binding] and current == self.binding
            if not same_binding:
                failed.append("native_binding_mismatch")
            if self.control_authorization_revoked(state):
                failed.append("native_control_authorization_revoked")
            if self.authorization_revoked(state):
                failed.append("native_device_revoked")
            elif same_binding and current_account_needs_review(
                identity.get("last_error"), state["daemon"].get("started_at_ms")
            ):
                failed.append("native_account_needs_review")
            elif identity.get("last_error"):
                failed.append("native_identity_error")
            return failed
        except (OSError, ValueError, KeyError, TypeError):
            return ["native_state_unavailable"]


def validate_official(proof, binding_id, org_id, now_ms, minimum_remaining=0.60):
    """Validate an optional operator-supplied, fresh official observation."""
    if (
        type(binding_id) is not int
        or binding_id <= 0
        or type(org_id) is not int
        or org_id <= 0
    ):
        raise ValueError("invalid_binding_or_org")
    if not 0 <= now_ms - proof["observed_at_ms"] < 120000:
        raise ValueError("official_proof_stale")
    if proof["quota"]["status"] != 200 or proof["devices"]["status"] != 200:
        raise ValueError("official_state_unavailable")
    quota = proof["quota"]["data"]
    limit, used = float(quota["quota_usd"]), float(quota["used_usd"])
    if not all(math.isfinite(v) for v in (limit, used, minimum_remaining)):
        raise ValueError("official_quota_invalid")
    if (
        quota.get("state") != "active"
        or quota.get("status") != "active"
        or quota.get("enabled") is not True
        or limit <= 0
        or used < 0
        or minimum_remaining <= 0
        or limit - used < minimum_remaining
    ):
        raise ValueError("official_quota_not_ready")
    devices = [d for d in proof["devices"]["data"] if d.get("id") == binding_id]
    if (
        len(devices) != 1
        or devices[0].get("org_id") != org_id
        or devices[0].get("revoked_at") is not None
    ):
        raise ValueError("native_device_not_active")
