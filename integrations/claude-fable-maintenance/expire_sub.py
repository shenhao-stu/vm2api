#!/usr/bin/env python3
"""Expire explicitly marked Pro promotions through Sub2API's native admin API."""

import argparse
import copy
import datetime as dt
import fcntl
import fnmatch
import json
import math
import os
from pathlib import Path
import re
import stat
import urllib.error
import urllib.parse
import urllib.request

MARKER_KEY = "vm2api_fable_pro_promotion"
MODEL = "claude-fable-5-2"
EXPIRES_AT = "2026-11-17T07:59:00Z"
VARIANTS = (MODEL, "claude-fable-5.2", MODEL + "[1m]", "claude-fable-5.2[1m]")
MODEL_RE = re.compile(r"^claude-fable-5[-.]2(?:\[1m\])?$", re.I)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("invalid_timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("invalid_timestamp") from None
    if parsed.tzinfo is None:
        raise ValueError("timezone_required")
    return parsed.timestamp()


def is_fable52(value):
    return isinstance(value, str) and MODEL_RE.fullmatch(value.strip()) is not None


def normalized_base(value):
    if not isinstance(value, str):
        raise ValueError("base_url_required")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("invalid_base_url")
    if parsed.query or parsed.fragment:
        raise ValueError("invalid_base_url")
    return value.rstrip("/")


def validate_spec(spec):
    if not isinstance(spec, dict) or type(spec.get("account_id")) is not int or spec["account_id"] <= 0:
        raise ValueError("invalid_account_spec")
    if not isinstance(spec.get("marker"), str) or not spec["marker"]:
        raise ValueError("promotion_marker_required")
    if timestamp(spec.get("expires_at")) != timestamp(EXPIRES_AT):
        raise ValueError("unexpected_promotion_expiry")
    normalized_base(spec.get("base_url"))


def bound_account(account, spec):
    if not isinstance(account, dict) or account.get("id") != spec["account_id"]:
        raise ValueError("account_identity_mismatch")
    if account.get("type") != "apikey" or account.get("platform") != "anthropic":
        raise ValueError("account_kind_mismatch")
    credentials = account.get("credentials")
    if not isinstance(credentials, dict):
        raise ValueError("credentials_missing")
    if normalized_base(credentials.get("base_url")) != normalized_base(spec["base_url"]):
        raise ValueError("account_binding_mismatch")
    return credentials


def expiration_patch(account, spec, now):
    """Return only credentials/extra updates; never alter scheduling or grouping."""
    validate_spec(spec)
    if not isinstance(now, (int, float)) or not math.isfinite(now):
        raise ValueError("invalid_clock")
    if now < timestamp(spec["expires_at"]):
        return None
    credentials = bound_account(account, spec)
    extra = account.get("extra")
    if not isinstance(extra, dict):
        raise ValueError("extra_missing")
    marker = extra.get(MARKER_KEY)
    if marker is None:
        return None
    if not isinstance(marker, dict) or marker.get("marker") != spec["marker"]:
        return None
    if marker.get("tier") != "pro" or marker.get("model") != MODEL:
        raise ValueError("promotion_identity_mismatch")
    if timestamp(marker.get("expires_at")) != timestamp(spec["expires_at"]):
        raise ValueError("promotion_expiry_mismatch")
    mapping = credentials.get("model_mapping")
    if not isinstance(mapping, dict):
        raise ValueError("explicit_model_mapping_required")
    kept = {key: value for key, value in mapping.items() if not is_fable52(key) and not is_fable52(value)}
    if not kept:
        # In Sub2API an empty mapping means unrestricted models.
        raise ValueError("model_mapping_would_be_unrestricted")
    for pattern in kept:
        if not isinstance(pattern, str):
            raise ValueError("invalid_model_mapping")
        if "*" in pattern and any(fnmatch.fnmatchcase(model, pattern.lower()) for model in VARIANTS):
            raise ValueError("wildcard_still_allows_fable52")
    updated_credentials = copy.deepcopy(credentials)
    updated_credentials["model_mapping"] = copy.deepcopy(kept)
    updated_extra = copy.deepcopy(extra)
    del updated_extra[MARKER_KEY]
    return {"credentials": updated_credentials, "extra": updated_extra}


def group_expiration_patch(group, account_ids):
    """Optional exact-model route cleanup; preserve all fallback routes and flags."""
    routing = group.get("model_routing")
    if not isinstance(routing, dict):
        raise ValueError("model_routing_missing")
    removed = set(account_ids)
    updated = copy.deepcopy(routing)
    for model, ids in routing.items():
        if not is_fable52(model):
            continue
        if not isinstance(ids, list) or any(type(value) is not int for value in ids):
            raise ValueError("invalid_model_route")
        keep = [value for value in ids if value not in removed]
        if keep:
            updated[model] = keep
        else:
            updated.pop(model)
    return {"model_routing": updated} if updated != routing else None


def expiration_applied(account, spec):
    try:
        credentials = bound_account(account, spec)
        extra = account.get("extra")
        if not isinstance(extra, dict) or MARKER_KEY in extra:
            return False
        mapping = credentials.get("model_mapping")
        if not isinstance(mapping, dict) or not mapping:
            return False
        return not any(
            is_fable52(key) or is_fable52(value) or
            (isinstance(key, str) and "*" in key and any(fnmatch.fnmatchcase(model, key.lower()) for model in VARIANTS))
            for key, value in mapping.items()
        )
    except ValueError:
        return False


def maintain_expirations(specs, api, now):
    reports = []
    for spec in specs:
        account_id = spec.get("account_id") if isinstance(spec, dict) else None
        report = {"account_id": account_id}
        try:
            validate_spec(spec)
            if now < timestamp(spec["expires_at"]):
                reports.append({**report, "action": "not_due"})
                continue
            route = f"/api/v1/admin/accounts/{account_id}"
            current = api("GET", route)
            patch = expiration_patch(current, spec, now)
            if patch is None:
                reports.append({**report, "action": "unchanged"})
                continue
            failed = False
            try:
                api("PUT", route, patch)
            except Exception:
                # A timeout may follow a committed write. Observe; never replay it here.
                failed = True
            latest = api("GET", route)
            if not expiration_applied(latest, spec):
                reports.append({**report, "action": "unconfirmed"})
                continue
            reports.append({**report, "action": "reconciled" if failed else "expired"})
        except ValueError as error:
            reason = str(error)
            reports.append({**report, "action": "blocked", "reason": reason if re.fullmatch(r"[a-z_]+", reason) else "invalid_input"})
        except Exception:
            reports.append({**report, "action": "error", "reason": "admin_request_failed"})
    return reports


def validate_group_spec(group, accounts):
    if not isinstance(group, dict) or type(group.get("group_id")) is not int or group["group_id"] <= 0:
        raise ValueError("invalid_group_spec")
    ids = group.get("account_ids")
    if not isinstance(ids, list) or not ids or len(set(ids)) != len(ids) or any(type(i) is not int for i in ids):
        raise ValueError("invalid_group_pro_ids")
    if timestamp(group.get("expires_at")) != timestamp(EXPIRES_AT):
        raise ValueError("unexpected_promotion_expiry")
    for identity in ids:
        spec = accounts.get(identity)
        if not spec or spec["marker"] != group.get("marker") or spec["expires_at"] != group["expires_at"]:
            raise ValueError("group_account_promotion_mismatch")


def maintain_group_expirations(groups, account_specs, api, now):
    """Remove only configured Pro accounts after their account-level expiry is verified."""
    accounts = {spec["account_id"]: spec for spec in account_specs}
    reports = []
    for spec in groups:
        report = {"group_id": spec.get("group_id") if isinstance(spec, dict) else None}
        try:
            validate_group_spec(spec, accounts)
            if now < timestamp(spec["expires_at"]):
                reports.append({**report, "action": "not_due"})
                continue
            route = f"/api/v1/admin/groups/{spec['group_id']}"
            current = api("GET", route)
            if current.get("id") != spec["group_id"] or current.get("platform") != "anthropic":
                raise ValueError("group_identity_mismatch")
            verified = []
            for identity in spec["account_ids"]:
                account = api("GET", f"/api/v1/admin/accounts/{identity}")
                if not expiration_applied(account, accounts[identity]):
                    raise ValueError("account_expiry_unconfirmed")
                verified.append(identity)
            patch = group_expiration_patch(current, verified)
            if patch is None:
                reports.append({**report, "action": "unchanged"})
                continue
            failed = False
            try:
                api("PUT", route, patch)
            except Exception:
                failed = True
            latest = api("GET", route)
            if latest.get("model_routing") != patch["model_routing"]:
                reports.append({**report, "action": "unconfirmed"})
                continue
            reports.append({**report, "action": "reconciled" if failed else "expired"})
        except ValueError as error:
            reason = str(error)
            reports.append({**report, "action": "blocked", "reason": reason if re.fullmatch(r"[a-z_]+", reason) else "invalid_input"})
        except Exception:
            reports.append({**report, "action": "error", "reason": "admin_request_failed"})
    return reports


def private_read(file, limit):
    path = Path(file)
    if not path.is_absolute():
        raise ValueError("absolute_private_file_required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("private_file_permissions_required")
        content = handle.read(limit + 1)
        if len(content) > limit:
            raise ValueError("private_file_too_large")
        return content.decode("utf-8")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("redirect_refused")


class AdminAPI:
    def __init__(self, base_url, token):
        self.base = normalized_base(base_url)
        parsed = urllib.parse.urlsplit(self.base)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1") or parsed.path:
            raise ValueError("loopback_admin_url_required")
        if not token or any(ord(char) < 33 or ord(char) > 126 for char in token):
            raise ValueError("invalid_admin_token")
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def __call__(self, method, route, body=None):
        if not re.fullmatch(r"/api/v1/admin/(?:accounts|groups)/[1-9][0-9]*", route):
            raise ValueError("admin_route_refused")
        if method not in ("GET", "PUT"):
            raise ValueError("admin_method_refused")
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(self.base + route, data=payload, method=method, headers={
            "x-api-key": self.token, "Content-Type": "application/json",
        })
        with self.opener.open(request, timeout=30) as response:
            content = response.read(4 * 1024 * 1024 + 1)
            if len(content) > 4 * 1024 * 1024:
                raise ValueError("admin_response_too_large")
            result = json.loads(content)
        if not isinstance(result, dict) or result.get("code", 0) not in (0, 200):
            raise ValueError("admin_response_rejected")
        result = result.get("data", result)
        if not isinstance(result, dict):
            raise ValueError("admin_account_missing")
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(private_read(args.config, 1024 * 1024))
    specs = config.get("accounts")
    if not isinstance(specs, list) or not specs:
        raise ValueError("account_specs_required")
    for spec in specs:
        validate_spec(spec)
    if len({spec["account_id"] for spec in specs}) != len(specs):
        raise ValueError("duplicate_account_spec")
    groups = config.get("groups", [])
    if not isinstance(groups, list):
        raise ValueError("invalid_group_specs")
    for group in groups:
        validate_group_spec(group, {spec["account_id"]: spec for spec in specs})
    if len({group["group_id"] for group in groups}) != len(groups):
        raise ValueError("duplicate_group_spec")
    token = private_read(config["token_file"], 65536).strip()
    api = AdminAPI(config["sub_admin_url"], token)
    lock_path = Path(config["lock_file"])
    if not lock_path.is_absolute():
        raise ValueError("absolute_lock_file_required")
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"action": "skipped", "reason": "release_lock_busy"}))
            return 0
        now = dt.datetime.now(dt.timezone.utc)
        reports = maintain_expirations(specs, api, now.timestamp())
        reports += maintain_group_expirations(groups, specs, api, now.timestamp())
        print(json.dumps({"at": now.isoformat(), "reports": reports}, ensure_ascii=False))
        return int(any(report["action"] in ("blocked", "error", "unconfirmed") for report in reports))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # Do not print urllib exceptions, config contents or credentials.
        print(json.dumps({"action": "error", "reason": "expiry_maintenance_failed"}))
        raise SystemExit(1)
