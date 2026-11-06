"""Prove caller-owned continuations after a paid response lost a delivery race."""
from dataclasses import asdict, dataclass

from native_history_boundary import BoundaryError, frozen_prefix


@dataclass(frozen=True)
class PaidSibling:
    parent: str
    paid_input: str
    paid_history: str
    assistant_offset: int  # ordinary messages; withdrawn system controls do not move it
    alternate_assistant: str
    first_request: str
    user_blocks: int = 0

    def key(self, signature):
        fields = [self.parent, self.paid_input, self.paid_history,
                  self.assistant_offset, self.alternate_assistant, self.first_request]
        return signature(['paid-user-extension-v1', *fields, self.user_blocks]
                         if self.user_blocks else ['paid-sibling-v1', *fields])

    def matches(self, dialogue, signature):
        if not 0 <= self.assistant_offset < len(dialogue):
            return False
        anchor = dialogue[self.assistant_offset]
        if self.user_blocks:
            return (anchor['role'] == 'user' and len(anchor['content']) >= self.user_blocks
                    and signature({**anchor, 'content': anchor['content'][:self.user_blocks]})
                    == self.alternate_assistant)
        return anchor['role'] == 'assistant' and signature(anchor) == self.alternate_assistant

    def serialize(self):
        value = asdict(self)
        if not self.user_blocks:
            value.pop('user_blocks')
        return value

    def valid(self, channel, signature):
        digests = (self.parent, self.paid_input, self.paid_history,
                   self.alternate_assistant, self.first_request)
        return (all(isinstance(v, str) and len(v) == 64
                    and not set(v) - set("0123456789abcdef") for v in digests)
                and type(self.assistant_offset) is int and self.assistant_offset >= 1
                and type(self.user_blocks) is int and self.user_blocks >= 0
                and self.parent != channel and self.key(signature) == channel)


def related_channels(channels, left, right):
    parents = {c.key: c.sibling.parent for c in channels if c.sibling}

    def ancestor(parent, child):
        visited = set()
        while child in parents and child not in visited:
            visited.add(child)
            child = parents[child]
            if child == parent:
                return True
        return False

    return left == right or ancestor(left, right) or ancestor(right, left)


def tool_ids(assistant):
    return {block['id'] for block in assistant['content'] if block['type'] == 'tool_use'}


def proven_sibling(channel, messages, request_sha, signature):
    """The common paid input AND the displaced assistant must reproduce the original receipt."""
    if (channel.status != 'awaiting_tools' or not channel.paid_input or
            not channel.history_pending or not channel.pending_ids):
        return None
    length = channel.history_length - 1
    controls = channel.history_controls
    if controls:
        controls = {**controls, 'length': length}
    try:
        common, split = frozen_prefix(messages, length, channel.paid_input, signature, controls)
    except BoundaryError:
        return None
    previous = channel.history_pending['assistant']
    if (signature(common + [previous]) != channel.history_sha256
            or tool_ids(previous) != channel.pending_ids or split >= len(messages)):
        return None
    alternate = messages[split]
    if alternate['role'] != 'assistant':
        return None
    new_ids = tool_ids(alternate)
    if not new_ids or new_ids & channel.pending_ids:
        return None
    dialogue = [m for m in messages[split + 1:] if m['role'] != 'system']
    # initial_request already verified the whole tool graph. Displaced tool IDs
    # cannot be supplied to this transcript, even as historical tool results.
    if (not dialogue or dialogue[0]['role'] != 'user' or
            {b['tool_use_id'] for b in dialogue[0]['content'] if b['type'] == 'tool_result'} != new_ids or
            any(b.get('id') in channel.pending_ids or b.get('tool_use_id') in channel.pending_ids
                for m in dialogue for b in m['content'])):
        return None
    # A caller-authored, new final turn follows the completed alternate exchange.
    # Never regenerate the disputed response or send just its tool results upstream.
    last_assistant = max((i for i, m in enumerate(dialogue) if m['role'] == 'assistant'), default=-1)
    final = dialogue[last_assistant + 1:]
    if (len(final) != 1 or final[0]['role'] != 'user' or
            not any(b['type'] == 'text' and b['text'].strip() for b in final[0]['content']) or
            any(b['type'] == 'tool_result' for b in final[0]['content'])):
        return None
    return PaidSibling(channel.key, channel.paid_input, channel.history_sha256,
                       sum(m['role'] != 'system' for m in messages[:split]),
                       signature(alternate), request_sha)


def proven_user_extension(channel, messages, request_sha, signature):
    """Require a complete paid receipt and newly appended caller text, not a retry."""
    if (channel.status != 'awaiting_tools' or not channel.paid_input
            or not channel.history_pending or not channel.pending_ids):
        return None
    length = channel.history_length - 1
    controls = channel.history_controls
    if controls:
        controls = {**controls, 'length': length}
    ordinary = [(i, m) for i, m in enumerate(messages) if m['role'] != 'system']
    count = length - len(controls['systems'] if controls else [])
    if len(ordinary) != count or not ordinary or ordinary[-1][1]['role'] != 'user':
        return None
    index, anchor = ordinary[-1]
    content = anchor['content']
    # Validate against the witnessed old controls, without rewriting the caller's
    # new effort setting or importing the lost assistant/tool calls.
    without_effort = lambda m: {k: v for k, v in m.items() if k != 'output_config'}
    systems = {signature(without_effort(x['message'])): x['message']
               for x in controls['systems']} if controls else {}
    # A bounded suffix search keeps large untrusted bodies from quadratic work.
    for split in range(len(content) - 1, max(0, len(content) - 17), -1):
        suffix = content[split:]
        if any(b['type'] != 'text' or not b['text'].strip() for b in suffix):
            break
        probe = messages[:index] + [{**anchor, 'content': content[:split]}] + messages[index + 1:]
        probe = [systems.get(signature(without_effort(m)), m) if m['role'] == 'system' else m
                 for m in probe]
        try:
            common, _ = frozen_prefix(probe, length, channel.paid_input, signature, controls)
        except BoundaryError:
            continue
        previous = channel.history_pending['assistant']
        if (signature(common + [previous]) == channel.history_sha256
                and tool_ids(previous) == channel.pending_ids):
            return PaidSibling(channel.key, channel.paid_input, channel.history_sha256,
                               count - 1, signature(anchor), request_sha, len(content))
    return None
