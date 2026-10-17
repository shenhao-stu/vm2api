#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

const version = 'v1.19.32'
const assets = {
  amd64: ['linux-amd64-compatible', 'ba3ce607747a07f948fc35780e108a4a7c7f552a38b9bd4d115f313ebcb89c20'],
  arm64: ['linux-arm64', '9dd862e28b46ff7d775f169cceebc28deccaa0a9e804237d421cd2571e0caba0'],
}
const [destination, arch = 'amd64'] = process.argv.slice(2)
if (!destination || !assets[arch]) throw new Error('usage: fetch-mihomo.mjs DEST [amd64|arm64]')
const [asset, expected] = assets[arch]
const url = `https://github.com/MetaCubeX/mihomo/releases/download/${version}/mihomo-${asset}-${version}.gz`
const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
if (!response.ok) throw new Error(`Mihomo download failed: HTTP ${response.status}`)
const archive = Buffer.from(await response.arrayBuffer())
if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Mihomo checksum mismatch')
const binary = gunzipSync(archive, { maxOutputLength: 100 * 1024 * 1024 })
await mkdir(path.dirname(path.resolve(destination)), { recursive: true })
await writeFile(`${destination}.download`, binary, { mode: 0o755 })
await rename(`${destination}.download`, destination)
console.log(`Mihomo ${version} ${arch}: checksum verified`)
