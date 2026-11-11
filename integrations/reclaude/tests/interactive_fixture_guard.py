#!/usr/bin/env python3
"""Offline fake provider; synthetic numbers must never enter a customer ledger."""
import argparse,http.server,json,os,pathlib,signal,sys,threading,uuid
p=argparse.ArgumentParser();p.add_argument('--directory',type=pathlib.Path);p.add_argument('--session');p.add_argument('--listen');p.add_argument('--api-base');a=p.parse_args()
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  b=json.dumps({'upstream_attempts':len(list(a.directory.glob('*.consumed.json'))),'denied':0}).encode();self.send_response(200);self.end_headers();self.wfile.write(b)
 def do_POST(self):
  raw=self.rfile.read(int(self.headers['Content-Length']));body=json.loads(raw)
  try:
   g=json.loads((a.directory/'grant.json').read_text());assert json.loads(body['metadata']['user_id'])['session_id']==a.session
   assert g['model']==body['model']
   assert any(t.get('name')=='mcp__caller__echo'for t in body.get('tools',[])), 'caller tools absent'
   with (a.directory/(g['id']+'.consumed.json')).open('x')as f:json.dump(g,f)
  except Exception:self.send_error(400);return
  (a.directory/(g['id']+'.request.private.json')).write_bytes(raw)
  tool=not any(m['role']=='assistant' for m in body['messages'])
  mid='msg_'+uuid.uuid4().hex
  events=[{'type':'message_start','message':{'id':mid,'type':'message','role':'assistant','model':body['model'],'content':[],'stop_reason':None,'usage':{'input_tokens':10,'output_tokens':0,'cache_creation_input_tokens':0,'cache_read_input_tokens':0}}},
   {'type':'content_block_start','index':0,'content_block':{'type':'tool_use','id':'toolu_fixture','name':'mcp__caller__echo','input':{}} if tool else {'type':'text','text':''}},
   {'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':'{"text":"SYNTHETIC"}'} if tool else {'type':'text_delta','text':'INTERACTIVE_OK'}},
   {'type':'content_block_stop','index':0},
   {'type':'message_delta','delta':{'stop_reason':'tool_use' if tool else 'end_turn','stop_sequence':None},'usage':{'output_tokens':5}},
   {'type':'message_stop'}]
  data=b''.join(('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n').encode() for e in events)
  with(a.directory/(g['id']+'.api-stream.private')).open('xb')as f:f.write(data);f.flush();os.fsync(f.fileno())
  (a.directory/(g['id']+'.api-terminal.json')).write_text(json.dumps({'grant_id':g['id'],'status':200,'complete':True}))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers();self.wfile.write(data);self.wfile.flush();self.close_connection=True
s=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);print(json.dumps({'listen':'127.0.0.1:'+str(s.server_port),'session_id':a.session}),flush=True)
s.serve_forever()
