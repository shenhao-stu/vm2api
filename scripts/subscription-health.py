#!/usr/bin/env python3
"""Low-traffic dynamic subscription patrol using the existing panel API.

Run from a host timer. It never changes exits, credentials, quotas or bindings.
Only a hold created by this patrol, for the same account and dynamic policy,
can be resumed. Fixed-IP policies are deliberately outside its authority.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit


def atomic(path, value):
    tmp = path.with_suffix('.new')
    with open(tmp, 'w', encoding='utf-8') as stream:
        os.chmod(tmp, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def stamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def binding(target, vm, policy, node):
    if (vm.get('id') != target['vm_id'] or vm.get('proxy', {}).get('id') != target['proxy_id']
            or policy.get('required') is not False or policy.get('expected_ip')
            or policy.get('state', {}).get('latched') or not node or node.get('retained')
            or node.get('profile_id') != target['profile_id']):
        return None
    account = vm.get('account_uuid')
    if not account:
        return None
    return hashlib.sha256(json.dumps([target, account, policy.get('revision'), node['id']],
                                     sort_keys=True).encode()).hexdigest()


def owned_hold(vm, reason):
    return vm.get('schedulable') is False and vm.get('schedule_disabled_reason') == reason


def can_resume(vm, reason):
    error = str(vm.get('refresh_error') or '')
    return (owned_hold(vm, reason) and vm.get('status') == 'running'
            and vm.get('has_token') is True and not error)


def probe(proxy_url, url):
    # SOCKS hostname resolution is remote; there is no direct retry or redirect.
    scheme = urlsplit(proxy_url).scheme
    if scheme not in ('socks5', 'socks5h'):
        return {'ok': False, 'security': True, 'code': 'proxy_scheme'}
    proxy_url = 'socks5h:' + proxy_url.split(':', 1)[1]
    try:
        result = subprocess.run(
            ['curl', '-q', '--config', '-', '--noproxy', '', '--proto', '=https',
             '--connect-timeout', '5', '--max-time', '12', '--max-filesize', '2048',
             '--fail', '--silent', '--show-error', url],
            input='proxy = ' + json.dumps(proxy_url) + '\n', text=True,
            capture_output=True, timeout=15, check=False)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'security': False, 'code': 'probe_deadline'}
    try:
        address = ipaddress.ip_address(result.stdout.strip())
        valid = result.returncode == 0 and address.is_global
    except ValueError:
        address, valid = None, False
    return {'ok': valid, 'ip': str(address) if valid else None,
            'security': result.returncode in (51, 60, 77) or result.returncode == 0 and not valid,
            'code': 'ok' if valid else 'https_probe_' + str(result.returncode)}


class Native:
    def __init__(self, config):
        self.root = pathlib.Path(config['project_root'])
        self.container = config['container']
        result = subprocess.run(['docker', 'inspect', self.container], capture_output=True,
                                text=True, timeout=10, check=True)
        env = dict(v.split('=', 1) for v in json.loads(result.stdout)[0]['Config']['Env'] if '=' in v)
        self.token = env['VM2API_API_KEY']
        self.base = config['panel_url'].rstrip('/')
        if urlsplit(self.base).hostname not in ('127.0.0.1', '::1'):
            raise ValueError('panel_must_be_loopback')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def api(self, method, route, body=None):
        req = urllib.request.Request(self.base + '/api/panel' + route, method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'},
            data=json.dumps(body).encode() if body is not None else None)
        with self.opener.open(req, timeout=55) as response:
            data = json.load(response)
        if data.get('ok') is False:
            raise RuntimeError('native_api_failed')
        return data.get('data', data)

    def view(self, target):
        vm = self.api('GET', '/vms/' + target['vm_id'])['vm']
        guards = self.api('GET', '/proxy-exit-guard')['proxies']
        policy = next((p for p in guards if p['id'] == target['proxy_id']), {})
        subs = self.api('GET', '/proxy-subscriptions')
        node = next((n for n in subs['nodes'] if n['proxy_id'] == target['proxy_id']), None)
        return vm, policy, node, subs

    def check(self, target, both=False):
        config = json.loads((self.root / 'data/run/egress' / target['proxy_id'] / 'egress.json').read_text())
        urls = ('https://api.ipify.org', 'https://checkip.amazonaws.com')
        first = probe(config['proxy_url'], urls[0])
        if first['security'] or first['ok'] and not both:
            return [first]
        return [first, probe(config['proxy_url'], urls[1])]

    def idle(self):
        return all(not v.get('inflight') and not v.get('queue_depth')
                   for v in self.api('GET', '/vms')['items'])

    def hold(self, target, reason):
        return self.api('POST', '/vms/' + target['vm_id'] + '/schedulable',
                        {'schedulable': False, 'reason': reason})

    def resume(self, target):
        return self.api('POST', '/vms/' + target['vm_id'] + '/schedulable', {'schedulable': True})

    def refresh(self, target):
        return self.api('POST', '/proxy-subscriptions/' + target['profile_id'] + '/refresh', {})

    def notify(self, text):
        # Reuse the existing native notifier and its restricted routing config.
        code = """import fs from 'node:fs';
import {dispatchNotify} from './src/lib/admin/notify.mjs';
const routing=JSON.parse(fs.readFileSync('./src/config/routing.json','utf8'));
const text=fs.readFileSync(0,'utf8');
if(!routing.notify?.enabled) throw Error('notify_disabled');
const result=await dispatchNotify(routing.notify,
 {title:'动态订阅健康状态',subject:'vm2api · 动态订阅健康状态',text});
