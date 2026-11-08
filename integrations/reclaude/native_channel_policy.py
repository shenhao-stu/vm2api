"""Pure configuration-channel selection; never dispatches.

The caller must hold SessionPool.lock through selection and Entry.busy reservation.
Snapshots are trusted projections of that pool and its durable dispatch evidence,
not fields accepted from an HTTP client. No files, sessions or grants are mutated.
"""

from dataclasses import dataclass
import hashlib

from native_paid_sibling import CompletedBoundary, PaidSibling
from native_tool_handoff import ToolHandoff, prove_handoff


@dataclass(frozen=True)
class Identity:
    logical_key: str
    model: str
    system_sha256: str
    anchor_sha256: str


@dataclass(frozen=True)
class Channel:
    key: str
    identity: Identity
    status: str
    history_length: int
    history_sha256: str
    resident: bool = True
    busy: bool = False
    pending_ids: frozenset[str] = frozenset()
    history_controls: dict | None = None
    history_pending: dict | None = None
    paid_input: str | None = None
    sibling: PaidSibling | None = None
    completed: tuple[CompletedBoundary, ...] = ()
    tool_handoff: ToolHandoff | None = None


@dataclass(frozen=True)
class Snapshot:
    logical_key: str
    channels: tuple[Channel, ...]
    consumed: frozenset[str]
    evidence_complete: bool
    resident_total: int
    capacity: int = 10
    unknown_dispatch: bool = False
    inflight: bool = False
    stopped: bool = False
    memory_pressure: bool = False
    issued_tool_ids: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Decision:
    action: str
    code: str
    logical_key: str
    request_sha256: str
    channel_key: str | None = None
    sibling: PaidSibling | None = None
    tool_handoff: ToolHandoff | None = None


def logical_key(tenant, session_id):
    """Exactly the existing pool key; only authenticated tenant is permitted."""
    if not isinstance(tenant, str) or not tenant or "\0" in tenant:
        raise ValueError("invalid_trusted_tenant")
    return hashlib.sha256((tenant + "\0" + session_id).encode()).hexdigest()


def request_identity(scope, body, native):
    """Use the bridge's normalization; mutable controls and tools are not keys."""
    messages = native.history_shape(body["messages"])
    anchor = next(m for m in messages if m["role"] == "user")
    return Identity(scope, body["model"], native.signature(native.initial_system(body)),
                    native.signature(anchor))


def consistent_snapshot(snapshot, native):
    def digest(value):
        return isinstance(value, str) and len(value) == 64 and all(
            c in "0123456789abcdef" for c in value)

    if (type(snapshot.channels) is not tuple or type(snapshot.consumed) is not frozenset
            or type(snapshot.issued_tool_ids) is not frozenset
            or any(not isinstance(t, str) or not t for t in snapshot.issued_tool_ids)
            or any(type(flag) is not bool for flag in (
                snapshot.evidence_complete, snapshot.unknown_dispatch, snapshot.inflight,
                snapshot.stopped, snapshot.memory_pressure))
            or not digest(snapshot.logical_key) or not all(digest(s) for s in snapshot.consumed)
            or any(type(c) is not Channel or type(c.identity) is not Identity
                   for c in snapshot.channels)):
        return False
    if snapshot.resident_total < sum(c.resident is True for c in snapshot.channels):
        return False
    for channel in snapshot.channels:
        if (type(channel.busy) is not bool or type(channel.resident) is not bool
                or type(channel.pending_ids) is not frozenset
                or type(channel.history_length) is not int or channel.history_length < 0
                or not all(digest(s) for s in (channel.key, channel.history_sha256,
                    channel.identity.logical_key, channel.identity.system_sha256,
                    channel.identity.anchor_sha256))):
            return False
        if (type(channel.completed) is not tuple or len(channel.completed) > 8
                or any(type(c) is not CompletedBoundary or type(c.length) is not int
                       or c.length < 2 or not digest(c.request_sha256)
                       or not digest(c.history_sha256) for c in channel.completed)):
            return False
        if channel.tool_handoff is not None and (type(channel.tool_handoff) is not ToolHandoff
                or not channel.tool_handoff.valid(channel.key, native.signature)):
            return False
        if channel.status == "prepared" and (channel.history_length != 0 or channel.pending_ids
                or channel.history_sha256 != native.signature([])):
            return False
        if channel.status in {"idle", "awaiting_tools"} and channel.history_length == 0:
            return False
        if ((channel.status == "awaiting_tools" and not channel.pending_ids)
                or (channel.status == "idle" and channel.pending_ids)):
            return False
    return True


