import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchSubscription,
  subscriptionSources,
  resolvePublicHost,
  SubscriptionError,
} from '../../src/lib/vm/subscription-network.mjs'

const path = '/use/unsafe/sub.php?t=signed%2Bpayload&s=private-signature'
const primary = `https://equaldcdn.com${path}`
const backup = `https://ipequal.com${path}`
const failure = (code = 'subscription_fetch') => new SubscriptionError(code)

test('only approved HTTPS subscription origins share an unchanged signed query', () => {
  assert.deepEqual(subscriptionSources(backup), [primary, backup])
  assert.deepEqual(subscriptionSources(primary), [primary, backup])
  for (const url of [
    'https://other.example' + path,
    'https://ipequal.com.evil.example' + path,
    'http://ipequal.com' + path,
    'https://ipequal.com:8443' + path,
    'https://ipequal.com/other',
  ]) {
    assert.deepEqual(subscriptionSources(url), [url])
  }
  assert.throws(() => subscriptionSources('https://user:secret@ipequal.com' + path))
})

test('healthy primary performs one download even when stored source is backup', async () => {
  const calls = []
  const body = await fetchSubscription(backup, {
    fetcher: async (url) => {
      calls.push(url)
      return 'valid'
    },
  })
  assert.equal(body, 'valid')
  assert.deepEqual(calls, [primary])
})

test('primary transport failure uses exactly the approved backup', async () => {
  const calls = []
  const body = await fetchSubscription(primary, {
    fetcher: async (url) => {
      calls.push(url)
      if (url === primary) throw failure()
      return 'backup'
    },
  })
  assert.equal(body, 'backup')
  assert.deepEqual(calls, [primary, backup])
})

test('HTTP 200 invalid subscription falls back before caller can commit it', async () => {
  const calls = []
  const body = await fetchSubscription(primary, {
    fetcher: async (url) => {
      calls.push(url)
      return url === primary ? '<html>error</html>' : 'nodes'
    },
    validate: (body) => {
      if (body !== 'nodes') throw failure('subscription_invalid')
    },
  })
  assert.equal(body, 'nodes')
  assert.equal(calls.length, 2)
})

test('security and size rejections do not become mirror retries', async () => {
  for (const code of ['subscription_blocked', 'subscription_limit']) {
    let calls = 0
    await assert.rejects(
      fetchSubscription(primary, {
        fetcher: async () => {
          calls++
          throw failure(code)
        },
      }),
      (e) => e.code === code,
    )
    assert.equal(calls, 1)
  }
})

test('DNS transport errors can fall back; private addresses remain blocked', async () => {
  await assert.rejects(
    resolvePublicHost('ipequal.com', async () => {
      throw Error('ENOTFOUND')
    }),
    (e) => e.code === 'subscription_fetch',
  )
  await assert.rejects(
    resolvePublicHost('ipequal.com', async () => [{ address: '127.0.0.1', family: 4 }]),
    (e) => e.code === 'subscription_blocked',
  )
})

test('both unavailable fails closed with redacted error and bounded attempts', async () => {
  let calls = 0
  await assert.rejects(
    fetchSubscription(primary, {
      fetcher: async () => {
        calls++
        throw Error(primary)
      },
    }),
    (e) => e.code === 'subscription_fetch' && !e.message.includes('private-signature'),
  )
  assert.equal(calls, 2)
})

test('a stalled primary leaves time for the alternate; no third attempt', async () => {
  const calls = []
  const body = await fetchSubscription(primary, {
    timeoutMs: 100,
    fetcher: async (url) => {
      calls.push(url)
      if (url === primary) return new Promise(() => {})
      return 'backup'
    },
  })
  assert.equal(body, 'backup')
  assert.deepEqual(calls, [primary, backup])
})
