import { describe, expect, it } from 'vitest'
import {
  keyLimitsDraft,
  keyLimitsPayload,
  keyServiceLabel,
  selectKeyService,
  type KeyLimitsDraft,
} from './key-payload'

const draft: KeyLimitsDraft = {
  name: ' ops ',
  category: 'api',
  max_concurrency: 4,
  quota_requests: 12,
  quota_usd: 3.5,
  rpm: 60,
  expires_in_days: 30,
  group_type: 'anthropic',
  allowed_vms: ['vm-01', 'vm-01', ' '],
}

describe('API key limit payload', () => {
  it('keeps request and USD quotas separate', () => {
    expect(keyLimitsPayload(draft, 'create')).toEqual({
      name: 'ops',
      category: 'api',
      max_concurrency: 4,
      quota_requests: 12,
      quota_usd: 3.5,
      rpm: 60,
      expires_in_days: 30,
      group_type: 'anthropic',
      allowed_vms: ['vm-01'],
    })
  })

  it('sends category only for admins', () => {
    expect(keyLimitsPayload(draft, 'create', { isAdmin: true }).category).toBe(
      'api'
    )
    expect(
      keyLimitsPayload(draft, 'create', { isAdmin: false })
    ).not.toHaveProperty('category')
    expect(
      keyLimitsPayload(draft, 'edit', { isAdmin: false })
    ).not.toHaveProperty('category')
  })

  it('omits create-only fields from edits and rejects invalid quotas', () => {
    expect(keyLimitsPayload(draft, 'edit')).not.toHaveProperty('name')
    expect(keyLimitsPayload(draft, 'edit')).not.toHaveProperty(
      'expires_in_days'
    )
    expect(() =>
      keyLimitsPayload({ ...draft, quota_requests: 1.5 }, 'create')
    ).toThrow('请求额度')
    expect(() =>
      keyLimitsPayload({ ...draft, quota_usd: -1 }, 'create')
    ).toThrow('USD 额度')
    expect(
      keyLimitsPayload(
        { ...draft, group_type: 'all', allowed_vms: ['vm-01'] },
        'create'
      )
    ).toMatchObject({
      group_type: 'all',
      allowed_vms: [],
    })
    expect(() =>
      keyLimitsPayload({ ...draft, allowed_vms: [] }, 'create')
    ).toThrow('至少选择一台 VM')
  })

  it('handles vm_pool_id for admin and strips it for non-admin', () => {
    const pooledDraft: KeyLimitsDraft = {
      ...draft,
      group_type: 'pool',
      vm_pool_id: 'pool_12345678',
    }

    // Admin creates key with pool
    const adminCreate = keyLimitsPayload(pooledDraft, 'create', {
      isAdmin: true,
    })
    expect(adminCreate.vm_pool_id).toBe('pool_12345678')
    expect(adminCreate.group_type).toBe('all')
    expect(adminCreate.allowed_vms).toEqual([])

    // Admin edits key with non-pool group_type -> vm_pool_id cleared to null
    const adminEditAll = keyLimitsPayload(
      { ...draft, group_type: 'all', vm_pool_id: 'pool_12345678' },
      'edit',
      { isAdmin: true }
    )
    expect(adminEditAll.vm_pool_id).toBeNull()

    // Non-admin payload must not carry vm_pool_id under any mode or group_type
    const tenantCreate = keyLimitsPayload(
      { ...draft, group_type: 'all', vm_pool_id: 'pool_12345678' },
      'create',
      { isAdmin: false }
    )
    expect(tenantCreate).not.toHaveProperty('vm_pool_id')

    const tenantEdit = keyLimitsPayload(
      { ...draft, group_type: 'all', vm_pool_id: 'pool_12345678' },
      'edit',
      { isAdmin: false }
    )
    expect(tenantEdit).not.toHaveProperty('vm_pool_id')

    // If non-admin passes group_type: 'pool' (e.g. from tampered client state), fallback cleanly without vm_pool_id
    const tenantTampered = keyLimitsPayload(pooledDraft, 'create', {
      isAdmin: false,
    })
    expect(tenantTampered).not.toHaveProperty('vm_pool_id')
    expect(tenantTampered.group_type).toBe('all')
  })

  it('editing a unified key preserves its native Claude scope and selected GPT gateway', () => {
    const restored = keyLimitsDraft(
      {
        id: 'key_unified',
        category: 'hybrid',
        group_type: 'anthropic',
        allowed_vms: ['line01', 'line02'],
        openai_endpoint_id: 'ep_0123456789ab',
        max_concurrency: 1,
      },
      true
    )
    expect(
      keyLimitsPayload({ ...restored, quota_requests: 100 }, 'edit')
    ).toMatchObject({
      category: 'hybrid',
      group_type: 'anthropic',
      allowed_vms: ['line01', 'line02'],
      openai_endpoint_id: 'ep_0123456789ab',
      max_concurrency: 1,
      quota_requests: 100,
    })
    expect(() =>
      keyLimitsPayload({ ...restored, group_type: 'all' }, 'edit')
    ).toThrow('Claude')
    expect(() =>
      keyLimitsPayload({ ...restored, openai_endpoint_id: '' }, 'edit')
    ).toThrow('GPT')
  })

  it('keeps hybrid pools Anthropic-scoped and leaves admin routing untouched in tenant limit edits', () => {
    const restored = keyLimitsDraft(
      {
        id: 'key_unified',
        category: 'hybrid',
        group_type: 'anthropic',
        vm_pool_id: 'pool_12345678',
        openai_endpoint_id: 'ep_0123456789ab',
      },
      true
    )
    expect(keyLimitsPayload(restored, 'edit')).toMatchObject({
      group_type: 'anthropic',
      allowed_vms: [],
      vm_pool_id: 'pool_12345678',
      category: 'hybrid',
    })
    const tenant = keyLimitsPayload(restored, 'edit', { isAdmin: false })
    expect(() =>
      keyLimitsPayload(restored, 'create', { isAdmin: false })
    ).toThrow('管理员')
    for (const field of [
      'category',
      'group_type',
      'allowed_vms',
      'vm_pool_id',
      'openai_endpoint_id',
    ]) {
      expect(tenant).not.toHaveProperty(field)
    }
    expect(keyLimitsDraft().category).toBe('oauth')
    expect(keyLimitsDraft({ id: 'api', category: 'api' }).category).toBe('api')
    expect(
      keyLimitsPayload({ ...restored, category: 'oauth' }, 'edit')
        .openai_endpoint_id
    ).toBeNull()
  })

  it('creates separate Claude and GPT keys with concurrency one and no cross-service scope', () => {
    const claude = {
      ...keyLimitsDraft(null, true),
      name: 'Claude pool',
      allowed_vms: ['line01'],
    }
    expect(keyLimitsPayload(claude, 'create')).toMatchObject({
      category: 'oauth',
      group_type: 'anthropic',
      allowed_vms: ['line01'],
      max_concurrency: 1,
    })
    expect(keyLimitsPayload(claude, 'create')).not.toHaveProperty(
      'openai_endpoint_id'
    )
    const gpt = {
      ...keyLimitsDraft(null, true, 'gpt'),
      name: 'GPT pool',
      openai_endpoint_id: 'ep_0123456789ab',
    }
    expect(keyLimitsPayload(gpt, 'create')).toMatchObject({
      category: 'hybrid',
      group_type: 'openai',
      allowed_vms: [],
      vm_pool_id: null,
      openai_endpoint_id: 'ep_0123456789ab',
      max_concurrency: 1,
    })
    expect(keyServiceLabel(gpt)).toBe('GPT 托管池')
    expect(keyServiceLabel(claude)).toBe('Claude 托管池')
    expect(() =>
      keyLimitsPayload({ ...gpt, allowed_vms: ['line01'] }, 'create')
    ).toThrow('不绑定原生槽位')
    expect(() =>
      keyLimitsPayload({ ...gpt, vm_pool_id: 'pool_12345678' }, 'create')
    ).toThrow('不绑定原生槽位')
    expect(() => keyLimitsPayload(gpt, 'create', { isAdmin: false })).toThrow(
      '管理员'
    )
  })

  it('edits a GPT key without requiring native VMs or downgrading its gateway binding', () => {
    const gpt = keyLimitsDraft(
      {
        id: 'key_gpt',
        category: 'hybrid',
        group_type: 'openai',
        allowed_vms: [],
        vm_pool_id: null,
        openai_endpoint_id: 'ep_0123456789ab',
        max_concurrency: 1,
      },
      true
    )
    expect(keyLimitsPayload(gpt, 'edit')).toMatchObject({
      category: 'hybrid',
      group_type: 'openai',
      allowed_vms: [],
      vm_pool_id: null,
      openai_endpoint_id: 'ep_0123456789ab',
    })
    const tenant = keyLimitsPayload(gpt, 'edit', { isAdmin: false })
    for (const field of [
      'category',
      'group_type',
      'allowed_vms',
      'vm_pool_id',
      'openai_endpoint_id',
    ])
      expect(tenant).not.toHaveProperty(field)
  })

  it('explicit service changes reset incompatible routes; new mixed keys are rejected', () => {
    const claude = {
      ...keyLimitsDraft(null, true),
      allowed_vms: ['line01'],
      vm_pool_id: 'pool_12345678',
    }
    const gpt = selectKeyService(claude, 'gpt')
    expect(gpt).toMatchObject({
      category: 'hybrid',
      group_type: 'openai',
      allowed_vms: [],
      vm_pool_id: '',
      max_concurrency: 1,
    })
    const back = selectKeyService(
      { ...gpt, openai_endpoint_id: 'ep_0123456789ab' },
      'claude'
    )
    expect(back).toMatchObject({
      category: 'oauth',
      group_type: 'anthropic',
      openai_endpoint_id: '',
      allowed_vms: [],
    })
    expect(
      keyLimitsPayload(
        { ...back, group_type: 'pool', vm_pool_id: 'pool_12345678' },
        'create'
      )
    ).toMatchObject({
      category: 'oauth',
      group_type: 'anthropic',
      vm_pool_id: 'pool_12345678',
    })
    expect(() =>
      keyLimitsPayload(
        {
          ...claude,
          category: 'hybrid',
          openai_endpoint_id: 'ep_0123456789ab',
        },
        'create'
      )
    ).toThrow('分别创建')
    expect(selectKeyService(gpt, 'api')).toMatchObject({
      category: 'api',
      group_type: 'all',
      openai_endpoint_id: '',
    })
  })
})
