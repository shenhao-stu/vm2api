// https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers
export const FABLE_PRO_START = Date.parse('2026-11-09T18:00:00Z')
export const FABLE_PRO_END = Date.parse('2026-11-17T07:59:00Z')

export function proFablePromotionAllows(model, now = Date.now()) {
  return (
    /^claude-fable-5(?:-2|\.2)(?:-\d{8})?$/.test(String(model || '').toLowerCase()) &&
    Number.isFinite(now) &&
    now >= FABLE_PRO_START &&
    now < FABLE_PRO_END
  )
}
