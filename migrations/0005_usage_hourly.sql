-- siiswell D1 schema, migration 0005: usage and API-equivalent cost per HOUR (additive).
--
-- The same row as usage_daily (0003), keyed by the host's LOCAL hour `YYYY-MM-DDTHH` (00-23, in the time zone the host
-- banks its days in; the repeated autumn hour is one bucket) instead of the day. NUMBERS AND LABELS ONLY, validated exactly
-- like the daily rows. Kept USAGE_HOURLY_RETENTION_DAYS (90) days; usage_daily stays the long-term record.
--
-- WITHOUT ROWID with `hour` FIRST: a day's 24 hours are one range seek (`hour BETWEEN 'D' || 'T00' AND 'D' || 'T23'`), and the
-- retention purge walks the oldest hours first. No secondary index.
--
-- DEPLOY: additive. A Worker without it ignores the optional `hourly` block of an upload; a Worker with it tolerates the table
-- missing (the hourly block is skipped and the answer says `hourly: "pending"`; GET /api/usage?group=hour answers `pending`).
CREATE TABLE usage_hourly (
  hour            TEXT NOT NULL,
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
  PRIMARY KEY (hour, host, project, agent, source, model)
) WITHOUT ROWID;
