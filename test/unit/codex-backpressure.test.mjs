import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { handleCodexProtocol, codexFailureHold } from '../../src/lib/protocol/handle-codex.mjs'
import { writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { createRespond } from '../../src/lib/http/respond.mjs'

async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'stream did not reach the expected write')
    await wait(2)
  }
}

for (const protocol of ['openai.responses', 'openai.chat']) {
  for (const delivery of [
    { name: 'text HTTP', transport: 'http', image: false },
    { name: 'image HTTP', transport: 'http', image: true },
    { name: 'image WebSocket', transport: 'websocket', image: true },
  ]) {
    for (const disconnect of [false, true]) {
      test(`${protocol} ${delivery.name} pauses the actual hop on downstream backpressure (disconnect=${disconnect})`, async (t) => {
        resetOpenAIAccountRuntime()
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-drain-'))
        const id = 'vm-fixture'
        fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
        fs.writeFileSync(
          path.join(root, 'vms', id + '.json'),
          JSON.stringify({
            id,
            platform: 'openai',
            family: 'codex',
            status: 'running',
            schedulable: true,
            has_token: true,
          }),
        )
        writeCodexAccounts(root, id, [
          {
            id: 'fixture-account',
            access_token: 'fixture-at',
            refresh_token: 'fixture-rt',
            chatgpt_account_id: 'fixture-workspace',
          },
        ])
        t.after(() => {
          fs.rmSync(root, { recursive: true, force: true })
          resetOpenAIAccountRuntime()
        })
        const req = new EventEmitter()
        req.headers = {}
        req.apiKeyKind = 'master'
        req.kinTimings = { transport: delivery.transport }
        const tools = delivery.image ? [{ type: 'image_generation', model: 'gpt-image-2.6' }] : []
        const res = new EventEmitter()
        Object.assign(res, { headersSent: false, destroyed: false, writableEnded: false, writes: [] })
        let waitingForDrain = false
        const drainTimeouts = []
        const originalSetTimeout = globalThis.setTimeout
        t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
          if (waitingForDrain) {
            drainTimeouts.push(ms)
          }
          return originalSetTimeout(fn, ms, ...args)
        })
        res.write = (chunk) => {
          res.writes.push(String(chunk))
          waitingForDrain = res.writes.length === 1
          return !waitingForDrain
        }
        res.end = () => {
          res.writableEnded = true
        }
        let advanced = false,
          hops = 0
        const generatedText = 'OK🙂多'.repeat(16 * 1024)
        res.writeHead = (status, headers) => {
          res.statusCode = status
          res.headers = headers
          res.headersSent = true
        }
        const { writeSSEHeaders } = createRespond({ rewrite: { enabled: false } })
        const logBag = {}
        const pending = handleCodexProtocol({
          req,
          res,
          protocol,
          projectRoot: root,
          ctx: {
            body:
              protocol === 'openai.responses'
                ? { model: 'gpt-6.1-sol', input: 'hello', stream: true, tools }
                : { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hello' }], stream: true, tools },
          },
          inbound: { stream: true },
          logBag,
          stats: { requests: 0, errors: 0, by_route: {} },
          routing: {},
          json(_res, status, body) {
            res.statusCode = status
            res.body = body
          },
          writeSSEHeaders,
          ops: {
            writeCodexKernelConfig() {},
            ensureCodexKernel: async () => ({ ok: true }),
            streamCodexKernel: async ({ onEvent, signal }) => {
              hops++
              try {
                await onEvent(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: generatedText })}\n`)
                advanced = true
                await onEvent(
                  'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}}\n',
                )
                return { ok: true, status: 200, committed: true, terminalState: 'verified' }
              } catch (error) {
                assert.ok(signal.aborted || error.code === 'client_cancelled')
                return { ok: false, status: 499, clientCancelled: true, terminalState: 'cancelled' }
              }
            },
          },
        })
        await until(() => res.writes.length === 1)
        assert.deepEqual(drainTimeouts, [30_000])
        assert.equal(res.headers['x-accel-buffering'], 'no')
        // Inspect the actual stall budget without shrinking it into a race
        // against the test runner's scheduling under parallel load.
        await wait(10)
        assert.equal(advanced, false, 'the next upstream event must wait for drain')
        waitingForDrain = false
        if (disconnect) {
          res.destroyed = true
          res.emit('close')
        } else res.emit('drain')
        await pending
        assert.equal(advanced, !disconnect)
        assert.equal(hops, 1)
        assert.equal(res.listenerCount('drain'), 0)
        assert.equal(res.listenerCount('close'), 0)
        if (!disconnect) {
          assert.ok(res.writes.join('').includes(generatedText), 'large content must survive transport chunking')
          assert.ok(res.writes.every((chunk) => Buffer.byteLength(chunk) <= 32 * 1024))
        }
      })
    }
  }
}

test('a stream buffer limit never parks the selected account', () => {
  assert.equal(codexFailureHold({ ok: false, status: 502, body: { error: { code: 'worker_stream_limit' } } }), null)
})

for (const ending of ['drain', 'abort', 'timeout']) {
  test(`Codex JSON image delivery holds the seat until ${ending} and never replays`, async (t) => {
    const { openAIRuntimeSignals } = await import('../../src/lib/pool/openai-account-runtime.mjs')
    resetOpenAIAccountRuntime()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-drain-'))
    const id = 'vm-json'
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        platform: 'openai',
        family: 'codex',
        status: 'running',
        schedulable: true,
      }),
    )
    writeCodexAccounts(root, id, [{ access_token: 'fixture', chatgpt_account_id: 'fixture' }])
    t.after(() => {
      resetOpenAIAccountRuntime()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const req = new EventEmitter()
    req.headers = {}
    const res = new EventEmitter()
    Object.assign(res, { headersSent: false, destroyed: false, writableEnded: false, writes: [] })
    res.writeHead = () => {
      res.headersSent = true
    }
    res.write = (chunk) => {
      res.writes.push(String(chunk))
      return res.writes.length !== 1
    }
    res.end = () => {
      res.writableEnded = true
    }
    res.destroy = () => {
      res.destroyed = true
      res.emit('close')
    }
    const respond = createRespond({ rewrite: { enabled: false } })
    const keepAlive = setTimeout(() => {}, 2000)
    t.after(() => clearTimeout(keepAlive))
    const image = 'x'.repeat(256 * 1024)
    const logBag = {}
    let hops = 0
    const pending = handleCodexProtocol({
      req,
      res,
      projectRoot: root,
      protocol: 'openai.responses',
      ctx: { body: { model: 'gpt-5.5', input: 'fixture', stream: false } },
      inbound: { stream: false },
      logBag,
      stats: { errors: 0, requests: 0, by_route: {} },
      routing: {},
      json: (response, status, body, delivery) =>
        respond.json(response, status, body, {
          ...delivery,
          timeoutMs: ending === 'timeout' ? 40 : 1000,
        }),
      writeSSEHeaders: respond.writeSSEHeaders,
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async () => {
          hops++
          return {
            ok: true,
            status: 200,
            terminalState: 'verified',
            body: {
              id: 'fixture',
              output: [{ type: 'image_generation_call', result: image }],
            },
          }
        },
      },
    })
    await until(() => res.writes.length > 0)
    assert.equal(openAIRuntimeSignals(id).inFlight, 1)
    if (ending === 'drain') res.emit('drain')
    if (ending === 'abort') req.emit('aborted')
    await pending
    assert.equal(openAIRuntimeSignals(id).inFlight, 0)
    assert.equal(hops, 1)
    if (ending === 'drain') {
      assert.equal(JSON.parse(res.writes.join('')).output[0].result, image)
      assert.ok(res.writes.every((chunk) => Buffer.byteLength(chunk) <= 32768))
    } else {
      assert.equal(logBag.error_code, ending === 'abort' ? 'client_cancelled' : 'downstream_write_timeout')
      assert.equal(logBag.final_state, ending === 'abort' ? 'cancelled' : 'incomplete')
    }
  })
}
