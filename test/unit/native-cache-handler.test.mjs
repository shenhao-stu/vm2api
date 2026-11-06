import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { harness, usage } from '../fixtures/claude-pool-handler.mjs'
import { listCacheMarkers, forceEphemeralCacheTtl } from '../../src/lib/protocol/cache-ttl.mjs'

test('passthrough retains homogeneous TTL, mid-system, tools and original usage', async (t) => {
  const h = await harness(t)
  const input = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    stream: false,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'caller',
        eager_input_streaming: false,
        input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'system', content: [{ type: 'text', text: 'mid-system' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_fixture', name: 'caller', input: { cache_control: 'business' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_fixture',
            content: 'result',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    ],
  }
  const expected = structuredClone(input)
  expected.system[0].cache_control.ttl = '1h'
  const result = await h.send(input)
  assert.equal(result.status, 200, result.text)
  assert.equal(h.captured.length, 1)
  const envelope = h.captured[0]
  assert.deepEqual(envelope.body.messages, expected.messages)
  assert.deepEqual(envelope.body.system, expected.system)
  assert.deepEqual(envelope.body.tools, expected.tools)
  assert.equal(envelope.preserve_cache_breakpoints, true)
  assert.equal(envelope.cache_ttl, null)
  assert.deepEqual(JSON.parse(result.text).usage, usage)

  // Same caller session: an old request's resolved TTL cannot override this one.
  const next = structuredClone(input)
  next.system[0].cache_control.ttl = '5m'
  next.messages.at(-1).content[0].cache_control.ttl = '5m'
  assert.equal((await h.send(next)).status, 200)
  assert.equal(h.captured[1].body.messages.at(-1).content[0].cache_control.ttl, '5m')
  assert.deepEqual(h.logs.at(-1).usage.cache_creation, usage.cache_creation)
})

test('native handler rejects mixed TTL before scheduling or worker calls', async (t) => {
  const h = await harness(t)
  const result = await h.send({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'tail', cache_control: { type: 'ephemeral' } }] }],
  })
  assert.equal(result.status, 400, result.text)
  assert.equal(JSON.parse(result.text).error.code, 'cache_ttl_mixed_unsupported')
  assert.equal(h.scheduled(), 0)
  assert.deepEqual(h.captured, [])
})

test('existing rewrite context and marker layout stay unchanged across native per-turn TTL changes', async (t) => {
  const h = await harness(t, false)
  const input = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [{ type: 'text', text: 'FIXTURE_CALLER_SYSTEM' }],
    tools: [
      {
        name: 'caller',
        eager_input_streaming: false,
        input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
      },
    ],
    messages: [{ role: 'user', content: 'fixture user' }],
  }
  for (const ttl of [undefined, '5m', '1h']) {
    const request = { ...input, ...(ttl ? { cache_control: { type: 'ephemeral', ttl } } : {}) }
    const result = await h.send(request)
    assert.equal(result.status, 200, result.text)
    const envelope = h.captured.at(-1)
    const points = listCacheMarkers(envelope.body)
    assert.ok(points.length)
    assert.ok(points.every((p) => p.ttl === (ttl || '1h')))
    assert.deepEqual(JSON.parse(result.text).usage, usage)
    assert.equal(envelope.cache_ttl, null)
    assert.equal(envelope.preserve_cache_breakpoints, true)
  }
  const context = (body) => {
    const value = forceEphemeralCacheTtl(body, '1h')
    return { ...value, betas: value.betas.filter((b) => b !== 'extended-cache-ttl-2025-04-11') }
  }
  for (const envelope of h.captured.slice(1)) {
    assert.deepEqual(context(envelope.body), context(h.captured[0].body))
  }
  if (process.env.NATIVE_CACHE_FIXTURE_OUTPUT) {
    fs.writeFileSync(
      process.env.NATIVE_CACHE_FIXTURE_OUTPUT,
      JSON.stringify(
        h.captured.map((envelope) => envelope.body),
        null,
        2,
      ),
    )
  }
  const count = h.captured.length
  const result = await h.send({
    ...input,
    cache_control: { type: 'ephemeral', ttl: '5m' },
    system: [{ type: 'text', text: 'fixture', cache_control: { type: 'ephemeral' } }],
  })
  assert.equal(result.status, 400, result.text)
  assert.equal(JSON.parse(result.text).error.code, 'cache_ttl_mixed_unsupported')
  assert.equal(h.captured.length, count)
})

for (const passthrough of [false, true])
  test(`nested result TTL survives handler transformation (passthrough=${passthrough})`, async (t) => {
    const h = await harness(t, passthrough)
    const result = await h.send({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      metadata: {
        user_id: JSON.stringify({
          device_id: 'a'.repeat(64),
          account_uuid: '',
          session_id: '11111111-2222-4333-8444-555555555555',
        }),
      },
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      tools: [{ name: 'caller', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'fixture' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture', name: 'caller', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'fixture',
              content: [
                {
                  type: 'search_result',
                  source: 'https://example.com',
                  title: 'fixture',
                  content: [{ type: 'text', text: 'fixture', cache_control: { type: 'ephemeral' } }],
                },
              ],
            },
          ],
        },
      ],
    })
    assert.equal(result.status, 200, result.text)
    assert.equal(h.captured[0].body.messages.at(-1).content[0].content[0].content[0].cache_control.ttl, '1h')
  })
