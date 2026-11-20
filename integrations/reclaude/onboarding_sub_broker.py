"""Account-side broker for onboarding a native Relay seat. Runs as a forced SSH command.

    onboarding_sub_broker.py CONFIG onboarding
        one request on stdin: {"action": "sub_create", "seat": "3fa91c0b", ...}
    onboarding_sub_broker.py CONFIG control
        the seat comes from the SSH command ("seat-control 3fa91c0b"); stdin is
        {"action": "status" | "pause" | "resume"} and only that seat's scheduling changes

Every account is cloned from one reference account and starts in its own exclusive
acceptance group. It joins the shared groups only after one real request was billed to it.
The Sub2API admin helper and its credentials never leave this host.
"""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

SEAT = re.compile(r"[0-9a-f]{8}")
NAME = re.compile(r"[\w][\w .·-]{0,23}")
ADDRESS = re.compile(r"[0-9a-fA-F:.]{3,45}")
KEY = re.compile(r"[A-Za-z0-9_-]{32,100}")
MAX_CANARIES = 3
CLI_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."


class Refused(Exception):
    def __init__(self, code, detail=""):
        self.code, self.detail = code, str(detail)[:300]
        super().__init__(code)


def require(condition, code, detail=""):
    if not condition:
        raise Refused(code, detail)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    path = Path(path)
    temporary = path.with_name("." + path.name + "." + secrets.token_hex(4))
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False)
    os.replace(temporary, path)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def insert_after_relays(ids, account, relays):
    """Place a new relay account right behind the relay accounts already routed."""
    positions = [index for index, value in enumerate(ids) if value in relays]
    if account in ids or not positions:
        return list(ids)
    return ids[:positions[-1] + 1] + [account] + ids[positions[-1] + 1:]


