"""Validate one account's official percentage windows without inventing resets."""
from datetime import datetime
import math


def normalize_windows(config, data, now_ms):
    source = config['account_windows']
    ids = ('binding', 'org', 'account_id')
    if any(type(data[k]) is not int for k in ids):
        raise ValueError('invalid_scope')
    if (data['binding'], data['org'], data['account_id']) != (
            config['binding'], source['org'], source['account_id']):
        raise ValueError('wrong_relay')
    observed, updated = data['observed_at_ms'], data['source_updated']
    if any(type(x) is not int for x in (observed, updated)) or not 0 < updated <= observed <= now_ms + 10000:
        raise ValueError('invalid_observation')
    result = {}
    for key in ('five_hour', 'seven_day'):
        window = data['windows'][key]
        used, reset = window['used_percent'], window['resets_at']
        if type(used) not in (float, int) or not math.isfinite(used) or used < 0:
            raise ValueError('invalid_usage')
        # The official API returns zero + null while no new session window is active.
        if reset is None:
            if used != 0:
                raise ValueError('missing_active_reset')
            reset_ms = None
        else:
            if not isinstance(reset, str):
                raise ValueError('invalid_reset')
            date = datetime.fromisoformat(reset.replace('Z', '+00:00'))
            if date.tzinfo is None:
                raise ValueError('missing_timezone')
            reset_ms = int(date.timestamp() * 1000)
        result[key] = {'used_percent': used, 'resets_at_ms': reset_ms}
    result.update(observed_at_ms=observed, source_updated_ms=updated,
                  stale=(now_ms - observed > 900000 or now_ms - updated > 7200000 or
                         any(w['resets_at_ms'] is not None and w['resets_at_ms'] <= now_ms
                             for w in result.values())))
    return result
