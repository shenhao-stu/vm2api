import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { maintainFableResets } from './maintenance.mjs'

const base = new URL(process.env.VM2API_PANEL_URL || 'http://127.0.0.1:18787/api/panel')
if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('loopback_only')
const token = process.env.VM2API_PANEL_KEY_FILE
  ? (await fs.readFile(process.env.VM2API_PANEL_KEY_FILE, 'utf8')).trim()
  : process.env.VM2API_API_KEY
if (!token) throw Error('panel_auth_missing')
const file = process.env.VM2API_FABLE_RESET_STATE
if (!file || !path.isAbsolute(file)) throw Error('state_path_required')
await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
if (process.env.VM2API_FABLE_RESET_LOCKED !== file) {
  const child = spawnSync('flock', ['-n', `${file}.lock`, process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, VM2API_FABLE_RESET_LOCKED: file },
  })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}
{
  let state = {}
  try { state = JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('invalid_state')
  const save = async (value) => {
    const handle = await fs.open(`${file}.new`, 'w', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await fs.rename(`${file}.new`, file)
  }
  const api = async (method, route, body, headers = {}) => {
    const response = await fetch(base.href.replace(/\/$/, '') + route, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      ...(body == null ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) })
    const result = await response.json()
    if (!response.ok) throw Object.assign(Error('panel_request_failed'), { code: result.error?.code || `panel_http_${response.status}` })
    if (result.ok === false) throw Object.assign(Error('panel_rejected'), { code: result.error?.code || 'panel_rejected' })
    return result.data ?? result
  }
  const reports = await maintainFableResets({ api, state, save, enabled: process.env.VM2API_FABLE_AUTO_RESET === '1' })
  console.log(JSON.stringify({ at: new Date().toISOString(), reports }))
  if (reports.some(r => ['error', 'blocked'].includes(r.action))) process.exitCode = 1
}
