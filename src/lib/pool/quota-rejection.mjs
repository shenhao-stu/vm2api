import { parseResetMs } from './quota-window.mjs'

const WINDOWS = Object.freeze({
  quota_5h_header: '5h',
  quota_5h_cli: '5h',
  quota_5h_safety: '5h',
  quota_7d_header: '7d',
  quota_7d_cli: '7d',
  quota_7d_safety: '7d',
})

/** Describe a known admission rejection without changing the admission decision. */
export function quotaRejection(reason, reset = null, now = Date.now()) {
  if (!Object.hasOwn(WINDOWS, reason)) return null
  const until = new Date(parseResetMs(reset)).getTime()
  return { reason, window: WINDOWS[reason], until: Number.isFinite(until) && until > now ? until : null }
}
