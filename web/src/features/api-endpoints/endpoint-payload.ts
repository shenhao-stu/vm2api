import type { ApiEndpoint, ApiModelEntry } from '@/types/panel-api-endpoints'

export type ModelDraft = {
  name: string
  alias: string
  image: boolean
  thinking: string
}

export type EndpointDraft = {
  kind: NonNullable<ApiEndpoint['kind']>
  protocol: 'anthropic' | 'openai'
  name: string
  baseUrl: string
  prefix: string
  priority: string
  disableCooling: boolean
  authScheme: 'x_api_key' | 'authorization_bearer'
  headersText: string
  models: ModelDraft[]
  newKey: string
  newProxy: string
}

export function modelsFromEndpoint(endpoint: ApiEndpoint | null): ModelDraft[] {
  const models = endpoint?.models || []
  if (!models.length)
    return [{ name: '', alias: '', image: false, thinking: '' }]
  return models.map((model) => ({
    name: model.name || '',
    alias: model.alias || '',
    image: !!model.image,
    thinking: (model.thinking?.levels || []).join(','),
  }))
}

export function endpointPayload(
  draft: EndpointDraft,
  isEdit: boolean
): Record<string, unknown> {
  const local = draft.kind === 'local_gateway'
  let headers: Record<string, unknown>
  try {
    headers = JSON.parse(draft.headersText.trim() || '{}')
    if (!headers || typeof headers !== 'object' || Array.isArray(headers))
      throw new Error()
  } catch {
    throw new Error('Headers 不是合法 JSON')
  }
  let base_url = draft.baseUrl.trim()
  if (local) {
    let url: URL
    try {
      url = new URL(base_url)
    } catch {
      throw new Error('请输入本机回环地址，如 http://127.0.0.1:8787')
    }
    if (
      !(
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]'
      ) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        '本机网关仅支持回环 HTTP(S) 地址，不带 /v1、账号或查询参数'
      )
    }
    if (
      draft.newProxy.trim() ||
      Object.keys(headers).some((key) => key !== 'auth_scheme') ||
      (headers.auth_scheme && headers.auth_scheme !== 'authorization_bearer')
    ) {
      throw new Error('本机网关不使用代理或自定义 Headers')
    }
    base_url = url.origin
  }
  const models: ApiModelEntry[] = []
  for (const row of draft.models) {
    const name = row.name.trim(),
      alias = row.alias.trim() || name
    if (!name) {
      if (local && alias) throw new Error('每个 GPT 别名都需要对应的上游模型名')
      continue
    }
    if (local && row.image) throw new Error('本机网关仅支持 GPT 对话模型')
    const levels = row.thinking.split(/[,\s]+/).filter(Boolean)
    models.push({
      name,
      alias,
      ...(row.image ? { image: true } : {}),
      ...(levels.length ? { thinking: { levels } } : {}),
    })
  }
  if (local && !models.length)
    throw new Error('至少手工配置一个允许的 GPT 模型')
  const body: Record<string, unknown> = {
    kind: draft.kind,
    protocol: local ? 'openai' : draft.protocol,
    name: draft.name.trim() || 'api',
    base_url,
    prefix: draft.prefix.trim(),
    priority: Number(draft.priority || 0),
    disable_cooling: draft.disableCooling,
    auth_scheme: local ? 'authorization_bearer' : draft.authScheme,
    headers: local ? {} : headers,
    models,
  }
  if (!isEdit) {
    const api_key = draft.newKey.trim()
    body.api_key_entries = api_key
      ? [{ api_key, ...(!local ? { proxy_url: draft.newProxy.trim() } : {}) }]
      : []
  }
  return body
}
