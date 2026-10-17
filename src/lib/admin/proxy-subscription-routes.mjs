import { SubscriptionError } from '../vm/subscription-network.mjs'

export async function handleProxySubscriptions({ req, res, url, manager, readBody, json, role }) {
  res.setHeader('Cache-Control', 'no-store')
  if (role !== 'admin')
    return json(res, 403, { ok: false, error: { code: 'forbidden', message: '仅管理员可管理代理订阅' } })
  if (!manager)
    return json(res, 503, { ok: false, error: { code: 'subscription_runtime', message: '代理订阅服务未配置' } })
  const base = '/api/panel/proxy-subscriptions'
  try {
    let result
    if (req.method === 'GET' && url.pathname === base) result = manager.view()
    else if (req.method === 'POST' && url.pathname === base)
      result = await manager.import(await readBody(req, 3 * 1024 * 1024))
    else {
      const match = url.pathname.match(/^\/api\/panel\/proxy-subscriptions\/(sub-[a-f0-9]{16})(\/refresh)?$/)
      if (!match) return json(res, 404, { ok: false, error: { code: 'not_found', message: '订阅操作不存在' } })
      if (req.method === 'POST' && match[2]) result = await manager.import({ id: match[1] })
      else if (req.method === 'DELETE' && !match[2]) result = await manager.remove(match[1])
      else return json(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '不支持的订阅操作' } })
    }
    return json(res, 200, { ok: true, data: result })
  } catch (cause) {
    const error = cause instanceof SubscriptionError ? cause : new SubscriptionError()
    const status =
      {
        subscription_runtime: 503,
        subscription_fetch: 502,
        subscription_storage: 503,
        subscription_limit: 413,
        subscription_busy: 409,
        subscription_bound: 409,
        subscription_not_found: 404,
      }[error.code] || 400
    return json(res, status, { ok: false, error: { code: error.code, message: error.message } })
  }
}
