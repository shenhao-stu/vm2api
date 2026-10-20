import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  assertAuthLoginReady,
  authLoginSessionDir,
  completeClaudeAuthLogin,
  extractAuthLoginUrl,
  isPersistentAuthLoginSession,
  officialLoginCredentialToOauth,
  startClaudeAuthLoginSession,
  stopClaudeAuthLoginSession,
} from '../../src/lib/oauth/claude-auth-login.mjs'
import { KVM_GUEST_EXEC } from '../../src/lib/vm/slot-exec.mjs'
import { FULL_OAUTH_SCOPE } from '../../src/lib/oauth/oauth-contract.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'
import { proxyExitGuardDirectory } from '../../src/lib/vm/proxy-exit-guard.mjs'

test('official login refuses an unverified strict exit before inspecting or preparing the slot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-guard-'))
  const settings = new SettingsRepo(openDatabase({ dbPath: ':memory:' }))
  settings.set('proxy_exit_guard', { required: true, proxies: {} })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const vm = { id: 'vm-guard', proxy: { id: 'px-fixture', host: '127.0.0.1', port: 1080 } }
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(path.join(home, '.kin'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kin', 'cli-node'), '')
  let inspections = 0
  assert.throws(
    () =>
      assertAuthLoginReady(root, vm, {
        inspect() {
          inspections++
          return { running: true }
        },
      }),
    { code: 'exit_guard_blocked', reason: 'exit_ip_required', status: 409 },
  )
  assert.equal(inspections, 0)
  assert.deepEqual(fs.readdirSync(home), ['.kin'])
  assert.equal(fs.existsSync(authLoginSessionDir(root, vm.id)), false)
})

test('strict login checks the helper latch before fake authorization', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-login-latch-'))
  const settings = new SettingsRepo(openDatabase({ dbPath: ':memory:' }))
  const vm = { id: 'vm-guard', proxy: { id: 'px-fixture', host: '127.0.0.1', port: 1080 } }
  const policy = { expected_ip: '203.0.113.10', revision: 'fixture' }
  settings.set('proxy_exit_guard', { required: true, proxies: { [vm.proxy.id]: policy } })
  const dir = proxyExitGuardDirectory(root, vm.proxy.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'exit-guard-state.json'),
    JSON.stringify({ ...policy, latched: true, ready: false, reason: 'exit_ip_mismatch' }),
  )
  const saved = process.env.KIN_FAKE_SESSION_OAUTH
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  t.after(() => {
    if (saved === undefined) delete process.env.KIN_FAKE_SESSION_OAUTH
    else process.env.KIN_FAKE_SESSION_OAUTH = saved
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await assert.rejects(startClaudeAuthLoginSession({ vm, projectRoot: root }), {
    code: 'exit_guard_blocked',
    reason: 'exit_ip_mismatch',
  })
  for (const target of [
    { ...vm, platform: 'openai' },
    { ...vm, node_id: 'remote' },
  ]) {
    assert.throws(() => assertAuthLoginReady(root, target), { code: 'exit_guard_blocked' })
  }
  assert.equal(fs.existsSync(path.join(root, 'vms')), false)
})