def select_channel(tenant, body, snapshot, *, native, session_identity,
                   allow_history_import=False, check_capacity=True):
    """Choose an existing directory, a new directory, or a rejection.

    Native validators remain authoritative and may raise ContractError. A create
    decision is NOT permission to replay: the normal factory/import/once path must
    still run, with only the final caller tail eligible for its existing grant.
    """
    native.native_options(body)
    scope = logical_key(tenant, session_identity(body))
    messages = native.history_shape(body["messages"])
    request_sha = native.signature(messages)

    def reject(code):
        return Decision("reject", code, scope, request_sha)

    if (type(snapshot.capacity) is not int or not 1 <= snapshot.capacity <= 10
            or type(snapshot.resident_total) is not int or snapshot.resident_total < 0):
        raise ValueError("invalid_native_pool_limits")
    if not consistent_snapshot(snapshot, native):
        return reject("native_session_evidence_unknown")
    if snapshot.logical_key != scope:
        return reject("session_scope_mismatch")
    channels = snapshot.channels
    if (any(c.identity.logical_key != scope for c in channels)
            or len({c.key for c in channels}) != len(channels)):
        return reject("session_scope_mismatch")
    if snapshot.inflight:
        return reject('native_request_in_flight_no_replay' if request_sha in snapshot.consumed
                      else 'session_busy')
    # A positive claim is decisive even when its terminal is unknown. A 5xx
    # here would invite another account to execute the very same request.
    if not snapshot.evidence_complete or snapshot.unknown_dispatch:
        if request_sha in snapshot.consumed:
            return reject("native_request_consumed_no_replay")
        return reject("native_session_evidence_unknown")
    if snapshot.stopped:
        return reject("native_pool_stopped")
    if snapshot.inflight or any(c.busy or c.status in {"in_flight", "closing"}
                               for c in channels):
        return reject("session_busy")
    retired = tuple(c.key for c in channels if c.status in {'quota_rejected', 'terminal_error'})
    channels = tuple(c for c in channels if c.key not in retired)
    if any(c.status == "failed" for c in channels):
        return reject("native_session_failed_no_replay")
    if any(c.status not in {"prepared", "idle", "awaiting_tools"} for c in channels):
        return reject("native_session_incomplete_no_replay")
    if request_sha in snapshot.consumed:
        return reject("request_already_consumed")

    # This validates the entire caller tool graph without importing or executing it.
    # It also rejects missing/duplicate results, rather than dropping them to fit.
    native.initial_request(body, allow_history_import=True)
    identity = request_identity(scope, body, native)
    final_user = next(m for m in reversed(messages) if m['role'] != 'system')
    final_results = {b['tool_use_id'] for b in final_user['content']
                     if b['type'] == 'tool_result'}
    meaningful = [b for b in final_user['content']
                  if b['type'] != 'text' or b['text'].strip()]
    if meaningful != final_user['content']:
        normalized = [({**m, 'content': meaningful} if m is final_user else m) for m in messages]
        if native.signature(normalized) in snapshot.consumed:
            return reject('request_already_consumed')
    transferred = [c for c in channels if c.tool_handoff
                   and final_results.intersection(c.tool_handoff.tool_ids)]
    if transferred:
        if len(transferred) != 1:
            return reject('native_channel_ambiguous')
        target = transferred[0]
        if (target.status != 'prepared' or target.tool_handoff.first_request != request_sha
                or target.identity != identity):
            return reject('request_already_consumed')
        if snapshot.memory_pressure:
            return reject('native_memory_pressure')
        if check_capacity and not target.resident and snapshot.resident_total >= snapshot.capacity:
            return reject('native_session_capacity')
        return Decision('reuse', 'prepared_tool_handoff', scope, request_sha, target.key)
    if not (final_results & snapshot.issued_tool_ids):
        # A verified tool-use terminal is also a completed upstream turn. Its
        # pending client tools do not own unrelated caller history. Only results
        # for our own issued tools need the strict owner path below.
        compatible = []
        for channel in channels:
            if channel.identity != identity or (channel.status == 'prepared'
                    and channel.sibling and channel.sibling.first_request != request_sha):
                continue
            try:
                _, prefix = native.frozen_history_prefix(
                    messages, channel.history_length, channel.history_sha256,
                    channel.history_controls,
                    channel.history_pending if channel.status == 'awaiting_tools' else None)
            except native.ContractError as error:
                if str(error) != 'history_prefix_mismatch':
                    return reject(str(error))
                continue
            if prefix < len(messages):
                compatible.append((prefix, channel))
        compatible.sort(key=lambda match: match[0], reverse=True)
        if len(compatible) > 1 and compatible[0][0] == compatible[1][0]:
            return reject('native_channel_ambiguous')
        selected = compatible[0][1] if compatible else None
        if not selected and not allow_history_import and any(
                m['role'] == 'assistant' for m in messages):
            return reject('native_session_history_not_imported')
        if snapshot.memory_pressure:
            return reject('native_memory_pressure')
        if (check_capacity and (selected is None or not selected.resident)
                and snapshot.resident_total >= snapshot.capacity):
            return reject('native_session_capacity')
        if selected:
            return Decision('reuse', 'verified_existing_channel', scope, request_sha, selected.key)
        key = scope if not channels and not retired else native.signature([
            'native-caller-history-v1', scope, identity.model, identity.system_sha256,
            identity.anchor_sha256, request_sha, sorted(retired)])
        if any(c.key == key for c in snapshot.channels):
            return reject('native_channel_collision')
        return Decision('create', 'validated_caller_history', scope, request_sha, key)
    owners = [c for c in channels if final_results & c.pending_ids]
    if not owners:
        return reject('request_already_consumed')
    if len(owners) != 1:
        return reject('native_channel_ambiguous')
    selected = owners[0]
    try:
        if selected.identity != identity:
            raise native.ContractError('native_pending_tools_no_branch')
        _, prefix = native.frozen_history_prefix(
            messages, selected.history_length, selected.history_sha256,
            selected.history_controls, selected.history_pending)
    except native.ContractError as error:
        if str(error) not in {'history_prefix_mismatch', 'native_pending_tools_no_branch'}:
            return reject(str(error))
        handoff = prove_handoff(selected, messages, request_sha) if allow_history_import else None
        if not handoff:
            return reject(str(error))
        if snapshot.memory_pressure:
            return reject('native_memory_pressure')
        if check_capacity and snapshot.resident_total >= snapshot.capacity:
            return reject('native_session_capacity')
        return Decision('create', 'verified_tool_handoff', scope, request_sha,
                        handoff.key(native.signature), tool_handoff=handoff)
    tail = [m for m in messages[prefix:] if m['role'] != 'system']
    ids = [b['tool_use_id'] for b in tail[0]['content']
           if b['type'] == 'tool_result'] if tail else []
    if (not tail or tail[0]['role'] != 'user' or len(ids) != len(set(ids))
            or set(ids) != selected.pending_ids):
        return reject('native_session_incomplete_no_replay')
    if snapshot.memory_pressure:
        return reject('native_memory_pressure')
    if check_capacity and not selected.resident and snapshot.resident_total >= snapshot.capacity:
        return reject('native_session_capacity')
    return Decision('reuse', 'verified_existing_channel', scope, request_sha, selected.key)
