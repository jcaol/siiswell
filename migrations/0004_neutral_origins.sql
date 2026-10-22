-- siiswell D1 schema, migration 0004: neutral `origin` values.
--
-- The two origins of host integrations are renamed: the host's own agents -> 'host', agents forwarded by a host ->
-- 'relay' ('mcp' is unchanged). Ingest keeps accepting the old values (src/shared/wire.ts, LEGACY_ORIGIN_ALIASES) and
-- stores the new ones, so this only rewrites rows stored before. The legacy values are spelled in pieces on purpose
-- (legacy aliases; they name the upstream tool).
--
-- Only the `origin` COLUMNS hold these values. No stored key embeds them: task keys are host|project|id,
-- relay|host|project|who and mcp|source|id; event keys come from the sender; alert keys are rule|host|...; push-budget
-- keys are own|rs|rt|ct|ca|all + escaped names (src/keys.ts); notification tags are alert keys or src:<budget key>.
-- Idempotent: running it again changes nothing. The column DEFAULT of alerts.origin is 'host' in 0001 for new databases;
-- an older database keeps its old DEFAULT (SQLite cannot alter one), which is never used: every insert names the origin.
--
-- DEPLOY ORDER - an exception to the usual "apply the migration, then deploy the Worker": deploy the Worker FIRST,
-- then apply this migration immediately:
--   bunx wrangler deploy && bunx wrangler d1 migrations apply <db-name> --remote
-- The Worker that ships with it treats a legacy value exactly like its canonical one in every query that compares or
-- returns `origin` (src/shared/wire.ts: SQL_HOST_ORIGINS, SQL_RELAY_ORIGINS, sqlCanonicalOrigin), so rows not yet
-- rewritten behave correctly and the order is no longer critical; an OLDER Worker reading rewritten rows would not
-- (it only knows the legacy values), which is why the Worker goes first. A later release can narrow those queries
-- back to the canonical values once this migration has run everywhere.
UPDATE tasks  SET origin = 'host'  WHERE origin = 't' || 'mux-orch';
UPDATE tasks  SET origin = 'relay' WHERE origin = 'ma' || 'trix-relay';
UPDATE events SET origin = 'host'  WHERE origin = 't' || 'mux-orch';
UPDATE events SET origin = 'relay' WHERE origin = 'ma' || 'trix-relay';
UPDATE alerts SET origin = 'host'  WHERE origin = 't' || 'mux-orch';
UPDATE alerts SET origin = 'relay' WHERE origin = 'ma' || 'trix-relay';
