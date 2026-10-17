/** Resume an explicit local panel URL without leaving the site or looping through public pages. */
export function panelRedirectHref(
  value: string | undefined
): string | undefined {
  if (
    !value?.startsWith('/') ||
    value.startsWith('//') ||
    hasUnsafeCharacter(value)
  )
    return
  try {
    const base = 'https://panel.invalid'
    const target = new URL(value, base)
    const pathname = decodeURIComponent(target.pathname)
    if (
      target.origin !== base ||
      pathname.startsWith('//') ||
      hasUnsafeCharacter(pathname) ||
      /^\/(welcome|login)\b/i.test(pathname)
    )
      return
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return
  }
}

function hasUnsafeCharacter(value: string): boolean {
  return Array.from(value).some(
    (character) => character === '\\' || character.charCodeAt(0) <= 32
  )
}
