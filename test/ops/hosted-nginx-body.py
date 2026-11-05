"""Linux/root integration check: isolated Nginx, loopback upstream, no model calls."""
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Echo(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            chunks = []
            while True:
                size = int(self.rfile.readline().strip().split(b';')[0], 16)
                if not size:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            data = b''.join(chunks)
        else:
            data = self.rfile.read(int(self.headers['Content-Length']))
        body = json.dumps({'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def exercise(template):
    assert os.geteuid() == 0, 'Run on Linux as root; only isolated temporary paths are changed'
    assert 'proxy_request_buffering off;' in template
    assert 'proxy_http_version 1.1;' in template
    nginx = shutil.which('nginx')
    assert nginx, 'Nginx is required'
    upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Echo)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    rows = []
    try:
        with tempfile.TemporaryDirectory(prefix='hosted-nginx-body-') as folder:
            root = Path(folder)
            root.chmod(0o755)
            body_dir = root / 'body'
            body_dir.mkdir(mode=0o700)
            for buffering in ['on', 'off']:
                port = free_port()
                config = root / 'nginx.conf'
                config.write_text(f'''user www-data;
worker_processes 1;
pid {root}/nginx.pid;
error_log {root}/error.log;
events {{ worker_connections 32; }}
http {{
 access_log off;
 client_body_temp_path {body_dir};
 client_body_buffer_size 1k;
 server {{
  listen 127.0.0.1:{port};
  client_max_body_size 2m;
  location / {{
   proxy_pass http://127.0.0.1:{upstream.server_port};
   proxy_http_version 1.1;
   proxy_request_buffering {buffering};
   proxy_buffering off;
  }}
 }}
}}
''')
                proc = subprocess.Popen([nginx, '-p', str(root), '-c', str(config), '-g', 'daemon off;'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                try:
                    for _ in range(100):
                        assert proc.poll() is None, 'Isolated nginx exited'
                        try:
                            with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                                break
                        except OSError:
                            time.sleep(0.02)
                    else:
                        raise AssertionError('Isolated nginx did not start')
                    # Fault injection only inside this temporary fixture. Nginx startup may chown it.
                    os.chown(body_dir, 0, 0)
                    body_dir.chmod(0o700)
                    for endpoint in ['/claude/v1/messages', '/claude/v1/chat/completions']:
                        for size, chunked in [(128, False), (65536, False), (65536, True)]:
                            data = b'x' * size
                            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
                            payload = iter([data[i:i + 4096] for i in range(0, size, 4096)]) if chunked else data
                            conn.request('POST', endpoint, payload, {'Content-Type': 'application/octet-stream'},
                                         encode_chunked=chunked)
                            response = conn.getresponse()
                            result = response.read()
                            want = 500 if buffering == 'on' and size > 1024 else 200
                            assert response.status == want, (buffering, endpoint, size, response.status)
                            if want == 200:
                                assert json.loads(result) == {'bytes': size, 'sha256': hashlib.sha256(data).hexdigest()}
                            rows.append({'buffering': buffering, 'endpoint': endpoint, 'bytes': size,
                                         'chunked': chunked, 'status': response.status})
                            conn.close()
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                if buffering == 'on':
                    assert 'Permission denied' in (root / 'error.log').read_text()
    finally:
        upstream.shutdown()
        upstream.server_close()
    return rows


if __name__ == '__main__':
    import sys
    template_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'deploy/hosted-nginx.conf.example'
    print(json.dumps(exercise(template_path.read_text()), indent=2))
