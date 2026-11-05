import test from 'node:test'
import assert from 'node:assert/strict'
import { createSseJsonBridge } from '../../src/lib/protocol/responses-ws.mjs'

for (const callType of ['function_call', 'custom_tool_call']) {
  for (const terminalShape of ['omitted', 'empty', 'partial']) {
    test(`SSE replay retains completed ${callType} items with ${terminalShape} terminal output`, () => {
      const reasoning = {
        type: 'reasoning',
        id: 'rs_replay',
        summary: [{ type: 'summary_text', text: 'think' }],
        encrypted_content: 'opaque-reasoning-content',
      }
      const call = {
        type: callType,
        id: 'item_replay',
        call_id: 'call_replay',
        name: 'lookup',
        [callType === 'function_call' ? 'arguments' : 'input']: '{"q":"x"}',
      }
      const message = {
        type: 'message',
        id: 'msg_replay',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'looking up' }],
      }
      const response = { id: 'resp_replay', status: 'completed' }
      if (terminalShape !== 'omitted') response.output = terminalShape === 'empty' ? [] : [message]
      const events = [
        { type: 'response.created', response: { id: 'resp_replay', output: [] } },
        {
          type: 'response.output_item.added',
          output_index: 3,
          item: { ...call, id: 'fc_partial', call_id: 'call_partial' },
        },
        { type: 'response.function_call_arguments.delta', output_index: 3, item_id: 'fc_partial', delta: '{' },
        { type: 'response.output_item.done', output_index: 1, item: call },
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
        { type: 'response.output_item.done', output_index: 2, item: message },
        { type: 'response.completed', response },
      ]
      const bridge = createSseJsonBridge()
      for (const event of events) bridge.push(`data: ${JSON.stringify(event)}\n\n`)
      bridge.finish()
      assert.equal(bridge.terminal, 'completed')
      assert.deepEqual(bridge.snapshot(), { id: 'resp_replay', output: [reasoning, call, message] })
      assert.deepEqual(bridge.frames, events)
      assert.equal(Object.hasOwn(response, 'output'), terminalShape !== 'omitted')
    })
  }
}

test('SSE replay prefers terminal items and deduplicates parallel calls by id, call_id, and output index', () => {
  const reasoning = { type: 'reasoning', id: 'rs_parallel', summary: [], encrypted_content: 'keep-exactly' }
  const first = { type: 'function_call', id: 'fc_streamed', call_id: 'call_first', name: 'first', arguments: '{}' }
  const finalFirst = { ...first, id: 'fc_final', arguments: '{"complete":true}' }
  const second = {
    type: 'custom_tool_call',
    id: 'ct_second',
    call_id: 'call_second',
    name: 'second',
    input: 'raw input',
  }
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] }
  const finalMessage = { ...message, status: 'completed' }
  const bridge = createSseJsonBridge()
  const events = [
    { type: 'response.created', response: { id: 'resp_parallel', output: [] } },
    { type: 'response.output_item.done', output_index: 2, item: second },
    { type: 'response.output_item.done', output_index: 1, item: first },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 2, item: second },
    { type: 'response.output_item.done', output_index: 3, item: message },
    {
      type: 'response.completed',
      response: { id: 'resp_parallel', output: [reasoning, finalFirst, second, finalMessage] },
    },
  ]
  for (const event of events) bridge.push(`data: ${JSON.stringify(event)}\n\n`)
  bridge.finish()
  assert.deepEqual(bridge.snapshot().output, [reasoning, finalFirst, second, finalMessage])
  assert.deepEqual(bridge.frames, events)
})
