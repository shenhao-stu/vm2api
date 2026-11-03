import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function fixture(role = 'admin') {
  const calls = [],
    headers = new Map()
  const view = {
    runtime: { available: true },
    profiles: [{ id: 'sub-0123456789abcdef', name: 'airport', source: 'url', node_count: 1, retained_count: 0 }],
  }
  const manager = {
    view: () => view,
    import: async (body) => {
      calls.push(['import', body])
      return view
    },
    refresh: async (id) => {
      calls.push(['refresh', id])
      return view
    },
    configure: (id, body) => {
      calls.push(['configure', id, body])
      return view
    },
  }
  let input, response
  const handle = createPanelHandler({
    cfg: { paths: {} },
    proxySubscriptions: manager,
    requireAuth(req) {
      req.panelUser = 'fixture'
      req.panelRole = role
      return true
    },
    readBody: async () => input,
    json(_res, status, body) {
      response = { status, body }
    },
  })
  return {
    manager,
    calls,
    headers,
    async request(method, body, route = '/api/panel/proxies/clash') {
      input = body
      response = null
      await handle(
        { method },
        { setHeader: (key, value) => headers.set(key, value) },
        new URL(`http://localhost${route}`),
      )
      return response
    },
  }
}

test('legacy and canonical routes share the manager, validation and safe metadata', async () => {
  const f = fixture(),
    id = 'sub-0123456789abcdef'
  assert.equal((await f.request('GET')).body.sources[0].has_url, true)
  assert.equal(f.headers.get('Cache-Control'), 'no-store')
  assert.equal((await f.request('POST', { name: 'airport', yaml: 'proxies: []' })).status, 200)
  assert.equal(f.calls.at(-1)[1].content, 'proxies: []')
  assert.equal(f.calls.at(-1)[1].id, id)
  await f.request('POST', { action: 'refresh', source_id: id })
  assert.deepEqual(f.calls.at(-1), ['refresh', id])
  await f.request('POST', {}, `/api/panel/proxy-subscriptions/${id}/refresh`)
  assert.deepEqual(f.calls.at(-1), ['refresh', id])
  await f.request('PATCH', { auto_refresh: false }, `/api/panel/proxy-subscriptions/${id}`)
  assert.deepEqual(f.calls.at(-1), ['configure', id, { auto_refresh: false }])
  const count = f.calls.length
  assert.equal((await f.request('POST', { action: 'unknown' })).status, 400)
  assert.equal(f.calls.length, count)
  assert.equal((await f.request('DELETE')).status, 405)
})

test('legacy exceptions are redacted and both routes remain administrator-only', async () => {
  const f = fixture()
  f.manager.refresh = async () => {
    throw new Error('provider-secret')
  }
  const failure = await f.request('POST', { action: 'refresh', source_id: 'id' })
  assert.equal(failure.status, 400)
  assert.equal(JSON.stringify(failure).includes('provider-secret'), false)
  for (const role of ['user', 'super']) {
    const restricted = fixture(role)
    for (const route of ['/api/panel/proxies/clash', '/api/panel/proxy-subscriptions']) {
      for (const action of ['import', 'refresh', 'configure'])
        assert.equal((await restricted.request('POST', { action, source_id: 'id' }, route)).status, 403)
      assert.equal((await restricted.request('GET', undefined, route)).status, 403)
    }
    assert.equal(restricted.calls.length, 0)
  }
})
