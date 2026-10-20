import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { DEFAULT_CLAUDE_SETTING } from '../../src/lib/protocol/seed-policy.mjs'

function seed(root, id) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'stopped',
      seed_policy: { claude_setting: 'FROM_POLICY=1' },
    }),
  )
}

function handler(project, { readBody = async () => ({}) } = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project }, vm: { id: null } },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody,
    proxyPool: {
      unbindVm() {},
      followProxyTimezoneEnabled() {
        return true
      },
      proxyTimezone() {
        return 'Asia/Shanghai'
      },
      timezoneForVm() {
        return 'Asia/Shanghai'
      },
    },
  })
  return { handlePanel, response }
}

test('GET seed-settings keeps a missing claude.setting null', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-get-'))
  try {
    seed(root, 'vm-01')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-01/seed-settings'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.equal(response.body.data.claude_setting, null)
    assert.equal(response.body.data.settings_json, null)
    assert.equal(response.body.data.seed_policy.claude_setting, 'FROM_POLICY=1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET seed-settings returns an empty claude.setting file as empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-empty-'))
  try {
    seed(root, 'vm-01')
    const dir = path.join(root, 'vms', 'vm-01', 'cli-home', '.claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'claude.setting'), '\n')
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { TZ: 'UTC' } }))
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-01/seed-settings'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.equal(response.body.data.claude_setting, '')
    assert.equal(response.body.data.seed_policy.claude_setting, '')
    assert.equal(response.body.data.settings_json.env.TZ, 'UTC')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PUT seed-settings can follow proxy timezone and locale before writing files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-put-tz-'))
  try {
    seed(root, 'vm-01')
    const vmPath = path.join(root, 'vms', 'vm-01.json')
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    vm.timezone = 'UTC'
    vm.timezone_source = 'manual'
    vm.locale = 'en_US.UTF-8'
    vm.proxy = { id: 'px-1' }
    fs.writeFileSync(vmPath, JSON.stringify(vm))
    const body = {
      telemetry_disabled: true,
      claude_setting: 'X=1',
      extra_env: { CUSTOM: 'yes' },
      theme: 'dark',
      timezone_follow_proxy: true,
      locale: 'zh_CN.UTF-8',
    }
    const { handlePanel, response } = handler(root, {
      readBody: async () => body,
    })
    await handlePanel(
      { method: 'PUT', url: '/api/panel/vms/vm-01/seed-settings' },
      {},
      new URL('http://localhost/api/panel/vms/vm-01/seed-settings'),
    )
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(saved.locale, 'zh_CN.UTF-8')
    assert.equal(saved.timezone, 'Asia/Shanghai')
    assert.equal(response.body.data.settings_json.env.TZ, 'Asia/Shanghai')
    assert.equal(response.body.data.settings_json.env.LANG, 'zh_CN.UTF-8')
    assert.equal(response.body.data.settings_json.env.CUSTOM, 'yes')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET seed-settings returns the upload log only when debug is on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-log-'))
  try {
    seed(root, 'vm-01')
    const run = path.join(root, 'vms', 'vm-01', 'run')
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(
      path.join(run, 'telemetry-upload.log'),
      'old\n2026-10-19T00:00:00Z batch tengu_init ok {"event_type":"x"}\n',
    )
    const hidden = handler(root)
    await hidden.handlePanel(
      { method: 'GET', url: '/api/panel/vms/vm-01/seed-settings' },
      {},
      new URL('http://localhost/api/panel/vms/vm-01/seed-settings'),
    )
    assert.equal(hidden.response.body.data.telemetry_log, undefined)
    const shown = handler(root)
    await shown.handlePanel(
      { method: 'GET', url: '/api/panel/vms/vm-01/seed-settings?debug=1' },
      {},
      new URL('http://localhost/api/panel/vms/vm-01/seed-settings?debug=1'),
    )
    assert.deepEqual(shown.response.body.data.telemetry_log, [
      'old',
      '2026-10-19T00:00:00Z batch tengu_init ok {"event_type":"x"}',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('seed edits and a telemetry restart cannot override deployment telemetry off', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-forced-off-'))
  const savedPath = process.env.PATH
  const savedOff = process.env.VM2API_DISABLE_TELEMETRY
  process.env.VM2API_DISABLE_TELEMETRY = '1'
  const calls = path.join(root, 'docker-calls.jsonl')
  fs.writeFileSync(
    path.join(root, 'docker'),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');`,
    { mode: 0o755 },
  )
  process.env.PATH = `${root}:${savedPath || ''}`
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedOff === undefined) delete process.env.VM2API_DISABLE_TELEMETRY
    else process.env.VM2API_DISABLE_TELEMETRY = savedOff
    fs.rmSync(root, { recursive: true, force: true })
  })
  seed(root, 'vm-guard')
  const vmPath = path.join(root, 'vms', 'vm-guard.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  Object.assign(vm, {
    status: 'running',
    runtime: { type: 'docker' },
    proxy: { id: 'px-local', scheme: 'local', host: 'local' },
    seed_policy: { telemetry_disabled: false },
  })
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'worker.json'), JSON.stringify({ telemetry: { enabled: true } }))
  const { handlePanel, response } = handler(root, {
    readBody: async () => ({
      telemetry_disabled: false,
      telemetry_service_restart: true,
      extra_env: { DISABLE_TELEMETRY: '0', DO_NOT_TRACK: '0', CUSTOM: 'kept' },
      settings_json_override: { env: { DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' } },
      claude_setting: 'DISABLE_TELEMETRY=0',
    }),
  })
  await handlePanel(
    { method: 'PUT', url: '/api/panel/vms/vm-guard/seed-settings' },
    {},
    new URL('http://localhost/api/panel/vms/vm-guard/seed-settings'),
  )
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const data = response.body.data
  assert.equal(data.seed_policy.telemetry_disabled, true)
  assert.equal(data.telemetry_enabled, false)
  assert.equal(data.settings_json.env.DISABLE_TELEMETRY, '1')
  assert.equal(data.settings_json.env.DO_NOT_TRACK, '1')
  assert.equal(data.settings_json.env.CUSTOM, 'kept')
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'worker.json'), 'utf8')).telemetry.enabled, false)
  assert.equal(data.service.ok, true)
  assert.equal(data.service.telemetry.action, 'stopped')
  const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(commands.length, 1)
  assert.match(commands[0].at(-1), /pkill -TERM -x kin-worker/)
})

