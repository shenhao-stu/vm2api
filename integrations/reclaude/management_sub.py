"""Forced-command broker: only one configured Sub2API account's scheduling.

The existing native_api credential helper stays on Sub2API's server. The public
key granting access is restricted to this command, with forwarding/PTY disabled.
"""
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import uuid


def matches_shared_profile(account, profile):
    """Compare only scheduling controls. Credentials and upstream addresses are per account."""
    creds = account["credentials"]
    if any(account.get(k) != value for k, value in profile["account"].items()):
        return False
    if not profile["groups"] or set(account.get("group_ids") or []) != set(profile["groups"]):
        return False
    extra = account.get("extra") or {}
    if extra.get("affinity_tags") or any(extra.get(k) != v for k, v in profile["extra"].items()):
        return False
    if creds.get("model_mapping") != {model: model for model in profile["models"]}:
        return False
    if any(creds.get(k) != value for k, value in profile["credentials"].items()):
        return False

    def rules(entries):
        # First-match order is significant. Keyword order and human labels are not.
        return [(row.get("error_code"), row.get("scope"), row.get("duration_minutes"),
                 sorted(row.get("keywords") or [])) for row in entries]

    return rules(creds.get("temp_unschedulable_rules") or []) == rules(profile["cooldowns"])


def model_cooldowns(account, models):
    """Read-only, credential-free projection; scheduling remains Sub2API's decision."""
    extra = account.get("extra") or {}
    limits = extra.get("model_rate_limits") if isinstance(extra, dict) else None
    if not isinstance(limits, dict):
        return []
    result = []
    for model in sorted(set(models)):
        row = limits.get(model)
        reset = row.get("rate_limit_reset_at") if isinstance(row, dict) else None
        if not isinstance(reset, str) or len(reset) > 64:
            continue
        try:
            if datetime.fromisoformat(reset.replace("Z", "+00:00")).utcoffset() is None:
                continue
        except ValueError:
            continue
        result.append({"model": model, "reset_at": reset})
    return result


def execute(config, action):
    if action not in ("status", "pause", "resume"):
        raise ValueError("unknown_action")
    spec = importlib.util.spec_from_file_location("sub_native_api", config["native_api_path"])
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    native.ROOT = Path(config["receipts_dir"])
    native.ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = "/api/v1/admin/accounts/" + str(config["account_id"])
    def account():
        return native.api("sub", "GET", path)
    value = account()
    if value["id"] != config["account_id"]:
        raise ValueError("account_mismatch")
    profile_path = config.get("shared_routing_profile")
    matches = True
    if profile_path:
        try:
            matches = matches_shared_profile(value, json.loads(Path(profile_path).read_text()))
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            # Preserve stop and revocation handling even if the operator's file is unavailable.
            matches = False
    if action == "resume":
        if not matches:
            raise ValueError("shared_routing_profile_changed")
        credentials = value["credentials"]
        if (value["concurrency"] != config["concurrency"] or value["status"] != "active"
                or credentials.get("base_url") != config["base_url"]
                or set(credentials.get("model_mapping", {})) != set(config["models"])
                or set(value.get("group_ids", [])) != set(config["group_ids"])):
            raise ValueError("account_policy_changed")
    if action != "status":
        native.api("sub", "POST", path + "/schedulable", {"schedulable": action == "resume"},
                   receipt="management-" + str(uuid.uuid4()) + ".private.json")
        value = account()
    return {"ok": True, "shared_policy_matches": matches, "id": value["id"], "status": value["status"],
            "schedulable": value["schedulable"], "concurrency": value["concurrency"],
            "rate_limit_reset_at": value.get("rate_limit_reset_at"),
            "temp_unschedulable_until": value.get("temp_unschedulable_until"),
            "model_cooldowns": model_cooldowns(value, config["models"])}


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
        print(json.dumps({"ok": False, "error": "sub_management_failed"}))
        sys.exit(1)
