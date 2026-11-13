"""Run an isolated nginx fixture; no credentials, model traffic or live config."""
import datetime
import socket
import threading
import http.server
import tempfile
import http.client
import json
import pathlib
import subprocess
import time

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()
CONFIG = pathlib.Path(__file__).resolve().parents[1] / 'nginx'
MAP = (CONFIG / 'admission-http.conf').read_text()
LOCATION = (CONFIG / 'admission-location.conf').read_text()
CAPACITY = (CONFIG / 'capacity-server.conf').read_text()

def run_probe():
    checks = {}
    held = []
    process = None
    calls = []

    class Handler(http.server.BaseHTTPRequestHandler):

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', '0')))
            calls.append(self.path)
            if self.path.endswith('?quota'):
                self.send_response(429)
                self.send_header('Retry-After', '3600')
                self.end_headers()
                self.wfile.write(b'upstream quota')
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'fixture')

        def log_message(self, *a):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    probe = socket.socket()
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
    probe.close()
    with tempfile.TemporaryDirectory(prefix='vm2api-relay-body-offline-') as directory:
        root = pathlib.Path(directory)
        cfg = f"""
pid {root / 'nginx.pid'};
daemon off;
master_process off;
error_log {root / 'error.log'} error;
events {{}}
http {{
    access_log off;
    client_body_temp_path {root / 'bodies'};
    {MAP}
    limit_conn_zone $binary_remote_addr zone=vm2api_clients_direct:1m;
    server {{
        listen 127.0.0.1:{port};
        client_body_timeout 15s;
        limit_conn_status 429;
        limit_conn vm2api_clients_direct 20;
"""
        for route in ['/reclaude/v1/messages', '/reclaude/v1/native-3805/v1/messages']:
            cfg += f"""
        location = {route} {{
            {LOCATION}
            proxy_request_buffering on;
            proxy_pass http://127.0.0.1:{server.server_port};
        }}
"""
        cfg += f"""
        {CAPACITY}
        location ^~ /reclaude/ {{ return 404; }}
        location /v1/ {{
            client_max_body_size 128m;
            proxy_pass http://127.0.0.1:{server.server_port};
        }}
    }}
}}
"""
        path = root / 'nginx.conf'
        path.write_text(cfg)
        subprocess.run(['nginx', '-t', '-p', str(root), '-c', str(path)], check=True, capture_output=True)
        process = subprocess.Popen(['nginx', '-p', str(root), '-c', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def start(length, path='/reclaude/v1/messages', extra='', method='POST'):
            sock = socket.create_connection(('127.0.0.1', port), 2)
            sock.settimeout(2)
            headers = 'Content-Length: ' + str(length) if length is not None else 'Transfer-Encoding: chunked'
            request = (
                f'{method} {path} HTTP/1.1\r\nHost: fixture\r\n'
                'Connection: close\r\nExpect: 100-continue\r\n'
                f'{headers}\r\n{extra}\r\n'
            )
            sock.sendall(request.encode())
            held.append(sock)
            response = b''
            while b'\r\n\r\n' not in response:
                response += sock.recv(4096)
            if response.startswith(b'HTTP/1.1 100 '):
                _, following = response.split(b'\r\n\r\n', 1)
                if not following:
                    sock.settimeout(0.1)
                    try:
                        following = sock.recv(4096)
                    except socket.timeout:
                        following = b''
                    sock.settimeout(2)
                if following:
                    response = following
            if not response.startswith(b'HTTP/1.1 100 '):
                while b'\r\n\r\n' not in response:
                    response += sock.recv(4096)
                head, body = response.split(b'\r\n\r\n', 1)
                length = int(next(
                    line.split(b':', 1)[1] for line in head.split(b'\r\n')
                    if line.lower().startswith(b'content-length:')
                ))
                while len(body) < length:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    response += chunk
                    body += chunk
            return (sock, response.decode())

        def admitted(response):
            return response.startswith('HTTP/1.1 100 Continue')

        def rejected(response):
            return response.startswith('HTTP/1.1 429 ')

        def release():
            for sock in held:
                sock.close()
            held.clear()
            time.sleep(0.15)

        def complete(path):
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            conn.request('POST', path, body=b'{}')
            r = conn.getresponse()
            result = (r.status, dict(r.getheaders()), r.read())
            conn.close()
            return result
        try:
            for _ in range(30):
                try:
                    with socket.create_connection(('127.0.0.1', port), 0.1):
                        break
                except OSError:
                    time.sleep(0.03)
            a, response = start(8596819)
            checks['8_20_mib_admitted'] = admitted(response)
            a.sendall(b'x')
            _, response = start(8596853, extra='X-Real-IP: 1.1.1.1\r\n')
            checks['second_large_admitted'] = admitted(response)
            _, response = start(8596853, extra='X-Real-IP: 2.2.2.2\r\n')
            checks['third_large_rejected_despite_spoof'] = rejected(response)
            assert response.split('\r\n\r\n', 1)[1].startswith('{'), repr(response)
            body = json.loads(response.split('\r\n\r\n', 1)[1])
            checks['structured_capacity_429'] = body['error']['code'] == 'native_ingress_busy' and '\r\nRetry-After: 1\r\n' in response
            checks['eight_small_with_two_large'] = all(admitted(start(999999)[1]) for _ in range(8))
            _, response = start(2, extra='X-Real-IP: 2.2.2.2\r\n')
            checks['eleventh_rejected'] = rejected(response)
            _, response = start(2, '/reclaude/v1/messages?different')
            checks['query_does_not_split_budget'] = rejected(response)
            _, response = start(2, '/reclaude/v1/%6dessages')
            checks['encoded_uri_does_not_split_budget'] = rejected(response)
            _, response = start(8596819, '/reclaude/v1/native-3805/v1/messages')
            checks['other_relay_independent_budget'] = admitted(response)
            _, response = start(128 * 1024 * 1024, '/v1/messages')
            checks['pro_limit_unchanged_in_fixture'] = admitted(response)
            checks['rejected_not_forwarded'] = not calls
            release()
            _, response = start(None)
            checks['unknown_length_budgeted'] = admitted(response)
            _, response = start(1000000)
            checks['unknown_and_one_large_admitted'] = admitted(response)
            checks['unknown_consumes_one_large_seat'] = rejected(start(1000000)[1])
            release()
            _, response = start(1000000, method='GET')
            checks['large_get_counted'] = admitted(response)
            _, response = start(1000000)
            checks['one_other_large_admitted'] = admitted(response)
            checks['large_get_cannot_bypass'] = rejected(start(1000000)[1])
            release()
            _, response = start(16 * 1024 * 1024)
            checks['16_mib_admitted'] = admitted(response)
            _, response = start(16 * 1024 * 1024 + 1)
            checks['16_mib_plus_byte_413'] = response.startswith('HTTP/1.1 413 ')
            release()
            status, headers, body = complete('/reclaude/v1/messages?quota')
            checks['upstream_quota_unchanged'] = status == 429 and headers.get('Retry-After') == '3600' and (body == b'upstream quota')
            checks['unknown_relay_path_404'] = complete('/reclaude/v1/messages/')[0] == 404
            checks['seat_released_after_disconnect'] = complete('/reclaude/v1/messages')[0] == 200
        finally:
            release()
            process.terminate()
            process.wait(timeout=5)
            server.shutdown()
            server.server_close()
    print(json.dumps({'at': now(), 'checks': checks, 'passed': sum(checks.values()), 'total': len(checks), 'production_config_changed': False, 'model_calls': 0, 'fixture_cleaned': process.poll() is not None}))
    assert all(checks.values()), checks
if __name__ == '__main__':
    run_probe()
