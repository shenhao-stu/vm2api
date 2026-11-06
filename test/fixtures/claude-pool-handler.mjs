import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'
import { rememberRustHealth, clearRustHealthCache } from '../../src/lib/transport/kernel-router.mjs'

export const usage = {
  input_tokens: 11,
  output_tokens: 3,
  cache_read_input_tokens: 7,
  cache_creation_input_tokens: 5,
  cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
}

export async function harness(t, passthrough = true, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cache-handler-'))
  const socketPath = path.join(root, 'kernel.sock')
  const tokenPath = path.join(root, 'internal.token')
  fs.writeFileSync(tokenPath, 'fixture-token')
  const binary = path.join(root, 'fixture-kernel')
  fs.writeFileSync(binary, 'not executed; worker boundary is the fixture socket', { mode: 0o700 })
  const oldKernel = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = binary
  const captured = []
  const kernel = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    assert.equal(req.headers['x-internal-token'], 'fixture-token')
    assert.equal(req.url, '/internal/v1/messages')
    const envelope = JSON.parse(raw)
    captured.push(envelope)
    if (options.respond) return options.respond(envelope, res, captured.length)
    const message = {
      type: 'message',
      role: 'assistant',
      model: envelope.body.model,
      id: 'msg_fixture',
      content: [],
      stop_reason: null,
      usage: { ...usage, output_tokens: 0 },
    }
    const events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve) => kernel.listen(socketPath, resolve))
  const vm = {
    id: 'vm-fixture',
    claude: options.claude || { mode: 'api-key' },
    runtime: {
      kernel_socket: socketPath,
      worker_token_file: tokenPath,
      worker_run_dir: root,
    },
  }
  const exec = { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: {}, timezone: 'UTC' }
  fs.mkdirSync(exec.homeDir)
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', vm.id + '.json'), JSON.stringify(vm))
  for (const extra of options.otherVms || []) {
    fs.writeFileSync(path.join(root, 'vms', extra.id + '.json'), JSON.stringify(extra))
  }
  const routing = {
    inference: { engine: 'rust', health_ttl_ms: 60000 },
    compatibility: { official_cc_passthrough: passthrough },
    failover: { stream_keepalive_ms: 0 },
  }
  const routingPath = path.join(root, 'routing.json')
  fs.writeFileSync(routingPath, JSON.stringify(routing))
  rememberRustHealth(exec, { ok: true, health: { ok: true, ready_slots: 1, healthy: true } })
  const logs = []
  const cfg = {
    rewrite: { enabled: false },
    intercept: { rules: [] },
    distill: { enabled: false },
    limits: { max_body_bytes: 1048576, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
    paths: { project: root, data: root },
  }
  let scheduled = 0
  const handler = createHandleProtocol({
    ...createRespond(cfg),
    readBody,
    cfg,
    requireAuth: () => true,
    requestLog: { start: () => ({ request_id: 'fixture', t0: Date.now() }), finish: (_ctx, bag) => logs.push(bag) },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfigPath: routingPath,
    routingConfig: routing,
    apiKeyStore: {},
    accountQuota: {},
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    ...options.deps,
    failoverRunner: {
      async run(opts) {
        scheduled++
        const selected = options.selectVm?.(vm, scheduled) || vm
        const candidate = { vmId: selected.id, accountId: 'fixture-account', vm: selected, exec }
        await options.beforeSelect?.(scheduled)
        const block = opts.beforeAttempt?.(candidate)
        if (block) return { ...block, attemptCount: 0 }
        let prepared
        try {
          prepared = await opts.applyAttempt(opts.canonicalBody, candidate)
        } catch (error) {
          if (error.code === 'response_sent') return { responseSent: true }
          throw error
        }
        const result = await opts.callAttempt({
          candidate,
          body: prepared.body,
          attemptMeta: prepared.meta,
          signal: opts.signal,
          deliveryMode: opts.deliveryMode,
          onCommit() {},
        })
        return { ...result, vmId: vm.id, accountId: candidate.accountId, attemptCount: result.upstreamExecutions === 0 ? 0 : 1 }
      },
    },
  })
  const gateway = http.createServer((req, res) => {
    req.apiKeyKind = options.key ? 'managed' : 'master'
    req.apiKeyRecord = options.keys?.get(req.headers['x-fixture-client']) || options.key
    handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch((error) => {
      res.writeHead(500).end(String(error.stack))
    })
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    gateway.closeAllConnections()
    kernel.closeAllConnections()
    await Promise.all([
      new Promise((resolve) => gateway.close(resolve)),
      new Promise((resolve) => kernel.close(resolve)),
    ])
    clearRustHealthCache(vm.id)
    if (oldKernel === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = oldKernel
    fs.rmSync(root, { recursive: true, force: true })
  })
  const fetchStream = (body, client = '') => fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.304 (external, sdk-cli)', 'x-fixture-client': client },
      body: JSON.stringify(body),
    })
  const send = async (body, client) => {
    const response = await fetchStream(body, client)
    return { status: response.status, text: await response.text() }
  }
  return { send, fetchStream, captured, logs, scheduled: () => scheduled }
}
