import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import {
  resolveNativeCacheTtl,
  fillMissingCacheTtl,
  forceEphemeralCacheTtl,
} from '../../src/lib/protocol/cache-ttl.mjs'

test('native passthrough fills omitted TTL without changing homogeneous layout', () => {
  const body = {
    model: 'claude-opus-5-5',
    tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [{ type: 'text', text: 'caller', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'cache', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'tail' },
        ],
      },
    ],
  }
  const before = structuredClone(body)
  const outgoing = prepareCliHopBody(body, { preserveSystem: true, cacheTtl: '5m' })
  const expected = structuredClone(body)
  expected.system[0].cache_control.ttl = '1h'
  assert.deepEqual(outgoing.system, expected.system)
  assert.deepEqual(outgoing.tools, expected.tools)
  assert.deepEqual(outgoing.messages, expected.messages)
  assert.deepEqual(body, before)
})

test('native TTL accepts homogeneous controls and rejects mixtures without mutating input', () => {
  assert.equal(resolveNativeCacheTtl({}), '1h')
  const definition = {
    type: 'tool_addition',
    tool: {
      type: 'tool_definition',
      definition: {
        name: 'caller',
        input_schema: { type: 'object', properties: { cache_control: { ttl: 'business' } } },
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    },
  }
  const body = { messages: [{ role: 'system', content: [definition] }] }
  const before = structuredClone(body)
  assert.equal(resolveNativeCacheTtl(body), '5m')
  assert.deepEqual(body, before)
  body.cache_control = { type: 'ephemeral' }
  assert.throws(
    () => resolveNativeCacheTtl(body),
    (e) => e.status === 400 && e.body.error.code === 'cache_ttl_mixed_unsupported',
  )
  for (const ttl of [null, '', '10m', [], {}]) {
    assert.throws(
      () => resolveNativeCacheTtl({ cache_control: { type: 'ephemeral', ttl } }),
      (e) => e.status === 400 && e.body.error.code === 'invalid_cache_control',
    )
  }
})

test('native completion reaches a typed tool definition without traversing schema data', () => {
  const body = {
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'caller',
                cache_control: { type: 'ephemeral' },
                input_schema: {
                  properties: { cache_control: { type: 'ephemeral', ttl: 'business-data' } },
                },
              },
            },
          },
        ],
      },
    ],
  }
  const original = structuredClone(body)
  for (const transform of [fillMissingCacheTtl, forceEphemeralCacheTtl]) {
    const output = transform(body, '1h')
    assert.equal(output.messages[0].content[0].tool.definition.cache_control.ttl, '1h')
    assert.deepEqual(
      output.messages[0].content[0].tool.definition.input_schema,
      body.messages[0].content[0].tool.definition.input_schema,
    )
  }
  assert.deepEqual(body, original)
})
