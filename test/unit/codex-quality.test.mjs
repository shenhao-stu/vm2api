import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexQualityMonitor, judgeQuality, nextQualityState } from '../../src/lib/admin/codex-quality.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { getVm, setScheduleOff, markUnschedulable, setCodexQualityPause } from '../../src/lib/vm/vm-registry.mjs'
import { runCodexKernelHop } from '../../src/lib/protocol/handle-codex.mjs'

const id = 'codex-test'
const receipt = { vm_id: id, model: 'gpt-6.1-sol', final_state: 'verified', attempt_count: 1 }
const body = (text) => ({
  status: 'completed',
  output: [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text }] }],
})
test('only an attributed complete bare answer is scored', () => {
  assert.equal(judgeQuality(body('21'), receipt, id), 'correct')
  assert.equal(judgeQuality(body('22'), receipt, id), 'wrong')
  assert.equal(judgeQuality(body('21 or 22'), receipt, id), 'invalid')
  for (const r of [
    null,
    { ...receipt, vm_id: 'other' },
    { ...receipt, attempt_count: 2 },
    { ...receipt, final_state: 'incomplete' },
  ]) {
    assert.equal(judgeQuality(body('22'), r, id), 'unverified')
  }
  assert.equal(judgeQuality(body('22'), { ...receipt, model_mismatch: true }, id), 'model_mismatch')
})
test('incomplete/error observations cannot vote; confirmation is a separate due observation', () => {
  const s = nextQualityState({}, 'wrong', false, 0)
  for (const result of ['transport_error', 'http_429', 'invalid', 'unverified'])
    assert.equal(nextQualityState(s, result, false, 1).wrong, 1)
  const hold = nextQualityState(s, 'wrong', false, 2)
  assert.equal(hold.action, 'pause')
  const pass = nextQualityState(hold, 'correct', true, hold.due)
  assert.equal(pass.due, hold.due + 600000)
  assert.equal(nextQualityState(pass, 'http_502', true, pass.due).first_pass, null)
  assert.equal(nextQualityState(pass, 'correct', true, pass.due).action, 'recover')
})
test('serial round consumes uncertain attempts, respects holds and only owns its quality pause', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-quality-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'vms', id), { recursive: true })
  writeFileSync(
    path.join(root, 'vms', id + '.json'),
    JSON.stringify({
      id,
      platform: 'openai',
      family: 'codex',
      status: 'stopped',
      schedulable: true,
      proxy: { id: 'px', url: 'socks5h://127.0.0.1:9999', host: '127.0.0.1', port: 9999 },
    }),
  )
  writeFileSync(
    path.join(root, 'vms', id, 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ email: 'test@example.invalid', chatgpt_account_id: id, access_token: 'fixture' }] }),
  )
  const m = new Map()
  const settings = () => ({ get: (k, d) => m.get(k) ?? d, set: (k, v) => m.set(k, v) })
  let result = 'wrong',
    calls = 0,
    now = 10000000
  const options = {
    project: root,
    settings,
    now: () => now,
    quotaPolicy: () => ({}),
    measure: async () => {
      calls++
      return result
    },
  }
  const monitor = new CodexQualityMonitor(options)
  await monitor.run(true)
  await monitor.run(true)
  assert.equal(calls, 2)
  assert.equal(getVm(root, id).schedule_off_reason, 'quality_probe_failed')
  result = 'correct'
  await monitor.run(true)
  assert.equal(calls, 2)
  now += 86400000
  await monitor.run(true)
  assert.equal(calls, 3)
  const resumed = new CodexQualityMonitor(options)
  now += 599999
  await resumed.run(true)
  assert.equal(calls, 3)
  now++
  await resumed.run(true)
  assert.equal(calls, 4)
  assert.equal(getVm(root, id).schedulable, true)
  setCodexQualityPause(root, id, true)
  markUnschedulable(root, id, 'oauth_revoked')
  setCodexQualityPause(root, id, false)
  assert.equal(getVm(root, id).unschedulable.reason, 'oauth_revoked')
  setScheduleOff(root, id, true, { reason: 'operator' })
  await resumed.run(true)
  assert.equal(calls, 4)
})
test('known oversized Codex request is rejected before any body arrives; chunked and invalid JSON are bounded', async () => {
  const req = new PassThrough()
  req.url = '/v1/responses'
  req.headers = { 'content-length': '9999999' }
  await assert.rejects(readBody(req, 8), (e) => e.status === 413)
  req.end()
  const chunked = new PassThrough()
  chunked.url = req.url
  const reading = readBody(chunked, 8)
  chunked.end('123456789')
  await assert.rejects(reading, (e) => e.status === 413)
  const broken = new PassThrough()
  broken.url = req.url
  const b = readBody(broken, 100)
  broken.end('invalid-api-key-material')
  await assert.rejects(b, (e) => e.status === 400 && !JSON.stringify(e).includes('invalid-api-key-material'))
})
test('single-attempt quality probe cannot retry an uncertain transport', async () => {
  let calls = 0
  const out = await runCodexKernelHop({
    args: { singleAttempt: true },
    hop: async () => {
      calls++
      return { status: 0, ok: false, transportError: true }
    },
  })
  assert.equal(calls, 1)
  assert.equal(out.ok, false)
})

test('quality exit requires two matching replies and never learns a changed address', async () => {
  const { checkQualityExit } = await import('../../src/lib/pool/codex-quality-exit.mjs')
  const binding = { ip: '192.0.2.8', url: 'socks5h://127.0.0.1:12345' }
  assert.equal(await checkQualityExit(null, () => assert.fail()), false)
  for (const replies of [
    ['192.0.2.8', '192.0.2.8'],
    ['192.0.2.8', '192.0.2.9'],
  ]) {
    const expected = replies[0] === replies[1]
    assert.equal(
      await checkQualityExit(binding, async (_, opts) => {
        assert.ok(opts.agent)
        return new Response(replies.shift())
      }),
      expected,
    )
  }
  assert.equal(binding.ip, '192.0.2.8')
})
