import unittest

from native_bridge_session import configuration, initial_system


class CallerRuntimeMetadataTests(unittest.TestCase):
    def body(self, system):
        return {'model': 'claude-fable-5-1', 'max_tokens': 1024,
                'system': system, 'messages': [{'role': 'user', 'content': 'test'}]}

    def test_cli_runtime_header_is_not_a_server_system_instruction(self):
        body = self.body([
            {'type': 'text', 'text': 'x-anthropic-billing-header: cc_version=2.1.111.test; cc_entrypoint=cli;'},
            {'type': 'text', 'text': 'Keep the caller instructions.'},
        ])
        self.assertEqual(initial_system(body), 'Keep the caller instructions.')
        self.assertEqual(configuration(body)['system'], initial_system(body))

    def test_flattened_header_preserves_following_instructions(self):
        body = self.body('x-anthropic-billing-header: cc_version=2.1.111.test;\nKeep this.\nAnd this.')
        self.assertEqual(initial_system(body), 'Keep this.\nAnd this.')

    def test_header_is_only_recognized_at_the_protocol_prefix(self):
        for content in ['Quote: x-anthropic-billing-header: cc_version=example;',
                        'First instruction.\nx-anthropic-billing-header: cc_version=example;',
                        'x-anthropic-billing-header: an example without version metadata']:
            self.assertEqual(initial_system(self.body(content)), content)

    def test_runtime_changes_do_not_change_caller_configuration(self):
        a = self.body('x-anthropic-billing-header: cc_version=2.1.111.test;\nSame system')
        b = self.body('x-anthropic-billing-header: cc_version=2.1.304.other;\nSame system')
        self.assertEqual(configuration(a), configuration(b))
        b['system'] += ' changed'
        self.assertNotEqual(configuration(a), configuration(b))


if __name__ == '__main__':
    unittest.main()
