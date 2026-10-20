import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

type GuardView = {
  required: boolean
  proxies: {
    id: string
    expected_ip: string
    state: {
      ready: boolean
      latched: boolean
      reason: string
      observed_ip?: string
    }
  }[]
}

export function ExitGuardStatus() {
  const query = useQuery({
    queryKey: ['panel', 'proxy-exit-guard'],
    queryFn: () => api<GuardView>('/api/panel/proxy-exit-guard'),
    refetchInterval: 10_000,
  })
  if (query.isPending)
    return (
      <p className='text-sm text-muted-foreground'>正在读取出口 IP 保护状态…</p>
    )
  if (query.isError || !query.data) {
    return (
      <p role='alert' className='text-sm text-destructive'>
        出口 IP 保护状态暂不可用，请勿据此判断出口已放行。
      </p>
    )
  }
  const configured = query.data.proxies.filter((proxy) => proxy.expected_ip)
  const blocked = configured.filter(
    (proxy) => !proxy.state.ready || proxy.state.latched
  )
  return (
    <section
      className='mb-4 rounded-lg border p-3 text-sm'
      aria-label='出口 IP 保护'
    >
      <p className='font-medium'>
        出口 IP 保护：{query.data.required ? '已启用' : '未启用'}
      </p>
      {query.data.required ? (
        <>
          <p className='mt-1 text-muted-foreground'>
            已配置 {configured.length} 个固定出口，其中 {blocked.length}{' '}
            个未放行。
          </p>
          {!configured.length ? (
            <p role='alert' className='mt-1 text-destructive'>
              尚未配置预期出口，受保护请求将被拒绝。
            </p>
          ) : null}
          {blocked.map((proxy) => (
            <p role='alert' key={proxy.id} className='mt-1 text-destructive'>
              {proxy.id} · 预期 {proxy.expected_ip} · 最近观测{' '}
              {proxy.state.observed_ip || '未知'} · {proxy.state.reason}
            </p>
          ))}
        </>
      ) : (
        <p className='mt-1 text-muted-foreground'>
          当前没有启用固定出口 IP 校验。
        </p>
      )}
      <p className='mt-2 text-xs text-muted-foreground'>
        本机浏览器打开的 OAuth
        授权网页不经过服务端代理；此处状态不能证明浏览器的登录出口。
      </p>
    </section>
  )
}
