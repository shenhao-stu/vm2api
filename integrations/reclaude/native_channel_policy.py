"""Pure configuration-channel selection; never dispatches.

The caller must hold SessionPool.lock through selection and Entry.busy reservation.
Snapshots are trusted projections of that pool and its durable dispatch evidence,
not fields accepted from an HTTP client. No files, sessions or grants are mutated.
"""

from dataclasses import dataclass
import hashlib

from native_paid_sibling import PaidSibling, proven_sibling, proven_user_extension, related_channels


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


@dataclass(frozen=True)
class Decision:
    action: str
    code: str
    logical_key: str
    request_sha256: str
    channel_key: str | None = None
    sibling: PaidSibling | None = None


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
    # Consume/unknown/inflight above are global to the authenticated scope. Only
    # then choose a transcript. Both sides of a witnessed split retain their own
    # native directory and immutable paid grants, including after restart.
    dialogue = [m for m in messages if m['role'] != 'system']
    siblings = [c for c in channels if c.sibling]
    matches = [c for c in siblings if c.sibling.matches(dialogue, native.signature)]
    matches.sort(key=lambda c: (c.sibling.assistant_offset, c.sibling.user_blocks), reverse=True)
    if len(matches) > 1 and (matches[0].sibling.assistant_offset, matches[0].sibling.user_blocks) == (
            matches[1].sibling.assistant_offset, matches[1].sibling.user_blocks):
        return reject('native_channel_ambiguous')
    if matches:
        match = matches[0]
        if match.identity != identity or (match.status == 'prepared' and
                                          match.sibling.first_request != request_sha):
            return reject('history_prefix_mismatch')
        channels = (match,)
    else:
        channels = tuple(c for c in channels if not c.sibling)
    same_anchor = [c for c in channels
                   if c.identity.anchor_sha256 == identity.anchor_sha256]
    boundaries = {}
    for channel in same_anchor:
        length = channel.history_length
        try:
            _, prefix = native.frozen_history_prefix(
                messages, length, channel.history_sha256, channel.history_controls,
                channel.history_pending if channel.status == 'awaiting_tools' else None)
        except native.ContractError as error:
            if (str(error) == 'history_prefix_mismatch' and allow_history_import
                    and len(same_anchor) == 1 and channel.identity == identity
                    and not any(c.pending_ids for c in snapshot.channels
                                if not related_channels(snapshot.channels, c.key, channel.key))
                    and not any(c.sibling.parent == channel.key and
                                c.sibling.paid_input == channel.paid_input for c in siblings)):
                sibling = (proven_sibling(channel, messages, request_sha, native.signature)
                           or proven_user_extension(channel, messages, request_sha, native.signature))
                if sibling:
                    if snapshot.memory_pressure:
                        return reject('native_memory_pressure')
                    if check_capacity and snapshot.resident_total >= snapshot.capacity:
                        return reject('native_session_capacity')
                    key = sibling.key(native.signature)
                    if any(c.key == key for c in snapshot.channels):
                        return reject('native_channel_collision')
                    return Decision('create', 'verified_paid_sibling', scope, request_sha, key, sibling)
            return reject(str(error))
        if prefix >= len(messages):
            return reject("history_prefix_mismatch")
        boundaries[channel.key] = prefix
    exact = [c for c in channels if c.identity == identity]
    if len(exact) > 1:
        return reject("native_channel_ambiguous")
    selected = exact[0] if exact else None
    # A pending native tool exchange cannot move to another channel/model. It may
    # resume only on the original channel, with the exact original tool results.
    for channel in channels:
        if channel.status == "awaiting_tools" or channel.pending_ids:
            if channel is not selected:
                return reject("native_pending_tools_no_branch")
            tail = [m for m in messages[boundaries[channel.key]:] if m["role"] != "system"]
            ids = [b["tool_use_id"] for b in tail[0]["content"]
                   if b["type"] == "tool_result"] if tail else []
            if (not channel.pending_ids or not tail or tail[0]["role"] != "user"
                    or len(ids) != len(set(ids)) or set(ids) != channel.pending_ids):
                return reject("native_session_incomplete_no_replay")
    # The displaced parent and its own child can each finish their tools.
    # An unrelated outstanding exchange still prevents creating/switching channels.
    for other in snapshot.channels:
        if other in channels or not other.pending_ids:
            continue
        related = selected and related_channels(snapshot.channels, selected.key, other.key)
        if not related:
            return reject('native_pending_tools_no_branch')
    if selected is None and not allow_history_import and any(
            m["role"] == "assistant" for m in messages):
        return reject("native_session_history_not_imported")
    if snapshot.memory_pressure:
        return reject("native_memory_pressure")
    if (check_capacity and (selected is None or not selected.resident)
            and snapshot.resident_total >= snapshot.capacity):
        return reject("native_session_capacity")
    if selected:
        return Decision("reuse", "verified_existing_channel", scope, request_sha, selected.key)
    # The first channel retains the legacy pathname. Additional channels do not
    # become separate pools, accounts, credentials or budgets.
    key = scope if not channels else native.signature(
        ["native-config-channel-v1", scope, identity.model,
         identity.system_sha256, identity.anchor_sha256])
    if any(c.key == key for c in channels):
        return reject("native_channel_collision")
    return Decision("create", "validated_new_channel", scope, request_sha, key)
