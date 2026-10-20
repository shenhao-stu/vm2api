import test from 'node:test'
import assert from 'node:assert/strict'
import { assertInlineImages, materializeRemoteImageSources } from '../../src/lib/protocol/images.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('materializeRemoteImageSources fetches url images to base64', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/example.com\/a.png$/)
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG,
    }
  }
  const out = await materializeRemoteImageSources(
    {
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是什么?' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
    },
    { fetchImpl },
  )
  assert.equal(out.messages[0].content[1].source.type, 'base64')
  assert.equal(out.messages[0].content[1].source.media_type, 'image/png')
  assert.equal(out.messages[0].content[1].source.data, PNG.toString('base64'))
})

test('materializeRemoteImageSources keeps url when fetch fails', async () => {
  const out = await materializeRemoteImageSources(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/missing.png' } }],
        },
      ],
    },
    {
      fetchImpl: async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
    },
  )
  assert.equal(out.messages[0].content[0].source.type, 'url')
})

test('remote images are rejected before any download when inline images are required', async () => {
  let calls = 0
  const body = {
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.com/image.png' }] }],
  }
  const original = structuredClone(body)
  await assert.rejects(
    materializeRemoteImageSources(body, {
      allowRemote: false,
      fetchImpl: async () => {
        calls++
        return { ok: false }
      },
    }),
    { code: 'exit_guard_remote_image_unsupported' },
  )
  assert.equal(calls, 0)
  assert.deepEqual(body, original)
})

test('inline-only validation covers nested tool results and Responses image inputs without changing content', () => {
  for (const body of [
    {
      messages: [
        {
          content: [
            {
              type: 'tool_result',
              content: [{ type: 'image', source: { type: 'url', url: 'https://image.invalid/a' } }],
            },
          ],
        },
      ],
    },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://image.invalid/a' }] }] },
  ]) {
    const original = structuredClone(body)
    assert.throws(() => assertInlineImages(body), { code: 'exit_guard_remote_image_unsupported' })
    assert.deepEqual(body, original)
  }
  const inline = {
    messages: [
      {
        content: [
          { type: 'thinking', thinking: 'synthetic', signature: 'synthetic-signature' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
          { type: 'text', text: 'https://example.com is ordinary text' },
        ],
      },
    ],
  }
  const original = structuredClone(inline)
  assert.doesNotThrow(() => assertInlineImages(inline))
  assert.deepEqual(inline, original)
})
