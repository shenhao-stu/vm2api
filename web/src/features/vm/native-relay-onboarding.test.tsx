import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OnboardingCard } from './native-relay-onboarding'
import {
  authorizationRemaining,
  draftProblems,
  errorText,
  isOpen,
  phaseStates,
  sessionHeadline,
  sessionTone,
  type OnboardingSession,
  type OnboardingView,
} from './native-relay-onboarding-state'
import { NativeRelays } from './native-relays'
import {
  onboardingKey,
  relayKey,
  type RelayOnboarding,
} from './use-relay-onboarding'

const STEPS = [
  'preflight',
  'prepare',
  'exit_check',
  'login',
  'native',
  'worker',
  'native_canary',
  'gateway',
  'route',
  'sub',
  'sub_canary',
  'manager',
  'promote',
  'live',
]

function session(
  done: number,
  change: Partial<OnboardingSession> = {},
  current: 'running' | 'failed' | 'pending' = 'running'
): OnboardingSession {
  return {
    seat: '0a1b2c3d',
    name: 'Fixture',
    egress: 'direct',
    expected_ip: '203.0.113.7',
    org: 4242,
    created_at: 1,
    updated_at: 2,
    status: 'running',
    authorization: null,
    error: null,
    result: {},
    steps: STEPS.map((key, index) => ({
      key,
      status: index < done ? 'done' : index === done ? current : 'pending',
    })),
    ...change,
  }
}

const options = [{ id: 'direct', label: '直连', expected_ip: '203.0.113.7' }]

function page(view: OnboardingView | null, items: unknown[] = []) {
  const client = new QueryClient()
  client.setQueryData(relayKey, { items })
  client.setQueryData(onboardingKey, view)
  const doc = new Window().document
  doc.body.innerHTML = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NativeRelays enabled />
    </QueryClientProvider>
  )
  return doc
}

describe('native Relay onboarding', () => {
  it('folds the internal steps into five phases and names the one in progress', () => {
    const phases = phaseStates(session(5))
    expect(phases.map((phase) => phase.state)).toEqual([
      'done',
      'done',
      'running',
      'pending',
      'pending',
    ])
    expect(phases[2].current).toBe('worker')
    const failed = phaseStates(session(8, { status: 'failed' }, 'failed'))
    expect(failed[3].state).toBe('failed')
    expect(failed[3].current).toBe('route')
    expect(phaseStates(session(14)).every((p) => p.state === 'done')).toBe(true)
  })

  it('describes each state in words an administrator can act on', () => {
    const waiting = session(3, {
      status: 'awaiting_authorization',
      authorization: { url: 'https://example.test/device', expires_at: 1000 },
    })
    expect(sessionTone(waiting).text).toBe('等待授权')
    expect(sessionHeadline(waiting)).toContain('授权')
    expect(authorizationRemaining(waiting, 875_000)).toBe('02:05')
    expect(authorizationRemaining(waiting, 1_000_000)).toBeNull()
    const stopped = session(
      10,
      {
        status: 'failed',
        error: {
          step: 'sub_canary',
          code: 'sub_canary_failed',
          retriable: true,
        },
      },
      'failed'
    )
    expect(sessionTone(stopped).cls).toBe('bad')
    expect(sessionHeadline(stopped)).toContain('端到端计费验收')
    expect(sessionTone(session(14, { status: 'live' })).cls).toBe('ok')
    expect(isOpen(session(14, { status: 'live' }))).toBe(false)
    expect(isOpen(session(2, { status: 'abandoned' }))).toBe(false)
    expect(isOpen(stopped)).toBe(true)
  })

  it('explains known failures and groups the rest by where they happened', () => {
    expect(errorText({ code: 'authorization_timeout' })).toContain('有效期')
    expect(errorText({ code: 'template_firewall_differs' })).toContain('模板')
    expect(errorText({ code: 'nginx_rejected_route' })).toContain('已回滚')
    expect(errorText({ code: 'account_differs_from_reference' })).toContain(
      'Sub2API'
    )
    expect(errorText({ code: 'something_new' })).toBe('这一步没有完成。')
  })

  it('applies the server rules to the form before anything is sent', () => {
    const good = { name: 'Ciry 二号', egress: 'direct', org: '4242' }
    expect(draftProblems(good, options)).toEqual({})
    expect(draftProblems({ ...good, name: ' x' }, options).name).toBeTruthy()
    expect(draftProblems({ ...good, name: 'a/b' }, options).name).toBeTruthy()
    expect(
      draftProblems({ ...good, name: 'x'.repeat(25) }, options).name
    ).toBeTruthy()
    expect(draftProblems({ ...good, org: '0' }, options).org).toBeTruthy()
    expect(draftProblems({ ...good, org: '1e3' }, options).org).toBeTruthy()
    expect(
      draftProblems({ ...good, egress: 'elsewhere' }, options).egress
    ).toBeTruthy()
  })

  it('stays hidden where the server does not offer onboarding', () => {
    expect(page(null).body.innerHTML).toBe('')
  })

  it('offers the entry even before the first Relay exists', () => {
    const doc = page({ options, sessions: [], busy: false })
    expect(doc.body.textContent).toContain('还没有原生 Relay')
    expect(doc.body.textContent).toContain('添加原生 Relay')
  })

  it('shows a seat in progress beside live Relays, with the link while it waits', () => {
    const waiting = session(3, {
      status: 'awaiting_authorization',
      authorization: {
        url: 'https://example.test/device?code=fixture',
        expires_at: Date.now() / 1000 + 600,
      },
    })
    const doc = page({ options, sessions: [waiting], busy: true })
    const card = doc.querySelector('article[aria-label="Fixture · 接入中"]')
    expect(card?.textContent).toContain('等待授权')
    expect(card?.textContent).toContain('203.0.113.7')
    expect(
      card?.querySelector('a[target="_blank"]')?.getAttribute('href')
    ).toBe('https://example.test/device?code=fixture')
    expect(card?.querySelector('a')?.getAttribute('rel')).toBe('noreferrer')
    expect(
      card?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')
    ).toBe('1')
    // 进行中时入口换成“查看进度”，不能再开第二个流程。
    expect(doc.body.textContent).toContain('查看接入进度')
    expect(doc.body.textContent).not.toContain('添加原生 Relay')
  })

  it('keeps finished sessions out of the grid', () => {
    const doc = page({
      options,
      busy: false,
      sessions: [
        session(14, { status: 'live' }),
        session(2, { status: 'abandoned', seat: '11112222' }),
      ],
    })
    expect(doc.querySelectorAll('article')).toHaveLength(0)
    expect(doc.body.textContent).toContain('添加原生 Relay')
  })

  it('states a failure on the card and leaves the decision to the dialog', () => {
    const flow = { setDialog: () => {} } as unknown as RelayOnboarding
    const html = renderToStaticMarkup(
      <OnboardingCard
        flow={flow}
        session={session(
          4,
          {
            status: 'failed',
            error: {
              step: 'native',
              code: 'native_not_ready',
              retriable: true,
            },
          },
          'failed'
        )}
      />
    )
    expect(html).toContain('已停止')
    expect(html).toContain('启动原生守护进程')
    expect(html).toContain('查看并处理')
    expect(html).not.toContain('放弃')
  })
})
