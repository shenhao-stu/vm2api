"""Onboarding sessions for native Relay seats, shared by the console service and the runner.

The console service can do two things only: read session state, and drop a small request
file into a spool directory. A separate runner owns provisioning. No HTTP input becomes a
host, a command or a path: a seat is an eight-digit hex id chosen here, an exit is an id
from an administrator-maintained list, and the display name is matched against a pattern.
"""
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
import uuid

STEPS = ("preflight", "prepare", "exit_check", "login", "native", "worker", "native_canary",
         "gateway", "route", "sub", "sub_canary", "manager", "promote", "live")
# Before the device is authorized nothing is worth repairing: start again instead.
NOT_RETRIABLE = ("prepare", "login")
OPEN = ("queued", "running", "awaiting_authorization", "failed", "abandoning")
CLOSED = ("live", "abandoned")
REQUESTS = ("start", "retry", "abandon")
KEEP_CLOSED = 86400
# The runner marks a file every few seconds. Without a fresh mark, requests would only pile up.
RUNNER_SILENT = 45

SEAT = re.compile(r"[0-9a-f]{8}")
EGRESS = re.compile(r"[a-z0-9][a-z0-9-]{1,31}")
NAME = re.compile(r"[\w][\w .·-]{0,23}")
MAX_ORG = 10 ** 9


