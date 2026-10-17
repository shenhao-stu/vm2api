import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { standardSeedPolicy, buildSlotSettingsEnv } from '../../src/lib/protocol/seed-policy.mjs'
import { buildWorkerTelemetry } from '../../src/lib/vm/worker-telemetry.mjs'
import {
  normalizeOfficialCcConfig,
  applyOfficialCcConfig,
  finalizeOfficialCcTelemetry,
} from '../../src/lib/oauth/official-cc-bootstrap.mjs'

function forcePrivacy(t) {
  const previous = process.env.VM2API_DISABLE_TELEMETRY
  process.env.VM2API_DISABLE_TELEMETRY = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.VM2API_DISABLE_TELEMETRY
    else process.env.VM2API_DISABLE_TELEMETRY = previous
  })
}

test('deployment telemetry disable overrides slot and explicit bootstrap enable', (t) => {
  forcePrivacy(t)
  const seed = standardSeedPolicy({ telemetry_disabled: false })
  assert.equal(seed.telemetry_disabled, true)
  assert.equal(seed.do_not_track, true)
  const env = buildSlotSettingsEnv({ telemetry_disabled: false, extra_env: { DISABLE_TELEMETRY: '0' } })
  assert.equal(env.DISABLE_TELEMETRY, '1')
  assert.equal(env.DO_NOT_TRACK, '1')
  assert.equal(normalizeOfficialCcConfig({ sync_telemetry: true }).sync_telemetry, false)
  assert.equal(applyOfficialCcConfig({ syncTelemetry: true }, { sync_telemetry: true }).syncTelemetry, false)
})

test('official reinitialization preserves deployment privacy in persisted CLI and worker config', async (t) => {
  forcePrivacy(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-privacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vmId = 'vm-01'
  const home = path.join(root, 'vms', vmId, 'cli-home')
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ machineID: 'aa'.repeat(32), userID: 'bb'.repeat(32) }),
  )
  const vm = { id: vmId, seed_policy: { telemetry_disabled: false }, fingerprint: { session_id: 'test-session' } }
  const vmPath = path.join(root, 'vms', `${vmId}.json`)
  const workerPath = path.join(runDir, 'worker.json')
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  fs.writeFileSync(workerPath, JSON.stringify({ vm_id: vmId, telemetry: { enabled: true } }))
  assert.deepEqual(buildWorkerTelemetry(vm, root), { enabled: false })
  const result = await finalizeOfficialCcTelemetry(root, vmId, {
    enable: true,
    reloadSlot: async () => assert.fail('disabled telemetry must not restart the slot'),
  })
  assert.equal(result.enabled, false)
  assert.equal(result.reloaded, false)
  assert.equal(result.touched, false)
  assert.equal(JSON.parse(fs.readFileSync(vmPath, 'utf8')).seed_policy.telemetry_disabled, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(workerPath, 'utf8')).telemetry, { enabled: false })
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  assert.equal(settings.env.DISABLE_TELEMETRY, '1')
  assert.equal(settings.env.DO_NOT_TRACK, '1')
})
