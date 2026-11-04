import { StringDecoder } from 'node:string_decoder'
import { once } from 'node:events'
import { forwardLocalGateway } from '../transport/local-gateway-client.mjs'
import { assertLocalGatewayEndpoint, gatewayError } from '../pool/local-gateway-policy.mjs'
import { disjointOpenaiUsage, extractOpenaiUsage, mergeUsage } from './openai-usage.mjs'
import { calculateCost } from '../admin/pricing.mjs'
import { hostedResponsesRequest, hostedResponseBody, createHostedResponseStream } from './hosted-gateway-protocol.mjs'

const MAX_FRAME = 2 * 1024 * 1024
const MAX_JSON = 64 * 1024 * 1024

function evidence(protocol) {
  let serviceTier = null
  let usage = null
  let terminal = false
  let failed = false
  let visible = false
  let done = false
  let finalUsage = null
  let upstreamModel = null
  const visibleBlock = (block) =>
    !!(
      block &&
      ((['text', 'output_text', 'refusal'].includes(block.type) && (block.text || block.refusal)) ||
        (['tool_use', 'function_call', 'custom_tool_call'].includes(block.type) && block.name) ||
        (block.type === 'message' && block.content?.some(visibleBlock)))
    )
  const observe = (event) => {
    if (!event || typeof event !== 'object') return
    usage = mergeUsage(usage, event.usage || event.response?.usage || event.message?.usage)
    serviceTier = event.response?.service_tier ?? event.service_tier ?? serviceTier
    upstreamModel = event.model || event.response?.model || event.message?.model || upstreamModel
    visible ||= !!(
      event.output?.some(visibleBlock) ||
      event.response?.output?.some(visibleBlock) ||
      event.content?.some?.(visibleBlock) ||
      visibleBlock(event.item) ||
      visibleBlock(event.content_block) ||
      ([
        'response.output_text.delta',
        'response.refusal.delta',
        'response.function_call_arguments.delta',
        'response.custom_tool_call_input.delta',
      ].includes(event.type) &&
        event.delta) ||
      (event.type === 'content_block_delta' &&
        ['text_delta', 'input_json_delta'].includes(event.delta?.type) &&
        (event.delta.text || event.delta.partial_json)) ||
      event.choices?.some((choice) => {
        const message = choice.message || choice.delta || {}
        return (
          choice.text ||
          message.content ||
          message.refusal ||
          message.tool_calls?.some((tool) => tool.function?.name || tool.function?.arguments)
        )
      })
    )
    if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) failed = true
    if (protocol === 'openai.responses') {
      if (event.type === 'response.completed' || event.status === 'completed') {
        terminal = true
        finalUsage = event.response?.usage || event.usage || null
      }
      if (['failed', 'incomplete', 'cancelled'].includes(event.status)) failed = true
    } else if (protocol === 'anthropic.messages') {
      if (event.type === 'message_stop' || event.stop_reason) terminal = true
    } else if (event.choices?.some((choice) => choice.finish_reason != null)) terminal = true
  }
  return {
    observe,
    done: () => {
      done = true
    },
    snapshot: () => {
      const tokens = extractOpenaiUsage(finalUsage)
      return {
        usage: usage ? { ...disjointOpenaiUsage(usage), ...(serviceTier ? { service_tier: serviceTier } : {}) } : null,
        usageVerified: tokens?.input_tokens != null && tokens?.output_tokens != null,
        terminal,
        failed,
        visible,
        done,
        upstreamModel,
      }
    },
  }
}

