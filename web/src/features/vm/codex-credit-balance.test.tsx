// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { codexCreditReadout, CodexCreditBalance } from './codex-credit-balance'
import { VmUsageWindows } from './usage-windows'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const now = Date.parse('2026-11-09T00:00:00Z')
const credits = (balance: string | number | null = '3331.5130650000') => ({
  balance,
  has_credits: true,
  fetched_at: '2026-11-08T23:58:00Z',
})
const vm = {
  id: 'test',
  platform: 'openai',
  has_token: true,
  codex_credits: credits(),
  utilization_5h: 0.25,
  utilization_7d: 1,
} as Vm

it('shows official balance separately from money and vouchers with precise details', () => {
  const view = codexCreditReadout(credits(), now)
  expect(view.value).toBe('3,331.51')
  expect(view.status).toBe('2 分钟前更新')
  expect(view.detail).toContain('3331.5130650000')
  expect(view.value).not.toContain('$')
})
it('does not interpret missing data as zero', () => {
  expect(codexCreditReadout(null, now)).toMatchObject({
    value: '—',
    status: '未查询',
  })
  expect(codexCreditReadout(credits(null), now)).toMatchObject({
    value: '—',
    status: '未提供余额',
  })
  expect(codexCreditReadout(credits('0'), now)).toMatchObject({
    value: '0',
    fresh: true,
  })
})
it.each(['', 'NaN', '-1', 'Infinity', '12x'])(
  'rejects malformed balances: %s',
  (balance) => {
    expect(codexCreditReadout(credits(balance), now).value).toBe('—')
  }
)
it('keeps small positive credits distinct from zero and supports unlimited', () => {
  expect(codexCreditReadout(credits('0.00001'), now).value).toBe('<0.01')
  expect(
    codexCreditReadout({ ...credits(null), unlimited: true }, now).value
  ).toBe('不限量')
})
it('marks expired or invalid timestamps as old without erasing the balance', () => {
  for (const fetched_at of [
    '2026-11-08T23:49:59Z',
    'bad',
    '2026-11-09T00:01:00Z',
  ]) {
    expect(codexCreditReadout({ ...credits(), fetched_at }, now)).toMatchObject(
      { value: '3,331.51', status: '待更新', fresh: false }
    )
  }
})
it('renders balance under native windows while leaving Claude untouched', () => {
  const html = renderToStaticMarkup(<VmUsageWindows vm={vm} now={now} />)
  expect(html).toContain('5H')
  expect(html).toContain('7D')
  expect(html).toContain('剩余积分')
  expect(html).toContain('3,331.51')
  expect(
    renderToStaticMarkup(
      <CodexCreditBalance vm={{ ...vm, platform: 'anthropic' }} now={now} />
    )
  ).toBe('')
})
it('updates on new API snapshots without mutating slot policy', async () => {
  const original = structuredClone(vm)
  const node = document.createElement('div')
  const root = createRoot(node)
  try {
    await act(async () => root.render(<CodexCreditBalance vm={vm} now={now} />))
    expect(node.textContent).toContain('3,331.51')
    await act(async () =>
      root.render(
        <CodexCreditBalance
          vm={{ ...vm, codex_credits: credits('2984.25') }}
          now={now}
        />
      )
    )
    expect(node.textContent).toContain('2,984.25')
    expect(node.textContent).not.toContain('3,331.51')
    expect(vm).toEqual(original)
  } finally {
    await act(async () => root.unmount())
  }
})
