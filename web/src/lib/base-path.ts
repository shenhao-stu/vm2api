/** Runtime mount supplied by the backend, not a user-controlled API override. */
export function publicBasePath(): string {
  const base =
    typeof document === 'undefined'
      ? ''
      : document
          .querySelector?.('meta[name="vm2api-base-path"]')
          ?.getAttribute('content') || ''
  if (base && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(base)) {
    throw new Error('Invalid public base path')
  }
  return base
}

export function joinApiPath(base: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Expected a local API path')
  }
  // URL normalization must never allow a caller to escape a mounted service.
  const pathname = path.split(/[?#]/, 1)[0]
  if (
    pathname
      .split('/')
      .some((part) => /^\.{1,2}$/.test(decodeURIComponent(part)))
  ) {
    throw new Error('Invalid API path traversal')
  }
  return `${base.replace(/\/+$/, '')}${path}`
}

export function publicPath(path: string): string {
  return joinApiPath(publicBasePath(), path)
}

export function publicApiBase(configured?: string | null): string {
  const mount = publicBasePath()
  return mount
    ? `${location.origin}${mount}`
    : (configured || location.origin).replace(/\/+$/, '')
}

export function panelWebSocketUrl(
  path: string,
  base: string,
  origin: string
): URL {
  const url = new URL(joinApiPath(base, path), origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}
