import '../fixtures/kin-computer-test-env.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-data-'))
const previous = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = data
const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
after(() => {
  if (previous == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previous
  fs.rmSync(data, { recursive: true, force: true })
})

for (const remote of [true, false]) {
  test(`panel VM detail keeps a ${remote ? 'remote' : 'local'} health deadline`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'))
    const socket = path.join(root, 'kernel.sock')
    const timers = new Set()
    const server = http.createServer((_req, res) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, healthy: true, ready_slots: 1, cli_pid: 42 }))
      }, 1100)
      timers.add(timer)
    })
    await new Promise((resolve) => server.listen(socket, resolve))
    t.after(async () => {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    })
    fs.mkdirSync(path.join(root, 'vms', 'health-test'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', 'health-test.json'),
      JSON.stringify({
        id: 'health-test',
        status: 'running',
        ...(remote ? { node_id: 'test-node' } : {}),
        runtime: { kernel_socket: socket },
      }),
    )
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      requireAuth(req) {
        Object.assign(req, { apiKeyKind: 'master', panelRole: 'admin' })
        return true
      },
      json: (_res, status, body) => {
        response = { status, body }
        return true
      },
      readBody: async () => ({}),
    })
    await handler({ method: 'GET', headers: {} }, {}, new URL('http://localhost/api/panel/vms/health-test'))
    assert.equal(response.status, 200)
    assert.equal(response.body.data.kernel.rust_health.status, remote ? 200 : 0)
    assert.equal(response.body.data.kernel.rust_health.reachable, remote)
  })
}