class Broker:
    def __init__(self, config, native=None):
        self.config = config
        self.root = Path(config["root"])
        self.native = native or load_module("sub_native_api", config["native_api_path"])
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    # ------------------------------------------------------------ helpers

    def folder(self, seat, create=False):
        require(isinstance(seat, str) and SEAT.fullmatch(seat), "invalid_seat")
        folder = self.root / "seats" / seat
        if create:
            (folder / "receipts").mkdir(mode=0o700, parents=True, exist_ok=True)
        if folder.exists():
            self.native.ROOT = folder / "receipts"
        return folder

    def api(self, method, path, body=None, label="write"):
        """The admin helper stops the process on an HTTP error; report it as a refusal instead."""
        receipt = None if method == "GET" else f"{label}-{time.time_ns()}"
        try:
            return self.native.api("sub", method, "/api/v1/admin" + path, body, receipt=receipt)
        except SystemExit as stop:
            raise Refused("sub_api_failed", f"{method} {path.split('?')[0]}: {str(stop)[:60]}") from None
        except (OSError, ValueError, AssertionError) as error:
            raise Refused("sub_api_failed", f"{method} {path.split('?')[0]}: {type(error).__name__}") from None

    def rows(self, query):
        return self.native.db("sub2api", query)

    def base_url(self, seat):
        return self.config["base_url_prefix"] + seat

    def stage(self, seat):
        return read_json(self.folder(seat) / "sub.json", {})

    def relay_accounts(self):
        return set(self.config["relay_accounts"]) | set(read_json(self.root / "relay-accounts.json", []))

    def account_alive(self, account):
        return bool(self.rows(f"select id from accounts where id={int(account)} and deleted_at is null"))

    # ------------------------------------------------------------ public path (Caddy)

    def caddy_state(self):
        """Find the one 404 matcher on the public site, in the running server and on disk."""
        settings = self.config["caddy"]
        servers = json.load(self.opener.open(settings["admin"] + "/config/apps/http/servers", timeout=6))
        found = []
        for name, server in servers.items():
            for i, route in enumerate(server.get("routes", [])):
                if route.get("match") != [{"host": [settings["host"]]}]:
                    continue
                for j, handler in enumerate(route.get("handle", [])):
                    for k, inner in enumerate(handler.get("routes", [])):
                        target, match = inner.get("handle", []), inner.get("match") or []
                        if (len(target) == 1 and target[0].get("handler") == "static_response"
                                and str(target[0].get("status_code")) == "404" and len(match) == 1
                                and settings["marker_path"] in (match[0].get("path") or [])):
                            found.append(f"{settings['admin']}/config/apps/http/servers/{name}/routes/{i}"
                                         f"/handle/{j}/routes/{k}/match/0/path")
        require(len(found) == 1, "public_matcher_not_found", len(found))
        with self.opener.open(found[0], timeout=6) as response:
            live, etag = json.load(response), response.headers["Etag"]
        disk = Path(settings["site"]).read_bytes()
        lines = re.findall(rb"^    " + re.escape(settings["matcher"].encode()) + rb" path (.*)$", disk, re.M)
        require(len(lines) == 1 and etag, "public_matcher_not_found", "site file")
        require(lines[0].decode().split() == live, "public_matcher_disk_differs")
        return {"url": found[0], "etag": etag, "live": live, "disk": disk, "line": lines[0]}

    def caddy_swap(self, expected, target):
        site = Path(self.config["caddy"]["site"])
        status = site.stat()
        handle, name = tempfile.mkstemp(dir=site.parent, prefix=".relay-onboarding-")
        try:
            with os.fdopen(handle, "wb") as file:
                os.fchown(file.fileno(), status.st_uid, status.st_gid)
                os.fchmod(file.fileno(), status.st_mode & 0o777)
                file.write(target)
                file.flush()
                os.fsync(file.fileno())
            require(site.read_bytes() == expected, "public_site_changed_concurrently")
            os.replace(name, site)
        finally:
            Path(name).unlink(missing_ok=True)

    def caddy_validate(self):
        settings = self.config["caddy"]
        environment = os.environ.copy()
        for line in Path(settings["environment"]).read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                environment[key] = shlex.split(value)[0]
        subprocess.run([settings["binary"], "validate", "--config", settings["config"]], env=environment,
                       capture_output=True, check=True, timeout=40)

    def set_public_paths(self, seat, blocked):
        """Add or remove this seat's two paths in the public 404 matcher, on disk and live."""
        own = [f"{self.config['public_path_prefix']}{seat}", f"{self.config['public_path_prefix']}{seat}/*"]
        state = self.caddy_state()
        paths = [path for path in state["live"] if path not in own] + (own if blocked else [])
        if paths == state["live"]:
            return False
        settings = self.config["caddy"]
        prefix = ("    " + settings["matcher"] + " path ").encode()
        new_disk = state["disk"].replace(prefix + state["line"], prefix + " ".join(paths).encode())
        backup = self.folder(seat, create=True) / ("caddy." + hashlib.sha256(state["disk"]).hexdigest()[:12] + ".private")
        if not backup.exists():
            backup.write_bytes(state["disk"])
        with open(self.root / "public-path.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.caddy_swap(state["disk"], new_disk)
            try:
                self.caddy_validate()
                call = urllib.request.Request(state["url"], method="PATCH", data=json.dumps(paths).encode(),
                                              headers={"Content-Type": "application/json", "If-Match": state["etag"]})
                with self.opener.open(call, timeout=40) as response:
                    require(response.status == 200, "public_matcher_update_failed")
            except Exception:
                # An interrupted response may already be committed: read the running server first.
                live = json.load(self.opener.open(state["url"], timeout=6))
                if live == state["live"]:
                    self.caddy_swap(new_disk, state["disk"])
                if live != paths:
                    raise Refused("public_matcher_update_failed") from None
            require(json.load(self.opener.open(state["url"], timeout=6)) == paths, "public_matcher_update_failed")
        return True

    # ------------------------------------------------------------ route checks (no model is called)

    def fetch(self, url, key=None):
        headers = {"x-api-key": key} if key else {}
        try:
            response = self.opener.open(urllib.request.Request(url, headers=headers), timeout=12)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(100000)
        try:
            return response.status, json.loads(raw)
        except ValueError:
            return response.status, {}

    def route_probe(self, seat, key):
        """The model list through the private route, exactly as Sub2API will reach it."""
        try:
            return self.fetch(self.base_url(seat) + "/v1/models", key)
        except OSError:
            return 0, {}

    def public_status(self, seat):
        """The same path on the public name must not exist."""
        try:
            return self.fetch(self.config["public_origin"] + self.config["public_path_prefix"] + seat + "/v1/models")[0]
        except OSError:
            return 0

    # ------------------------------------------------------------ user session for the acceptance key

    def user_session(self):
        """Log in as the administrator's own user: acceptance keys belong to a user, not to the admin API."""
        settings = self.config["sub"]
        container = json.loads(subprocess.check_output(["docker", "inspect", settings["container"]], text=True))[0]
        require(container["State"]["Running"], "sub_not_running")
        environment = dict(entry.split("=", 1) for entry in container["Config"]["Env"])
        user = self.api("GET", f"/users/{settings['admin_user']}")
        call = urllib.request.Request(settings["url"] + "/api/v1/auth/login", headers={"Content-Type": "application/json"},
                                      data=json.dumps({"email": user["email"], "password": environment["ADMIN_PASSWORD"]}).encode())
        login = json.load(self.opener.open(call, timeout=20))["data"]
        token = login.get("access_token") or login.get("tokens", {}).get("access_token")
        require(token, "sub_login_failed")
        refresh = login.get("refresh_token") or (login.get("tokens") or {}).get("refresh_token")
        return {"token": token, "refresh": refresh}

    def user_api(self, session, method, path, body=None):
        call = urllib.request.Request(self.config["sub"]["url"] + "/api/v1" + path, method=method,
                                      data=None if body is None else json.dumps(body).encode(),
                                      headers={"Authorization": "Bearer " + session["token"], "Content-Type": "application/json"})
        with self.opener.open(call, timeout=25) as response:
            return json.load(response)

    def close_session(self, session):
        if session.get("refresh"):
            try:
                self.user_api(session, "POST", "/auth/logout", {"refresh_token": session["refresh"]})
            except (OSError, ValueError):
                pass

    def grant_admin(self, group, allowed):
        """Let the administrator's user use (or stop using) one acceptance group. Other grants are kept."""
        admin = self.config["sub"]["admin_user"]
        groups = self.api("GET", f"/users/{admin}")["allowed_groups"]
        wanted = [value for value in groups if value != group] + ([group] if allowed else [])
        if wanted != groups:
            self.api("PUT", f"/users/{admin}", {"allowed_groups": wanted}, "admin-grant" if allowed else "admin-revoke")
            require(set(self.api("GET", f"/users/{admin}")["allowed_groups"]) == set(wanted), "admin_grant_unconfirmed")

    def delete_group_keys(self, group):
        keys = self.rows(f"select id from api_keys where group_id={int(group)} and deleted_at is null")
        if not keys:
            return 0
        session = self.user_session()
        try:
            for row in keys:
                self.user_api(session, "DELETE", f"/keys/{int(row['id'])}")
        finally:
            self.close_session(session)
        require(not self.rows(f"select id from api_keys where group_id={int(group)} and deleted_at is null"),
                "acceptance_key_not_deleted")
        return len(keys)

    # ------------------------------------------------------------ actions

    def act_preflight(self, request):
        reference = self.api("GET", f"/accounts/{self.config['reference_account']}")
        require(reference["status"] == "active" and reference["type"] == "apikey" and reference["group_ids"],
                "reference_account_changed")
        for group in self.config["routing_groups"]:
            routing = self.api("GET", f"/groups/{group}")
            require(routing["model_routing_enabled"]
                    and any(reference["id"] in ids for ids in routing["model_routing"].values()), "routing_reference_missing", group)
        self.caddy_state()
        self.caddy_validate()
        container = json.loads(subprocess.check_output(["docker", "inspect", self.config["sub"]["container"]], text=True))[0]
        require(container["State"]["Running"], "sub_not_running")
        return {"shared_groups": reference["group_ids"], "models": sorted(reference["credentials"]["model_mapping"])}

    def act_block_public(self, request):
        return {"changed": self.set_public_paths(request["seat"], True)}

    def act_sub_create(self, request):
        """A dedicated account in its own exclusive acceptance group. Nothing shared can reach it yet."""
        seat = request["seat"]
        folder = self.folder(seat, create=True)
        require(isinstance(request.get("name"), str) and NAME.fullmatch(request["name"]), "invalid_name")
        require(isinstance(request.get("client_key"), str) and KEY.fullmatch(request["client_key"]), "invalid_client_key")
        require(all(type(request.get(field)) is int and 0 < request[field] < 10 ** 9 for field in ("binding", "org")), "invalid_identity")
        require(isinstance(request.get("expected_ip"), str) and ADDRESS.fullmatch(request["expected_ip"]), "invalid_address")
        reference = self.api("GET", f"/accounts/{self.config['reference_account']}")
        models = sorted(reference["credentials"]["model_mapping"])
        base, stage = self.base_url(seat), self.stage(seat)
        # The seat id is random, so a group or account carrying it can only be this seat's own:
        # one left by an interrupted earlier run is adopted instead of created twice.
        if "group_id" not in stage:
            tag = f"relay-onboarding-{seat}"
            found = self.rows(f"select id from groups where deleted_at is null and name='{tag}'")
            require(len(found) <= 1, "acceptance_group_ambiguous")
            group = {"id": found[0]["id"]} if found else self.api("POST", "/groups", {
                "name": tag, "description": "Directed native relay acceptance; no failover.", "platform": "anthropic",
                "subscription_type": "standard", "is_exclusive": True, "claude_code_only": False, "rate_multiplier": 1,
                "model_routing_enabled": False, "fallback_group_id": None, "fallback_group_id_on_invalid_request": None,
                "model_allowlist": {"enabled": True, "models": models}, "rpm_limit": 4}, "acceptance-group")
            stage.update(group_id=group["id"], shared_groups=reference["group_ids"])
            write_json(folder / "sub.json", stage)
        if "account_id" not in stage:
            found = self.rows(f"select id from accounts where deleted_at is null and credentials->>'base_url'='{base}'")
            require(len(found) <= 1, "account_ambiguous")
            account = {"id": found[0]["id"]} if found else self.api("POST", "/accounts", {
                "name": self.config["account_name"].format(name=request["name"], seat=seat),
                "notes": (f"Independent native ReClaude device{request['binding']}/org{request['org']} ({request['name']}); "
                          f"exit {request['expected_ip']}; concurrency{reference['concurrency']}; separate HOME/session/usage; "
                          f"no user affinity; fixed exit fail closed; onboarded from the console as seat {seat}."),
                "platform": "anthropic", "type": "apikey",
                "credentials": {**reference["credentials"], "base_url": base, "api_key": request["client_key"]},
                "extra": {"anthropic_passthrough": True, "upstream_billing_probe_enabled": False,
                          "upstream_billing_rate_sync_enabled": False},
                "concurrency": reference["concurrency"], "priority": reference["priority"], "rate_multiplier": 1,
                "group_ids": [stage["group_id"]], "proxy_id": None, "upstream_billing_probe_enabled": False}, "account")
            stage["account_id"] = account["id"]
            write_json(folder / "sub.json", stage)
        account = self.api("GET", f"/accounts/{stage['account_id']}")
        require(account["credentials"]["base_url"] == base and account["concurrency"] == reference["concurrency"]
                and account["credentials"]["model_mapping"] == reference["credentials"]["model_mapping"]
                and not account["extra"].get("affinity_tags"), "account_differs_from_reference")
        require(account["group_ids"] == [stage["group_id"]] or set(account["group_ids"]) == set(stage["shared_groups"]),
                "account_groups_unexpected")
        stored = self.rows(f"select credentials->>'api_key' as relay_key from accounts where id={int(account['id'])}")
        require(len(stored) == 1 and secrets.compare_digest(str(stored[0]["relay_key"]), request["client_key"]),
                "account_key_differs")
        status, body = self.route_probe(seat, request["client_key"])
        require(status == 200 or body.get("error", {}).get("code") == "relay_acceptance_pending", "private_route_unreachable", status)
        require(self.public_status(seat) == 404, "public_path_open")
        if not account["schedulable"]:
            self.api("POST", f"/accounts/{account['id']}/schedulable", {"schedulable": True}, "schedulable")
        write_json(folder / "control.json", {
            "native_api_path": self.config["native_api_path"], "receipts_dir": str(folder / "control-receipts"),
            "account_id": account["id"], "concurrency": account["concurrency"], "base_url": base, "models": models,
            "group_ids": account["group_ids"]})
        return {"account_id": account["id"], "group_id": stage["group_id"]}

    def canary_request(self, key):
        """One Claude-Code-shaped streaming request through Sub2API with the acceptance key."""
        nonce = "PONG-" + secrets.token_hex(3).upper()
        user = json.dumps({"device_id": hashlib.sha256(b"relay-onboarding-canary").hexdigest(), "account_uuid": "",
                           "session_id": str(uuid.uuid4())})
        body = {"model": self.config["canary_model"], "max_tokens": 64, "stream": True, "metadata": {"user_id": user},
                "system": [{"type": "text", "text": CLI_PROMPT}],
                "messages": [{"role": "user", "content": "Reply with exactly this token and nothing else: " + nonce}]}
        call = urllib.request.Request(self.config["sub"]["url"] + "/v1/messages?beta=true", data=json.dumps(body).encode(), headers={
            "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219", "X-App": "cli", "User-Agent": "claude-cli/2.1.224 (external, cli)"})
        result, started = {"model": body["model"]}, time.monotonic()
        try:
            try:
                response = self.opener.open(call, timeout=180)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                raw, result["status"] = response.read(600000), response.status
            if result["status"] == 200:
                events = [json.loads(line[5:]) for line in raw.decode().splitlines() if line.startswith("data:")]
                kinds = [event.get("type") for event in events]
                text = "".join(event["delta"].get("text", "") for event in events
                               if event.get("type") == "content_block_delta" and event["delta"].get("type") == "text_delta")
                stop = next((event.get("delta", {}).get("stop_reason") for event in events if event.get("type") == "message_delta"), None)
                result["complete"] = (text.strip() == nonce and stop == "end_turn" and kinds.count("message_stop") == 1
                                      and "error" not in kinds)
            else:
                result["error"] = re.sub(r"[A-Za-z0-9_-]{24,}", "***", raw[:200].decode("utf-8", "replace"))
        except Exception as error:  # recorded; the caller reports a failed acceptance
            result["exception"] = type(error).__name__
        result["elapsed_s"] = round(time.monotonic() - started, 2)
        return result

    def act_sub_canary(self, request):
        """Bill exactly one short request to the new account, then remove the key that sent it."""
        seat = request["seat"]
        folder, stage = self.folder(seat), self.stage(seat)
        require("account_id" in stage, "account_not_created")
        for record in sorted(folder.glob("canary-*.safe.json")):
            earlier = read_json(record, {})
            if earlier.get("passed"):
                return {**earlier, "reused": True}
        attempt = len(list(folder.glob("canary-*.intent"))) + 1
        require(attempt <= MAX_CANARIES, "canary_attempts_exhausted")
        account, group = stage["account_id"], stage["group_id"]
        require(self.rows(f"select account_id from account_groups where group_id={int(group)}") == [{"account_id": account}],
                "acceptance_group_not_exclusive")
        # Free checks first, so an attempt is only spent when the request can actually arrive.
        stored = self.rows(f"select credentials->>'api_key' as relay_key from accounts where id={int(account)}")
        status, catalog = self.route_probe(seat, stored[0]["relay_key"])
        require(status == 200 and self.config["canary_model"] in {model.get("id") for model in catalog.get("data", [])},
                "private_route_unreachable", status)
        require(self.public_status(seat) == 404, "public_path_open")
        with (folder / f"canary-{attempt}.intent").open("x") as intent:
            json.dump({"at": time.time(), "posts": 1, "no_retry": True}, intent)
        self.grant_admin(group, True)
        session, result = None, {}
        try:
            session = self.user_session()
            key = self.user_api(session, "POST", "/keys", {"name": f"relay-onboarding-{seat}", "group_id": group,
                                                           "quota": .50, "expires_in_days": 1})["data"]
            require(key["group_id"] == group, "acceptance_key_unexpected")
            try:
                result = self.canary_request(key["key"])
                usage = []
                for _ in range(8):
                    usage = self.rows(f"select id, account_id from usage_logs where api_key_id={int(key['id'])} order by id")
                    if usage or not result.get("complete"):
                        break
                    time.sleep(1)
                result.update(attempt=attempt, usage_rows=len(usage),
                              billed_to_seat=bool(usage) and all(row["account_id"] == account for row in usage))
            finally:
                self.user_api(session, "DELETE", f"/keys/{int(key['id'])}")
        finally:
            self.grant_admin(group, False)
            if session:
                self.close_session(session)
        result["passed"] = bool(result.get("complete") and result.get("billed_to_seat") and result.get("usage_rows") == 1)
        write_json(folder / f"canary-{attempt}.safe.json", result)
        require(result["passed"], "sub_canary_failed",
                result.get("error") or result.get("exception") or f"status {result.get('status')}, rows {result.get('usage_rows')}")
        return result

    def act_promote(self, request):
        """Move the accepted account into the shared groups and routes of the reference account."""
        seat = request["seat"]
        folder, stage = self.folder(seat), self.stage(seat)
        require("account_id" in stage, "account_not_created")
        require(any((read_json(record, {})).get("passed") for record in folder.glob("canary-*.safe.json")), "not_accepted")
        account_id, group = stage["account_id"], stage["group_id"]
        with open(self.config["release_lock"]) as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise Refused("release_in_progress") from None
            reference = self.api("GET", f"/accounts/{self.config['reference_account']}")
            shared, tags = reference["group_ids"], reference["extra"].get("busy_sticky_fallback_tags")
            account = self.api("GET", f"/accounts/{account_id}")
            if set(account["group_ids"]) != set(shared):
                require(account["group_ids"] == [group] and account["status"] == "active" and account["schedulable"]
                        and account["concurrency"] == reference["concurrency"] and account["priority"] == reference["priority"]
                        and account["credentials"]["model_mapping"] == reference["credentials"]["model_mapping"]
                        and not account["extra"].get("affinity_tags"), "account_differs_from_reference")
                extra = {**account["extra"], **({"busy_sticky_fallback_tags": tags} if tags else {})}
                self.api("PUT", f"/accounts/{account_id}", {"group_ids": shared, "extra": extra}, "promote")
                after = self.api("GET", f"/accounts/{account_id}")
                require(set(after["group_ids"]) == set(shared) and after["schedulable"]
                        and all(after[field] == account[field] for field in ("credentials", "concurrency", "priority", "status")),
                        "promotion_unconfirmed")
            relays, routes = self.relay_accounts(), []
            for routing_group in self.config["routing_groups"]:
                current = self.api("GET", f"/groups/{routing_group}")
                old = current["model_routing"]
                new = {model: (insert_after_relays(ids, account_id, relays) if reference["id"] in ids else ids)
                       for model, ids in old.items()}
                if new != old:
                    write_json(folder / f"group-{routing_group}.before.private.json", current)
                    self.api("PUT", f"/groups/{routing_group}", {"model_routing": new}, f"routes-{routing_group}")
                    require(self.api("GET", f"/groups/{routing_group}")["model_routing"] == new, "routing_unconfirmed", routing_group)
                routes.append({"group": routing_group, "models": sorted(model for model, ids in new.items() if account_id in ids)})
            self.delete_group_keys(group)
            self.grant_admin(group, False)
            if self.rows(f"select id from groups where id={int(group)} and deleted_at is null"):
                require(not self.rows(f"select account_id from account_groups where group_id={int(group)}"), "acceptance_group_in_use")
                self.api("DELETE", f"/groups/{group}", None, "acceptance-group-delete")
            control = read_json(folder / "control.json")
            control["group_ids"] = shared
            write_json(folder / "control.json", control)
            write_json(self.root / "relay-accounts.json", sorted(set(read_json(self.root / "relay-accounts.json", [])) | {account_id}))
            final = self.api("GET", f"/accounts/{account_id}")
            checks = {"active_and_schedulable": final["status"] == "active" and final["schedulable"],
                      "shared_groups": set(final["group_ids"]) == set(shared),
                      "routed_like_reference": all(route["models"] for route in routes),
                      "acceptance_group_removed": not self.rows(f"select id from groups where id={int(group)} and deleted_at is null")}
            write_json(folder / f"promote-{time.time_ns()}.safe.json", {"at": time.time(), "checks": checks, "routes": routes})
            require(all(checks.values()), "promotion_unconfirmed", [name for name, passed in checks.items() if not passed])
        return {"account_id": account_id, "groups": shared, "routes": routes}

    def act_mark_live(self, request):
        folder = self.folder(request["seat"])
        require("account_id" in self.stage(request["seat"]), "account_not_created")
        (folder / "live.marker").touch(mode=0o600)
        return {"live": True}

    def act_abandon(self, request):
        """Take a seat that never went live out of every shared place, then remove what was created for it."""
        seat = request["seat"]
        folder, removed, left = self.folder(seat), [], []
        if folder.exists():
            require(not (folder / "live.marker").exists(), "seat_is_live")
            stage = self.stage(seat)
            account, group = stage.get("account_id"), stage.get("group_id")
            if account and self.account_alive(account):
                if self.api("GET", f"/accounts/{account}")["schedulable"]:
                    self.api("POST", f"/accounts/{account}/schedulable", {"schedulable": False}, "abandon-pause")
                require(self.api("GET", f"/accounts/{account}")["schedulable"] is False, "sub_pause_unconfirmed")
                for routing_group in self.config["routing_groups"]:
                    current = self.api("GET", f"/groups/{routing_group}")
                    new = {model: [value for value in ids if value != account] for model, ids in current["model_routing"].items()}
                    if new != current["model_routing"]:
                        self.api("PUT", f"/groups/{routing_group}", {"model_routing": new}, f"abandon-routes-{routing_group}")
                        require(self.api("GET", f"/groups/{routing_group}")["model_routing"] == new, "routing_unconfirmed")
                        removed.append(f"routes-{routing_group}")
                registry = read_json(self.root / "relay-accounts.json", [])
                if account in registry:
                    write_json(self.root / "relay-accounts.json", [value for value in registry if value != account])
            if group:
                if self.delete_group_keys(group):
                    removed.append("acceptance-key")
                self.grant_admin(group, False)
            if account and self.account_alive(account):
                try:
                    self.api("DELETE", f"/accounts/{account}", None, "abandon-account-delete")
                    removed.append("account")
                except Refused:
                    left.append(f"account {account} is paused but was not deleted")
            if group and self.rows(f"select id from groups where id={int(group)} and deleted_at is null"):
                if self.rows(f"select account_id from account_groups where group_id={int(group)}"):
                    left.append(f"acceptance group {group} still holds the paused account")
                else:
                    self.api("DELETE", f"/groups/{group}", None, "abandon-group-delete")
                    removed.append("acceptance-group")
        if self.set_public_paths(seat, False):
            removed.append("public-block")
        if folder.exists():
            folder.rename(folder.with_name(seat + ".abandoned-" + time.strftime("%Y%m%d%H%M%S")))
        return {"abandoned": True, "removed": removed, "left": left}

    def control(self, seat, action):
        """Scheduling of one onboarded seat, with the same rules as every other native relay."""
        folder = self.root / "seats" / seat
        config = read_json(folder / "control.json")
        require(isinstance(config, dict), "unknown_seat")
        return load_module("relay_sub_control", self.config["control_broker"]).execute(config, action)


def main(arguments):
    os.umask(0o077)
    try:
        broker = Broker(json.loads(Path(arguments[1]).read_text()))
        if arguments[2] == "control":
            match = re.fullmatch(r"seat-control ([0-9a-f]{8})", os.environ.get("SSH_ORIGINAL_COMMAND", ""))
            request = json.loads(sys.stdin.read(256))
            require(match and set(request) == {"action"}, "invalid_request")
            print(json.dumps(broker.control(match.group(1), request["action"])))
            return 0
        request = json.loads(sys.stdin.read(4096))
        handler = getattr(broker, "act_" + str(request.get("action")), None)
        require(arguments[2] == "onboarding" and handler is not None, "unknown_action")
        if "seat" in request or request["action"] != "preflight":
            require(isinstance(request.get("seat"), str) and SEAT.fullmatch(request["seat"]), "invalid_seat")
        print(json.dumps({"ok": True, **handler(request)}))
        return 0
    except Refused as refusal:
        print(json.dumps({"ok": False, "error": refusal.code, "detail": refusal.detail}))
    except BaseException as error:  # the admin helper may call sys.exit; report by type only
        print(json.dumps({"ok": False, "error": "broker_failed", "detail": type(error).__name__}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
