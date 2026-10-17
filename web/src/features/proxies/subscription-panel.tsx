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
        支持 VLESS、VMess、Shadowsocks、Trojan、Hysteria2、TUIC、SOCKS5 和
        HTTP。导入后在代理池中绑定控制面本机槽位；刷新保留仍在使用的旧节点。
      </p>
      <Button
        className='mt-3'
        size='sm'
        loading={mutation.isPending}
        disabled={!available || !value.trim() || mutation.isPending}
        onClick={() =>
          mutation.mutate({
            body: {
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
            className='flex items-center gap-2 rounded-md bg-muted/40 p-2 text-xs'
          >
            <span className='min-w-0 flex-1 truncate'>
              {profile.name} · {profile.node_count} 个节点
              {profile.retained_count
                ? ` · 保留 ${profile.retained_count}`
                : ''}
            </span>
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
