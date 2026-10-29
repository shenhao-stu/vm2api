import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'gateway-client.py'
spec = importlib.util.spec_from_file_location('gateway_client', SCRIPT)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class GatewayClientTests(unittest.TestCase):
    def test_actual_child_receives_only_gateway_auth_and_reuses_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = root / 'key'
            key.write_text('fixture-' + 'a' * 40); key.chmod(0o600)
            inspect_child = 'import json,os,sys;print(json.dumps({"environment":dict(os.environ),"args":sys.argv[1:]}))'
            command = [sys.executable, str(SCRIPT), '--base-url', 'https://gateway.invalid',
                       '--state-dir', str(root / 'state'), '--key-file', str(key),
                       '--claude-bin', sys.executable, '--', '-c', inspect_child, '--resume', 'fixture-session']
            inherited = dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN='native-secret-fixture',
                             DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1',
                             CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='0',
                             DISABLE_NON_ESSENTIAL_MODEL_CALLS='1', ANTHROPIC_API_KEY='other-fixture',
                             CLAUDE_CONFIG_DIR='/unrelated/profile', ANTHROPIC_BASE_URL='https://unrelated.invalid')
            first = json.loads(subprocess.check_output(command, env=inherited, text=True))
            profile = Path(first['environment']['CLAUDE_CONFIG_DIR'])
            marker = profile / 'stable-profile-marker'; marker.write_text('preserved')
            second = json.loads(subprocess.check_output(command, env=inherited, text=True))
            self.assertEqual(first, second)
            self.assertEqual(marker.read_text(), 'preserved')
            self.assertEqual(first['args'], ['--resume', 'fixture-session'])
            self.assertEqual(first['environment']['ANTHROPIC_AUTH_TOKEN'], key.read_text())
            self.assertEqual(first['environment']['ANTHROPIC_BASE_URL'], 'https://gateway.invalid')
            self.assertEqual(profile, (root / 'state/profile').resolve())
            for name in ['CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING',
                         'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS',
                         'ANTHROPIC_API_KEY']:
                self.assertNotIn(name, first['environment'])

    def test_native_credentials_and_public_key_files_fail_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); key = root / 'key'
            key.write_text('fixture-' + 'b' * 40); key.chmod(0o644)
            with self.assertRaises(ValueError):
                client.client_environment('https://gateway.invalid', root / 'state', key, '/usr/bin')
            key.chmod(0o600)
            env = client.client_environment('https://gateway.invalid', root / 'state', key, '/usr/bin')
            (Path(env['CLAUDE_CONFIG_DIR']) / '.credentials.json').write_text('{}')
            with self.assertRaises(ValueError):
                client.client_environment('https://gateway.invalid', root / 'state', key, '/usr/bin')

    def test_plain_remote_http_and_url_credentials_are_rejected(self):
        for url in ['http://gateway.invalid', 'https://user:secret@gateway.invalid',
                    'https://gateway.invalid?token=fixture', 'ftp://gateway.invalid']:
            with self.subTest(url=url), self.assertRaises(ValueError): client.gateway_url(url)
        self.assertEqual(client.gateway_url('http://127.0.0.1:18787/'), 'http://127.0.0.1:18787')


if __name__ == '__main__':
    unittest.main()
