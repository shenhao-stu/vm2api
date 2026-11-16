"""Positive, read-only evidence for a single uncharged native quota rejection."""
import json
import math
from pathlib import Path


def terminal_reset(events, native_id, at_ms, now, *, model_change=False, accounted=False):
    if any(e.get('type') == 'stream_event' for e in events):
        return None
    assistants = [e for e in events if e.get('type') == 'assistant']
    results = [e for e in events if e.get('type') == 'result']
    limits = [e for e in events if e.get('type') == 'rate_limit_event']
    if len(assistants) != 1 or len(results) != 1 or len(limits) != 1:
        return None
    assistant, result = assistants[0], results[-1]
    if any(e.get('session_id') != native_id for e in (assistant, result, limits[0])):
        return None
    api_error = assistant.get('api_error')
    if (assistant.get('error') != 'rate_limit' or assistant.get('api_error_status') != 429
            or api_error not in {'usage_limit_reached', 'model_requires_usage_credits'}
            or result.get('is_error') is not True or result.get('api_error_status') != 429
            or result.get('api_error') != api_error
            or result.get('terminal_reason') != 'api_error'):
        return None
    if not accounted and (result.get('modelUsage') != {}
            or type(result.get('total_cost_usd')) not in (int, float) or result['total_cost_usd'] != 0):
        return None
    message = assistant.get('message', {})
    if accounted and (assistant.get('is_api_error_message') is not True
                       or message.get('model') != '<synthetic>'):
        return None
    usage = message.get('usage', {}) if accounted else result.get('usage', {})
    if any(type(usage.get(k)) is not int or usage[k] != 0 for k in
           ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')):
        return None
    limit = limits[0].get('rate_limit_info', {})
    reset = limit.get('resetsAt')
    if (limit.get('status') != 'rejected' or type(reset) is not int or type(at_ms) is not int
            or not 0 < at_ms / 1000 < reset):
        return None
    if reset > now and not (model_change and api_error == 'model_requires_usage_credits'):
        return None
    return reset


def request_evidence(directory, state, claims):
    """No offset means no proof: old or ambiguous consumed records stay blocked."""
    directory = Path(directory)

    def read(path):
        if path.is_symlink() or path.stat().st_size > 16384:
            raise ValueError('invalid quota evidence')
        return json.loads(path.read_text())

    try:
        if (directory.is_symlink() or (directory / 'dispatch').is_symlink()
                or any((directory / 'dispatch').glob('*.tmp')) or state.get('status') != 'failed'):
            return None
        grant = read(directory / 'dispatch/grant.json')
        matches = [(request, c) for request, c in claims.items() if c.get('grant_id') == grant.get('id')]
        if len(matches) != 1:
            return None
        request, claim = matches[0]
        offset = claim.get('stdout_offset')
        native_id = state['native_id']
        if (claim.get('state') != 'claimed' or type(offset) is not int or offset < 0
                or claim.get('native_id') != native_id or grant.get('session_id') != native_id):
            return None
        grant_id = grant['id']
        if (not isinstance(grant_id, str) or len(grant_id) != 36
                or set(grant_id) - set('0123456789abcdef-')):
            return None
        receipt = read(directory / 'dispatch' / (grant_id + '.consumed.json'))
        final = read(directory / 'dispatch/final.safe.json')
        if (receipt.get('id') != grant_id or receipt.get('session_id') != native_id
                or receipt.get('model') != grant.get('model')
                or type(final.get('upstream_attempts')) is not int or final['upstream_attempts'] < 1
                or type(final.get('denied')) is not int or final['denied'] != 0):
            return None
        log = directory / 'stdout.private.jsonl'
        if log.is_symlink() or not 0 < log.stat().st_size - offset <= 2 * 1024 * 1024:
            return None
        with log.open('rb') as stream:
            stream.seek(offset)
            events = [json.loads(line) for line in stream.read(2 * 1024 * 1024 + 1).splitlines() if line.strip()]
        return request, native_id, receipt.get('at_ms'), grant.get('model'), events
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def rejected_request(directory, state, claims, now, *, requested_model=None):
    return checked_request(directory, state, claims, now, requested_model, accounted=False)


def accounted_usage(directory, claims, request, native_id, result):
    """Match cumulative CLI counters to prior, individually completed grants."""
    fields = {'input_tokens': 'inputTokens', 'output_tokens': 'outputTokens',
              'cache_read_input_tokens': 'cacheReadInputTokens',
              'cache_creation_input_tokens': 'cacheCreationInputTokens'}
    expected = {}
    try:
        for key, claim in claims.items():
            if key == request or claim.get('native_id') != native_id:
                continue
            grant = claim['grant_id']
            path = Path(directory) / 'dispatch' / (grant + '.consumed.json')
            if (claim.get('request_sha256') != key or claim.get('state') != 'complete'
                    or not isinstance(grant, str) or len(grant) != 36
                    or set(grant) - set('0123456789abcdef-')
                    or path.is_symlink() or path.stat().st_size > 16384):
                return False
            receipt = json.loads(path.read_text())
            model = receipt.get('model')
            if receipt.get('id') != grant or receipt.get('session_id') != native_id or not isinstance(model, str):
                return False
            totals = expected.setdefault(model, dict.fromkeys(fields.values(), 0))
            usage = claim['terminal_usage']
            for source, target in fields.items():
                value = usage.get(source, 0 if source.startswith('cache_') else None)
                if type(value) is not int or value < 0:
                    return False
                totals[target] += value
        actual = result.get('modelUsage')
        cost = result.get('total_cost_usd')
        if (not expected or not isinstance(actual, dict) or set(expected) != set(actual)
                or type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0):
            return False
        return all(type(actual[model].get(field)) is int and actual[model][field] == value
                   for model, totals in expected.items() for field, value in totals.items())
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return False


def retired_request(directory, state, claims, now, *, requested_model=None):
    """Retire a reset quota channel without making its consumed request retryable."""
    return checked_request(directory, state, claims, now, requested_model, accounted=True)


def checked_request(directory, state, claims, now, requested_model, *, accounted):
    try:
        evidence = request_evidence(directory, state, claims)
        if evidence is None:
            return None
        request, native_id, at_ms, model, events = evidence
        results = [e for e in events if e.get('type') == 'result']
        if accounted and (len(results) != 1 or not accounted_usage(
                directory, claims, request, native_id, results[0])):
            return None
        changed = bool(requested_model and model and requested_model != model)
        return request if terminal_reset(events, native_id, at_ms, now,
                                         model_change=changed, accounted=accounted) else None
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return None
