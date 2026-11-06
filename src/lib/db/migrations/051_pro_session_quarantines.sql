-- Only hashes of the authenticated namespace, session or refused conversation are retained.
CREATE TABLE pro_session_quarantines (
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('session', 'context')),
  digest TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  steps INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(namespace, kind, digest, client)
) WITHOUT ROWID;
CREATE INDEX pro_quarantine_lengths ON pro_session_quarantines(namespace, kind, steps);
