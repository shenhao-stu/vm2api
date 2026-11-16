"""Real isolated CLI: new text after paid, locally issued tool results."""
from pathlib import Path

fixture = Path(__file__).with_name('offline_caller_history.py')
source = fixture.read_text().split('\npool = new_pool()')[0]
exec(compile(source, str(fixture), 'exec'))

pool = new_pool()
try:
    base['metadata'] = {'user_id': str(uuid.uuid4())}
    reply[0] = 'tools'
    with pool.lease('tenant-a', base) as parent:
        run(parent, base)
        original = parent.directory
        results = [{'type': 'tool_result', 'tool_use_id': tool_id,
                    'content': 'SYNTHETIC_CALLER_RESULT'} for tool_id in sorted(parent.pending_ids)]
        follow = {**base, 'messages': copy.deepcopy(parent.history) + [
            {'role': 'user', 'content': results}]}
    with pool.lease('tenant-a', follow) as parent:
        run(parent, follow)
    before = evidence(original)
    extended = copy.deepcopy(follow)
    extended['messages'][-1]['content'].append({'type': 'text', 'text': 'FRESH_CONTINUE'})
    pool.close()
    pool = new_pool()
    reply[0] = 'text'
    with pool.lease('tenant-a', extended) as child:
        child_path = child.directory
        assert child_path != original
        wire = run(child, extended)
        assert 'FRESH_CONTINUE' in json.dumps(wire['messages'])
        history = copy.deepcopy(child.history)
    assert evidence(original) == before
    for duplicate in (base, follow, extended):
        try:
            with pool.lease('tenant-a', duplicate):
                raise AssertionError('consumed request admitted again')
        except ContractError as error:
            assert 'consumed' in str(error)
    next_turn = {**extended, 'messages': history + [
        {'role': 'user', 'content': 'FRESH_FOLLOWUP'}]}
    with pool.lease('tenant-a', next_turn) as child:
        assert child.directory == child_path
        run(child, next_turn)
    assert evidence(original) == before and len(calls) == 4
    print(json.dumps({'ok': True, 'cli_sha256': cli_hash, 'paid_provider_requests': 0,
        'cli_stream_terminals': len(calls), 'original_evidence_unchanged': True,
        'duplicates_blocked': 3, 'new_tail_once': True, 'history_followup': True,
        'usage_verified_each_turn': checks['unique_final_and_cache_usage_on_every_turn']}))
finally:
    pool.close()
    server.shutdown()
    server.server_close()
