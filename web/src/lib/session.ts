import { publicBasePath } from './base-path'

const LS_TOKEN = 'kin_console_token'
const LS_USER = 'kin_console_user'
const LS_BASE = 'kin_api_base'
const COOKIE = import.meta.env.VITE_PANEL_COOKIE_NAME || 'kin_panel_token'

export { LS_TOKEN, LS_USER, LS_BASE, COOKIE }

export function sameOriginPanel(host = location.hostname): boolean {
  return Boolean(publicBasePath()) || /^kin\.fkcodex\.com$/i.test(host || '')
}

export function apiBase(): string {
  const mount = publicBasePath()
  if (mount) return mount
  const host = location.hostname || ''
  if (sameOriginPanel(host)) return ''
  const saved = (localStorage.getItem(LS_BASE) || '').replace(/\/$/, '')
  if (saved) return saved
  // No saved base: talk to the backend that served this page.
  return ''
}

function storageKey(key: string): string {
  const mount = publicBasePath()
  return mount ? `${key}:${COOKIE}:${mount}` : key
}

export function setApiBase(base: string) {
  const trimmed = base.trim().replace(/\/$/, '')
  if (sameOriginPanel() || !trimmed) {
    localStorage.removeItem(storageKey(LS_BASE))
    return
  }
  localStorage.setItem(storageKey(LS_BASE), trimmed)
}

function clearClientCookie(name: string) {
  document.cookie = `${name}=; Path=${publicBasePath() || '/'}; Max-Age=0; SameSite=Lax`
}

export function sessionToken(): string {
  return (localStorage.getItem(storageKey(LS_TOKEN)) || '').trim()
}

export function hasSession(): boolean {
  return Boolean(sessionToken())
}

type PanelSessionExpiredListener = () => void
const panelSessionExpiredListeners = new Set<PanelSessionExpiredListener>()
let panelSessionExpiredHandled = false

/** Register UI handler: toast + redirect after panel 401 (see panelFetch). */
export function onPanelSessionExpired(listener: PanelSessionExpiredListener) {
  panelSessionExpiredListeners.add(listener)
  return () => panelSessionExpiredListeners.delete(listener)
}

export function expirePanelSession() {
  if (panelSessionExpiredHandled) return
  panelSessionExpiredHandled = true
  clearSession()
  for (const listener of panelSessionExpiredListeners) listener()
}

export function setSession(token: string, user?: string) {
  clearClientCookie(COOKIE)
  if (COOKIE === 'kin_panel_token') clearClientCookie('kin_console_token')
  if (token) {
    panelSessionExpiredHandled = false
    localStorage.setItem(storageKey(LS_TOKEN), token)
  } else localStorage.removeItem(storageKey(LS_TOKEN))
  if (user) localStorage.setItem(storageKey(LS_USER), user)
}

export function clearSession() {
  localStorage.removeItem(storageKey(LS_TOKEN))
  localStorage.removeItem(storageKey(LS_USER))
  clearClientCookie(COOKIE)
  if (COOKIE === 'kin_panel_token') clearClientCookie('kin_console_token')
}

export function storedUser(): string {
  return localStorage.getItem(storageKey(LS_USER)) || ''
}
