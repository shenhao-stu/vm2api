import test from 'node:test'
import assert from 'node:assert/strict'
import {
  feishuWebhookUrl,
  sendFeishuNotify,
  dispatchNotify,
  mergeNotifyConfig,
  publicNotifyConfig,
  notifyChannelsReady,
} from '../../src/lib/admin/notify.mjs'
const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000001'
const cfg = { feishu: { enabled: true, webhook: url } }

test('Feishu accepts only fixed HTTPS bot endpoint and never reveals a stored webhook', () => {
  assert.equal(feishuWebhookUrl(url), url)
  for (const value of [
    url.replace('https:', 'http:'),
    url + '?extra=secret',
    url.replace('open.feishu.cn', '127.0.0.1'),
    url + '/redirect',
    'https://open.feishu.cn@evil.invalid/hook',
  ])
    assert.equal(feishuWebhookUrl(value), null)
  assert.equal(notifyChannelsReady(cfg).feishu, true)
  const merged = mergeNotifyConfig(cfg, { feishu: { webhook: '', enabled: true } })
  assert.equal(merged.feishu.webhook, url)
  assert.equal(publicNotifyConfig(merged).feishu.webhook, '')
  assert.equal(publicNotifyConfig(merged).feishu.webhook_set, true)
  assert.doesNotMatch(JSON.stringify(publicNotifyConfig(merged)), /00000000-/)
})

test('native dispatch sends Feishu JSON, blocks redirects and bounds request duration', async () => {
  const result = await dispatchNotify(
    cfg,
    { text: 'vm2api test alert' },
    {
      fetch: async (target, opts) => {
        assert.equal(target, url)
        assert.equal(opts.redirect, 'error')
        assert.equal(opts.signal.aborted, false)
        assert.deepEqual(JSON.parse(opts.body), { msg_type: 'text', content: { text: 'vm2api test alert' } })
        return { ok: true, json: async () => ({ code: 0 }) }
      },
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.results[0].channel, 'feishu')
})

test('provider and transport failures are not reported as delivered and cannot echo secrets', async () => {
  for (const fetch of [
    async () => {
      throw Error(url)
    },
    async () => ({ ok: false, status: 403 }),
    async () => ({ ok: true, json: async () => ({ code: 19024, msg: url }) }),
    async () => ({ ok: true, json: async () => ({ code: url }) }),
    async () => ({
      ok: true,
      json: async () => {
        throw Error(url)
      },
    }),
  ]) {
    const result = await dispatchNotify(cfg, { text: 'alert' }, { fetch })
    assert.equal(result.ok, false)
    assert.doesNotMatch(JSON.stringify(result), /00000000-|open.feishu.cn/)
  }
  await assert.rejects(sendFeishuNotify({}, { text: 'alert' }), /not_configured/)
})
