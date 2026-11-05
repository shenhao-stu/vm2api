"""Thinking display controls use the unmodified native CLI's supported flags."""
import copy
import unittest

from native_bridge_session import ContractError, configuration, fixed_configuration, native_options


class ThinkingCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.body = {
            "model": "claude-opus-5-5", "max_tokens": 4096,
            "messages": [{"role": "user", "content": "Offline fixture."}],
        }

    def test_adaptive_display_is_carried_to_the_native_cli(self):
        for display in ("summarized", "omitted"):
            with self.subTest(display=display):
                body = {**self.body, "thinking": {"type": "adaptive", "display": display}}
                original = copy.deepcopy(body)
                environment, options = native_options(body)
                expected_environment = {
                    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096",
                    "CLAUDE_CODE_PROMPT_CACHE_TTL": "1h",
                    "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL": "1h",
                    "FORCE_PROMPT_CACHING_5M": "0",
                }
                if display == 'omitted':
                    expected_environment['CLAUDE_CODE_THINKING_DISPLAY_UPDATES'] = '0'
                self.assertEqual(environment, expected_environment)
                self.assertEqual(options, ["--effort", "medium", "--thinking", "adaptive",
                                           "--thinking-display", display])
                self.assertEqual(body, original)

    def test_legacy_defaults_keep_their_existing_configuration_and_options(self):
        expected = {'model': 'claude-opus-5-5', 'system': '', 'tools': [],
                    'max_tokens': 4096, 'output_config': {'effort': 'medium'}}
        self.assertEqual(configuration(self.body), expected)
        self.assertEqual(fixed_configuration(self.body),
                         {'model': 'claude-opus-5-5', 'system': '', 'tools': []})
        for thinking in (None, {'type': 'adaptive'}, {'type': 'adaptive', 'display': 'updates'}):
            with self.subTest(thinking=thinking):
                body = {**self.body, 'thinking': thinking}
                self.assertEqual(configuration(body), expected)
                self.assertEqual(native_options(body), native_options(self.body))

    def test_unrepresentable_or_unknown_thinking_controls_still_reject(self):
        invalid = [
            {'type': 'enabled', 'budget_tokens': 1024}, {'type': 'disabled'},
            {'type': 'adaptive', 'display': 'highlights'},
            {'type': 'adaptive', 'display': 'unknown'},
            {'type': 'adaptive', 'display': []},
            {'type': 'adaptive', 'display': 'omitted', 'budget_tokens': 1024},
            {'type': 'adaptive', 'display': 'summarized', 'unknown': True},
            {}, [], 'adaptive', True,
        ]
        for thinking in invalid:
            with self.subTest(thinking=thinking), self.assertRaisesRegex(
                    ContractError, 'unsupported_thinking_configuration'):
                native_options({**self.body, 'thinking': thinking})


if __name__ == "__main__":
    unittest.main()
