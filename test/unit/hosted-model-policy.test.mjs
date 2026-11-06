import test from 'node:test'
import assert from 'node:assert/strict'
import { hostedModelDenial, isFableModel, withoutFableModels } from '../../src/lib/protocol/hosted-model-policy.mjs'
import { getModelPolicy } from '../../src/lib/protocol/model-policy.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { normalizeKeyScope, keyAllowsVm } from '../../src/lib/admin/key-scope.mjs'

test('Fable policy rejects literal, provider-prefixed and configured aliases in requests/catalogs', () => {
  const policy = getModelPolicy()
  const original = policy.aliases['claude-hidden-family']
  policy.aliases['claude-hidden-family'] = 'claude-fable-5'
  try {
    for (const id of ['FaBlE', 'anthropic/CLAUDE-FABLE-5.1', 'gpt-fable-name', 'claude-hidden-family']) {
      assert.equal(isFableModel(id), true)
      assert.equal(hostedModelDenial(null, id).code, 'model_disabled')
    }
    assert.equal(isFableModel('claude-sonnet-4-6'), false)
    assert.deepEqual(withoutFableModels({ data: [{ id: 'claude-hidden-family' }, { id: 'gpt-6.1-sol' }] }).data, [
      { id: 'gpt-6.1-sol' },
    ])
  } finally {
    if (original == null) delete policy.aliases['claude-hidden-family']
    else policy.aliases['claude-hidden-family'] = original
  }
})

test('API endpoint aliases cannot conceal Fable upstreams', () => {
  const scheduler = new ApiScheduler()
  scheduler.reload([
    {
      id: 'ep_test',
      models: [{ name: 'claude-fable-5', alias: 'claude-hidden' }],
      api_key_entries: [{ id: 'ek_test', api_key: 'test' }],
    },
  ])
  assert.equal(scheduler.pick('claude-hidden').ok, false)
  assert.deepEqual(scheduler.catalog().data, [])
  assert.equal(scheduler.pick('FaBlE').code, 'model_disabled')
  scheduler.reload([
    {
      id: 'ep_test',
      models: [{ upstream_name: 'claude-fable-5', alias: 'claude-hidden' }],
      api_key_entries: [{ id: 'ek_test', api_key: 'test' }],
    },
  ])
  assert.equal(scheduler.pick('claude-hidden').ok, false)
  assert.deepEqual(scheduler.catalog().data, [])
})

test('the explicit gateway scope exception gives no native VM authority', () => {
  const scope = normalizeKeyScope({ group_type: 'openai', allowed_vms: [], vm_pool_id: null }, { gatewayOnly: true })
  for (const vm of [
    { id: 'gpt', platform: 'openai' },
    { id: 'claude', platform: 'anthropic' },
  ])
    assert.equal(keyAllowsVm(scope, vm), false)
  assert.throws(() => normalizeKeyScope({ group_type: 'openai', allowed_vms: [] }), { code: 'key_vms_required' })
  assert.throws(() => normalizeKeyScope({ group_type: 'anthropic', allowed_vms: [] }, { gatewayOnly: true }), {
    code: 'key_vms_required',
  })
})

test('count_tokens rejects Fable and GPT-only Claude requests before any account lookup or hop', async () => {
  for (const [record, model, code] of [
    [{ category: 'oauth', group_type: 'anthropic' }, 'FaBlE', 'model_disabled'],
    [{ category: 'hybrid', group_type: 'openai' }, 'claude-sonnet-4-6', 'key_group_mismatch'],
  ]) {
    let result
    let calls = 0
    await handleUserCountTokens(
      { apiKeyKind: 'managed', apiKeyRecord: record },
      {},
      {
        requireAuth: () => true,
        readBody: async () => ({ model, messages: [{ role: 'user', content: 'hi' }] }),
        cfg: { limits: { max_body_bytes: 1024 } },
        json: (_res, status, body) => {
          result = { status, body }
        },
        getPoolScheduler: () => {
          calls++
          throw new Error('unexpected account lookup')
        },
      },
    )
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, code)
    assert.equal(calls, 0)
  }
})
