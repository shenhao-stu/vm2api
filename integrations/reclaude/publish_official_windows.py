"""Publish a scoped, fresh official observation; never touch auth or scheduling."""
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from official_windows import normalize_windows


def publish(config, data, now_ms):
    fields = {'ok', 'binding', 'org', 'account_id', 'source_updated', 'observed_at_ms', 'windows'}
    if set(data) != fields or data['ok'] is not True or set(data['windows']) != {'five_hour', 'seven_day'}:
        raise ValueError('invalid_fields')
    normalize_windows(config, data, now_ms)
    if not 0 <= now_ms - data['observed_at_ms'] <= 120000:
        raise ValueError('unexpected_observation_time')
    if (Path(config['home']) / '.rec/claude/current').read_text().strip() != str(config['binding']):
        raise ValueError('binding_changed')
    target = Path(config['account_windows']['path'])
    with target.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if target.exists() and json.loads(target.read_bytes())['observed_at_ms'] >= data['observed_at_ms']:
            raise ValueError('out_of_order')
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
            tmp.write(json.dumps(data, allow_nan=False).encode())
        try:
            os.replace(tmp.name, target)
        finally:
            Path(tmp.name).unlink(missing_ok=True)


if __name__ == '__main__':
    os.umask(0o077)
    raw = sys.stdin.buffer.read(2049)
    if len(raw) > 2048:
        raise SystemExit('snapshot_too_large')
    publish(json.loads(Path(sys.argv[1]).read_text()), json.loads(raw), int(time.time() * 1000))
    print('official_windows_synchronized')