test('login ticket is rechecked after protection is enabled, without creating credentials', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-login-ticket-'))
  const settings = new SettingsRepo(openDatabase({ dbPath: ':memory:' }))
  const savedPath = process.env.PATH
  const vm = { id: 'vm-guard', proxy: { id: 'px-fixture', host: '127.0.0.1', port: 1080 } }
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(path.join(home, '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(path.join(home, '.kin', 'cli-node'), '')
  const calls = path.join(root, 'docker-calls.jsonl')
  fs.writeFileSync(
    path.join(root, 'docker'),
    `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n'); process.stdout.write('true|123|fixture||||docker||false');`,
    { mode: 0o755 },
  )
  process.env.PATH = `${root}:${savedPath || ''}`
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const shell = createSlotShell({ projectRoot: root })
  const issued = shell.issueTicket(vm.id, { login: true })
  assert.equal(issued.ok, true)
  settings.set('proxy_exit_guard', { required: true, proxies: {} })
  const denied = shell.issueTicket(vm.id, { login: true })
  assert.equal(denied.status, 409)
  assert.equal(denied.error.code, 'exit_guard_blocked')
  assert.equal(denied.error.reason, 'exit_ip_required')
  const responses = []
  const socket = { write: (data) => responses.push(String(data)), destroy() {} }
  assert.equal(
    shell.handleUpgrade(
      { url: `/api/panel/vms/${vm.id}/shell?ticket=${issued.ticket}&login=1` },
      socket,
      Buffer.alloc(0),
    ),
    true,
  )
  assert.match(responses[0], /^HTTP\/1\.1 409 /)
  assert.deepEqual(fs.readdirSync(home), ['.kin'])
  const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(commands.length, 1)
  assert.equal(commands[0][0], 'inspect')
})

test('strict login accepts a verified live local helper', { skip: process.platform !== 'linux' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-login-ready-'))
  const settings = new SettingsRepo(openDatabase({ dbPath: ':memory:' }))
  const vm = { id: 'vm-guard', proxy: { id: 'px-fixture', host: '127.0.0.1', port: 1080 } }
  const policy = { expected_ip: '203.0.113.10', revision: 'fixture' }
  settings.set('proxy_exit_guard', { required: true, proxies: { [vm.proxy.id]: policy } })
  const dir = proxyExitGuardDirectory(root, vm.proxy.id)
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(root, 'kin-egress')
  fs.copyFileSync(process.execPath, bin)
  const child = spawn(bin, ['-e', 'setInterval(() => {}, 1000)', '--', '-config', path.join(dir, 'egress.json')], {
    stdio: 'ignore',
    env: {},
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await once(child, 'spawn')
  fs.writeFileSync(path.join(dir, 'egress.pid'), String(child.pid))
  fs.writeFileSync(
    path.join(dir, 'exit-guard-state.json'),
    JSON.stringify({
      ...policy,
      pid: child.pid,
      observed_ip: policy.expected_ip,
      checked_at: new Date().toISOString(),
      ready: true,
      latched: false,
      socks_addr: '127.0.0.1:19080',
    }),
  )
  const home = path.join(root, 'vms', vm.id, 'cli-home', '.kin')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'cli-node'), '')
  assert.equal(assertAuthLoginReady(root, vm, { inspect: () => ({ running: true }) }).container, 'kin-guard')
})

test('extractAuthLoginUrl reads the official manual CAI link', () => {
  const url =
    'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&scope=user%3Aprofile'
  const raw = `If the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07`
  assert.equal(extractAuthLoginUrl(raw), url)
  const wrapped = 'https://claude.com/cai/oauth/authorize?code=true&\nclient_id=abc&state=xyz'
  assert.equal(extractAuthLoginUrl(wrapped), 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz')
})

test('officialLoginCredentialToOauth keeps a full refresh grant and rejects setup tokens', () => {
  const oauth = officialLoginCredentialToOauth({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-full',
      refreshToken: 'rt-full',
      expiresAt: Date.now() + 8 * 3600 * 1000,
      scopes: FULL_OAUTH_SCOPE.split(' '),
      email: 'user@example.com',
      accountUuid: 'acct-1',
      orgUuid: 'org-1',
      subscriptionType: 'max',
    },
  })
  assert.equal(oauth.type, 'oauth')
  assert.equal(oauth.mode, 'oauth')
  assert.equal(oauth.flavor, 'claude_code')
  assert.equal(oauth.source, 'claude-auth-login')
  assert.equal(oauth.refresh_token, 'rt-full')
  assert.equal(oauth.email, 'user@example.com')
  assert.equal(oauth.subscription_type, 'max')
  assert.match(oauth.scope, /user:profile/)
  assert.match(oauth.scope, /user:file_upload/)
  assert.throws(
    () =>
      officialLoginCredentialToOauth({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-' + 'a'.repeat(90),
          refreshToken: '',
          scopes: ['user:inference'],
        },
      }),
    /完整 OAuth/,
  )
  assert.throws(
    () => officialLoginCredentialToOauth({ claudeAiOauth: { accessToken: 'at', scopes: ['user:inference'] } }),
    /完整 OAuth/,
  )
})

test('auth login session stays reusable until force regenerate or login_ready', () => {
  const session = {
    alive: true,
    auth_url: 'https://claude.com/cai/oauth/authorize?code=true',
    expired: false,
    status: 'waiting_auth',
  }
  assert.equal(isPersistentAuthLoginSession(session), true)
  assert.equal(isPersistentAuthLoginSession(session, { force: true }), false)
  assert.equal(isPersistentAuthLoginSession({ ...session, status: 'login_ready' }), false)
  assert.equal(isPersistentAuthLoginSession({ ...session, alive: false }), false)
})