class OnboardingError(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status
        super().__init__(code)


def valid_operation(value):
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def valid_name(value):
    return isinstance(value, str) and bool(NAME.fullmatch(value)) and value == value.strip()


def valid_org(value):
    return type(value) is int and 0 < value < MAX_ORG


def write_atomic(path, data):
    """Readers see either the old file or the complete new one."""
    path = Path(path)
    temporary = path.with_name("." + path.name + "." + secrets.token_hex(4))
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def oldest_first(paths):
    """Files by age. The other service adds and removes files meanwhile: one that is gone is skipped."""
    found = []
    for path in paths:
        try:
            found.append((path.stat().st_mtime, path.name, path))
        except OSError:
            continue
    return [path for _, _, path in sorted(found)]


def new_session(seat, name, egress, expected_ip, org, now):
    return {"seat": seat, "name": name, "egress": egress, "expected_ip": expected_ip, "org": org,
            "created_at": now, "updated_at": now, "status": "queued",
            "steps": {key: {"status": "pending"} for key in STEPS},
            "authorization": None, "error": None, "result": {}, "facts": {}}


def public_view(session):
    """What an administrator's browser may see. Internal facts stay on the server."""
    steps = [{"key": key, **{field: session["steps"][key].get(field) for field in ("status", "started_at", "finished_at")}}
             for key in STEPS]
    return {**{key: session.get(key) for key in ("seat", "name", "egress", "expected_ip", "org", "created_at",
                                                 "updated_at", "status", "authorization", "error", "result")},
            "steps": steps}


class Store:
    """Directory layout under one private root:

    options.json   exits an administrator verified: [{"id", "label", "expected_ip"}]
    spool/         requests waiting for the runner (the only place the console service writes)
    receipts/      one marker per consumed operation id
    sessions/      one JSON file per seat, written only by the runner
    """

    def __init__(self, root, clock=time.time):
        self.root, self.clock = Path(root), clock
        self.spool, self.receipts, self.sessions = self.root / "spool", self.root / "receipts", self.root / "sessions"
        self.starting = threading.Lock()

    # ------------------------------------------------------------ reading

    def options(self):
        rows = read_json(self.root / "options.json") or []
        return [{"id": row["id"], "label": str(row["label"])[:40], "expected_ip": str(row["expected_ip"])[:45]}
                for row in rows if isinstance(row, dict) and EGRESS.fullmatch(str(row.get("id", "")))]

    def load(self, seat):
        if not isinstance(seat, str) or not SEAT.fullmatch(seat):
            return None
        return read_json(self.sessions / (seat + ".json"))

    def saved(self):
        """Sessions the runner has written, oldest first."""
        found = []
        for path in self.sessions.glob("*.json"):
            session = read_json(path)
            if isinstance(session, dict) and SEAT.fullmatch(str(session.get("seat", ""))) and path.stem == session["seat"]:
                found.append(session)
        return sorted(found, key=lambda session: session["created_at"])

    def all(self):
        """Sessions the runner knows, plus accepted starts it has not picked up yet."""
        found = {session["seat"]: session for session in self.saved()}
        for request in self.pending():
            if request["action"] == "start" and request["seat"] not in found:
                found[request["seat"]] = new_session(request["seat"], request["name"], request["egress"],
                                                     request["expected_ip"], request["org"], request["at"])
        return sorted(found.values(), key=lambda session: -session["created_at"])

    def pending(self):
        requests = []
        for path in oldest_first(self.spool.glob("*.json")):
            request = read_json(path)
            if isinstance(request, dict) and request.get("action") in REQUESTS:
                requests.append(request)
        return requests

    def runner_alive(self):
        try:
            return self.clock() - (self.root / "runner.alive").stat().st_mtime < RUNNER_SILENT
        except OSError:
            return False

    def view(self):
        """Open sessions, and closed ones for a day so their outcome can be read."""
        recent = self.clock() - KEEP_CLOSED
        sessions = [session for session in self.all() if session["status"] in OPEN or session["updated_at"] >= recent]
        return {"options": self.options(), "sessions": [public_view(session) for session in sessions],
                "busy": any(session["status"] in OPEN for session in sessions), "runner_alive": self.runner_alive()}

    # ------------------------------------------------------------ console service

    def submit(self, request):
        operation = request["id"]
        if not valid_operation(operation):
            raise OnboardingError("invalid_operation_id", 400)
        if (self.receipts / operation).exists() or (self.spool / (operation + ".json")).exists():
            raise OnboardingError("operation_already_consumed")
        if not self.runner_alive():
            # Nobody would take the request: say so now instead of leaving it queued.
            raise OnboardingError("runner_not_running", 503)
        write_atomic(self.spool / (operation + ".json"), {**request, "at": self.clock()})

    def start(self, operation, name, egress, org):
        if not valid_name(name):
            raise OnboardingError("invalid_name", 400)
        if not valid_org(org):
            raise OnboardingError("invalid_org", 400)
        option = next((row for row in self.options() if row["id"] == egress), None)
        if option is None:
            raise OnboardingError("unknown_egress", 400)
        with self.starting:  # two administrators pressing Add together get one session
            sessions = self.all()
            if any(session["status"] in OPEN for session in sessions):
                raise OnboardingError("onboarding_in_progress")
            taken = {session["seat"] for session in sessions}
            seat = secrets.token_hex(4)
            while seat in taken:
                seat = secrets.token_hex(4)
            self.submit({"id": operation, "action": "start", "seat": seat, "name": name, "egress": egress,
                         "expected_ip": option["expected_ip"], "org": org})
        return public_view(new_session(seat, name, egress, option["expected_ip"], org, self.clock()))

    def change(self, operation, seat, action):
        if action not in ("retry", "abandon"):
            raise OnboardingError("not_found", 404)
        session = next((item for item in self.all() if item["seat"] == seat), None)
        if session is None:
            raise OnboardingError("not_found", 404)
        if session["status"] in CLOSED or session["status"] == "abandoning":
            raise OnboardingError("session_closed")
        if action == "retry":
            error = session.get("error") or {}
            if session["status"] != "failed" or not error.get("retriable"):
                raise OnboardingError("retry_not_available")
        self.submit({"id": operation, "action": action, "seat": seat})
        return public_view(session)

    # ------------------------------------------------------------ runner

    def prepare(self):
        for folder in (self.root, self.spool, self.receipts, self.sessions):
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)

    def beat(self):
        """The runner is running. Called from its own thread, so a long step does not look like a stop."""
        (self.root / "runner.alive").touch(mode=0o600)

    def take(self, match=None):
        """The oldest request (that `match` accepts), removed from the spool. Unreadable files are discarded."""
        for path in oldest_first(self.spool.iterdir()):
            if path.name.startswith("."):
                # A file still being written by the console service; one left behind by a crash is removed.
                try:
                    if time.time() - path.stat().st_mtime > 60:
                        path.unlink(missing_ok=True)
                except OSError:
                    pass
                continue
            request = read_json(path)
            valid = (isinstance(request, dict) and valid_operation(request.get("id"))
                     and path.name == request["id"] + ".json" and request.get("action") in REQUESTS)
            if valid and match is not None and not match(request):
                continue
            path.unlink(missing_ok=True)
            if not valid:
                continue
            (self.receipts / request["id"]).touch(mode=0o600)
            return request
        return None

    def save(self, session):
        session["updated_at"] = self.clock()
        write_atomic(self.sessions / (session["seat"] + ".json"), session)
