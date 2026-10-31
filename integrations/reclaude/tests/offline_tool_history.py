"""Unmodified CLI + synthetic loopback provider. No live credentials or provider calls."""
import copy,http.server,json,os,sys,tempfile,threading,time,uuid
from pathlib import Path
sys.path.insert(0,os.environ.get('NATIVE_BRIDGE_DIR',str(Path(__file__).resolve().parents[1])))
from native_bridge_session import Session,ContractError
os.umask(0o077)
root=Path(os.environ.get('NATIVE_COMPAT_OUTPUT',tempfile.mkdtemp(prefix='reclaude-compat-fixture-')))
root.mkdir(parents=True,exist_ok=True); calls=[]; reply=['text']; checks={}
class Fixture(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*a):pass
 def deny(self):
  self.send_response(403);self.send_header('Content-Length','0');self.send_header('Connection','close');self.end_headers();self.close_connection=True
 do_CONNECT=do_GET=do_HEAD=deny
 def do_POST(self):
  if self.path.split('?')[0]!='/v1/messages':return self.deny()
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(body);i=len(calls)
  blocks=[{'type':'tool_use','id':'tool_A_'+str(i),'name':'mcp__caller__Read','input':{'path':'synthetic-A'}},{'type':'tool_use','id':'tool_B_'+str(i),'name':'mcp__caller__Read','input':{'path':'synthetic-B'}}] if reply[0]=='tools' else [{'type':'text','text':''}]
  events=[{'type':'message_start','message':{'id':'msg_'+str(i),'type':'message','role':'assistant','model':body['model'],'content':[],'stop_reason':None,'usage':{'input_tokens':100+i,'output_tokens':0,'cache_read_input_tokens':i,'cache_creation_input_tokens':3*i,'cache_creation':{'ephemeral_5m_input_tokens':i,'ephemeral_1h_input_tokens':2*i}}}}]
  for index,block in enumerate(blocks):
   events.append({'type':'content_block_start','index':index,'content_block':block})
   if block['type']=='text':events.append({'type':'content_block_delta','index':index,'delta':{'type':'text_delta','text':'SYNTHETIC_REPLY_'+str(i)}})
   events.append({'type':'content_block_stop','index':index})
  events += [{'type':'message_delta','delta':{'stop_reason':'tool_use' if reply[0]=='tools' else 'end_turn'},'usage':{'output_tokens':10+i}},{'type':'message_stop'}]
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers();self.close_connection=True
  for e in events:self.wfile.write(('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n').encode());self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)
env={'PATH':os.environ['PATH'],'HOME':str(root/'home'),'CLAUDE_CONFIG_DIR':str(root/'profile'),'ANTHROPIC_BASE_URL':url,'ANTHROPIC_AUTH_TOKEN':'offline-fixture-only','HTTP_PROXY':url,'HTTPS_PROXY':url,'NO_PROXY':'127.0.0.1,localhost,::1','LANG':'C.UTF-8'}
command=[os.environ.get('NATIVE_CLI','/opt/homebrew/bin/claude'),'--setting-sources','']
base={'model':'claude-fable-5-1','max_tokens':1024,'system':'SYNTHETIC_SYSTEM','messages':[{'role':'user','content':'SYNTHETIC_ORIGINAL'}],'tools':[{'name':'Read','input_schema':{'type':'object','properties':{'path':{'type':'string'}}}}]}
sessions=[]
def start(name,body,restore=False):
 s=Session(root/name,command,env,body,timeout=30,restore=restore,history_profile=root/'profile');sessions.append(s);return s
def run(s,body):
 n=len(calls);events=list(s.request(body));assert events[-1]['type']=='message_stop';time.sleep(.1);assert len(calls)==n+1,(n,len(calls))
 i=n+1;usage=next(e['message']['usage'] for e in events if e['type']=='message_start');terminal=next(e['usage'] for e in events if e['type']=='message_delta')
 assert usage=={'input_tokens':100+i,'output_tokens':0,'cache_read_input_tokens':i,'cache_creation_input_tokens':3*i,'cache_creation':{'ephemeral_5m_input_tokens':i,'ephemeral_1h_input_tokens':2*i}},usage
 assert terminal=={'output_tokens':10+i},terminal
 checks['unique_final_and_cache_usage_on_every_turn']=True
 return calls[-1]
def follow(s,**fields):return {**base,**fields,'messages':copy.deepcopy(s.history)+[{'role':'user','content':'SYNTHETIC_FOLLOW'}]}

