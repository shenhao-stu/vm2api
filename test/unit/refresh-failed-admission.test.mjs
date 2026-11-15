import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evaluateCredentialEligibility, credPanelUnavailable } from '../../src/lib/pool/schedule-eligibility.mjs'
import { isCredentialRefreshFailed } from '../../src/lib/pool/availability.mjs'
import { markVmRefreshError } from '../../src/lib/oauth/oauth-credentials.mjs'

const now = Date.now()
const expired = { has_access: true, has_refresh: true, expires_at: now - 60_000, refresh_error: 'refresh_failed' }

test('recorded refresh_failed with expired access cannot dispatch another model request', () => {
  const vm = { claude: expired }
  assert.equal(evaluateCredentialEligibility({ vm, now }).ok, false)
  assert.equal(isCredentialRefreshFailed({ vm, now }), true)
  assert.equal(credPanelUnavailable({ has_token: true, has_refresh: true, refresh_error: 'refresh_failed' }, expired.expires_at, now), true)
})

test('retryable refresh failures and a later healthy access token are not revoked grants', () => {
  const vm = { claude: { ...expired, refresh_class: 'retryable' } }
  assert.equal(evaluateCredentialEligibility({ vm, now }).ok, true)
  assert.equal(isCredentialRefreshFailed({ vm, now }), false)
  const fresh = { claude: { ...expired, expires_at: now + 3600_000 } }
  assert.equal(evaluateCredentialEligibility({ vm: fresh, now }).ok, true)
  assert.equal(isCredentialRefreshFailed({ vm: fresh, now }), false)
})

test('old generic failure never hides a current rejected grant or a permanent pause', () => {
  const vm = { claude: { ...expired, expires_at: now + 3600_000 } }
  const workerStatus = { ok: false, last_error: 'invalid_grant' }
  assert.equal(evaluateCredentialEligibility({ vm, workerStatus, now }).ok, false)
  const paused = { schedule_disabled_reason: 'oauth_invalid_grant', claude: { ...expired, refresh_class: 'retryable' } }
  assert.equal(isCredentialRefreshFailed({ vm: paused, now }), true)
})

test('refresh rejection records evidence and parks expired access without labelling it revoked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-admission-'))
  try {
    const file = path.join(dir, 'vm.json')
    fs.writeFileSync(file, JSON.stringify({ status: 'running', schedulable: true, claude: expired }))
    markVmRefreshError(file, { ok: false, status: 400, error: { code: 'refresh_failed' } })
    const vm = JSON.parse(fs.readFileSync(file))
    assert.equal(vm.schedulable, false)
    assert.equal(vm.status, 'running')
    assert.equal(vm.schedule_disabled_reason, 'credential_refresh_failed')
    assert.equal(vm.claude.refresh_class, 'failed')
    assert.equal(vm.claude.refresh_http_status, 400)
    assert.ok(vm.claude.refresh_failed_at)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('transport failure or quota 429 does not permanently stop an expired refreshable credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-retryable-'))
  try {
    const file = path.join(dir, 'vm.json')
    for (const status of [429, 502]) {
      fs.writeFileSync(file, JSON.stringify({ status: 'running', schedulable: true, claude: expired }))
      markVmRefreshError(file, { ok: false, status, error: { code: 'refresh_failed' } })
      const vm = JSON.parse(fs.readFileSync(file))
      assert.equal(vm.schedulable, true)
      assert.equal(evaluateCredentialEligibility({ vm, now }).ok, true)
      assert.equal(vm.claude.refresh_class, 'retryable')
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
