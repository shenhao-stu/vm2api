import contextlib
import gzip
import http.client
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('adapter', Path(__file__).parents[1] / 'adapter.py')
a = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = a
SPEC.loader.exec_module(a)
KEY = 'test-only-' + 'a' * 40
BODY = {'model': 'claude-sonnet-4-6', 'max_tokens': 32, 'stream': True,
        'messages': [{'role': 'user', 'content': 'private prompt'}]}

def event(value):
    return b'data: ' + json.dumps(value).encode() + b'\n\n'

COMPLETE = event({'type': 'message_start', 'message': {'usage': {'input_tokens': 7}}}) + event({
    'type': 'message_delta', 'usage': {'output_tokens': 3}, 'delta': {'stop_reason': 'end_turn'}}) + event({'type': 'message_stop'})

class Connection:
    def __init__(self, sock=None):
        self.relay_socket = sock
        self.closed = False
    def close(self):
        self.closed = True
        if self.relay_socket:
            self.relay_socket.close()

class Response:
    def __init__(self, chunks=(COMPLETE,), status=200, content_type='text/event-stream', sock=None, encoding=None):
        self.chunks = iter(chunks)
        self.status = status
        self.content_type = content_type
        self.sock = sock
        self.closed = False
        self.encoding = encoding
    def getheaders(self):
        return ([('content-encoding', self.encoding)] if self.encoding else []) + [('content-type', self.content_type), ('request-id', 'req_actual_fixture'),
                ('content-length', '999'), ('connection', 'keep-alive, x-hop'), ('x-hop', 'private'), ('set-cookie', 'private')]
    def getheader(self, name, default=None):
        return dict(self.getheaders()).get(name.lower(), default)
    def read1(self, size):
        return self.sock.recv(size) if self.sock else next(self.chunks, b'')
    def close(self):
        self.closed = True

class Relay:
    def __init__(self, response=None, sock=None, error=None):
        self.response = response or Response()
        self.connection = Connection(sock)
        self.calls = []
        self.error = error
    def failed_health_checks(self):
        return []
    def authorization_revoked(self):
        return False
    def open_upstream(self, *args, **_kwargs):
        self.calls.append(args)
        if self.error:
            raise self.error
        return self.connection, self.response

class Server(a.RelayServer):
    def __init__(self, *args, **kwargs):
        self.records = []
        self.completed = threading.Event()
        super().__init__(*args, **kwargs)
    def audit(self, record):
        super().audit(record)
        self.records.append(record)
        self.completed.set()

@contextlib.contextmanager
def serve(relay=None, **kwargs):
    server = Server(('127.0.0.1', 0), relay or Relay(), KEY, **kwargs)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)

