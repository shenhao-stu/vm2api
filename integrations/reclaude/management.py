"""Opt-in management of an independent native Relay, not a kin/Pro slot.

Commands and paths come only from an administrator-owned local configuration.
No HTTP input becomes a host, command, path, account ID or authorization change.
"""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import math
import sqlite3
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


def guard_status(config, snapshot=None):
    try:
        g = snapshot if snapshot is not None else json.loads(Path(config["guard_file"]).read_text())
        age = time.time() - datetime.fromisoformat(g["checked_at"].replace("Z", "+00:00")).timestamp()
        ready = (g.get("ready") is True and g.get("latched") is False
                 and g.get("expected_ip") == g.get("observed_ip") == config["expected_ip"]
                 and g.get("revision") == config["guard_revision"] and 0 <= age < 180)
        return {"ready": ready, "latched": g.get("latched") is not False,
                "expected_ip": config["expected_ip"], "observed_ip": g.get("observed_ip"),
                "checked_at": g.get("checked_at"), "revision": g.get("revision")}
    except (OSError, ValueError, KeyError, TypeError):
        return {"ready": False, "latched": True, "expected_ip": config["expected_ip"]}


def relay_usage(config, now=None):
    ledger = config.get("usage_ledger")
    if not ledger:
        return None
    now = now or datetime.now(timezone.utc)
    def stamp(value):
        return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        uri = Path(ledger["path"]).as_uri() + "?mode=ro"
        account_id = ledger["account_id"]
        if not isinstance(account_id, str) or not account_id:
            return None
        with closing(sqlite3.connect(uri, uri=True, timeout=0.25)) as db:
            # Final backend owns the logged cost. Older single-attempt rows
            # may only identify it in account_id.
            row = db.execute("""
                SELECT sum(total_cost),
                       sum(CASE WHEN created_at >= :since THEN total_cost ELSE 0 END),
                       sum(CASE WHEN created_at >= :week THEN total_cost ELSE 0 END),
                       count(*), count(total_cost), min(created_at)
                FROM usage_logs
                WHERE created_at <= :now AND (
                    final_account_id = :account OR
                    (final_account_id IS NULL AND account_id = :account AND attempt_count = 1)
                )
            """, {"account": account_id, "since": stamp(now - timedelta(hours=5)),
                  "week": stamp(now - timedelta(days=7)), "now": stamp(now)}).fetchone()
    except (KeyError, ValueError, TypeError, OSError, sqlite3.Error):
        return None
    total, recent, week, count, priced, first = row
    return {"total_usd": total or 0, "last_5h_usd": recent or 0, "last_7d_usd": week or 0,
            "unpriced_requests": count - priced, "first_at": first}


def official_quota(config, now=None):
    """A billing reader publishes a scoped snapshot, without web credentials."""
    source = config.get("official_quota")
    if not source:
        return None
    try:
        with Path(source["path"]).open() as stream:
            data = json.loads(stream.read(2048))
        if (data["binding"], data["org_id"], data["account_id"]) != (
                config["binding"], source["org_id"], source["account_id"]):
            return None
        used, limit = data["used_usd"], data["quota_usd"]
        if any(type(n) not in (float, int) or not math.isfinite(n) for n in (used, limit)):
            return None
        observed, reset = data["observed_at_ms"], data["resets_at_ms"]
        now_ms = int((now if now is not None else time.time()) * 1000)
        if (type(observed) is not int or not 0 < observed <= now_ms or used < 0 or limit <= 0
                or reset is not None and (type(reset) is not int or not 0 < reset < 8640000000000000)):
            return None
        stale = now_ms - observed > 600000 or (reset is not None and reset <= now_ms)
        return {"used_usd": used, "quota_usd": limit, "resets_at_ms": reset,
                "observed_at_ms": observed, "stale": stale}
    except (KeyError, TypeError, ValueError, OSError, OverflowError):
        return None


# Scheduling stops once this share of the seat quota or less is left, and comes
# back only when at least the larger share is available again.
SEAT_PAUSE_REMAINING = 0.01
SEAT_RESUME_REMAINING = 0.05
# Our own metering ran 1-4% under the official figure over the same interval.
METERED_MARGIN = 1.05
# A new cycle is assumed this long after the official reset time. The reading
# does not carry the cycle length; a week is the shortest one seen, so a reset
# time older than that says nothing about the current cycle.
RESET_GRACE_MS = 600000
CYCLE_MS = 7 * 86400000


