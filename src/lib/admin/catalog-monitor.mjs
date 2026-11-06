/**
 * Keeps price and model catalogs current without a manual click:
 * - models.dev price snapshot (boot + daily);
 * - Claude ids from Anthropic `/v1/models` through a live OAuth slot;
 * - GPT ids from the ChatGPT Codex catalog through a Codex OAuth slot.
 * Results land in settings `model_catalog_sync` so the models page can show them.
 */
import path from 'node:path'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { getVm, listVms, vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { vmHasProxyPath } from '../oauth/credential-refresh-monitor.mjs'
import { seedModelCatalog } from '../protocol/models.mjs'
import { syncWorkerModelsIntoPolicy } from '../protocol/model-policy.mjs'
import { modelsDevMeta, syncModelsDev } from './price-catalog.mjs'
import { syncCodexCatalog } from './vm-test-chat.mjs'

export const CATALOG_SYNC_KEY = 'model_catalog_sync'
const MODELS_DEV_EVERY_MS = 24 * 3600_000
const UPSTREAM_EVERY_MS = 6 * 3600_000
export const GPT_CATALOG_EVERY_MS = UPSTREAM_EVERY_MS
const BOOT_DELAY_MS = 5_000
const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])
// Plan tiers see different model sets (Fable is Max-only); a few accounts cover the union.
const CLAUDE_ACCOUNTS_PER_SYNC = 3

export function readCatalogSync() {
  try {
    return new SettingsRepo().get(CATALOG_SYNC_KEY, null) || { claude: null, codex: null }
  } catch {
    return { claude: null, codex: null }
  }
}

function writeCatalogSync(platform, status) {
  const repo = new SettingsRepo()
  const cur = repo.get(CATALOG_SYNC_KEY, null) || { claude: null, codex: null }
  repo.set(CATALOG_SYNC_KEY, { ...cur, [platform]: status })
  return status
}

function syncStatus(status, { added = [], error = null } = {}) {
  return { at: new Date().toISOString(), status, added, error }
}

// listVms strips credentials; the exec needs the raw record's OAuth block.
function claudeCatalogTargets(projectRoot) {
  return listVms(projectRoot)
    .filter((vm) => vm?.id && !isCodexVm(vm) && !HARD_DOWN.has(String(vm.status || '').toLowerCase()))
    .map((vm) => getVm(projectRoot, vm.id))
    .filter((vm) => vm && vmHasClaudeCredential(vm) && vmHasProxyPath(vm))
}

/** Live Claude catalog → model_policy. */
export async function syncClaudeCatalog({ projectRoot, runOauth = runSlotOauth } = {}) {
  const targets = claudeCatalogTargets(projectRoot)
  if (!targets.length) return writeCatalogSync('claude', syncStatus('skipped', { error: 'no_claude_slot' }))
  const ids = new Set()
  let successes = 0
  let lastError = null
  for (const vm of targets) {
    if (successes >= CLAUDE_ACCOUNTS_PER_SYNC) break
    const exec = { vmId: vm.id, homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'), oauth: vm.claude, vm }
    const res = await runOauth(exec, 'models', { timeoutMs: 30_000 })
    const list = Array.isArray(res?.body?.data) ? res.body.data : null
    if (!res?.ok || !list) {
      lastError = res?.body?.error?.code || `http_${res?.status || 0}`
      continue
    }
    successes++
    for (const row of list) if (row?.id) ids.add(String(row.id))
  }
  if (!successes) return writeCatalogSync('claude', syncStatus('error', { error: lastError || 'models_failed' }))
  const { added } = syncWorkerModelsIntoPolicy([...ids], {
    displayNameOf: (id) => modelsDevMeta('anthropic', id)?.name,
  })
  seedModelCatalog()
  return writeCatalogSync('claude', syncStatus('ok', { added }))
}

/** Read-only by default, including the monitor and the model discovery button. */
export async function syncGptCatalog(opts = {}) {
  const result = await syncCodexCatalog({ ...opts, rotate: opts.rotate === true })
  const skipped = result.error === 'no_codex_slot' || result.error === 'proxy_required'
  const status = syncStatus(result.ok ? 'ok' : skipped ? 'skipped' : 'error', {
    added: result.added || [],
    error: result.ok ? null : result.error,
  })
  for (const key of [
    'synced',
    'catalog_version',
    'attempted_accounts',
    'successful_accounts',
    'failed_accounts',
    'partial',
  ]) {
    if (result[key] != null) status[key] = result[key]
  }
  status.interval_sec = GPT_CATALOG_EVERY_MS / 1000
  writeCatalogSync('codex', status)
  return result
}

/** Independent, single-flight jobs: a stalled Claude/price request never delays GPT discovery. */
export function createCatalogMonitor({
  projectRoot,
  codexCatalogVersion = () => 'auto',
  log = () => {},
  jobs = {},
  clock = { setTimeout, clearTimeout, setInterval, clearInterval },
} = {}) {
  const timers = []
  let running = false
  const guard = (name, fn) => {
    let inflight = null
    return () => {
      if (!running) return Promise.resolve()
      if (inflight) return inflight
      inflight = Promise.resolve()
        .then(() => (running ? fn() : undefined))
        .then((out) => {
          if (out) log({ event: 'catalog-sync', job: name, status: out.status ?? (out.ok === false ? 'error' : 'ok') })
          return out
        })
        .catch(() => {
          // Upstream errors are codes in sync status. Never log a raw request,
          // credential-bearing URL, or exception from a transport adapter.
          log({ event: 'catalog-sync', job: name, status: 'error', error: 'catalog_sync_failed' })
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    }
  }
  const modelsDev = guard('models.dev', jobs.modelsDev || (() => syncModelsDev()))
  const claude = guard('claude-catalog', jobs.claude || (() => syncClaudeCatalog({ projectRoot })))
  const gpt = guard(
    'gpt-catalog',
    jobs.gpt ||
      (() =>
        syncGptCatalog({
          projectRoot,
          catalogClientVersion: codexCatalogVersion(),
          rotate: false,
        })),
  )
  return {
    start() {
      if (running) return
      running = true
      const boot = clock.setTimeout(() => {
        if (!running) return
        void modelsDev()
        void claude()
        void gpt()
      }, BOOT_DELAY_MS)
      boot.unref?.()
      timers.push(boot)
      for (const [fn, ms] of [
        [modelsDev, MODELS_DEV_EVERY_MS],
        [claude, UPSTREAM_EVERY_MS],
        [gpt, GPT_CATALOG_EVERY_MS],
      ]) {
        const timer = clock.setInterval(() => void fn(), ms)
        timer.unref?.()
        timers.push(timer)
      }
    },
    stop() {
      running = false
      for (const timer of timers.splice(0)) {
        clock.clearTimeout(timer)
        clock.clearInterval(timer)
      }
    },
  }
}
