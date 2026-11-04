import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginRequest, panelFetch, logoutRequest } from './api'
import {
  joinApiPath,
  panelWebSocketUrl,
  publicApiBase,
  publicPath,
} from './base-path'
import { getCookie, setCookie, removeCookie } from './cookies'
import { modelIconUrl } from './model-vendor/vendor-icon-files'
import {
  apiBase,
  clearSession,
  hasSession,
  LS_BASE,
  LS_TOKEN,
  sessionToken,
  setApiBase,
  setSession,
} from './session'

function browser(prefix = '/claude') {
  const storage = new Map<string, string>()
  const doc = {
    cookie: '',
    querySelector: () => ({ getAttribute: () => prefix }),
  }
  vi.stubGlobal('location', {
    origin: 'https://example.test',
    hostname: 'example.test',
  })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  return {
    storage,
    doc,
    mount: (next: string) => {
      prefix = next
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('mounted panel transport', () => {
  it('keeps login, JSON, streamed responses and logout under the mount despite a root API override', async () => {
    const { storage } = browser()
    storage.set(LS_BASE, 'https://another-service.test')
    setApiBase('https://another-service.test')
    const fetchMock = vi.fn(async () =>
      Response.json({ token: 'kin-panel-fixture', user: 'admin' })
    )
    vi.stubGlobal('fetch', fetchMock)
    const login = await loginRequest({
      username: 'admin',
      password: 'fixture',
      base: '',
    })
    setSession(login.token, login.user)
    await panelFetch('/api/panel/me')
    await panelFetch('/api/panel/pool/stream', {
      headers: { Accept: 'text/event-stream' },
    })
    logoutRequest()
    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      '/claude/api/panel/login',
      '/claude/api/panel/me',
      '/claude/api/panel/pool/stream',
      '/claude/api/panel/logout',
    ])
    expect(apiBase()).toBe('/claude')
  })

  it('does not read or clear root-session storage and clears only its own mount cookie', () => {
    const { storage, doc, mount } = browser()
    storage.set(LS_TOKEN, 'root-session')
    expect(hasSession()).toBe(false)
    setSession('claude-session', 'admin')
    expect(sessionToken()).toBe('claude-session')
    mount('')
    expect(sessionToken()).toBe('root-session')
    mount('/claude')
    clearSession()
    expect(sessionToken()).toBe('')
    expect(storage.get(LS_TOKEN)).toBe('root-session')
    expect(doc.cookie).toContain('Path=/claude;')
  })

  it('keeps ticket-authenticated WebSockets on the mounted path and supports old remote bases', () => {
    browser()
    const ws = panelWebSocketUrl(
      '/api/panel/vms/vm-1/shell',
      apiBase(),
      location.origin
    )
    ws.search = new URLSearchParams({ ticket: 'fixture' }).toString()
    expect(ws.href).toBe(
      'wss://example.test/claude/api/panel/vms/vm-1/shell?ticket=fixture'
    )
    expect(
      panelWebSocketUrl(
        '/api/panel/shell',
        'http://localhost:8787',
        location.origin
      ).href
    ).toBe('ws://localhost:8787/api/panel/shell')
  })

  it('uses mounted public assets, API examples and preferences while leaving root compatibility intact', () => {
    const { doc, mount } = browser()
    expect(publicPath('/favicon.svg')).toBe('/claude/favicon.svg')
    expect(modelIconUrl('anthropic.svg')).toBe(
      '/claude/model-icons/anthropic.svg'
    )
    expect(publicApiBase('http://127.0.0.1:18888')).toBe(
      'https://example.test/claude'
    )
    setCookie('theme', 'light')
    expect(doc.cookie).toContain('path=/claude;')
    removeCookie('theme')
    expect(doc.cookie).toContain('path=/claude; max-age=0')
    doc.cookie = 'theme=light; theme=dark'
    expect(getCookie('theme')).toBe('light')
    mount('')
    expect(publicPath('/favicon.svg')).toBe('/favicon.svg')
    expect(apiBase()).toBe('')
    expect(publicApiBase('https://legacy.test/')).toBe('https://legacy.test')
  })

  it('rejects malformed mount metadata and paths escaping to another origin or root service', () => {
    browser('//evil.test')
    expect(() => apiBase()).toThrow('Invalid public base path')
    for (const path of [
      'https://evil.test/',
      '//evil.test/',
      '/a/../api',
      '/%2e%2e/api',
      '/a\\b',
    ]) {
      expect(() => joinApiPath('/claude', path)).toThrow()
    }
  })
})
