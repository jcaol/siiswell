-- siiswell D1 schema, migration 0010: report_task is idempotent for clients that send a client_ref (additive).
--
-- tasks.client_ref: an optional random key chosen by the client (the siiswell hook writes it to its state BEFORE it sends).
-- A retried report_task with the same ref returns the task already created instead of a second one. Unique per source;
-- NULL for every task reported without one (MCP agents), which the partial index ignores.
--
-- DEPLOY: additive. A Worker without this column stores the task without the ref (no dedupe, as before).
ALTER TABLE tasks ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX idx_tasks_client_ref ON tasks (source_id, client_ref) WHERE client_ref IS NOT NULL;
