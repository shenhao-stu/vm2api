"""Read-only proof that one consumed request ended in a native server error."""
import json


def terminal_usage(events, native_id):
    relevant = [(i, e) for i, e in enumerate(events)
                if e.get('type') in {'assistant', 'result', 'stream_event'}]
    if any(e.get('session_id') != native_id for _, e in relevant):
        return None
    assistants = [(i, e) for i, e in relevant if e['type'] == 'assistant']
    results = [(i, e) for i, e in relevant if e['type'] == 'result']
    streams = [(i, e['event']) for i, e in relevant if e['type'] == 'stream_event']
    starts = [(i, e) for i, e in streams if e.get('type') == 'message_start']
    deltas = [(i, e) for i, e in streams if e.get('type') == 'message_delta']
    stops = [(i, e) for i, e in streams if e.get('type') == 'message_stop']
    if any(len(group) != 1 for group in (assistants, results, starts, deltas, stops)):
        return None
    ai, assistant = assistants[0]
    ri, result = results[0]
    if (assistant.get('error') != 'server_error' or assistant.get('is_api_error_message') is not True
            or result.get('is_error') is not True or result.get('terminal_reason') != 'api_error'
            or result.get('num_turns') != 1
            or not starts[0][0] < ai < deltas[0][0] < stops[0][0] < ri
            or ri != relevant[-1][0]):
        return None
    # Assistant/result usage can be zero placeholders or cumulative across turns.
    usage = {**starts[0][1]['message'].get('usage', {}), **deltas[0][1].get('usage', {})}
    keys = ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')
    return usage if all(type(usage.get(k)) is int and usage[k] >= 0 for k in keys) else None


def failed_request(directory, state, claims):
    """The old request remains consumed; this proof only retires its broken CLI."""
    def read(path):
        if path.is_symlink() or path.stat().st_size > 16384:
            raise ValueError('invalid terminal evidence')
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
        offset, native_id, grant_id = claim.get('stdout_offset'), state['native_id'], grant['id']
        if (claim.get('state') != 'claimed' or type(offset) is not int or offset < 0
                or claim.get('native_id') != native_id or grant.get('session_id') != native_id
                or not isinstance(grant_id, str) or len(grant_id) != 36
                or set(grant_id) - set('0123456789abcdef-')):
            return None
        receipt = read(directory / 'dispatch' / (grant_id + '.consumed.json'))
        final = read(directory / 'dispatch/final.safe.json')
        if (receipt.get('id') != grant_id or receipt.get('session_id') != native_id
                or receipt.get('model') != grant.get('model')
                or type(final.get('upstream_attempts')) is not int or final['upstream_attempts'] != 1
                or type(final.get('denied')) is not int or final['denied'] != 0):
            return None
        log = directory / 'stdout.private.jsonl'
        if log.is_symlink() or not 0 < log.stat().st_size - offset <= 2 * 1024 * 1024:
            return None
        with log.open('rb') as stream:
            stream.seek(offset)
            events = [json.loads(line) for line in stream.read(2 * 1024 * 1024 + 1).splitlines() if line.strip()]
        return request if terminal_usage(events, native_id) is not None else None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
