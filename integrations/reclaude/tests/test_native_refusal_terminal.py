"""A provider refusal is a terminal response, never a resumable assistant turn."""
import unittest
from unittest.mock import Mock

import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError
from native_channel_store import read_json, write_json


class RefusalTerminalTests(unittest.TestCase):
    setUp = fixtures.ChannelTests.setUp
    tearDown = fixtures.ChannelTests.tearDown
    new_pool = fixtures.ChannelTests.new_pool

    def test_empty_refusal_keeps_usage_and_isolates_scope_without_resume_uuid(self):
        with self.pool.lease('tenant-a', self.body) as session:
            session.prepare = lambda: None
            session.dispatch_process = Mock(poll=lambda: None)
            (session.directory / 'dispatch').mkdir()
            def dispatch(blocks):
                session.authorize_dispatch()
                grant = read_json(session.directory / 'dispatch/grant.json')
                write_json(session.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant)
                session.dispatch_process = None
            session.dispatch_user_input = dispatch
            for event in [
                {'type': 'message_start', 'message': {'id': 'msg_refusal', 'type': 'message',
                 'role': 'assistant', 'model': 'opus', 'content': [], 'stop_reason': None,
                 'usage': {'input_tokens': 32, 'output_tokens': 0,
                           'cache_creation_input_tokens': 1302, 'cache_read_input_tokens': 0}}},
                {'type': 'message_delta', 'delta': {'stop_reason': 'refusal'}, 'usage': {'output_tokens': 0}},
                {'type': 'message_stop'},
            ]:
                session.events.put(event)
            got = list(session.request(self.body))
            self.assertEqual(got[-1]['type'], 'message_stop')
            self.assertEqual(got[-2]['delta']['stop_reason'], 'refusal')
            claim = read_json(next((session.directory / 'caller-grants').glob('*.json')))
            self.assertEqual(claim['state'], 'policy_refused')
            self.assertEqual(claim['terminal_usage']['cache_creation_input_tokens'], 1302)
            self.assertIsNone(session.resume_uuid)
            self.assertTrue(session.failed)
            original = session.directory
        self.pool.close(); self.pool = self.new_pool()
        for body in (self.body, {**self.body, 'model': 'sonnet'},
                     {**self.body, 'messages': [{'role': 'user', 'content': 'Continue'}]}):
            with self.assertRaisesRegex(ContractError, '^upstream_policy_refused_no_replay$'):
                with self.pool.lease('tenant-a', body): self.fail('refused scope resumed')
        with self.pool.lease('another-tenant', self.body) as other:
            self.assertNotEqual(other.directory, original)
        self.assertEqual(len(list((original / 'dispatch').glob('*.consumed.json'))), 1)


if __name__ == '__main__': unittest.main()