try:
 # Native caller tools return a structured result, never converted to text.
 t=start('structured',base);reply[0]='tools';run(t,base);pid=t.process.pid;native=t.native_id
 inner=[{'type':'text','text':'RESULT_MARKER'},
  {'type':'tool_reference','tool_name':'Read'},
  {'type':'document','source':{'type':'text','media_type':'text/plain','data':'DOCUMENT_MARKER'}},
  {'type':'search_result','source':'https://example.com/','title':'Synthetic','content':[{'type':'text','text':'SEARCH_MARKER'}]},
  {'type':'image','source':{'type':'base64','media_type':'image/png','data':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII='}}]
 follow_body=follow(t);follow_body['messages'][-1]['content']=[{'type':'tool_result','tool_use_id':i,'content':inner} for i in sorted(t.pending_ids)]
 reply[0]='text';wire=run(t,follow_body)
 actual=[b for m in wire['messages'] if m['role']=='user' for b in (m['content'] if isinstance(m['content'],list) else []) if b['type']=='tool_result']
 checks['structured_results_preserved']=all(any(c['type']==k for b in actual for c in (b['content'] if isinstance(b.get('content'),list) else [])) for k in ['text','image','document','search_result'])
 # The actual CLI resolves the reference into its native tool catalogue.
 checks['tool_reference_resolved_by_native_cli']=any(t['name']=='mcp__caller__Read' for t in wire['tools']) and 'Tool loaded.' in json.dumps(wire['messages'])
 checks['structured_resume_owns_same_session']=t.native_id==native and t.process.pid!=pid
 imported={**base,'messages':[
  {'role':'user','content':'IMPORTED_ORIGINAL_USER'},
  {'role':'assistant','content':[{'type':'tool_use','id':'tool_historical','name':'Read','input':{'path':'external'}}]},
  {'role':'user','content':[{'type':'tool_result','tool_use_id':'tool_historical','content':'HISTORICAL_RESULT'}]},
  {'role':'assistant','content':'IMPORTED_PRIOR_ANSWER'},
  {'role':'user','content':'ONE_NEW_IMPORTED_TURN'}]}
 s=start('imported',imported);before=len(calls);s.prepare_request(imported)
 checks['import_prewarm_has_zero_dispatch']=len(calls)==before
 wire=run(s,imported);native=s.native_id
 checks['import_preserves_role_and_order']=all(marker in json.dumps(wire['messages']) for marker in ['IMPORTED_ORIGINAL_USER','HISTORICAL_RESULT','IMPORTED_PRIOR_ANSWER','ONE_NEW_IMPORTED_TURN'])
 checks['import_maps_only_native_tool_name']=any(b.get('name')=='mcp__caller__Read' for m in wire['messages'] if m['role']=='assistant' for b in m['content'])
 # Close and recover the same native UUID, not an empty replacement session.
 following={**imported,'messages':copy.deepcopy(s.history)+[{'role':'user','content':'AFTER_EVICTION'}]}
 s.close(graceful=True);s=start('imported',following,True);wire=run(s,following)
 checks['imported_history_survives_native_resume']=s.native_id==native and all(x in json.dumps(wire['messages']) for x in ['HISTORICAL_RESULT','SYNTHETIC_REPLY_3','AFTER_EVICTION'])
 other={**base,'messages':[{'role':'user','content':'OTHER_TENANT_ONLY'}]};o=start('other',other);wire=run(o,other)
 checks['other_session_has_no_imported_or_tool_context']=all(x not in json.dumps(wire['messages']) for x in ['IMPORTED_PRIOR_ANSWER','HISTORICAL_RESULT','RESULT_MARKER']) and o.native_id!=native
 before=len(calls)
 try:list(s.request(following))
 except ContractError as exc:checks['paid_turns_never_replayed']='request_already_consumed' in str(exc) and len(calls)==before
 # Initial imported last assistant may be waiting for tool results.
 pending={**base,'messages':imported['messages'][:2]+[{'role':'user','content':[{'type':'tool_result','tool_use_id':'tool_historical','content':inner}]}]}
 z=start('imported-pending',pending);wire=run(z,pending)
 checks['pending_import_only_dispatches_new_result']=len(calls)==6 and 'HISTORICAL_RESULT' not in json.dumps(wire['messages']) and 'RESULT_MARKER' in json.dumps(wire['messages'])
 time.sleep(.3);checks['exactly_six_new_requests']=len(calls)==6
 receipt={'checks':checks,'fixture_calls':len(calls),'real_provider_calls':0,'ok':all(checks.values())}
 (root/'calls.synthetic.json').write_text(json.dumps(calls,indent=2));(root/'receipt.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt));assert receipt['ok']
finally:
 for s in sessions:s.close()
 server.shutdown();server.server_close()
