"""Paid tool-turn checkpoints remain inspectable after later failures."""
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

from native_channel_store import ChannelStore, read_json, write_json
from native_bridge_session import ContractError


class PaidCheckpoint(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.store = ChannelStore(root)
        self.addCleanup(self.store.close)
        self.session = SimpleNamespace(directory=root / ('b' * 64), native_id=str(uuid.uuid4()), pending_ids={'tool_fixture'})
        self.session.directory.mkdir()
        self.grant = str(uuid.uuid4())
        self.req = 'a' * 64
        self.store.bind(self.session, self.req, self.grant)
        dispatch = self.session.directory / 'dispatch'
        dispatch.mkdir()
        self.receipt = dispatch / (self.grant + '.consumed.json')
        write_json(self.receipt, {'id':self.grant, 'session_id': self.session.native_id})
        self.file = self.session.directory / 'continuation.json'
        self.state = dict(version=2,status='awaiting_tools',native_id=self.session.native_id,
                          assistant_uuid=str(uuid.uuid4()),message_id='msg_fixture',configuration='1'*64,
                          fixed_configuration='2'*64,history_length=2,history_sha256='3'*64,
                          request_sha256=self.req,history_pending_sha256='4'*64,history_controls_sha256='5'*64)
        self.usage = {'input_tokens':12,'output_tokens':4}
        write_json(self.file,self.state)
        self.claim = self.session.directory / 'caller-grants' / (self.req+'.json')

    def test_paid_boundary_survives_failed_checkpoint_without_authorizing_another_turn(self):
        receipt_before = self.receipt.read_bytes()
        self.store.complete(self.session,self.req,self.usage)
        write_json(self.file,{'version':2,'status':'failed','native_id':str(uuid.uuid4())})
        paid = read_json(self.claim)
        self.assertEqual(paid['completed_checkpoint'],self.state)
        self.assertEqual(paid['terminal_usage'],self.usage)
        self.assertEqual(read_json(self.file)['status'],'failed')
        self.assertEqual(self.receipt.read_bytes(),receipt_before)
        with self.assertRaisesRegex(ContractError,'request_already_consumed'):
            self.store.bind(self.session,self.req,str(uuid.uuid4()))

    def test_unrecognized_metadata_is_never_copied_into_receipt(self):
        write_json(self.file,dict(self.state,unexpected_content='private fixture'))
        self.store.complete(self.session,self.req,self.usage)
        self.assertNotIn('completed_checkpoint',read_json(self.claim))

    def test_missing_consumed_grant_cannot_create_paid_boundary(self):
        self.receipt.unlink()
        with self.assertRaises(ContractError):
            self.store.complete(self.session,self.req,self.usage)
        self.assertEqual(read_json(self.claim)['state'],'claimed')
        self.assertNotIn('completed_checkpoint',read_json(self.claim))

    def test_consumed_receipt_from_another_native_id_cannot_supply_resume_evidence(self):
        write_json(self.receipt, {'id':self.grant, 'session_id':str(uuid.uuid4())})
        self.store.complete(self.session,self.req,self.usage)
        self.assertNotIn('completed_checkpoint',read_json(self.claim))

    def test_paid_refusal_does_not_acquire_a_resume_checkpoint(self):
        self.store.refuse(self.session,self.req,self.usage)
        self.assertEqual(read_json(self.claim)['state'],'policy_refused')
        self.assertNotIn('completed_checkpoint',read_json(self.claim))
