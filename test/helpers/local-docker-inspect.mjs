import http from 'node:http'
import net from 'node:net'
import { instanceLabels, slotContainerName } from '../../src/lib/vm/instance-scope.mjs'

/** Fake only Engine transport; production inspect/owner checks still run. */
export async function mockLocalDockerInspect(t, { vmIds, running = false }) {
  const requests = []
  const allowed = new Map(vmIds.map((id) => [`/containers/${encodeURIComponent(slotContainerName(id))}/json`, id]))
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url })
    const id = req.method === 'GET' && allowed.get(req.url)
    res.writeHead(id ? 200 : 500, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        id
          ? {
              Id: `fixture-${id}`,
              Name: `/${slotContainerName(id)}`,
              Config: { Labels: instanceLabels(`slot:${id}`) },
              State: { Running: running },
            }
          : { message: 'unexpected fixture Engine request' },
      ),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const connect = net.connect
  t.mock.method(net, 'connect', (...args) =>
    args[0] === '/var/run/docker.sock' ? connect(server.address().port, '127.0.0.1') : connect(...args),
  )
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { requests }
}
