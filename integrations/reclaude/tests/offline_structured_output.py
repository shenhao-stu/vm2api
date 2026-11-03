"""Genuine CLI against a synthetic one-dispatch provider; no live model requests."""
import copy, http.server, json, os, sys, tempfile, threading, time
from pathlib import Path
sys.path.insert(0, os.environ.get('NATIVE_BRIDGE_DIR', str(Path(__file__).resolve().parents[1])))
from native_bridge_session import Session, ContractError
os.umask(0o077)
root = Path(os.environ.get('NATIVE_COMPAT_OUTPUT', tempfile.mkdtemp(prefix='native-structured-')))
root.mkdir(parents=True, exist_ok=True)
calls, blocked, sessions, checks = [], [], [], {}
mode, allowance = ['structured'], [0]
schema = {'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok'],'additionalProperties':False}
class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def deny(self):
        self.send_response(409);self.send_header('Content-Length','0');self.end_headers()
    do_GET=do_CONNECT=do_HEAD=deny
    def do_POST(self):
        if self.path.split('?')[0]!='/v1/messages':return self.deny()
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if allowance[0] == 0:
            blocked.append({'mode':mode[0]});return self.deny()
        allowance[0]-=1;calls.append(body);i=len(calls)
        tool = mode[0] in ('structured','bad_schema','caller_tool')
        name = 'mcp__caller__StructuredOutput' if mode[0]=='caller_tool' else 'StructuredOutput'
        value={'ok':'invalid'} if mode[0]=='bad_schema' else {'ok':True}
        block={'type':'tool_use','id':'fixture_tool_'+str(i),'name':name,'input':{}} if tool else {'type':'text','text':''}
        delta={'type':'input_json_delta','partial_json':json.dumps(value)} if tool else {'type':'text_delta','text':'{"ok":true}'}
        events=[{'type':'message_start','message':{'id':'msg_schema_'+str(i),'type':'message','role':'assistant','model':body['model'],'content':[],'stop_reason':None,'usage':{'input_tokens':100+i,'output_tokens':0,'cache_read_input_tokens':i,'cache_creation_input_tokens':3*i,'cache_creation':{'ephemeral_5m_input_tokens':i,'ephemeral_1h_input_tokens':2*i}}}}, {'type':'content_block_start','index':0,'content_block':block},{'type':'content_block_delta','index':0,'delta':delta},{'type':'content_block_stop','index':0},{'type':'message_delta','delta':{'stop_reason':'tool_use' if tool else 'end_turn'},'usage':{'output_tokens':10+i}},{'type':'message_stop'}]
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers();self.close_connection=True
        for e in events:self.wfile.write(('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n').encode());self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)
env={'PATH':os.environ['PATH'],'HOME':str(root/'home'),'CLAUDE_CONFIG_DIR':str(root/'profile'),'ANTHROPIC_BASE_URL':url,'ANTHROPIC_AUTH_TOKEN':'offline-fixture-only','HTTP_PROXY':url,'HTTPS_PROXY':url,'NO_PROXY':'127.0.0.1,localhost,::1','LANG':'C.UTF-8'}
command=[os.environ.get('NATIVE_CLI','/opt/homebrew/bin/claude'),'--setting-sources','']
base={'model':'claude-opus-5-5','max_tokens':128,'system':'SYNTHETIC_ONLY','messages':[{'role':'user','content':'Return the synthetic object.'}], 'output_config':{'format':{'type':'json_schema','schema':schema}}}
def start(name,body,restore=False):
    s=Session(root/name,command,env,body,timeout=20,restore=restore,history_profile=root/'profile');sessions.append(s);return s
def run(s,body,reply='structured',fail=False):
    mode[0]=reply;allowance[0]=1;before=len(calls);events=[];error=None;grants=[]
    original=s.authorize_dispatch
    def grant():grants.append(True);original()
    s.authorize_dispatch=grant
    try:
        for event in s.request(body):events.append(event)
    except ContractError as exc:error=str(exc)
    finally:s.authorize_dispatch=original
    assert len(calls)==before+1 and len(grants)==1,(len(calls),before,grants,error)
    i=len(calls);usage=next(e['message']['usage']for e in events if e['type']=='message_start')
    terminal=next(e['usage']for e in reversed(events)if e['type']=='message_delta')
    assert usage['input_tokens']==100+i and usage['cache_creation_input_tokens']==3*i
    assert terminal['output_tokens']==10+i
    assert (error is not None)==fail,error
    if not fail:assert events[-1]['type']=='message_stop'
    else:assert events[-1]['type']=='message_delta' and not any(e['type']=='content_block_delta' for e in events)
    checks['single_dispatch_and_final_usage_on_all_cases']=True
    return events,error
