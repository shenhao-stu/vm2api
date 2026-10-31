"""Bounded native session leases; caller identity is scoped to an authenticated key."""

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import threading
import time
import uuid

from native_bridge_session import ContractError, fresh_prompt, native_options


def session_identity(body):
    value = body.get("metadata", {}).get("user_id")
    if not isinstance(value, str):
        raise ContractError("caller_session_required")
    try:
        parsed = json.loads(value)
        value = parsed["session_id"]
    except (ValueError, TypeError, KeyError):
        match = re.fullmatch(
            r"user_[a-f0-9]+_account_[a-zA-Z0-9-]*_session_([a-f0-9-]{36})", value
        )
        if match:
            value = match.group(1)
    try:
        identifier = str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise ContractError("invalid_caller_session") from None
    if identifier != value:
        raise ContractError("invalid_caller_session")
    return identifier


@dataclass
class Entry:
    session: object
    touched: float
    busy: bool = False


class SessionPool:
    def __init__(
        self,
        root,
        factory,
        capacity=10,
        idle_seconds=1800,
        clock=time.monotonic,
        recover=None,
    ):
        if type(capacity) is not int or not 1 <= capacity <= 10 or idle_seconds <= 0:
            raise ValueError("invalid_native_pool_limits")
        self.root = Path(root)
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.factory, self.capacity, self.idle_seconds, self.clock = (
            factory,
            capacity,
            idle_seconds,
            clock,
        )
        self.recover = recover
        self.entries = {}
        self.lock = threading.Lock()
        self.stopped = False

    def expire(self):
        now = self.clock()
        with self.lock:
            expired = [
                key
                for key, e in self.entries.items()
                if not e.busy
                and (not getattr(e.session, "pending_ids", set()) or e.session.failed)
                and now - e.touched >= self.idle_seconds
            ]
            for key in expired:
                self.entries.pop(key).session.close(graceful=True)
        return len(expired)

    @contextmanager
    def lease(self, tenant, body):
        native_options(body)
        identity = session_identity(body)
        key = hashlib.sha256((tenant + "\0" + identity).encode()).hexdigest()
        self.expire()
        with self.lock:
            if self.stopped:
                raise ContractError("native_pool_stopped")
            entry = self.entries.get(key)
            if entry is None:
                existing = (self.root / key).exists()
                if existing and self.recover is None:
                    raise ContractError("native_session_expired_no_replay")
                if not existing:
                    fresh_prompt(body["messages"])
                if len(self.entries) >= self.capacity and self.recover:
                    candidates = [
                        (e.touched, k)
                        for k, e in self.entries.items()
                        if not e.busy and not getattr(e.session, "pending_ids", set())
                    ]
                    if candidates:
                        self.entries.pop(min(candidates)[1]).session.close(
                            graceful=True
                        )
                if len(self.entries) >= self.capacity:
                    raise ContractError("native_session_capacity")
                session = (self.recover if existing else self.factory)(
                    self.root / key, body
                )
                entry = self.entries[key] = Entry(session, self.clock())
            if entry.busy:
                raise ContractError("session_busy")
            if entry.session.failed:
                raise ContractError("native_session_failed_no_replay")
            entry.busy = True
        try:
            yield entry.session
        finally:
            with self.lock:
                entry.busy = False
                entry.touched = self.clock()
                if getattr(entry.session, "suspended", False):
                    self.entries.pop(key, None)
                    entry.session.close(graceful=True)

    def close(self):
        with self.lock:
            self.stopped = True
            sessions = [entry.session for entry in self.entries.values()]
            self.entries.clear()
        for session in sessions:
            session.close()
