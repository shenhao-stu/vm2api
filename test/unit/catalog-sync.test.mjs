import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { loadModelPolicy, getModelPolicy } from '../../src/lib/protocol/model-policy.mjs'
import {
  loadGptModelPolicy,
  getGptModelPolicy,
  syncGptIdsIntoPolicy,
} from '../../src/lib/protocol/gpt-model-policy.mjs'
import { clearModelsCache } from '../../src/lib/protocol/models.mjs'
import {
  claudeCatalogBusy,
  readCatalogSync,
  syncClaudeCatalog,
  syncGptCatalog,
} from '../../src/lib/admin/catalog-monitor.mjs'

function seedClaudeVm(root, id) {
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      status: 'running',
      claude: { access_token: 'at', refresh_token: 'rt', account_uuid: `acc-${id}` },
      proxy: { url: 'socks5h://127.0.0.1:1080' },
    }),
  )
}

function withDb(t, catalogMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-catalog-sync-'))
  openDatabase({ dbPath: ':memory:' })
  if (catalogMode) new SettingsRepo().set('model_policy', { catalog_mode: catalogMode, models: {} })
  loadModelPolicy({ force: true })
  loadGptModelPolicy({ force: true })
  clearModelsCache()
  t.after(() => {
    closeDatabase()
    loadModelPolicy({ force: true })
    loadGptModelPolicy({ force: true })
    clearModelsCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

const upstream = (ids) => async () => ({ ok: true, status: 200, body: { data: ids.map((id) => ({ id })) } })

test('a Claude id new to the policy is added disabled outside worker_only', async (t) => {
  const root = withDb(t, 'policy_only')
  seedClaudeVm(root, 'vm-1')
  const before = getModelPolicy().models['claude-opus-5']
  const status = await syncClaudeCatalog({
    projectRoot: root,
    runOauth: upstream(['claude-opus-5', 'claude-opus-6-preview']),
  })
  assert.equal(status.status, 'ok')
  assert.deepEqual(status.added, ['claude-opus-6-preview'])
  const models = getModelPolicy().models
  assert.equal(models['claude-opus-6-preview'].enabled, false)
  assert.deepEqual(models['claude-opus-5'], before)
  assert.equal(readCatalogSync().claude.status, 'ok')
})

test('worker_only publishes a new Claude id immediately', async (t) => {
  const root = withDb(t, 'worker_only')
  seedClaudeVm(root, 'vm-1')
  await syncClaudeCatalog({ projectRoot: root, runOauth: upstream(['claude-opus-6-preview']) })
  assert.equal(getModelPolicy().models['claude-opus-6-preview'].enabled, true)
})

test('Claude sync without a reachable slot records the failure and changes nothing', async (t) => {
  const root = withDb(t, 'policy_only')
  seedClaudeVm(root, 'vm-1')
  const before = structuredClone(getModelPolicy().models)
  const status = await syncClaudeCatalog({
    projectRoot: root,
    runOauth: async () => ({ ok: false, status: 401, body: { error: { code: 'upstream_auth' } } }),
  })
  assert.equal(status.status, 'error')
  assert.equal(status.error, 'upstream_auth')
  assert.deepEqual(getModelPolicy().models, before)
})

test('a new GPT id stays disabled until review; known ids keep their switch', (t) => {
  withDb(t)
  const result = syncGptIdsIntoPolicy([{ id: 'gpt-5.6' }, { id: 'gpt-7-preview' }])
  assert.deepEqual(result.added, ['gpt-7-preview'])
  const models = getGptModelPolicy().models
  assert.equal(models['gpt-5.6'].enabled, true)
  assert.equal(models['gpt-7-preview'].enabled, false)
  assert.ok(!result.ids.includes('gpt-7-preview'))
})

test('GPT sync persists safe discovery totals and client version for the model page', async (t) => {
  const root = withDb(t)
  const id = 'vm-codex-sync'
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      status: 'running',
      family: 'codex',
      platform: 'openai',
      schedulable: true,
      proxy: { url: 'socks5h://127.0.0.1:1080' },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ access_token: 'private-access-ticket', refresh_token: 'private-refresh-ticket' }],
    }),
  )
  const result = await syncGptCatalog({
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    fetchImpl: async (url) => {
      assert.ok(String(url).includes('/codex/models?'))
      return { status: 200, json: async () => ({ models: [{ slug: 'gpt-status-discovery' }] }) }
    },
  })
  assert.equal(result.ok, true)
  const status = readCatalogSync().codex
  assert.equal(status.status, 'ok')
  assert.equal(status.synced, 1)
  assert.equal(status.catalog_version, '0.164.0')
  assert.equal(status.interval_sec, 21600)
  assert.equal(status.attempted_accounts, 1)
  assert.equal(status.successful_accounts, 1)
  assert.deepEqual(status.added, ['gpt-status-discovery'])
  assert.ok(!JSON.stringify(status).includes('private-'))
})

test('background Claude catalog rechecks business occupancy before each metadata hop', async (t) => {
  const root = withDb(t)
  seedClaudeVm(root, 'vm-a')
  seedClaudeVm(root, 'vm-b')
  const seen = []
  const result = await syncClaudeCatalog({
    projectRoot: root,
    isBusy: (vm) => seen.length > 0 || vm.id !== 'vm-a',
    runOauth: async (exec) => {
      seen.push(exec.vmId)
      return upstream(['claude-opus-5'])()
    },
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(seen, ['vm-a'])
  const busy = await syncClaudeCatalog({
    projectRoot: root,
    isBusy: () => true,
    runOauth: () => assert.fail('busy Claude slot dispatched'),
  })
  assert.equal(busy.status, 'skipped')
})

test('periodic metadata yields to account cooldowns and reserves half-open recovery for inference', () => {
  const now = Date.now()
  let state = 'closed'
  let until = now - 1
  const scheduler = {
    queuedTotal: () => 0,
    vmInflight: new Map(),
    inflight: new Map(),
    runtimeRepo: { get: () => ({ cooldown_until: until }) },
    unitCircuit: { view: () => ({ state }) },
  }
  const busy = () => claudeCatalogBusy(scheduler, 'vm', 'account', now)
  assert.equal(busy(), false)
  until = new Date(now + 60000).toISOString()
  assert.equal(busy(), true)
  until = null
  for (state of ['open', 'half_open']) assert.equal(busy(), true)
  state = 'closed'
  scheduler.inflight.set('account', 1)
  assert.equal(busy(), true)
})
