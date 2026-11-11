import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_api_http import APIHealth, provider
from native_bridge_session import ContractError, Session


class APIProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'provider.json'
        self.path.write_text(json.dumps({'base_url': 'https://example.com', 'api_key': 'x' * 32}))
        self.path.chmod(0o600)

    def test_permissions_and_credential_validation(self):
        self.assertEqual(provider(self.path)['base_url'], 'https://example.com')
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            provider(self.path)
        self.path.chmod(0o600)
        for url in ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=x', 'https://example.com/v1', 'https://example.com#x']:
            self.path.write_text(json.dumps({'base_url': url, 'api_key': 'x' * 32}))
            with self.assertRaises(ValueError):
                provider(self.path)

    def test_proxy_is_explicit_and_validated(self):
        for proxy in ['socks5h://user:secret@127.0.0.1:1080', 'http://127.0.0.1:8080']:
            self.path.write_text(json.dumps({'base_url': 'https://example.com', 'api_key': 'x' * 32, 'proxy_url': proxy}))
            self.assertEqual(provider(self.path)['proxy_url'], proxy)
        for proxy in ['file:///etc/passwd', 'socks5://127.0.0.1', 'http://127.0.0.1:8080/path', 'http://127.0.0.1:8080?x=y']:
            self.path.write_text(json.dumps({'base_url': 'https://example.com', 'api_key': 'x' * 32, 'proxy_url': proxy}))
            with self.assertRaises(ValueError):
                provider(self.path)

    def test_health_never_reads_existing_oauth_state(self):
        health = APIHealth(self.path, Path('/bin/sh'), Path('/bin/sh'))
        self.assertEqual(health.failed_health_checks(), [])
        self.path.unlink()
        self.assertEqual(health.failed_health_checks(), ['provider_configuration_unavailable'])
        self.assertFalse(health.authorization_revoked())

    def test_api_mode_requires_durable_dispatch_guard(self):
        body = {'model': 'claude-sonnet-5-5', 'max_tokens': 100, 'messages': [{'role': 'user', 'content': 'fixture'}]}
        with self.assertRaisesRegex(ContractError, 'api_provider_requires_dispatch_guard'):
            Session(self.root/'session', ['/bin/false'], {'HOME': str(self.root/'home')}, body, api_base='https://example.com')


if __name__ == '__main__':
    unittest.main()
