"""Isolated Linux Nginx regression: duplicated SDK /v1, body/auth/query and GPT isolation."""
import hashlib
import http.client
import http.server
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time

spec = importlib.util.spec_from_file_location('body_check', Path(__file__).with_name('hosted-nginx-body.py'))
body_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(body_check)


class Endpoint(body_check.Echo):
    seen = []

    def do_POST(self):
        Endpoint.seen.append((self.server.label, self.command, self.path, self.headers.get('Authorization')))
        if self.server.label == 'claude' and self.path.startswith('/v1/v1/'):
            self.send_error(404)
            self.close_connection = True
            return
        super().do_POST()


def exercise(snippet):
    nginx = shutil.which('nginx')
    assert nginx, 'Linux Nginx is required'
    servers = []
    results = []
    try:
        for label in ('claude', 'gpt'):
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
            server.label = label
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
        with tempfile.TemporaryDirectory(prefix='hosted-nginx-prefix-') as folder:
            root = Path(folder)
            root.chmod(0o755)
            for compatibility in (False, True):
                port = body_check.free_port()
                config = root / 'nginx.conf'
                config.write_text(f'''worker_processes 1;
pid {root}/nginx.pid;
error_log {root}/error.log;
events {{ worker_connections 32; }}
http {{
 access_log off;
 server {{
  listen 127.0.0.1:{port};
  location ^~ /claude/ {{
   {snippet if compatibility else ''}
   proxy_pass http://127.0.0.1:{servers[0].server_port}/;
   proxy_http_version 1.1;
   proxy_request_buffering off;
   proxy_buffering off;
  }}
  location / {{ proxy_pass http://127.0.0.1:{servers[1].server_port}; }}
 }}
}}
''')
                proc = subprocess.Popen([nginx, '-p', str(root), '-c', str(config), '-g', 'daemon off;'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                try:
                    for _ in range(100):
                        assert proc.poll() is None, 'Isolated Nginx exited'
                        try:
                            with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                                break
                        except OSError:
                            time.sleep(0.02)
                    else:
                        raise AssertionError('Isolated Nginx did not start')
                    paths = [(f'/claude/{prefix}/{endpoint}?beta=true', 'claude', f'/v1/{endpoint}?beta=true')
                             for prefix in ('v1', 'v1/v1')
                             for endpoint in ('messages', 'messages/count_tokens', 'chat/completions', 'models')]
                    paths += [('/v1/messages', 'gpt', '/v1/messages'),
                              ('/v1/v1/messages', 'gpt', '/v1/v1/messages'),
                              ('/claude/api/panel/overview', 'claude', '/api/panel/overview')]
                    for path, upstream, expected_path in paths:
                        for chunked in (False, True):
                            duplicate = path.startswith('/claude/v1/v1/')
                            data = b'benign-payload\n' * (8 if duplicate and not compatibility else 7000)
                            payload = iter([data[i:i + 4096] for i in range(0, len(data), 4096)]) if chunked else data
                            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
                            conn.request('POST', path, payload, {'Authorization': 'Bearer fixture',
                                         'Content-Type': 'application/octet-stream'}, encode_chunked=chunked)
                            response = conn.getresponse()
                            result = response.read()
                            expected_status = 404 if duplicate and not compatibility else 200
                            assert response.status == expected_status, (path, response.status)
                            assert response.getheader('Location') is None
                            if expected_status == 200:
                                assert json.loads(result) == {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                                assert Endpoint.seen[-1] == (upstream, 'POST', expected_path, 'Bearer fixture')
                            results.append({'compatibility': compatibility, 'path': path, 'chunked': chunked,
                                            'status': response.status, 'bytes': len(data)})
                            conn.close()
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
    return results


if __name__ == '__main__':
    import sys
    snippet = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parents[2] / 'deploy/hosted-prefix-compat.conf'
    print(json.dumps(exercise(snippet.read_text()), indent=2))
