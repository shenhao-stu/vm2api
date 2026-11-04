import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import {
  hostedResponsesRequest,
  hostedResponseBody,
  createHostedResponseStream,
} from '../../src/lib/protocol/hosted-gateway-protocol.mjs'
import { runHostedGateway } from '../../src/lib/protocol/hosted-gateway.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'

const model = 'gpt-6.1-sol'
const usage = {
  input_tokens: 14,
  output_tokens: 9,
  input_tokens_details: { cached_tokens: 4 },
  output_tokens_details: { reasoning_tokens: 2 },
}
const textItem = (text) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
})
const completed = (output, extra = {}) => ({
  type: 'response.completed',
  response: {
    id: 'resp_review',
    status: 'completed',
    model,
    output,
    usage,
    ...extra,
  },
})
const frames = (wire) =>
  wire
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== '[DONE]')
    .map(JSON.parse)
const wireText = (protocol, wire) =>
  frames(wire)
    .map((event) =>
      protocol === 'anthropic.messages'
        ? event.delta?.type === 'text_delta'
          ? event.delta.text
          : ''
        : event.choices?.[0]?.delta?.content || event.choices?.[0]?.text || '',
    )
    .join('')

function response() {
  return Object.assign(new EventEmitter(), {
    headersSent: false,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk))
      return true
    },
    end() {},
  })
}
async function upstream(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}
async function run(origin, protocol, body) {
  const endpoint = {
    id: 'ep_123456789abc',
    kind: 'local_gateway',
    protocol: 'openai',
    base_url: origin,
    headers: {},
    models: [{ name: model, alias: model }],
    api_key_entries: [{ id: 'ek_review', api_key: 'synthetic-review-key' }],
  }
  const scheduler = new ApiScheduler()
  scheduler.reload([endpoint])
  const res = response()
  const result = await runHostedGateway({
    req: { headers: {} },
    res,
    endpoint,
    scheduler,
    protocol,
    body: { model, ...body },
    timeoutMs: 1000,
  })
  return { result, wire: Buffer.concat(res.chunks).toString('utf8') }
}

test('Chat request preserves tool history, image URLs and explicit output budget on the Responses wire', () => {
  const request = hostedResponsesRequest(
    'openai.chat',
    {
      messages: [
        { role: 'system', content: 'Be concise' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AA==' },
            },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_one',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"a"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_one', content: 'found' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      max_completion_tokens: 37,
      stream: false,
    },
    model,
  )
  assert.equal(request.input[0].role, 'developer')
  assert.equal(request.input[1].content[1].type, 'input_image')
  assert.equal(request.input[1].content[1].image_url, 'data:image/png;base64,AA==')
  assert.deepEqual(request.input.slice(2), [
    {
      type: 'function_call',
      call_id: 'call_one',
      name: 'lookup',
      arguments: '{"q":"a"}',
    },
    { type: 'function_call_output', call_id: 'call_one', output: 'found' },
  ])
  assert.deepEqual(request.tool_choice, { type: 'function', name: 'lookup' })
  assert.equal(request.max_output_tokens, 37)
  assert.equal(request.stream, false)
})

test('Messages request preserves assistant tool calls and user tool results', () => {
  const request = hostedResponsesRequest(
    'anthropic.messages',
    {
      system: [{ type: 'text', text: 'system' }],
      messages: [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_one',
              name: 'lookup',
              input: { q: 'a' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_one', content: 'found' }],
        },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'lookup' },
      max_tokens: 42,
    },
    model,
  )
  assert.deepEqual(
    request.input.filter((item) => item.type !== 'message'),
    [
      {
        type: 'function_call',
        call_id: 'call_one',
        name: 'lookup',
        arguments: '{"q":"a"}',
      },
      { type: 'function_call_output', call_id: 'call_one', output: 'found' },
    ],
  )
  assert.deepEqual(request.tool_choice, { type: 'function', name: 'lookup' })
  assert.equal(request.max_output_tokens, 42)
})

test('unsupported nested Messages images and Chat audio fail before any lossy conversion', () => {
  const nestedImage = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_one',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'AA==',
                },
              },
            ],
          },
        ],
      },
    ],
  }
  assert.throws(() => hostedResponsesRequest('anthropic.messages', nestedImage, model), {
    code: 'gateway_content_unsupported',
  })
  const audio = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }],
      },
    ],
  }
  assert.throws(() => hostedResponsesRequest('openai.chat', audio, model), {
    code: 'gateway_content_unsupported',
  })
})

