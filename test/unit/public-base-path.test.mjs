import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { publicBasePath, mountWebIndex } from '../../src/lib/http/public-base-path.mjs'
import { tryServeWebDist } from '../../src/lib/http/web-dist.mjs'

test('only the configured exact reverse-proxy prefix selects a mount', () => {
  const env = { VM2API_PUBLIC_BASE_PATH: '/claude' }
  assert.equal(publicBasePath({ headers: { 'x-forwarded-prefix': '/claude' } }, env), '/claude')
  for (const header of [undefined, '', '/other', '//evil.test', '/claude/', '/claude,/other', ['/claude']]) {
    assert.equal(publicBasePath({ headers: { 'x-forwarded-prefix': header } }, env), '')
  }
  assert.equal(publicBasePath({ headers: { 'x-forwarded-prefix': '/claude' } }, {}), '')
  for (const value of ['/../claude', '/claude?x', '/claude; Path=/', '/<script>', '//claude']) {
    assert.throws(() => publicBasePath({}, { VM2API_PUBLIC_BASE_PATH: value }), /Invalid/)
  }
})

test('HTML resources stay under the mount without changing hash anchors or external URLs', () => {
  const html =
    '<html><head><link rel="icon" href="./favicon.svg"><link rel="stylesheet" href="/assets/style.css">' +
    '<link href="https://example.test/docs"><script type="module" src="./assets/app.js"></script></head>' +
    '<body><a href="#/login">login</a><a href="#content">skip</a></body></html>'
  const mounted = mountWebIndex(html, '/claude')
  assert.match(mounted, /name="vm2api-base-path" content="\/claude"/)
  assert.match(mounted, /href="\/claude\/favicon.svg"/)
  assert.match(mounted, /href="\/claude\/assets\/style.css"/)
  assert.match(mounted, /src="\/claude\/assets\/app.js"/)
  assert.match(mounted, /href="https:\/\/example.test\/docs"/)
  assert.match(mounted, /href="#\/login"/)
  assert.match(mounted, /href="#content"/)
  assert.doesNotMatch(mounted, /<base\b/)
  assert.match(mountWebIndex(html), /src="\/assets\/app.js"/)
})

test('stripped mounted root serves the SPA and its resources while old /console stays usable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-mounted-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dist = path.join(root, 'web', 'dist')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<html><head><script src="./assets/app.js"></script></head></html>')
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'export const ready=true')
  const env = { VM2API_PUBLIC_BASE_PATH: '/claude' }
  const server = http.createServer((req, res) => {
    const basePath = publicBasePath(req, env)
    if (tryServeWebDist(res, root, new URL(req.url, 'http://localhost').pathname, { basePath })) return
    res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-forwarded-prefix': '/claude' }
  const mounted = await fetch(`${base}/`, { headers })
  assert.equal(mounted.status, 200)
  assert.equal(mounted.headers.get('cache-control'), 'no-store')
  assert.match(await mounted.text(), /src="\/claude\/assets\/app.js"/)
  const asset = await fetch(`${base}/assets/app.js`, { headers })
  assert.equal(await asset.text(), 'export const ready=true')
  assert.match(asset.headers.get('cache-control'), /immutable/)
  const legacy = await fetch(`${base}/console/`)
  assert.equal(legacy.status, 200)
  assert.match(await legacy.text(), /src="\/assets\/app.js"/)
  assert.equal((await fetch(`${base}/`)).status, 404)
})

test('native login and logout cookies use only the selected mount, keeping legacy root cookies compatible', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-mounted-login-'))
  const patch = {
    KIN_DATA_DIR: root,
    VM2API_PUBLIC_BASE_PATH: '/claude',
    VM2API_PANEL_COOKIE_NAME: 'kin_hosted_panel_token',
    VM2API_ADMIN_USER: 'mount-admin',
    VM2API_ADMIN_PASSWORD: 'fixture-only-password',
  }
  const prior = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]))
  Object.assign(process.env, patch)
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
  const { verifyPanelSession, extractPanelToken } = await import('../../src/lib/core/security.mjs')
  assert.equal(
    extractPanelToken({
      headers: {
        cookie: 'kin_hosted_panel_token=mounted; kin_hosted_panel_token=legacy-root; kin_panel_token=other',
      },
    }),
    'mounted',
  )
  let response
  const handler = createPanelHandler({
    cfg: { paths: { project: root } },
    readBody: async () => ({ username: 'mount-admin', password: 'fixture-only-password' }),
    json: (_res, status, body) => {
      response = { status, body }
    },
  })
  for (const prefix of ['/claude', '']) {
    let cookie
    const res = {
      setHeader: (name, value) => {
        if (name === 'Set-Cookie') cookie = value
      },
    }
    const req = { method: 'POST', headers: { 'x-forwarded-prefix': prefix, 'x-forwarded-proto': 'https' } }
    await handler(req, res, new URL('http://localhost/api/panel/login'))
    assert.equal(response.status, 200)
    assert.ok(response.body.token.startsWith('kin-panel-'))
    assert.ok(verifyPanelSession(response.body.token))
    assert.ok(cookie.includes(`Path=${prefix || '/'};`))
    assert.match(cookie, /^kin_hosted_panel_token=/)
    assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/)
    req.headers.authorization = `Bearer ${response.body.token}`
    const token = response.body.token
    await handler(req, res, new URL('http://localhost/api/panel/logout'))
    assert.equal(response.status, 200)
    assert.ok(cookie.includes(`Path=${prefix || '/'};`))
    assert.match(cookie, /Max-Age=0/)
    assert.equal(verifyPanelSession(token), null)
  }
})
