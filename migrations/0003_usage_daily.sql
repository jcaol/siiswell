-- siiswell D1 schema, migration 0003: usage and API-equivalent cost per day.
--
-- One row per (day, host, project, agent, source, model): tokens, requests and the API-equivalent dollars (what the
-- tokens would cost at the vendors' public API prices; NULL = the model has no known price). NUMBERS AND LABELS ONLY:
-- no free text is stored here (every label is validated against a strict character set at ingest). A host pushes the
-- last two days after every rollup and its whole history once; the upsert is idempotent and only writes a row that changed.
--
-- WITHOUT ROWID with `day` FIRST: the page reads a day range (a seek) and the retention purge deletes the oldest days
-- (`(day, host, ...) IN (SELECT ... WHERE day < ? LIMIT ?)`, the same form project_seen uses): no secondary index, so a row costs one write.
-- Apply this migration BEFORE deploying the Worker that reads it:
--   bunx wrangler d1 migrations apply <db-name> --remote
-- (a Worker deployed earlier answers /api/ingest/usage with 503 until the table exists, and the purge tolerates its absence).
CREATE TABLE usage_daily (
  day             TEXT NOT NULL,
  host            TEXT NOT NULL,
  project         TEXT NOT NULL,
  agent           TEXT NOT NULL,
  source          TEXT NOT NULL,
  model           TEXT NOT NULL,
  input           INTEGER NOT NULL,
  output          INTEGER NOT NULL,
  cache_read      INTEGER NOT NULL,
  cache_write_5m  INTEGER NOT NULL,
  cache_write_1h  INTEGER NOT NULL,
  requests        INTEGER NOT NULL,
  usd             REAL,
  updated         INTEGER NOT NULL,
  PRIMARY KEY (day, host, project, agent, source, model)
) WITHOUT ROWID;

-- One row per host that ever pushed usage: when it last did (`pushed_at`: freshness of the page's figures even when no
-- number changed), the time zone its days are in, whether its WHOLE history arrived (`has_full`: the answer
-- `needFull` tells the pusher to send it), and the host's own daily row-write allowance (a fixed 24 h window, counted
-- in rows: usage has its own budget so a full-history upload cannot starve snapshots, and vice versa).
CREATE TABLE usage_hosts (
  host          TEXT PRIMARY KEY,
  pushed_at     INTEGER NOT NULL,
  generated_at  INTEGER NOT NULL,
  tz            TEXT NOT NULL,
  has_full      INTEGER NOT NULL DEFAULT 0,
  win_start     INTEGER NOT NULL DEFAULT 0,
  win_count     INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
