"""Retain a conclusively uncharged legacy quota refusal before a new caller turn.

This never retries a request, repairs an unknown turn, or migrates indexed channels.
The caller must own the pool lock and validate the new history before retiring it.
"""
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import time


def file_hashes(directory):
    paths = list(islice(directory.rglob('*'), 129))
    if (directory.is_symlink() or len(paths) > 128
            or any(p.is_symlink() and p != directory / 'latest' for p in paths)):
        raise ValueError('unsafe legacy evidence')
    result = {}
    for path in paths:
        if path.is_symlink():
            result[str(path.relative_to(directory))] = hashlib.sha256(
                b'symlink\0' + os.fsencode(os.readlink(path))).hexdigest()
        elif path.is_file():
            with path.open('rb') as stream:
                result[str(path.relative_to(directory))] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return result


def rejection_proof(directory, now):
    """Return a positive disposition only for one terminal, zero-use HTTP 429."""
    directory = Path(directory)

    def read(name):
        path = directory / name
        if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('unbounded evidence')
        return json.loads(path.read_text())

    try:
        if (directory.is_symlink() or (directory / '.configuration-channel.json').exists()
                or any((directory / 'caller-grants').glob('*.json'))):
            return None
        state, grant, final = (read(n) for n in ('continuation.json', 'dispatch/grant.json',
                                                'dispatch/final.safe.json'))
        if state.get('status') != 'failed' or state.get('version') != 2:
            return None
        records = list((directory / 'dispatch').glob('*.consumed.json'))
        if len(records) != 1 or any((directory / 'dispatch').glob('*.tmp')):
            return None
        receipt = read(str(records[0].relative_to(directory)))
        native_id, grant_id = state['native_id'], grant['id']
        if (receipt.get('id') != grant_id or records[0].name != grant_id + '.consumed.json'
                or receipt.get('session_id') != native_id or grant.get('session_id') != native_id
                or receipt.get('model') != grant.get('model')
                or type(final.get('upstream_attempts')) is not int or final['upstream_attempts'] != 1
                or type(final.get('denied')) is not int or final['denied'] != 0):
            return None
        log = directory / 'stdout.private.jsonl'
        if log.is_symlink() or log.stat().st_size > 2 * 1024 * 1024:
            return None
        events = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
        if any(e.get('type') == 'stream_event' for e in events):
            return None
        assistants = [e for e in events if e.get('type') == 'assistant']
        results = [e for e in events if e.get('type') == 'result']
        limits = [e for e in events if e.get('type') == 'rate_limit_event']
        if len(assistants) != 1 or len(results) != 1 or len(limits) != 1:
            return None
        if any(e.get('session_id') != native_id for e in assistants + results + limits):
            return None
        assistant, result = assistants[0], results[0]
        if (assistant.get('error') != 'rate_limit' or assistant.get('api_error_status') != 429
                or assistant.get('api_error') != 'usage_limit_reached'
                or result.get('is_error') is not True or result.get('api_error_status') != 429
                or result.get('api_error') != 'usage_limit_reached'
                or result.get('terminal_reason') != 'api_error' or result.get('modelUsage') != {}
                or type(result.get('total_cost_usd')) not in (int, float) or result['total_cost_usd'] != 0):
            return None
        usage = result.get('usage', {})
        if any(type(usage.get(k)) is not int or usage[k] != 0 for k in
               ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')):
            return None
        limit = limits[0].get('rate_limit_info', {})
        reset = limit.get('resetsAt')
        if (limit.get('status') != 'rejected' or type(reset) is not int
                or type(receipt.get('at_ms')) is not int
                or not 0 < receipt['at_ms'] / 1000 < reset <= now):
            return None
        return {'version': 1, 'disposition': 'terminal_429_zero_usage', 'native_id': native_id,
                'grant_id': grant_id, 'reset_at': reset, 'files': file_hashes(directory)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def retire_rejected_legacy(directory, now=None):
    directory = Path(directory)
    if len(directory.name) != 64 or set(directory.name) - set('0123456789abcdef'):
        return False
    proof = rejection_proof(directory, time.time() if now is None else now)
    if proof is None:
        return False
    encoded = json.dumps(proof, sort_keys=True).encode()
    archive = directory.parent / '.rejected-legacy' / directory.name / hashlib.sha256(encoded).hexdigest()
    if any(p.is_symlink() for p in (archive, archive.parent, archive.parent.parent)):
        raise ValueError('unsafe archive')
    archive.mkdir(parents=True, mode=0o700, exist_ok=True)
    marker = archive / 'proof.json'
    if not marker.exists():
        with marker.open('xb') as stream:
            stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
    if marker.is_symlink() or marker.read_bytes() != encoded or (archive / 'session').exists():
        raise ValueError('legacy archive conflict')
    if file_hashes(directory) != proof['files']:
        raise ValueError('legacy evidence changed')
    os.rename(directory, archive / 'session')
    for path in (archive, archive.parent, archive.parent.parent, directory.parent):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return True
