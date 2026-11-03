import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Kept for old automation. The gateway creates its encrypted registry and local
// controller credentials; this check never creates a second plaintext registry.
export function initClash({ dataDir, binary = process.env.VM2API_MIHOMO_BIN } = {}) {
  if (!dataDir) throw new Error('A data directory is required')
  if (fs.existsSync(path.join(dataDir, 'clash', 'subscriptions.json')))
    throw new Error(
      'Legacy sidecar state detected. Follow docs/CLASH.md migration before starting the unified runtime.',
    )
  if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary))
    throw new Error('Set VM2API_MIHOMO_BIN to the installed Mihomo executable; Docker images include it.')
  return { created: false, managed: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initClash({ dataDir: process.env.KIN_DATA_DIR || path.resolve('data') })
  console.log('Unified subscription runtime ready; no sidecar configuration created.')
}
