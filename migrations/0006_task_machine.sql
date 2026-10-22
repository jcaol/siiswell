-- siiswell D1 schema, migration 0006: the machine an MCP task was reported from (additive).
--
-- `machine` is an optional label (`[A-Za-z0-9._-]{1,64}`) that the siiswell stdio MCP server adds to report_task from its
-- config (`machine`, else the usage collector's `host` label), so the dashboard can group the tasks of several apps on one
-- machine (Claude Code, Codex, Claude Desktop, each with its own client token) under "machine / project". NULL for every
-- other task and for clients that do not send it.
--
-- DEPLOY: additive. The Worker that reads it falls back to the old statements while the column is missing (report_task
-- stores no machine, the state shows the client name as the group), so the Worker may be deployed before or after this.
ALTER TABLE tasks ADD COLUMN machine TEXT;
