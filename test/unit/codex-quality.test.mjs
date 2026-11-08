import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { attributedAnswer } from '../../src/lib/admin/codex-quality.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { runCodexKernelHop } from '../../src/lib/protocol/handle-codex.mjs'

const id = 'codex-test'
const model = 'gpt-6.1-sol'
const receipt = { vm_id: id, model, final_state: 'verified', attempt_count: 1 }
const body = {
  status: 'completed',
  output: [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: '21' }] }],
}
test('score requires a completed response with a single attributed receipt', () => {
  assert.equal(attributedAnswer(body, receipt, id, model).text, '21')
  for (const r of [
    null,
    { ...receipt, vm_id: 'other' },
    { ...receipt, attempt_count: 2 },
    { ...receipt, final_state: 'unknown' },
    { ...receipt, model_mismatch: true },
  ])
    assert.equal(attributedAnswer(body, r, id, model).ok, false)
  assert.equal(attributedAnswer({ ...body, status: 'incomplete' }, receipt, id, model).ok, false)
  assert.equal(attributedAnswer({ ...body, model: 'other' }, receipt, id, model).ok, false)
  assert.equal(attributedAnswer({ ...body, safety_buffering: 'true' }, receipt, id, model).debug.safety_buffering, null)
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

test('verified account safety observations survive a model downgrade without voting on the answer', () => {
  const out = attributedAnswer(
    { ...body, model: 'gpt-6-luna', safety_buffering: true },
    { ...receipt, upstream_model: 'gpt-6-luna', model_mismatch: true },
    id,
    model,
  )
  assert.equal(out.ok, false)
  assert.equal(out.vm_id, id)
  assert.equal(out.debug.safety_buffering, true)
  assert.equal(out.debug.upstream_model, 'gpt-6-luna')
  assert.equal(out.text, undefined)
  const other = attributedAnswer({ ...body, safety_buffering: true }, { ...receipt, vm_id: 'other' }, id, model)
  assert.equal(other.debug, undefined, 'other accounts must not contribute a signal')
})

test('quality configuration is bounded and never substituted for the observed safety flag', () => {
  const out = attributedAnswer(
    {
      ...body,
      safety_buffering_enabled: 'true',
      safety_buffering_faster_model: 'gpt-6-luna',
      safety_buffering: 'true',
    },
    receipt,
    id,
    model,
  )
  assert.equal(out.debug.safety_buffering, null)
  assert.equal(out.debug.safety_buffering_enabled, 'true')
  assert.equal(out.debug.safety_buffering_faster_model, 'gpt-6-luna')
})
