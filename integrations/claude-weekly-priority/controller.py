"""Low-cost metadata watcher. Adapter owns deployment-specific local API access."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
from scheduler import plan, timestamp


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, sort_keys=True))
    os.chmod(temp, 0o600)
    temp.replace(path)


def cycle(adapter, config, state, state_path, now):
    try:
        snapshot = adapter.snapshot()
        state['snapshot'] = snapshot
    except Exception as exc:
        # A failed refresh must not leave an expired window ranked first.
        snapshot = state.get('snapshot', {})
        print(json.dumps({'event': 'snapshot_unavailable', 'error_type': type(exc).__name__}), flush=True)
    accounts = adapter.accounts()
    ownership = state.setdefault('ownership', {})
    for key, claim in ownership.items():
        # An observed successful write closes its uncertain intent. Afterwards
        # an operator restoring the old priority must not be overwritten.
        if accounts.get(int(key), {}).get('priority') == claim['after']:
            claim['before'] = claim['after']
    result = plan(snapshot, accounts, config['bindings'], ownership, now)
    for change in result['changes']:
        aid = change['account_id']
        # Durable intent permits read-after-timeout recovery of this idempotent field.
        state['ownership'][str(aid)] = change
        save(state_path, state)
        adapter.set_priority(aid, change['before'], change['after'])
        state['ownership'][str(aid)] = {**change, 'before': change['after']}
        save(state_path, state)
        print(json.dumps({'event': 'priority_updated', **change}), flush=True)
    state.update(last_cycle=now, result=result)
    save(state_path, state)
    future = [timestamp(row.get('reset_7d')) for row in snapshot.get('slots', [])]
    waits = [deadline - time.time() + 0.2 for deadline in future if deadline and deadline > time.time()]
    return max(1, min([20] + waits))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    spec = importlib.util.spec_from_file_location('runtime', config['adapter'])
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    state_path = Path(config['state'])
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    while True:
        try:
            wait = cycle(adapter, config, state, state_path, time.time())
        except Exception as exc:
            print(json.dumps({'event': 'cycle_failed', 'error_type': type(exc).__name__}), flush=True)
            if args.once:
                raise
            wait = 20
        if args.once:
            return
        time.sleep(wait)


if __name__ == '__main__':
    main()
