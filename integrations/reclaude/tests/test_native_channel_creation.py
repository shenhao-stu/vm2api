"""No dispatch or registry entry may outlive an unsuccessful channel preparation."""
import unittest
from unittest.mock import patch
import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError
from native_session_pool import session_key
from native_channel_store import read_json, write_json

class ChannelCreationTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.ChannelTests();self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.body=self.fixture.body

    def restart(self):
        self.fixture.pool.close();self.fixture.pool=self.fixture.new_pool()

    def test_first_factory_failure_does_not_poison_logical_session(self):
        p=self.fixture.pool;key=session_key('tenant',self.body)
        def fail(path,body):
            path.mkdir();(path/'partial').write_text('no grant')
            raise OSError('fixture factory unavailable')
        with patch.object(p,'factory',fail),self.assertRaises(OSError):
            with p.lease('tenant',self.body):self.fail('admitted')
        self.restart();p=self.fixture.pool
        self.assertFalse(p.channel_store.document(key)['channels'])
        with p.lease('tenant',self.body) as fresh:
            self.assertFalse(fresh.failed)
            self.assertFalse(list((fresh.directory/'dispatch').glob('*.consumed.json')))

    def test_unpublished_first_prepared_channel_recovers_after_restart(self):
        p=self.fixture.pool;key=session_key('tenant',self.body)
        with patch.object(p.channel_store,'register',side_effect=OSError('publication failed')):
            with self.assertRaises(OSError):
                with p.lease('tenant',self.body):self.fail('admitted')
        target=p.root/key
        self.assertEqual(read_json(target/'continuation.json')['status'],'prepared')
        self.restart()
        with self.fixture.pool.lease('tenant',self.body) as fresh:
            self.assertEqual(fresh.directory,target)
            self.assertFalse(fresh.failed)
        self.assertEqual(set(self.fixture.pool.channel_store.document(key)['channels']),{key})

    def test_unpublished_preparation_with_any_dispatch_is_never_reused(self):
        p=self.fixture.pool;key=session_key('tenant',self.body)
        with patch.object(p.channel_store,'register',side_effect=OSError):
            with self.assertRaises(OSError):
                with p.lease('tenant',self.body):pass
        d=p.root/key/'dispatch';d.mkdir(exist_ok=True)
        write_json(d/'unknown.consumed.json',{'id':'unknown'},exclusive=True)
        self.restart()
        with self.assertRaises(ContractError):
            with self.fixture.pool.lease('tenant',self.body):self.fail('unknown dispatch reused')
        self.assertTrue((d/'unknown.consumed.json').exists())
