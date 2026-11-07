"""A proved, uncharged legacy quota refusal must not poison later user turns."""
import copy
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid

from native_bridge_session import ContractError, Session
from native_session_pool import SessionPool, session_key


class RejectedLegacyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.body = {'model': 'fixture', 'max_tokens': 16,
                     'metadata': {'user_id': str(uuid.uuid4())},
                     'messages': [{'role': 'user', 'content': 'earlier work'},
                                  {'role': 'assistant', 'content': 'completed elsewhere'},
                                  {'role': 'user', 'content': 'new input'}]}
        self.key = session_key('tenant-a', self.body)
        self.path = self.root / 'sessions' / self.key
        self.path.mkdir(parents=True)
        (self.path / 'dispatch').mkdir()
        self.native_id, self.grant_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.state = {'version': 2, 'status': 'failed', 'native_id': self.native_id}
        self.result = {'type': 'result', 'session_id': self.native_id,
                       'is_error': True, 'api_error_status': 429,
                       'api_error': 'usage_limit_reached', 'terminal_reason': 'api_error',
                       'total_cost_usd': 0, 'modelUsage': {},
                       'usage': {k: 0 for k in ('input_tokens', 'output_tokens',
                                  'cache_read_input_tokens', 'cache_creation_input_tokens')}}
        self.events = [
            {'type': 'rate_limit_event', 'session_id': self.native_id,
             'rate_limit_info': {'status': 'rejected', 'resetsAt': int(time.time()) - 60}},
            {'type': 'assistant', 'session_id': self.native_id, 'error': 'rate_limit',
             'api_error_status': 429, 'api_error': 'usage_limit_reached'},
            self.result]
        self.write('continuation.json', self.state)
        self.write('tools.json', [])
        (self.path / 'system.txt').write_text('')
        self.write('dispatch/grant.json', {'id': self.grant_id, 'session_id': self.native_id, 'model': 'fixture'})
        self.write('dispatch/'+self.grant_id+'.consumed.json',
                   {'id': self.grant_id, 'session_id': self.native_id, 'model': 'fixture',
                    'body_sha256': 'a' * 64, 'at_ms': int((time.time()-120)*1000)})
        self.write('dispatch/final.safe.json', {'upstream_attempts': 1, 'denied': 0})
        self.save_events()
        (self.path / 'latest').symlink_to('native.debug.log')
        self.pool = SessionPool(self.root / 'sessions', self.factory, recover=self.factory,
                                allow_history_import=True, configuration_channels=True)

    def write(self, name, value):
        (self.path / name).write_text(json.dumps(value))

    def save_events(self):
        (self.path / 'stdout.private.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in self.events))

    def factory(self, path, body):
        return Session(path, ['unused-no-provider'], {'PATH': os.environ['PATH']}, body,
                       restore=True, history_profile=self.root / 'profile')

    def tearDown(self):
        self.pool.close()
        self.temp.cleanup()

    def test_known_uncharged_refusal_can_import_a_later_caller_history(self):
        old = {str(p.relative_to(self.path)): p.read_bytes() for p in self.path.rglob('*') if p.is_file()}
        with self.pool.lease('tenant-a', self.body) as session:
            self.assertFalse(session.failed)
            self.assertNotEqual(session.native_id, self.native_id)
            self.assertEqual(session.history, [])
            self.assertIsNone(session.process)
        archives = list((self.pool.root / '.rejected-legacy' / self.key).glob('*/session'))
        self.assertEqual(len(archives), 1)
        self.assertEqual(os.readlink(archives[0]/'latest'), 'native.debug.log')
        self.assertEqual(old, {str(p.relative_to(archives[0])): p.read_bytes()
                              for p in archives[0].rglob('*') if p.is_file()})
        self.assertFalse(list((self.path / 'dispatch').glob('*.consumed.json')))
        self.assertIsNotNone(self.pool.channel_store.document(self.key))

    def test_missing_or_nonzero_terminal_evidence_stays_blocked(self):
        original = copy.deepcopy(self.events)
        mutations = [lambda: self.events.pop(),
                     lambda: self.events[-1]['usage'].update(output_tokens=1),
                     lambda: self.events[-1].update(total_cost_usd=.01),
                     lambda: self.events[-1].update(api_error_status=502),
                     lambda: self.events[0]['rate_limit_info'].update(resetsAt=int(time.time())+300),
                     lambda: self.events.insert(0, {'type':'stream_event','event':{'type':'message_start'}})]
        for change in mutations:
            with self.subTest(change=change):
                self.events = copy.deepcopy(original)
                change(); self.save_events()
                with self.assertRaisesRegex(ContractError, 'incomplete_no_replay'):
                    with self.pool.lease('tenant-a', self.body):
                        self.fail('unproved recovery')
                self.assertEqual(json.loads((self.path/'continuation.json').read_text()), self.state)

    def test_extra_dispatch_or_registered_channel_is_never_legacy_recovery(self):
        extra = self.path/'dispatch'/(str(uuid.uuid4())+'.consumed.json')
        extra.write_text('{}')
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', self.body):
                self.fail('unknown earlier request')
        extra.unlink()
        (self.path/'.configuration-channel.json').write_text('{}')
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', self.body):
                self.fail('registered channel migrated')

    def test_other_tenant_does_not_recover_or_read_this_history(self):
        before=(self.path/'continuation.json').read_bytes()
        with self.pool.lease('tenant-b',self.body) as other:
            self.assertNotEqual(other.directory,self.path)
            self.assertFalse(other.history)
        self.assertEqual((self.path/'continuation.json').read_bytes(),before)

    def test_invalid_new_history_cannot_retire_the_old_evidence(self):
        changed={**self.body,'messages':[{'role':'user','content':[
            {'type':'tool_result','tool_use_id':'no-such-tool','content':'bad'}]}]}
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a',changed):
                self.fail('invalid caller history')
        self.assertTrue((self.path/'continuation.json').exists())
        self.assertFalse((self.pool.root/'.rejected-legacy').exists())

    def test_symlink_and_changed_receipt_are_not_accepted(self):
        path=self.path/'dispatch'/ (self.grant_id+'.consumed.json')
        old=path.read_text();path.unlink()
        other=self.root/'receipt.json';other.write_text(old);path.symlink_to(other)
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a',self.body):
                self.fail('symlink receipt')
        self.assertTrue((self.path/'continuation.json').exists())


if __name__ == '__main__':
    unittest.main()
