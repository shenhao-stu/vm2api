"""Project trusted weekly reset times onto Sub2API's native priority field.

No model dispatch, quota clearing, credential writes or scheduling enable/disable.
An operator changing an owned priority takes that account out of automation.
"""
from datetime import datetime
import math

WEEK = 7 * 86400
UNKNOWN_PRIORITY = 39


def timestamp(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
        result = result / 1000 if result > 10_000_000_000 else result
    except (ValueError, TypeError):
        try:
            result = datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
        except ValueError:
            return None
    return result if math.isfinite(result) and result > 0 else None


def priorities(snapshot, bindings, now, max_age=90):
    """Equal deadlines tie; expired/unknown windows sort behind future windows.

    Read the same effective reset shown on the VM page. Never manufacture the
    next reset or infer remaining entitlement from the old utilization value.
    """
    captured = timestamp(snapshot.get('captured_at'))
    fresh = captured is not None and -5 <= now - captured <= max_age
    rows = {row['id']: row for row in snapshot.get('slots', [])}
    if len(rows) != len(snapshot.get('slots', [])):
        raise ValueError('duplicate_slot')
    deadlines = {}
    for binding in bindings:
        row = rows.get(binding['slot_id'], {})
        reset = timestamp(row.get('reset_7d'))
        valid = (fresh and row.get('tier') == 'pro' and
                 reset is not None and now < reset <= now + WEEK + 300)
        deadlines[binding['account_id']] = reset if valid else None
    unique = sorted({value for value in deadlines.values() if value is not None})
    if len(unique) >= UNKNOWN_PRIORITY:
        raise ValueError('priority_band_capacity_exceeded')
    ranks = {value: rank + 1 for rank, value in enumerate(unique)}
    return {aid: ranks.get(reset, UNKNOWN_PRIORITY) for aid, reset in deadlines.items()}


def structural_match(account, binding):
    expected = binding['expected']
    return all(account.get(key) == value for key, value in expected.items())


def plan(snapshot, accounts, bindings, ownership, now):
    desired = priorities(snapshot, bindings, now)
    slots = {row['id']: row for row in snapshot.get('slots', [])}
    changes, skipped = [], []
    for binding in bindings:
        aid = binding['account_id']
        account = accounts.get(aid)
        if slots.get(binding['slot_id'], {}).get('tier') not in (None, 'pro'):
            skipped.append({'account_id': aid, 'reason': 'not_a_pro_slot'})
            continue
        if not account or not structural_match(account, binding):
            skipped.append({'account_id': aid, 'reason': 'account_binding_changed'})
            continue
        if account.get('status') != 'active' or not account.get('schedulable'):
            skipped.append({'account_id': aid, 'reason': 'operator_or_provider_paused'})
            continue
        claim = ownership.get(str(aid), {'before': binding['initial_priority'],
                                         'after': binding['initial_priority']})
        if account['priority'] not in (claim['before'], claim['after']):
            skipped.append({'account_id': aid, 'reason': 'priority_manually_changed'})
            continue
        if account['priority'] != desired[aid]:
            changes.append({'account_id': aid, 'before': account['priority'],
                            'after': desired[aid]})
    return {'desired': desired, 'changes': changes, 'skipped': skipped}
