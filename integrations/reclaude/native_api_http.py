"""Isolated official Claude Code runtime for an explicitly configured API provider."""
import argparse
import json
import os
from pathlib import Path
import signal
import threading
from urllib.parse import urlsplit

from adapter import Limits, load_relay_key
from native_bridge_session import Session
from native_http import NativeServer


def provider(path):
    if path.stat().st_mode & 0o077:
        raise ValueError('provider_credentials_must_be_private')
    value = json.loads(path.read_text())
    url = urlsplit(value['base_url'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ('', '/')):
        raise ValueError('provider_requires_https_origin')
    if not isinstance(value.get('api_key'), str) or len(value['api_key']) < 20:
        raise ValueError('provider_api_key_required')
    if value.get('proxy_url'):
        proxy = urlsplit(value['proxy_url'])
        if (proxy.scheme not in ('http', 'https', 'socks5', 'socks5h')
                or not proxy.hostname or not proxy.port or proxy.path
                or proxy.query or proxy.fragment):
            raise ValueError('invalid_provider_proxy')
    return value


class APIHealth:
    def __init__(self, credentials, cli, guard):
        self.credentials, self.cli, self.guard = credentials, cli, guard

    def authorization_revoked(self):
        return False  # No native OAuth daemon; provider authorization needs live acceptance.

    def failed_health_checks(self):
        try:
            provider(self.credentials)
            return [] if all(os.access(x, os.X_OK) for x in (self.cli, self.guard)) else ['cli_runtime_unavailable']
        except (OSError, ValueError, KeyError, TypeError):
            return ['provider_configuration_unavailable']


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    for name in ('home', 'root', 'key-file', 'provider-file', 'cli', 'dispatch-proxy'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--port', type=int, default=18790)
    p.add_argument('--private-host')
    p.add_argument('--model', action='append', required=True)
    p.add_argument('--concurrency', type=int, default=2)
    p.add_argument('--max-requests', type=int)
    args = p.parse_args()
    credentials = provider(args.provider_file)
    # Only the dispatch guard inherits this server environment. The CLI receives
    # its own clean environment and connects exclusively to its loopback guard.
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        os.environ.pop(key, None)
    if credentials.get('proxy_url'):
        os.environ['HTTPS_PROXY'] = credentials['proxy_url']
    os.environ['NO_PROXY'] = '127.0.0.1,localhost,::1'
    args.home.mkdir(parents=True, exist_ok=True, mode=0o700)
    profile = args.home / 'profile'
    profile.mkdir(mode=0o700, exist_ok=True)
    limits = Limits(models=tuple(args.model), concurrency=args.concurrency)
    env = {'HOME': str(args.home), 'CLAUDE_CONFIG_DIR': str(profile),
           'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'LANG': 'C.UTF-8',
           'ANTHROPIC_API_KEY': credentials['api_key'],
           'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
           'DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1', 'NO_PROXY': '127.0.0.1,localhost,::1'}

    def factory(directory, body):
        return Session(directory, [str(args.cli), '--setting-sources', ''], env, body,
                       timeout=limits.request_seconds, dispatch_proxy=args.dispatch_proxy,
                       api_base=credentials['base_url'], restore=True, history_profile=profile)

    health = APIHealth(args.provider_file, args.cli, args.dispatch_proxy)
    if health.failed_health_checks():
        raise ValueError('api_runtime_not_ready')
    server = NativeServer((args.private_host or '127.0.0.1', args.port), health,
                          load_relay_key(args.key_file), args.root, factory, limits=limits,
                          private_host=args.private_host, max_requests=args.max_requests,
                          recover=factory, allow_history_import=True, configuration_channels=True)
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
