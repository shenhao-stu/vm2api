import { getDb } from '../database.mjs'

export class RefusedSessionsRepo {
  constructor(db = getDb()) {
    this.any = db.prepare('SELECT 1 FROM refused_sessions LIMIT 1')
    this.lookup = db.prepare('SELECT 1 FROM refused_sessions WHERE digest IN (SELECT value FROM json_each(?)) LIMIT 1')
    this.insert = db.prepare('INSERT OR IGNORE INTO refused_sessions (digest) SELECT value FROM json_each(?)')
  }

  hasRecords() {
    return !!this.any.get()
  }

  matches(digests) {
    return digests.length > 0 && !!this.lookup.get(JSON.stringify(digests))
  }

  remember(digests) {
    this.insert.run(JSON.stringify(digests))
  }
}