def post(server, body=BODY, path='/v1/messages', headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
    payload = json.dumps(body).encode() if not isinstance(body, bytes) else body
    values = {'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
    values.update(headers or {})
    connection.request('POST', path, body=payload, headers=values)
    response = connection.getresponse()
    data = response.read()
    result = response.status, dict(response.getheaders()), data
    connection.close()
    return result

class AdapterTests(unittest.TestCase):
    def test_health_persists_native_revocation_without_model_dispatch(self):
        relay = Relay()
        with tempfile.TemporaryDirectory() as directory:
            latch = Path(directory) / 'auth-latch.json'
            with serve(relay, latch_file=latch) as server:
                for failed in [['native_state_unavailable'], ['native_device_revoked'], []]:
                    with patch.object(relay, 'failed_health_checks', return_value=failed):
                        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                        connection.request('GET', '/healthz')
                        response = connection.getresponse()
                        health = json.loads(response.read())
                        connection.close()
                    self.assertEqual(response.status, 503)
                    if failed == ['native_state_unavailable']:
                        self.assertFalse(latch.exists())
                    else:
                        self.assertTrue(latch.exists())
                        self.assertIn('authentication_latched', health['failed'])
                self.assertEqual(relay.calls, [])
            with serve(relay, latch_file=latch) as restarted:
                self.assertEqual(post(restarted)[0], 503)
                self.assertEqual(relay.calls, [])

    def test_client_policy_rejects_sdk_before_dispatch_without_latching(self):
        limits = a.Limits(claude_code_only=True)
        with serve(limits=limits) as s:
            for headers in [{}, {'User-Agent': 'anthropic-python/0.72', 'x-app': 'cli'},
                            {'User-Agent': 'claude-cli/2.1.304 (external, sdk-cli)'},
                            {'User-Agent': 'claude-cli/2.1.304', 'x-app': 'web'}]:
                with self.subTest(headers=headers):
                    status, _, body = post(s, headers=headers)
                    self.assertEqual(status, 400)
                    self.assertEqual(json.loads(body)['error']['code'], 'unsupported_client')
            self.assertEqual(s.relay.calls, [])
            self.assertFalse(s.latched)
            self.assertTrue(s.completed.wait(1))
            self.assertTrue(all(r['attempts'] == 0 for r in s.records))

    def test_client_policy_preserves_actual_cli_headers_without_fabricating_signals(self):
        limits = a.Limits(claude_code_only=True)
        headers = {'User-Agent': 'claude-cli/2.1.304 (external, sdk-cli)', 'x-app': 'cli'}
        with serve(limits=limits) as s:
            self.assertEqual(post(s, headers=headers)[0], 200)
            self.assertEqual(len(s.relay.calls), 1)
            forwarded = {k.lower(): v for k, v in s.relay.calls[0][2].items()}
            self.assertEqual(forwarded['user-agent'], headers['User-Agent'])
            self.assertEqual(forwarded['x-app'], headers['x-app'])
            self.assertNotIn('x-client-request-id', forwarded)
            self.assertNotIn('x-cc-atis', forwarded)

    def test_client_policy_rejects_ambiguous_headers(self):
        headers = http.client.HTTPMessage()
        headers['User-Agent'] = 'claude-cli/2.1.304'
        headers['x-app'] = 'cli'
        headers['X-App'] = 'cli'
        with self.assertRaises(a.Rejection) as raised:
            a.validate_client(headers)
        self.assertEqual(raised.exception.code, 'unsupported_client')

    def test_gzip_split_stream_is_decoded_before_validation_and_forwarding(self):
        compressed = gzip.compress(COMPLETE)
        chunks = [compressed[i:i+7] for i in range(0, len(compressed), 7)]
        with serve(Relay(Response(chunks, encoding='gzip'))) as s:
            status, headers, data = post(s)
            self.assertTrue(s.completed.wait(1))
            self.assertEqual(status, 200); self.assertEqual(data, COMPLETE)
            self.assertNotIn('content-encoding', headers)
            self.assertTrue(s.records[0]['complete'])
            self.assertEqual(s.records[0]['usage'], {'input_tokens': 7, 'output_tokens': 3})
            self.assertEqual(s.records[0]['response_bytes'], len(COMPLETE))
            self.assertEqual(len(s.relay.calls), 1)

    def test_compressed_error_is_observed_and_latches_authorization(self):
        raw = b'{"error":{"type":"device_revoked"}}'
        with serve(Relay(Response([gzip.compress(raw)], status=403, content_type='application/json', encoding='gzip'))) as s:
            self.assertEqual(post(s)[2], raw)
            self.assertTrue(s.completed.wait(1)); self.assertTrue(s.latched)
            self.assertEqual(post(s)[0], 503)
            self.assertEqual(len(s.relay.calls), 1)

    def test_compression_expansion_is_bounded_by_decoded_size(self):
        with serve(Relay(Response([gzip.compress(b'x'*100000)], encoding='gzip')), limits=a.Limits(response_bytes=1024)) as s:
            _, _, data = post(s)
            self.assertTrue(s.completed.wait(1))
            self.assertLess(len(data), 2048)
            self.assertEqual(s.records[0]['error'], 'upstream_response_too_large')
            self.assertFalse(s.records[0]['complete'])

    def test_truncated_or_unsupported_compression_never_reports_success(self):
        truncated = gzip.compress(event({'type': 'message_start'}))[:-6]
        with serve(Relay(Response([truncated], encoding='gzip'))) as s:
            _, _, data = post(s)
            self.assertTrue(s.completed.wait(1))
            self.assertIn(b'upstream_compression_incomplete', data)
            self.assertFalse(s.records[0]['complete'])
        with serve(Relay(Response([b'unsupported'], encoding='br'))) as s:
            self.assertEqual(post(s)[0], 502)
            self.assertTrue(s.completed.wait(1))
            self.assertEqual(s.records[0]['error'], 'upstream_encoding_unsupported')

    def test_only_empty_authorized_account_is_completed(self):
        identity = {'device_id': 'caller-device', 'account_uuid': '', 'session_id': 'caller-session'}
        body = json.dumps({'metadata': {'user_id': json.dumps(identity)}}).encode()
        result = json.loads(a.complete_account_uuid(body, 'authorized-account'))
        identity['account_uuid'] = 'authorized-account'
        self.assertEqual(json.loads(result['metadata']['user_id']), identity)
        existing = json.dumps(result).encode()
        self.assertEqual(a.complete_account_uuid(existing, 'different'), existing)
        self.assertEqual(a.complete_account_uuid(b'bad-json', 'a'), b'bad-json')

    def test_credentials_refresh_is_read_without_cached_token(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'credentials'
            for token in ['first-secret', 'refreshed-secret']:
                p.write_text(json.dumps({'claudeAiOauth': {'accessToken': token}}))
                self.assertEqual(a.load_access_token(p), token)

    def test_binding_discovery_rejects_ambiguity_and_does_not_use_retired_directory(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            old = root / 'claude/accounts/old/config'
            new = root / 'claude/accounts/new/config'
            old.mkdir(parents=True); new.mkdir(parents=True)
            (old / '.claude.json').write_text('{}')
            with self.assertRaises(ValueError): a.discover_binding(root)
            (new / '.credentials.json').write_text('{}')
            self.assertEqual(a.discover_binding(root)[0], new / '.credentials.json')
            (old / '.credentials.json').write_text('{}')
            with self.assertRaises(ValueError): a.discover_binding(root)

    def test_proxy_and_listener_cannot_expose_or_bypass_local_daemon(self):
        self.assertEqual(a.proxy_address('http://127.0.0.1:1234'), ('127.0.0.1', 1234))
        for url in ['http://public.test:1234', 'https://127.0.0.1:1', 'http://u:p@localhost:1', 'http://localhost:1/?x=1']:
            with self.subTest(url=url), self.assertRaises(ValueError): a.proxy_address(url)
        with self.assertRaises(ValueError): Server(('0.0.0.0', 0), Relay(), KEY)

    def test_key_file_requires_restricted_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'key'; p.write_text(KEY); p.chmod(0o644)
            with self.assertRaises(ValueError): a.load_relay_key(p)
            p.chmod(0o600)
            self.assertEqual(a.load_relay_key(p), KEY)

    def test_daemon_restart_port_is_read_from_native_state_without_stale_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'state.json'
            config = a.Config(p, p, p, None, state_file=p)
            for port in [30001, 30002]:
                p.write_text(json.dumps({'daemon': {'running': True, 'port': port}}))
                self.assertEqual(a.current_proxy_address(config), ('127.0.0.1', port))
            p.write_text(json.dumps({'daemon': {'running': False, 'port': 30002}, 'last_port': 30002}))
            with self.assertRaises(ValueError): a.current_proxy_address(config)

    def test_headers_preserve_actual_client_signals_and_strip_hop_secrets(self):
        source = {'Authorization': 'Bearer local-secret', 'x-api-key': 'local-secret', 'Cookie': 'cookie-secret',
                  'Connection': 'x-secret', 'x-secret': 'hidden', 'X-Forwarded-For': 'private-ip',
                  'x-client-request-id': 'actual-client-id', 'x-cc-atis': 'actual-client-signature',
                  'Anthropic-Beta': 'tools-beta', 'Anthropic-Version': '2023-06-01'}
        out = a.upstream_headers(source, 'oauth-secret')
        self.assertEqual(out['Authorization'], 'Bearer oauth-secret')
        self.assertEqual(out['x-client-request-id'], source['x-client-request-id'])
        self.assertEqual(out['x-cc-atis'], source['x-cc-atis'])
        self.assertEqual(out['Anthropic-Beta'], 'tools-beta,' + a.OAUTH_BETA)
        self.assertNotIn('local-secret', json.dumps(out)); self.assertNotIn('cookie-secret', json.dumps(out))
        self.assertNotIn('x-secret', out); self.assertNotIn('X-Forwarded-For', out)
        self.assertNotIn('x-client-request-id', a.upstream_headers({}, 'token'))

    def test_invalid_input_is_rejected_without_upstream_calls(self):
        cases = [(b'not-json', {}, 400), ({}, {}, 400), ({**BODY, 'model': 'unknown-model'}, {}, 400),
                 ({**BODY, 'messages': []}, {}, 400), ({**BODY, 'max_tokens': True}, {}, 400),
                 ({**BODY, 'stream': 'true'}, {}, 400), (BODY, {'Content-Encoding': 'gzip'}, 415),
                 (BODY, {'Content-Type': 'text/plain'}, 415), (BODY, {'Content-Length': '99999999'}, 413)]
        with serve() as s:
            for body, headers, status in cases:
                with self.subTest(body=body): self.assertEqual(post(s, body, headers=headers)[0], status)
            self.assertEqual(s.relay.calls, [])

    def test_auth_paths_queries_and_telemetry_do_not_reach_upstream(self):
        with serve() as s:
            self.assertEqual(post(s, headers={'Authorization': 'Bearer wrong'})[0], 401)
            self.assertEqual(post(s, headers={'x-api-key': 'conflicting-key'})[0], 401)
            self.assertEqual(post(s, path='/v1/messages?key=secret')[0], 400)
            self.assertEqual(post(s, path='/event_logging/batch')[0], 404)
            self.assertEqual(s.relay.calls, [])

    def test_stream_is_forwarded_once_with_terminal_and_usage_observation(self):
        relay = Relay()
        with tempfile.TemporaryDirectory() as d, serve(relay, trace_file=Path(d)/'trace.jsonl') as s:
            status, headers, data = post(s, path='/v1/messages?beta=true')
            self.assertTrue(s.completed.wait(1))
            self.assertEqual(status, 200); self.assertEqual(data, COMPLETE)
            self.assertEqual(headers['request-id'], 'req_actual_fixture')
            self.assertNotIn('content-length', headers); self.assertNotIn('x-hop', headers); self.assertNotIn('set-cookie', headers)
            self.assertEqual(len(relay.calls), 1)
            self.assertEqual(json.loads(relay.calls[0][3]), BODY)
            self.assertTrue(relay.response.closed and relay.connection.closed)
            record = s.records[0]
            self.assertTrue(record['complete']); self.assertEqual(record['attempts'], 1)
            self.assertEqual(record['usage'], {'input_tokens': 7, 'output_tokens': 3})
            log = (Path(d)/'trace.jsonl').read_text()
            self.assertNotIn('private prompt', log); self.assertNotIn(KEY, log)
            self.assertEqual((Path(d)/'trace.jsonl').stat().st_mode & 0o777, 0o600)

    def test_concurrency_one_is_held_until_stream_finishes(self):
        left, right = socket.socketpair()
        relay = Relay(Response(sock=left), sock=left)
        with serve(relay) as s:
            first = http.client.HTTPConnection('127.0.0.1', s.server_port, timeout=2)
            first.request('POST', '/v1/messages', json.dumps(BODY), {'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
            response = first.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(post(s)[0], 429)
            self.assertEqual(len(relay.calls), 1)
            right.sendall(COMPLETE); right.shutdown(socket.SHUT_WR)
            self.assertEqual(response.read(), COMPLETE)
            first.close(); right.close()
            self.assertTrue(s.completed.wait(1))
            self.assertTrue(s.inference.acquire(False)); s.inference.release()

    def test_ten_concurrent_streams_hold_separate_slots_and_reject_eleventh(self):
        sockets = []
        class ConcurrentRelay(Relay):
            def open_upstream(self, *args, **kwargs):
                self.calls.append(args)
                left, right = socket.socketpair()
                sockets.append((left, right))
                return Connection(left), Response(sock=left)
        relay = ConcurrentRelay()
        with serve(relay, limits=a.Limits(concurrency=10)) as s:
            clients = []
            for number in range(10):
                c = http.client.HTTPConnection('127.0.0.1', s.server_port, timeout=3)
                body = {**BODY, 'metadata': {'user_id': 'user-' + str(number)}}
                c.request('POST', '/v1/messages', json.dumps(body), {'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
                r = c.getresponse(); self.assertEqual(r.status, 200); clients.append((c, r))
            self.assertEqual(post(s)[0], 429)
            self.assertEqual(len(relay.calls), 10)
            for number, (_, right) in enumerate(sockets):
                right.sendall(event({'type': 'content_block_delta', 'delta': {'text': 'result-' + str(number)}}) + COMPLETE)
                right.shutdown(socket.SHUT_WR)
            for number, (c, r) in enumerate(clients):
                body = r.read()
                self.assertIn(('result-' + str(number)).encode(), body)
                self.assertEqual(body.count(b'result-'), 1)
                c.close()
            for _, right in sockets: right.close()

    def test_incomplete_stream_reports_error_without_retry_or_success(self):
        with serve(Relay(Response([event({'type': 'message_start'})]))) as s:
            status, _, data = post(s)
            self.assertTrue(s.completed.wait(1))
            self.assertEqual(status, 200)
            self.assertIn(b'upstream_stream_incomplete', data)
            self.assertNotIn(b'message_stop', data)
            self.assertFalse(s.records[0]['complete']); self.assertEqual(len(s.relay.calls), 1)

    def test_total_deadline_closes_stalled_exchange_and_releases_slot(self):
        left, right = socket.socketpair()
        with serve(Relay(Response(sock=left), sock=left), limits=a.Limits(request_seconds=.15)) as s:
            status, _, _ = post(s)
            self.assertEqual(status, 200)
            self.assertTrue(s.completed.wait(1))
            self.assertEqual(s.records[0]['error'], 'request_deadline')
            self.assertTrue(s.inference.acquire(False)); s.inference.release()
            self.assertTrue(s.relay.connection.closed)
            self.assertEqual(len(s.relay.calls), 1)
        right.close()

    def test_open_failure_does_not_leak_error_text_or_retry(self):
        with serve(Relay(error=OSError('secret-token private-prompt'))) as s:
            status, _, data = post(s)
            self.assertTrue(s.completed.wait(1))
            self.assertEqual(status, 502); self.assertNotIn(b'secret-token', data)
            self.assertEqual(len(s.relay.calls), 1)
            self.assertTrue(s.inference.acquire(False)); s.inference.release()
            self.assertNotIn('secret-token', json.dumps(s.records))

    def test_total_deadline_also_interrupts_wait_for_response_headers(self):
        left, right = socket.socketpair()
        class StalledRelay(Relay):
            def open_upstream(self, *args, on_socket):
                self.calls.append(args)
                on_socket(left)
                try:
                    left.recv(1)
                    raise TimeoutError()
                finally:
                    left.close()
        with serve(StalledRelay(), limits=a.Limits(request_seconds=.15)) as s:
            with self.assertRaises((http.client.RemoteDisconnected, ConnectionError)):
                post(s)
            self.assertTrue(s.completed.wait(1))
            self.assertEqual(s.records[0]['error'], 'request_deadline')
            self.assertEqual(len(s.relay.calls), 1)
            self.assertTrue(s.inference.acquire(False)); s.inference.release()
        right.close()

    def test_malformed_upstream_error_cannot_crash_observer(self):
        observer = a.StreamObservation()
        observer.feed(event({'type': 'error', 'error': {'type': [], 'code': {}}}))
        self.assertTrue(observer.error); self.assertFalse(observer.auth_error)

    def test_401_latches_across_restart_and_does_not_dispatch_again(self):
        with tempfile.TemporaryDirectory() as d:
            latch = Path(d)/'latch.json'
            relay = Relay(Response([b'{"error":{"type":"authentication_error"}}'], status=401, content_type='application/json'))
            with serve(relay, latch_file=latch) as s:
                self.assertEqual(post(s)[0], 401)
                self.assertTrue(s.completed.wait(1))
                self.assertEqual(post(s)[0], 503)
                self.assertEqual(len(relay.calls), 1)
                self.assertTrue(latch.exists())
            with serve(latch_file=latch) as s:
                self.assertEqual(post(s)[0], 503); self.assertEqual(s.relay.calls, [])

    def test_model_permission_403_does_not_disable_entire_binding(self):
        with serve(Relay(Response([b'{"error":{"type":"permission_error"}}'], status=403, content_type='application/json'))) as s:
            self.assertEqual(post(s)[0], 403)
            self.assertTrue(s.completed.wait(1)); self.assertFalse(s.latched)

    def test_observer_handles_split_frames_without_logging_text(self):
        observer = a.StreamObservation()
        stream = event({'type': 'content_block_delta', 'delta': {'text': 'private-response'}}) + COMPLETE
        for byte in stream.replace(b'\n', b'\r\n'):
            observer.feed(bytes([byte]))
        self.assertTrue(observer.terminal); self.assertFalse(observer.error)
        self.assertEqual(observer.usage, {'input_tokens': 7, 'output_tokens': 3})
        self.assertNotIn('private-response', str(observer.__dict__))

    def test_oversized_sse_frame_does_not_grow_observer_or_hide_next_stop(self):
        observer = a.StreamObservation()
        for _ in range(64): observer.feed(b'x' * 65536)
        self.assertLessEqual(len(observer.buffer), 262144)
        observer.feed(b'\n\n' + event({'type': 'message_stop'}))
        self.assertTrue(observer.terminal)

    def test_server_revocation_inside_sse_latches(self):
        frame = event({'type': 'error', 'error': {'type': 'device_revoked', 'message': 'private details'}})
        with serve(Relay(Response([frame]))) as s:
            self.assertEqual(post(s)[0], 200)
            self.assertTrue(s.completed.wait(1)); self.assertTrue(s.latched)
            self.assertEqual(post(s)[0], 503)
            self.assertNotIn('private details', json.dumps(s.records))

    def test_native_revocation_before_a_request_latches_without_dispatch(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d) / 'state.json'
            state.write_text(json.dumps({'last_error': {'code': 'account_sync_failed',
                'message': 'unexpected status 401: {"error":{"code":"device_revoked"}}'}}))
            class NativeStateRelay(Relay):
                def authorization_revoked(self):
                    return a.native_authorization_revoked(state)
            with serve(NativeStateRelay(), latch_file=Path(d)/'latch') as s:
                self.assertEqual(post(s)[0], 503)
                self.assertTrue(s.completed.wait(1))
                self.assertTrue(s.latched)
                self.assertEqual(s.relay.calls, [])
                self.assertEqual(s.records[0]['attempts'], 0)
            state.write_text(json.dumps({'last_error': {'message': 'network timeout'}}))
            self.assertFalse(a.native_authorization_revoked(state))
            state.unlink()
            with self.assertRaises(FileNotFoundError): a.native_authorization_revoked(state)

    def test_native_identity_revocation_blocks_dispatch_before_a_local_latch_exists(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d) / 'state.json'
            state.write_text(json.dumps({'last_error': None, 'identities': {'claude': {
                'gateway': {'healthy': True}, 'last_error': {'kind': 'account_sync_failed',
                'detail': 'unexpected status 401: {"error":{"code":"device_revoked"}}'}}}}))
            class NativeStateRelay(Relay):
                def authorization_revoked(self):
                    return a.native_authorization_revoked(state)
            with serve(NativeStateRelay(), latch_file=Path(d)/'latch') as s:
                self.assertEqual(post(s)[0], 503)
                self.assertTrue(s.completed.wait(1))
                self.assertTrue(s.latched)
                self.assertEqual(s.relay.calls, [])
                self.assertEqual(s.records[0]['attempts'], 0)

    def test_native_identity_revocation_is_unhealthy_even_when_gateway_is_reachable(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d) / 'state.json'
            state.write_text(json.dumps({'daemon': {'running': True, 'port': 30001},
                'last_error': None, 'identities': {'claude': {'gateway': {'healthy': True},
                'last_error': {'kind': 'account_sync_failed', 'detail': 'device_revoked'}}}}))
            relay = a.ReClaudeRelay(a.Config(state, state, state, None, state_file=state))
            with patch.object(a, 'load_access_token', return_value='test-token'), \
                 patch.object(a.ssl, 'create_default_context'), patch.object(a.socket, 'create_connection'):
                self.assertEqual(relay.failed_health_checks(), ['native_device_revoked'])

    def test_revoked_daemon_starts_a_latched_service_instead_of_exiting(self):
        with tempfile.TemporaryDirectory() as d, socket.socket() as proxy:
            root = Path(d)
            config = root / 'claude/accounts/fixture/config'
            config.mkdir(parents=True)
            (config/'.credentials.json').write_text(json.dumps({'accessToken': 'fixture-token'}))
            (config/'.claude.json').write_text(json.dumps({'oauthAccount': {'accountUuid': 'fixture-account'}}))
            key = root/'relay.key'; key.write_text(KEY); key.chmod(0o600)
            ca = root/'ca.pem'
            certificate = a.ssl.create_default_context().get_ca_certs(binary_form=True)[0]
            ca.write_text(a.ssl.DER_cert_to_PEM_cert(certificate))
            proxy.bind(('127.0.0.1', 0)); proxy.listen(4)
            (root/'state.json').write_text(json.dumps({'daemon': {'running': True, 'port': proxy.getsockname()[1]},
                'last_error': None, 'identities': {'claude': {'last_error': {'detail': 'device_revoked'}}}}))
            with socket.socket() as reserve:
                reserve.bind(('127.0.0.1', 0)); port = reserve.getsockname()[1]
            process = subprocess.Popen([sys.executable, str(Path(a.__file__)), '--rec-home', str(root),
                '--ca-file', str(ca), '--key-file', str(key), '--port', str(port),
                '--trace-file', str(root/'trace'), '--latch-file', str(root/'latch'),
                '--model', BODY['model']], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                for _ in range(100):
                    self.assertIsNone(process.poll(), 'revoked state must remain observable, not exit at startup')
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=.2)
                    try:
                        connection.request('GET', '/healthz')
                        response = connection.getresponse(); health = json.loads(response.read())
                        self.assertEqual(response.status, 503)
                        break
                    except OSError:
                        time.sleep(.02)
                    finally:
                        connection.close()
                else:
                    self.fail('adapter did not start')
                self.assertEqual(set(health['failed']), {'native_device_revoked', 'authentication_latched'})
                self.assertTrue((root/'latch').exists())
                self.assertEqual(post(SimpleNamespace(server_port=port))[0], 503)
                self.assertEqual((root/'trace').read_bytes(), b'')
                self.assertIsNone(process.poll())
            finally:
                process.terminate()
                process.communicate(timeout=3)

    def test_native_revocation_is_scoped_to_claude_and_not_transient_network_failures(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d) / 'state.json'
            for error, expected in [('network timeout', False), ('invalid_sk', True), (None, False)]:
                with self.subTest(error=error):
                    state.write_text(json.dumps({'last_error': None, 'identities': {
                        'claude': {'last_error': {'detail': error} if error else None},
                        'codex': {'last_error': {'detail': 'device_revoked'}}}}))
                    self.assertEqual(a.native_authorization_revoked(state), expected)

    def test_json_response_is_forwarded_and_validated_without_context_storage(self):
        payload = {'type': 'message', 'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': 'result'}], 'usage': {'input_tokens': 1, 'output_tokens': 2}}
        with serve(Relay(Response([json.dumps(payload).encode()], content_type='application/json'))) as s:
            self.assertEqual(json.loads(post(s, {**BODY, 'stream': False})[2]), payload)
            self.assertTrue(s.completed.wait(1)); self.assertTrue(s.records[0]['complete'])
            self.assertNotIn('result', json.dumps(s.records))

if __name__ == '__main__': unittest.main()
