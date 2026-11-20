"""Pause new work after the provider would not confirm policy for a launch.

A launch whose policy stays unconfirmed sends the provider dozens of rejected
calls and cannot succeed until the provider answers again. After such a launch
the relay refuses requests for a growing pause, then admits a single probe: the
probe's outcome either clears the pause or doubles it.
"""

import math
import threading
import time

LAUNCH_REFUSED = "native_policy_not_ready_no_dispatch"
PROBE_WAIT_SECONDS = 5


class LaunchBackoff:
    def __init__(self, base_seconds=30, max_seconds=900, clock=time.monotonic):
        if not 0 < base_seconds <= max_seconds:
            raise ValueError("invalid_launch_backoff")
        self.base_seconds, self.max_seconds, self.clock = base_seconds, max_seconds, clock
        self.failures = 0
        self.until = 0.0
        self.probing = False
        self.lock = threading.Lock()

    def admit(self):
        """Return (epoch, 0) to proceed, or (None, seconds) to refuse without launching."""
        with self.lock:
            if self.failures:
                remaining = self.until - self.clock()
                if remaining > 0:
                    return None, math.ceil(remaining)
                if self.probing:
                    return None, PROBE_WAIT_SECONDS
                self.probing = True
            return self.failures, 0

    def failed(self, epoch):
        """A launch admitted in `epoch` ended without a policy confirmation."""
        with self.lock:
            # Launches that failed together count as one failure, not one each.
            if epoch != self.failures:
                return
            self.failures += 1
            pause = min(self.max_seconds, self.base_seconds * 2 ** (self.failures - 1))
            self.until = self.clock() + pause
            self.probing = False

    def succeeded(self):
        """The provider confirmed policy or answered a dispatch."""
        with self.lock:
            self.failures = 0
            self.until = 0.0
            self.probing = False

    def release(self, epoch):
        """The admitted request ended without learning anything about the provider."""
        with self.lock:
            if self.failures and epoch == self.failures:
                self.probing = False

    def snapshot(self):
        with self.lock:
            remaining = max(0.0, self.until - self.clock()) if self.failures else 0.0
            return {"failures": self.failures, "retry_in_seconds": math.ceil(remaining),
                    "probing": self.probing}