def metered_since(config, since_ms, now_ms):
    """Cost this relay metered itself in (since, now], or None without a readable ledger."""
    ledger = config.get("usage_ledger")
    if not ledger:
        return None
    def stamp(ms):
        return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z")
    try:
        account_id = ledger["account_id"]
        if not isinstance(account_id, str) or not account_id:
            return None
        uri = Path(ledger["path"]).as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=0.25)) as db:
            row = db.execute("""
                SELECT sum(total_cost) FROM usage_logs
                WHERE created_at > :since AND created_at <= :now AND (
                    final_account_id = :account OR
                    (final_account_id IS NULL AND account_id = :account AND attempt_count = 1)
                )
            """, {"account": account_id, "since": stamp(since_ms), "now": stamp(now_ms)}).fetchone()
        cost = row[0] or 0
        return cost if math.isfinite(cost) and cost >= 0 else None
    except (KeyError, ValueError, TypeError, OSError, OverflowError, sqlite3.Error):
        return None


def seat_quota(config, now=None):
    """Seat usage for scheduling decisions.

    The official reading is used while it is fresh. The reader depends on a
    browser session and is often away, so a stale reading is carried forward
    with the cost this relay metered since then. After the official reset time
    only the cost metered in the new cycle counts.
    """
    now_ms = int((now if now is not None else time.time()) * 1000)
    official = official_quota(config, now_ms / 1000)
    if not official:
        return None
    limit, reset = official["quota_usd"], official["resets_at_ms"]
    if not official["stale"]:
        used, source, cycle_reset = official["used_usd"], "official", False
    else:
        after_reset = -1 if reset is None else now_ms - reset
        if 0 <= after_reset < RESET_GRACE_MS or after_reset >= CYCLE_MS:
            return None  # at the reset instant, or cycles later, neither figure can be trusted
        cycle_reset = after_reset >= 0
        start, base = (reset, 0) if cycle_reset else (official["observed_at_ms"], official["used_usd"])
        metered = metered_since(config, start, now_ms)
        if metered is None:
            return None
        used, source = base + metered * METERED_MARGIN, "estimated"
        if cycle_reset:
            reset = None
    return {"used_usd": used, "quota_usd": limit, "resets_at_ms": reset, "source": source,
            "cycle_reset": cycle_reset, "remaining": (limit - used) / limit}


