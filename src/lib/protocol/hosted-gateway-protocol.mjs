import { claudeToOpenAIChatRequest } from '../pool/api-openai.mjs'
import { randomUUID } from 'node:crypto'
import { gatewayError } from '../pool/local-gateway-policy.mjs'
import {
  chatToCodexResponses,
  completionsToCodexResponses,
  codexBodyToAnthropicMessage,
  createChatSseState,
  createAnthropicSseState,
  responsesSseToChatChunk,
  responsesSseToAnthropicEvents,
} from './codex-convert.mjs'
import { fromClaudeToOpenAIChat, fromClaudeToOpenAICompletions } from './convert.mjs'
import { extractOpenaiUsage } from './openai-usage.mjs'

/** This is an API protocol adapter, not the native Codex CLI policy/identity filter. */
export function hostedResponsesRequest(protocol, body, model) {
  if (protocol === 'openai.responses') return { ...body, model }
  let source = body
  if (protocol === 'anthropic.messages') {
    // The shared converter handles text and standard tool history. Refuse content it
    // cannot represent instead of silently dropping images/documents/thinking blocks.
    const blocks = [
      ...(Array.isArray(body.system) ? body.system : []),
      ...(body.messages || []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])),
    ]
    if (blocks.some((block) => !['text', 'tool_use', 'tool_result'].includes(block?.type)))
      throw gatewayError(
        'gateway_content_unsupported',
        'GPT Messages supports text and standard tool content; use Responses for other input types',
      )
    if (
      blocks.some(
        (block) =>
          block.type === 'tool_result' &&
          Array.isArray(block.content) &&
          block.content.some((part) => part?.type !== 'text'),
      )
    )
      throw gatewayError(
        'gateway_content_unsupported',
        'GPT Messages tool results support text; use Responses for other input types',
      )
    source = { ...claudeToOpenAIChatRequest(body), tool_choice: body.tool_choice, stream: !!body.stream }
  }
  if (protocol === 'openai.chat') {
    for (const message of body.messages || []) {
      if (
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            typeof part !== 'string' &&
            ![
              'text',
              'input_text',
              'output_text',
              ...(message.role === 'user' ? ['image_url', 'input_image'] : []),
            ].includes(part?.type),
        )
      )
        throw gatewayError(
          'gateway_content_unsupported',
          'GPT Chat supports text, user images and function tools; use Responses for other input types',
        )
      if (message.audio || message.function_call || message.tool_calls?.some((call) => call.type !== 'function'))
        throw gatewayError('gateway_content_unsupported', 'GPT Chat requires standard function tool history')
    }
    if (body.audio || body.modalities?.some((value) => value !== 'text'))
      throw gatewayError(
        'gateway_content_unsupported',
        'GPT Chat supports text output; use Responses for other output types',
      )
    if (body.tools?.some((tool) => tool.type !== 'function'))
      throw gatewayError(
        'gateway_content_unsupported',
        'GPT Chat supports function tools; use Responses for custom tools',
      )
  }
  if (!['openai.chat', 'openai.completions', 'anthropic.messages'].includes(protocol))
    throw gatewayError('hybrid_protocol_unsupported', 'This GPT gateway protocol is not supported')
  if (body.n != null && body.n !== 1)
    throw gatewayError('gateway_content_unsupported', 'GPT gateway supports one completion per request')
  const converted =
    protocol === 'openai.completions' ? completionsToCodexResponses(source) : chatToCodexResponses(source)
  converted.model = model
  converted.stream = !!body.stream
  const budget = body.max_completion_tokens ?? body.max_tokens
  if (budget != null) converted.max_output_tokens = budget
  for (const key of [
    'temperature',
    'top_p',
    'parallel_tool_calls',
    'metadata',
    'user',
    'prompt_cache_key',
    'service_tier',
  ])
    if (body[key] != null) converted[key] = body[key]
  if (body.response_format) {
    const format = body.response_format
    converted.text = { format: format.type === 'json_schema' ? { type: 'json_schema', ...format.json_schema } : format }
  }
  return converted
}

function readableResponse(body) {
  // Existing output converters accept text blocks; a refusal is visible output too.
  return {
    ...body,
    output: body.output?.map((item) => ({
      ...item,
      ...(item.content
        ? {
            content: item.content.map((block) =>
              block.type === 'refusal' ? { type: 'output_text', text: block.refusal || '' } : block,
            ),
          }
        : {}),
    })),
  }
}

export function hostedResponseBody(protocol, body, model) {
  if (protocol === 'openai.responses') return body
  for (const item of body.output || [])
    if (
      ['function_call', 'custom_tool_call'].includes(item.type) &&
      (!String(item.name || '').trim() || !String(item.call_id || item.id || '').trim())
    )
      throw gatewayError('gateway_tool_mismatch', 'GPT gateway returned a tool without a name or call identity', 502)
  const message = codexBodyToAnthropicMessage(readableResponse(body), model)
  const result =
    protocol === 'anthropic.messages'
      ? message
      : protocol === 'openai.completions'
        ? fromClaudeToOpenAICompletions(message, model)
        : fromClaudeToOpenAIChat(message, model)
  if (!extractOpenaiUsage(body.usage)) delete result.usage
  return result
}