test('assertAuthLoginReady refuses a missing container and a missing cli-node', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-ready-'))
  const stopped = () => ({ running: false })
  const running = () => ({ running: true })
  try {
    fs.mkdirSync(path.join(root, 'vms', 'vm-01'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01' }))
    assert.throws(
      () => assertAuthLoginReady(root, { id: 'vm-01' }, { inspect: stopped }),
      (err) => err.code === 'container_not_ready',
    )
    const home = path.join(root, 'vms', 'vm-01', 'cli-home', '.kin')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'cli-node'), '')
    assert.throws(
      () => assertAuthLoginReady(root, { id: 'vm-01' }, { inspect: stopped }),
      (err) => err.code === 'container_not_ready',
    )
    assert.throws(
      () => assertAuthLoginReady(root, { id: 'vm-missing' }, { inspect: running }),
      (err) => err.code === 'cli_node_missing',
    )
    assert.throws(
      () => assertAuthLoginReady(root, { id: 'vm-01', node_id: 'node-a' }, { inspect: running }),
      (err) => err.code === 'remote_unsupported',
    )
    assert.equal(assertAuthLoginReady(root, { id: 'vm-01' }, { inspect: running }).container, 'kin-01')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a live login session is not reused after the container stops or cli-node disappears', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-reuse-'))
  const vm = { id: 'vm-01' }
  const running = () => ({ running: true })
  const stopped = () => ({ running: false })
  try {
    const home = path.join(root, 'vms', 'vm-01', 'cli-home', '.kin')
    fs.mkdirSync(home, { recursive: true })
    const cli = path.join(home, 'cli-node')
    fs.writeFileSync(cli, '')
    const dir = authLoginSessionDir(root, 'vm-01')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'pty.pid'), `${process.pid}\n`)
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        session_id: 'live-login',
        auth_url: 'https://claude.com/cai/oauth/authorize?code=true&live=1',
        status: 'waiting_auth',
        expires_at: Date.now() + 60_000,
        updated_at: Date.now(),
      }),
    )
    const reused = await startClaudeAuthLoginSession({ vm, projectRoot: root, inspect: running })
    assert.equal(reused.reused, true)
    assert.equal(reused.session_id, 'live-login')
    await assert.rejects(
      () => startClaudeAuthLoginSession({ vm, projectRoot: root, inspect: stopped }),
      (err) => err.code === 'container_not_ready',
    )
    fs.rmSync(cli)
    await assert.rejects(
      () => startClaudeAuthLoginSession({ vm, projectRoot: root, inspect: running }),
      (err) => err.code === 'cli_node_missing',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fake claude_code login returns the official CAI url and a full oauth grant', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-fake-'))
  try {
    fs.mkdirSync(path.join(root, 'vms', 'vm-01', 'cli-home', '.kin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'vm-01', 'cli-home', '.kin', 'cli-node'), '')
    const started = await startClaudeAuthLoginSession({
      vm: { id: 'vm-01' },
      projectRoot: root,
      inspect: () => ({ running: true }),
    })
    assert.equal(started.flavor, 'claude_code')
    assert.equal(started.source, 'claude-auth-login')
    assert.match(started.auth_url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/)
    const cred = await completeClaudeAuthLogin({
      projectRoot: '/tmp/unused',
      vmId: 'vm-01',
      sessionId: started.session_id,
      code: 'pasted-code#state',
    })
    assert.equal(cred.email, 'fake-oauth@kin.test')
    assert.equal(cred.mode, 'oauth')
    assert.match(cred.scope, /user:file_upload/)
    assert.ok(cred.refresh_token)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    delete process.env.KIN_FAKE_SESSION_OAUTH
  }
})

test('stopClaudeAuthLoginSession pkills auth login, not setup-token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-stop-'))
  try {
    fs.mkdirSync(path.join(root, 'vms'))
    fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02', runtime: { type: 'docker' } }))
    const seen = []
    await stopClaudeAuthLoginSession(root, 'vm-02', {
      spawn: (bin, argv) => {
        seen.push({ bin, argv })
        return { status: 0 }
      },
    })
    assert.equal(seen[0].bin, 'docker')
    assert.deepEqual(seen[0].argv.slice(0, 4), ['exec', 'kin-02', 'sh', '-lc'])
    assert.match(seen[0].argv.at(-1), /auth login/)
    assert.doesNotMatch(seen[0].argv.at(-1), /setup-token/)

    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01', runtime: { type: 'kvm' } }))
    const kvm = []
    await stopClaudeAuthLoginSession(root, 'vm-01', {
      spawn: (_bin, argv) => {
        kvm.push(argv)
        return { status: 0 }
      },
    })
    assert.equal(kvm[0][2], KVM_GUEST_EXEC)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
