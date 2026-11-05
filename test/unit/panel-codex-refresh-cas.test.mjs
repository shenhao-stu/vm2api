import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../../src/lib/vm/codex-slot.mjs'

function fixture(t, refresh) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-codex-cas-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-1'), { recursive: true })
  const vmFile = path.join(root, 'vms', 'vm-1.json')
  fs.writeFileSync(
    vmFile,
    JSON.stringify({
      id: 'vm-1',
      platform: 'openai',
      family: 'codex',
      schedule_off: true,
      proxy: { url: 'socks5h://proxy.example.invalid:1080' },
    }),
  )
  upsertCodexAccount(root, 'vm-1', {
    id: 'fixture',
    email: 'one@example.invalid',
    chatgpt_account_id: 'workspace-one',
    access_token: 'old-at',
    refresh_token: 'old-rt',
  })
  let response,
    scheduled = 0
  const handler = createPanelHandler({
    cfg: { paths: { project: root }, vm: {} },
    requireAuth(req) {
      req.panelUser = 'fixture-admin'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, body) {
      response = { status, body }
      return true
    },
    refreshCodexAccessToken: refresh,
    reauthManager: {
      schedule: async () => {
        scheduled++
        return { status: 'ready' }
      },
    },
  })
  return {
    root,
    vmFile,
    invoke: async () => {
      await handler({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/vm-1/oauth/refresh'))
      return { ...response, scheduled }
    },
  }
}

test('explicit refresh rejects a late success without overwriting the verified login', async (t) => {
  let enter, release
  const entered = new Promise((resolve) => {
    enter = resolve
  })
  const delayed = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture(t, async () => {
    enter()
    await delayed
    return { ok: true, access_token: 'late-at', refresh_token: 'late-rt' }
  })
  const pending = f.invoke()
  await entered
  upsertCodexAccount(f.root, 'vm-1', { access_token: 'verified-at', refresh_token: 'verified-rt' })
  release()
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'credential_changed')
  assert.equal(readCodexAccounts(f.root, 'vm-1')[0].refresh_token, 'verified-rt')
  assert.equal(result.scheduled, 0)
})

test('late grant rejection cannot quarantine a new login', async (t) => {
  let enter, release
  const entered = new Promise((resolve) => {
    enter = resolve
  })
  const delayed = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture(t, async () => {
    enter()
    await delayed
    return { ok: false, error: 'refresh_failed', status: 400, auth_code: 'invalid_grant' }
  })
  const pending = f.invoke()
  await entered
  upsertCodexAccount(f.root, 'vm-1', { access_token: 'verified-at', refresh_token: 'verified-rt' })
  release()
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(result.scheduled, 0)
  assert.equal(JSON.parse(fs.readFileSync(f.vmFile)).unschedulable, undefined)
})
