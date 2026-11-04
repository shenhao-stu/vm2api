import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Keep the normal test runner unchanged; module mocks replace only the worker
// boundary. The request handler, tracker and error mapper are the real modules.
if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  test('Anthropic terminal-error handler regression', () => {
    const child = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--test', fileURLToPath(import.meta.url)],
      {
        encoding: 'utf8',
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
      },
    )
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.match(child.stdout, /(?:pass 8|# pass 8)/, child.stdout + child.stderr)
    assert.doesNotMatch(child.stdout, /(?:fail [1-9]|# fail [1-9])/, child.stdout)
  })
} else {
  const streamModule = await import('../../src/lib/protocol/stream-truncation.mjs')
  let tracker
  mock.module('../../src/lib/protocol/stream-truncation.mjs', {
    namedExports: {
      ...streamModule,
      createAnthropicStreamTracker() {
        tracker = streamModule.createAnthropicStreamTracker()
        return tracker
      },
    },
  })
  const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')
  const MESSAGE = {
    model: 'claude-haiku-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hello from the queue' }],
  }

  function overloaded() {
    return {
      ok: false,
      status: 529,
      terminalState: 'exhausted',
      body: {
        type: 'error',
        error: {
          type: 'overloaded_error',
          code: 'pool_overloaded',
          message: '号池负载过高，稍后再试',
          details: { reason: 'pool_deadline_exceeded' },
        },
      },
    }
  }

  function createResponse() {
    const chunks = []
    const res = {
      statusCode: 0,
      body: null,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      chunks,
      headers: {},
      writeHead(status) {
        this.statusCode = status
        this.headersSent = true
      },
      write(chunk) {
        chunks.push(String(chunk))
        return true
      },
      end() {
        this.writableEnded = true
      },
      on(event, fn) {
        if (event === 'finish') this.finish = fn
      },
      once() {},
      off() {},
      setHeader(name, value) {
        this.headers[name] = value
      },
    }
    return res
  }

  function createHandler({ root, routing, run, stream = true }) {
    const routingFile = path.join(root, 'routing.json')
    fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {}, failover: routing.failover || {} }))
    return createHandleProtocol({
      json(res, status, body) {
        res.statusCode = status
        res.body = body
        res.headersSent = true
        return body
      },
      writeSSEHeaders(res) {
        res.writeHead(200)
      },
      readBody: async () => ({ ...MESSAGE, stream }),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: {
          max_body_bytes: 1024 * 1024,
          upstream_timeout_ms: 2000,
          stream_idle_timeout_ms: 2000,
          stream_keepalive_ms: routing.failover?.stream_keepalive_ms ?? 20,
          queue_keepalive_delay_ms: routing.failover?.queue_keepalive_delay_ms ?? 60_000,
        },
        paths: { data: root, project: root },
      },
      requestLog: {
        start: () => ({ request_id: 'queue-keepalive', mode: 'normal', t0: Date.now() }),
        finish() {},
      },
      stickyRouter: {},
      accountQuota: {},
      apiKeyStore: {},
      apiScheduler: {},
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: routing,
      groupsRepo: { rateMultiplier: () => 1 },
      failoverRunner: { run },
    })
  }

  async function invoke(handler, res, protocol = 'anthropic.messages') {
    const route = protocol === 'anthropic.messages' ? '/v1/messages' : '/v1/chat/completions'
    const req = {
      method: 'POST',
      url: route,
      headers: { authorization: 'Bearer master', 'user-agent': 'claude-cli/2.1.187 (external, cli)' },
      apiKeyKind: 'master',
      once() {},
      off() {},
    }
    await handler.handleProtocol(req, res, protocol, route)
    res.finish?.()
  }

  const failure = (code) => ({
    ok: false,
    status: 502,
    finalState: 'incomplete',
    attemptCount: 1,
    body: {
      type: 'error',
      error: { type: 'api_error', code, message: code },
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  })
  const start = { type: 'message_start', message: { usage: { output_tokens: 3 } } }
  const block = (type) => ({ type: 'content_block_start', index: 0, content_block: { type } })
  for (const sample of [
    { name: 'thinking interrupted by ECONNRESET', events: [start, block('thinking')], code: 'ECONNRESET', error: true },
    {
      name: 'thinking interrupted by timeout',
      events: [start, block('thinking')],
      code: 'worker_timeout',
      error: true,
    },
    { name: 'text interrupted by timeout', events: [start, block('text')], code: 'worker_timeout', error: true },
    { name: 'tool interrupted by timeout', events: [start, block('tool_use')], code: 'worker_timeout', error: true },
    { name: 'unstarted stream retains error', events: [], code: 'ECONNRESET', error: true },
    {
      name: 'completed stream has no duplicate terminal',
      events: [start, { type: 'message_stop' }],
      code: 'ECONNRESET',
      error: false,
    },
    {
      name: 'provider error is not duplicated',
      events: [start, { type: 'error', error: { type: 'api_error', code: 'ECONNRESET' } }],
      code: 'ECONNRESET',
      error: true,
    },
    {
      name: 'existing tool truncation compatibility is unchanged',
      events: [start, block('tool_use')],
      code: 'ECONNRESET',
      error: false,
    },
  ]) {
    test(sample.name, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-terminal-fixture-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      const res = createResponse()
      let calls = 0
      const result = failure(sample.code)
      const original = structuredClone(result)
      const handler = createHandler({
        root,
        routing: { failover: { stream_keepalive_ms: 0 } },
        run: async () => {
          calls++
          res.writeHead(200)
          for (const event of sample.events) {
            const wire = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
            tracker.observe(wire)
            res.write(wire)
          }
          return result
        },
      })
      await invoke(handler, res)
      const wire = res.chunks.join('')
      assert.equal(calls, 1, 'no replay')
      assert.equal(res.writableEnded, true)
      assert.deepEqual(result, original, 'preserve observed usage and outcome')
      assert.equal((wire.match(/event: error\n/g) || []).length, sample.error ? 1 : 0, wire)
      if (sample.error && sample.events.at(-1)?.type !== 'error') {
        assert.doesNotMatch(wire, /event: message_stop|"stop_reason":"max_tokens"/)
        assert.match(wire, /"type":"error"/)
      }
    })
  }
}
