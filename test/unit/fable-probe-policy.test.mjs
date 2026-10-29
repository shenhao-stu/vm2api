import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { saveModelPolicy, seedDefaultPolicy } from '../../src/lib/protocol/model-policy.mjs'
import { probeFableEntitlement } from '../../src/lib/oauth/crs-usage-probe.mjs'

function fixture(t, { disabled = [], allowed = null, defaultsEnabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-probe-policy-'))
  const trace = path.join(dir, 'worker.json')
  const previous = { mock: process.env.KIN_CRS_MOCK, trace: process.env.KIN_CRS_TRACE_FILE }
  process.env.KIN_CRS_MOCK = '1'
  process.env.KIN_CRS_TRACE_FILE = trace
  openDatabase({ dbPath: ':memory:' })
  const policy = seedDefaultPolicy()
  for (const id of disabled) policy.models[id].enabled = false
  policy.defaults.enabled = defaultsEnabled
  saveModelPolicy(policy)
  t.after(() => {
    closeDatabase()
    for (const [key, value] of Object.entries({ KIN_CRS_MOCK: previous.mock, KIN_CRS_TRACE_FILE: previous.trace })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { trace, exec: { vmId: 'test-policy', homeDir: dir, vm: { policy: { allowed_models: allowed } } } }
}

test('disabled Fable models cause no worker request or tier reclassification', async (t) => {
  const { trace, exec } = fixture(t, { disabled: ['claude-fable-5', 'claude-fable-5-1'] })
  const result = await probeFableEntitlement({ exec })
  assert.equal(fs.existsSync(trace), false, 'model policy must apply to entitlement probes')
  assert.deepEqual(result, { tier: null, fable: null })
})

test('slot allowlist prevents Fable probes even when the gateway enables Fable', async (t) => {
  const { trace, exec } = fixture(t, { allowed: ['claude-sonnet-5-5', 'claude-opus-5-5'] })
  const result = await probeFableEntitlement({ exec })
  assert.equal(fs.existsSync(trace), false, 'probe must honor the slot allowlist')
  assert.deepEqual(result, { tier: null, fable: null })
})

test('probe can still use an enabled and explicitly allowed Fable model', async (t) => {
  const { trace, exec } = fixture(t, { allowed: ['claude-fable-5'], disabled: ['claude-fable-5-1'] })
  const result = await probeFableEntitlement({ exec })
  assert.equal(result.tier, 'max')
  assert.equal(JSON.parse(fs.readFileSync(trace, 'utf8')).body.model, 'claude-fable-5')
})

test('closed catalog denies future Fable probe ids', async (t) => {
  const { trace, exec } = fixture(t, { defaultsEnabled: false })
  const result = await probeFableEntitlement({ exec, models: ['claude-fable-99'] })
  assert.equal(fs.existsSync(trace), false)
  assert.deepEqual(result, { tier: null, fable: null })
})
