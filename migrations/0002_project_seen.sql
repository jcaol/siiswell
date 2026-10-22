-- siiswell D1 schema, migration 0002: per-project liveness.
--
-- `hosts.last_seen` says the HOST is alive. One project's reporter can die while the others on the same host keep
-- sending, so each (host, project) also records when anything (snapshot, heartbeat, events) last arrived for it.
-- That is what the `project-offline` rule and the "reporter offline" mark in the page read.
--
-- Rows are only ever created for a project the host already has a snapshot for (heartbeats and events use an
-- EXISTS guard), so the table is bounded by the per-host project limit (MAX_PROJECTS_PER_HOST) and cannot be grown with
-- invented project names. Writes are throttled per row (PROJECT_SEEN_WRITE_FLOOR_MS). The cron purge removes rows
-- older than the retention period. Apply this migration BEFORE deploying the Worker that reads it:
--   bunx wrangler d1 migrations apply <db-name> --remote
-- (the Worker treats a missing table as "no per-project data" and keeps working, but nothing is recorded until it exists).
CREATE TABLE project_seen (
  host       TEXT NOT NULL,
  project    TEXT NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (host, project)
) WITHOUT ROWID;

-- The rules read the SILENT projects (oldest first) and the purge deletes the old ones: both walk this index.
CREATE INDEX idx_project_seen_last ON project_seen (last_seen);
