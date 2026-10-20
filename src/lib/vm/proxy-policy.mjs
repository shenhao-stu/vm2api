import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { socksProxyFamily } from './socks-address.mjs'
import net from 'node:net'
import { getProxyExitGuardPolicy } from './proxy-exit-guard.mjs'

export function configuredIpv6Enabled() {
  return isDbOpen() && new SettingsRepo(getDb()).get('proxy_pool_config')?.ipv6_enabled === true
}

export function proxyBlockedReason(proxy, ipv6Enabled = configuredIpv6Enabled()) {
  const guard = getProxyExitGuardPolicy(proxy?.id)
  if (guard.required) {
    if (
      proxy?.node_id ||
      proxy?.scheme === 'local' ||
      proxy?.host === 'local' ||
      /^px-local(?:-|$)/.test(proxy?.id || '')
    )
      return 'exit_guard_unsupported_exit'
    if (!proxy?.id || !net.isIP(guard.expected_ip) || !guard.revision) return 'exit_ip_required'
  }
  return ipv6Enabled !== true && socksProxyFamily(proxy) === 6 ? 'ipv6_disabled' : null
}

export function assertProxyAllowed(proxy) {
  const reason = proxyBlockedReason(proxy)
  if (reason)
    throw Object.assign(
      new Error(
        reason === 'ipv6_disabled'
          ? 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口'
          : `出口 IP 校验未放行: ${reason}`,
      ),
      { code: reason, status: 409 },
    )
}