test('native privacy opt-outs survive subsequent seed edits without changing slot bindings', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-privacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root, 'vm-privacy')
  const vmPath = path.join(root, 'vms', 'vm-privacy.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.proxy = { id: 'px-private', host: '192.0.2.1', port: 1080 }
  vm.policy = { maxConcurrency: 1 }
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  const optOuts = {
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  }
  const url = new URL('http://localhost/api/panel/vms/vm-privacy/seed-settings')
  for (const body of [{ telemetry_disabled: true, extra_env: { CUSTOM: 'kept', ...optOuts } }, { theme: 'dark' }]) {
    const { handlePanel, response } = handler(root, { readBody: async () => body })
    await handlePanel({ method: 'PUT', url: url.pathname }, {}, url)
    assert.equal(response.status, 200)
    assert.equal(response.body.data.service, null)
    const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const settings = JSON.parse(fs.readFileSync(path.join(root, 'vms', vm.id, 'cli-home/.claude/settings.json')))
    for (const [key, value] of Object.entries(optOuts)) {
      assert.equal(saved.seed_policy.extra_env[key], value)
      assert.equal(settings.env[key], value)
    }
    assert.equal(settings.env.CUSTOM, 'kept')
    assert.equal(settings.env.DISABLE_TELEMETRY, '1')
    assert.equal(settings.env.DO_NOT_TRACK, '1')
    assert.deepEqual(saved.proxy, vm.proxy)
    assert.deepEqual(saved.policy, vm.policy)
    assert.equal(saved.status, 'stopped')
  }
})
