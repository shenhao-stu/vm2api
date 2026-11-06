import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCatalogMonitor, GPT_CATALOG_EVERY_MS } from '../../src/lib/admin/catalog-monitor.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function fakeClock() {
  const timers = []
  const add = (kind, fn, ms) => {
    const timer = { kind, fn, ms, cleared: false, unref() {} }
    timers.push(timer)
    return timer
  }
  return {
    timers,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (timer) => {
      timer.cleared = true
    },
    clearInterval: (timer) => {
      timer.cleared = true
    },
  }
}

test('GPT discovery runs independently at boot and every six hours without overlap', async (t) => {
  const clock = fakeClock()
  const calls = { gpt: 0, claude: 0, modelsDev: 0 }
  let finishGpt
  const gptGate = new Promise((resolve) => {
    finishGpt = resolve
  })
  const monitor = createCatalogMonitor({
    clock,
    jobs: {
      modelsDev: () => {
        calls.modelsDev++
        return new Promise(() => {})
      },
      claude: () => {
        calls.claude++
        return new Promise(() => {})
      },
      gpt: () => {
        calls.gpt++
        return calls.gpt === 1 ? gptGate : { ok: true }
      },
    },
  })
  t.after(() => monitor.stop())
  monitor.start()
  monitor.start()
  assert.equal(clock.timers.length, 4)
  assert.deepEqual(
    clock.timers
      .filter((timer) => timer.kind === 'interval')
      .map((timer) => timer.ms)
      .sort((a, b) => a - b),
    [21600000, 21600000, 86400000],
  )
  clock.timers.find((timer) => timer.kind === 'timeout').fn()
  await flush()
  assert.deepEqual(calls, { gpt: 1, claude: 1, modelsDev: 1 })
  const gptTick = clock.timers.findLast((timer) => timer.ms === GPT_CATALOG_EVERY_MS)
  gptTick.fn()
  await flush()
  assert.equal(calls.gpt, 1)
  finishGpt({ ok: true })
  await flush()
  gptTick.fn()
  await flush()
  assert.equal(calls.gpt, 2)
  monitor.stop()
  assert.ok(clock.timers.every((timer) => timer.cleared))
  gptTick.fn()
  await flush()
  assert.equal(calls.gpt, 2)
})

test('stopping before boot prevents every follow-up and exceptions log only safe codes', async () => {
  const clock = fakeClock()
  let calls = 0
  const logs = []
  const monitor = createCatalogMonitor({
    clock,
    log: (entry) => logs.push(entry),
    jobs: {
      modelsDev: () => {
        calls++
        return { ok: true }
      },
      claude: () => {
        calls++
        return { ok: true }
      },
      gpt: () => {
        calls++
        throw new Error('secret-transport-detail')
      },
    },
  })
  monitor.start()
  monitor.stop()
  clock.timers[0].fn()
  await flush()
  assert.equal(calls, 0)
  monitor.start()
  clock.timers.findLast((timer) => timer.ms === GPT_CATALOG_EVERY_MS).fn()
  await flush()
  monitor.stop()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].status, 'error')
  assert.equal(logs[0].error, 'catalog_sync_failed')
  assert.ok(!JSON.stringify(logs).includes('secret-transport-detail'))
})
