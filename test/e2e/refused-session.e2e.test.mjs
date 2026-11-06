import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startGateway, api, takeTrace } from '../harness.mjs'

const model = 'claude-haiku-4-5-20251001'
const history = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'synthetic refusal fixture' },
]
const next = { role: 'user', content: 'continue' }
test('public Messages and Chat isolate only the refused Claude Pro context and honor the independent panel switch', async () => {
  const gw = await startGateway({ scenario: 'policy_refusal', env: { KIN_KERNEL_BIN: process.execPath } })
  const send = (endpoint, messages, sid, stream = false) =>
    api(gw, 'POST', endpoint, {
      headers: sid ? { 'x-session-id': sid } : {},
      body: { model, messages, max_tokens: 24, stream },
    })
  async function set(patch) {
    const response = await api(gw, 'PUT', '/api/panel/refusal-guards', { body: patch })
    assert.equal(response.status, 200, response.text)
    return response.json.data
  }
  try {
    assert.equal((await set({ enabled: false })).session_isolation_enabled, true)
    const first = await send('/v1/messages', history, 'session-a', true)
    assert.equal(first.status, 200, first.text)
    assert.match(first.text, /"stop_reason":"refusal"/)
    assert.ok(takeTrace(gw))
    for (const [sid, messages] of [
      ['session-a', [next]],
      ['fresh-id', [...history, next]],
      ['', [...history, next]],
    ]) {
      const blocked = await send('/v1/chat/completions', messages, sid, true)
      assert.equal(blocked.status, 403, sid + ' ' + blocked.text)
      assert.equal(blocked.json.error.code, 'session_context_isolated')
      assert.doesNotMatch(blocked.text, /synthetic refusal fixture|session-a|fresh-id/)
      assert.equal(takeTrace(gw), null)
    }
    const different = await send('/v1/chat/completions', [history[0], history[1], next], 'fresh-id')
    assert.equal(different.status, 200, different.text)
    assert.ok(takeTrace(gw))
    const afterChatRefusal = await send('/v1/messages', [next], 'fresh-id')
    assert.equal(afterChatRefusal.status, 403, afterChatRefusal.text)
    assert.equal(takeTrace(gw), null)
    assert.equal((await set({ session_isolation_enabled: false })).session_isolation_enabled, false)
    const disabled = await send('/v1/messages', [next], 'session-a')
    assert.equal(disabled.status, 200, disabled.text)
    assert.ok(takeTrace(gw))
    await set({ session_isolation_enabled: true })
    const cleared = await send('/v1/messages', [next], 'session-a')
    assert.equal(cleared.status, 200, cleared.text)
    assert.ok(takeTrace(gw))
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
