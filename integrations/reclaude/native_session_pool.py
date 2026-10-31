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


def memory_pressure(path, high_bytes):
    if high_bytes == 0:
        return False
    try:
        with Path(path).open() as file:
            raw = file.read(64).strip()
        if not raw.isascii() or not raw.isdecimal():
            raise ValueError()
        current = int(raw)
    except (OSError, ValueError):
        raise ContractError("native_memory_not_ready") from None
    try:
        stat = dict(line.split() for line in Path(path).with_name("memory.stat").read_text().splitlines())
        inactive = int(stat["inactive_file"])
    except (OSError, ValueError, KeyError):
        inactive = 0
    # Match vm2api's cgroup working set; inconsistent stats cannot lower usage.
    return current - (inactive if 0 <= inactive <= current else 0) >= high_bytes


def idle(entry):
    return not entry.busy and (
        entry.session.failed or not getattr(entry.session, "pending_ids", set())
    )


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
        prepared_idle_seconds=120,
        under_pressure=lambda: False,
    ):
        if type(capacity) is not int or not 1 <= capacity <= 10 or not 0 < idle_seconds <= 86400:
            raise ValueError("invalid_native_pool_limits")
        if not 0 < prepared_idle_seconds <= 86400:
            raise ValueError("invalid_prepared_idle_limit")
        self.root = Path(root)
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.factory, self.capacity, self.idle_seconds, self.clock = (
            factory,
            capacity,
            idle_seconds,
            clock,
        )
        self.recover = recover
        self.under_pressure = under_pressure
        self.prepared_idle_seconds = min(idle_seconds, prepared_idle_seconds)
        self.entries = {}
        self.lock = threading.Lock()
        self.stopped = False

    def expire(self):
        now = self.clock()
        with self.lock:
            expired = [
                (key, e)
                for key, e in self.entries.items()
                if idle(e)
                and now - e.touched >= (
                    self.prepared_idle_seconds
                    if getattr(e.session, "prepared", False)
                    else self.idle_seconds
                )
            ]
            for _, entry in expired:
                entry.busy = True
        for key, entry in expired:
            self.retire(key, entry)
        reclaimed = len(expired)
        while self.under_pressure():
            with self.lock:
                selected = self.reserve_idle()
            if selected is None:
                break
            self.retire(*selected)
            reclaimed += 1
        return reclaimed

    def reserve_idle(self, exclude=None):
        """Called under the pool lock; closing entries remain capacity-reserved."""
        candidates = [(e.touched, k) for k, e in self.entries.items()
                      if k != exclude and self.recover and idle(e)]
        if not candidates:
            return None
        key = min(candidates)[1]
        entry = self.entries[key]
        entry.busy = True
        return key, entry

    def snapshot(self):
        with self.lock:
            return {"capacity": self.capacity, "resident": len(self.entries),
                    "busy": sum(e.busy for e in self.entries.values()),
                    "pending_tools_sessions": sum(
                        bool(getattr(e.session, "pending_ids", set()))
                        and not e.session.failed for e in self.entries.values()),
                    "prepared": sum(bool(getattr(e.session, "prepared", False))
                                    for e in self.entries.values()),
                    "idle_seconds": self.idle_seconds,
                    "prepared_idle_seconds": self.prepared_idle_seconds}

    def retire(self, key, entry):
        # Keep closing processes counted, but never wait under the pool lock.
        entry.session.close(graceful=True)
        with self.lock:
            if self.entries.get(key) is entry:
                self.entries.pop(key)

    @contextmanager
    def lease(self, tenant, body):
        native_options(body)
        identity = session_identity(body)
        key = hashlib.sha256((tenant + "\0" + identity).encode()).hexdigest()
        # The reaper handles expiry; hot requests need not wait for other CLIs.
        while True:
            retiring = None
            with self.lock:
                if self.stopped:
                    raise ContractError("native_pool_stopped")
                entry = self.entries.get(key)
                if entry is not None:
                    if entry.busy:
                        raise ContractError("session_busy")
                    if entry.session.failed:
                        raise ContractError("native_session_failed_no_replay")
                else:
                    existing = (self.root / key).exists()
                    if existing and self.recover is None:
                        raise ContractError("native_session_expired_no_replay")
                    if not existing:
                        fresh_prompt(body["messages"])
                pressure = self.under_pressure()
                if pressure or (entry is None and len(self.entries) >= self.capacity):
                    retiring = self.reserve_idle(exclude=key)
                    if retiring is None:
                        raise ContractError("native_memory_pressure" if pressure
                                            else "native_session_capacity")
                elif entry is None:
                    session = (self.recover if existing else self.factory)(
                        self.root / key, body
                    )
                    entry = self.entries[key] = Entry(session, self.clock())
                if retiring is None:
                    entry.busy = True
            if retiring is None:
                break
            self.retire(*retiring)
        try:
            yield entry.session
        finally:
            retiring = None
            with self.lock:
                entry.touched = self.clock()
                if getattr(entry.session, "suspended", False):
                    retiring = key, entry
                else:
                    entry.busy = False
            if retiring:
                self.retire(*retiring)

    def close(self):
        with self.lock:
            self.stopped = True
            sessions = [entry.session for entry in self.entries.values()]
            self.entries.clear()
        for session in sessions:
            session.close()
