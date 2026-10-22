-- siiswell D1 schema, migration 0009: OTLP retries are not counted twice (additive).
--
-- otlp_seen: one row per OTLP data point already added to the usage tables, keyed by a hash of (host, metric, attributes,
-- start time, time) so an exporter that retries the same export (at-least-once delivery) adds nothing the second time. Kept
-- OTLP_SEEN_TTL_MS (2 days: an exporter retries for minutes, not days); the OTLP request itself deletes expired rows.
--
-- DEPLOY: additive, only used while OTLP_INGEST=1. A Worker with OTLP on but without this table answers 503.
CREATE TABLE otlp_seen (
  k   TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_otlp_seen_at ON otlp_seen (at);
