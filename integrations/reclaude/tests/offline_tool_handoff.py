"""Unmodified CLI with synthetic loopback provider: pending history/model handoff."""
from pathlib import Path
fixture = Path(__file__).with_name('offline_caller_history.py')
source = fixture.read_text().split('\npool = new_pool()')[0]
exec(compile(source, str(fixture), 'exec'))
pool = SessionPool(root / 'pool', factory, recover=factory, capacity=4,
                   allow_history_import=True, configuration_channels=True)
try:
    base['metadata'] = {'user_id': str(uuid.uuid4())}
    reply[0] = 'tools'
    with pool.lease('tenant-a', base) as parent:
        run(parent, base)
        original = parent.directory
        history = copy.deepcopy(parent.history)
        results = [{'type': 'tool_result', 'tool_use_id': t, 'content': 'OWNED_RESULT'}
                   for t in sorted(parent.pending_ids)]
    before = evidence(original)
    follow = {**base, 'messages': history + [{'role': 'user', 'content': results}]}
    changed = copy.deepcopy(follow)
    changed['model'] = 'claude-sonnet-5-5'
    changed['system'] = 'REVISED_CALLER_SYSTEM'
    changed['messages'][0]['content'] = 'REVISED_CALLER_ANCHOR'
    changed['messages'][-2]['content'].insert(0, {'type': 'text', 'text': 'CALLER_ANNOTATION'})
    with pool.lease('tenant-a', changed) as child: child_path = child.directory
    pool.close()
    pool = SessionPool(root / 'pool', factory, recover=factory, capacity=4,
                       allow_history_import=True, configuration_channels=True)
    reply[0] = 'text'
    with pool.lease('tenant-a', changed) as child:
        assert child.directory == child_path != original
        wire = run(child, changed)
        assert wire['model'] == changed['model']
        assert 'REVISED_CALLER_ANCHOR' in json.dumps(wire['messages'])
        assert 'OWNED_RESULT' in json.dumps(wire['messages'])
        assert 'CALLER_ANNOTATION' in json.dumps(wire['messages'])
        history = copy.deepcopy(child.history)
    assert evidence(original) == before
    for duplicate in (base, follow, changed, {**changed, 'model': 'claude-opus-5-5'}):
        try:
            with pool.lease('tenant-a', duplicate): raise AssertionError('tool result replayed')
        except ContractError as error: assert 'consumed' in str(error)
    following = {**changed, 'messages': history + [{'role': 'user', 'content': 'FRESH_NEXT_TURN'}]}
    with pool.lease('tenant-a', following) as child:
        assert child.directory == child_path
        run(child, following)
    with pool.lease('tenant-b', changed) as other:
        assert other.directory not in (original, child_path)
        run(other, changed)
    assert len(calls) == 4
    print(json.dumps({'ok': True, 'cli_sha256': cli_hash, 'cli_stream_terminals': len(calls),
        'paid_provider_requests': 0, 'one_mock_dispatch_per_turn': True,
        'parent_evidence_unchanged': evidence(original) == before,
        'model_system_history_handoff': True, 'account_isolation': True,
        'duplicates_blocked': 4, 'prepared_restart': True,
        'usage_verified_each_turn': checks['unique_final_and_cache_usage_on_every_turn']}))
finally:
    pool.close();server.shutdown();server.server_close()
