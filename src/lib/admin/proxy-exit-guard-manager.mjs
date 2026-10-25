import crypto from 'node:crypto'
import net from 'node:net'
import { proxyRequiresExitIp } from '../vm/exit-guard-policy.mjs'

const KEY = 'proxy_exit_guard'
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status })

export function canonicalExitIp(value) {
  const ip = typeof value === 'string' ? value.trim() : ''
  if (!net.isIP(ip) || ip.includes('%')) throw failure('exit_guard_invalid_ip')
  return net.isIPv6(ip) ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip
}

/** Operator intent is stored separately from replaceable subscription rows and geo observations. */
export function createProxyExitGuardManager({
  settings,
  listProxies,
  readState,
  quiesce,
  startHelper,
  notify,
  log = console.error,
  now = Date.now,
  revision = crypto.randomUUID,
  onBlock,
}) {
  let tail = Promise.resolve()
  let timer = null
  let polling = false
  const alerted = new Map()
  const enforced = new Map()
  const config = () => {
    const raw = settings.get(KEY)
    if (raw == null && !settings.has?.(KEY)) return { required: false, proxies: {} }
    if (
      !raw ||
      typeof raw.required !== 'boolean' ||
      !raw.proxies ||
      typeof raw.proxies !== 'object' ||
      Array.isArray(raw.proxies)
    )
      throw failure('exit_guard_config_invalid', 503)
    return raw
  }
  const policy = (id) => {
    const cfg = config()
    const row = cfg.proxies?.[id]
    return {
      required: proxyRequiresExitIp(cfg, id),
      expected_ip: row?.expected_ip || null,
      revision: row?.revision || null,
    }
  }
  const view = () => ({
    required: config().required === true,
    proxies: listProxies().map(({ id }) => ({ id, ...policy(id), state: readState(id) })),
  })
  const serial = (fn) => {
    const result = tail.then(fn)
    tail = result.catch(() => {})
    return result
  }
  function proxy(id) {
    const row = listProxies().find((p) => p.id === id)
    if (!row) throw failure('proxy_not_found', 404)
    if (id.startsWith('px-local') || row.node_id) throw failure('exit_guard_proxy_unsupported', 409)
    return row
  }
  async function apply(rows, next) {
    // Closing existing transports happens before changing trust. Failure never enables a slot.
    for (const row of rows) {
      const stopped = await quiesce(row)
      if (!stopped?.ok) throw failure('exit_guard_stop_failed', 503)
    }
    settings.set(KEY, next)
    const helpers = []
    for (const row of rows) {
      if (!proxyRequiresExitIp(next, row.id) || !next.proxies?.[row.id]?.expected_ip) continue
      const result = await startHelper(row)
      helpers.push({ id: row.id, ok: !!result?.ok, error: result?.ok ? null : 'exit_guard_helper_unavailable' })
    }
    return { ...view(), helpers }
  }
  const mutate = (action) =>
    serial(action).then(async (result) => {
      await poll()
      return result
    })
  function setRequired(body) {
    return mutate(async () => {
      if (typeof body?.required !== 'boolean' || Object.keys(body).some((k) => k !== 'required'))
        throw failure('exit_guard_invalid_config')
      const prev = config()
      if (prev.required === body.required) return view()
      return apply(listProxies(), { ...prev, required: body.required })
    })
  }
  function setExpected(id, body, { rearm = false } = {}) {
    return mutate(async () => {
      const row = proxy(id)
      if (!rearm && body?.required === false && Object.keys(body).length === 1) {
        const prev = config()
        if (prev.proxies?.[id]?.required === false) return view()
        return apply([row], {
          ...prev,
          proxies: { ...prev.proxies, [id]: { required: false, revision: revision() } },
        })
      }
      if (!body || Object.keys(body).some((k) => k !== 'expected_ip')) throw failure('exit_guard_invalid_config')
      const expectedIp = canonicalExitIp(body.expected_ip)
      const prev = config()
      if (rearm && prev.proxies?.[id]?.expected_ip !== expectedIp) throw failure('exit_guard_expected_ip_changed', 409)
      if (!rearm && prev.proxies?.[id]?.expected_ip === expectedIp) return view()
      return apply([row], {
        ...prev,
        proxies: { ...prev.proxies, [id]: { expected_ip: expectedIp, revision: revision() } },
      })
    })
  }
  async function poll() {
    if (polling) return
    polling = true
    try {
      // Enforcement shares the mutation lock. Notification I/O never holds it.
      // A stale snapshot must not stop a helper that an operator has just rearmed.
      const events = await serial(async () => {
        const events = []
        for (const source of listProxies()) {
          const row = { id: source.id, ...policy(source.id), state: readState(source.id) }
          if (!row.required || row.state?.ready) {
            enforced.delete(row.id)
            alerted.delete(row.id)
            continue
          }
          if (!row.state?.latched && ['exit_guard_checking', 'exit_guard_retrying'].includes(row.state?.reason))
            continue
          const boundIds = source.bound_vm_ids || (source.bound_vm_id ? [source.bound_vm_id] : [])
          if (!row.expected_ip && !boundIds.length) continue
          const reason = row.state?.reason || 'exit_guard_unverified'
          const key = `${row.revision}:${reason}`
          const stopKey = `${key}:${[...boundIds].sort().join(',')}`
          if (boundIds.length && enforced.get(row.id) !== stopKey) {
            try {
              const stopped = await onBlock?.(source, reason)
              if (stopped?.ok === true) enforced.set(row.id, stopKey)
              else log('[exit-guard] slot_stop_failed; transport remains blocked')
            } catch {
              log('[exit-guard] slot_stop_failed; transport remains blocked')
            }
          }
          const previous = alerted.get(row.id)
          if (previous?.key === key && now() - previous.at < 300_000) continue
          alerted.set(row.id, { key, at: now() })
          events.push({ ...row, reason })
        }
        return events
      })
      for (const row of events) {
        // A queued alert should not describe superseded policy as current.
        if (policy(row.id).revision !== row.revision || !policy(row.id).required || readState(row.id)?.ready) continue
        const reason = row.reason
        const text = `出口校验已阻断 ${row.id}；指定 ${row.expected_ip || '未配置'}；观测 ${row.state?.observed_ip || '未知'}；原因 ${reason}。需要管理员检查并显式重新验证；不会自动接受新 IP。`
        log(`[exit-guard] ${text}`)
        try {
          const delivery = await notify?.({ title: '出口 IP 校验阻断', subject: 'vm2api · 出口 IP 校验阻断', text })
          if (delivery?.ok === false)
            log('[exit-guard] external_notification_failed; persistent status remains available')
        } catch {
          log('[exit-guard] external_notification_failed; persistent status remains available')
        }
      }
    } finally {
      polling = false
    }
  }
  return {
    view,
    policy,
    setRequired,
    setExpected,
    poll,
    start() {
      if (timer) return
      timer = setInterval(() => {
        void poll().catch(() => log('[exit-guard] monitor_failed'))
      }, 5000)
      timer.unref?.()
      void poll().catch(() => log('[exit-guard] monitor_failed'))
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
  }
}

export async function handleProxyExitGuard({ req, res, url, manager, readBody, json, role }) {
  res.setHeader('Cache-Control', 'no-store')
  if (role !== 'admin') return json(res, 403, { ok: false, error: { code: 'forbidden' } })
  if (!manager) return json(res, 503, { ok: false, error: { code: 'exit_guard_unavailable' } })
  const base = '/api/panel/proxy-exit-guard'
  try {
    let result
    if (url.pathname === base && req.method === 'GET') result = manager.view()
    else if (url.pathname === base && req.method === 'PUT')
      result = await manager.setRequired(await readBody(req, 8192))
    else {
      const match = url.pathname.match(/^\/api\/panel\/proxy-exit-guard\/([a-zA-Z0-9_-]+)(\/rearm)?$/)
      if (!match) throw failure('not_found', 404)
      if ((!match[2] && req.method === 'PUT') || (match[2] && req.method === 'POST'))
        result = await manager.setExpected(match[1], await readBody(req, 8192), { rearm: !!match[2] })
      else throw failure('method_not_allowed', 405)
    }
    return json(res, 200, { ok: true, data: result })
  } catch (error) {
    return json(res, error.status || 503, { ok: false, error: { code: error.code || 'exit_guard_update_failed' } })
  }
}
