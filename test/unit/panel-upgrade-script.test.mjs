import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = path.resolve(import.meta.dirname, '../../scripts/panel-upgrade.sh')

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
args.push('--compose-file-env', process.env.COMPOSE_FILE || '')
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\n')
if (args[0] === 'compose') {
  if (args.includes('build') && process.env.FAIL_BUILD === '1') process.exit(1)
  if (args.includes('up') && process.env.STALE_BACKEND !== '1') {
    fs.writeFileSync(process.env.BOOT_VERSION, 'v1.2.7')
  }
} else if (args[0] === 'inspect') {
  console.log(process.env.SAME_CONTAINER === '1' ? 'old-id' : 'new-id')
} else if (args[0] === 'exec') {
  const cmd = args.slice(3)
  if (cmd.some((part) => String(part).includes('fleet-services.mjs'))) {
    if (args[2] === 'node') fs.writeFileSync(process.env.FLEET_MARKER, 'updated')
    process.exit(0)
  }
  const result = spawnSync(process.execPath, cmd, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else { process.exit(2) }
`

async function runUpgrade({ source = true, arch = 'amd64', override, env = {}, readOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-upgrade space-'))
  const bin = path.join(root, 'fake-bin')
  const log = path.join(root, 'calls.jsonl')
  const bootVersion = path.join(root, 'boot-version')
  const fleetMarker = path.join(root, 'fleet-marker')
  const apiCalls = []
  const slot = () => {
    const upgraded = fs.readFileSync(bootVersion, 'utf8') === 'v1.2.7'
    const stopped =
      (upgraded && env.STOPPED_SLOT === '1') || (fs.existsSync(fleetMarker) && env.STOPPED_AFTER_REFRESH === '1')
    return {
      id: 'vm-01',
      status: stopped ? 'stopped' : 'running',
      proxy_id: upgraded && env.PROXY_CHANGED === '1' ? 'px-other' : 'px-one',
      max_concurrency: upgraded && env.CONCURRENCY_CHANGED === '1' ? 2 : 1,
      schedulable: env.MANUALLY_DISABLED_SLOT !== '1' && !(upgraded && env.DISABLED_SLOT === '1'),
    }
  }
  const server = http.createServer((req, res) => {
    apiCalls.push({ method: req.method, path: req.url })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') {
      res.end('{"status":"ok"}')
    } else if (req.url === '/api/panel/version' && req.headers.authorization === 'Bearer test-key') {
      res.end(JSON.stringify({ ok: true, data: { current_tag: fs.readFileSync(bootVersion, 'utf8') } }))
    } else if (req.url === '/api/panel/proxy-exit-guard' && req.headers.authorization === 'Bearer test-key') {
      const upgraded = fs.readFileSync(bootVersion, 'utf8') === 'v1.2.7'
      const blocked = upgraded && env.GUARD_LATCHED === '1'
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            required: !(upgraded && env.GUARD_DISABLED === '1'),
            proxies: [
              {
                id: 'px-one',
                expected_ip: '203.0.113.10',
                revision: 'approved-policy',
                state: {
                  expected_ip: '203.0.113.10',
                  observed_ip: upgraded && env.GUARD_MISMATCH === '1' ? '203.0.113.11' : '203.0.113.10',
                  revision: 'approved-policy',
                  ready: !blocked,
                  latched: blocked,
                  checked_at: upgraded && env.GUARD_STALE === '1' ? '2020-01-01T00:00:00Z' : new Date().toISOString(),
                },
              },
            ],
          },
        }),
      )
    } else if (req.url === '/api/panel/vms' && req.headers.authorization === 'Bearer test-key') {
      res.end(
        JSON.stringify({
          ok: true,
          data:
            env.LEGACY_SLOT_LIST === '1'
              ? [slot()]
              : {
                  items:
                    env.NO_SLOTS === '1' ? [] : [slot(), { id: 'retired-slot', status: 'stopped', schedulable: false }],
                },
        }),
      )
    } else if (req.url === '/api/panel/vms/vm-01' && req.headers.authorization === 'Bearer test-key') {
      const upgraded = fs.readFileSync(bootVersion, 'utf8') === 'v1.2.7'
      const broken = env.PREEXISTING_SLOT_FAILURE === '1' || (upgraded && env.BROKEN_SLOT === '1')
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            vm: slot(),
            kernel: {
              rust_health: {
                status: broken ? 401 : 200,
                process_up: !broken,
                healthy: true,
                reachable: !broken && env.BUSY_SLOT !== '1',
                ready_slots: env.BUSY_SLOT === '1' ? 0 : 20,
              },
            },
          },
        }),
      )
    } else {
      res.writeHead(401).end('{}')
    }
  })
  try {
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
    fs.writeFileSync(
      path.join(bin, 'git'),
      '#!/usr/bin/env node\n' +
        'if (process.argv[2] === "checkout") ' +
        'require("node:fs").writeFileSync("src/config/routing.json", "release defaults\\n")\n',
      { mode: 0o755 },
    )
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(root, 'VERSION'), '1.2.6\n')
    fs.writeFileSync(bootVersion, 'v1.2.6')
    fs.writeFileSync(path.join(root, '.env'), 'VM2API_ADMIN_PASSWORD=keep-me\nVM2API_IMAGE_TAG=v1.2.6\n')
    fs.mkdirSync(path.join(root, 'src/config'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/config/routing.json'), 'operator config\n')
    if (source) fs.mkdirSync(path.join(root, '.git'))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    let args = [
      script,
      root,
      'custom-stack',
      'custom-control',
      'old-id',
      'v1.2.7',
      arch,
      path.join(root, 'docker-compose.yml'),
      path.join(root, override || 'docker-compose.override.yml'),
    ]
    if (readOnly) {
      const capture = await exec('sh', [script, '--snapshot-slots', 'custom-control'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_LOG: log,
          BOOT_VERSION: bootVersion,
          FLEET_MARKER: fleetMarker,
          PORT: String(server.address().port),
          VM2API_API_KEY: 'test-key',
          ...env,
        },
        timeout: 20000,
      })
      const baseline = path.join(root, 'slots-before.json')
      fs.writeFileSync(baseline, capture.stdout)
      fs.writeFileSync(bootVersion, 'v1.2.7')
      args = [script, '--verify-slots', 'custom-control', baseline]
    }
    let result
    try {
      result = {
        ...(await exec('sh', args, {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TEST_LOG: log,
            BOOT_VERSION: bootVersion,
            FLEET_MARKER: fleetMarker,
            PORT: String(server.address().port),
            VM2API_API_KEY: 'test-key',
            ...env,
          },
          timeout: 20000,
        })),
        code: 0,
      }
    } catch (error) {
      result = { code: error.code, stderr: error.stderr, stdout: error.stdout }
    }
    return {
      ...result,
      apiCalls,
      root,
      calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
      env: fs.readFileSync(path.join(root, '.env'), 'utf8'),
      version: fs.readFileSync(path.join(root, 'VERSION'), 'utf8'),
      routing: fs.readFileSync(path.join(root, 'src/config/routing.json'), 'utf8'),
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('source upgrade builds the backend, preserves overrides, recreates it, and verifies its HTTP version', async () => {
  const result = await runUpgrade()
  assert.equal(result.code, 0, result.stderr)
  const build = result.calls.find((args) => args.includes('build'))
  assert.match(
    build.at(-1),
    new RegExp(`${result.root}/docker-compose.override.yml:${result.root}/docker-compose.build.yml`),
  )
  assert.ok(build.includes('--project-name'))
  assert.ok(build.includes('custom-stack'))
  const up = result.calls.find((args) => args.includes('up'))
  assert.ok(up.includes('--force-recreate'))
  assert.ok(up.includes('--no-deps'))
  assert.ok(up.includes('vm2api'))
  assert.ok(result.calls.some((args) => args[0] === 'exec'))
  assert.match(result.stdout, /restarted and verified at v1\.2\.7/)
  assert.match(result.env, /VM2API_ADMIN_PASSWORD=keep-me/)
  assert.equal(result.routing, 'operator config\n', 'release checkout must preserve live routing config')
})

test('failed backend build never replaces the running control plane', async () => {
  const result = await runUpgrade({ env: { FAIL_BUILD: '1' } })
  assert.equal(result.code, 1)
  assert.ok(!result.calls.some((args) => args.includes('up')))
})

test('unchanged container ID cannot be reported as a successful restart', async () => {
  const result = await runUpgrade({ env: { SAME_CONTAINER: '1' } })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /did not replace/)
  assert.ok(!result.calls.some((args) => args[0] === 'exec' && args.includes('verify')))
})

test('a healthy but stale backend is an upgrade failure', async () => {
  const result = await runUpgrade({ source: false, env: { STALE_BACKEND: '1' } })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /did not become healthy at v1\.2\.7/)
  assert.equal(result.version, '1.2.6\n', 'do not advance the host VERSION on failure')
})

test('a new backend version with broken kernel auth cannot report upgrade success', async () => {
  const result = await runUpgrade({ source: false, env: { BROKEN_SLOT: '1' } })
  assert.equal(result.code, 1)
  assert.match(result.stdout, /Recording healthy slot kernels before upgrade: \[\{"id":"vm-01"/)
  assert.match(result.stderr, /Previously healthy slot vm-01 failed kernel verification/)
  assert.equal(result.version, '1.2.6\n')
})

test('busy but healthy kernels survive upgrade verification', async () => {
  const result = await runUpgrade({ env: { BUSY_SLOT: '1' } })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Previously healthy slot kernels verified: \[\{"id":"vm-01"/)
})

test('legacy array slot lists are still verified during updates', async () => {
  const result = await runUpgrade({ env: { LEGACY_SLOT_LIST: '1', BROKEN_SLOT: '1' } })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Previously healthy slot vm-01 failed kernel verification/)
})

test('empty installations and already unhealthy slots do not become false upgrade regressions', async () => {
  for (const env of [{ NO_SLOTS: '1' }, { PREEXISTING_SLOT_FAILURE: '1' }]) {
    const result = await runUpgrade({ env })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Recording healthy slot kernels before upgrade: \[\]/)
  }
})

test('image upgrade pulls the pinned ARM64 release and records VERSION only after verification', async () => {
  const result = await runUpgrade({ source: false, arch: 'arm64' })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.env, /VM2API_IMAGE_TAG=v1\.2\.7-arm64/)
  assert.match(result.env, /VM2API_ADMIN_PASSWORD=keep-me/)
  assert.ok(result.calls.some((args) => args.includes('pull')))
  assert.ok(!result.calls.some((args) => args.includes('build')))
  assert.equal(result.version, '1.2.7\n')
})

test('ARM64 source upgrade keeps the native override and rejects a missing one before building', async () => {
  const result = await runUpgrade({ arch: 'arm64', override: 'docker-compose.arm64.yml' })
  assert.equal(result.code, 0, result.stderr)
  const build = result.calls.find((args) => args.includes('build'))
  assert.match(build.at(-1), new RegExp(`${result.root}/docker-compose.arm64.yml`))
  assert.doesNotMatch(build.at(-1), /docker-compose\.build\.yml/)
  const missing = await runUpgrade({ arch: 'arm64' })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /lacks docker-compose.arm64.yml/)
  assert.ok(!missing.calls.some((args) => args[0] === 'compose'))
})

test('healthy kernels with a stopped slot cannot report upgrade success', async () => {
  const result = await runUpgrade({ source: false, env: { STOPPED_SLOT: '1' } })
  assert.equal(result.code, 1, result.stdout)
  assert.match(result.stderr, /not running/)
  assert.equal(result.version, '1.2.6\n')
  assert.ok(
    result.apiCalls.every((call) => call.method === 'GET'),
    'verification must not start or rearm',
  )
})

test('previously schedulable slots must still be schedulable', async () => {
  const result = await runUpgrade({ env: { DISABLED_SLOT: '1' } })
  assert.equal(result.code, 1, result.stdout)
  assert.match(result.stderr, /not schedulable/)
})

test('manual scheduling disable is preserved without becoming an upgrade regression', async () => {
  const result = await runUpgrade({ env: { MANUALLY_DISABLED_SLOT: '1' } })
  assert.equal(result.code, 0, result.stderr)
  assert.ok(result.apiCalls.every((call) => call.method === 'GET'))
})

test('service refresh must be followed by another state verification before publishing VERSION', async () => {
  const result = await runUpgrade({ source: false, env: { STOPPED_AFTER_REFRESH: '1' } })
  assert.equal(result.code, 1, result.stdout)
  assert.match(result.stderr, /not running/)
  assert.equal(result.version, '1.2.6\n')
})

test('changed proxy, concurrency or a latched exit fail without any recovery mutation', async () => {
  for (const env of [{ PROXY_CHANGED: '1' }, { CONCURRENCY_CHANGED: '1' }, { GUARD_LATCHED: '1' }]) {
    const result = await runUpgrade({ source: false, env })
    assert.equal(result.code, 1, result.stdout)
    assert.equal(result.version, '1.2.6\n')
    assert.ok(result.apiCalls.every((call) => call.method === 'GET'))
  }
})

test('standalone snapshot and verify modes are read-only and exclude retired slots', async () => {
  const good = await runUpgrade({ readOnly: true })
  assert.equal(good.code, 0, good.stderr)
  assert.ok(good.calls.every((call) => call[0] === 'exec'))
  assert.ok(good.apiCalls.every((call) => call.method === 'GET' && !call.path.includes('retired-slot')))
  const stopped = await runUpgrade({ readOnly: true, env: { STOPPED_SLOT: '1' } })
  assert.equal(stopped.code, 1)
  assert.match(stopped.stderr, /not running/)
  assert.ok(stopped.calls.every((call) => call[0] === 'exec'))
})

test('standalone verification fails closed for a changed IP, stale evidence or disabled guard', async () => {
  for (const env of [{ GUARD_MISMATCH: '1' }, { GUARD_STALE: '1' }, { GUARD_DISABLED: '1' }]) {
    const result = await runUpgrade({ readOnly: true, env })
    assert.equal(result.code, 1, result.stdout)
    assert.match(result.stderr, /guard/)
    assert.ok(result.apiCalls.every((call) => call.method === 'GET'))
    assert.ok(result.calls.every((call) => call[0] === 'exec'))
  }
})