test('native Responses input keeps custom tools and complete history', () => {
  const source = {
    model,
    input: [
      { type: 'custom_tool_call', call_id: 'custom_one', name: 'patch', input: 'patch text' },
      { type: 'custom_tool_call_output', call_id: 'custom_one', output: 'ok' },
    ],
    tools: [{ type: 'custom', name: 'patch', format: { type: 'text' } }],
    max_output_tokens: 17,
    stream: true,
  }
  assert.deepEqual(hostedResponsesRequest('openai.responses', source, model), source)
})

test('JSON text plus tools convert with complete stop and non-duplicated cache/reasoning usage', () => {
  const output = [
    textItem('REVIEW_OK'),
    {
      type: 'function_call',
      call_id: 'call_one',
      name: 'lookup',
      arguments: '{"q":"a"}',
    },
  ]
  const source = completed(output).response
  const chat = hostedResponseBody('openai.chat', source, model)
  assert.equal(chat.object, 'chat.completion')
  assert.equal(chat.choices[0].message.content, 'REVIEW_OK')
  assert.equal(chat.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(JSON.parse(chat.choices[0].message.tool_calls[0].function.arguments), { q: 'a' })
  assert.deepEqual(chat.usage, {
    prompt_tokens: 14,
    completion_tokens: 9,
    total_tokens: 23,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
  })
  const message = hostedResponseBody('anthropic.messages', source, model)
  assert.equal(message.type, 'message')
  assert.equal(message.stop_reason, 'tool_use')
  assert.deepEqual(message.content[1].input, { q: 'a' })
  assert.deepEqual(message.usage, {
    input_tokens: 10,
    output_tokens: 9,
    cache_read_input_tokens: 4,
    reasoning_tokens: 2,
  })
})

test('completed-only and partial text snapshots emit the whole answer exactly once in every client protocol', () => {
  for (const protocol of ['openai.chat', 'anthropic.messages', 'openai.completions']) {
    for (const prefix of ['', '你']) {
      const map = createHostedResponseStream(protocol, model)
      let wire = prefix ? map({ type: 'response.output_text.delta', delta: prefix }, false) : ''
      wire += map(completed([textItem('你好')]), true)
      wire += map(completed([textItem('你好')]), true)
      assert.equal(wireText(protocol, wire), '你好', protocol)
      if (protocol === 'anthropic.messages')
        assert.equal(frames(wire).filter((event) => event.type === 'message_stop').length, 1)
      else assert.equal((wire.match(/data: \[DONE\]/g) || []).length, 1)
    }
  }
})

test('stream text snapshot conflicting with delivered prefix fails instead of replacing prior bytes', () => {
  const map = createHostedResponseStream('openai.chat', model)
  map({ type: 'response.output_text.delta', delta: 'hello' }, false)
  assert.throws(() => map(completed([textItem('different')]), true), {
    code: 'gateway_output_mismatch',
  })
})

test('final tool snapshot fills only missing argument suffix and rejects a conflicting prefix', () => {
  const map = createHostedResponseStream('openai.chat', model)
  let wire = map(
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_one',
        call_id: 'call_one',
        name: 'lookup',
        arguments: '',
      },
    },
    false,
  )
  wire += map(
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_one',
      delta: '{"q":',
    },
    false,
  )
  wire += map(
    completed([
      {
        type: 'function_call',
        id: 'fc_one',
        call_id: 'call_one',
        name: 'lookup',
        arguments: '{"q":"a"}',
      },
    ]),
    true,
  )
  const calls = frames(wire).flatMap((event) => event.choices?.[0]?.delta?.tool_calls || [])
  assert.equal(calls.filter((call) => call.id).length, 1)
  assert.deepEqual(JSON.parse(calls.map((call) => call.function?.arguments || '').join('')), { q: 'a' })
  const bad = createHostedResponseStream('openai.chat', model)
  bad(
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_one',
        call_id: 'call_one',
        name: 'lookup',
        arguments: '{"q":"a',
      },
    },
    false,
  )
  assert.throws(
    () =>
      bad(
        completed([
          {
            type: 'function_call',
            id: 'fc_one',
            call_id: 'call_one',
            name: 'lookup',
            arguments: '{"q":"b"}',
          },
        ]),
        true,
      ),
    { code: 'tool_arguments_mismatch' },
  )
})

