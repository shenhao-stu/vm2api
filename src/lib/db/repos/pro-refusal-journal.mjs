import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function syncDir(dir) {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// Only used when the primary SQLite transaction fails. No request content is written.
export class ProRefusalJournal {
  constructor(db) {
    const file = db
      .prepare('PRAGMA database_list')
      .all()
      .find((row) => row.name === 'main')?.file
    this.dir = file ? `${file}.pro-refusal-pending` : null
    this.files = new Map()
    if (!this.dir) return
    fs.mkdirSync(this.dir, { mode: 0o700, recursive: true })
    if (!fs.lstatSync(this.dir).isDirectory()) throw new Error('invalid Pro refusal journal directory')
    syncDir(path.dirname(this.dir))
    // A read-only state volume cannot promise isolation across a restart.
    const probe = path.join(this.dir, `.${randomUUID()}.tmp`)
    const fd = fs.openSync(probe, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, '1')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
      fs.unlinkSync(probe)
    }
  }

  *load() {
    if (!this.dir) return
    for (const name of fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'))) {
      const file = path.join(this.dir, name)
      if (!fs.lstatSync(file).isFile()) throw new Error('invalid Pro refusal journal file')
      const bytes = fs.readFileSync(file)
      if (name !== `${sha(bytes)}.json`) throw new Error('invalid Pro refusal journal digest')
      const { namespace, entries } = JSON.parse(bytes)
      if (
        !isDigest(namespace) ||
        !Array.isArray(entries) ||
        !entries.length ||
        entries.some(
          (e) =>
            !['session', 'context'].includes(e?.kind) ||
            !isDigest(e.digest) ||
            !Number.isSafeInteger(e.steps) ||
            e.steps < 0 ||
            (e.client && !isDigest(e.client)),
        )
      )
        throw new Error('invalid Pro refusal journal entry')
      this.track(namespace, file)
      yield { namespace, entries }
    }
  }

  track(namespace, file) {
    const files = this.files.get(namespace) ?? new Set()
    files.add(file)
    this.files.set(namespace, files)
  }

  save(namespace, entries) {
    if (!this.dir) return
    const data = JSON.stringify({ namespace, entries })
    const file = path.join(this.dir, `${sha(data)}.json`)
    const temp = path.join(this.dir, `.${randomUUID()}.tmp`)
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
    syncDir(this.dir)
    this.track(namespace, file)
  }

  clear(namespace) {
    const files = this.files.get(namespace)
    if (!files) return
    for (const file of files) fs.rmSync(file, { force: true })
    syncDir(this.dir)
    this.files.delete(namespace)
  }
}
