import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  commitCodexCredentialRefresh,
  readCodexAccounts,
  upsertCodexAccount,
  writeCodexAccounts,
} from '../../src/lib/vm/codex-slot.mjs'

function fixture(t, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-cas-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-1'), { recursive: true })
  const proxy = { host: 'fixture.invalid', port: 1080, username: 'fixture' }
  const vmFile = path.join(root, 'vms', 'vm-1.json')
  fs.writeFileSync(vmFile, JSON.stringify({ id: 'vm-1', platform: 'openai', family: 'codex', proxy }))
  writeCodexAccounts(
    root,
    'vm-1',
    rows || [
      {
        id: 'one',
        email: 'one@example.invalid',
        chatgpt_account_id: 'workspace-one',
        access_token: 'old-at',
        refresh_token: 'old-rt',
        id_token: 'old-id',
        expires_at: 123,
        rpm: 42,
      },
    ],
  )
  return { root, proxy, vmFile, expected: readCodexAccounts(root, 'vm-1')[0] }
}

test('refresh CAS preserves metadata and omitted fields on a current ticket', async (t) => {
  const f = fixture(t)
  const result = await commitCodexCredentialRefresh(f.root, 'vm-1', {
    expected: f.expected,
    proxy: f.proxy,
    patch: { access_token: 'new-at', refresh_token: undefined, id_token: undefined },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(readCodexAccounts(f.root, 'vm-1')[0], { ...f.expected, access_token: 'new-at' })
})

test('a late refresh cannot overwrite a newly verified same-account login', async (t) => {
  const f = fixture(t)
  upsertCodexAccount(
    f.root,
    'vm-1',
    { ...f.expected, access_token: 'verified-at', refresh_token: 'verified-rt' },
    { replaceCredentials: true },
  )
  const result = await commitCodexCredentialRefresh(f.root, 'vm-1', {
    expected: f.expected,
    proxy: f.proxy,
    patch: { access_token: 'late-at', refresh_token: 'late-rt' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'credential_changed')
  assert.equal(result.account.access_token, 'verified-at')
  assert.equal(readCodexAccounts(f.root, 'vm-1')[0].refresh_token, 'verified-rt')
})

test('a rebound account is neither overwritten nor adopted for a retry', async (t) => {
  const f = fixture(t)
  // Simulate an old/native writer bypassing the guarded import API.
  fs.writeFileSync(
    path.join(f.root, 'vms', 'vm-1', 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'two',
          email: 'two@example.invalid',
          chatgpt_account_id: 'workspace-two',
          access_token: 'two-at',
          refresh_token: 'two-rt',
        },
      ],
    }),
  )
  const result = await commitCodexCredentialRefresh(f.root, 'vm-1', {
    expected: f.expected,
    proxy: f.proxy,
    patch: { access_token: 'late-at' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.account, null)
  assert.equal(readCodexAccounts(f.root, 'vm-1')[0].access_token, 'two-at')
})

test('a changed proxy rejects even a current ticket refresh', async (t) => {
  const f = fixture(t)
  const vm = JSON.parse(fs.readFileSync(f.vmFile))
  vm.proxy.host = 'other.invalid'
  fs.writeFileSync(f.vmFile, JSON.stringify(vm))
  const result = await commitCodexCredentialRefresh(f.root, 'vm-1', {
    expected: f.expected,
    proxy: f.proxy,
    patch: { access_token: 'late-at' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.account, null)
  assert.equal(readCodexAccounts(f.root, 'vm-1')[0].access_token, 'old-at')
})

test('a deleted VM is never recreated by late refresh', async (t) => {
  const f = fixture(t)
  fs.unlinkSync(f.vmFile)
  const result = await commitCodexCredentialRefresh(f.root, 'vm-1', {
    expected: f.expected,
    proxy: f.proxy,
    patch: { access_token: 'late-at' },
  })
  assert.equal(result.code, 'vm_not_found')
  assert.equal(fs.existsSync(f.vmFile), false)
  assert.equal(readCodexAccounts(f.root, 'vm-1')[0].access_token, 'old-at')
})
