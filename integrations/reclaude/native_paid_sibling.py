"""Select a caller-owned transcript after a paid tool response lost a delivery race."""
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

    def key(self, signature):
        return signature(['paid-sibling-v1', self.parent, self.paid_input,
                          self.paid_history, self.assistant_offset, self.alternate_assistant, self.first_request])

    def matches(self, dialogue, signature):
        return (0 <= self.assistant_offset < len(dialogue)
                and dialogue[self.assistant_offset]['role'] == 'assistant'
                and signature(dialogue[self.assistant_offset]) == self.alternate_assistant)

    def serialize(self):
        return asdict(self)

    def valid(self, channel, signature):
        digests = (self.parent, self.paid_input, self.paid_history,
                   self.alternate_assistant, self.first_request)
        return (all(isinstance(v, str) and len(v) == 64
                    and not set(v) - set("0123456789abcdef") for v in digests)
                and type(self.assistant_offset) is int and self.assistant_offset >= 1
                and self.parent != channel and self.key(signature) == channel)


def tool_ids(assistant):
    return {block['id'] for block in assistant['content'] if block['type'] == 'tool_use'}


def proven_sibling(channel, messages, request_sha, signature):
    """The common paid input AND the displaced assistant must reproduce the original receipt."""
    if (channel.status != 'awaiting_tools' or not channel.paid_input or
            not channel.history_pending or channel.sibling or not channel.pending_ids):
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
