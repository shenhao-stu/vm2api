"""Captured event shape only; the child is local and cannot call a provider."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from native_bridge_session import ContractError, NativeRateLimit, Session


CHILD = r'''
import json, sys
for line in sys.stdin:
    data = json.loads(line)
    if data['type'] == 'control_request':
        print(json.dumps({'type':'control_response','response':{
            'subtype':'success','request_id':data['request_id'],'response':{}}}), flush=True)
    else:
        print(json.dumps({'type':'rate_limit_event','rate_limit_info':{
            'status':'rejected','resetsAt':1793815200,'rateLimitType':'seven_day'}}), flush=True)
        print(json.dumps({'type':'assistant','error':'rate_limit','is_api_error_message':True}), flush=True)
        print(json.dumps({'type':'result','is_error':True}), flush=True)
'''


class NativeRateLimitTests(unittest.TestCase):
    def test_only_native_rejection_has_a_validated_reset(self):
        for info in [None, {}, {'status':'allowed','resetsAt':1793815200},
                     {'status':'rejected','resetsAt':True,'rateLimitType':'unsafe text'},
                     {'status':'rejected','resetsAt':-1},
                     {'status':'rejected','resetsAt':'1793815200'}]:
            with self.subTest(info=info):
                error = NativeRateLimit('model', info)
                self.assertEqual(error.details, {'upstream_type':'rate_limit_error','model':'model'})

    def test_quota_error_retains_late_native_terminal_before_closing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / 'fixture.py'
            child.write_text(CHILD.replace("import json, sys", "import json, sys, time").replace(
                "print(json.dumps({'type':'result'", "time.sleep(.15)\n        print(json.dumps({'type':'result'"))
            body = {'model':'claude-sonnet-5-5', 'max_tokens':16,
                    'messages':[{'role':'user','content':'fresh fixture'}]}
            session = Session(root/'session', [sys.executable,str(child)],
                              {'PATH':os.environ['PATH']}, body, timeout=3)
            try:
                with self.assertRaises(NativeRateLimit):
                    list(session.request(body))
                events=[json.loads(line) for line in (session.directory/'stdout.private.jsonl').read_text().splitlines()]
                self.assertTrue(any(e.get('type')=='result' for e in events))
                self.assertTrue(session.failed, 'unproved minimal result is still not recoverable')
            finally:
                session.close()

    def test_native_weekly_limit_keeps_model_and_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / 'fixture.py'
            child.write_text(CHILD)
            body = {'model':'claude-sonnet-5-5', 'max_tokens':16, 'tools':[],
                    'messages':[{'role':'user','content':'fresh fixture'}]}
            session = Session(root / 'session', [sys.executable, str(child)],
                              {'PATH':os.environ['PATH']}, body, timeout=3)
            try:
                with self.assertRaises(ContractError) as caught:
                    list(session.request(body))
                self.assertEqual(str(caught.exception), 'native_rate_limit')
                self.assertEqual(caught.exception.details, {
                    'upstream_type':'rate_limit_error', 'model':'claude-sonnet-5-5',
                    'rate_limit_type':'seven_day', 'reset_at':1793815200})
                self.assertTrue(session.failed)
            finally:
                session.close()
