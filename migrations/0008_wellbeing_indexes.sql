-- siiswell D1 schema, migration 0008: an index for the well-being plan-limit read (additive, no data change).
--
-- idx_snapshots_received: the plan-limit indicator reads the snapshots received in the last 6 hours (`received_at >= ?`):
-- a range seek instead of a scan of every host's / project's snapshot.
-- (The open-alert count, `resolved IS NULL AND rule IN (...)`, already seeks idx_alerts_resolved from migration 0001; a
-- second, partial index would only cost writes. test/wellbeing-indexes.test.ts checks both plans.)
--
-- DEPLOY: additive, any order; a Worker without it runs the same query, only as a scan.
CREATE INDEX IF NOT EXISTS idx_snapshots_received ON snapshots (received_at);
