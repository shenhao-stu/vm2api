/** A reverse proxy must overwrite this header, never forward a client's value. */
export function publicBasePath(req, env = process.env) {
  const configured = String(env.VM2API_PUBLIC_BASE_PATH || '')
  if (!configured) return ''
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(configured) || configured.length > 128) {
    throw new Error('Invalid VM2API_PUBLIC_BASE_PATH')
  }
  return req?.headers?.['x-forwarded-prefix'] === configured ? configured : ''
}

/** Only local HTML resource URLs change; hash navigation keeps its current document. */
export function mountWebIndex(html, basePath = '') {
  if (basePath && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) {
    throw new Error('Invalid public base path')
  }
  const mounted = String(html).replace(/<(?:script|link)\b[^>]*>/gi, (tag) =>
    tag.replace(
      /\b(src|href)=(['"])(?:\.\/|\/(?!\/))([^'"]*)\2/gi,
      (_, attr, quote, rel) => `${attr}=${quote}${basePath}/${rel}${quote}`,
    ),
  )
  return mounted.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<meta name="vm2api-base-path" content="${basePath}">`)
}
