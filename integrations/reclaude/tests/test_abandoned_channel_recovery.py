"""A caller session is not refused forever after one unproven native turn.

Production 2026-11-18/19 (34050): after one failed or unterminated turn, every
later request in that caller session was refused (4232 failed_no_replay, 1295
evidence_unknown in two days), while Sub2API kept routing the session there.
"""
import copy
import os
import time
import unittest
from types import SimpleNamespace

import native_channel_store
import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError, history_shape, signature
from native_channel_store import read_json, write_json
from test_native_paid_sibling import user


def age(directory, seconds):
    then = time.time() - seconds
    for path in directory.rglob('*'):
        os.utime(path, (then, then), follow_symlinks=False)


class AbandonedChannelRecovery(unittest.TestCase):
    setUp = fixtures.ChannelTests.setUp
    tearDown = fixtures.ChannelTests.tearDown
    new_pool = fixtures.ChannelTests.new_pool
    completed = fixtures.ChannelTests.completed

    def claim(self, session, body):
        session.caller_request_sha = signature(history_shape(body['messages']))
        session.dispatch_process = SimpleNamespace(poll=lambda: None)
        (session.directory / 'dispatch').mkdir(exist_ok=True)
        session.authorize_dispatch()
        session.dispatch_process = None

    def failed_turn(self, *, receipt=True, resident_failed=False):
        """A completed first turn, then a dispatched second turn with no terminal."""
        with self.pool.lease('tenant-a', self.body) as active:
            history = self.completed(active, self.body)
        second = {**self.body, 'messages': history + [user('second turn')]}
        with self.pool.lease('tenant-a', second) as active:
            self.assertIsNotNone(active.history)
            self.claim(active, second)
            if receipt:
                grant = read_json(active.directory / 'dispatch/grant.json')
                write_json(active.directory / 'dispatch' / (grant['id'] + '.consumed.json'), grant)
            active.checkpoint('in_flight')
            if resident_failed:
                active.failed = True
                active.checkpoint('failed')
        if not resident_failed:
            self.pool.close()
            self.pool = self.new_pool()
        return active, history, second

    def test_unterminated_turn_blocks_during_cooldown_then_new_turn_continues(self):
        active, history, second = self.failed_turn()
        later = {**self.body, 'messages': history + [user('second turn'),
                 {'role': 'assistant', 'content': 'answer the client did see elsewhere'},
                 user('third turn')]}
        with self.assertRaisesRegex(ContractError, '^native_session_evidence_unknown$'):
            with self.pool.lease('tenant-a', later):
                self.fail('the unproven turn may still be running upstream')
        with self.assertRaisesRegex(ContractError, '^native_request_consumed_no_replay$'):
            with self.pool.lease('tenant-a', second):
                self.fail('the exact unproven request is never replayed')
        age(active.directory, native_channel_store.ABANDON_AFTER_SECONDS + 5)
        with self.pool.lease('tenant-a', later) as fresh:
            self.assertNotEqual(fresh.directory, active.directory)
            self.assertFalse(fresh.history)
        for _ in range(2):
            with self.assertRaisesRegex(ContractError, '^native_request_consumed_no_replay$'):
                with self.pool.lease('tenant-a', second):
                    self.fail('abandonment does not release the consumed request')
        # First completed turn + the abandoned one; nothing new was dispatched there.
        self.assertEqual(len(list((active.directory / 'dispatch').glob('*.consumed.json'))), 2)

    def test_resident_failed_channel_recovers_only_after_cooldown(self):
        active, history, second = self.failed_turn(resident_failed=True)
        later = {**self.body, 'messages': history + [user('a different new turn')]}
        with self.assertRaisesRegex(ContractError, 'failed_no_replay|evidence_unknown'):
            with self.pool.lease('tenant-a', later):
                self.fail('cooldown')
        age(active.directory, native_channel_store.ABANDON_AFTER_SECONDS + 5)
        with self.pool.lease('tenant-a', later) as fresh:
            self.assertNotEqual(fresh.directory, active.directory)
        with self.assertRaisesRegex(ContractError, 'consumed'):
            with self.pool.lease('tenant-a', second):
                self.fail('no replay')

    def test_orphan_dispatch_evidence_stays_closed_after_cooldown(self):
        active, history, _ = self.failed_turn()
        (active.directory / 'dispatch' / ('0' * 8 + '-0000-0000-0000-' + '0' * 12 + '.consumed.json')).write_text('{}')
        age(active.directory, native_channel_store.ABANDON_AFTER_SECONDS + 5)
        with self.assertRaisesRegex(ContractError, '^native_session_evidence_unknown$'):
            with self.pool.lease('tenant-a', {**self.body, 'messages': history + [user('new')]}):
                self.fail('an unattributed dispatch is not a known abandoned turn')

    def test_without_history_import_old_refusal_is_unchanged(self):
        active, history, _ = self.failed_turn()
        age(active.directory, native_channel_store.ABANDON_AFTER_SECONDS + 5)
        self.pool.close()
        self.pool = self.new_pool()
        self.pool.allow_history_import = False
        with self.assertRaisesRegex(ContractError, 'evidence_unknown|failed_no_replay'):
            with self.pool.lease('tenant-a', {**self.body, 'messages': history + [user('new')]}):
                self.fail('only the history-import route can rebuild the conversation')

    def test_tool_result_for_abandoned_turn_continues_through_caller_history(self):
        body = {**self.body, 'tools': [{'name': 'Bash', 'input_schema': {'type': 'object'}}]}
        assistant = [{'type': 'tool_use', 'id': 'toolu_abandoned', 'name': 'Bash', 'input': {}}]
        with self.pool.lease('tenant-a', body) as active:
            history = self.completed(active, body, assistant, pending=('toolu_abandoned',))
            active.failed = True
            active.checkpoint('failed')
        follow = {**body, 'messages': history + [{'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'toolu_abandoned', 'content': 'done'}]}]}
        with self.assertRaises(ContractError):
            with self.pool.lease('tenant-a', follow):
                self.fail('cooldown')
        age(active.directory, native_channel_store.ABANDON_AFTER_SECONDS + 5)
        with self.pool.lease('tenant-a', follow) as fresh:
            self.assertNotEqual(fresh.directory, active.directory)
            self.assertFalse(fresh.history)

    def test_other_tenant_never_sees_abandonment(self):
        active, history, _ = self.failed_turn()
        age(active.directory, native_channel_store.ABANDON_AFTER_SECONDS + 5)
        with self.pool.lease('tenant-b', {**self.body, 'messages': history + [user('new')]}) as other:
            self.assertNotEqual(other.directory, active.directory)
            self.assertFalse(other.history)


if __name__ == '__main__':
    unittest.main()
