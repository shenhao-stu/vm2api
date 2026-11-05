import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { streamCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'
import { codexErrorLogMessage, isRetryableSameCodexAccount } from '../../src/lib/protocol/handle-codex.mjs'

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`

async function kernel(t, payload, { body = {}, ...options } = {}) {
  const root = fs.mkdtempSync('/tmp/c2a-empty-')
  const socket = path.join(root, 'k.sock')
  const token = path.join(root, 'token')
  fs.writeFileSync(token, 'fixture-only', { mode: 0o600 })
  const urls = []
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    urls.push(req.url)
    res.setHeader('content-type', 'text/event-stream')
    res.end(payload)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const lines = []
  const result = await streamCodexKernel({
    exec: {
      vmId: 'fixture',
      homeDir: root,
      vm: {
        runtime: {
          worker_run_dir: root,
          codex_kernel_socket: socket,
          worker_token_file: token,
        },
      },
    },
    envelope: { body: { model: 'gpt-6-astra', input: 'private fixture', stream: true, ...body } },
    onEvent: (line) => lines.push(line),
    ...options,
  })
  assert.deepEqual(urls, ['/internal/v1/codex/responses'])
  return { result, lines }
}

test('a WebSocket prewarm forwards its real successful terminal exactly once without generated output', async (t) => {
  for (const ending of ['', '\n', '\n\n']) {
    const events = [
      { type: 'response.created', response: { id: 'resp_warm', status: 'in_progress', output: [] } },
      { type: 'response.in_progress', response: { id: 'resp_warm', status: 'in_progress', output: [] } },
      { type: 'response.completed', response: { id: 'resp_warm', status: 'completed', output: [] } },
    ]
    const payload = events.slice(0, -1).map(frame).join('') + `data: ${JSON.stringify(events.at(-1))}${ending}`
    const { result, lines } = await kernel(t, payload, {
      body: { generate: false, store: false },
      allowEmptyCompletedResponse: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.committed, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.ttftMs, null, 'prewarm has no first generated token')
    assert.equal(result.usage, null, 'no synthetic usage is added')
    assert.deepEqual(
      lines.filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))),
      events,
    )
  }
})

test('metadata-only completion remains empty without the explicit WebSocket prewarm contract', async (t) => {
  const payload = frame({ type: 'response.completed', response: { status: 'completed', output: [] } })
  for (const options of [
    {},
    { body: { generate: false, store: false } },
    { allowEmptyCompletedResponse: true },
    { allowEmptyCompletedResponse: true, body: { generate: true, store: false } },
    { allowEmptyCompletedResponse: true, body: { generate: false, store: true } },
  ]) {
    const { result, lines } = await kernel(t, payload, options)
    assert.equal(result.ok, false)
    assert.equal(result.body.error.code, 'empty_response')
    assert.equal(result.committed, false)
    assert.deepEqual(lines, [])
  }
})

test('a WebSocket prewarm cannot turn failed, incomplete or unterminated streams into success', async (t) => {
  for (const event of [
    { type: 'response.created', response: { status: 'in_progress', output: [] } },
    { type: 'response.completed', response: { status: 'in_progress', output: [] } },
    { type: 'response.incomplete', response: { status: 'incomplete', output: [] } },
    { type: 'response.failed', response: { status: 'failed', output: [] } },
    { type: 'response.done', response: { status: 'failed', output: [] } },
    { type: 'error', error: { type: 'server_error', message: 'fixture failure' } },
  ]) {
    const { result, lines } = await kernel(t, frame(event), {
      body: { generate: false, store: false },
      allowEmptyCompletedResponse: true,
    })
    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    assert.notEqual(result.terminalState, 'verified')
    assert.deepEqual(lines, [])
  }
  const { result, lines } = await kernel(
    t,
    frame({ type: 'error', error: { type: 'server_error', message: 'fixture failure' } }) +
      frame({ type: 'response.completed', response: { status: 'completed', output: [] } }),
    { body: { generate: false, store: false }, allowEmptyCompletedResponse: true },
  )
  assert.equal(result.ok, false)
  assert.equal(result.body.error.code, 'upstream_stream_error')
  assert.equal(result.committed, false)
  assert.deepEqual(lines, [])
})

test('Codex errors without a code preserve their cause instead of becoming empty_response', async (t) => {
  for (const ending of ['', '\n', '\n\n']) {
    const { result, lines } = await kernel(
      t,
      `data: ${JSON.stringify({
        type: 'error',
        error: { type: 'server_error', message: 'upstream fixture failure', status: 503 },
      })}${ending}`,
    )
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'upstream_stream_error')
    assert.equal(result.body.error.message, 'upstream fixture failure')
    assert.equal(result.body.error.type, 'server_error')
    assert.equal(result.committed, false)
    assert.equal(isRetryableSameCodexAccount(result), false, 'error preservation does not add same-account retries')
    assert.equal(result.streamObservation.terminal, 'error')
    assert.deepEqual(lines, [])
  }
})

test('Codex error normalization retains authentication and request rejection semantics', async (t) => {
  for (const [error, status] of [
    [{ type: 'authentication_error', message: 'invalid bearer' }, 401],
    [{ type: 'invalid_request_error', message: 'invalid fixture request' }, 400],
    [{ type: 'rate_limit_error', message: 'fixture rate limit' }, 429],
  ]) {
    const { result } = await kernel(t, frame({ type: 'error', error }))
    assert.equal(result.status, status)
    assert.equal(result.body.error.message, error.message)
    assert.notEqual(result.body.error.code, 'empty_response')
  }
})

test('failed and incomplete Codex terminals without errors cannot become an empty response', async (t) => {
  for (const [type, status, code] of [
    ['response.failed', 'failed', 'upstream_response_failed'],
    ['response.incomplete', 'incomplete', 'upstream_response_incomplete'],
    ['response.done', 'failed', 'upstream_response_failed'],
    ['response.done', 'incomplete', 'upstream_response_incomplete'],
    ['response.done', 'cancelled', 'upstream_response_incomplete'],
  ]) {
    const { result, lines } = await kernel(t, frame({ type, response: { status, output: [] } }))
    assert.equal(result.ok, false)
    assert.equal(result.body.error.code, code)
    assert.equal(result.committed, false)
    assert.deepEqual(lines, [])
  }
})

test('completed metadata is observed without synthesizing a failure after forwarding completion', async (t) => {
  const { result, lines } = await kernel(
    t,
    frame({
      type: 'response.completed',
      response: {
        status: 'in_progress',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture complete' }] }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    }),
  )
  assert.equal(result.body.error, undefined)
  assert.equal(result.committed, true)
  assert.equal(result.streamObservation.terminal, 'incomplete')
  assert.equal(lines.filter((line) => line.includes('response.completed')).length, 1)
})

test('an incomplete event preserves its explicit top-level error', async (t) => {
  const { result } = await kernel(
    t,
    frame({
      type: 'response.incomplete',
      response: { status: 'incomplete', output: [] },
      error: { type: 'invalid_request_error', message: 'fixture explicit rejection' },
    }),
  )
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'upstream_stream_error')
  assert.equal(result.body.error.message, 'fixture explicit rejection')
})

test('an empty failure terminal cannot overwrite an earlier provider error or its outer status', async (t) => {
  const { result } = await kernel(
    t,
    frame({ type: 'error', status: 503, error: { type: 'server_error', message: 'fixture original failure' } }) +
      frame({ type: 'response.failed', response: { status: 'failed' } }),
  )
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'upstream_stream_error')
  assert.equal(result.body.error.message, 'fixture original failure')
})

test('image progress followed by an unlabelled failure stays unpublished and preserves its cause', async (t) => {
  const { result, lines } = await kernel(
    t,
    frame({ type: 'response.image_generation_call.generating' }) +
      frame({ type: 'response.failed', response: { error: { type: 'server_error', message: 'fixture busy' } } }),
  )
  assert.equal(result.ok, false)
  assert.equal(result.committed, false)
  assert.equal(result.terminalState, 'incomplete')
  assert.equal(result.body.error.code, 'upstream_stream_error')
  assert.deepEqual(lines, [])
})

test('a genuine Codex empty stream records only bounded payload-free observations', async (t) => {
  const payload =
    frame({ type: 'response.created', response: { id: 'private_response', output: [] } }) +
    frame({ type: 'private_event_type', text: 'private upstream text', image: 'private image bytes' })
  const { result, lines } = await kernel(t, payload)
  assert.equal(result.body.error.code, 'empty_response')
  assert.equal(result.committed, false)
  assert.deepEqual(lines, [])
  assert.equal(result.streamObservation.events, 2)
  assert.ok(result.streamObservation.bytes > 0)
  assert.deepEqual(result.streamObservation.kinds, { created: 1, other: 1 })
  assert.equal(result.streamObservation.terminal, 'none')
  const message = codexErrorLogMessage(result, {
    body: { input: [{ content: 'private prompt' }], tools: [], generate: false },
    req: { kinTimings: { transport: 'websocket' }, headers: { authorization: 'Bearer private fixture' } },
  })
  assert.ok(message.length <= 300)
  assert.match(message, /empty_response/)
  assert.match(message, /events=2/)
  assert.match(message, /kinds=created,other/)
  assert.match(message, /input=1 tools=0 generate=off via=ws/)
  assert.doesNotMatch(message, /private|Bearer|authorization/)
  assert.doesNotMatch(JSON.stringify(result.streamObservation), /private/)
})

test('a Codex output frame at EOF commits exactly once and reaches downstream', async (t) => {
  for (const ending of ['', '\n', '\n\n']) {
    const event = {
      type: 'response.completed',
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture complete' }] }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    }
    const { result, lines } = await kernel(t, `data: ${JSON.stringify(event)}${ending}`)
    assert.equal(result.committed, true)
    assert.equal(result.body.error, undefined)
    assert.equal(result.usage.output_tokens, 2)
    assert.equal(result.streamObservation.terminal, 'completed')
    assert.equal(lines.filter((line) => line.startsWith('data:')).length, 1)
    assert.equal(lines.at(-1), '')
  }
})

test('diagnostic log suffix remains bounded when all recognized kinds are present', () => {
  const message = codexErrorLogMessage({
    ok: false,
    status: 200,
    body: { error: { code: 'empty_response', message: 'long '.repeat(100) } },
    streamObservation: {
      events: 1_000_000_000,
      bytes: 1_000_000_000,
      terminal: 'private terminal',
      kinds: {
        created: 1,
        in_progress: 1,
        text: 1,
        item: 1,
        image: 1,
        completed: 1,
        done: 1,
        failed: 1,
        incomplete: 1,
        error: 1,
        other: 1,
      },
    },
  })
  assert.ok(message.length <= 300)
  assert.match(message, /end=other/)
  assert.doesNotMatch(message, /private/)
})