/** One Responses request to the bound gateway; public protocol conversion never replays it. */
export async function runHostedGateway({ req, res, endpoint, scheduler, body, protocol, signal, timeoutMs }) {
  let dispatched = false
  let committed = false
  let upstream
  let upstreamStatus = null
  const observed = evidence('openai.responses')
  const converted = protocol !== 'openai.responses'
  const delivered = evidence(protocol)
  let picked
  try {
    assertLocalGatewayEndpoint(endpoint)
    if (endpoint.disabled) throw gatewayError('gateway_unavailable', 'The GPT gateway is disabled', 503)
    picked = scheduler.pick(body.model, Date.now(), { localGatewayId: endpoint.id })
    if (!picked.ok) throw gatewayError(picked.code, picked.message, picked.code === 'model_not_found' ? 404 : 503)
    if (!calculateCost({ input_tokens: 0, output_tokens: 0 }, picked.upstream_model).known)
      throw gatewayError('gateway_model_unpriced', 'Configure a price for this GPT model before dispatch', 400)
    upstream = await forwardLocalGateway({
      endpoint,
      key: picked.key,
      protocol: 'openai.responses',
      body: hostedResponsesRequest(protocol, body, picked.upstream_model),
      callerHeaders: req.headers,
      signal,
      timeoutMs,
      onDispatched: () => {
        dispatched = true
      },
    })
    const status = upstream.statusCode || 502
    upstreamStatus = status
    const contentType = String(upstream.headers['content-type'] || '')
    const stream = /text\/event-stream/i.test(contentType) && status >= 200 && status < 300
    if (status >= 200 && status < 300 && !!body.stream !== stream)
      throw gatewayError('gateway_protocol_error', 'GPT gateway response does not match the requested stream mode', 502)
    const headers = { 'content-type': stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8' }
    if (upstream.headers['retry-after']) headers['retry-after'] = upstream.headers['retry-after']
    const decoder = new StringDecoder('utf8')
    let pending = ''
    const chunks = []
    let bytes = 0
    const convertFrame = createHostedResponseStream(protocol, body.model)
    const observeDelivered = (frames) => {
      for (const line of frames.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') delivered.done()
        else if (data) delivered.observe(JSON.parse(data))
      }
    }
    const parseFrames = () => {
      let match
      let output = ''
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
        if (Buffer.byteLength(frame) > MAX_FRAME)
          throw gatewayError('gateway_frame_too_large', 'GPT gateway event exceeded its size limit', 502)
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '[DONE]') observed.done()
        else if (data) {
          try {
            const event = JSON.parse(data)
            observed.observe(event)
            if (converted) {
              const snapshot = observed.snapshot()
              output += convertFrame(
                event,
                snapshot.terminal && snapshot.visible && !snapshot.failed && snapshot.usageVerified,
              )
            }
          } catch (error) {
            if (error.code) throw error
            throw gatewayError('gateway_invalid_sse', 'Invalid GPT gateway event', 502)
          }
        }
      }
      if (Buffer.byteLength(pending) > MAX_FRAME)
        throw gatewayError('gateway_frame_too_large', 'GPT gateway event exceeded its size limit', 502)
      if (converted) observeDelivered(output)
      return output
    }
    const write = async (chunk) => {
      if (!chunk.length) return
      if (!res.headersSent)
        res.writeHead(status, { ...headers, 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
      committed = true
      if (!res.write(chunk)) await once(res, 'drain', { signal })
    }
    for await (const chunk of upstream) {
      if (signal?.aborted) throw signal.reason || new Error('client_cancelled')
      if (stream) {
        pending += decoder.write(chunk)
        const output = parseFrames()
        await write(converted ? output : chunk)
      } else {
        bytes += chunk.length
        if (bytes > MAX_JSON)
          throw gatewayError('gateway_response_too_large', 'GPT gateway response exceeded its size limit', 502)
        chunks.push(chunk)
      }
    }
    let jsonBody = null
    if (stream) {
      pending += decoder.end()
      const output = parseFrames()
      if (converted) await write(output)
      if (pending.trim()) throw gatewayError('gateway_incomplete_sse', 'GPT gateway ended inside an event', 502)
    } else {
      try {
        jsonBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw gatewayError('gateway_invalid_json', 'GPT gateway returned invalid JSON', 502)
      }
      observed.observe(jsonBody)
      if (converted && status >= 200 && status < 300) {
        jsonBody = hostedResponseBody(protocol, jsonBody, body.model)
        delivered.observe(jsonBody)
      }
    }
    const snapshot = observed.snapshot()
    const doneRequired = stream && (protocol === 'openai.chat' || protocol === 'openai.completions')
    const output = converted ? delivered.snapshot() : snapshot
    const ok =
      status >= 200 &&
      status < 300 &&
      snapshot.terminal &&
      snapshot.visible &&
      !snapshot.failed &&
      snapshot.usageVerified &&
      output.visible &&
      output.terminal &&
      !output.failed &&
      (!doneRequired || output.done)
    return {
      ...snapshot,
      upstreamStatus,
      ok,
      status: ok || status >= 400 ? status : 502,
      headers,
      body: jsonBody,
      errorCode:
        ok || status >= 400
          ? null
          : snapshot.terminal && snapshot.visible && !snapshot.usageVerified
            ? 'gateway_usage_missing'
            : 'gateway_incomplete_response',
      terminalState: ok ? 'verified' : status >= 400 ? 'rejected' : 'incomplete',
      committed,
      attemptCount: dispatched ? 1 : 0,
      accountId: picked.key.id,
      endpointId: endpoint.id,
      model: picked.upstream_model,
    }
  } catch (error) {
    upstream?.destroy()
    return {
      ...observed.snapshot(),
      upstreamStatus,
      ok: false,
      status: signal?.aborted ? 499 : error.status || 502,
      errorCode: signal?.aborted ? 'client_cancelled' : error.code || 'gateway_transport_error',
      terminalState: signal?.aborted
        ? 'cancelled'
        : !dispatched && error.status >= 400 && error.status < 500
          ? 'rejected'
          : committed
            ? 'incomplete'
            : 'transport_error',
      committed,
      attemptCount: dispatched ? 1 : 0,
      accountId: picked?.key?.id || null,
      endpointId: endpoint?.id || null,
      model: picked?.upstream_model || null,
    }
  }
}
