import copy
import tempfile
import unittest
from pathlib import Path
import uuid

from native_bridge_session import (ContractError, RequestRejected, Session, configuration,
                                   fixed_configuration, native_cache_ttl, native_options)
from native_session_pool import SessionPool


class NativeCacheTtlTests(unittest.TestCase):
    def test_explicit_five_minutes_reaches_native_cli_controls(self):
        body = {'model': 'fixture', 'max_tokens': 32, 'messages': [
            {'role': 'user', 'content': [{'type': 'text', 'text': 'fixture',
             'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}]}]}
        before = copy.deepcopy(body)
        environment, _ = native_options(body)
        self.assertEqual(environment.get('CLAUDE_CODE_PROMPT_CACHE_TTL'), '5m')
        self.assertEqual(environment.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'), '5m')
        self.assertEqual(environment.get('FORCE_PROMPT_CACHING_5M'), '1')
        self.assertEqual(body, before)

    def test_ttl_change_is_mutable_without_changing_session_identity(self):
        body = {'model': 'fixture', 'max_tokens': 32, 'system': 'fixture',
                'messages': [{'role': 'user', 'content': 'fixture'}]}
        short = {**body, 'system': [{'type': 'text', 'text': 'fixture',
                  'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}]}
        with tempfile.TemporaryDirectory() as root:
            session = Session(Path(root) / 'session', ['unused'], {}, body)
            try:
                self.assertTrue(session.validate_configuration(short))
                self.assertEqual(fixed_configuration(short), fixed_configuration(body))
                self.assertNotIn('cache_ttl', configuration(body))
            finally:
                session.close()

    def test_absent_and_explicit_hour_are_equivalent_and_override_inherited_five(self):
        base = {'model': 'fixture', 'max_tokens': 32,
                'messages': [{'role': 'user', 'content': 'fixture'}]}
        controls = [None, {'type': 'ephemeral'}, {'type': 'ephemeral', 'ttl': '1h'}]
        for control in controls:
            body = {**base, **({'cache_control': control} if control else {})}
            with self.subTest(control=control), tempfile.TemporaryDirectory() as root:
                inherited = {'FORCE_PROMPT_CACHING_5M': '1',
                             'CLAUDE_CODE_PROMPT_CACHE_TTL': '5m'}
                session = Session(Path(root) / 'session', ['unused'], inherited, body)
                try:
                    self.assertEqual(native_cache_ttl(body), '1h')
                    self.assertEqual(session.environment['CLAUDE_CODE_PROMPT_CACHE_TTL'], '1h')
                    self.assertEqual(session.environment['FORCE_PROMPT_CACHING_5M'], '0')
                    self.assertEqual(configuration(body), configuration(base))
                    self.assertEqual(inherited['FORCE_PROMPT_CACHING_5M'], '1')
                finally:
                    session.close()

    def test_only_real_annotations_select_ttl(self):
        body = {'tools': [{'name': 'tool', 'input_schema': {'type': 'object',
                          'properties': {'cache_control': {'type': 'string'}}}}],
                'messages': [{'role': 'assistant', 'content': [{'type': 'tool_use',
                    'input': {'cache_control': {'ttl': 'business data'}}}]}]}
        self.assertEqual(native_cache_ttl(body), '1h')
        body['messages'].append({'role': 'user', 'content': [{'type': 'tool_result',
            'content': [{'type': 'search_result', 'content': [{'type': 'text',
                'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}]}]}]})
        self.assertEqual(native_cache_ttl(body), '5m')

    def test_mixed_and_invalid_ttl_reject_before_pool_admission(self):
        base = {'model': 'fixture', 'max_tokens': 32,
                'metadata': {'user_id': str(uuid.uuid4())},
                'messages': [{'role': 'user', 'content': 'fixture'}]}
        with tempfile.TemporaryDirectory() as root:
            created = []
            pool = SessionPool(root, lambda *args: created.append(args))
            try:
                for control in [None, [], {'type': 'other'},
                                {'type': 'ephemeral', 'ttl': None},
                                {'type': 'ephemeral', 'ttl': '10m'}]:
                    with self.subTest(control=control):
                        with self.assertRaisesRegex(ContractError, 'invalid_cache_control'):
                            with pool.lease('tenant', {**base, 'cache_control': control}):
                                self.fail('Admitted invalid TTL')
                for long in [{'type': 'ephemeral'}, {'type': 'ephemeral', 'ttl': '1h'}]:
                    mixed = {**base, 'cache_control': long, 'system': [
                        {'type': 'text', 'text': 'fixture',
                         'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}]}
                    with self.assertRaisesRegex(ContractError, 'cache_ttl_mixed_unsupported'):
                        with pool.lease('tenant', mixed):
                            self.fail('Admitted mixed TTL')
                self.assertEqual(created, [])
                self.assertEqual(list(Path(root).iterdir()), [])
            finally:
                pool.close()

    def test_rejected_mixed_request_preserves_resident_and_failed_checkpoints(self):
        base = {'model': 'fixture', 'max_tokens': 32,
                'messages': [{'role': 'user', 'content': 'fixture'}]}
        mixed = {**base, 'cache_control': {'type': 'ephemeral'}, 'system': [
            {'type': 'text', 'text': 'fixture',
             'cache_control': {'type': 'ephemeral', 'ttl': '5m'}}]}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'session'
            session = Session(path, ['unused'], {}, base)
            session.checkpoint('prepared')
            saved = (path / 'continuation.json').read_bytes()
            with self.assertRaisesRegex(RequestRejected, 'cache_ttl_mixed_unsupported'):
                list(session.request(mixed))
            self.assertFalse(session.failed)
            self.assertEqual((path / 'continuation.json').read_bytes(), saved)
            session.failed = True
            session.checkpoint('failed')
            saved = (path / 'continuation.json').read_bytes()
            with self.assertRaisesRegex(ContractError, 'native_session_incomplete_no_replay'):
                Session(path, ['unused'], {}, base, restore=True)
            self.assertEqual((path / 'continuation.json').read_bytes(), saved)
            session.close()
