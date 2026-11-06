import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import fetch from 'node-fetch'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'

export function qualityExitBinding(project, vm) {
  try {
    const pins = JSON.parse(fs.readFileSync(path.join(project, 'data', 'codex-quality-exits.json'), 'utf8'))
    const pin = pins[vm.id]
    const url = new URL(hostProxyUrlForVm(vm))
    if (
      !pin ||
      !net.isIP(pin.ip) ||
      vm.proxy?.id !== pin.proxy_id ||
      url.hostname !== pin.host ||
      Number(url.port) !== pin.port ||
      !['socks5:', 'socks5h:'].includes(url.protocol)
    )
      return null
    url.protocol = 'socks5h:'
    return { ip: pin.ip, url: url.toString() }
  } catch {
    return null
  }
}

export async function checkQualityExit(binding, request = fetch) {
  if (!binding) return false
  const agent = createProxyAgent(binding.url)
  try {
    const ips = await Promise.all(
      ['https://api.ipify.org', 'https://checkip.amazonaws.com'].map(async (url) => {
        const r = await request(url, { agent, redirect: 'error', size: 80, signal: AbortSignal.timeout(8000) })
        return r.ok ? (await r.text()).trim() : null
      }),
    )
    return ips.every((ip) => ip === binding.ip)
  } catch {
    return false
  } finally {
    agent.destroy()
  }
}
