"""Import caller-supplied context into a new native transcript, without inference."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import uuid


class HistoryError(ValueError):
    pass


def import_plan(messages):
    """Require a complete tool graph and one new user tail; never fetch history."""
    conversation = list(messages)
    while conversation and conversation[0]['role'] == 'system':
        conversation.pop(0)
    if (not conversation or conversation[0]['role'] != 'user'
            or conversation[-1]['role'] != 'user'):
        raise HistoryError('invalid_imported_history_roles')
    pending, seen = set(), set()
    last_assistant = None
    for index, message in enumerate(conversation):
        role, blocks = message['role'], message['content']
        if role not in {'user', 'assistant'}:
            raise HistoryError('unsupported_imported_history_role')
        ids, text_started = [], False
        for block in blocks:
            kind = block['type']
            if role == 'assistant' and kind == 'tool_use':
                tool_id = block.get('id')
                if (not isinstance(tool_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', tool_id)
                        or tool_id in seen or not isinstance(block.get('input'), dict)
                        or not isinstance(block.get('name'), str)
                        or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', block['name'])):
                    raise HistoryError('invalid_imported_tool_use')
                seen.add(tool_id)
                ids.append(tool_id)
            elif role == 'user' and kind == 'tool_result':
                if text_started:
                    raise HistoryError('tool_results_must_precede_text')
                ids.append(block['tool_use_id'])
            elif kind == 'text' or role == 'assistant' and kind in {'thinking', 'redacted_thinking'}:
                text_started = True
            elif role == 'user' and kind in {'image', 'document'}:
                text_started = True
            else:
                raise HistoryError('unsupported_imported_history_content')
        if role == 'user':
            if len(set(ids)) != len(ids) or set(ids) != pending:
                raise HistoryError('imported_tool_result_set_mismatch')
            pending = set()
        else:
            if pending:
                raise HistoryError('imported_tool_result_missing')
            pending = set(ids)
            last_assistant = index
    if last_assistant is None:
        raise HistoryError('imported_history_requires_assistant')
    tail = [block for message in conversation[last_assistant + 1:] for block in message['content']]
    return conversation[:last_assistant + 1], tail


def write_transcript(profile, directory, native_id, messages):
    """Use CLI 2.1.304's native JSONL resume format, with our own UUIDs and cwd."""
    directory = Path(directory).resolve()
    project_key = re.sub(r'[^a-zA-Z0-9]', '-', str(directory))
    if len(project_key) > 200:
        raise HistoryError('native_history_project_path_too_long')
    uuid.UUID(native_id)
    target = Path(profile).resolve() / 'projects' / project_key
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = target / (native_id + '.jsonl')
    parent = None
    with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as out:
        for message in messages:
            entry = {'parentUuid': parent, 'isSidechain': False, 'userType': 'external',
                     'cwd': str(directory), 'sessionId': native_id, 'type': message['role'],
                     'message': message, 'uuid': str(uuid.uuid4()),
                     'timestamp': datetime.now(timezone.utc).isoformat()}
            parent = entry['uuid']
            out.write(json.dumps(entry) + '\n')
        out.flush()
        os.fsync(out.fileno())
    return parent
