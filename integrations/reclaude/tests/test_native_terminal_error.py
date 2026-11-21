"""A terminal native server error is paid failure, never an invitation to replay."""
import copy
import io
import json
import unittest
from types import SimpleNamespace

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, signature
from native_channel_store import read_json, write_json
from native_terminal_error import failed_request
from test_native_paid_sibling import user


def events(native_id):
    return [
        {'type': 'stream_event', 'session_id': native_id, 'event': {
            'type': 'message_start', 'message': {'id': 'native-message', 'type': 'message',
            'role': 'assistant', 'model': 'opus', 'content': [], 'stop_reason': None,
            'usage': {'input_tokens': 2, 'output_tokens': 0,
                      'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}}}},
        {'type': 'assistant', 'session_id': native_id, 'error': 'server_error',
         'is_api_error_message': True, 'message': {'usage': {'input_tokens': 0, 'output_tokens': 0}}},
        {'type': 'stream_event', 'session_id': native_id, 'event': {'type': 'message_delta',
            'delta': {'stop_reason': None}, 'usage': {'input_tokens': 2, 'output_tokens': 3,
            'cache_creation_input_tokens': 3052, 'cache_read_input_tokens': 154269}}},
        {'type': 'stream_event', 'session_id': native_id, 'event': {'type': 'message_stop'}},
        {'type': 'result', 'session_id': native_id, 'subtype': 'success', 'is_error': True,
         'terminal_reason': 'api_error', 'num_turns': 1, 'usage': {'input_tokens': 0, 'output_tokens': 0}}]


class TerminalErrorTests(unittest.TestCase):
    setUp = fixtures.ChannelTests.setUp
    tearDown = fixtures.ChannelTests.tearDown
    new_pool = fixtures.ChannelTests.new_pool

    def failed(self):
        with self.pool.lease('tenant-a', self.body) as active:
            active.caller_request_sha = signature(history_shape(self.body['messages']))
            active.dispatch_process = SimpleNamespace(poll=lambda: None)
            (active.directory / 'dispatch').mkdir(exist_ok=True)
            active.authorize_dispatch()
            grant = read_json(active.directory / 'dispatch/grant.json')
            write_json(active.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant)
            write_json(active.directory / 'dispatch/final.safe.json', {'upstream_attempts': 1, 'denied': 0})
            active.dispatch_process = None
            active.failed = True; active.checkpoint('failed')
            log = active.directory / 'stdout.private.jsonl'
            log.write_text(''.join(json.dumps(e)+'\n' for e in events(active.native_id)))
        return active, log

    def test_known_terminal_failure_allows_new_input_without_replaying_old_request(self):
        active, log = self.failed()
        before = log.read_bytes()
        self.pool.close(); self.pool = self.new_pool()
        with self.assertRaisesRegex(ContractError, 'already_consumed'):
            with self.pool.lease('tenant-a', self.body): pass
        fresh = {**self.body, 'messages': [user('newly authored request')]}
        with self.pool.lease('tenant-a', fresh) as child:
            self.assertNotEqual(child.directory, active.directory)
            self.assertFalse(child.history)
        self.assertEqual(log.read_bytes(), before)
        self.assertEqual(len(list((active.directory/'dispatch').glob('*.consumed.json'))), 1)

    def test_resident_cli_terminal_is_proved_per_grant_after_many_turns(self):
        active, log = self.failed()
        current = events(active.native_id)
        current[-1]['num_turns'] = 22
        log.write_text(''.join(json.dumps(e) + '\n' for e in current))
        before = log.read_bytes()
        with self.assertRaisesRegex(ContractError, 'consumed'):
            with self.pool.lease('tenant-a', self.body):
                self.fail('a terminal error cannot release the old request')
        with self.pool.lease('tenant-a', {**self.body, 'messages': [user('new caller turn')]}) as child:
            self.assertNotEqual(child.directory, active.directory)
        self.assertEqual(log.read_bytes(), before)

    def test_incomplete_mixed_identity_or_policy_rejection_stays_unknown(self):
        active, log = self.failed()
        original = events(active.native_id)
        for change in ('missing_result', 'missing_stop', 'wrong_identity', 'refusal', 'two_turns',
                       'bool_turns', 'zero_turns', 'bad_usage'):
            changed = copy.deepcopy(original)
            if change == 'missing_result': changed.pop()
            elif change == 'missing_stop': changed.pop(-2)
            elif change == 'wrong_identity': changed[-1]['session_id'] = 'another'
            elif change == 'refusal': changed[1]['error'] = 'invalid_request'
            elif change == 'two_turns': changed += original
            elif change == 'bool_turns': changed[-1]['num_turns'] = True
            elif change == 'zero_turns': changed[-1]['num_turns'] = 0
            else: changed[2]['event']['usage']['output_tokens'] = -1
            log.write_text(''.join(json.dumps(e)+'\n' for e in changed))
            with self.subTest(change=change), self.assertRaisesRegex(ContractError, 'evidence_unknown'):
                with self.pool.lease('tenant-a', {**self.body, 'messages': [user('new')]}): pass

    def test_resident_process_counter_is_not_the_current_request_attempt_count(self):
        active, _ = self.failed()
        claims={p.stem:read_json(p) for p in (active.directory/'caller-grants').glob('*.json')}
        request=next(iter(claims))
        claims.update({('a'*64): {'grant_id': 'older-grant-a'}, ('b'*64): {'grant_id': 'older-grant-b'}})
        final=active.directory/'dispatch/final.safe.json'
        write_json(final, {'upstream_attempts': 3, 'denied': 0})
        state=read_json(active.directory/'continuation.json')
        self.assertEqual(failed_request(active.directory, state, claims), request)
        for attempts in (0, 4, True):
            write_json(final, {'upstream_attempts': attempts, 'denied': 0})
            self.assertIsNone(failed_request(active.directory, state, claims))

    def test_reader_keeps_terminal_usage_and_never_emits_success_stop(self):
        with self.pool.lease('tenant-a', self.body) as active:
            active.process = SimpleNamespace(stdout=io.StringIO(
                ''.join(json.dumps(e)+'\n' for e in events(active.native_id))))
            active.read_output()
            active.process = None
            queued=[]
            while not active.events.empty(): queued.append(active.events.get_nowait())
            deltas = [e for e in queued if isinstance(e, dict) and e.get('type')=='message_delta']
            self.assertEqual(deltas[0]['usage']['output_tokens'], 3)
            errors=[e for e in queued if isinstance(e, Exception)]
            self.assertEqual(len(errors), 1)
            self.assertLess(queued.index(deltas[0]), queued.index(errors[0]))
            self.assertFalse(any(isinstance(e, dict) and e.get('type')=='message_stop' for e in queued))

    def test_live_claim_is_busy_without_permitting_duplicate_failover(self):
        with self.pool.lease('tenant-a', self.body) as active:
            active.caller_request_sha = signature(history_shape(self.body['messages']))
            active.dispatch_process = SimpleNamespace(poll=lambda: None)
            (active.directory / 'dispatch').mkdir(exist_ok=True)
            active.authorize_dispatch()
            active.dispatch_process = None
            with self.assertRaisesRegex(ContractError, '^native_request_in_flight_no_replay$'):
                with self.pool.lease('tenant-a', self.body): pass
            # A new conversation of this session runs beside the live claim on its own channel.
            with self.pool.lease('tenant-a', {**self.body, 'messages': [user('new input')]}) as other:
                self.assertNotEqual(other.directory, active.directory)
        with self.assertRaisesRegex(ContractError, '^native_session_evidence_unknown$'):
            with self.pool.lease('tenant-a', {**self.body, 'messages': [user('new input')]}): pass

    def test_incomplete_stream_with_terminal_denied_retry_does_not_poison_new_turn(self):
        active, log = self.failed()
        original = events(active.native_id)
        first = {'type': 'assistant', 'session_id': active.native_id, 'message': {
            'model': 'opus', 'stop_reason': None, 'content': [{'type': 'thinking', 'thinking': 'fixture'}]}}
        error = {'type': 'assistant', 'session_id': active.native_id,
                 'error': 'rate_limit', 'is_api_error_message': True, 'api_error_status': 429,
                 'message': {'model': '<synthetic>', 'content': [
                     {'type': 'text', 'text': 'native_dispatch_already_consumed'}]}}
        result = {**original[-1], 'num_turns': 29, 'api_error_status': 429}
        terminal = [original[0], first, original[-2], error, result]
        write_json(active.directory / 'dispatch/final.safe.json', {'upstream_attempts': 1, 'denied': 1})
        log.write_text(''.join(json.dumps(e)+'\n' for e in terminal))
        before = log.read_bytes()
        with self.assertRaisesRegex(ContractError, 'consumed'):
            with self.pool.lease('tenant-a', self.body): pass
        with self.pool.lease('tenant-a', {**self.body, 'messages': [user('new continuation')]}): pass
        self.assertEqual(log.read_bytes(), before)
        for change in ('missing_result', 'wrong_identity', 'second_stream', 'policy', 'not_guard'):
            changed = copy.deepcopy(terminal)
            if change == 'missing_result': changed.pop()
            elif change == 'wrong_identity': changed[-1]['session_id'] = 'other'
            elif change == 'second_stream': changed.insert(2, original[0])
            elif change == 'policy': changed[1]['error'] = 'invalid_request'
            else: changed[-2]['message']['content'][0]['text'] = 'real quota error'
            log.write_text(''.join(json.dumps(e)+'\n' for e in changed))
            with self.subTest(change=change), self.assertRaisesRegex(ContractError, 'evidence_unknown'):
                with self.pool.lease('tenant-a', {**self.body, 'messages': [user('another continuation')]}): pass

    def test_empty_max_tokens_then_local_retry_keeps_original_claim(self):
        active, log = self.failed()
        native_id = active.native_id
        start, _, delta, stop, result = events(native_id)
        delta['event']['delta']['stop_reason'] = 'max_tokens'
        delta['event']['usage'] = dict(start['event']['message']['usage'], output_tokens=1)
        start['event']['message']['usage']['output_tokens'] = 1
        allowed = {'type': 'rate_limit_event', 'session_id': native_id,
                   'rate_limit_info': {'status': 'allowed'}}
        retry = {'type': 'user', 'session_id': native_id, 'isSynthetic': True,
                 'message': {'role': 'user', 'content': 'continue'}}
        rejected = {**allowed, 'rate_limit_info': {'status': 'rejected'}}
        denial = {'type': 'assistant', 'session_id': native_id, 'error': 'rate_limit',
                  'api_error_status': 429, 'is_api_error_message': True,
                  'message': {'model': '<synthetic>', 'content': [
                      {'type': 'text', 'text': 'native_dispatch_already_consumed'}]}}
        batch = [start, delta, stop, allowed, retry, rejected, denial,
                 {**result, 'api_error_status': 429, 'num_turns': 2}]
        def write(items):
            log.write_text(''.join(json.dumps(e) + '\n' for e in items))
        counters = active.directory / 'dispatch/final.safe.json'
        write_json(counters, {'upstream_attempts': 1, 'denied': 1})
        write(batch)
        self.pool.close()
        self.pool = self.new_pool()
        before = log.read_bytes()
        with self.assertRaisesRegex(ContractError, '^request_already_consumed$'):
            with self.pool.lease('tenant-a', self.body):
                self.fail('original turn was leased twice')
        fresh = {**self.body, 'messages': [user('new question after the empty stream')]}
        with self.pool.lease('tenant-a', fresh) as child:
            self.assertNotEqual(child.directory, active.directory)
        self.assertEqual(log.read_bytes(), before)
        self.assertEqual(len(list((active.directory/'dispatch').glob('*.consumed.json'))), 1)
        state = read_json(active.directory/'continuation.json')
        claims = {p.stem: read_json(p) for p in (active.directory/'caller-grants').glob('*.json')}
        for label, index, path, value in (
            ('vendor quota', 6, ('message','content'), [{'type':'text','text':'usage_limit_reached'}]),
            ('real reset', 5, ('rate_limit_info','resetsAt'), 1900000000),
            ('tool content', 0, ('event','message','content'), [{'type':'tool_use'}]),
            ('wrong model', 0, ('event','message','model'), 'other-model'),
            ('end turn', 1, ('event','delta','stop_reason'), 'end_turn'),
            ('invalid usage', 1, ('event','usage','output_tokens'), True),
            ('different input usage', 1, ('event','usage','input_tokens'), 4),
            ('different session', 4, ('session_id',), 'other-session'),
            ('external user', 4, ('isSynthetic',), False),
            ('policy', 6, ('error',), 'invalid_request'),
        ):
            changed = copy.deepcopy(batch)
            target = changed[index]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            write(changed)
            with self.subTest(reason=label):
                self.assertIsNone(failed_request(active.directory, state, claims))
        for items in (batch[:-1], batch[:2] + batch[3:], [start, *batch],
                      [*batch[:1], {'type':'stream_event','session_id':native_id,
                       'event':{'type':'content_block_start'}}, *batch[1:]]):
            write(items)
            self.assertIsNone(failed_request(active.directory, state, claims))
        write(batch)
        for attempts, denied in ((0,1), (2,1), (1,0)):
            write_json(counters, {'upstream_attempts': attempts, 'denied': denied})
            self.assertIsNone(failed_request(active.directory, state, claims))

    def test_observed_gateway_failure_retires_cli_but_keeps_consumed_request(self):
        active, log = self.failed()
        grant = read_json(active.directory / 'dispatch/grant.json')
        witness = active.directory / 'dispatch' / (grant['id'] + '.gateway-error.json')
        write_json(witness, {'id': grant['id'], 'status': 502})
        for legacy in (False, True):
            marker = 'native_dispatch_already_consumed' if legacy else 'native_gateway_error_no_replay'
            status = 429 if legacy else 400
            log.write_text(''.join(json.dumps(e) + '\n' for e in [
                {'type': 'assistant', 'session_id': active.native_id, 'error': 'rate_limit' if legacy else 'unknown',
                 'is_api_error_message': True, 'api_error_status': status,
                 'message': {'model': '<synthetic>', 'content': [{'type': 'text', 'text': 'API Error: ' + marker}]}},
                {'type': 'result', 'session_id': active.native_id, 'is_error': True,
                 'terminal_reason': 'api_error', 'api_error_status': status, 'num_turns': 4}]))
            write_json(active.directory / 'dispatch/final.safe.json',
                       {'upstream_attempts': 1, 'denied': int(legacy)})
            new = {**self.body, 'messages': [user('new caller continuation ' + str(legacy))]}
            with self.pool.lease('tenant-a', new) as fresh:
                self.assertNotEqual(fresh.directory, active.directory)
            with self.assertRaisesRegex(ContractError, 'already_consumed'):
                with self.pool.lease('tenant-a', self.body):
                    self.fail('original gateway attempt may have been charged')
        witness.unlink()
        with self.assertRaisesRegex(ContractError, 'evidence_unknown'):
            with self.pool.lease('tenant-a', {**self.body, 'messages': [user('without proof')]}):
                self.fail('a local retry denial alone cannot authorize recovery')

    def test_gateway_witness_cannot_reclassify_another_grant_or_real_quota(self):
        active, log = self.failed()
        grant = read_json(active.directory / 'dispatch/grant.json')
        witness = active.directory / 'dispatch' / (grant['id'] + '.gateway-error.json')
        terminal = [
            {'type': 'assistant', 'session_id': active.native_id, 'is_api_error_message': True,
             'api_error_status': 400, 'message': {'model': '<synthetic>', 'content': [
                 {'type': 'text', 'text': 'native_gateway_error_no_replay'}]}},
            {'type': 'result', 'session_id': active.native_id, 'is_error': True,
             'terminal_reason': 'api_error', 'api_error_status': 400, 'num_turns': 1}]
        for reason in ('wrong_grant', 'wrong_status', 'wrong_session', 'missing_result', 'stream_started', 'real_quota'):
            changed = copy.deepcopy(terminal)
            receipt = {'id': grant['id'], 'status': 502}
            if reason == 'wrong_grant': receipt['id'] = 'another-grant'
            elif reason == 'wrong_status': receipt['status'] = 429
            elif reason == 'wrong_session': changed[-1]['session_id'] = 'another-session'
            elif reason == 'missing_result': changed.pop()
            elif reason == 'stream_started': changed.insert(0, {'type': 'stream_event'})
            else: changed[0]['message']['content'][0]['text'] = 'usage_limit_reached'
            write_json(witness, receipt)
            log.write_text(''.join(json.dumps(e) + '\n' for e in changed))
            with self.subTest(reason=reason), self.assertRaisesRegex(ContractError, 'evidence_unknown'):
                with self.pool.lease('tenant-a', {**self.body, 'messages': [user('new turn')]}):
                    self.fail('unproved gateway failure')


if __name__ == '__main__': unittest.main()
