"""Forced-command broker: only one configured Sub2API account's scheduling.

The existing native_api credential helper stays on Sub2API's server. The public
key granting access is restricted to this command, with forwarding/PTY disabled.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import uuid


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
    if action == "resume":
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
    return {"ok": True, "id": value["id"], "status": value["status"],
            "schedulable": value["schedulable"], "concurrency": value["concurrency"]}


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
