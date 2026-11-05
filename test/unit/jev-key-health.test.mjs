import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createJevKeyHealth,
  JEV_KEY_HEALTH_SETTING,
  readJevCredentialFailure,
} from '../../src/lib/protocol/jev-key-health.mjs'
import {
  classifyJev,
  installJevKeyHealthStore,
  publicJevConfig,
  applyJevPatch,
} from '../../src/lib/protocol/jev-intercept.mjs'

const response = (payload, status = 403) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
const disabled = { detail: { error_type: 'authentication_error', message: 'Your organization has been deactivated.' } }
const store = () => {
  const values = new Map()
  return {
    get: (key, fallback) => structuredClone(values.get(key) ?? fallback),
    set: (key, value) => values.set(key, structuredClone(value)),
  }
}

test('confirmed failures persist across store reload without credentials, URLs or provider text', () => {
  const settings = store()
  const health = createJevKeyHealth(settings)
  const target = 'https://private-endpoint.example/v1/systemone\0secret-test-key'
  health.retire(target, 'organization_disabled')
  const saved = JSON.stringify(settings.get(JEV_KEY_HEALTH_SETTING))
  assert.ok(!saved.includes('secret-test-key') && !saved.includes('private-endpoint'))
  const restored = createJevKeyHealth(settings)
  assert.equal(restored.reason(target), 'organization_disabled')
  assert.equal(restored.reason('https://other.example/v1/systemone\0secret-test-key'), null)
  restored.rearm([target])
  assert.equal(createJevKeyHealth(settings).reason(target), null)
})

test('only a structured authentication failure confirms organization retirement', async () => {
  assert.equal(await readJevCredentialFailure(response(disabled)), 'organization_disabled')
  for (const payload of [
    { detail: 'Forbidden' },
    { error: { type: 'permission_error', message: 'Organization disabled for this model' } },
    { detail: { error_type: 'authentication_error', message: 'Access denied' } },
  ])
    assert.equal(await readJevCredentialFailure(response(payload)), null)
  assert.equal(await readJevCredentialFailure(new Response('<html>Challenge</html>', { status: 403 })), null)
  assert.equal(await readJevCredentialFailure(new Response('{}', { status: 401 })), 'invalid_credentials')
})

test('oversized forbidden response is cancelled and cannot retire a key', async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8193))
    },
    cancel() {
      cancelled = true
    },
  })
  assert.equal(await readJevCredentialFailure(new Response(body, { status: 403 })), null)
  assert.equal(cancelled, true)
})

test('panel and classifier retain disabled health after restart; ordinary config saves cannot clear it', async (t) => {
  const settings = store()
  const config = {
    enabled: true,
    fail_open: false,
    base_url: 'https://persistent-health.example',
    api_keys: ['synthetic-persisted'],
    dedup_sec: 0,
  }
  settings.set('jev_intercept', config)
  installJevKeyHealthStore(settings)
  t.after(() => installJevKeyHealthStore(null))
  await classifyJev('first', config, async () => response(disabled))
  installJevKeyHealthStore(settings)
  const snapshot = publicJevConfig(config)
  assert.equal(snapshot.api_key_ready_count, 0)
  assert.equal(snapshot.api_key_retired_count, 1)
  assert.equal(applyJevPatch(settings, { timeout_ms: 3000 }).config.api_key_retired_count, 1)
  let calls = 0
  const blocked = await classifyJev('second', config, async () => {
    calls++
    return response(disabled)
  })
  assert.equal(blocked.reason, 'unavailable')
  assert.equal(calls, 0)
  assert.equal(applyJevPatch(settings, { api_keys: config.api_keys }).config.api_key_retired_count, 0)
  installJevKeyHealthStore(settings)
  assert.equal(publicJevConfig(config).api_key_retired_count, 0)
})

test('generic forbidden does not retire healthy credentials or traverse every same-host key', async () => {
  let calls = 0
  const config = {
    enabled: true,
    fail_open: false,
    base_url: 'https://generic-forbidden.example',
    api_keys: Array.from({ length: 50 }, (_, i) => `synthetic-403-${i}`),
    dedup_sec: 0,
  }
  const result = await classifyJev('blocked endpoint', config, async () => {
    calls++
    return new Response('<html>forbidden</html>', { status: 403 })
  })
  assert.equal(result.reason, 'unavailable')
  assert.equal(calls, 1)
  assert.equal(publicJevConfig(config).api_key_retired_count, 0)
})
