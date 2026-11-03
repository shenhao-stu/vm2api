import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUpdateStatus, startHostUpgrade } from '../../src/lib/admin/release.mjs'

test('hosted release status and update never fetch or execute the upstream installer', async () => {
  const forbidden = () => {
    throw new Error('unexpected external operation')
  }
  const env = { VM2API_RELEASE_CHANNEL: 'hosted' }
  const status = await buildUpdateStatus({ env, currentVersion: '1.4.038', fetchImpl: forbidden })
  assert.equal(status.managed_release, true)
  assert.equal(status.release_channel, 'dev/hosted')
  assert.equal(status.update_available, false)
  assert.equal(status.upgrade_command, '')
  const result = await startHostUpgrade({
    env,
    confirm: true,
    version: '1.4.099',
    fetchImpl: forbidden,
    execFileImpl: forbidden,
  })
  assert.equal(result.status, 409)
  assert.equal(result.error.code, 'hosted_release_pinned')
})
