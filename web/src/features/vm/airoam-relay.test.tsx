import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AiroamRelayCard } from './airoam-relay'

it('shows live model and execution capacity separately from resident sessions', () => {
  const html = renderToStaticMarkup(
    <AiroamRelayCard
      status={{
        state: 'ready',
        models: ['claude-opus-5-5'],
        active_requests: 2,
        execution_slots: 4,
        resident_sessions: 7,
        resident_capacity: 8,
      }}
    />
  )
  expect(html).toContain('claude-opus-5-5')
  expect(html).toContain('运行中')
  expect(html).toContain('2/4')
  expect(html).toContain('7/8')
  expect(html).not.toContain('<button')
})

it('renders unavailable telemetry without implying zero capacity', () => {
  expect(renderToStaticMarkup(<AiroamRelayCard />)).toContain('状态未知')
})
