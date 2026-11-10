// https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers
export const FABLE_52_ID = 'claude-fable-5-2'
export const FABLE_PROMOTION_START = Date.parse('2026-11-09T18:00:00Z')
export const FABLE_PROMOTION_END = Date.parse('2026-11-17T08:00:00Z')

export function isFable52(model) {
  const bare = String(model || '')
    .trim()
    .split('/')
    .pop()
    .replace(/\[1m\]$/i, '')
    .toLowerCase()
  return bare === FABLE_52_ID || bare === 'claude-fable-5.2'
}

export function fablePromotionActive(now = Date.now()) {
  return Number.isFinite(now) && now >= FABLE_PROMOTION_START && now < FABLE_PROMOTION_END
}
