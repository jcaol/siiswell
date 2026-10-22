-- siiswell D1 schema, migration 0011: the operator's own input, per source and hour (additive).
--
-- human_hourly: counts the siiswell hooks on a user's machine upload in batches (POST /api/ingest/human, client token):
-- prompts the user sent, permission prompts the user approved, how many of those came < 30 s after the previous one
-- ("rapid") and in how many distinct minutes that happened ("rapid_min"), and the median response time from a "waiting for you" notification to the next prompt / approval.
-- Numbers and the hour only: no text of any kind. One row per (source, UTC hour start in epoch ms); a re-upload of the
-- same hour replaces it. Kept 90 days: like wb_metrics, a trigger on each new hour's insert removes up to 50 older rows
-- (no extra statement in the purge).
--
-- DEPLOY: additive. A Worker without it answers the upload with 503; the You line then shows "no data".
CREATE TABLE human_hourly (
  source_id   TEXT    NOT NULL,
  hour        INTEGER NOT NULL,
  prompts     INTEGER NOT NULL DEFAULT 0,
  approvals   INTEGER NOT NULL DEFAULT 0,
  rapid       INTEGER NOT NULL DEFAULT 0,
  rapid_min   INTEGER NOT NULL DEFAULT 0,
  lat_n       INTEGER NOT NULL DEFAULT 0,
  lat_p50_ms  INTEGER,
  updated     INTEGER NOT NULL,
  PRIMARY KEY (source_id, hour)
) WITHOUT ROWID;
CREATE INDEX idx_human_hourly_hour ON human_hourly (hour);
CREATE TRIGGER human_hourly_retention AFTER INSERT ON human_hourly
BEGIN
  DELETE FROM human_hourly WHERE (source_id, hour) IN (SELECT source_id, hour FROM human_hourly WHERE hour < NEW.updated - 7776000000 ORDER BY hour LIMIT 50);
END;