test('invalid final function JSON cannot produce a successful SSE finish', () => {
  for (const protocol of ['openai.chat', 'anthropic.messages']) {
    const map = createHostedResponseStream(protocol, model)
    assert.throws(
      () =>
        map(
          completed([
            {
              type: 'function_call',
              call_id: 'call_one',
              name: 'lookup',
              arguments: '{"q":',
            },
          ]),
          true,
        ),
      { code: 'tool_arguments_invalid' },
    )
  }
})

test('reasoning-only and failed upstream events do not synthesize client success', () => {
  const map = createHostedResponseStream('anthropic.messages', model)
  assert.equal(
    map(
      {
        type: 'response.reasoning_summary_text.delta',
        delta: 'private thought',
      },
      false,
    ),
    '',
  )
  assert.equal(
    map(
      completed([
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'private thought' }],
        },
      ]),
      false,
    ),
    '',
  )
  assert.equal(map({ type: 'response.failed', response: { status: 'failed' } }, false), '')
})

test('real canonical Responses JSON hop returns actual Chat shape and is sent exactly once', async (t) => {
  let calls = 0
  const origin = await upstream(t, async (req, res) => {
    calls++
    assert.equal(req.url, '/v1/responses')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(body.input[0].content[0].text, 'hello')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(completed([textItem('REVIEW_OK')]).response))
  })
  const { result } = await run(origin, 'openai.chat', {
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  })
  assert.equal(result.ok, true)
  assert.equal(result.body.choices[0].message.content, 'REVIEW_OK')
  assert.equal(result.body.choices[0].finish_reason, 'stop')
  assert.equal(result.body.usage.prompt_tokens, 14)
  assert.equal(result.attemptCount, 1)
  assert.equal(calls, 1)
})

