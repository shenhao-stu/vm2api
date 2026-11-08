"""A paid tool response owns its results, not the caller's mutable transcript."""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class ToolHandoff:
    parent: str
    paid_input: str
    paid_history: str
    first_request: str
    tool_ids: tuple[str, ...]

    def key(self, signature):
        return signature(['native-tool-handoff-v1', asdict(self)])

    def valid(self, key, signature):
        digests = (self.parent, self.paid_input, self.paid_history, self.first_request)
        return (all(isinstance(v, str) and len(v) == 64
                    and not set(v) - set('0123456789abcdef') for v in digests)
                and type(self.tool_ids) is tuple and bool(self.tool_ids)
                and all(isinstance(t, str) and 0 < len(t) <= 160 for t in self.tool_ids)
                and tuple(sorted(set(self.tool_ids))) == self.tool_ids
                and key != self.parent and self.key(signature) == key)


def prove_handoff(channel, messages, request_sha):
    """Called after whole caller tool-graph validation, within the trusted scope."""
    if (channel.status != 'awaiting_tools' or not channel.paid_input
            or not channel.history_pending or not channel.pending_ids):
        return None
    turns = [m for m in messages if m['role'] != 'system']
    if len(turns) < 2 or turns[-2]['role'] != 'assistant' or turns[-1]['role'] != 'user':
        return None
    previous = channel.history_pending['assistant']['content']
    old = {b['id']: b['name'] for b in previous if b['type'] == 'tool_use'}
    current = {b['id']: b['name'] for b in turns[-2]['content'] if b['type'] == 'tool_use'}
    results = [b['tool_use_id'] for b in turns[-1]['content'] if b['type'] == 'tool_result']
    if (old != current or set(old) != channel.pending_ids
            or len(results) != len(set(results)) or set(results) != channel.pending_ids):
        return None
    return ToolHandoff(channel.key, channel.paid_input, channel.history_sha256,
                       request_sha, tuple(sorted(channel.pending_ids)))
