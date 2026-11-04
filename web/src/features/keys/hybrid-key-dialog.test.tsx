// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ApiKeyItem } from '@/types/panel-keys'
import type { Vm } from '@/types/panel-vm'
import { afterEach, expect, it, vi } from 'vitest'
import { KeyLimitsDialog } from './key-limits-dialog'
import { keyLimitsPayload, type KeyLimitsDraft } from './key-payload'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
afterEach(async () => cleanup())
const initial: ApiKeyItem = {
  id: 'key_unified',
  name: 'Combined',
  category: 'hybrid',
  group_type: 'anthropic',
  allowed_vms: ['line01'],
  openai_endpoint_id: 'ep_0123456789ab',
  max_concurrency: 1,
}

async function mount(
  item = initial,
  admin = true,
  endpointPresent = true,
  createService?: 'claude' | 'gpt'
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const submitted = vi.fn<(draft: KeyLimitsDraft) => void>()
  cleanup = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  await act(async () =>
    root.render(
      <KeyLimitsDialog
        mode={createService ? 'create' : 'edit'}
        createService={createService}
        open
        initial={item}
        pending={false}
        onOpenChange={() => {}}
        onSubmit={submitted}
        pools={admin ? [] : undefined}
        vms={[{ id: 'line01', name: 'Claude line 1' } as Vm]}
        endpoints={
          endpointPresent
            ? [
                {
                  id: 'ep_0123456789ab',
                  name: 'GPT loopback',
                  kind: 'local_gateway',
                  models: [{ name: 'gpt-5.4', alias: 'gpt-5.4' }],
                },
              ]
            : []
        }
      />
    )
  )
  const save = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === (createService ? '生成' : '保存')
  )!
  return { save, submitted }
}

it('editing limits retains both routes and explains which GPT models the key can call', async () => {
  const ui = await mount()
  expect(document.body.textContent).toContain('Claude 使用所选原生槽位')
  expect(document.body.textContent).toContain('GPT 模型：gpt-5.4')
  expect(ui.save.disabled).toBe(false)
  await act(async () => ui.save.click())
  expect(keyLimitsPayload(ui.submitted.mock.calls[0][0], 'edit')).toMatchObject(
    {
      category: 'hybrid',
      allowed_vms: ['line01'],
      group_type: 'anthropic',
      openai_endpoint_id: 'ep_0123456789ab',
      max_concurrency: 1,
    }
  )
})

it('a missing endpoint option never silently converts an existing unified key to OAuth', async () => {
  const ui = await mount(initial, true, false)
  expect(document.body.textContent).toContain('当前绑定不可用')
  await act(async () => ui.save.click())
  expect(ui.submitted.mock.calls[0][0]).toMatchObject({
    category: 'hybrid',
    openai_endpoint_id: initial.openai_endpoint_id,
  })
})

it('tenant limit edits leave a pooled unified route under administrator control', async () => {
  const ui = await mount(
    { ...initial, allowed_vms: [], vm_pool_id: 'pool_12345678' },
    false
  )
  expect(document.body.textContent).toContain(
    'Claude 范围和 GPT 网关由管理员维护'
  )
  expect(ui.save.disabled).toBe(false)
  await act(async () => ui.save.click())
  const payload = keyLimitsPayload(ui.submitted.mock.calls[0][0], 'edit', {
    isAdmin: false,
  })
  for (const field of [
    'category',
    'group_type',
    'allowed_vms',
    'vm_pool_id',
    'openai_endpoint_id',
  ])
    expect(payload).not.toHaveProperty(field)
})

it('GPT-only key editing has no native VM picker and preserves its independent gateway contract', async () => {
  const ui = await mount({
    ...initial,
    name: 'GPT pool',
    group_type: 'openai',
    allowed_vms: [],
    vm_pool_id: null,
  })
  expect(document.body.textContent).toContain('GPT 托管池')
  expect(document.body.textContent).toContain(
    '与 Claude 托管池分别限额和计并发'
  )
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect(ui.save.disabled).toBe(false)
  await act(async () => ui.save.click())
  expect(keyLimitsPayload(ui.submitted.mock.calls[0][0], 'edit')).toMatchObject(
    {
      category: 'hybrid',
      group_type: 'openai',
      allowed_vms: [],
      vm_pool_id: null,
      openai_endpoint_id: initial.openai_endpoint_id,
      max_concurrency: 1,
    }
  )
})

it('Claude-only key editing does not offer a GPT gateway binding', async () => {
  const ui = await mount({
    ...initial,
    category: 'oauth',
    openai_endpoint_id: null,
  })
  expect(document.body.textContent).toContain('Claude 托管池')
  expect(document.body.textContent).toContain('与 GPT 托管池分别限额和计并发')
  expect(document.querySelector('[aria-label="GPT 本机网关"]')).toBeNull()
  expect(ui.save.disabled).toBe(false)
  await act(async () => ui.save.click())
  expect(keyLimitsPayload(ui.submitted.mock.calls[0][0], 'edit')).toMatchObject(
    {
      category: 'oauth',
      group_type: 'anthropic',
      allowed_vms: ['line01'],
      openai_endpoint_id: null,
    }
  )
})

it('the GPT create entry starts with a gateway-only form and waits for an explicit binding', async () => {
  const ui = await mount(initial, true, true, 'gpt')
  expect(document.body.textContent).toContain('GPT 托管池')
  expect(document.querySelector('[aria-label="GPT 本机网关"]')).not.toBeNull()
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect(ui.save.disabled).toBe(true)
  expect(ui.submitted).not.toHaveBeenCalled()
})
