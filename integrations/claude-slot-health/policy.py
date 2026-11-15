"""Pause-only projection of native slot health. No quota clearing or auth recovery."""
import math
import re
from datetime import datetime


def timestamp(value):
    try:
        number = float(value)
        return number / 1000 if number > 10_000_000_000 else number
    except (ValueError, TypeError):
        try:
            return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
        except ValueError:
            return None


def credential_hold(slot, now):
    error = str(slot.get('refresh_error') or '')
    if re.search(r'oauth_revoked|invalid_grant|token has been revoked|organization_disabled', error, re.I):
        return 'credential_rejected'
    expiry = timestamp(slot.get('expires_at'))
    if not expiry or expiry > now or slot.get('refresh_class') == 'retryable':
        return None
    if re.search(r'^(refresh_failed|credential_refresh_failed|refresh_token_missing|refresh_token_invalid|worker_output_invalid|refresh_rejected|refresh_denied)$', error):
        return 'credential_refresh_failed'
    if slot.get('has_refresh') is False:
        return 'oauth_expired'
    return None


def slot_hold(slot, now):
    reason = credential_hold(slot, now)
    if reason:
        return reason
    if slot.get('schedulable') is False:
        return 'native_schedule_disabled'
    if slot.get('status') in ('stopped', 'paused', 'dead', 'error', 'disabled'):
        return 'native_not_running'
    return None


def pause_plan(snapshot, accounts, bindings, now, max_age=60):
    captured = timestamp(snapshot.get('captured_at'))
    if captured is None or not -5 <= now - captured <= max_age:
        raise ValueError('stale_snapshot')
    rows = snapshot.get('slots', [])
    slots = {row['id']: row for row in rows}
    if len(rows) != len(slots):
        raise ValueError('duplicate_slot')
    changes = []
    for binding in bindings:
        account = accounts.get(binding['account_id'])
        if not account or any(account.get(k) != v for k, v in binding['expected'].items()):
            raise ValueError('account_binding_changed')
        slot = slots.get(binding['slot_id'])
        if slot is None:
            raise ValueError('missing_slot')
        if slot.get('platform') != 'anthropic':
            raise ValueError('not_an_anthropic_slot')
        reason = slot_hold(slot, now)
        if reason and account.get('schedulable') is True:
            changes.append({'account_id': binding['account_id'], 'slot_id': slot['id'], 'reason': reason})
    return changes


def weekly_priority(slot, now, base=20):
    """Lower Sub2API rank wins; preserve sticky sessions and native quota vetoes."""
    deadline = timestamp(slot.get('reset_7d'))
    if not deadline or not now < deadline <= now + 7 * 86400 + 300:
        return base + 7
    return base + min(6, math.ceil((deadline - now) / 86400) - 1)