test('real completed-only SSE is translated with visible text and full downstream terminal', async (t) => {
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(completed([textItem('REVIEW_OK')]))}\n\n`)
  })
  for (const protocol of ['openai.chat', 'anthropic.messages']) {
    const { result, wire } = await run(origin, protocol, {
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    })
    assert.equal(result.ok, true, protocol)
    assert.equal(wireText(protocol, wire), 'REVIEW_OK')
    assert.equal(result.usage.output_tokens, 9)
    assert.equal(result.attemptCount, 1)
  }
  assert.equal(calls, 2)
})

test('real truncated SSE never claims success or replays the upstream call', async (t) => {
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')
  })
  const { result, wire } = await run(origin, 'openai.chat', {
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.terminalState, 'incomplete')
  assert.equal(result.attemptCount, 1)
  assert.equal(calls, 1)
  assert.equal(wire.includes('[DONE]'), false)
})

test('custom tool raw input has the same JSON envelope in streamed and JSON client protocols', () => {
  const input = '*** Begin Patch\n你好 "quoted" \\ path'
  const item = {
    type: 'custom_tool_call',
    id: 'ct_one',
    call_id: 'call_custom',
    name: 'patch',
    input,
  }
  for (const protocol of ['openai.chat', 'anthropic.messages']) {
    const json = hostedResponseBody(protocol, completed([item]).response, model)
    const expected =
      protocol === 'anthropic.messages'
        ? json.content[0].input
        : JSON.parse(json.choices[0].message.tool_calls[0].function.arguments)
    assert.deepEqual(expected, { input })
    for (const streamed of [false, true]) {
      const map = createHostedResponseStream(protocol, model)
      let wire = ''
      if (streamed) {
        wire += map(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, input: '' },
          },
          false,
        )
        wire += map(
          {
            type: 'response.custom_tool_call_input.delta',
            output_index: 0,
            item_id: item.id,
            delta: input.slice(0, 12),
          },
          false,
        )
        wire += map(
          {
            type: 'response.custom_tool_call_input.delta',
            output_index: 0,
            item_id: item.id,
            delta: input.slice(12),
          },
          false,
        )
        wire += map(
          {
            type: 'response.custom_tool_call_input.done',
            output_index: 0,
            item_id: item.id,
            input,
          },
          false,
        )
      }
      wire += map(completed([item]), true)
      const args = frames(wire)
        .flatMap((event) =>
          protocol === 'anthropic.messages'
            ? event.delta?.type === 'input_json_delta'
              ? [event.delta.partial_json]
              : []
            : (event.choices?.[0]?.delta?.tool_calls || []).map((call) => call.function?.arguments || ''),
        )
        .join('')
      assert.deepEqual(JSON.parse(args), expected, `${protocol} streamed=${streamed}`)
    }
  }
})

test('a final snapshot cannot rename or rebind a tool already announced to the client', () => {
  for (const protocol of ['openai.chat', 'anthropic.messages']) {
    for (const type of ['function_call', 'custom_tool_call']) {
      for (const changed of [{ name: 'other_action' }, { call_id: 'call_other' }]) {
        const item = {
          type,
          id: 'item_one',
          call_id: 'call_one',
          name: 'lookup',
          ...(type === 'function_call' ? { arguments: '' } : { input: '' }),
        }
        const map = createHostedResponseStream(protocol, model)
        map({ type: 'response.output_item.added', output_index: 0, item }, false)
        const final = {
          ...item,
          ...changed,
          ...(type === 'function_call' ? { arguments: '{}' } : { input: 'raw' }),
        }
        assert.throws(() => map(completed([final]), true), `${protocol} ${type} ${Object.keys(changed)[0]}`)
      }
    }
  }
})

test('JSON text cannot mask a tool result with a missing name or call identity', () => {
  for (const protocol of ['openai.chat', 'anthropic.messages']) {
    for (const type of ['function_call', 'custom_tool_call']) {
      const full = {
        type,
        call_id: 'call_one',
        name: 'lookup',
        ...(type === 'function_call' ? { arguments: '{}' } : { input: 'raw' }),
      }
      for (const missing of ['name', 'call_id']) {
        const item = { ...full }
        delete item[missing]
        assert.throws(
          () => hostedResponseBody(protocol, completed([textItem('hello'), item]).response, model),
          `${protocol} ${type} ${missing}`,
        )
      }
    }
  }
})

test('a real failed Responses stream emits no successful downstream terminal and is not replayed', async (t) => {
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"fixture_failure"}}}\n\n',
    )
  })
  const { result, wire } = await run(origin, 'openai.chat', {
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.failed, true)
  assert.equal(result.attemptCount, 1)
  assert.equal(calls, 1)
  assert.equal(wire.includes('[DONE]'), false)
  assert.equal(
    frames(wire).some((event) => event.choices?.[0]?.finish_reason),
    false,
  )
})

test('missing or partial final JSON usage cannot become a verified zero-cost success', async (t) => {
  let calls = 0
  let reportedUsage
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    const body = completed([textItem('REVIEW_OK')]).response
    delete body.usage
    if (reportedUsage !== undefined) body.usage = reportedUsage
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  for (const value of [undefined, { input_tokens: 14 }, { input_tokens: 14, output_tokens: -1 }]) {
    reportedUsage = value
    const { result } = await run(origin, 'openai.chat', {
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 502)
    assert.equal(result.errorCode, 'gateway_usage_missing')
    assert.equal(result.attemptCount, 1)
  }
  assert.equal(calls, 3)
})

test('initial stream usage cannot substitute for missing completed-response usage', async (t) => {
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    const start = {
      type: 'response.created',
      response: {
        id: 'resp_review',
        model,
        status: 'in_progress',
        usage: { input_tokens: 14, output_tokens: 0 },
      },
    }
    const end = completed([textItem('REVIEW_OK')])
    delete end.response.usage
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(end)}\n\n`)
  })
  const { result, wire } = await run(origin, 'openai.chat', {
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'gateway_usage_missing')
  assert.equal(wire.includes('[DONE]'), false)
  assert.equal(result.attemptCount, 1)
  assert.equal(calls, 1)
})
