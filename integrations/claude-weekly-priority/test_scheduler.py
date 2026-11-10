import copy
from pathlib import Path
import tempfile
import unittest
from scheduler import plan, priorities, timestamp
from controller import cycle

NOW = 1794333600
BINDINGS = [{'slot_id': str(i), 'account_id': i, 'initial_priority': 0,
             'expected': {'concurrency': 1, 'groups': [25], 'affinity': ['private']}} for i in [1, 2, 3]]
ACCOUNTS = {b['account_id']: dict(b['expected'], status='active', schedulable=True, priority=0) for b in BINDINGS}
def snapshot(resets):
    return {'captured_at': NOW, 'slots': [{'id': str(i), 'tier': 'pro', 'reset_7d': r} for i,r in enumerate(resets, 1)]}

class ScheduleTests(unittest.TestCase):
    def test_exact_deadline_order(self):
        self.assertEqual(priorities(snapshot([NOW+3602,NOW+3600,NOW+3601]),BINDINGS,NOW),{1:3,2:1,3:2})
    def test_reset_crossing_demotes_without_refresh(self):
        s=snapshot([NOW+1,NOW+200,NOW+300])
        self.assertEqual(priorities(s,BINDINGS,NOW)[1],1)
        self.assertEqual(priorities(s,BINDINGS,NOW+1),{1:39,2:1,3:2})
    def test_confirmed_new_window_last(self):
        self.assertEqual(priorities(snapshot([NOW+604800,NOW+200,NOW+300]),BINDINGS,NOW),{1:3,2:1,3:2})
    def test_unknown_expired_stale_and_bad_clock(self):
        for resets in [[None,'bad',NOW], [NOW+700000,float('inf'),-1]]:
            self.assertEqual(set(priorities(snapshot(resets),BINDINGS,NOW).values()),{39})
        for now in [NOW+91,NOW-6]:
            self.assertEqual(set(priorities(snapshot([NOW+1000]*3),BINDINGS,now).values()),{39})
    def test_equal_deadlines_preserve_native_load_balancing(self):
        self.assertEqual(priorities(snapshot([NOW+100]*3),BINDINGS,NOW),{1:1,2:1,3:1})
    def test_disabled_or_non_pro_not_promoted(self):
        a=copy.deepcopy(ACCOUNTS);a[1]['schedulable']=False;a[2]['status']='error'
        s=snapshot([NOW+10]*3);s['slots'][2]['tier']='max'
        p=plan(s,a,BINDINGS,{},NOW)
        self.assertEqual(p['changes'],[])
        self.assertEqual(len(p['skipped']),3)
    def test_mapping_scope_change_and_manual_priority_respected(self):
        for field,value in [('concurrency',10),('groups',[5]),('affinity',[]),('priority',8)]:
            a=copy.deepcopy(ACCOUNTS);a[1][field]=value
            self.assertNotIn(1,[c['account_id']for c in plan(snapshot([NOW+10]*3),a,BINDINGS,{},NOW)['changes']])
    def test_unknown_account_never_mutated_and_input_immutable(self):
        a=copy.deepcopy(ACCOUNTS);a[9]=dict(a[1]);before=copy.deepcopy(a)
        p=plan(snapshot([NOW+10]*3),a,BINDINGS,{},NOW)
        self.assertNotIn(9,p['desired']);self.assertEqual(a,before)
    def test_timeout_read_after_write_claim(self):
        own={'1':{'before':0,'after':1}}
        a=copy.deepcopy(ACCOUNTS);a[1]['priority']=1
        self.assertNotIn(1,[c['account_id']for c in plan(snapshot([NOW+10]*3),a,BINDINGS,own,NOW)['changes']])
    def test_timestamp_formats(self):
        for value in [NOW,str(NOW),NOW*1000,'2026-11-10T18:00:00Z']:
            self.assertEqual(timestamp(value),NOW)
        self.assertIsNone(timestamp(True))
    def test_duplicate_rejected(self):
        s=snapshot([NOW+1]);s['slots']*=2
        with self.assertRaises(ValueError):priorities(s,BINDINGS,NOW)
    def test_transport_failure_still_demotes_due_reset(self):
        class Adapter:
            def snapshot(self):raise TimeoutError()
            def accounts(self):return copy.deepcopy(ACCOUNTS)
            def set_priority(self,aid,before,after):calls.append((aid,before,after))
        calls=[];state={'snapshot':snapshot([NOW,NOW+20,NOW+30])}
        with tempfile.TemporaryDirectory() as d:cycle(Adapter(),{'bindings':BINDINGS},state,Path(d)/'state.json',NOW)
        self.assertIn((1,0,39),calls)

    def test_manual_restore_of_original_priority_is_respected_after_commit(self):
        class Adapter:
            def snapshot(self):return snapshot([NOW+10]*3)
            def accounts(self):return copy.deepcopy(accounts)
            def set_priority(self,aid,before,after):
                calls.append(aid)
                accounts[aid]['priority']=after
        calls=[];accounts=copy.deepcopy(ACCOUNTS);state={}
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'state.json'
            cycle(Adapter(),{'bindings':BINDINGS},state,path,NOW)
            self.assertEqual(state['ownership']['1']['before'],1)
            accounts[1]['priority']=0;calls.clear()
            cycle(Adapter(),{'bindings':BINDINGS},state,path,NOW)
        self.assertEqual(calls,[])
        self.assertIn({'account_id':1,'reason':'priority_manually_changed'},state['result']['skipped'])

    def test_uncertain_success_is_committed_after_readback(self):
        class Adapter:
            def snapshot(self):return snapshot([NOW+10]*3)
            def accounts(self):return {aid:{**a,'priority':1}for aid,a in ACCOUNTS.items()}
            def set_priority(self,*args):self.fail('unexpected_write')
        state={'ownership':{str(i):{'before':0,'after':1}for i in [1,2,3]}}
        with tempfile.TemporaryDirectory() as d:
            cycle(Adapter(),{'bindings':BINDINGS},state,Path(d)/'state.json',NOW)
        self.assertTrue(all(c['before']==c['after']==1 for c in state['ownership'].values()))

if __name__ == '__main__':unittest.main()
