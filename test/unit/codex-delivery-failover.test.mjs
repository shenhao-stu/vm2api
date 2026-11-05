import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCodexProtocol, codexFailureHold } from '../../src/lib/protocol/handle-codex.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

test('input usage alone does not turn an empty upstream failure into a successful response', async (t) => {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-failover-'))
  t.after(() => {
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const id of ['vm-a', 'vm-b']) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    atomicWriteJson(path.join(root, 'vms', `${id}.json`), {
      id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
    })
    atomicWriteJson(path.join(root, 'vms', id, 'codex-credentials.json'), {
      accounts: [{ access_token: 'fixture-access', refresh_token: 'fixture-refresh', chatgpt_account_id: id }],
    })
  }
  const seen = []
  const result = await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'user' },
    res: { headersSent: false, write() {}, end() {} },
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.5', input: 'fixture', stream: false } },
    inbound: { stream: false },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => ({ status, body }),
    writeSSEHeaders() {},
    routing: { failover: { codex: { max_same_account_retries: 0 } } },
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec }) => {
        seen.push(exec.vm.id)
        if (seen.length === 1)
          return {
            ok: false,
            status: 200,
            committed: false,
            usage: { input_tokens: 120, output_tokens: 0 },
            body: {
              type: 'error',
              error: { code: 'empty_response', message: 'Upstream stream ended without visible output' },
            },
          }
        return { ok: true, status: 200, body: { object: 'response', output_text: 'recovered' } }
      },
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.output_text, 'recovered')
  assert.deepEqual(seen, ['vm-a', 'vm-b'])
})

test('402 has a temporary account hold but never parks a committed stream', () => {
  const now = 1000
  assert.deepEqual(codexFailureHold({ ok: false, status: 402 }, now), {
    until: 61000,
    reason: 'payment_required',
  })
  assert.equal(codexFailureHold({ ok: false, status: 402, committed: true }, now), null)
})

test('exhausted empty streams keep bounded attempts and persist an incomplete cause', async (t) => {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-budget-'))
  t.after(() => {
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const id of ['vm-a', 'vm-b', 'vm-c', 'vm-d', 'vm-e']) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    atomicWriteJson(path.join(root, 'vms', `${id}.json`), {
      id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
    })
    atomicWriteJson(path.join(root, 'vms', id, 'codex-credentials.json'), {
      accounts: [{ access_token: 'fixture-access', refresh_token: 'fixture-refresh', chatgpt_account_id: id }],
    })
  }
  const seen = []
  const logBag = {}
  const result = await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'user', kinTimings: { transport: 'websocket' } },
    res: {
      headersSent: false,
      write() {
        assert.fail('empty hops cannot write output')
      },
      end() {},
    },
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-6-astra', input: 'private fixture', stream: true } },
    inbound: { stream: true },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => ({ status, body }),
    writeSSEHeaders() {
      assert.fail('empty hops cannot commit headers')
    },
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec }) => {
        seen.push(exec.vm.id)
        return {
          ok: false,
          status: 200,
          committed: false,
          terminalState: 'incomplete',
          body: {
            type: 'error',
            error: { code: 'empty_response', message: 'Upstream stream ended without visible output' },
          },
          streamObservation: { bytes: 160, events: 1, terminal: 'none', kinds: { created: 1 } },
        }
      },
    },
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'empty_response')
  assert.equal(seen.length, 5, 'every eligible account is tried once')
  assert.equal(new Set(seen).size, 5)
  assert.equal(logBag.attempt_count, 5)
  assert.equal(logBag.final_state, 'incomplete')
  assert.match(logBag.error_message, /events=1 bytes=160 end=none/)
  assert.match(logBag.error_message, /input=1 tools=0 generate=on via=ws/)
  assert.doesNotMatch(logBag.error_message, /private fixture/)
})
