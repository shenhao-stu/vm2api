"""Durable configuration channels within one authenticated logical session."""
from dataclasses import asdict
import fcntl
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

import native_bridge_session as native
from native_history_boundary import BoundaryError, control_record, pending_record, validate_record
from native_paid_sibling import CompletedBoundary, PaidSibling
from native_channel_policy import Channel, Identity, Snapshot, request_identity
from native_quota_rejection import rejected_request
from native_tool_handoff import ToolHandoff
from native_terminal_error import failed_request


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

    def register(self, logical, key, body, sibling=None, tool_handoff=None):
        document = self.document(logical)
        if document is None or key in document['channels']:
            raise native.ContractError('native_channel_evidence_unknown')
        identity = asdict(request_identity(logical, body, native))
        if sibling:
            identity['paid_sibling'] = sibling.serialize()
        if tool_handoff:
            identity['tool_handoff'] = asdict(tool_handoff)
        document['channels'][key] = identity
        write_json(self.directory / (logical + '.json'), document)

    def prepare_channel(self, decision, body, factory, recover):
        """Publish membership last; a failed preparation cannot poison the parent's registry."""
        logical, key = decision.logical_key, decision.channel_key
        registry = self.directory / (logical + '.json')
        if not registry.exists():
            write_json(registry, {'version': 1, 'logical': logical, 'channels': {}}, exclusive=True)
        target = self.root / key
        if target.exists():
            # The atomic directory move may have succeeded before a process exit.
            # Only an attached, never-dispatched prepared directory can finish publication.
            marker = {'version': 1, 'logical': logical, 'channel': key}
            if (target.is_symlink() or read_json(target / '.configuration-channel.json') != marker
                    or read_json(target / 'continuation.json').get('status') != 'prepared'
                    or any((target / 'caller-grants').glob('*.json'))
                    or any((target / 'dispatch').glob('*.json')) or recover is None):
                raise native.ContractError('native_channel_evidence_unknown')
            session = recover(target, body)
        else:
            with tempfile.TemporaryDirectory(prefix='.prepare-channel-', dir=self.root) as staging:
                initial = Path(staging) / key
                session = factory(initial, body)
                session.checkpoint('prepared')
                self.attach(session, logical)
                os.rename(initial, target)
                session.directory = target
                sync_directory(self.root)
        self.attach(session, logical)
        self.register(logical, key, body, decision.sibling, decision.tool_handoff)
        return session

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
        channels, consumed, issued_tools = [], set(), set()
        complete, unknown = True, False
        paid = {}
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
            controls = native.checkpoint_controls(directory, state)
            pending_witness = native.checkpoint_pending(directory, state)
            if controls is None and session is not None and session.history:
                controls = control_record(native.history_shape(session.history))
            if (pending_witness is None and session is not None and session.history
                    and status == 'awaiting_tools'):
                pending_witness = pending_record(native.history_shape(session.history))
            paid_input = None
            completed = []
            pending = frozenset(getattr(session, 'pending_ids', ()))
            # A nonresident tool wait cannot be branched: the existing native
            # recover() still verifies the exact result set on its own path.
            claims = directory / 'caller-grants'
            claim_values = {path.stem: read_json(path) for path in claims.glob('*.json')}
            rejected = rejected_request(directory, state, claim_values, time.time()) if status == 'failed' else None
            terminal_error = failed_request(directory, state, claim_values) if status == 'failed' else None
            if rejected:
                status = 'quota_rejected'
            elif terminal_error:
                status = 'terminal_error'
            known_grants = set()
            for request, claim in claim_values.items():
                if (len(request) != 64 or any(c not in '0123456789abcdef' for c in request)
                        or claim.get('request_sha256') != request):
                    raise native.ContractError('native_channel_evidence_unknown')
                if request != rejected:
                    consumed.add(request)
                adoption_sha = claim.get('history_adoption_sha256')
                if adoption_sha is not None:
                    adoption = directory / 'history-adoptions' / (request + '.json')
                    value = read_json(adoption)
                    if (value.get('channel') != key or value.get('request_sha256') != request
                            or hashlib.sha256(adoption.read_bytes()).hexdigest() != adoption_sha):
                        raise native.ContractError('native_channel_evidence_unknown')
                    witness = native.checkpoint_pending(directory, {**value, 'status': 'awaiting_tools'})
                    if (witness is None or native.signature(witness['assistant'])
                            != value.get('original_assistant_sha256')):
                        raise native.ContractError('native_channel_evidence_unknown')
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
                receipt = read_json(record) if record.is_file() else {}
                if request in {rejected, terminal_error}:
                    continue
                if claim.get('state') != 'complete' or receipt.get('id') != grant_id:
                    unknown = True
                elif (isinstance(claim.get('terminal_usage'), dict)
                      and all(type(claim['terminal_usage'].get(k)) is int and claim['terminal_usage'][k] >= 0
                              for k in ('input_tokens', 'output_tokens'))):
                    paid[(key, request)] = claim.get('history_sha256')
                    tool_ids = claim.get('pending_ids', [])
                    if not isinstance(tool_ids, list) or any(not isinstance(t, str) or not t for t in tool_ids):
                        raise native.ContractError('native_channel_evidence_unknown')
                    issued_tools.update(tool_ids)
                    if claim.get('pending_ids') == [] and type(claim.get('history_length')) is int:
                        completed.append(claim)
                    if (status == 'awaiting_tools' and request == state.get('request_sha256')
                            and claim.get('history_sha256') == history_sha and claim.get('history_length') == length
                            and frozenset(claim['pending_ids']) == pending and state.get('history_pending_sha256')
                            and receipt.get('session_id') == state.get('native_id')):
                        paid_input = request
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
            if (status not in {'quota_rejected', 'terminal_error'} and session is not None and session.history
                    and (length != len(session.history)
                         or history_sha != native.signature(native.history_shape(session.history)))):
                complete = False
            try:
                fields = dict(raw_identity)
                marker = fields.pop('paid_sibling', None)
                sibling = PaidSibling(**marker) if marker is not None else None
                transfer = fields.pop('tool_handoff', None)
                tool_handoff = (ToolHandoff(**{**transfer, 'tool_ids': tuple(transfer['tool_ids'])})
                                if transfer is not None else None)
                identity = Identity(**fields)
                if sibling and not sibling.valid(key, native.signature):
                    raise ValueError('invalid paid sibling')
                if tool_handoff and not tool_handoff.valid(key, native.signature):
                    raise ValueError('invalid tool handoff')
            except (KeyError, TypeError, ValueError):
                raise native.ContractError('native_channel_evidence_unknown') from None
            boundaries = []
            for claim in sorted(completed, key=lambda c: c['history_length'], reverse=True)[:8]:
                digest, count = claim['history_sha256'], claim['history_length']
                if (not isinstance(digest, str) or len(digest) != 64
                        or set(digest) - set('0123456789abcdef') or count < 2):
                    raise native.ContractError('native_channel_evidence_unknown')
                witness = directory / 'history-controls' / (digest + '.json')
                record = read_json(witness) if witness.exists() else None
                if record is not None:
                    try:
                        validate_record(record, count)
                    except BoundaryError:
                        raise native.ContractError('native_channel_evidence_unknown') from None
                boundaries.append(CompletedBoundary(claim['request_sha256'], digest, count, record))
            channels.append(Channel(key, identity, status, length, history_sha,
                                    resident=entry is not None, busy=bool(entry and entry.busy),
                                    pending_ids=pending, history_controls=controls,
                                    history_pending=pending_witness, paid_input=paid_input, sibling=sibling,
                                    completed=tuple(boundaries), tool_handoff=tool_handoff))
        parents = {c.key: c.identity for c in channels}
        for channel in channels:
            sibling = channel.sibling
            if sibling and (parents.get(sibling.parent) != channel.identity or
                            paid.get((sibling.parent, sibling.paid_input)) != sibling.paid_history):
                raise native.ContractError('native_channel_evidence_unknown')
            transfer = channel.tool_handoff
            if transfer and (transfer.parent not in parents
                    or parents[transfer.parent].logical_key != logical
                    or paid.get((transfer.parent, transfer.paid_input)) != transfer.paid_history):
                raise native.ContractError('native_channel_evidence_unknown')
        return Snapshot(logical, tuple(channels), frozenset(consumed), complete,
                        len(entries), capacity, unknown_dispatch=unknown,
                        inflight=any(c.busy for c in channels),
                        stopped=stopped, memory_pressure=pressure,
                        issued_tool_ids=frozenset(issued_tools))

    def bind(self, session, request_sha, grant_id):
        directory = session.directory / 'caller-grants'
        durable_directory(directory)
        path = directory / (request_sha + '.json')
        claim = {'request_sha256': request_sha, 'grant_id': grant_id, 'state': 'claimed'}
        log = session.directory / 'stdout.private.jsonl'
        if log.is_symlink():
            raise native.ContractError('native_channel_evidence_unknown')
        claim.update(stdout_offset=log.stat().st_size if log.exists() else 0,
                     native_id=session.native_id)
        adoption = session.directory / 'history-adoptions' / (request_sha + '.json')
        if adoption.exists():
            value = read_json(adoption)
            if value.get('channel') != session.directory.name or value.get('request_sha256') != request_sha:
                raise native.ContractError('native_channel_evidence_unknown')
            claim['history_adoption_sha256'] = hashlib.sha256(adoption.read_bytes()).hexdigest()
        try:
            write_json(path, claim, exclusive=True)
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
