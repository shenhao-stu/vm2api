"""Sub2API's account test uses the legacy, default temperature of one."""
import unittest

from native_bridge_session import ContractError, configuration, native_options


class SamplingCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.body = {
            "model": "claude-fable-5-1", "max_tokens": 1024, "stream": True,
            "metadata": {"user_id": "00000000-0000-4000-8000-000000000001"},
            "system": [{"type": "text", "text": "Offline fixture.",
                        "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": "Offline fixture."}],
        }

    def test_sub_account_test_default_is_native_default(self):
        for temperature in (1, 1.0):
            body = {**self.body, "temperature": temperature}
            self.assertEqual(native_options(body), native_options(self.body))
            self.assertEqual(configuration(body), configuration(self.body))
            self.assertEqual(body["temperature"], temperature)

    def test_other_values_are_rejected_before_native_dispatch(self):
        for temperature in (True, False, None, "1", 0, 0.5, 2, float("nan")):
            with self.subTest(temperature=temperature):
                with self.assertRaisesRegex(ContractError, "unsupported_temperature"):
                    native_options({**self.body, "temperature": temperature})

    def test_no_blanket_acceptance_of_unknown_controls(self):
        for extra in ({"top_k": 1}, {"top_p": 0.5}, {"unexpected": True}):
            with self.assertRaises(ContractError):
                native_options({**self.body, **extra})
