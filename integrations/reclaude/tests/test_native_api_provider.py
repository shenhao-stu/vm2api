import json
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

from native_api_http import APIHandler, APIHealth, initialize_api_profile, provider
from native_bridge_session import ContractError, Session


class APIProviderTests(unittest.TestCase):
    def handler(self, headers):
        handler = object.__new__(APIHandler)
        handler.server = SimpleNamespace(
            client_key="c" * 40,
            relay_key="g" * 40,
            tenant="gateway",
            require_principal=True,
        )
        handler.headers = Message()
        for name, val in headers:
            handler.headers[name] = val
        return handler

    def test_dedicated_client_key_needs_no_principal_header(self):
        for name, value in [
            ("Authorization", "Bearer " + "c" * 40),
            ("x-api-key", "c" * 40),
        ]:
            handler = self.handler(
                [(name, value), ("X-Native-Relay-Principal", "forged")]
            )
            self.assertTrue(handler.authorized())
            self.assertNotEqual(handler.authenticated_tenant(), "gateway")
            tenant = handler.authenticated_tenant()
            handler.headers.replace_header("X-Native-Relay-Principal", "0" * 64)
            self.assertEqual(handler.authenticated_tenant(), tenant)

    def test_ambiguous_credentials_cannot_select_a_tenant(self):
        handler = self.handler(
            [("Authorization", "Bearer " + "c" * 40), ("x-api-key", "g" * 40)]
        )
        self.assertFalse(handler.authorized())

    def test_gateway_key_still_requires_trusted_principal(self):
        from adapter import Rejection

        handler = self.handler([("Authorization", "Bearer " + "g" * 40)])
        self.assertTrue(handler.authorized())
        with self.assertRaises(Rejection):
            handler.authenticated_tenant()
        handler.headers["X-Native-Relay-Principal"] = "0" * 64
        self.assertNotEqual(handler.authenticated_tenant(), "gateway")

    def test_matching_bearer_and_api_key_select_same_client(self):
        handler = self.handler(
            [("Authorization", "bearer " + "c" * 40), ("x-api-key", "c" * 40)]
        )
        self.assertTrue(handler.authorized())
        self.assertNotEqual(handler.authenticated_tenant(), "gateway")
        handler = self.handler(
            [
                ("Authorization", "Bearer " + "c" * 40),
                ("Authorization", "Bearer " + "c" * 40),
            ]
        )
        self.assertFalse(handler.authorized())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "provider.json"
        self.path.write_text(
            json.dumps({"base_url": "https://example.com", "api_key": "x" * 32})
        )
        self.path.chmod(0o600)

    def test_permissions_and_credential_validation(self):
        self.assertEqual(provider(self.path)["base_url"], "https://example.com")
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            provider(self.path)
        self.path.chmod(0o600)
        for url in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com?key=x",
            "https://example.com/v1",
            "https://example.com#x",
        ]:
            self.path.write_text(json.dumps({"base_url": url, "api_key": "x" * 32}))
            with self.assertRaises(ValueError):
                provider(self.path)

    def test_proxy_is_explicit_and_validated(self):
        for proxy in ["socks5h://user:secret@127.0.0.1:1080", "http://127.0.0.1:8080"]:
            self.path.write_text(
                json.dumps(
                    {
                        "base_url": "https://example.com",
                        "api_key": "x" * 32,
                        "proxy_url": proxy,
                    }
                )
            )
            self.assertEqual(provider(self.path)["proxy_url"], proxy)
        for proxy in [
            "file:///etc/passwd",
            "socks5://127.0.0.1",
            "http://127.0.0.1:8080/path",
            "http://127.0.0.1:8080?x=y",
        ]:
            self.path.write_text(
                json.dumps(
                    {
                        "base_url": "https://example.com",
                        "api_key": "x" * 32,
                        "proxy_url": proxy,
                    }
                )
            )
            with self.assertRaises(ValueError):
                provider(self.path)

    def test_health_never_reads_existing_oauth_state(self):
        health = APIHealth(self.path, Path("/bin/sh"), Path("/bin/sh"))
        self.assertEqual(health.failed_health_checks(), [])
        self.path.unlink()
        self.assertEqual(
            health.failed_health_checks(), ["provider_configuration_unavailable"]
        )
        self.assertFalse(health.authorization_revoked())

    def test_api_mode_requires_durable_dispatch_guard(self):
        body = {
            "model": "claude-sonnet-5-5",
            "max_tokens": 100,
            "messages": [{"role": "user", "content": "fixture"}],
        }
        with self.assertRaisesRegex(
            ContractError, "api_provider_requires_dispatch_guard"
        ):
            Session(
                self.root / "session",
                ["/bin/false"],
                {"HOME": str(self.root / "home")},
                body,
                api_base="https://example.com",
            )

    def test_private_profile_is_initialized_once_without_overwriting_settings(self):
        profile = initialize_api_profile(self.root / "isolated-home")
        config = profile / ".claude.json"
        self.assertEqual(
            json.loads(config.read_text()), {"hasCompletedOnboarding": True}
        )
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        original = '{"hasCompletedOnboarding": false, "theme": "light"}'
        config.write_text(original)
        self.assertEqual(initialize_api_profile(self.root / "isolated-home"), profile)
        self.assertEqual(config.read_text(), original)


if __name__ == "__main__":
    unittest.main()
