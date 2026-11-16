/** Validate caller intent before normalization, slot selection or model I/O. */
export function thinkingRequestError(body = {}) {
  const model = String(body.model || '')
    .split('/')
    .pop()
    .split('[')[0]
    .toLowerCase()
  if (!model.startsWith('claude-') || body.thinking === undefined) return null
  const fail = (param, message) => ({ param, message })
  const thinking = body.thinking
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
    return fail('thinking', 'thinking must be an object')
  }
  const type = thinking.type
  if (!['enabled', 'disabled', 'adaptive', 'between_tools'].includes(type)) {
    return fail('thinking.type', 'Unsupported thinking.type')
  }
  const sonnet55 = /^claude-sonnet-5[-.]5(?:-\d{8})?$/.test(model)
  const haiku55 = /^claude-haiku-5[-.]5(?:-\d{8})?$/.test(model)
  const adaptiveOnly = sonnet55 || /^claude-(?:opus-5[-.]5|fable-5[-.]2)(?:-\d{8})?$/.test(model)
  const effort = body.output_config?.effort
  if ((adaptiveOnly && ['enabled', 'disabled'].includes(type)) || (haiku55 && type === 'enabled')) {
    return fail(
      'thinking.type',
      `${model} requires adaptive thinking${sonnet55 ? ' or between_tools' : ''}; omit thinking or use a supported mode`,
    )
  }
  if (haiku55 && type === 'disabled' && ['xhigh', 'max'].includes(effort)) {
    return fail('output_config.effort', 'Haiku 5.5 disabled thinking supports only low, medium or high effort')
  }
  if (type === 'between_tools') {
    if (!sonnet55) return fail('thinking.type', 'thinking.type=between_tools is supported only by Sonnet 5.5')
    if (effort !== undefined && !['low', 'medium', 'high'].includes(effort)) {
      return fail('output_config.effort', 'between_tools supports only low, medium or high effort')
    }
    for (const field of ['display', 'budget_tokens', 'block_binding']) {
      if (Object.hasOwn(thinking, field))
        return fail(`thinking.${field}`, `between_tools does not support thinking.${field}`)
    }
  }
  if (type === 'enabled') {
    const budget = thinking.budget_tokens
    if (!Number.isInteger(budget) || budget < 1024) {
      return fail('thinking.budget_tokens', 'enabled thinking requires an integer budget_tokens of at least 1024')
    }
    // Interleaved manual thinking can exceed max_tokens; headers decide that at the hop.
  }
  return null
}