/** Stateful wire formatting only. Completion validity is owned by the gateway runner. */
export function createHostedResponseStream(protocol, model) {
  const state =
    protocol === 'anthropic.messages' ? createAnthropicSseState() : createChatSseState(`chatcmpl_${randomUUID()}`)
  state.model = model
  let emittedText = ''
  const custom = new Map()
  const identities = new Map()
  const checkTool = (item, index, itemId) => {
    if (!['function_call', 'custom_tool_call'].includes(item?.type)) return
    const keys = [index, itemId, item.id, item.call_id].filter((key) => key != null && key !== '').map(String)
    const found = keys.map((key) => identities.get(key)).filter(Boolean)
    const identity = found[0] || {}
    if (found.some((value) => value !== identity))
      throw gatewayError('gateway_tool_mismatch', 'GPT gateway changed a tool identity', 502)
    for (const field of ['id', 'call_id', 'name', 'type']) {
      if (item[field] && identity[field] && item[field] !== identity[field])
        throw gatewayError('gateway_tool_mismatch', 'GPT gateway changed a tool identity', 502)
      if (item[field]) identity[field] = item[field]
    }
    for (const key of keys) identities.set(key, identity)
  }
  const customFunction = (event) => {
    const key = event.output_index ?? event.item_id
    if (event.item?.type === 'custom_tool_call') {
      const input = event.item.input || ''
      custom.set(key, input)
      const item = { ...event.item, type: 'function_call' }
      delete item.input
      if (event.type === 'response.output_item.done') item.arguments = JSON.stringify({ input })
      return { ...event, item }
    }
    if (event.type === 'response.custom_tool_call_input.delta') {
      // Buffer custom raw text until its authoritative done/item snapshot. Treating
      // raw text as function.arguments would generate invalid Chat tool JSON.
      custom.set(key, (custom.get(key) || '') + (event.delta || ''))
      return null
    }
    if (event.type === 'response.custom_tool_call_input.done')
      return {
        ...event,
        type: 'response.function_call_arguments.done',
        arguments: JSON.stringify({ input: event.input ?? custom.get(key) ?? '' }),
      }
    if (event.type === 'response.completed')
      return {
        ...event,
        response: {
          ...event.response,
          output: event.response?.output?.map((item) =>
            item.type === 'custom_tool_call'
              ? { ...item, type: 'function_call', arguments: JSON.stringify({ input: item.input || '' }) }
              : item,
          ),
        },
      }
    return event
  }
  const convert = (event) => {
    if (protocol !== 'anthropic.messages') {
      event = customFunction(event)
      if (!event) return ''
    }
    const line = `data: ${JSON.stringify(event)}`
    if (protocol === 'anthropic.messages') return responsesSseToAnthropicEvents(line, state) || ''
    const frames = responsesSseToChatChunk(line, state.id, state) || ''
    return frames
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => {
        const data = frame.slice(6)
        if (data === '[DONE]') return `${frame}\n\n`
        const chunk = JSON.parse(data)
        chunk.model = model
        chunk.created = Math.floor(Date.now() / 1000)
        if (protocol === 'openai.completions') {
          chunk.object = 'text_completion'
          chunk.choices = chunk.choices.map((choice) => ({
            index: choice.index,
            text: choice.delta?.content || '',
            finish_reason: choice.finish_reason,
            logprobs: null,
          }))
        }
        return `data: ${JSON.stringify(chunk)}\n\n`
      })
      .join('')
  }
  return (event, validTerminal) => {
    if (protocol === 'openai.responses') return ''
    const type = event.type || ''
    if (event.item) checkTool(event.item, event.output_index, event.item_id)
    if (type === 'response.completed')
      for (const [index, item] of (event.response?.output || []).entries()) checkTool(item, index)
    if (/^response\.(function_call_arguments|custom_tool_call_input)\.(delta|done)$/.test(type)) {
      const identity = identities.get(String(event.output_index)) || identities.get(String(event.item_id))
      if (!identity?.name || !(identity.call_id || identity.id) || (event.name && event.name !== identity.name))
        throw gatewayError(
          'gateway_tool_mismatch',
          'GPT gateway supplied arguments without a stable tool identity',
          502,
        )
    }
    // An upstream [DONE] alone is not a completed Responses result. Reasoning is
    // not an Anthropic text answer, and must not become one during conversion.
    if (protocol === 'anthropic.messages' && type.startsWith('response.reasoning_')) return ''
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') emittedText += event.delta || ''
    if (Buffer.byteLength(emittedText) > 64 * 1024 * 1024)
      throw gatewayError('gateway_response_too_large', 'GPT gateway response exceeded its size limit', 502)
    if (type === 'response.completed') {
      if (!validTerminal) return ''
      // Validate complete tool arguments before emitting any success terminal.
      hostedResponseBody('anthropic.messages', event.response || {}, model)
      const full = (event.response?.output || [])
        .flatMap((item) => item.content || [])
        .filter((block) => ['text', 'output_text', 'refusal'].includes(block.type))
        .map((block) => block.text || block.refusal || '')
        .join('')
      let repair = ''
      if (full) {
        if (!full.startsWith(emittedText))
          throw gatewayError('gateway_output_mismatch', 'GPT gateway output disagrees with its streamed prefix', 502)
        if (full.length > emittedText.length)
          repair = convert({ type: 'response.output_text.delta', delta: full.slice(emittedText.length) })
      }
      const tail = convert(event)
      for (const slot of new Set(state.tools.values())) {
        if (slot.custom) continue
        let args
        try {
          args = JSON.parse(slot.args || '{}')
        } catch {}
        if (!slot.name || !slot.id || !args || typeof args !== 'object' || Array.isArray(args))
          throw gatewayError('tool_arguments_invalid', 'GPT gateway returned incomplete function arguments', 502)
      }
      return repair + tail
    }
    // Never turn a legacy done/failed/incomplete event into a successful finish.
    if (['response.done', 'response.failed', 'response.incomplete', 'error'].includes(type)) return ''
    return convert(type === 'response.refusal.delta' ? { ...event, type: 'response.output_text.delta' } : event)
  }
}
