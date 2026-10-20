import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { parseRequestUrl, readBody } from '../../src/lib/http/respond.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'

const body = {
  model: 'claude-sonnet-5-5',
  max_tokens: 1024,
  temperature: 1,
  stream: true,
  system: "You are Claude Code, Anthropic's official CLI for Claude.",
  messages: [{ role: 'user', content: 'synthetic close fixture' }],
}
const usage = { input_tokens: 10, output_tokens: 4 }

async function exercise(
  t,
  {
    closeAtTerminal = false,
    cancelled = false,
    beforeTerminal = false,
    unauthorized = false,
    search = false,
    input = body,
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-close-summary-'))
  const routing = { compatibility: {}, failover: { stream_keepalive_ms: 0, queue_keepalive_delay_ms: 60000 } }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const records = [],
    billed = [],
    ingested = [],
    events = []
  let response,
    workerCalls = 0,
    releases = 0,
    aborted = false,
    handlerError = null,
    complete
  const handled = new Promise((resolve) => {
    complete = resolve
  })
  const handler = createHandleProtocol({
    json(res, status, value) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    },
    writeSSEHeaders(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
    },
    readBody,
    requireAuth(req, res) {
      if (unauthorized) {
        res.writeHead(401)
        res.end()
        return false
      }
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = { id: 'synthetic-key', vm_scope: 'all', group_type: 'all' }
      return true
    },
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: {
        max_body_bytes: 1048576,
        upstream_timeout_ms: 2000,
        stream_idle_timeout_ms: 2000,
        stream_keepalive_ms: 0,
      },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'synthetic-close', mode: 'normal', t0: Date.now() }),
      finish: (_ctx, record) => records.push(structuredClone(record)),
    },
    stickyRouter: {},
    accountQuota: { ingestHeaders: (...args) => ingested.push(args) },
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release: () => {
        releases++
      },
      recordUsage: (_key, value) => billed.push(value),
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      async run({ signal }) {
        workerCalls++
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fixture"}}\n\n')
        if (!beforeTerminal) response.write('data: {"type":"message_stop"}\n\n')
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 80)
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              clearTimeout(timer)
              setTimeout(resolve, 10)
            },
            { once: true },
          )
        })
        return {
          ok: !cancelled,
          status: cancelled ? 499 : 200,
          attemptCount: 1,
          finalState: cancelled ? 'cancelled' : 'verified',
          clientCancelled: cancelled,
          vmId: 'synthetic-vm',
          accountId: 'synthetic-account',
          via: 'synthetic-worker',
          body: {
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'fixture' }],
            stop_reason: 'end_turn',
            usage,
          },
        }
      },
    },
  })
  const server = http.createServer(async (req, res) => {
    response = res
    res.on('finish', () => events.push('finish'))
    res.on('close', () => events.push('close'))
    try {
      if (search) await handler.handleSearch(req, res, parseRequestUrl(req).pathname)
      else await handler.handleProtocol(req, res, 'anthropic.messages', parseRequestUrl(req).pathname)
    } catch (error) {
      handlerError = error.message
      res.destroy()
    } finally {
      complete()
    }
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: '/v1/messages?beta=true',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.187 (external, cli)' },
      },
      (res) => {
        let received = ''
        res.on('data', (chunk) => {
          received += chunk
          if (closeAtTerminal && received.includes(beforeTerminal ? 'content_block_delta' : 'message_stop')) {
            res.destroy()
            resolve()
          }
        })
        res.on('end', resolve)
        res.on('error', (error) => {
          if (!closeAtTerminal) reject(error)
        })
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(input))
  })
  await handled
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(handlerError, null)
  return { records, billed, ingested, events, workerCalls, releases, aborted }
}

test('worker verified result is logged once with final usage after the socket closes', async (t) => {
  const result = await exercise(t, { closeAtTerminal: true })
  assert.equal(result.aborted, true)
  assert.deepEqual(result.events, ['close'])
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].final_state, 'verified')
  assert.equal(result.records[0].account_id, 'synthetic-account')
  assert.equal(result.records[0].attempt_count, 1)
  assert.equal(result.records[0].usage.output_tokens, usage.output_tokens)
  assert.equal(result.workerCalls, 1)
  assert.equal(result.releases, 1)
  assert.equal(result.billed.length, 1)
  assert.equal(result.ingested.length, 1)
})

test('normal finish followed by close records and bills once', async (t) => {
  const result = await exercise(t)
  assert.equal(result.aborted, false)
  assert.deepEqual(result.events, ['finish', 'close'])
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].final_state, 'verified')
  assert.equal(result.records[0].usage.output_tokens, usage.output_tokens)
  assert.equal(result.billed.length, 1)
  assert.equal(result.ingested.length, 1)
  assert.equal(result.releases, 1)
})

for (const beforeTerminal of [false, true]) {
  test(`cancelled result keeps its classification and usage after ${beforeTerminal ? 'partial content' : 'message_stop'}`, async (t) => {
    const result = await exercise(t, { closeAtTerminal: true, cancelled: true, beforeTerminal })
    assert.equal(result.aborted, true)
    assert.equal(result.records.length, 1)
    assert.equal(result.records[0].final_state, 'cancelled')
    assert.equal(result.records[0].error_code, null)
    assert.equal(result.records[0].error_message, null)
    assert.equal(result.records[0].usage.output_tokens, usage.output_tokens)
    assert.equal(result.releases, 1)
    assert.equal(result.billed.length, 1)
    assert.equal(result.ingested.length, 1)
  })
}

for (const search of [false, true]) {
  test(`${search ? 'search' : 'messages'} auth rejection still logs once without inference or accounting`, async (t) => {
    const result = await exercise(t, { unauthorized: true, search })
    assert.equal(result.records.length, 1)
    assert.equal(result.records[0].status, 401)
    assert.equal(result.workerCalls, 0)
    assert.equal(result.releases, 0)
    assert.equal(result.billed.length, 0)
    assert.equal(result.ingested.length, 0)
  })
}

test('required exit guard rejects remote images at the HTTP boundary before inference or accounting', async (t) => {
  new SettingsRepo(openDatabase({ dbPath: ':memory:' })).set('proxy_exit_guard', { required: true, proxies: {} })
  t.after(closeDatabase)
  const result = await exercise(t, {
    input: {
      ...body,
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://image.invalid/a' } }] },
      ],
    },
  })
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].status, 400)
  assert.equal(result.records[0].error_code, 'exit_guard_remote_image_unsupported')
  assert.equal(result.workerCalls, 0)
  assert.equal(result.releases, 0)
  assert.equal(result.billed.length, 0)
})

for (const search of [false, true]) {
  test(`required exit guard rejects unsupported Codex ${search ? 'search' : 'inference'} before dispatch`, async (t) => {
    new SettingsRepo(openDatabase({ dbPath: ':memory:' })).set('proxy_exit_guard', { required: true, proxies: {} })
    t.after(closeDatabase)
    const result = await exercise(t, { search, input: { ...body, model: 'gpt-5' } })
    assert.equal(result.records.length, 1)
    assert.equal(result.records[0].status, 409)
    assert.equal(result.records[0].error_code, 'exit_guard_blocked')
    assert.equal(result.workerCalls, 0)
    assert.equal(result.billed.length, 0)
  })
}
