import json
from pathlib import Path
import tempfile
import unittest

from management_sub import execute


class ScheduleBrokerTests(unittest.TestCase):
    def test_native_schedule_mutates_only_one_flag_and_preserves_cooldowns(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'account.json'
            original = {'id': 42, 'status': 'active', 'schedulable': True,
                        'concurrency': 10, 'group_ids': [3],
                        'rate_limit_reset_at': '2099-01-01T00:00:00Z',
                        'temp_unschedulable_until': '2098-01-01T00:00:00Z',
                        'credentials': {'base_url': 'http://relay.internal',
                                        'model_mapping': {'claude-fable-5-1': 'claude-fable-5-1'},
                                        'api_key': 'fixture'}}
            state.write_text(json.dumps(original))
            helper = root / 'native_fixture.py'
            helper.write_text('''import json
from pathlib import Path
STATE = Path(__file__).with_name('account.json')
def api(service, method, path, data=None, receipt=None):
    assert service == 'sub'
    value = json.loads(STATE.read_text())
    if method == 'POST':
        assert path == '/api/v1/admin/accounts/42/schedulable'
        assert set(data) == {'schedulable'}
        value.update(data)
        STATE.write_text(json.dumps(value))
    else:
        assert method == 'GET' and path == '/api/v1/admin/accounts/42'
    return value
''')
            config = {'native_api_path': str(helper), 'receipts_dir': str(root / 'receipts'),
                      'account_id': 42, 'base_url': 'http://relay.internal', 'concurrency': 10,
                      'group_ids': [3], 'models': ['claude-fable-5-1']}
            for action in ('pause', 'resume'):
                result = execute(config, action)
                self.assertEqual(result['schedulable'], action == 'resume')
                self.assertEqual(json.loads(state.read_text()),
                                 {**original, 'schedulable': action == 'resume'})
                self.assertEqual(result['rate_limit_reset_at'], original['rate_limit_reset_at'])
                self.assertEqual(result['temp_unschedulable_until'], original['temp_unschedulable_until'])