class Manager:
    def __init__(self, config, call=command):
        self.config, self.call = config, call
        self.root = Path(config["state_dir"])
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        (self.root / "operations").mkdir(mode=0o700, exist_ok=True)
        self.lock = threading.Lock()
        self.cached = None
        self.exit_retry_at = 0

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
        revoked = r.get("revoked") or r.get("auth_latched")
        under_review = "native_account_needs_review" in (r.get("failed_checks") or ())
        if (revoked or under_review) and sub.get("schedulable") is not False:
            sub = self.sub("pause")
            if sub.get("schedulable") is not False:
                raise ManagementError("sub_pause_unconfirmed", 503)
        if revoked:
            evidence = self.root / "authorization-latch.json"
            if not evidence.exists():
                data = {"at": time.time(), "binding": self.config["binding"],
                        "sub_account": self.config["sub_account"], "paused": True,
                        "revoked": bool(r.get("revoked")), "auth_latched": bool(r.get("auth_latched"))}
                with evidence.open("x") as file:
                    json.dump(data, file)
                self.record("authorization_latched", **data)
        elif under_review:
            evidence = self.root / "account-review.json"
            if not evidence.exists():
                data = {"at": time.time(), "sub_account": self.config["sub_account"],
                        "paused": True, "reason": "account_needs_review"}
                with evidence.open("x") as file:
                    json.dump(data, file)
                self.record("account_needs_review", **data)
        guard = (guard_status(self.config, r.get("exit_guard") or {})
                 if self.config.get("guard_source") == "runtime" else guard_status(self.config))
        seat = seat_quota(self.config)
        sub = self._pause_exhausted_seat(seat, sub)
        result = {"id": self.config["id"], "name": self.config["name"],
                  "node": self.config["node"], "kind": "reclaude_native",
                  "binding": self.config["binding"], "sub_account": self.config["sub_account"],
                  "concurrency": self.config["concurrency"], "models": self.config["models"],
                  "observed_at": time.time(), "runtime": r, "guard": guard,
                  "usage": relay_usage(self.config), "official_quota": official_quota(self.config),
                  "seat_quota": seat, "seat_quota_paused": self.seat_pause.exists(),
                  "sub": sub, "authorization_latched": (self.root / "authorization-latch.json").exists()}
        self._resume_reset_seat(result)
        self.cached = result
        return result

    @property
    def seat_pause(self):
        return self.root / "seat-quota-pause.json"

    def _pause_exhausted_seat(self, seat, sub):
        """Stop scheduling a seat whose quota is used up. In-flight turns are not touched."""
        if (not seat or seat["remaining"] > SEAT_PAUSE_REMAINING or self.seat_pause.exists()
                or sub.get("schedulable") is False):
            return sub
        sub = self.sub("pause")
        if sub.get("schedulable") is not False:
            raise ManagementError("sub_pause_unconfirmed", 503)
        data = {"at": time.time(), "sub_account": self.config["sub_account"],
                **{key: seat[key] for key in ("used_usd", "quota_usd", "resets_at_ms", "source")}}
        with self.seat_pause.open("x") as file:
            json.dump(data, file)
        self.record("seat_quota_paused", **data)
        return sub

    def _end_seat_pause(self, event, **data):
        self.seat_pause.replace(self.root / ("seat-quota-pause.%d.json" % int(time.time() * 1000)))
        self.record(event, **data)

    def _resume_reset_seat(self, state):
        """Undo only our own quota pause, and only once the seat has quota again."""
        if not self.seat_pause.exists():
            return
        if state["sub"].get("schedulable") is not False:
            state["seat_quota_paused"] = False  # someone resumed it: that stands
            return self._end_seat_pause("seat_quota_pause_superseded", reason="resumed")
        seat = state["seat_quota"]
        if not seat or seat["remaining"] < SEAT_RESUME_REMAINING:
            return
        try:
            self.require_schedule_ready(state)
        except ManagementError:
            return  # not healthy yet; the next refresh looks again
        if time.monotonic() < self.exit_retry_at:
            return
        try:
            self.runtime("verify_exit")
        except ManagementError:
            # Do not probe the exit through the public lookup services every half minute.
            self.exit_retry_at = time.monotonic() + 300
            return
        sub = self.sub("resume")
        if not sub.get("schedulable"):
            return
        state["sub"], state["seat_quota_paused"] = sub, False
        self._end_seat_pause("seat_quota_resumed", **{key: seat[key] for key in ("used_usd", "quota_usd", "source")})

    def status(self):
        if self.cached and time.time() - self.cached["observed_at"] < 15:
            return self.cached
        return self.refresh()

    def logs(self):
        runtime = self.runtime("logs")
        return {"runtime": runtime.get("items", []), "management": read_tail(self.root / "audit.jsonl")}

    def require_schedule_ready(self, state):
        r = state["runtime"]
        seat = state["seat_quota"]
        if seat and seat["remaining"] <= SEAT_PAUSE_REMAINING:
            raise ManagementError("seat_quota_exhausted")
        if (state["authorization_latched"] or r.get("revoked") or r.get("auth_latched")
                or not state["guard"]["ready"] or state["sub"].get("shared_policy_matches") is False
                or r.get("failed_checks") or r.get("management_paused")
                or not all(r.get(k) for k in ("container_running", "http_active", "http_ready"))):
            raise ManagementError("schedule_requires_healthy_running_relay")

    def action(self, action, operation_id):
        if action not in ("start", "stop", "pause_schedule", "resume_schedule"):
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
            if action in ("pause_schedule", "stop") and self.seat_pause.exists():
                # The operator wants it paused: a quota reset must not undo that.
                self._end_seat_pause("seat_quota_pause_superseded", reason=action)
            if action == "pause_schedule":
                # The native scheduler is authoritative; never stop a paid turn.
                if self.sub("pause").get("schedulable") is not False:
                    raise ManagementError("sub_pause_unconfirmed", 503)
            state = self._refresh()
            if action == "resume_schedule":
                self.require_schedule_ready(state)
                self.runtime("verify_exit")
                self.require_schedule_ready(self._refresh())
                self.sub("resume")
            elif action == "stop":
                paused = self.sub("pause")
                if paused.get("schedulable") is not False:
                    raise ManagementError("sub_pause_unconfirmed", 503)
                # Runtime refuses to stop until in-flight requests have drained.
                self.runtime("stop")
            elif action == "start":
                if state["sub"].get("shared_policy_matches") is False:
                    raise ManagementError("shared_routing_profile_changed")
                r = state["runtime"]
                if (state["authorization_latched"] or r.get("revoked") or r.get("auth_latched")
                        or r.get("failed_checks") or not state["guard"]["ready"]
                        or not r.get("container_running")):
                    raise ManagementError("start_requires_healthy_original_binding_and_exit")
                seat = state["seat_quota"]
                if seat and seat["remaining"] <= SEAT_PAUSE_REMAINING:
                    raise ManagementError("seat_quota_exhausted")
                self.runtime("verify_exit")
                self.runtime("start")
                ready = self._refresh()
                if (not ready["runtime"].get("http_ready") or not ready["guard"]["ready"]
                        or ready["authorization_latched"]):
                    raise ManagementError("relay_not_ready", 503)
                self.sub("resume")
            self.cached = None
            result = self._refresh()
            if action == "pause_schedule" and result["sub"].get("schedulable") is not False:
                raise ManagementError("sub_pause_unconfirmed", 503)
            if action in ("start", "resume_schedule") and not result["sub"].get("schedulable"):
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
