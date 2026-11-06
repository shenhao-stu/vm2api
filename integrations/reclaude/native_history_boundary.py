"""Verify immutable dialogue while permitting withdrawn turn system controls."""
import hashlib
import json
import os


class BoundaryError(ValueError):
    pass


def pending_inputs_match(previous, current):
    """The caller owns tool execution; only its outstanding inputs may normalize."""
    if (previous.get('role') != 'assistant' or current.get('role') != 'assistant'
            or set(previous) != set(current)):
        return False
    before, after = previous.get('content'), current.get('content')
    if not isinstance(before, list) or not isinstance(after, list) or len(before) != len(after):
        return False
    comparable, tools = [], 0
    for old, new in zip(before, after):
        if not isinstance(old, dict) or not isinstance(new, dict):
            return False
        if old.get('type') == 'tool_use':
            if not isinstance(old.get('input'), dict) or not isinstance(new.get('input'), dict):
                return False
            new = {**new, 'input': old['input']}
            tools += 1
        comparable.append(new)
    return tools > 0 and previous == {**current, 'content': comparable}


def prefix_boundary(history, messages, *, allow_pending=False):
    """Keep exact dialogue, except withdrawn controls and explicitly pending inputs."""
    index = 0
    for offset, previous in enumerate(history):
        if index < len(messages) and (previous == messages[index] or (
                allow_pending and offset == len(history) - 1
                and pending_inputs_match(previous, messages[index]))):
            index += 1
        elif previous.get('role') != 'system':
            raise BoundaryError('history_prefix_mismatch')
    return index


def control_record(history):
    return {'version': 1, 'length': len(history), 'systems': [
        {'index': i, 'message': message} for i, message in enumerate(history)
        if message['role'] == 'system']}


def validate_record(record, length):
    if (not isinstance(record, dict) or set(record) != {'version', 'length', 'systems'}
            or record['version'] != 1 or record['length'] != length
            or not isinstance(record['systems'], list)):
        raise BoundaryError('native_history_controls_unavailable')
    previous = -1
    for item in record['systems']:
        if (not isinstance(item, dict) or set(item) != {'index', 'message'}
                or type(item['index']) is not int or not previous < item['index'] < length
                or not isinstance(item['message'], dict)
                or item['message'].get('role') != 'system'):
            raise BoundaryError('native_history_controls_unavailable')
        previous = item['index']


def frozen_prefix(messages, length, history_sha, signature, controls=None, pending=None):
    """Reconstruct only a prefix authenticated by the existing full-history hash."""
    if type(length) is not int or length < 0:
        raise BoundaryError('history_prefix_mismatch')
    if controls is not None:
        validate_record(controls, length)
    if pending is not None:
        validate_pending(pending, length)
    history = messages[:length]
    if len(history) == length and signature(history) == history_sha:
        return history, length
    if pending is not None:
        systems = {item['index']: item['message'] for item in controls['systems']} if controls else {}
        ordinary = iter(message for message in messages if message['role'] != 'system')
        try:
            history = ([systems[i] if i in systems else next(ordinary) for i in range(length)]
                       if controls else messages[:length])
        except StopIteration:
            raise BoundaryError('history_prefix_mismatch') from None
        if len(history) == length:
            history = history[:-1] + [pending['assistant']]
            if signature(history) == history_sha:
                return history, prefix_boundary(history, messages, allow_pending=True)
    if controls is not None:
        systems = {item['index']: item['message'] for item in controls['systems']}
        ordinary = iter(message for message in messages if message['role'] != 'system')
        try:
            history = [systems[i] if i in systems else next(ordinary) for i in range(length)]
        except StopIteration:
            raise BoundaryError('history_prefix_mismatch') from None
        if signature(history) == history_sha:
            return history, prefix_boundary(history, messages)
    elif length >= 2:
        # Legacy checkpoints have no control witness. Recover one withdrawn hint
        # only if the caller supplies it now AND the complete old hash proves it.
        candidates = {}
        for message in messages:
            if message['role'] == 'system':
                candidates[signature(message)] = message
                if len(candidates) > 16:
                    break
        for message in list(candidates.values())[:16]:
            history = messages[:length - 1]
            history = history[:length - 2] + [message] + history[length - 2:]
            if len(history) == length and signature(history) == history_sha:
                return history, prefix_boundary(history, messages)
    raise BoundaryError('history_prefix_mismatch')


def pending_record(history):
    record = {'version': 1, 'length': len(history), 'assistant': history[-1]}
    validate_pending(record, len(history))
    return record


def validate_pending(record, length):
    if (not isinstance(record, dict) or set(record) != {'version', 'length', 'assistant'}
            or record['version'] != 1 or record['length'] != length or length < 1
            or not isinstance(record['assistant'], dict)
            or not pending_inputs_match(record['assistant'], record['assistant'])):
        raise BoundaryError('native_history_pending_unavailable')


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_controls(directory, history, history_sha):
    record = control_record(history)
    if not record['systems']:
        return None
    return write_witness(directory, history_sha, record, 'controls')


def write_pending(directory, history, history_sha):
    return write_witness(directory, history_sha, pending_record(history), 'pending')


def write_witness(directory, history_sha, record, kind):
    data = json.dumps(record, sort_keys=True, separators=(',', ':')).encode()
    root = directory / ('history-' + kind)
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink():
        raise BoundaryError('native_history_' + kind + '_unavailable')
    path = root / (history_sha + '.json')
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        if path.is_symlink() or path.read_bytes() != data:
            raise BoundaryError('native_history_' + kind + '_unavailable') from None
    else:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(root)
        sync_directory(directory)
    return hashlib.sha256(data).hexdigest()


def read_controls(directory, state):
    return read_witness(directory, state, 'controls', validate_record)


def read_pending(directory, state):
    if state.get('history_pending_sha256') is not None and state.get('status') != 'awaiting_tools':
        raise BoundaryError('native_history_pending_unavailable')
    return read_witness(directory, state, 'pending', validate_pending)


def read_witness(directory, state, kind, validate):
    error = 'native_history_' + kind + '_unavailable'
    digest = state.get('history_' + kind + '_sha256')
    if digest is None:
        return None
    history_sha = state.get('history_sha256', '')
    if any(not isinstance(s, str) or len(s) != 64
           or any(c not in '0123456789abcdef' for c in s) for s in (digest, history_sha)):
        raise BoundaryError(error)
    root = directory / ('history-' + kind)
    path = root / (history_sha + '.json')
    try:
        if root.is_symlink() or path.is_symlink():
            raise BoundaryError(error)
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise BoundaryError(error)
        record = json.loads(data)
        validate(record, state['history_length'])
        return record
    except (OSError, ValueError, KeyError):
        raise BoundaryError(error) from None
