import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { streamCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`
const error = { type: 'service_unavailable_error', code: 'server_is_overloaded', message: 'Server overloaded' }
const failedUsage = { input_tokens: 999, output_tokens: 777 }
const successUsage = { input_tokens: 7, output_tokens: 3 }
const successImageUsage = { input_tokens: 2, output_tokens: 5, num_images: 1 }
const opaque = { type: 'reasoning', id: 'rs_opaque', summary: [], encrypted_content: 'fixture-encrypted-reasoning' }

function progress(id, { reasoning = true } = {}) {
  return [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type: 'response.in_progress', response: { id, status: 'in_progress', output: [] } },
    ...(reasoning
      ? [
          { type: 'response.output_item.added', output_index: 0, item: opaque },
          { type: 'response.output_item.done', output_index: 0, item: opaque },
        ]
      : []),
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'image_generation_call', id: `${id}_img`, status: 'in_progress' },
    },
    { type: 'response.image_generation_call.in_progress', item_id: `${id}_img`, output_index: 1 },
    { type: 'response.image_generation_call.generating', item_id: `${id}_img`, output_index: 1 },
  ]
    .map(frame)
    .join('')
}

function success(res, id, bytes = Buffer.from('fixture image bytes')) {
  const image = {
    type: 'image_generation_call',
    id: `${id}_img`,
    status: 'completed',
    result: bytes.toString('base64'),
  }
  res.write(progress(id))
  res.write(frame({ type: 'response.image_generation_call.completed', item_id: image.id, output_index: 1 }))
  res.write(frame({ type: 'response.output_item.done', output_index: 1, item: image }))
  res.end(
    frame({
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [opaque, image],
        usage: successUsage,
        tool_usage: { image_gen: successImageUsage },
      },
    }),
  )
}

function failure(id, type = 'response.failed', ending = '\n\n') {
  const response = {
    id,
    status: type === 'response.incomplete' ? 'incomplete' : 'failed',
    output: [opaque],
    error,
    usage: failedUsage,
    tool_usage: { image_gen: { input_tokens: 999, output_tokens: 999, num_images: 999 } },
  }
  const event =
    type === 'error'
      ? { type, error, usage: failedUsage }
      : type === 'flat_error'
        ? { ...error, type: 'error', usage: failedUsage }
        : type === 'response.failed.top_error'
          ? { type: 'response.failed', error, response: { ...response, error: undefined } }
          : { type, response }
  return `data: ${JSON.stringify(event)}${ending}`
}

function eventsFrom(wire) {
  return wire
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
}

function gate() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('fixture did not finish promptly')), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(t, programs) {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync('/tmp/c2a-image-overload-')
  const seen = [],
    outcomes = [],
    cancellations = [],
    order = [],
    sockets = new Set(),
    servers = [],
    jobs = new Map()
  const cancelled = gate()
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const [index, program] of programs.entries()) {
    const id = `vm-${String.fromCharCode(97 + index)}`
    const run = path.join(root, 'vms', id, 'run')
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        platform: 'openai',
        family: 'codex',
        schedulable: true,
        status: 'running',
      }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [{ access_token: 'fixture-access', refresh_token: 'fixture-refresh', chatgpt_account_id: id }],
      }),
    )
    fs.writeFileSync(path.join(run, 'internal.token'), 'fixture-private-token', { mode: 0o600 })
    const server = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString())
      if (req.url === '/internal/v1/cancel') {
        cancellations.push({ id, requestId: payload.request_id })
        jobs.get(payload.request_id)?.end()
        res.end('{"ok":true}')
        cancelled.resolve()
        return
      }
      assert.equal(req.url, '/internal/v1/codex/responses')
      seen.push({ id, requestId: payload.request_id })
      order.push(`start:${id}`)
      jobs.set(payload.request_id, res)
      res.once('finish', () => order.push(`finish:${id}`))
      res.once('close', () => jobs.delete(payload.request_id))
      res.setHeader('content-type', 'text/event-stream')
      await program(res, { id, payload, seen, order })
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path.join(run, 'codex-kernel.sock'), resolve)
    })
    servers.push(server)
  }
  return {
    seen,
    outcomes,
    cancellations,
    order,
    cancelled: cancelled.promise,
    execute({ stream = true, routing = {}, tools = [{ type: 'image_generation' }] } = {}) {
      const req = Object.assign(new EventEmitter(), { headers: {}, apiKeyKind: 'user' })
      const wire = [],
        logBag = {},
        stats = { errors: 0, requests: 0, by_route: {} }
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        write(chunk) {
          wire.push(String(chunk))
          return true
        },
        end() {
          this.writableEnded = true
        },
      })
      const completion = handleCodexProtocol({
        req,
        res,
        protocol: 'openai.responses',
        ctx: { path: '/v1/responses', body: { model: 'gpt-6-astra', input: 'fixture', tools, stream } },
        inbound: { stream },
        logBag,
        stats,
        json: (_res, status, body) => ({ status, body }),
        writeSSEHeaders: () => {
          res.headersSent = true
        },
        routing: { failover: { codex: { max_same_account_retries: 0 } }, ...routing },
        projectRoot: root,
        ops: {
          writeCodexKernelConfig() {},
          ensureCodexKernel: async () => ({ ok: true }),
          async streamCodexKernel(args) {
            const result = await streamCodexKernel(args)
            outcomes.push({
              id: args.exec.vmId,
              status: result.status,
              committed: result.committed,
              code: result.body?.error?.code,
            })
            return result
          },
        },
      })
      return { req, res, wire, logBag, stats, completion }
    },
  }
}

for (const [type, ending] of [
  ['error', '\n\n'],
  ['flat_error', ''],
  ['response.failed', '\n'],
  ['response.failed.top_error', ''],
  ['response.incomplete', '\n\n'],
  ['response.done', ''],
]) {
  test(`real Unix image ${type} at EOF switches accounts before any client output`, async (t) => {
    const bytes = type === 'error' ? Buffer.alloc(4 * 1024 * 1024, 0xa7) : Buffer.from('second account image')
    const f = await fixture(t, [
      (res) => {
        res.write(progress('resp_failed'))
        res.end(failure('resp_failed', type, ending))
      },
      (res) => success(res, 'resp_success', bytes),
    ])
    const call = f.execute()
    assert.equal(await within(call.completion), undefined)
    assert.deepEqual(
      f.seen.map((entry) => entry.id),
      ['vm-a', 'vm-b'],
    )
    assert.equal(new Set(f.seen.map((entry) => entry.requestId)).size, 2)
    assert.deepEqual(f.outcomes[0], { id: 'vm-a', status: 503, committed: false, code: 'server_is_overloaded' })
    assert.ok(f.order.indexOf('finish:vm-a') < f.order.indexOf('start:vm-b'))
    assert.deepEqual(f.cancellations, [])
    const events = eventsFrom(call.wire)
    assert.equal(events.filter((event) => event.type === 'response.completed').length, 1)
    assert.ok(events.every((event) => !JSON.stringify(event).includes('resp_failed')))
    assert.doesNotMatch(call.wire.join(''), /server_is_overloaded/)
    const images = events.filter(
      (event) => event.type === 'response.output_item.done' && event.item.type === 'image_generation_call',
    )
    assert.equal(images.length, 1)
    assert.deepEqual(Buffer.from(images[0].item.result, 'base64'), bytes)
    assert.deepEqual(call.logBag.image_usage, successImageUsage)
    assert.equal(call.logBag.input_tokens, successUsage.input_tokens)
    assert.equal(call.logBag.output_tokens, successUsage.output_tokens)
    assert.equal(call.logBag.usage.input_tokens, successUsage.input_tokens)
    assert.equal(call.logBag.usage.output_tokens, successUsage.output_tokens)
    assert.equal(call.logBag.attempt_count, 2)
    assert.equal(call.logBag.codex_failed_over, true)
    assert.equal(call.stats.errors, 0)
  })
}

test('image generation progress waits for a real EOF failure before starting another account', async (t) => {
  const started = gate(),
    release = gate()
  const f = await fixture(t, [
    async (res) => {
      res.write(progress('resp_waiting'))
      started.resolve()
      await release.promise
      res.end(failure('resp_waiting'))
    },
    (res) => success(res, 'resp_after_wait'),
  ])
  const call = f.execute()
  await within(started.promise)
  await tick()
  assert.deepEqual(
    f.seen.map((entry) => entry.id),
    ['vm-a'],
  )
  assert.deepEqual(f.cancellations, [])
  assert.deepEqual(call.wire, [])
  assert.equal(call.res.headersSent, false)
  release.resolve()
  await within(call.completion)
  assert.deepEqual(
    f.seen.map((entry) => entry.id),
    ['vm-a', 'vm-b'],
  )
  assert.deepEqual(f.cancellations, [])
})

test('multiple overloaded image accounts recover once on the next account for JSON delivery', async (t) => {
  const bytes = Buffer.from('third account image')
  const f = await fixture(
    t,
    Array.from({ length: 3 }, () => (res, { seen }) => {
      if (seen.length === 3) return success(res, 'resp_third', bytes)
      const id = `resp_failed_${seen.length}`
      res.write(progress(id))
      res.end(failure(id))
    }),
  )
  const call = f.execute({ stream: false })
  const result = await within(call.completion)
  assert.equal(result.status, 200)
  assert.equal(f.seen.length, 3)
  assert.equal(new Set(f.seen.map((entry) => entry.id)).size, 3)
  assert.deepEqual(call.wire, [])
  assert.equal(result.body.id, 'resp_third')
  assert.deepEqual(
    Buffer.from(result.body.output.find((item) => item.type === 'image_generation_call').result, 'base64'),
    bytes,
  )
  assert.deepEqual(result.body.usage, successUsage)
  assert.deepEqual(call.logBag.image_usage, successImageUsage)
  assert.equal(call.logBag.attempt_count, 3)
})

for (const [name, accounts, attempts] of [
  ['attempt budget', 5, 3],
  ['exhausted pool', 3, 64],
]) {
  test(`all overloaded image accounts stop at the ${name} without leaking progress`, async (t) => {
    const f = await fixture(
      t,
      Array.from({ length: accounts }, (_value, index) => (res) => {
        res.write(progress(`resp_busy_${index}`))
        res.end(failure(`resp_busy_${index}`))
      }),
    )
    const call = f.execute({
      routing: {
        failover: {
          codex: { max_total_attempts: attempts, max_account_switches: attempts - 1, max_same_account_retries: 0 },
        },
      },
    })
    const result = await within(call.completion)
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'server_is_overloaded')
    assert.equal(f.seen.length, 3)
    assert.equal(new Set(f.seen.map((entry) => entry.id)).size, 3)
    assert.deepEqual(call.wire, [])
    assert.equal(call.res.headersSent, false)
    assert.equal(call.logBag.attempt_count, 3)
    assert.equal(call.stats.errors, 1)
    assert.deepEqual(f.cancellations, [])
  })
}

for (const [name, event] of [
  ['partial image', { type: 'response.image_generation_call.partial_image', partial_image_b64: 'preview' }],
  [
    'complete image',
    {
      type: 'response.output_item.done',
      item: { type: 'image_generation_call', id: 'img_delivered', result: 'ZGVsaXZlcmVk' },
    },
  ],
  ['text', { type: 'response.output_text.delta', delta: 'visible text' }],
  ['reasoning summary', { type: 'response.reasoning_summary_text.delta', delta: 'visible summary' }],
  [
    'external function',
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'call_external', name: 'image_generation', arguments: '' },
    },
  ],
  [
    'external custom tool',
    {
      type: 'response.output_item.added',
      item: { type: 'custom_tool_call', call_id: 'call_custom', name: 'image_generation', input: '' },
    },
  ],
  ['unknown image event', { type: 'response.image_generation_call.new_state' }],
]) {
  test(`real Unix overload after ${name} never repeats the request on another account`, async (t) => {
    const f = await fixture(t, [
      (res) => {
        res.write(progress('resp_committed'))
        res.write(frame(event))
        res.end(failure('resp_committed'))
      },
      () => assert.fail('a committed request cannot switch accounts'),
    ])
    const call = f.execute()
    await within(call.completion)
    assert.deepEqual(
      f.seen.map((entry) => entry.id),
      ['vm-a'],
    )
    assert.deepEqual(
      eventsFrom(call.wire).filter(
        (candidate) => candidate.type === event.type && candidate.item?.type === event.item?.type,
      ),
      [event],
    )
    assert.match(call.wire.join(''), /server_is_overloaded/)
    assert.equal(call.logBag.final_state, 'incomplete')
    assert.equal(call.stats.errors, 1)
  })
}

for (const event of ['aborted', 'close']) {
  test(`client ${event} during buffered image generation cancels one job and starts no replacement`, async (t) => {
    const started = gate()
    const f = await fixture(t, [
      (res) => {
        res.write(progress('resp_cancelled'))
        started.resolve()
      },
      () => assert.fail('a cancelled client cannot start another generation'),
    ])
    const call = f.execute()
    await within(started.promise)
    ;(event === 'aborted' ? call.req : call.res).emit(event)
    await within(call.completion)
    await within(f.cancelled)
    assert.deepEqual(
      f.seen.map((entry) => entry.id),
      ['vm-a'],
    )
    assert.deepEqual(f.cancellations, [{ id: 'vm-a', requestId: f.seen[0].requestId }])
    assert.deepEqual(call.wire, [])
    assert.equal(call.logBag.final_state, 'cancelled')
  })
}

for (const type of ['response.completed', 'response.done']) {
  test(`real Unix opaque-only reasoning preserves its successful ${type} response`, async (t) => {
    const f = await fixture(t, [
      (res) => {
        res.write(frame({ type: 'response.output_item.done', output_index: 0, item: opaque }))
        res.end(
          frame({
            type,
            response: { id: 'resp_reasoning', status: 'completed', output: [opaque], usage: successUsage },
          }),
        )
      },
    ])
    const call = f.execute({ tools: [] })
    await within(call.completion)
    assert.deepEqual(
      f.seen.map((entry) => entry.id),
      ['vm-a'],
    )
    assert.equal(eventsFrom(call.wire).filter((event) => event.type === type).length, 1)
    assert.equal(call.stats.errors, 0)
  })
}

for (const type of ['response.failed', 'response.incomplete', 'eof']) {
  test(`real Unix opaque-only reasoning ${type} cannot turn a failed hop into success`, async (t) => {
    const f = await fixture(t, [
      (res) => {
        res.write(frame({ type: 'response.created', response: { id: 'resp_opaque_failed', output: [] } }))
        res.write(frame({ type: 'response.output_item.done', output_index: 0, item: opaque }))
        res.end(
          type === 'eof'
            ? ''
            : frame({ type, response: { id: 'resp_opaque_failed', status: type.slice(9), output: [opaque] } }),
        )
      },
    ])
    const call = f.execute({ tools: [] })
    const result = await within(call.completion)
    assert.equal(result.status, 502)
    assert.deepEqual(call.wire, [])
    assert.equal(call.res.headersSent, false)
    assert.equal(call.logBag.attempt_count, 1)
    assert.equal(call.stats.errors, 1)
  })
}
