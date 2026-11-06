"""Durable configuration channels within one authenticated logical session."""
from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path

import native_bridge_session as native
from native_channel_policy import Channel, Identity, Snapshot, request_identity


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    if path.is_symlink():
        raise native.ContractError('native_channel_evidence_unknown')
    sync_directory(path.parent)


def write_json(path, value, *, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    target = path if exclusive else path.with_suffix('.tmp')
    descriptor = os.open(target, flags | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    if not exclusive:
        os.replace(target, path)
    sync_directory(path.parent)


def read_json(path):
    if path.is_symlink():
        raise native.ContractError('native_channel_evidence_unknown')
    try:
        with path.open() as stream:
            return json.load(stream)
    except (OSError, ValueError):
        raise native.ContractError('native_channel_evidence_unknown') from None


class ChannelStore:
    def __init__(self, root):
        self.root = Path(root)
        self.directory = self.root / '.configuration-channels'
        durable_directory(self.directory)
        self.lease = (self.directory / 'pool.lock').open('a')
        try:
            fcntl.flock(self.lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lease.close()
            raise native.ContractError('native_pool_already_running') from None

    def close(self):
        if not self.lease.closed:
            fcntl.flock(self.lease, fcntl.LOCK_UN)
            self.lease.close()

    def document(self, logical):
        path = self.directory / (logical + '.json')
        if not path.exists():
            # Old directories have no complete caller-to-grant index. They retain
            # their existing path and guards; never infer a fresh paid branch.
            if (self.root / logical / '.configuration-channel.json').exists():
                raise native.ContractError('native_channel_evidence_unknown')
            return None if (self.root / logical).exists() else {
                'version': 1, 'logical': logical, 'channels': {}}
        value = read_json(path)
        if (value.get('version') != 1 or value.get('logical') != logical
                or not isinstance(value.get('channels'), dict)):
            raise native.ContractError('native_channel_evidence_unknown')
        return value

    def register(self, logical, key, body):
        document = self.document(logical)
        if document is None or key in document['channels']:
            raise native.ContractError('native_channel_evidence_unknown')
        identity = asdict(request_identity(logical, body, native))
        document['channels'][key] = identity
        write_json(self.directory / (logical + '.json'), document)

    def attach(self, session, logical):
        if session.budget_options:
            raise native.ContractError('native_channel_session_budget_unsupported')
        path = session.directory / '.configuration-channel.json'
        expected = {'version': 1, 'logical': logical, 'channel': session.directory.name}
        if path.exists():
            if read_json(path) != expected:
                raise native.ContractError('native_channel_evidence_unknown')
        else:
            write_json(path, expected, exclusive=True)
        session.channel_store = self

    def snapshot(self, logical, entries, capacity, *, stopped=False, pressure=False):
        document = self.document(logical)
        if document is None:
            return None
        channels, consumed = [], set()
        complete, unknown = True, False
        for key, raw_identity in document['channels'].items():
            if (len(key) != 64 or any(c not in '0123456789abcdef' for c in key)
                    or raw_identity.get('logical_key') != logical):
                raise native.ContractError('native_channel_evidence_unknown')
            directory = self.root / key
            entry = entries.get(key)
            state_path = directory / 'continuation.json'
            state = read_json(state_path) if state_path.exists() else {}
            session = entry.session if entry else None
            if not state and session is not None and not session.history and not session.failed:
                state = {'status': 'prepared'}
            status = 'failed' if session is not None and session.failed else state.get('status', 'unknown')
            length = state.get('history_length', 0)
            history_sha = state.get('history_sha256', native.signature([]))
            pending = frozenset(getattr(session, 'pending_ids', ()))
            # A nonresident tool wait cannot be branched: the existing native
            # recover() still verifies the exact result set on its own path.
            claims = directory / 'caller-grants'
            known_grants = set()
            for path in claims.glob('*.json'):
                claim = read_json(path)
                request = path.stem
                if (len(request) != 64 or any(c not in '0123456789abcdef' for c in request)
                        or claim.get('request_sha256') != request):
                    raise native.ContractError('native_channel_evidence_unknown')
                consumed.add(request)
                grant_id = claim.get('grant_id')
                if (not isinstance(grant_id, str) or len(grant_id) != 36
                        or any(c not in '0123456789abcdef-' for c in grant_id)):
                    raise native.ContractError('native_channel_evidence_unknown')
                known_grants.add(grant_id)
                if (status == 'awaiting_tools' and session is None
                        and state.get('request_sha256') == request
                        and state.get('history_sha256') == claim.get('history_sha256')):
                    pending = frozenset(claim.get('pending_ids', ()))
                record = directory / 'dispatch' / (grant_id + '.consumed.json')
                if (claim.get('state') != 'complete' or not record.is_file()
                        or read_json(record).get('id') != grant_id):
                    unknown = True
            grant_path = directory / 'dispatch/grant.json'
            if grant_path.exists() and read_json(grant_path).get('id') not in known_grants:
                complete = False
            records = list((directory / 'dispatch').glob('*.consumed.json'))
            for path in records:
                grant = path.name.removesuffix('.consumed.json')
                if grant not in known_grants or read_json(path).get('id') != grant:
                    complete = False
            if status == 'prepared' and (records or known_grants):
                complete = False
            if (session is not None and session.history
                    and (length != len(session.history)
                         or history_sha != native.signature(native.history_shape(session.history)))):
                complete = False
            try:
                identity = Identity(**raw_identity)
            except (TypeError, ValueError):
                raise native.ContractError('native_channel_evidence_unknown') from None
            channels.append(Channel(key, identity, status, length, history_sha,
                                    resident=entry is not None, busy=bool(entry and entry.busy),
                                    pending_ids=pending))
        return Snapshot(logical, tuple(channels), frozenset(consumed), complete,
                        len(entries), capacity, unknown_dispatch=unknown,
                        stopped=stopped, memory_pressure=pressure)

    def bind(self, session, request_sha, grant_id):
        directory = session.directory / 'caller-grants'
        durable_directory(directory)
        path = directory / (request_sha + '.json')
        try:
            write_json(path, {'request_sha256': request_sha, 'grant_id': grant_id,
                             'state': 'claimed'}, exclusive=True)
        except FileExistsError:
            raise native.ContractError('request_already_consumed') from None

    def complete(self, session, request_sha, usage):
        path = session.directory / 'caller-grants' / (request_sha + '.json')
        claim = read_json(path)
        state = read_json(session.directory / 'continuation.json')
        consumed = session.directory / 'dispatch' / (claim['grant_id'] + '.consumed.json')
        if (not isinstance(usage, dict)
                or any(type(usage.get(k)) is not int or usage[k] < 0
                       for k in ('input_tokens', 'output_tokens'))
                or claim.get('state') != 'claimed' or not consumed.is_file()
                or read_json(consumed).get('id') != claim['grant_id']
                or state.get('status') not in {'idle', 'awaiting_tools'}
                or state.get('request_sha256') != request_sha):
            raise native.ContractError('native_channel_evidence_unknown')
        claim.update(state='complete', terminal_usage=usage,
                     history_sha256=state['history_sha256'],
                     history_length=state['history_length'], pending_ids=sorted(session.pending_ids))
        write_json(path, claim)
