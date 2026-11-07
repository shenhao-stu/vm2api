"""Exercise independent pending histories with the deployed CLI, offline only."""
from pathlib import Path

fixture = Path(__file__).with_name('offline_caller_history.py')
source = fixture.read_text()
source = source[:source.index('\npool = new_pool()')]
exec(compile(source, str(fixture), 'exec'))

pool = SessionPool(root / 'pool', factory, recover=factory, capacity=4,
                   allow_history_import=True, configuration_channels=True)
try:
    base['metadata'] = {'user_id': str(uuid.uuid4())}
    reply[0] = 'tools'
    with pool.lease('tenant-a', base) as parent:
        run(parent, base)
        parent_path = parent.directory
        parent_history = copy.deepcopy(parent.history)
        parent_results = [{'type': 'tool_result', 'tool_use_id': tid, 'content': 'PARENT_RESULT'}
                          for tid in sorted(parent.pending_ids)]
    alternate = {**base, 'messages': [*base['messages'],
        {'role': 'assistant', 'content': 'EXTERNAL_ANSWER'},
        {'role': 'user', 'content': 'FRESH_INPUT'}]}
    with pool.lease('tenant-a', alternate) as child:
        run(child, alternate)
        child_path = child.directory
        child_history = copy.deepcopy(child.history)
        child_results = [{'type': 'tool_result', 'tool_use_id': tid, 'content': 'CHILD_RESULT'}
                         for tid in sorted(child.pending_ids)]
    previous = {p: evidence(p) for p in (parent_path, child_path)}
    pool.close()
    pool = SessionPool(root / 'pool', factory, recover=factory, capacity=4,
                       allow_history_import=True, configuration_channels=True)
    changed = copy.deepcopy(alternate)
    changed['messages'][1]['content'] = 'EDITED_EXTERNAL_ANSWER'
    changed['messages'][-1]['content'] = 'CONTINUE_WITH_CALLER_HISTORY'
    reply[0] = 'text'
    with pool.lease('tenant-a', changed) as edited:
        wire = run(edited, changed)
        edited_path = edited.directory
        assert edited_path not in previous
        assert 'EDITED_EXTERNAL_ANSWER' in json.dumps(wire['messages'])
        assert 'PARENT_RESULT' not in json.dumps(wire['messages'])
        assert 'CHILD_RESULT' not in json.dumps(wire['messages'])
    assert {p: evidence(p) for p in previous} == previous
    for history, results, expected in (
            (parent_history, parent_results, parent_path),
            (child_history, child_results, child_path)):
        following = {**base, 'messages': history + [{'role': 'user', 'content': results}]}
        with pool.lease('tenant-a', following) as own:
            assert own.directory == expected
            run(own, following)
    with pool.lease('tenant-b', changed) as other:
        assert other.directory not in {*previous, edited_path}
        run(other, changed)
    before = len(calls)
    for consumed in (base, alternate, changed):
        try:
            with pool.lease('tenant-a', consumed):
                raise AssertionError('duplicate admitted')
        except ContractError as error:
            assert 'already_consumed' in str(error)
    assert len(calls) == before == 6
    print(json.dumps({'ok': True, 'cli_sha256': cli_hash, 'cli_stream_terminals': len(calls),
        'paid_provider_requests': 0, 'one_mock_dispatch_per_turn': True,
        'two_pending_branches_retained': True, 'both_original_tool_results_resumed': True,
        'caller_history_rebased': True, 'account_isolation': True,
        'duplicate_dispatches': 0, 'usage_verified_each_turn': checks[
            'unique_final_and_cache_usage_on_every_turn']}))
finally:
    pool.close()
    server.shutdown()
    server.server_close()
