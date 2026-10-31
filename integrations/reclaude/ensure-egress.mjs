// Run inside the existing host-network gateway; never mutate its proxy policy or latch.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'

export function relayEgressAction(proxy, policy, state, expectedIp) {
  if (!proxy || proxy.enabled || proxy.bound_vm_id || proxy.bound_vm_ids?.length) {
    throw new Error('relay proxy must remain reserved outside the VM allocator')
  }
  if (!policy.required || policy.expected_ip !== expectedIp || !policy.revision) {
    throw new Error('fixed exit policy changed; operator review required')
  }
  if (state.latched) throw new Error('exit guard latched; automatic rearm is forbidden')
  if (state.reason === 'exit_guard_not_running') return 'start'
  if (!state.ready && !['exit_guard_checking', 'exit_guard_retrying'].includes(state.reason)) {
    throw new Error('unverified exit state; operator review required')
  }
  return 'observe'
}

async function main([project, proxyId, expectedIp]) {
  if (!path.isAbsolute(project || '') || !/^px-[a-f0-9]+$/.test(proxyId || '') || !net.isIP(expectedIp || '')) {
    throw new Error('usage: ensure-egress.mjs ABSOLUTE_PROJECT PROXY_ID EXPECTED_IP')
  }
  const moduleAt = (name) => import(pathToFileURL(path.join(project, 'src/lib', name)).href)
  const { openDatabase, closeDatabase } = await moduleAt('db/database.mjs')
  const { ProxyPool } = await moduleAt('vm/proxy-pool.mjs')
  const { getProxyExitGuardPolicy, getProxyExitGuardState } = await moduleAt('vm/proxy-exit-guard.mjs')
  const { ensureProxyEgress } = await moduleAt('vm/egress.mjs')
  openDatabase({ dataDir: path.join(project, 'data') })
  try {
    const pool = new ProxyPool()
    const proxy = pool.snapshot().proxies.find((row) => row.id === proxyId)
    const policy = getProxyExitGuardPolicy(proxyId)
    const state = getProxyExitGuardState(project, proxyId)
    if (relayEgressAction(proxy, policy, state, expectedIp) === 'start') {
      const result = await ensureProxyEgress(project, pool.getProxyByIdWithAuth(proxyId))
      if (!result.ok) throw new Error('native egress restart failed')
    }
    const current = getProxyExitGuardState(project, proxyId)
    console.log(JSON.stringify({ proxy_id: proxyId, ready: current.ready, reason: current.reason, revision: policy.revision }))
  } finally {
    closeDatabase()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2))
}
