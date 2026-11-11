"""Experimental PTY driver. Provider SSE, never terminal text, carries usage."""
import copy
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import struct
import subprocess
import sys
import termios
import threading
import time

import native_bridge_session as native


def prompt_text(blocks):
    if not blocks or any(b.get('type') != 'text' for b in blocks):
        raise native.ContractError('interactive_prompt_requires_text')
    text = '\n'.join(b['text'] for b in blocks)
    if (not text.strip() or len(text.encode()) > 1024 * 1024
            or any(ord(c) < 32 and c not in '\n\t' for c in text)):
        raise native.ContractError('interactive_prompt_invalid')
    return text


class TerminalInput:
    def __init__(self, master):
        self.master, self.closed = master, False

    def write(self, raw):
        record = json.loads(raw)
        if record.get('type') != 'user' or record.get('message', {}).get('role') != 'user':
            raise native.ContractError('interactive_control_not_supported')
        text = prompt_text(record['message']['content'])
        # Bracketed paste prevents embedded newlines from becoming extra turns.
        payload = b'\x1b[200~' + text.encode() + b'\x1b[201~'
        while payload:
            payload = payload[os.write(self.master, payload):]
        time.sleep(.05)
        os.write(self.master, b'\r')

    def flush(self):
        pass

    def close(self):
        self.closed = True


