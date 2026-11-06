import { getDb, withTransaction } from '../database.mjs'
import { ProRefusalJournal } from './pro-refusal-journal.mjs'

const entryKey = (e) => `${e.kind}/${e.digest}/${e.client || ''}`
export class ProSessionQuarantineRepo {
  constructor(db = getDb()) {
    this.db = db
    this.unsaved = new Map()
    this.retryAt = new Map()
    this.notDurable = new Set()
    this.find = db.prepare(
      "SELECT 1 FROM pro_session_quarantines WHERE namespace=? AND kind=? AND digest=? AND (client=? OR client='' OR ?='') LIMIT 1",
    )
    this.lengths = db.prepare(
      "SELECT DISTINCT steps FROM pro_session_quarantines WHERE namespace=? AND kind='context' AND steps<=?",
    )
    this.insert = db.prepare(
      'INSERT INTO pro_session_quarantines(namespace, kind, digest, client, steps) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
    this.journal = new ProRefusalJournal(db)
    for (const { namespace, entries } of this.journal.load()) this.retain(namespace, entries)
  }

  retain(namespace, entries) {
    const pending = this.unsaved.get(namespace) ?? new Map()
    for (const entry of entries) pending.set(entryKey(entry), entry)
    this.unsaved.set(namespace, pending)
    return pending
  }

  checkWrites(namespace) {
    for (const failed of this.notDurable) this.retryPending(failed)
    if (this.notDurable.size) throw new Error('Pro refusal persistence unavailable')
    this.retryPending(namespace)
  }

  has(namespace, kind, digest, client = '') {
    this.checkWrites(namespace)
    for (const entry of this.unsaved.get(namespace)?.values() ?? []) {
      if (entry.kind === kind && entry.digest === digest && (!entry.client || !client || entry.client === client))
        return true
    }
    return Boolean(this.find.get(namespace, kind, digest, client, client))
  }

  contextLengths(namespace, maximum) {
    this.checkWrites(namespace)
    const lengths = this.lengths.all(namespace, maximum).map((row) => row.steps)
    for (const entry of this.unsaved.get(namespace)?.values() ?? []) {
      if (entry.kind === 'context' && entry.steps <= maximum) lengths.push(entry.steps)
    }
    return lengths
  }

  remember(namespace, entries) {
    const pending = this.retain(namespace, entries)
    try {
      withTransaction(this.db, () => {
        for (const { kind, digest, client = '', steps } of pending.values())
          this.insert.run(namespace, kind, digest, client, steps)
      })
    } catch {
      this.retryAt.set(namespace, Date.now() + 1000)
      try {
        this.journal.save(
          namespace,
          entries.length && !this.notDurable.has(namespace) ? entries : [...pending.values()],
        )
        this.notDurable.delete(namespace)
      } catch {
        this.notDurable.add(namespace)
        console.error('[pro-session-quarantine] both stores unavailable; admission suspended')
      }
      return
    }
    this.unsaved.delete(namespace)
    this.retryAt.delete(namespace)
    this.notDurable.delete(namespace)
    try {
      this.journal.clear(namespace)
    } catch {
      console.error('[pro-session-quarantine] committed journal retained for idempotent recovery')
    }
  }

  retryPending(namespace) {
    if (this.unsaved.has(namespace) && !(Date.now() < this.retryAt.get(namespace))) this.remember(namespace, [])
  }
}

let cached
export function defaultProSessionQuarantines() {
  const db = getDb()
  if (cached?.db !== db) cached = new ProSessionQuarantineRepo(db)
  return cached
}
