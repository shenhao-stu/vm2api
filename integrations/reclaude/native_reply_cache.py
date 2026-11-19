"""Answer an identical caller request again without a second model dispatch.

A caller that loses its connection, hedges with a non-streaming twin, or retries
a turn that already completed sends the very same history a second time. The
native channel correctly refuses to run a paid turn twice. Replaying the answer
it already produced keeps that guarantee and lets the caller continue.

Only a completed, non-refused turn is kept, for a short time, scoped to the
authenticated tenant and caller session. A replay reports zero usage: nothing
was dispatched for it.
"""

import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time

REPLAYABLE = frozenset({"request_already_consumed", "native_request_in_flight_no_replay"})
ZERO_USAGE = {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
}
_DIGEST = re.compile(r"[0-9a-f]{64}")


def without_usage(event):
    """The same event, reporting that this response consumed nothing."""
    if event.get("type") == "message_start":
        return {**event, "message": {**event["message"], "usage": dict(ZERO_USAGE)}}
    if event.get("type") == "message_delta":
        return {**event, "usage": dict(ZERO_USAGE)}
    return event


class ReplyCache:
    def __init__(self, root, ttl_seconds=1800, per_scope=8, max_bytes=4 << 20,
                 max_waiters=3, clock=time.time):
        self.root = Path(root)
        self.ttl_seconds, self.per_scope, self.max_bytes = ttl_seconds, per_scope, max_bytes
        self.max_waiters, self.clock = max_waiters, clock
        self.lock = threading.Lock()
        self.running = {}
        self.waiting = set()

    def path(self, scope, request):
        if not (isinstance(scope, str) and isinstance(request, str)
                and _DIGEST.fullmatch(scope) and _DIGEST.fullmatch(request)):
            return None
        return self.root / scope / (request + ".json")

    def store(self, scope, request, model, message, events):
        """Keep one completed answer. Returns whether it was kept."""
        path = self.path(scope, request)
        if (path is None or not isinstance(message, dict)
                or message.get("stop_reason") in (None, "refusal")):
            return False
        document = json.dumps({"at": self.clock(), "model": model,
                               "message": message, "events": events})
        if len(document) > self.max_bytes:
            return False
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".reply-")
            with os.fdopen(handle, "w") as file:
                file.write(document)
            os.replace(temporary, path)
            self.prune(path.parent)
        except OSError:
            return False
        return True

    def prune(self, directory):
        """Drop expired answers and keep only the newest few per caller session."""
        now = self.clock()
        kept = []
        for path in directory.glob("*.json"):
            try:
                modified = path.stat().st_mtime
            except OSError:
                continue
            if now - modified > self.ttl_seconds:
                path.unlink(missing_ok=True)
            else:
                kept.append((modified, path))
        for _, path in sorted(kept)[:-self.per_scope]:
            path.unlink(missing_ok=True)

    def sweep(self):
        """Periodic cleanup of every caller session; returns removed directories."""
        removed = 0
        try:
            directories = [d for d in self.root.iterdir() if d.is_dir()]
        except OSError:
            return removed
        for directory in directories:
            self.prune(directory)
            try:
                directory.rmdir()
                removed += 1
            except OSError:
                pass
        return removed

    def load(self, scope, request, model):
        path = self.path(scope, request)
        if path is None:
            return None
        try:
            reply = json.loads(path.read_bytes())
        except (OSError, ValueError):
            return None
        if (not isinstance(reply, dict) or reply.get("model") != model
                or self.clock() - reply.get("at", 0) > self.ttl_seconds
                or not isinstance(reply.get("message"), dict)
                or not isinstance(reply.get("events"), list)):
            return None
        return reply

    def begin(self, scope, request):
        """Mark the dispatching request so one identical repeat can join it."""
        key = (scope, request)
        with self.lock:
            if key in self.running:
                return None
            self.running[key] = threading.Event()
        return key

    def finish(self, key):
        if key is None:
            return
        with self.lock:
            finished = self.running.pop(key, None)
        if finished:
            finished.set()

    def join(self, scope, request, model, seconds):
        """Wait for the identical request already running; bounded and exclusive."""
        key = (scope, request)
        with self.lock:
            finished = self.running.get(key)
            if finished is None or key in self.waiting or len(self.waiting) >= self.max_waiters:
                return None
            self.waiting.add(key)
        try:
            finished.wait(max(0, seconds))
        finally:
            with self.lock:
                self.waiting.discard(key)
        return self.load(scope, request, model)
