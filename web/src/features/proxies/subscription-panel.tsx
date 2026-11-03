import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Trash2, Download } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ProxyPanel } from './proxy-panel'
import { useRefreshProxies } from './queries'

type Subscription = {
  id: string
  name: string
  source: 'url' | 'text'
  node_count: number
  retained_count: number
  auto_refresh?: boolean
  refresh_interval_minutes?: number
  next_refresh_at?: string | null
  last_success_at?: string | null
  last_error?: string | null
}
type SubscriptionView = {
  runtime: { available: boolean; running: boolean }
  profiles: Subscription[]
  error?: string | null
}
const queryKey = ['panel', 'proxy-subscriptions'] as const
const endpoint = '/api/panel/proxy-subscriptions'

export function SubscriptionPanel() {
  const isAdmin = useAuthStore((state) => state.me?.role === 'admin')
  return isAdmin ? <AdminSubscriptionPanel /> : null
}

function AdminSubscriptionPanel() {
  const client = useQueryClient()
  const refreshProxies = useRefreshProxies()
  const query = useQuery({
    queryKey,
    queryFn: () => api<SubscriptionView>(endpoint),
  })
  const [source, setSource] = useState<'url' | 'text'>('url')
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [deleting, setDeleting] = useState<Subscription | null>(null)
  const mutation = useMutation({
    mutationFn: ({
      route = '',
      method = 'POST',
      body,
    }: {
      route?: string
      method?: string
      body?: object
    }) =>
      api<SubscriptionView>(`${endpoint}${route}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: async (view) => {
      client.setQueryData(queryKey, view)
      setValue('')
      setName('')
      setEditingId(null)
      setDeleting(null)
      toast.success('订阅代理已更新')
      await refreshProxies()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const available = query.data?.runtime.available === true
  return (
    <ProxyPanel
      title='代理订阅'
      meta={
        <span className='text-xs text-muted-foreground'>
          {query.data?.runtime.running ? '运行中' : '未运行'}
        </span>
      }
    >
      {query.isError ? (
        <p className='text-xs text-destructive'>订阅状态暂不可用</p>
      ) : null}
      {query.data && !available ? (
        <p className='mb-3 text-xs text-muted-foreground'>
          代理内核尚未启用，请检查部署配置。
        </p>
      ) : null}
      {query.data?.error ? (
        <p className='mb-3 text-xs text-destructive'>
          订阅出口暂不可用，已有绑定不会切换为直连。
        </p>
      ) : null}
      <div className='mb-2 flex gap-2'>
        <Button
          size='sm'
          variant={source === 'url' ? 'secondary' : 'ghost'}
          onClick={() => {
            setSource('url')
            setValue('')
          }}
        >
          订阅链接
        </Button>
        <Button
          size='sm'
          variant={source === 'text' ? 'secondary' : 'ghost'}
          onClick={() => {
            setSource('text')
            setValue('')
          }}
        >
          粘贴配置
        </Button>
      </div>
      <Input
        aria-label='订阅名称'
        placeholder='订阅名称（可选）'
        value={name}
        maxLength={100}
        autoComplete='off'
        onChange={(event) => setName(event.target.value)}
        className='mb-2'
      />
      {source === 'url' ? (
        <Input
          type='password'
          aria-label='订阅链接'
          placeholder='https://…'
          value={value}
          autoComplete='off'
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <Textarea
          aria-label='订阅内容'
          placeholder='Clash YAML / JSON、Base64 或协议链接列表'
          value={value}
          autoComplete='off'
          spellCheck={false}
          rows={4}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <p className='mt-2 text-[11px] text-muted-foreground'>
        支持 Clash 配置与协议链接，包括
        VLESS、VMess、SS/SSR、Trojan、Hysteria、TUIC、AnyTLS、Snell、Mieru、WireGuard、SSH、SOCKS5
        和 HTTP。链接默认每 6 小时刷新；已绑定线路变化时保留原配置。
      </p>
      {editingId ? (
        <p className='mt-2 text-xs'>
          正在重新导入 {name}。已绑定旧节点会保留，新配置成为独立节点。
          <Button
            size='sm'
            variant='ghost'
            onClick={() => {
              setEditingId(null)
              setName('')
              setValue('')
            }}
          >
            取消
          </Button>
        </p>
      ) : null}
      <Button
        className='mt-3'
        size='sm'
        loading={mutation.isPending}
        disabled={!available || !value.trim() || mutation.isPending}
        onClick={() =>
          mutation.mutate({
            body: {
              ...(editingId ? { id: editingId } : {}),
              ...(name.trim() ? { name: name.trim() } : {}),
              [source === 'url' ? 'url' : 'content']: value.trim(),
            },
          })
        }
      >
        <Download aria-hidden='true' /> 导入订阅
      </Button>
      <div className='mt-3 space-y-2'>
        {(query.data?.profiles || []).map((profile) => (
          <div
            key={profile.id}
            className='flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2 text-xs'
          >
            <span className='min-w-0 flex-1 truncate'>
              {profile.name} · {profile.node_count} 个节点
              {profile.retained_count
                ? ` · 保留 ${profile.retained_count}`
                : ''}
            </span>
            <Button
              size='sm'
              variant='ghost'
              disabled={mutation.isPending}
              onClick={() => {
                setEditingId(profile.id)
                setName(profile.name)
                setSource(profile.source)
                setValue('')
              }}
            >
              重新导入
            </Button>
            <Button
              size='icon'
              variant='ghost'
              aria-label={`刷新 ${profile.name}`}
              disabled={mutation.isPending || !available}
              onClick={() =>
                mutation.mutate({ route: `/${profile.id}/refresh` })
              }
            >
              <RefreshCw className='size-3.5' />
            </Button>
            <Button
              size='icon'
              variant='ghost'
              aria-label={`删除 ${profile.name}`}
              disabled={mutation.isPending || !available}
              onClick={() => setDeleting(profile)}
            >
              <Trash2 className='size-3.5' />
            </Button>
            {profile.source === 'url' ? (
              <div className='flex w-full flex-wrap items-center gap-2 text-muted-foreground'>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={mutation.isPending || !available}
                  onClick={() =>
                    mutation.mutate({
                      route: `/${profile.id}`,
                      method: 'PATCH',
                      body: { auto_refresh: !profile.auto_refresh },
                    })
                  }
                >
                  {profile.auto_refresh ? '暂停自动刷新' : '开启自动刷新'}
                </Button>
                <label className='flex items-center gap-1'>
                  间隔（分钟）
                  <Input
                    type='number'
                    aria-label={`${profile.name} 刷新间隔`}
                    className='h-7 w-24'
                    key={`${profile.id}-${profile.refresh_interval_minutes}`}
                    defaultValue={profile.refresh_interval_minutes ?? 360}
                    min={15}
                    max={10080}
                    disabled={mutation.isPending || !available}
                    onBlur={(event) => {
                      const minutes = Number(event.target.value)
                      if (
                        !Number.isInteger(minutes) ||
                        minutes < 15 ||
                        minutes > 10080
                      ) {
                        toast.error('刷新间隔应为 15–10080 分钟')
                        return
                      }
                      if (minutes !== profile.refresh_interval_minutes)
                        mutation.mutate({
                          route: `/${profile.id}`,
                          method: 'PATCH',
                          body: { refresh_interval_minutes: minutes },
                        })
                    }}
                  />
                </label>
                {profile.next_refresh_at ? (
                  <span>
                    下次：{new Date(profile.next_refresh_at).toLocaleString()}
                  </span>
                ) : null}
                {profile.last_success_at ? (
                  <span>
                    上次成功：
                    {new Date(profile.last_success_at).toLocaleString()}
                  </span>
                ) : null}
              </div>
            ) : null}
            {profile.last_error ? (
              <p role='status' className='w-full text-destructive'>
                {profile.last_error === 'subscription_bound_changed'
                  ? '已绑定线路发生变化，已保留原配置。检查后可手动重新导入。'
                  : '刷新失败，已保留原配置。'}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title='删除代理订阅'
        desc={`删除 ${deleting?.name || ''} 及其未绑定节点。已绑定节点需要先解除绑定。`}
        confirmText='删除'
        destructive
        handleConfirm={() => {
          if (deleting)
            mutation.mutate({ route: `/${deleting.id}`, method: 'DELETE' })
        }}
      />
    </ProxyPanel>
  )
}
