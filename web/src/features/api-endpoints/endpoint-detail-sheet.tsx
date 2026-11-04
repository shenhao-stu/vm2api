import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  ApiEndpoint,
  ApiEndpointPreset,
  ApiKeyEntry,
  ApiModelEntry,
} from '@/types/panel-api-endpoints'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import {
  endpointPayload,
  modelsFromEndpoint,
  type ModelDraft,
} from './endpoint-payload'

type EndpointKind = NonNullable<ApiEndpoint['kind']>
type Protocol = 'anthropic' | 'openai'
type EpAuthScheme = 'x_api_key' | 'authorization_bearer'

const KIND_FALLBACK_LABEL: Record<EndpointKind, string> = {
  claude: 'Claude 官方',
  openai: 'OpenAI 官方',
  custom: '自定义',
  local_gateway: '本机 GPT 网关',
}

export function EndpointDetailSheet({
  open,
  endpoint,
  presets,
  onOpenChange,
}: {
  open: boolean
  endpoint: ApiEndpoint | null
  presets: ApiEndpointPreset[]
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='w-[95vw] overflow-y-auto sm:w-[560px] sm:max-w-none md:w-[720px] lg:w-[820px]'
      >
        {open ? (
          <EndpointForm
            key={endpoint?.id ?? 'create'}
            endpoint={endpoint}
            presets={presets}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function EndpointForm({
  endpoint,
  presets,
  onOpenChange,
}: {
  endpoint: ApiEndpoint | null
  presets: ApiEndpointPreset[]
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const isEdit = !!endpoint
  const [kind, setKind] = useState<EndpointKind>(endpoint?.kind || 'claude')
  const [protocol, setProtocol] = useState<Protocol>(
    (endpoint?.protocol as Protocol) ||
      (presetFor(presets, kind).protocol as Protocol)
  )
  const [authScheme, setAuthScheme] = useState<EpAuthScheme>(
    endpoint?.auth_scheme || 'x_api_key'
  )
  const [name, setName] = useState(
    endpoint?.name || presetFor(presets, kind).label
  )
  const [baseUrl, setBaseUrl] = useState(
    endpoint?.base_url || presetFor(presets, kind).base_url
  )
  const [prefix, setPrefix] = useState(endpoint?.prefix || '')
  const [priority, setPriority] = useState(String(endpoint?.priority ?? 0))
  const [disableCooling, setDisableCooling] = useState(
    !!endpoint?.disable_cooling
  )
  const [headersText, setHeadersText] = useState(
    endpoint ? JSON.stringify(endpoint.headers || {}, null, 2) : ''
  )
  const [models, setModels] = useState<ModelDraft[]>(
    modelsFromEndpoint(endpoint)
  )
  const [newKey, setNewKey] = useState('')
  const [newProxy, setNewProxy] = useState('')
  const keys = endpoint?.api_key_entries || []
  const localGateway = kind === 'local_gateway'
  const kindOptions = (Object.keys(KIND_FALLBACK_LABEL) as EndpointKind[]).map(
    (kind) => presetFor(presets, kind)
  )

  const refresh = () =>
    qc.invalidateQueries({ queryKey: apiEndpointsQueryOptions().queryKey })

  const applyKind = (nextKind: EndpointKind) => {
    const nextPreset = presetFor(presets, nextKind)
    const prevPreset = presetFor(presets, kind)
    setKind(nextKind)
    if (nextKind === 'local_gateway') {
      setHeadersText('')
      setNewProxy('')
      setAuthScheme('authorization_bearer')
    }
    if (nextKind !== 'custom') {
      setBaseUrl(nextPreset.base_url)
      setProtocol((nextPreset.protocol as Protocol) || 'anthropic')
    }
    // 名称为空、或仍是「自动填充」态时才跟着类型联动；用户改过名字就不再覆盖
    const autoNames = [prevPreset.label, 'api', '']
    if (autoNames.includes(name.trim())) {
      setName(nextKind === 'custom' ? '' : nextPreset.label)
    }
  }

  const fetchModels = useMutation({
    mutationFn: async (): Promise<{
      models?: ApiModelEntry[]
      fetched?: number
      item?: ApiEndpoint
    }> => {
      if (localGateway) throw new Error('本机网关需要手工配置允许的 GPT 模型')
      if (!isEdit) {
        const key = newKey.trim()
        if (!key) throw new Error('先填上游 key')
        return api<{ models?: ApiModelEntry[] }>(
          '/api/panel/api-endpoints/fetch-models',
          {
            method: 'POST',
            body: JSON.stringify({
              kind,
              protocol,
              base_url: baseUrl.trim(),
              api_key: key,
              proxy_url: newProxy.trim(),
              auth_scheme: authScheme,
            }),
          }
        )
      }
      return api<{ fetched?: number; item?: ApiEndpoint }>(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint!.id)}/fetch-models`,
        { method: 'POST', body: JSON.stringify({ apply: true }) }
      )
    },
    onSuccess: async (data) => {
      if (!isEdit) {
        const fetched = data.models || []
        setModels(
          fetched.length
            ? fetched.map((m: ApiModelEntry) => ({
                name: m.name || '',
                alias: m.alias || '',
                image: !!m.image,
                thinking: (m.thinking?.levels || []).join(','),
              }))
            : modelsFromEndpoint(null)
        )
        toast.success(`拉到 ${fetched.length} 个模型`)
      } else {
        setModels(modelsFromEndpoint(data.item ?? null))
        toast.success(
          `拉到 ${data.fetched ?? data.item?.models?.length ?? 0} 个模型`
        )
        await refresh()
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      if (!endpoint) {
        return api('/api/panel/api-endpoints', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      }
      return api(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        }
      )
    },
    onSuccess: async () => {
      toast.success(isEdit ? '已保存' : '地址已添加')
      onOpenChange(false)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const addKey = useMutation({
    mutationFn: (body: { api_key: string; proxy_url?: string }) => {
      if (!endpoint) throw new Error('地址不存在')
      return api(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint.id)}/keys`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      )
    },
    onSuccess: async () => {
      toast.success('key 已加入')
      setNewKey('')
      setNewProxy('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const removeKey = useMutation({
    mutationFn: (kid: string) => {
      if (!endpoint) throw new Error('地址不存在')
      return api(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint.id)}/keys/${encodeURIComponent(kid)}`,
        { method: 'DELETE' }
      )
    },
    onSuccess: async () => {
      toast.success('已删除 key')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const pending = save.isPending || addKey.isPending || removeKey.isPending

  return (
    <>
      <SheetHeader className='pb-2'>
        <SheetTitle>{isEdit ? '编辑地址' : '添加地址'}</SheetTitle>
        <SheetDescription>
          {isEdit
            ? endpoint?.name || endpoint?.id
            : '直连上游 · key 池 · 模型 alias。地址不要带 /v1。'}
        </SheetDescription>
      </SheetHeader>
      <div className='space-y-6 pb-8'>
        <section className='space-y-3'>
          <h3 className='text-sm font-medium'>基本信息</h3>
          <Field label='类型'>
            <Select
              value={kind}
              onValueChange={(value) => applyKind(value as EndpointKind)}
            >
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kindOptions.map((p) => (
                  <SelectItem key={p.kind} value={p.kind}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label='名称'>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='api'
            />
          </Field>
          {kind === 'custom' || localGateway ? (
            <Field label={localGateway ? '本机网关地址' : '地址'}>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                aria-label={localGateway ? '本机网关地址' : '地址'}
                placeholder={
                  localGateway
                    ? 'http://127.0.0.1:8787'
                    : 'https://api.example.com'
                }
              />
            </Field>
          ) : null}
          {kind === 'custom' ? (
            <Field label='协议'>
              <Select
                value={protocol}
                onValueChange={(value) => setProtocol(value as Protocol)}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='anthropic'>Anthropic Messages</SelectItem>
                  <SelectItem value='openai'>OpenAI Chat</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label='前缀'>
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder='可选'
            />
          </Field>
          <Field label='优先级'>
            <Input
              type='number'
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </Field>
          {!localGateway ? (
            <Field label='上游认证'>
              <Select
                value={authScheme}
                onValueChange={(value) => setAuthScheme(value as EpAuthScheme)}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='x_api_key'>x-api-key</SelectItem>
                  <SelectItem value='authorization_bearer'>
                    Authorization: Bearer
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <p className='text-xs text-muted-foreground'>
              仅连接本机回环地址，使用 OpenAI Responses 协议及 Bearer
              认证。统一密钥只会调用这里明确配置的 GPT 模型。
            </p>
          )}
          <div className='flex items-center justify-between gap-3'>
            <Label htmlFor='disable_cooling'>关闭 429 冷却</Label>
            <Switch
              id='disable_cooling'
              checked={disableCooling}
              onCheckedChange={setDisableCooling}
            />
          </div>
          {!localGateway ? (
            <Field label='Headers（JSON）'>
              <Textarea
                className='font-mono text-xs'
                rows={4}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder='{"anthropic-beta":"…"}'
              />
            </Field>
          ) : null}
        </section>

        <section className='space-y-3'>
          <h3 className='text-sm font-medium'>上游 key</h3>
          {isEdit ? (
            keys.length ? (
              <div className='space-y-2'>
                {keys.map((entry) => (
                  <KeyRow
                    key={entry.id}
                    entry={entry}
                    busy={pending}
                    onRemove={() => removeKey.mutate(entry.id)}
                  />
                ))}
              </div>
            ) : (
              <p className='text-xs text-muted-foreground'>还没有 key</p>
            )
          ) : null}
          <div className='grid gap-2 sm:grid-cols-2'>
            <Field label={isEdit ? '新 key' : '上游 key'}>
              <Input
                id='api_key'
                name='api_key'
                type='password'
                autoComplete='off'
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder='sk-…'
              />
            </Field>
            {!localGateway ? (
              <Field label='代理'>
                <Input
                  value={newProxy}
                  onChange={(e) => setNewProxy(e.target.value)}
                  placeholder='socks5://… 可选'
                />
              </Field>
            ) : null}
          </div>
          {isEdit ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={pending}
              onClick={() => {
                const api_key = newKey.trim()
                if (!api_key) {
                  toast.error('先填上游 key')
                  return
                }
                addKey.mutate({
                  api_key,
                  ...(!localGateway ? { proxy_url: newProxy.trim() } : {}),
                })
              }}
            >
              加 key
            </Button>
          ) : !localGateway ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={fetchModels.isPending}
              loading={fetchModels.isPending}
              onClick={() => fetchModels.mutate()}
            >
              获取模型
            </Button>
          ) : null}
        </section>

        <section className='space-y-3'>
          <div className='flex items-center justify-between gap-2'>
            <h3 className='text-sm font-medium'>模型</h3>
            <div className='flex items-center gap-2'>
              {isEdit && !localGateway ? (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={fetchModels.isPending || keys.length === 0}
                  loading={fetchModels.isPending}
                  onClick={() => fetchModels.mutate()}
                >
                  获取模型
                </Button>
              ) : null}
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() =>
                  setModels((rows) => [
                    ...rows,
                    { name: '', alias: '', image: false, thinking: '' },
                  ])
                }
              >
                加一行
              </Button>
            </div>
          </div>
          {localGateway ? (
            <p className='text-xs text-muted-foreground'>
              手工列出允许调用的 GPT
              模型和客户端别名；保存不会自动拉取或扩大模型范围。
            </p>
          ) : null}
          {models.length ? (
            <div className='space-y-2'>
              {models.map((row, index) => (
                <ModelRow
                  key={index}
                  row={row}
                  localGateway={localGateway}
                  onChange={(next) =>
                    setModels((rows) =>
                      rows.map((item, i) =>
                        i === index ? { ...item, ...next } : item
                      )
                    )
                  }
                  onRemove={() =>
                    setModels((rows) => rows.filter((_, i) => i !== index))
                  }
                />
              ))}
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>
              还没有模型。点「加一行」补 alias。
            </p>
          )}
        </section>
      </div>
      <SheetFooter>
        <Button
          type='button'
          disabled={pending}
          onClick={() => {
            try {
              save.mutate(
                endpointPayload(
                  {
                    kind,
                    protocol,
                    name,
                    baseUrl,
                    prefix,
                    priority,
                    disableCooling,
                    authScheme,
                    headersText,
                    models,
                    newKey,
                    newProxy,
                  },
                  isEdit
                )
              )
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : '地址配置无效'
              )
            }
          }}
        >
          {isEdit ? '保存' : '添加'}
        </Button>
      </SheetFooter>
    </>
  )
}

function KeyRow({
  entry,
  busy,
  onRemove,
}: {
  entry: ApiKeyEntry
  busy: boolean
  onRemove: () => void
}) {
  const cooldown = cooldownLabel(entry.cooldown_until)
  return (
    <div className='flex flex-wrap items-center gap-2 rounded-md border px-3 py-2'>
      <span className='font-mono text-xs'>{entry.id}</span>
      <span className='font-mono text-xs text-muted-foreground'>
        {entry.api_key ||
          (entry.key_suffix ? `••••${entry.key_suffix}` : '••••••••')}
      </span>
      {entry.disabled ? (
        <span className='text-xs text-muted-foreground'>停用</span>
      ) : null}
      {cooldown ? (
        <span className='text-xs text-muted-foreground'>{cooldown}</span>
      ) : null}
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='ms-auto'
        disabled={busy}
        onClick={onRemove}
      >
        删
      </Button>
    </div>
  )
}

function ModelRow({
  row,
  localGateway = false,
  onChange,
  onRemove,
}: {
  row: ModelDraft
  localGateway?: boolean
  onChange: (next: Partial<ModelDraft>) => void
  onRemove: () => void
}) {
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <Input
        className='min-w-[8rem] flex-1'
        placeholder={localGateway ? '上游 GPT 模型名' : '上游 name'}
        value={row.name}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <Input
        className='min-w-[8rem] flex-1'
        placeholder={localGateway ? '客户端 GPT 别名' : 'alias'}
        value={row.alias}
        onChange={(e) => onChange({ alias: e.target.value })}
      />
      {!localGateway ? (
        <label className='flex items-center gap-1.5 text-sm'>
          <Checkbox
            checked={row.image}
            onCheckedChange={(value) => onChange({ image: value === true })}
          />
          图
        </label>
      ) : null}
      <Input
        className='min-w-[10rem] flex-1'
        placeholder='thinking levels'
        value={row.thinking}
        onChange={(e) => onChange({ thinking: e.target.value })}
      />
      <Button type='button' size='sm' variant='ghost' onClick={onRemove}>
        删
      </Button>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-1'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

/** 官方预设联动（地址/协议随类型自动填充），custom 兜底为空地址 + anthropic。 */
function presetFor(
  presets: ApiEndpointPreset[],
  kind: string
): { kind: string; label: string; base_url: string; protocol: string } {
  const found = presets.find((p) => p.kind === kind)
  if (found) return found
  if (kind === 'local_gateway')
    return { kind, label: '本机 GPT 网关', base_url: '', protocol: 'openai' }
  if (kind === 'custom')
    return {
      kind: 'custom',
      label: '自定义',
      base_url: '',
      protocol: 'anthropic',
    }
  if (kind === 'openai')
    return {
      kind: 'openai',
      label: 'OpenAI 官方',
      base_url: 'https://api.openai.com',
      protocol: 'openai',
    }
  return {
    kind: 'claude',
    label: 'Claude 官方',
    base_url: 'https://api.anthropic.com',
    protocol: 'anthropic',
  }
}

function cooldownLabel(until?: number): string | null {
  if (!until) return null
  const formatted = fmtExpiresAt(until)
  if (!formatted || formatted === '—') return '冷却中'
  return `冷却中 · ${formatted}`
}