if(!result.ok) throw Error('notify_failed');
"""
        subprocess.run(['docker', 'exec', '-i', '-w', str(self.root), self.container,
                        'node', '--input-type=module', '-e', code], input=text,
                       text=True, capture_output=True, timeout=30, check=True)


def tick(target, state, native, save, now):
    reason = 'subscription_health:' + target['proxy_id']
    vm, policy, node, subs = native.view(target)
    identity = binding(target, vm, policy, node)
    if not identity or state.get('identity', identity) != identity:
        state.update(status='manual', issue='binding_or_policy_changed')
        return
    state.setdefault('identity', identity)
    if state.get('manual'):
        state.update(status='manual')
        return
    held = owned_hold(vm, reason)
    if not held and (vm.get('schedulable') is False or vm.get('status') != 'running'):
        state.update(status='external_hold')
        return
    if held and not state.get('hold_intent'):
        state.update(status='manual', issue='unowned_hold', manual=True)
        return
    if held and now < state.get('next_attempt', 0):
        state.update(status='open')
        return

    profile = next(p for p in subs['profiles'] if p['id'] == target['profile_id'])
    due = now - stamp(profile['updated_at']) >= 6 * 3600
    attempt_due = now >= state.get('next_refresh', 0)
    if (held or due) and attempt_due and native.idle():
        attempts = state.get('refresh_failures', 0)
        if held and state.get('recovery_attempts', 0) >= 3:
            state.update(status='manual', manual=True, issue='recovery_exhausted')
            return
        if held:
            state['recovery_attempts'] = state.get('recovery_attempts', 0) + 1
        state.update(last_refresh_attempt=now, next_refresh=now + 6 * 3600)
        # Persist before a network write so an uncertain outcome is not retried on every tick.
        save()
        try:
            native.refresh(target)
            state.update(refresh_failures=0, last_refresh_ok=now, issue=None)
        except Exception as error:
            state.update(refresh_failures=attempts + 1, issue='refresh_' + type(error).__name__)
            state['next_refresh'] = now + (900, 3600, 21600)[min(attempts, 2)]
        vm, policy, node, subs = native.view(target)
        if binding(target, vm, policy, node) != identity:
            # Never follow a newly named node, even when the old one was retained.
            if (policy.get('required') is False and not policy.get('expected_ip')
                    and vm.get('proxy', {}).get('id') == target['proxy_id']
                    and vm.get('schedulable') is not False):
                state.update(hold_intent=True, held_at=now)
                save()
                native.hold(target, reason)
            state.update(status='manual', manual=True, issue='subscription_node_changed')
            return

    results = native.check(target, both=held)
    state.update(last_check=now, probes=results)
    security = any(r.get('security') for r in results)
    healthy = all(r['ok'] for r in results) if held else any(r['ok'] for r in results)
    if security or not healthy:
        # Recheck ownership before mutation; a concurrent operator hold wins.
        current, guard, current_node, _ = native.view(target)
        if binding(target, current, guard, current_node) != identity:
            state.update(status='manual', manual=True, issue='binding_or_policy_changed')
            return
        if current.get('schedulable') is not False:
            state.update(hold_intent=True, held_at=now, recovery_attempts=0, next_refresh=now)
            save()
            native.hold(target, reason)
        elif not owned_hold(current, reason):
            state.update(status='external_hold')
            return
        attempts = state.get('recovery_attempts', 0)
        manual = security or attempts >= 3
        state.update(status='manual' if manual else 'open', manual=manual,
                     issue='tls_or_response_invalid' if security else 'egress_unreachable',
                     next_attempt=now + (300, 900, 3600)[min(attempts, 2)])
        state['next_refresh'] = min(state.get('next_refresh', 0), state['next_attempt'])
        return

    if held:
        # A successful subscription/DNS refresh and two HTTPS checks are both required.
        if state.get('last_refresh_ok', 0) < state.get('held_at', now):
            state.update(status='open', issue='refresh_required')
            return
        current, guard, current_node, _ = native.view(target)
        if binding(target, current, guard, current_node) != identity or not can_resume(current, reason):
            state.update(status='external_hold')
            return
        native.resume(target)
        state.update(hold_intent=False, recovery_attempts=0)
    state.update(status='healthy', manual=False)
    if not state.get('refresh_failures'):
        state['issue'] = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(pathlib.Path(args.config).read_text())
    root = pathlib.Path(config['state_dir'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(root / 'lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        file = root / 'state.json'
        state = json.loads(file.read_text()) if file.exists() else {'version': 1, 'targets': {}}
        native = Native(config)
        for target in config['targets']:
            if not all(re.fullmatch(r'[a-zA-Z0-9_-]+', target[k]) for k in ('vm_id', 'proxy_id', 'profile_id')):
                raise ValueError('invalid_target')
            row = state['targets'].setdefault(target['vm_id'], {})
            save = lambda: atomic(file, state)
            try:
                tick(target, row, native, save, time.time())
            except Exception as error:
                row.update(status='unknown', issue='patrol_' + type(error).__name__)
            event = [row.get('status'), row.get('issue')]
            if event != row.get('notified'):
                message = 'vm2api ' + target['vm_id'] + ': ' + json.dumps(event)
                try:
                    native.notify(message)
                    row['notified'] = event
                except Exception as error:
                    row['notify_error'] = type(error).__name__
            save()
            print(json.dumps({'vm_id': target['vm_id'], 'status': row.get('status'),
                              'issue': row.get('issue'), 'at': time.time()}), flush=True)


if __name__ == '__main__':
    main()
