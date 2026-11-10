import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  loadModelPolicy,
  normalizePolicy,
  seedDefaultPolicy,
  normalizeThinkingByPolicy,
  filterPublicModelIds,
} from '../../src/lib/protocol/model-policy.mjs'
import { clearModelsCache, validateOfficialModel } from '../../src/lib/protocol/models.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { withRequestProtocolBetas } from '../../src/lib/protocol/claude-code-betas.mjs'
import { normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'
import { builtinOf, BUILTIN_ALIASES } from '../../src/lib/admin/builtin-rates.mjs'

const canonical = 'claude-fable-5-2'
const legacy = 'claude-fable-5.2'

test('Fable 5.2 uses official capabilities and prices independently of Fable 5.1', () => {
  const entry = seedDefaultPolicy().models[canonical]
  assert.equal(entry.capabilities.context_window, 1_000_000)
  assert.equal(entry.capabilities.thinking_mode, 'adaptive_only')
  assert.equal(entry.params.max_tokens_cap, 128000)
  assert.equal(entry.params.default_effort, 'high')
  assert.equal(entry.params.on_enabled, 'convert_to_adaptive')
  assert.equal(entry.betas.pass_context_1m, false)
  const { input, output, cache_read, cache_5m, cache_1h } = builtinOf(canonical).price
  assert.deepEqual([input, output, cache_read, cache_5m, cache_1h], [8, 40, 0.2, 10, 16])
  assert.equal(BUILTIN_ALIASES[legacy], canonical)
  assert.deepEqual(builtinOf(canonical).price.modes.fast, {
    input: 16,
    output: 80,
    cache_read: 0.4,
    cache_5m: 20,
    cache_1h: 32,
  })
  assert.equal(builtinOf('claude-fable-5-1').price.input, 10)
})

test('Fable 5.2 policy migration preserves prior model settings and canonical overrides', () => {
  const raw = {
    models: {
      [legacy]: { enabled: false, params: { max_tokens_default: 512 }, aliases: ['my-fable'] },
      [canonical]: { params: { max_tokens_cap: 2048 }, aliases: ['current-fable'] },
      'claude-opus-5': { enabled: false, display_name: 'private Opus' },
    },
    aliases: { custom: legacy },
  }
  const before = structuredClone(raw)
  const normalized = normalizePolicy(raw)
  assert.equal(normalized.models[legacy], undefined)
  assert.equal(normalized.models[canonical].enabled, false)
  assert.equal(normalized.models[canonical].params.max_tokens_default, 512)
  assert.equal(normalized.models[canonical].params.max_tokens_cap, 2048)
  assert.equal(normalized.models[canonical].params.on_enabled, 'convert_to_adaptive')
  assert.deepEqual(normalized.models[canonical].aliases, [legacy, 'my-fable', 'current-fable'])
  assert.equal(normalized.aliases.custom, canonical)
  assert.equal(normalized.models['claude-opus-5'].enabled, false)
  assert.equal(normalized.models['claude-opus-5'].display_name, 'private Opus')
  assert.deepEqual(raw, before)
  assert.deepEqual(normalizePolicy(normalized), normalized)
})

test('saved policies gain Fable 5.2 and disabling it blocks every spelling', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    const settings = new SettingsRepo()
    settings.set('model_policy', { catalog_mode: 'worker_only', models: {} })
    loadModelPolicy({ force: true })
    clearModelsCache()
    assert.equal(settings.get('model_policy').models[canonical].params.default_effort, 'high')
    for (const spelling of [canonical, legacy, `anthropic/${legacy}`, `${legacy}[1m]`]) {
      assert.equal(validateOfficialModel(spelling).model, canonical)
    }
    assert.deepEqual(filterPublicModelIds([legacy, canonical]), [canonical])
    settings.set('model_policy', { models: { [legacy]: { enabled: false } } })
    loadModelPolicy({ force: true })
    clearModelsCache()
    for (const spelling of [canonical, legacy]) assert.equal(validateOfficialModel(spelling).ok, false)
  } finally {
    closeDatabase()
    loadModelPolicy({ force: true })
    clearModelsCache()
  }
})

for (const prepare of [prepareCliHopBody, prepareAnthropicRequest]) {
  test(`${prepare.name} normalizes Fable 5.2 before dispatch without changing older Fable`, () => {
    const request = {
      model: canonical,
      messages: [{ role: 'user', content: 'Read a value.' }],
      tools: [{ name: 'read_value', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'read_value' },
      thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
      temperature: 0.5,
      top_p: 0.9,
      top_k: 3,
      output_config: { effort: 'low' },
    }
    const before = structuredClone(request)
    const out = prepare(request)
    assert.deepEqual(out.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(out.tool_choice, { type: 'auto' })
    assert.equal(out.tools[0].strict, true)
    assert.equal(out.output_config.effort, 'low')
    for (const field of ['temperature', 'top_p', 'top_k']) assert.equal(out[field], undefined)
    assert.deepEqual(request, before)
    assert.deepEqual(prepare(out), out)
    const previous = prepare({ ...request, model: 'claude-fable-5-1' })
    assert.deepEqual(previous.tool_choice, request.tool_choice)
    assert.equal(previous.thinking.type, 'enabled')
  })
}

test('Fable 5.2 cannot disable thinking and rejects unsupported budgets before the hop', () => {
  for (const type of ['disabled', 'enabled', 'adaptive']) {
    const out = normalizeThinkingByPolicy({ model: canonical, thinking: { type, budget_tokens: 4096 } })
    assert.deepEqual(out.thinking, { type: 'adaptive' })
  }
})

test('Fable 5.2 keeps per-turn history controls and gets only the matching protocol gates', () => {
  const body = {
    model: canonical,
    thread: 'owned-thread',
    messages: [{ role: 'user', content: 'Continue.', output_config: { effort: 'low' } }],
  }
  assert.deepEqual(normalizeAnthropicMessages(structuredClone(body)).messages[0].output_config, { effort: 'low' })
  const betas = withRequestProtocolBetas([], body)
  assert.ok(betas.includes('per-turn-control-2026-07-01'))
  assert.ok(betas.includes('mid-conversation-tool-changes-2026-07-01'))
  assert.ok(betas.includes('mid-conversation-output-config-2026-07-01'))
  assert.ok(!betas.includes('tool-provenance-2026-10-26'))
  assert.ok(!betas.includes('context-1m-2025-08-07'))
})
