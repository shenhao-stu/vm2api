import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { SubscriptionError, isPublicAddress } from './subscription-network.mjs'

export function renderSubscriptionConfig(nodes, { controller, secret }) {
  const proxies = nodes.map((node) => {
    const config = structuredClone(node.config)
    if (!isPublicAddress(node.address)) throw new SubscriptionError('subscription_blocked')
    if ((config.tls || ['trojan', 'hysteria2', 'tuic'].includes(config.type)) && !config.sni && !config.servername) {
      config[['vless', 'vmess'].includes(config.type) ? 'servername' : 'sni'] = config.server
    }
    if (config.network === 'ws') {
      config['ws-opts'] = { ...config['ws-opts'], headers: { Host: config.server, ...config['ws-opts']?.headers } }
    }
    return { ...config, name: node.id, server: node.address }
  })
  return {
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'skip-auth-prefixes': [],
    mode: 'rule',
    'log-level': 'silent',
    ipv6: true,
    'find-process-mode': 'off',
    'external-controller': controller,
    secret,
    'external-controller-cors': { 'allow-origins': [], 'allow-private-network': false },
    'geo-auto-update': false,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: { enable: false },
    proxies,
    listeners: nodes.map((node) => ({
      name: node.id,
      type: 'socks',
      listen: '127.0.0.1',
      port: node.listenPort,
      udp: true,
      users: [{ username: node.username, password: node.password }],
      proxy: node.id,
    })),
    rules: ['MATCH,REJECT'],
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function listenerAuthenticates(node) {
  return new Promise((resolve) => {
    const socket = net.connect(node.listenPort, '127.0.0.1')
    let phase = 0,
      pending = Buffer.alloc(0),
      done = false
    const finish = (ok) => {
      if (!done) {
        done = true
        socket.destroy()
        resolve(ok)
      }
    }
    socket.setTimeout(800)
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 2])))
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length < 2) return
      if (phase === 0) {
        if (pending[0] !== 5 || pending[1] !== 2) return finish(false)
        phase = 1
        pending = Buffer.alloc(0)
        const user = Buffer.from(node.username),
          password = Buffer.from(node.password)
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]))
      } else finish(pending[0] === 1 && pending[1] === 0)
    })
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    socket.on('close', () => finish(false))
  })
}

export class SubscriptionRuntime {
  constructor({ binary, dir }) {
    this.binary = binary
    this.dir = dir
    this.secret = crypto.randomBytes(32).toString('hex')
    this.controller = ''
    this.child = null
    this.ready = false
  }

  status() {
    return { available: !!this.binary && fs.existsSync(this.binary), running: this.ready && !!this.child }
  }

  prepare() {
    if (!this.binary || !path.isAbsolute(this.binary)) throw new SubscriptionError('subscription_runtime')
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(this.dir).isDirectory() || fs.lstatSync(this.dir).isSymbolicLink())
      throw new SubscriptionError('subscription_storage')
    fs.chmodSync(this.dir, 0o700)
  }

  writeConfig(nodes) {
    const file = path.join(this.dir, `runtime-${crypto.randomBytes(8).toString('hex')}.json`)
    const config = renderSubscriptionConfig(nodes, {
      controller: this.controller || '127.0.0.1:1',
      secret: this.secret,
    })
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
    return file
  }

  async validate(nodes) {
    try {
      this.prepare()
      const file = this.writeConfig(nodes)
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(this.binary, ['-t', '-d', this.dir, '-f', file], {
            env: { HOME: this.dir, GOMEMLIMIT: '256MiB' },
            stdio: 'ignore',
          })
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new SubscriptionError('subscription_runtime'))
          }, 15000)
          child.once('error', () => {
            clearTimeout(timer)
            reject(new SubscriptionError('subscription_runtime'))
          })
          child.once('exit', (code) => {
            clearTimeout(timer)
            code === 0 ? resolve() : reject(new SubscriptionError())
          })
        })
      } finally {
        fs.rmSync(file, { force: true })
      }
    } catch (error) {
      throw error instanceof SubscriptionError ? error : new SubscriptionError('subscription_runtime')
    }
  }

  request(method, route, payload) {
    return new Promise((resolve, reject) => {
      const body = payload ? JSON.stringify(payload) : ''
      const req = http.request(
        `http://${this.controller}${route}`,
        {
          method,
          agent: false,
          timeout: 4000,
          headers: {
            Authorization: `Bearer ${this.secret}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume()
          res.once('error', () => reject(new SubscriptionError('subscription_runtime')))
          res.once('aborted', () => reject(new SubscriptionError('subscription_runtime')))
          res.once('end', () =>
            res.statusCode >= 200 && res.statusCode < 300
              ? resolve()
              : reject(new SubscriptionError('subscription_runtime')),
          )
        },
      )
      req.on('error', () => reject(new SubscriptionError('subscription_runtime')))
      req.on('timeout', () => req.destroy())
      req.end(body)
    })
  }

  async apply(nodes) {
    this.prepare()
    if (!this.controller) this.controller = `127.0.0.1:${await freePort()}`
    await this.validate(nodes)
    try {
      if (this.child) {
        const payload = JSON.stringify(
          renderSubscriptionConfig(nodes, { controller: this.controller, secret: this.secret }),
        )
        await this.request('PUT', '/configs?force=true', { payload })
      } else {
        const file = this.writeConfig(nodes)
        const child = spawn(this.binary, ['-d', this.dir, '-f', file], {
          env: { HOME: this.dir, GOMEMLIMIT: '256MiB' },
          stdio: 'ignore',
        })
        this.child = child
        const exited = () => {
          if (this.child === child) {
            this.child = null
            this.ready = false
          }
          fs.rmSync(file, { force: true })
        }
        child.once('error', exited)
        child.once('exit', exited)
      }
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        if (!this.child) throw new SubscriptionError('subscription_runtime')
        try {
          await this.request('GET', '/version')
          let valid = true
          for (let start = 0; start < nodes.length; start += 16) {
            const results = await Promise.all(nodes.slice(start, start + 16).map(listenerAuthenticates))
            if (results.some((ok) => !ok)) {
              valid = false
              break
            }
          }
          if (valid) {
            this.ready = true
            return
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new SubscriptionError('subscription_runtime')
    } catch {
      await this.close()
      throw new SubscriptionError('subscription_runtime')
    }
  }

  async close() {
    this.ready = false
    const child = this.child
    this.child = null
    if (!child) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
