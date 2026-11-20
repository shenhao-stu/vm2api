"""Only a gateway refusal with nothing produced and nothing counted admits the same request again."""
import copy
import json
import unittest
from types import SimpleNamespace

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, signature
from native_channel_store import UNBILLED_REDISPATCHES, read_json, write_json
from native_http import refused_unbilled
from native_terminal_error import failed_request, unbilled_gateway_failure

ZERO = {'input_tokens': 0, 'output_tokens': 0, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}


def refusal(native_id, **result):
    """What the CLI prints when the dispatch proxy answers a gateway failure."""
    return [
        {'type': 'system', 'subtype': 'init', 'session_id': native_id},
        {'type': 'assistant', 'session_id': native_id, 'error': 'unknown', 'is_api_error_message': True,
         'api_error_status': 400, 'message': {'model': '<synthetic>', 'usage': dict(ZERO), 'content': [
             {'type': 'text', 'text': 'API Error: 400 native_gateway_error_no_replay'}]}},
        {'type': 'result', 'session_id': native_id, 'subtype': 'success', 'is_error': True,
         'terminal_reason': 'api_error', 'api_error_status': 400, 'num_turns': 1,
         'total_cost_usd': 0, 'modelUsage': {}, 'usage': dict(ZERO), **result}]


class UnbilledRefusalTests(unittest.TestCase):
    setUp = fixtures.ChannelTests.setUp
    tearDown = fixtures.ChannelTests.tearDown
    new_pool = fixtures.ChannelTests.new_pool

    def refuse(self, status=503, events=None, final=None):
        """Dispatch self.body once and leave the evidence of a gateway failure."""
        with self.pool.lease('tenant-a', self.body) as active:
            active.caller_request_sha = signature(history_shape(self.body['messages']))
            active.dispatch_process = SimpleNamespace(poll=lambda: None)
            (active.directory / 'dispatch').mkdir(exist_ok=True)
            active.authorize_dispatch()
            grant = read_json(active.directory / 'dispatch/grant.json')
            write_json(active.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant)
            write_json(active.directory / 'dispatch' / (grant['id'] + '.gateway-error.json'),
                       {'id': grant['id'], 'status': status})
            write_json(active.directory / 'dispatch/final.safe.json', final or {'upstream_attempts': 1, 'denied': 0})
            active.dispatch_process = None
            active.failed = True
            active.checkpoint('failed')
            self.write(active, events or refusal(active.native_id))
        return active

    def write(self, active, events):
        (active.directory / 'stdout.private.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in events))

    def proof(self, active):
        claims = {p.stem: read_json(p) for p in (active.directory / 'caller-grants').glob('*.json')}
        state = read_json(active.directory / 'continuation.json')
        return unbilled_gateway_failure(active.directory, state, claims), failed_request(active.directory, state, claims)

    def test_refused_request_is_dispatched_again_in_a_new_channel(self):
        for status in (502, 503):
            with self.subTest(status=status):
                self.body = {**self.body, 'messages': [{'role': 'user', 'content': 'turn %d' % status}]}
                first = self.refuse(status)
                self.assertTrue(refused_unbilled(first))
                before = sorted(p.name for p in (first.directory / 'dispatch').iterdir())
                self.pool.close()
                self.pool = self.new_pool()
                with self.pool.lease('tenant-a', self.body) as again:
                    self.assertNotEqual(again.directory, first.directory)
                    self.assertFalse(again.history)
                self.assertEqual(sorted(p.name for p in (first.directory / 'dispatch').iterdir()), before)

    def test_repeated_refusals_stop_after_the_allowed_redispatches(self):
        channels = {self.refuse().directory for _ in range(UNBILLED_REDISPATCHES + 1)}
        self.assertEqual(len(channels), UNBILLED_REDISPATCHES + 1)
        with self.assertRaisesRegex(ContractError, '^request_already_consumed$'):
            with self.pool.lease('tenant-a', self.body):
                self.fail('a failing gateway must not be retried without end')
        other = {**self.body, 'messages': [{'role': 'user', 'content': 'a different turn'}]}
        with self.pool.lease('tenant-a', other) as fresh:
            self.assertNotIn(fresh.directory, channels)

    def test_second_dispatch_without_its_own_proof_stays_consumed(self):
        self.refuse()
        with self.pool.lease('tenant-a', self.body) as again:
            again.caller_request_sha = signature(history_shape(self.body['messages']))
            again.dispatch_process = SimpleNamespace(poll=lambda: None)
            (again.directory / 'dispatch').mkdir(exist_ok=True)
            again.authorize_dispatch()
            grant = read_json(again.directory / 'dispatch/grant.json')
            write_json(again.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant)
            again.dispatch_process = None
            again.failed = True
            again.checkpoint('failed')
        with self.assertRaisesRegex(ContractError, 'consumed'):
            with self.pool.lease('tenant-a', self.body):
                self.fail('the second dispatch has no proof of its own')

    def test_anything_short_of_the_full_proof_stays_consumed(self):
        active = self.refuse()
        good = refusal(active.native_id)
        self.assertEqual(self.proof(active)[0], signature(history_shape(self.body['messages'])))
        cases = {
            'gateway_timeout': None,
            'no_usage_on_turn': lambda e: e[1]['message'].pop('usage'),
            'tokens_on_turn': lambda e: e[1]['message']['usage'].update(input_tokens=7),
            'cost_missing': lambda e: e[2].pop('total_cost_usd'),
            'cost_counted': lambda e: e[2].update(total_cost_usd=0.01),
            'usage_counted': lambda e: e[2].update(modelUsage={'opus': {'inputTokens': 3}}),
            'usage_missing': lambda e: e[2].pop('modelUsage'),
            'stream_started': lambda e: e.insert(1, {'type': 'stream_event', 'session_id': active.native_id,
                                                     'event': {'type': 'message_start'}}),
            'legacy_local_denial': lambda e: (e[1].update(api_error_status=429), e[2].update(api_error_status=429),
                                              e[1]['message']['content'][0].update(text='native_dispatch_already_consumed')),
            'cli_retried': None,
        }
        grant = read_json(active.directory / 'dispatch/grant.json')
        witness = active.directory / 'dispatch' / (grant['id'] + '.gateway-error.json')
        for name, change in cases.items():
            events = copy.deepcopy(good)
            write_json(witness, {'id': grant['id'], 'status': 504 if name == 'gateway_timeout' else 503})
            write_json(active.directory / 'dispatch/final.safe.json',
                       {'upstream_attempts': 1, 'denied': int(name == 'cli_retried')})
            if change:
                change(events)
            self.write(active, events)
            with self.subTest(case=name):
                self.assertIsNone(self.proof(active)[0])
                self.assertFalse(refused_unbilled(active))
                with self.assertRaises(ContractError):
                    with self.pool.lease('tenant-a', self.body):
                        self.fail('the original attempt may have been charged')

    def test_gateway_timeout_still_retires_the_cli_for_a_new_turn(self):
        active = self.refuse(504)
        unbilled, terminal = self.proof(active)
        self.assertIsNone(unbilled)
        self.assertIsNotNone(terminal)
        with self.assertRaisesRegex(ContractError, '^request_already_consumed$'):
            with self.pool.lease('tenant-a', self.body):
                self.fail('the provider may have run the turn after its gateway gave up')
        with self.pool.lease('tenant-a', {**self.body, 'messages': [{'role': 'user', 'content': 'next'}]}) as fresh:
            self.assertNotEqual(fresh.directory, active.directory)

    def test_resident_cli_totals_must_equal_its_earlier_completed_turns(self):
        active = self.refuse()
        request = signature(history_shape(self.body['messages']))
        claims = {p.stem: read_json(p) for p in (active.directory / 'caller-grants').glob('*.json')}
        state = read_json(active.directory / 'continuation.json')
        grant = read_json(active.directory / 'dispatch/grant.json')
        earlier = ('1' * 8 + '-' + '2' * 4 + '-' + '3' * 4 + '-' + '4' * 4 + '-' + '5' * 12, 'a' * 64)
        older_cli = ('6' * 8 + '-' + '2' * 4 + '-' + '3' * 4 + '-' + '4' * 4 + '-' + '5' * 12, 'b' * 64)
        for (grant_id, key), native_id, tokens in ((earlier, active.native_id, 40), (older_cli, 'another-cli', 900)):
            write_json(active.directory / 'dispatch' / (grant_id + '.consumed.json'),
                       {'id': grant_id, 'session_id': native_id, 'model': grant['model']})
            claims[key] = {'request_sha256': key, 'grant_id': grant_id, 'state': 'complete', 'native_id': native_id,
                           'terminal_usage': {'input_tokens': 2, 'output_tokens': tokens,
                                              'cache_read_input_tokens': 500, 'cache_creation_input_tokens': 30}}
        write_json(active.directory / 'dispatch/final.safe.json', {'upstream_attempts': 2, 'denied': 0})
        totals = {'inputTokens': 2, 'outputTokens': 40, 'cacheReadInputTokens': 500, 'cacheCreationInputTokens': 30}
        for name, usage, expected in (
                ('equal', totals, request),
                ('one_more_token', {**totals, 'outputTokens': 41}, None),
                ('another_model', None, None),
                ('includes_other_cli', {**totals, 'outputTokens': 940}, None)):
            usage = {'sonnet': totals} if usage is None else {grant['model']: usage}
            self.write(active, refusal(active.native_id, num_turns=2, total_cost_usd=0.4, modelUsage=usage))
            with self.subTest(case=name):
                self.assertEqual(unbilled_gateway_failure(active.directory, state, claims), expected)


if __name__ == '__main__':
    unittest.main()
