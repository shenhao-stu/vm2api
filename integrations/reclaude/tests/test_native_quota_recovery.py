"""Only a witnessed zero-use quota rejection can start a later generation."""
import copy,json,time,unittest
from unittest.mock import Mock
import test_native_configuration_channels as fixtures
from native_bridge_session import ContractError,history_shape,signature
from native_channel_store import read_json,write_json

class QuotaRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ChannelTests();self.f.setUp();self.addCleanup(self.f.tearDown)
        self.body=self.f.body
        with self.f.pool.lease('tenant',self.body)as s:
            history=self.f.completed(s,self.body)
        self.follow={**self.body,'messages':history+[{'role':'user','content':'new question'}]}
        with self.f.pool.lease('tenant',self.follow)as s:
            self.s=s;self.path=s.directory;s.caller_request_sha=signature(history_shape(self.follow['messages']))
            self.log=self.path/'stdout.private.jsonl';self.log.write_text('{"type":"old-private-history"}\n')
            self.offset=self.log.stat().st_size;s.dispatch_process=Mock(poll=lambda:None)
            s.authorize_dispatch();g=read_json(self.path/'dispatch/grant.json');self.grant=g
            self.at=int((time.time()-120)*1000)
            write_json(self.path/'dispatch'/(g['id']+'.consumed.json'),{**g,'at_ms':self.at})
            write_json(self.path/'dispatch/final.safe.json',{'upstream_attempts':2,'denied':0})
            self.events=[{'type':'rate_limit_event','session_id':s.native_id,'rate_limit_info':{'status':'rejected','resetsAt':int(time.time())-60}},
             {'type':'assistant','session_id':s.native_id,'error':'rate_limit','api_error_status':429,'api_error':'usage_limit_reached'},
             {'type':'result','session_id':s.native_id,'is_error':True,'api_error_status':429,'api_error':'usage_limit_reached','terminal_reason':'api_error','modelUsage':{},'total_cost_usd':0,'usage':{k:0 for k in ('input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens')}}]
            self.save_log();s.failed=True;s.dispatch_process=None;s.checkpoint('failed')
        self.claim=self.path/'caller-grants'/(s.caller_request_sha+'.json')

    def save_log(self):
        self.log.write_text('{"type":"old-private-history"}\n'+''.join(json.dumps(e)+'\n'for e in self.events))

    def test_reset_after_proven_rejection_creates_generation_but_keeps_paid_dedup(self):
        claim=read_json(self.claim)
        old={str(p.relative_to(self.path)):p.read_bytes()for p in self.path.rglob('*')if p.is_file()}
        for restart in (False,True):
            if restart:self.f.pool.close();self.f.pool=self.f.new_pool()
            with self.f.pool.lease('tenant',self.follow)as fresh:
                self.assertNotEqual(fresh.directory,self.path)
                self.assertFalse(fresh.failed)
                self.assertEqual(fresh.history,[])
            with self.assertRaisesRegex(ContractError,'already_consumed'):
                with self.f.pool.lease('tenant',{**self.body,'model':'sonnet'}):self.fail('paid replay')
        self.assertEqual(old,{str(p.relative_to(self.path)):p.read_bytes()for p in self.path.rglob('*')if p.is_file()})

    def test_unknown_nonzero_future_or_unbound_rejection_stays_closed(self):
        original=copy.deepcopy(self.events)
        for mutate in (lambda:self.events.pop(),lambda:self.events[-1]['usage'].update(output_tokens=1),
                       lambda:self.events[0]['rate_limit_info'].update(resetsAt=int(time.time())+60),
                       lambda:self.events[-1].update(session_id='wrong'),
                       lambda:self.events.insert(0,{'type':'stream_event','event':{'type':'message_start'}})):
            self.events=copy.deepcopy(original);mutate();self.save_log()
            with self.assertRaises(ContractError):
                with self.f.pool.lease('tenant',self.follow):self.fail('unproved reset')
        self.events=original;self.save_log();c=read_json(self.claim);c.pop('stdout_offset',None);write_json(self.claim,c)
        with self.assertRaises(ContractError):
            with self.f.pool.lease('tenant',self.follow):self.fail('legacy ambiguity')

    def test_unknown_other_claim_and_tenant_cannot_use_rejection(self):
        paid=next(p for p in (self.path/'caller-grants').glob('*.json')if p!=self.claim)
        saved=paid.read_bytes();c=read_json(paid);c['state']='claimed';write_json(paid,c)
        with self.assertRaises(ContractError):
            with self.f.pool.lease('tenant',self.follow):self.fail('unrelated unknown')
        paid.write_bytes(saved)
        with self.f.pool.lease('other-tenant',self.follow)as other:
            self.assertNotEqual(other.directory,self.path)
            self.assertFalse(other.history)
