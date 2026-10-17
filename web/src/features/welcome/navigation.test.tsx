// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { Route as EntryRoute } from '@/routes/_authenticated/index'
import { Route as AuthenticatedRoute } from '@/routes/_authenticated/route'
import { Route as LoginRoute } from '@/routes/login'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { LS_TOKEN, LS_USER } from '@/lib/session'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { LoginPage } from '@/features/auth/login-page'
import { WelcomePage } from './index'
import { ONBOARDING_KEY } from './queries'

const onboarding = {
  user: 'synthetic-admin',
  role: 'admin',
  status: 'pending',
  updated_at: null,
  needs_welcome: true,
  base_url: null,
  profile: null,
  guide_used: false,
  steps: [{ id: 'slot_account', done: false }],
  done_count: 0,
  total: 1,
}

let dispose: (() => Promise<void>) | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  localStorage.setItem(LS_TOKEN, 'synthetic-panel-token')
  localStorage.setItem(LS_USER, 'synthetic-admin')
  useAuthStore.setState({
    token: 'synthetic-panel-token',
    user: 'synthetic-admin',
    me: null,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network request')
    })
  )
})

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
})

async function mount(
  path: string,
  { signedIn = true, guideUsed = false, onboardingAvailable = true } = {}
) {
  if (!signedIn) {
    localStorage.removeItem(LS_TOKEN)
    useAuthStore.setState({ token: '', user: '', me: null })
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (onboardingAvailable)
    queryClient.setQueryData(ONBOARDING_KEY, {
      ...onboarding,
      guide_used: guideUsed,
      needs_welcome: !guideUsed,
    })
  queryClient.setQueryData(['panel', 'me'], {
    user: 'synthetic-admin',
    role: 'admin',
    views: null,
  })
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Outlet,
  })
  const welcome = createRoute({
    getParentRoute: () => rootRoute,
    path: '/welcome',
    validateSearch: () => ({}),
    component: WelcomePage,
  })
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: LoginRoute.options.validateSearch,
    beforeLoad: LoginRoute.options.beforeLoad,
    component: LoginPage,
  })
  const authenticated = createRoute({
    getParentRoute: () => rootRoute,
    id: '_authenticated',
    beforeLoad: AuthenticatedRoute.options.beforeLoad,
    component: AuthenticatedLayout,
  })
  const entry = createRoute({
    getParentRoute: () => authenticated,
    path: '/',
    // The real hook reads the same context; only the generated parent-route type differs.
    beforeLoad: (context) =>
      EntryRoute.options.beforeLoad?.(
        context as unknown as Parameters<
          NonNullable<typeof EntryRoute.options.beforeLoad>
        >[0]
      ),
  })
  const config = createRoute({
    getParentRoute: () => authenticated,
    path: '/import',
    component: () => <div data-testid='import-page'>Import configuration</div>,
  })
  const overview = createRoute({
    getParentRoute: () => authenticated,
    path: '/overview',
    component: () => <div data-testid='overview-page'>Overview</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      welcome,
      login,
      authenticated.addChildren([entry, config, overview]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  dispose = async () => {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  }
  await act(async () => {
    await router.load()
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider defaultTheme='dark'>
          <FontProvider>
            <DirectionProvider>
              <RouterProvider router={router} />
            </DirectionProvider>
          </FontProvider>
        </ThemeProvider>
      </QueryClientProvider>
    )
  })
  return { router, container, queryClient }
}

it('an unfinished welcome checklist can open its configuration page without completing the guide', async () => {
  const { router, container, queryClient } = await mount('/')
  expect(router.state.location.pathname).toBe('/welcome')
  const link = container.querySelector<HTMLAnchorElement>('a[href="/import"]')
  expect(link).not.toBeNull()
  await act(async () => {
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await router.load()
  })
  expect(router.state.location.pathname).toBe('/import')
  expect(container.querySelector('[data-testid="import-page"]')).not.toBeNull()
  expect(queryClient.getQueryData(ONBOARDING_KEY)).toEqual(onboarding)
  expect(fetch).not.toHaveBeenCalled()
})

it('sign-in restores the requested configuration page before optional welcome navigation', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token: 'synthetic-panel-token',
          user: 'synthetic-admin',
        }),
        { status: 200 }
      )
  )
  vi.stubGlobal('fetch', fetch)
  const { router, container, queryClient } = await mount('/import?fixture=1', {
    signedIn: false,
  })
  expect(router.state.location.pathname).toBe('/login')
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(router.state.location.pathname).toBe('/import')
  expect(router.state.location.search).toEqual({ fixture: 1 })
  expect(container.querySelector('[data-testid="import-page"]')).not.toBeNull()
  expect(queryClient.getQueryData(ONBOARDING_KEY)).toEqual(onboarding)
  expect(fetch.mock.calls).toHaveLength(1)
})

it('an existing session restores a login redirect without losing the requested page', async () => {
  const { router, container } = await mount(
    '/login?redirect=%2Fimport%3Ffixture%3D1'
  )
  expect(router.state.location.pathname).toBe('/import')
  expect(container.querySelector('[data-testid="import-page"]')).not.toBeNull()
})

it.each([
  ['/', false, '/welcome'],
  ['/login', false, '/welcome'],
  ['/', true, '/overview'],
  ['/login', true, '/overview'],
  ['/overview', false, '/overview'],
  ['/import', false, '/import'],
])(
  'entry %s with guide used=%s lands at %s',
  async (path, guideUsed, expected) => {
    const { router } = await mount(path, { guideUsed })
    expect(router.state.location.pathname).toBe(expected)
    expect(fetch).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'ordinary sign-in follows onboarding state (guide used=%s)',
  async (guideUsed) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token: 'synthetic-panel-token',
              user: 'synthetic-admin',
            }),
            { status: 200 }
          )
      )
    )
    const { router, container } = await mount('/login', {
      signedIn: false,
      guideUsed,
    })
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(router.state.location.pathname).toBe(
      guideUsed ? '/overview' : '/welcome'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  }
)

it('the anonymous root opens the public welcome without making an authenticated query', async () => {
  const { router } = await mount('/', {
    signedIn: false,
    onboardingAvailable: false,
  })
  expect(router.state.location.pathname).toBe('/welcome')
  expect(fetch).not.toHaveBeenCalled()
})

it('normalizes public redirect paths consistently with case-insensitive route matching', async () => {
  const { router } = await mount('/login?redirect=%2FWELCOME', {
    guideUsed: true,
  })
  expect(router.state.location.pathname).toBe('/overview')
  expect(fetch).not.toHaveBeenCalled()
})

it('an unavailable onboarding service does not block the authenticated default entry', async () => {
  const { router } = await mount('/', { onboardingAvailable: false })
  expect(router.state.location.pathname).toBe('/overview')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([
  'https://elsewhere.invalid/',
  '//elsewhere.invalid/',
  '/\\elsewhere.invalid/',
  '/x/../login',
  '/%6cogin',
  '/welcome?setup=true',
])('rejects a looping or external login redirect: %s', async (redirect) => {
  const { router } = await mount(
    `/login?redirect=${encodeURIComponent(redirect)}`
  )
  expect(router.state.location.pathname).toBe('/welcome')
  expect(fetch).not.toHaveBeenCalled()
})
