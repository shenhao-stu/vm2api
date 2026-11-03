import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseSubscription } from './subscription-parse.mjs'
import { SubscriptionRuntime, renderSubscriptionConfig } from './subscription-runtime.mjs'
import { subscriptionPortRange } from './instance-scope.mjs'
import {
  fetchSubscription,
  resolvePublicHost,
  sourceUrl,
  SubscriptionError,
  withDeadline,
} from './subscription-network.mjs'

const MAX_NODES = 512
export const SUBSCRIPTION_REFRESH_MINUTES = 360
const scheduleAt = (now, minutes) => new Date(now + minutes * 60000).toISOString()
function refreshMinutes(value = SUBSCRIPTION_REFRESH_MINUTES) {
  if (!Number.isInteger(value) || value < 15 || value > 10080) throw new SubscriptionError()
  return value
}
function refreshPolicy(input, previous, hasUrl, now) {
  if (input.auto_refresh !== undefined && typeof input.auto_refresh !== 'boolean') throw new SubscriptionError()
  const interval = refreshMinutes(input.refresh_interval_minutes ?? previous?.refresh_interval_minutes)
  const automatic = input.auto_refresh ?? (hasUrl && (previous?.auto_refresh ?? !previous))
  if (automatic && !hasUrl) throw new SubscriptionError()
  return {
    auto_refresh: !!automatic,
    refresh_interval_minutes: interval,
    next_refresh_at: automatic ? scheduleAt(now, interval) : null,
  }
}
const runtimeConfig = (nodes) => renderSubscriptionConfig(nodes, { controller: '127.0.0.1:1', secret: 'comparison' })
const emptyState = (range) => ({ version: 1, nextPort: range.first, profiles: [], nodes: [] })
const bound = (pool, id) => (pool?.snapshot().proxies.find((proxy) => proxy.id === id)?.bound_vm_ids || []).length > 0

export function reconcileSubscription(
  state,
  profile,
  parsed,
  { isBound, credentials, portRange = subscriptionPortRange() },
) {
  const next = structuredClone(state)
  const old = state.nodes.filter((node) => node.profileId === profile.id)
  const hashes = new Set(parsed.map((node) => node.hash))
  const retained = old
    .filter((node) => !hashes.has(node.hash) && isBound(node.proxyId))
    .map((node) => ({ ...node, retained: true }))
  const current = parsed.map((node) => {
    const previous = old.find((saved) => saved.hash === node.hash)
    if (previous) return { ...previous, ...node, retained: false }
    if (next.nextPort < portRange.first || next.nextPort > portRange.last)
      throw new SubscriptionError('subscription_limit')
    const id = `${profile.id}-${node.hash.slice(0, 16)}`
    return {
      ...node,
      id,
      profileId: profile.id,
      listenPort: next.nextPort++,
      ...credentials(id),
      proxyId: null,
      retained: false,
    }
  })
  next.nodes = [...state.nodes.filter((node) => node.profileId !== profile.id), ...current, ...retained]
  next.profiles = [...state.profiles.filter((item) => item.id !== profile.id), profile]
  if (next.nodes.length > MAX_NODES) throw new SubscriptionError('subscription_limit')
  return next
}

export class ProxySubscriptions {
  constructor({
    dataDir,
    proxyPool,
    binary = process.env.VM2API_MIHOMO_BIN || '',
    runtime,
    fetcher = fetchSubscription,
    resolver = resolvePublicHost,
    operationTimeoutMs = 45000,
    portRange = subscriptionPortRange(),
    now = Date.now,
  }) {
    this.now = now
    this.timer = null
    this.dueRunning = false
    this.portRange = Object.freeze({ ...portRange })
    this.dir = path.join(dataDir, 'subscriptions')
    this.legacyStateFile = path.join(dataDir, 'clash', 'subscriptions.json')
    this.keyFile = process.env.VM2API_SUBSCRIPTION_KEY_FILE || path.join(this.dir, 'key')
    this.file = path.join(this.dir, 'state.enc')
    this.pool = proxyPool
    this.fetcher = fetcher
    this.resolver = resolver
    this.operationTimeoutMs = operationTimeoutMs
    this.runtime = runtime || new SubscriptionRuntime({ binary, dir: path.join(this.dir, 'runtime') })
    this.state = emptyState(this.portRange)
    this.key = null
    this.busy = false
    this.error = null
    this.loaded = false
  }

