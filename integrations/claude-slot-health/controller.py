"""Native API pause-only reconciliation; deployment adapter contains credentials."""
import argparse
import importlib.util
import json
from pathlib import Path
import time
from policy import pause_plan, weekly_priority


def cycle(adapter, config, now):
    snapshot = adapter.snapshot()
    accounts = adapter.accounts()
    bindings = config['bindings']
    changes = pause_plan(snapshot, accounts, bindings, now)
    for change in changes:
        adapter.pause(change, accounts[change['account_id']])
    slots = {s['id']: s for s in snapshot['slots']}
    paused = {c['account_id'] for c in changes}
    ranks = []
    for b in bindings:
        a = accounts[b['account_id']]
        if not b.get('weekly_priority') or not a.get('schedulable') or a['id'] in paused:
            continue
        before = a['priority']
        base = config.get('priority_base', 20)
        # A manual move outside the owned priority band relinquishes ownership.
        if not base <= before <= base + 7:
            continue
        after = weekly_priority(slots[b['slot_id']], now, base)
        if before != after:
            adapter.priority(a['id'], before, after)
            ranks.append({'id': a['id'], 'priority': after})
    return {'at': now, 'paused': changes, 'priorities': ranks, 'checked': len(bindings)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--config', required=True)
    p.add_argument('--once', action='store_true')
    args = p.parse_args()
    config = json.loads(Path(args.config).read_text())
    spec = importlib.util.spec_from_file_location('adapter', config['adapter'])
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    while True:
        try:
            result = cycle(adapter, config, time.time())
            target = Path(config['state'])
            tmp = target.with_suffix('.tmp')
            tmp.write_text(json.dumps(result))
            tmp.chmod(0o600)
            tmp.replace(target)
            if result['paused'] or result['priorities'] or args.once:
                print(json.dumps(result), flush=True)
        except Exception as exc:
            print(json.dumps({'event': 'reconcile_failed', 'error': type(exc).__name__}), flush=True)
            if args.once: raise
        if args.once: return
        time.sleep(30)


if __name__ == '__main__': main()