def hook(directory):
    event = json.load(sys.stdin)
    if event.get('hook_event_name') not in {'SessionStart', 'Stop'}:
        return
    value = {k:event[k] for k in ('session_id','hook_event_name','transcript_path') if k in event}
    target = Path(directory) / ('interactive-' + event['hook_event_name'] + '.json')
    tmp = target.with_suffix('.tmp')
    with tmp.open('w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, target)


class InteractiveSession(native.Session):
    def __init__(self, *args, **kwargs):
        self.master = None
        self.ui_ready = threading.Event()
        self.read_stop = threading.Event()
        super().__init__(*args, **kwargs)
        if not self.api_base or self.require_policy:
            raise native.ContractError('interactive_api_provider_only')

    def request(self, body):
        # No semantic coercion of images or resumed tool results into terminal text.
        # This driver remains opt-in until those cases have their own acceptance.
        changed = native.signature(native.configuration(body)) != self.body_signature
        tail = native.native_blocks(next(m for m in reversed(body['messages']) if m['role']=='user')['content'])
        tool_results = any(b.get('type') == 'tool_result' for b in tail)
        if not tool_results:
            prompt_text(tail)
        elif (not self.pending_ids or self.suspended or changed
              or any(b.get('type') != 'tool_result' for b in tail)):
            raise native.RequestRejected('interactive_resume_tool_results_not_supported')
        if native.output_format(body) is not None:
            raise native.RequestRejected('interactive_structured_output_not_supported')
        yield from super().request(body)

    def prepare(self):
        if self.process is not None:
            if self.process.poll() is not None or self.failed:
                raise native.ContractError('native_process_not_reusable')
            return
        (self.directory/'interactive-mcp-ready.json').unlink(missing_ok=True)
        (self.directory/'interactive-mcp-required').touch(mode=0o600)
        self.start_dispatch_proxy()
        module = str(Path(__file__).resolve())
        context = shlex.join([sys.executable, str(Path(native.__file__).resolve()), '--context-hook', str(self.directory)])
        lifecycle = shlex.join([sys.executable, module, '--hook', str(self.directory)])
        settings = {'hooks':{
            **{e:[{'hooks':[{'type':'command','command':context}]}] for e in ('PostToolBatch','UserPromptSubmit')},
            **{e:[{'hooks':[{'type':'command','command':lifecycle}]}] for e in ('SessionStart','Stop')}},
            'env':{'ANTHROPIC_BASE_URL':self.dispatch_address}}
        mcp = {'mcpServers':{'caller':{'command':sys.executable,
               'args':[str(Path(native.__file__).resolve()),'--mcp',str(self.directory)]}}}
        argv = [*self.command, '--settings',json.dumps(settings),'--strict-mcp-config',
                '--mcp-config',json.dumps(mcp),'--tools','', '--allowedTools',
                *['mcp__caller__'+t['name'] for t in self.tools],
                '--system-prompt-file',str(self.directory/'system.txt'),
                '--system-prompt-snapshot','off','--permission-mode','manual','--model',self.model,
                '--disable-slash-commands','--no-chrome','--debug-file',str(self.directory/'interactive-debug.private.log'),
                *(['--resume',self.native_id,'--resume-session-at',self.resume_uuid]
                  if self.resume_uuid else ['--session-id',self.native_id]), *self.options]
        if any(x in argv for x in ('-p','--print','--input-format','--output-format')):
            raise native.ContractError('interactive_driver_forbids_print_mode')
        self.native_cli_argv = argv
        env = {**self.environment,'TERM':'xterm-256color','COLORTERM':'truecolor'}
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',40,120,0,0))
        self.read_stop.clear()
        self.ui_ready.clear()
        for event in ('SessionStart','Stop'):
            (self.directory/f'interactive-{event}.json').unlink(missing_ok=True)
        try:
            self.process = subprocess.Popen(argv,cwd=self.directory,env=env,stdin=slave,
                                            stdout=slave,stderr=slave,start_new_session=True)
        finally:
            os.close(slave)
        self.process.stdin = TerminalInput(self.master)
        self.reader = threading.Thread(target=self.read_output,daemon=True)
        self.reader.start()
        if not self.ui_ready.wait(min(30,self.timeout)):
            self.close()
            raise native.ContractError('interactive_not_ready_no_dispatch')

    def initialize_native(self):
        if not self.ui_ready.is_set():
            raise native.ContractError('interactive_not_ready_no_dispatch')

    def authorize_dispatch(self):
        (self.directory/'interactive-Stop.json').unlink(missing_ok=True)
        super().authorize_dispatch()

    def transcript(self):
        for kind in ('SessionStart','Stop'):
            path=self.directory/f'interactive-{kind}.json'
            try:
                value=json.loads(path.read_text())
            except (OSError,ValueError):
                continue
            if value.get('session_id') != self.native_id:
                raise native.ContractError('interactive_session_mismatch')
            transcript=Path(value['transcript_path']).resolve()
            if self.history_profile.resolve() not in transcript.parents:
                raise native.ContractError('interactive_transcript_outside_profile')
            return transcript
        return None

    def native_assistants(self):
        path=self.transcript()
        if not path or not path.exists():
            return
        with path.open() as stream:
            for line in stream:
                try:event=json.loads(line)
                except ValueError:continue
                if event.get('sessionId') != self.native_id or event.get('type') != 'assistant':
                    continue
                message=event.get('message',{})
                if message.get('id') and event.get('uuid'):
                    with self.assistant_ready:
                        self.assistants[message['id']]=event['uuid']
                        self.last_native_message_id=message['id']
                        self.assistant_ready.notify_all()
        stop=self.directory/'interactive-Stop.json'
        if stop.exists() and self.last_native_message_id:
            with self.control_ready:
                self.result={'is_error':False,'source':'interactive_stop_hook'}
                self.result_message_id=self.last_native_message_id
                self.control_ready.notify_all()

    def read_output(self):
        offsets, buffers, completed = {}, {}, set()
        terminal_tail=''
        answered=set()
        cues=[('DetectedacustomAPIkey',b'\x1b[A\r'),('Choosethetextstyle',b'\r'),
              ('Securitynotes:',b'\r'),('Accessingworkspace:',b'\x1b[B\r')]
        try:
            while not self.read_stop.is_set() and self.process.poll() is None:
                if select.select([self.master],[],[],.04)[0]:
                    raw=os.read(self.master,65536)
                    with (self.directory/'interactive-terminal.private.log').open('ab') as log:
                        log.write(raw)
                    terminal_tail=(terminal_tail+raw.decode('utf8','replace'))[-16384:]
                    plain=re.sub(r'\x1b\[[0-9;?<>]*[ -/]*[@-~]','',terminal_tail)
                    compact=re.sub(r'\s+','',plain)
                    for cue,answer in cues:
                        if cue in compact and cue not in answered:
                            answered.add(cue)
                            time.sleep(.3)
                            if answer != b'\r':
                                os.write(self.master,answer[:-1])
                                time.sleep(.2)
                            os.write(self.master,b'\r')
                            terminal_tail=''
                            break
                if (self.directory/'interactive-SessionStart.json').exists() and (not self.tools or (self.directory/'interactive-mcp-ready.json').exists()):
                    self.ui_ready.set()
                self.native_assistants()
                grant=self.last_grant_id
                if not grant or grant in completed:
                    continue
                path=self.directory/'dispatch'/f'{grant}.api-stream.private'
                final=path.with_name(f'{grant}.api-terminal.json')
                if not path.exists():
                    continue
                with path.open('rb') as stream:
                    stream.seek(offsets.get(grant,0));data=stream.read(1024*1024)
                    offsets[grant]=stream.tell()
                buffer=buffers.get(grant,b'')+data
                while b'\n\n' in buffer:
                    frame,rest=buffer.split(b'\n\n',1)
                    payload=b'\n'.join(l[5:].lstrip() for l in frame.splitlines() if l.startswith(b'data:'))
                    if not payload:
                        buffer=rest;continue
                    event=json.loads(payload)
                    if event.get('type')=='message_stop':
                        if not final.exists():break
                        finish=json.loads(final.read_text())
                        if not finish.get('complete') or finish.get('grant_id')!=grant:
                            raise native.ContractError('interactive_stream_incomplete_no_replay')
                        completed.add(grant)
                    self.events.put(event)
                    buffer=rest
                buffers[grant]=buffer
                if len(buffer)>2*1024*1024:
                    raise native.ContractError('interactive_event_too_large')
                if final.exists() and grant not in completed:
                    finish=json.loads(final.read_text())
                    if finish.get('status')!=200 or not finish.get('complete'):
                        raise native.ContractError('interactive_upstream_error_no_replay')
        except Exception as exc:
            self.events.put(exc if isinstance(exc,native.ContractError) else native.ContractError('interactive_reader_failed'))
        finally:
            self.events.put(None)

    def _close(self, graceful=False):
        self.read_stop.set()
        super()._close(graceful)
        if self.master is not None:
            os.close(self.master)
            self.master=None


if __name__=='__main__' and len(sys.argv)==3 and sys.argv[1]=='--hook':
    hook(sys.argv[2])