  prepareStorage() {
    if (fs.existsSync(this.legacyStateFile)) throw new SubscriptionError('subscription_storage')
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(this.dir).isDirectory() || fs.lstatSync(this.dir).isSymbolicLink())
      throw new SubscriptionError('subscription_storage')
    fs.chmodSync(this.dir, 0o700)
    if (!fs.existsSync(this.keyFile)) {
      if (fs.existsSync(this.file)) throw new SubscriptionError('subscription_storage')
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' })
    }
    const stat = fs.lstatSync(this.keyFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new SubscriptionError('subscription_storage')
    this.key = fs.readFileSync(this.keyFile)
    if (this.key.length !== 32) throw new SubscriptionError('subscription_storage')
  }

  load() {
    this.prepareStorage()
    if (!fs.existsSync(this.file)) {
      if (this.pool.managedProxyIds?.size) throw new SubscriptionError('subscription_storage')
      return emptyState(this.portRange)
    }
    const encrypted = fs.readFileSync(this.file)
    if (encrypted.length < 28 || encrypted.length > 8 * 1024 * 1024) throw new SubscriptionError('subscription_storage')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, 12))
    decipher.setAAD(Buffer.from('vm2api-proxy-subscriptions-v1'))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    const state = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString())
    if (
      state.version !== 1 ||
      !Array.isArray(state.nodes) ||
      !Array.isArray(state.profiles) ||
      state.nodes.length > MAX_NODES ||
      !Number.isInteger(state.nextPort) ||
      state.nextPort < this.portRange.first ||
      state.nextPort > this.portRange.last + 1 ||
      state.nodes.some(
        (node) =>
          !Number.isInteger(node.listenPort) ||
          node.listenPort < this.portRange.first ||
          node.listenPort > this.portRange.last,
      ) ||
      new Set(state.nodes.map((node) => node.listenPort)).size !== state.nodes.length
    )
      throw new SubscriptionError('subscription_storage')
    return state
  }

  save(state) {
    const plain = Buffer.from(JSON.stringify(state))
    if (plain.length > 8 * 1024 * 1024) throw new SubscriptionError('subscription_limit')
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from('vm2api-proxy-subscriptions-v1'))
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const file = path.join(this.dir, `state-${crypto.randomBytes(8).toString('hex')}.tmp`)
    try {
      fs.writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' })
      fs.renameSync(file, this.file)
    } finally {
      fs.rmSync(file, { force: true })
    }
  }

  syncPool(state) {
    const snapshot = this.pool.snapshot().proxies
    const entries = state.nodes
      .filter((node) => !snapshot.some((proxy) => proxy.id === node.proxyId))
      .map((node) => ({ host: '127.0.0.1', port: node.listenPort, username: node.username, password: node.password }))
    if (entries.length) this.pool.importLines('', { fields: entries })
    const proxies = this.pool.snapshot().proxies
    for (const node of state.nodes) {
      const proxy = proxies.find((item) => item.host === '127.0.0.1' && item.port === node.listenPort)
      const full = proxy && this.pool.getProxyByIdWithAuth(proxy.id)
      if (!full || full.username !== node.username || full.password !== node.password)
        throw new SubscriptionError('subscription_storage')
      node.proxyId = proxy.id
    }
    this.pool.managedProxyIds = new Set([
      ...this.pool.state.proxies
        .filter((proxy) => /^vm2api-sub-[a-f0-9]{16}-[a-f0-9]{16}$/.test(proxy.username || ''))
        .map((proxy) => proxy.id),
      ...state.nodes.map((node) => node.proxyId),
    ])
    this.pool.subscriptionLabels = new Map(state.nodes.map((node) => [node.proxyId, node.name]))
  }

  async start() {
    this.loaded = false
    try {
      this.state = this.load()
      this.loaded = true
      this.syncPool(this.state)
    } catch {
      await this.runtime.close()
      throw new SubscriptionError('subscription_storage')
    }
    try {
      if (this.state.nodes.length) {
        await this.runtime.apply(this.state.nodes)
        this.save(this.state)
      }
      this.error = null
    } catch {
      this.error = 'subscription_runtime'
      await this.runtime.close()
    }
    return this.view()
  }

  view() {
    return {
      runtime: this.runtime.status(),
      error: this.error,
      busy: this.busy,
      profiles: this.state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        source: profile.source,
        updated_at: profile.updatedAt,
        auto_refresh: profile.auto_refresh === true,
        refresh_interval_minutes: profile.refresh_interval_minutes ?? SUBSCRIPTION_REFRESH_MINUTES,
        last_attempt_at: profile.last_attempt_at ?? null,
        last_success_at: profile.last_success_at ?? null,
        next_refresh_at: profile.next_refresh_at ?? null,
        last_error: profile.last_error ?? null,
        node_count: this.state.nodes.filter((node) => node.profileId === profile.id && !node.retained).length,
        retained_count: this.state.nodes.filter((node) => node.profileId === profile.id && node.retained).length,
      })),
      nodes: this.state.nodes.map((node) => ({
        id: node.id,
        profile_id: node.profileId,
        proxy_id: node.proxyId,
        name: node.name,
        type: node.type,
        retained: node.retained,
      })),
    }
  }

  async mutate(action) {
    if (this.busy) throw new SubscriptionError('subscription_busy')
    if (!this.runtime.status().available) throw new SubscriptionError('subscription_runtime')
    this.busy = true
    try {
      if (!this.loaded) {
        this.state = this.load()
        this.loaded = true
      }
      const next = await withDeadline(action(), this.operationTimeoutMs, 'subscription_fetch')
      const previous = this.state
      const unchanged =
        this.runtime.status().running && isDeepStrictEqual(runtimeConfig(previous.nodes), runtimeConfig(next.nodes))
      if (!unchanged) await this.runtime.validate(next.nodes)
      const poolBefore = structuredClone(this.pool.state)
      try {
        if (!unchanged) await this.runtime.apply(next.nodes)
        this.syncPool(next)
        const removed = previous.nodes.filter((node) => !next.nodes.some((item) => item.id === node.id))
        for (const node of removed) {
          if (bound(this.pool, node.proxyId)) throw new SubscriptionError('subscription_bound')
          this.pool.remove(node.proxyId)
        }
        this.save(next)
        this.state = next
        this.error = null
      } catch (error) {
        this.pool.state = poolBefore
        try {
          this.pool.save()
          this.syncPool(previous)
          await this.runtime.apply(previous.nodes)
        } catch {
          await this.runtime.close()
          this.error = 'subscription_runtime'
        }
        throw error
      }
      return this.view()
    } catch (error) {
      throw error instanceof SubscriptionError ? error : new SubscriptionError('subscription_storage')
    } finally {
      this.busy = false
    }
  }

  async import(input = {}, { protectBound = false } = {}) {
    return this.mutate(async () => {
      if (input.id && !this.state.profiles.some((item) => item.id === input.id))
        throw new SubscriptionError('subscription_not_found')
      const existing = this.state.profiles.find((item) => item.id === input.id)
      const name = String(input.name ?? existing?.name ?? '代理订阅').trim()
      if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new SubscriptionError()
      const hasSource = input.url !== undefined || input.content !== undefined
      const url = hasSource ? input.url : existing?.url
      const text = hasSource ? input.content : existing?.content
      if ((!url && !text) || (url && text)) throw new SubscriptionError()
      if (url) sourceUrl(url)
      const policy = refreshPolicy(input, existing, !!url, this.now())
      const nodes = parseSubscription(url ? await this.fetcher(url) : text)
      const hosts = new Map()
      const uniqueHosts = [...new Set(nodes.map((node) => node.config.server))]
      for (let start = 0; start < uniqueHosts.length; start += 8) {
        await Promise.all(
          uniqueHosts.slice(start, start + 8).map(async (host) => {
            const addresses = await this.resolver(host)
            hosts.set(host, addresses[0])
          }),
        )
      }
      const profile = {
        id: existing?.id || `sub-${crypto.randomBytes(8).toString('hex')}`,
        name,
        source: url ? 'url' : 'text',
        ...(url ? { url } : { content: text }),
        updatedAt: new Date(this.now()).toISOString(),
        ...policy,
        last_attempt_at: new Date(this.now()).toISOString(),
        last_success_at: new Date(this.now()).toISOString(),
        last_error: null,
      }
      // A saved-source refresh cannot replace even a pinned public address of a bound route.
      if (protectBound && existing) {
        for (const old of this.state.nodes.filter(
          (node) => node.profileId === existing.id && bound(this.pool, node.proxyId),
        )) {
          const next = nodes.find((node) => node.hash === old.hash)
          if (!next || hosts.get(next.config.server) !== old.address)
            throw new SubscriptionError('subscription_bound_changed')
        }
      }
      return reconcileSubscription(
        this.state,
        profile,
        nodes.map((node) => ({ ...node, address: hosts.get(node.config.server) })),
        {
          isBound: (id) => bound(this.pool, id),
          portRange: this.portRange,
          credentials: (id) => ({
            username: `vm2api-${id}`,
            password: crypto.createHmac('sha256', this.key).update(id).digest('hex'),
          }),
        },
      )
    })
  }

  async remove(id) {
    return this.mutate(async () => {
      if (!this.state.profiles.some((item) => item.id === id)) throw new SubscriptionError('subscription_not_found')
      if (this.state.nodes.some((node) => node.profileId === id && bound(this.pool, node.proxyId)))
        throw new SubscriptionError('subscription_bound')
      return {
        ...structuredClone(this.state),
        profiles: this.state.profiles.filter((item) => item.id !== id),
        nodes: this.state.nodes.filter((node) => node.profileId !== id),
      }
    })
  }

  configure(id, input = {}) {
    if (this.busy) throw new SubscriptionError('subscription_busy')
    const previous = this.state.profiles.find((profile) => profile.id === id)
    if (!previous) throw new SubscriptionError('subscription_not_found')
    const profile = { ...previous, ...refreshPolicy(input, previous, !!previous.url, this.now()) }
    const next = { ...this.state, profiles: this.state.profiles.map((item) => (item.id === id ? profile : item)) }
    this.save(next)
    this.state = next
    return this.view()
  }

  async refresh(id) {
    if (this.busy) throw new SubscriptionError('subscription_busy')
    const previous = this.state.profiles.find((profile) => profile.id === id)
    if (!previous) throw new SubscriptionError('subscription_not_found')
    try {
      return await this.import({ id }, { protectBound: true })
    } catch (error) {
      const code = error.code === 'subscription_bound_changed' ? error.code : 'subscription_refresh_failed'
      const profile = {
        ...previous,
        last_attempt_at: new Date(this.now()).toISOString(),
        last_error: code,
        next_refresh_at: previous.auto_refresh ? scheduleAt(this.now(), 15) : null,
      }
      const next = { ...this.state, profiles: this.state.profiles.map((item) => (item.id === id ? profile : item)) }
      this.save(next)
      this.state = next
      throw new SubscriptionError(code)
    }
  }

  startScheduler() {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runDue().catch(() => {})
    }, 60000)
    this.timer.unref?.()
    void this.runDue().catch(() => {})
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runDue() {
    if (this.dueRunning || this.busy || !this.loaded || !this.runtime.status().available) return
    this.dueRunning = true
    try {
      const due = this.state.profiles.filter(
        (profile) =>
          profile.url &&
          profile.auto_refresh &&
          (!profile.next_refresh_at || Date.parse(profile.next_refresh_at) <= this.now()),
      )
      for (const profile of due) {
        if (this.busy) break
        await this.refresh(profile.id).catch(() => {})
      }
    } finally {
      this.dueRunning = false
    }
  }

  async close() {
    this.stopScheduler()
    await this.runtime.close()
  }
}
