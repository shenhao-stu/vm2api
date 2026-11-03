"""Accept one bounded official billing observation on stdin from a trusted operator."""
import fcntl
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time


def publish(config, observation, now_ms):
    source = config["official_quota"]
    integers = ("org_id", "account_id", "binding", "observed_at_ms")
    fields = {*integers, "used_usd", "quota_usd", "resets_at_ms"}
    if set(observation) != fields or any(type(observation[k]) is not int for k in integers):
        raise ValueError("invalid_fields")
    if any(observation[k] != source[k] for k in ("org_id", "account_id")) or observation["binding"] != config["binding"]:
        raise ValueError("wrong_relay")
    if not 0 <= now_ms - observation["observed_at_ms"] <= 120000:
        raise ValueError("unexpected_observation_time")
    used, limit = observation["used_usd"], observation["quota_usd"]
    if any(type(n) not in (int, float) or not math.isfinite(n) for n in (used, limit)) or used < 0 or limit <= 0:
        raise ValueError("invalid_quota")
    reset = observation["resets_at_ms"]
    if reset is not None and (type(reset) is not int or not 0 < reset < 8640000000000000):
        raise ValueError("invalid_reset")
    path = Path(source["path"])
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists() and json.loads(path.read_bytes())["observed_at_ms"] >= observation["observed_at_ms"]:
            raise ValueError("out_of_order")
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
            tmp.write(json.dumps(observation, allow_nan=False).encode())
        try:
            os.replace(tmp.name, path)
        finally:
            Path(tmp.name).unlink(missing_ok=True)


if __name__ == "__main__":
    os.umask(0o077)
    data = sys.stdin.buffer.read(2049)
    if len(data) > 2048:
        raise SystemExit("snapshot_too_large")
    publish(json.loads(Path(sys.argv[1]).read_text()), json.loads(data), int(time.time() * 1000))
    print("quota_synchronized")
