"""Import caller-supplied context into a new native transcript, without inference."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import uuid


class HistoryError(ValueError):
    pass


def active_efforts(messages, initial_effort):
    """Effort controls activate at new user input, not a tool-result-only turn."""
    active = pending = initial_effort
    new_input = False
    for message in messages:
        role = message['role']
        if role == 'user':
            content = message['content']
            new_input = bool(content) if isinstance(content, str) else any(
                b['type'] != 'tool_result' and (b['type'] != 'text' or b['text'])
                for b in content)
            if new_input:
                active = pending
        elif role == 'system':
            pending = message.get('output_config', {}).get('effort', pending)
            if new_input:
                active = pending
        else:
            new_input = False
        yield active


def validate_system_messages(messages):
    """Content-bearing system turns follow user input, before the next assistant."""
    previous, index = None, 0
    while index < len(messages):
        message = messages[index]
        if message['role'] != 'system':
            previous = message['role']
            index += 1
            continue
        has_text = False
        while index < len(messages) and messages[index]['role'] == 'system':
            message = messages[index]
            if set(message) - {'role', 'content', 'output_config'}:
                raise HistoryError('unsupported_system_message_control')
            if any(b['type'] != 'text' for b in message['content']):
                raise HistoryError('unsupported_system_message_content')
            output = message.get('output_config', {})
            if (not isinstance(output, dict) or set(output) - {'effort'}
                    or output and (not isinstance(output.get('effort'), str)
                    or output['effort'] not in {'low', 'medium', 'high', 'xhigh', 'max'})):
                raise HistoryError('unsupported_system_message_control')
            has_text |= any(b['text'] for b in message['content'])
            index += 1
        # Leading system messages retain the existing top-level compatibility.
        following = messages[index]['role'] if index < len(messages) else None
        if has_text and previous is not None and (previous != 'user' or following not in {None, 'assistant'}):
            raise HistoryError('invalid_system_message_position')


def trailing_system_text(messages):
    """Only the new tail's system content; history is carried by the transcript."""
    tail = []
    for message in reversed(messages):
        if message['role'] != 'system':
            break
        text = '\n'.join(b['text'] for b in message['content'])
        if text:
            tail.append(text)
    return list(reversed(tail))


def import_plan(messages):
    """Require a complete tool graph and one new user tail; never fetch history."""
    validate_system_messages(messages)
    first_user = next((i for i, m in enumerate(messages) if m['role'] != 'system'), len(messages))
    conversation = list(messages[first_user:])
    turns = [m for m in conversation if m['role'] != 'system']
    if (not conversation or conversation[0]['role'] != 'user'
            or not turns or turns[-1]['role'] != 'user'):
        raise HistoryError('invalid_imported_history_roles')
    pending, seen = set(), set()
    last_assistant = None
    for index, message in enumerate(conversation):
        role, blocks = message['role'], message['content']
        if role == 'system':
            continue
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
    tail = [block for message in conversation[last_assistant + 1:]
            if message['role'] == 'user' for block in message['content']]
    return conversation[:last_assistant + 1], tail


def write_transcript(profile, directory, native_id, messages, initial_effort=None):
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
        for message, effort in zip(messages, active_efforts(messages, initial_effort)):
            if message['role'] == 'system':
                text = '\n'.join(b['text'] for b in message['content'])
                if not text:
                    continue
            entry = {'parentUuid': parent, 'isSidechain': False, 'userType': 'external',
                     'cwd': str(directory), 'sessionId': native_id, 'type': message['role'],
                     'message': message, 'uuid': str(uuid.uuid4()),
                     'timestamp': datetime.now(timezone.utc).isoformat()}
            if message['role'] == 'system':
                entry.pop('message')
                entry.update({
                    'type': 'attachment',
                    'attachment': {'type': 'hook_additional_context', 'content': [text],
                                   'hookName': 'UserPromptSubmit', 'hookEvent': 'UserPromptSubmit'},
                    'rendered': [{'content': text}], 'renderedRole': 'system',
                })
            elif message['role'] == 'assistant' and effort is not None:
                entry['perTurnEffort'] = effort
            parent = entry['uuid']
            out.write(json.dumps(entry) + '\n')
        out.flush()
        os.fsync(out.fileno())
    return parent