try:
    for streaming in (False,True):
        b={**base,'stream':streaming};s=start('stream-'+str(streaming),b);events,_=run(s,b)
        text=''.join(e.get('delta',{}).get('text','')for e in events)
        assert json.loads(text)=={'ok':True}
        checks['native_schema_'+str(streaming)]=s.result['structured_output']=={'ok':True} and calls[-1].get('output_config',{}).get('format') is None
        assert next(t for t in calls[-1]['tools']if t['name']=='StructuredOutput')['input_schema']==schema
        state=json.loads((s.directory/'continuation.json').read_text());assert state['version']==3 and state['structured_output'] is True
        checks['v3_marks_only_validated_projection']=True
    # Per-turn schema changes keep the exact caller prefix and create a new
    # native segment after projection; no old assistant is dispatched again.
    original = s.native_id
    changed_schema = {**schema, 'description': 'The next synthetic response.'}
    changed = {**base, 'messages': copy.deepcopy(s.history) + [{'role': 'user', 'content': 'Use the updated schema.'}], 'output_config': {'format': {'type':'json_schema','schema':changed_schema}}}
    run(s, changed)
    assert s.native_id != original
    assert next(t for t in calls[-1]['tools'] if t['name']=='StructuredOutput')['input_schema'] == changed_schema
    checks['change_schema_imports_only_owned_context']=True
    original=s.native_id
    follow={**base,'messages':copy.deepcopy(s.history)+[{'role':'user','content':'Continue without a schema.'}]};follow.pop('output_config')
    s.close(graceful=True);s=start('stream-True',follow,True);run(s,follow,'text')
    assert s.native_id!=original and '{"ok":true}' in json.dumps(calls[-1]['messages']).replace('\\"','"')
    assert json.loads((s.directory/'continuation.json').read_text())['version']==2
    checks['remove_schema_imports_owned_history_no_replay']=True
    for reply in ('text','bad_schema'):
        s=start('fail-'+reply,base);events,error=run(s,base,reply,True)
        assert s.failed and not s.structured_checkpoint
        checks['reject_'+reply+'_without_additional_grant']=True
    # Caller tool named StructuredOutput is still MCP namespaced and returned as a tool.
    b={**base,'tools':[{'name':'StructuredOutput','input_schema':schema}]};s=start('same-name',b);events,_=run(s,b,'caller_tool')
    assert any(e.get('content_block',{}).get('type')=='tool_use'for e in events)
    assert s.pending_ids and not s.structured_checkpoint
    checks['caller_tool_not_consumed_as_private_schema_tool']=True
    follow = {**b, 'messages': copy.deepcopy(s.history)+[{'role':'user','content':[{'type':'tool_result','tool_use_id':next(iter(s.pending_ids)),'content':'SYNTHETIC_TOOL_RESULT'}]}]}
    run(s, follow)
    assert s.structured_checkpoint and not s.pending_ids
    assert 'SYNTHETIC_TOOL_RESULT' in json.dumps(calls[-1]['messages'])
    checks['same_name_caller_tool_result_reaches_native_then_schema_validates']=True
    invalid = {**base,'output_config':{'format':{'type':'json_schema','schema':{'type':'not_a_type'}}}}
    bad=start('invalid-schema',invalid);before=len(calls);allowance[0]=1
    try:
        list(bad.request(invalid))
        raise AssertionError('invalid schema accepted')
    except ContractError:
        pass
    assert len(calls)==before
    checks['native_invalid_schema_rejected_before_provider_dispatch']=True
    other=start('other',{**base,'messages':[{'role':'user','content':'OTHER_OWNER_ONLY'}]});run(other,{**base,'messages':[{'role':'user','content':'OTHER_OWNER_ONLY'}]})
    assert 'Continue without a schema.'not in json.dumps(calls[-1]['messages'])
    checks['schema_session_isolation']=True
    receipt={'ok':all(checks.values()),'checks':checks,'fixture_calls':len(calls),'blocked_extra_attempts':len(blocked),'provider_calls':0}
    (root/'calls.synthetic.json').write_text(json.dumps(calls,indent=2));(root/'receipt.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
finally:
    for s in sessions:s.close()
    server.shutdown();server.server_close()
