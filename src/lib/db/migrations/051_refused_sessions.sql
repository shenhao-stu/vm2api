-- No prompt, account identifier or raw session ID is retained.
CREATE TABLE IF NOT EXISTS refused_sessions (
  digest TEXT PRIMARY KEY NOT NULL
) WITHOUT ROWID;
