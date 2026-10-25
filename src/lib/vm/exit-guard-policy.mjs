/** The global default stays strict unless an operator opts this proxy out. */
export function proxyRequiresExitIp(config, proxyId) {
  const row = config.proxies?.[proxyId]
  if (
    row != null &&
    (typeof row !== 'object' ||
      Array.isArray(row) ||
      (Object.hasOwn(row, 'required') && typeof row.required !== 'boolean'))
  ) {
    throw Object.assign(new Error('exit_guard_config_invalid'), { code: 'exit_guard_config_invalid', status: 503 })
  }
  return config.required === true && row?.required !== false
}
