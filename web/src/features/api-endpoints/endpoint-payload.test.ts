import { describe, expect, it } from 'vitest'
import {
  endpointPayload,
  modelsFromEndpoint,
  type EndpointDraft,
} from './endpoint-payload'

const local: EndpointDraft = {
  kind: 'local_gateway',
  protocol: 'openai',
  name: ' Local GPT ',
  baseUrl: 'http://127.0.0.1:8787/',
  prefix: '',
  priority: '0',
  disableCooling: false,
  authScheme: 'authorization_bearer',
  headersText: '',
  models: [{ name: 'gpt-5.4', alias: 'gpt-5.4', image: false, thinking: '' }],
  newKey: 'synthetic-upstream-key',
  newProxy: '',
}

describe('endpoint editor payload', () => {
  it('saves explicit gateway models without a proxy and does not replace keys on edit', () => {
    expect(endpointPayload(local, false)).toMatchObject({
      kind: 'local_gateway',
      protocol: 'openai',
      auth_scheme: 'authorization_bearer',
      base_url: 'http://127.0.0.1:8787',
      headers: {},
      models: [{ name: 'gpt-5.4', alias: 'gpt-5.4' }],
      api_key_entries: [{ api_key: 'synthetic-upstream-key' }],
    })
    expect(endpointPayload(local, true)).not.toHaveProperty('api_key_entries')
    const reloaded = modelsFromEndpoint({
      id: 'ep_0123456789ab',
      models: [
        {
          name: 'gpt-5.4',
          alias: 'gpt-pro',
          thinking: { levels: ['low', 'high'] },
        },
      ],
    })
    expect(
      endpointPayload({ ...local, models: reloaded }, true).models
    ).toEqual([
      {
        name: 'gpt-5.4',
        alias: 'gpt-pro',
        thinking: { levels: ['low', 'high'] },
      },
    ])
  })

  it.each([
    'https://example.com',
    'http://localhost:8787',
    'http://127.example.com',
    'http://127.0.0.1:8787/v1',
    'http://user:pass@127.0.0.1',
    'http://127.0.0.1?target=x',
  ])(
    'rejects a local gateway that is not a literal loopback origin: %s',
    (baseUrl) => {
      expect(() => endpointPayload({ ...local, baseUrl }, false)).toThrow(
        '回环'
      )
    }
  )

  it('refuses proxy/custom header carry-over and empty or image model scopes', () => {
    expect(() =>
      endpointPayload({ ...local, newProxy: 'socks5://proxy:1080' }, false)
    ).toThrow('代理')
    expect(() =>
      endpointPayload(
        { ...local, headersText: '{"Authorization":"custom"}' },
        true
      )
    ).toThrow('Headers')
    expect(() => endpointPayload({ ...local, models: [] }, true)).toThrow(
      '至少'
    )
    expect(() =>
      endpointPayload(
        { ...local, models: [{ ...local.models[0], image: true }] },
        true
      )
    ).toThrow('对话模型')
    expect(
      endpointPayload({ ...local, baseUrl: 'http://[::1]:8787' }, false)
        .base_url
    ).toBe('http://[::1]:8787')
  })

  it('preserves normal custom endpoint protocol, proxy and headers behavior', () => {
    expect(
      endpointPayload(
        {
          ...local,
          kind: 'custom',
          protocol: 'anthropic',
          authScheme: 'x_api_key',
          baseUrl: 'https://example.com',
          newProxy: 'socks5://proxy:1080',
          headersText: '{"x-custom":"value"}',
        },
        false
      )
    ).toMatchObject({
      kind: 'custom',
      protocol: 'anthropic',
      auth_scheme: 'x_api_key',
      headers: { 'x-custom': 'value' },
      api_key_entries: [
        { api_key: 'synthetic-upstream-key', proxy_url: 'socks5://proxy:1080' },
      ],
    })
  })
})
