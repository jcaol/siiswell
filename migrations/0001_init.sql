-- siiswell D1 schema, migration 0001.
-- Only summaries live here (<= 300 chars, redacted, see src/shared/redact.ts); retention is
-- ALERT_DEFAULTS.retentionDays (30) and is enforced by the cron purge.

-- BUDGET LOGIC MUST NOT DEPEND ON `meta.changes`. Every claim in src/budget.ts (MCP mutations, host writes,
-- critical halts, push slots, budget flags) is an `UPDATE/INSERT ... RETURNING <col>`: the claim succeeded
-- if and only if a row came back. D1 (and the local runtime) may count rows written by triggers or other
-- side effects in `changes`, so a future trigger on `sources` would otherwise make every request look over
-- budget (or none).
--
-- One row per bearer token. `host` tokens may call /api/ingest/*, `client` tokens /mcp.
-- Only the sha256 hex of the token is stored; revoke by setting revoked=1 or deleting the row.
-- For kind='host' the NAME IS THE HOST LABEL the token is bound to: ingest rejects (403) any payload
-- whose `host` differs, and every row written from it carries this name, never a payload value.
-- (Source names are unique across kinds, so a client can never share a host's label.)
-- mut_window_start / mut_count: the MCP mutation budget of a `client` token as an O(1) counter in a
-- FIXED 24 h window that starts at the first change after the previous window ended. A mutation is
-- claimed with one conditional UPDATE of this row (see src/budget.ts); when the budget is spent that
-- UPDATE reads this one row by primary key and writes nothing.
-- wr_window_start / wr_count: the same pattern for a `host` token's ingest write budget (estimated D1
-- row writes per fixed 24 h window).
-- hl_window_start / hl_count: a host's separate small budget for CRITICAL halt events, which are
-- accepted even when the write budget is spent (so a spent budget never silences an agent-stuck alert).
-- budget_until: set (once per window) the first time a request of this source is refused for budget;
-- until then the rules show a `budget-exhausted` alert (host: critical + pushed, client: inbox only).
-- eval_at: when a request of this source last RAN the rule evaluation. Ingest-triggered evaluations are throttled
-- to one per source per RULES_MIN_INTERVAL_MS (the cron evaluates every minute anyway): the stamp is set by the same
-- conditional UPDATE that claims the write budget, so the throttle costs no extra statement and no extra write.
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('host', 'client')),
  token_sha256  TEXT NOT NULL UNIQUE,
  created       INTEGER NOT NULL,
  last_seen     INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0,
  mut_window_start  INTEGER NOT NULL DEFAULT 0,
  mut_count         INTEGER NOT NULL DEFAULT 0,
  wr_window_start   INTEGER NOT NULL DEFAULT 0,
  wr_count          INTEGER NOT NULL DEFAULT 0,
  hl_window_start   INTEGER NOT NULL DEFAULT 0,
  hl_count          INTEGER NOT NULL DEFAULT 0,
  budget_until      INTEGER NOT NULL DEFAULT 0,
  eval_at           INTEGER NOT NULL DEFAULT 0
);

-- Tiny key/value store for facts the read API must show but only the rules know. Today: `rules_truncated`
-- (JSON array of the rule inputs whose scan hit its LIMIT in the last evaluation), written only when it changes.
CREATE TABLE meta (
  k       TEXT PRIMARY KEY,
  v       TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- Phone-push budgets, one row per BUDGET KEY. A push is charged to several keys at once and must fit all. The keys
-- are TYPED and ESCAPED (src/keys.ts): `<kind>|<part>|...` with kind own (a host label or MCP client name), rs (a
-- relayed foreign agent: host, sender), rt (all relay senders of a host together: senders are named by the host's own
-- payload, so they cannot be what bounds it), ct / ca (the host agent's own critical alerts of a host: exempt from the
-- ordinary budget, capped per host and hour and day, one per agent per 30 min) and all (everything one owner may push
-- per day, summaries included). No name can spell another kind's or another owner's key. `owner` is the host label /
-- client name that pays for the key, stored beside it and what the code trusts (the key is never parsed for it).
-- window_start / count: pushes in the current short window; day_start / day_count: the daily cap;
-- suppressed: alerts held back by the budget, summarised in ONE later push ("N more items via <key>").
-- touched: when the row was last created, ensured or claimed. Rows are created by the push that needs them; the cron
-- purges them (never claimed: after 1 h, idle: after 2 days, whatever they hold: after the retention period).
CREATE TABLE push_budget (
  k            TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,                     -- the host label / client name the key belongs to (its `all` total)
  window_start INTEGER NOT NULL DEFAULT 0,
  count        INTEGER NOT NULL DEFAULT 0,
  day_start    INTEGER NOT NULL DEFAULT 0,
  day_count    INTEGER NOT NULL DEFAULT 0,
  suppressed   INTEGER NOT NULL DEFAULT 0,
  window_ms    INTEGER NOT NULL DEFAULT 600000,   -- the key's limits, kept by every claim so the summary push
  per_window   INTEGER NOT NULL DEFAULT 3,        -- (which only knows the key) claims under the same rules
  day_cap      INTEGER NOT NULL DEFAULT 1000000000,
  touched      INTEGER NOT NULL DEFAULT 0
);

-- Latest ProjectSnapshot per (host, project), verbatim after server-side sanitising EXCEPT `tasks`: those
-- live in the tasks table, and the stored JSON is capped (32 KB) so that every rule evaluation and every
-- /api/state parse stays small. `fp` fingerprints the rule-relevant parts (agents, tasks, approvals) so an
-- unchanged snapshot is recognised without reading the tasks; `open_tasks` counts its running/blocked
-- host-agent tasks (the per-host cap is the sum over a host's projects).
CREATE TABLE snapshots (
  source_id    TEXT NOT NULL,
  host         TEXT NOT NULL,
  project      TEXT NOT NULL,
  json         TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  fp           TEXT NOT NULL DEFAULT '',
  open_tasks   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (host, project)
);

-- Liveness per host. Chosen over deriving "last seen" from snapshots.received_at because a
-- heartbeat carries no snapshot, and because the binary version belongs to the host.
CREATE TABLE hosts (
  host            TEXT PRIMARY KEY,
  source_id       TEXT,
  last_seen       INTEGER NOT NULL,
  binary_version  TEXT
);

-- Flattened task list.
--   host-agent tasks  key = host|project|task_id        (replaced wholesale by each snapshot)
--   relay origin     key = relay|host|project|who      (one row per foreign agent, from STATUS events)
--   mcp              key = mcp|<source name>|task_id   (task_id is generated by the Worker)
-- The host / source-name prefix of every key is token-bound (see sources), and the upserts only
-- overwrite a row of the same origin and host, so a sender cannot reach another source's row by choosing a key.
CREATE TABLE tasks (
  key        TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL,
  origin     TEXT NOT NULL,
  host       TEXT,
  project    TEXT,
  agent      TEXT,
  task_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL,
  eta_at     INTEGER,
  last_line  TEXT,
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);

-- Event keys are chosen by the sender (a chat event id, `halt:Agent02:123`, ...), so they are only
-- unique PER SOURCE: PRIMARY KEY (source_id, key). A global key would let one token pre-insert a
-- guessed key and make INSERT OR IGNORE silently drop another source's real event.
CREATE TABLE events (
  source_id    TEXT NOT NULL,
  key          TEXT NOT NULL,
  host         TEXT,
  project      TEXT,
  kind         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  agent        TEXT,
  scenario     TEXT,
  status       TEXT,
  severity     TEXT NOT NULL,
  text         TEXT NOT NULL,
  sender       TEXT,
  at           INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  PRIMARY KEY (source_id, key)
);


-- Alert key is deterministic (rule|host|project|agent-or-task|...), so re-evaluating the rules
-- is idempotent. resolved = epoch ms, NULL while open. `origin` is where the underlying task/event came
-- from (host-agent origin | relay origin | mcp): alerts of any other origin are labelled "via <host/client>" in
-- the inbox and in pushes so a desktop client cannot pass for a real host-agent alert.
-- A key that re-opens within 30 minutes of resolving keeps its push_count / last_pushed / summarized_at (same incident).
-- push_count counts the pushes that were really sent; an alert that only a budget SUMMARY push mentions has
-- summarized_at set instead (and push_count 0), so the two can be told apart.
CREATE TABLE alerts (
  key          TEXT PRIMARY KEY,
  rule         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  origin       TEXT NOT NULL DEFAULT 'host',
  host         TEXT,
  project      TEXT,
  agent        TEXT,
  text         TEXT NOT NULL,
  opened       INTEGER NOT NULL,
  last_pushed  INTEGER,
  push_count   INTEGER NOT NULL DEFAULT 0,
  resolved     INTEGER,
  summarized_at INTEGER,
  since        INTEGER      -- when the CONDITION began (a task's last update, an approval's request, a halt's time): the ranking of the
                            -- per-owner alert caps (the newest conditions win), kept so an alert that is open but no longer visible to the
                            -- scans can still be ranked against new ones; NULL = `opened`
);

CREATE TABLE push_subs (
  endpoint  TEXT PRIMARY KEY,
  p256dh    TEXT NOT NULL,
  auth      TEXT NOT NULL,
  created   INTEGER NOT NULL,
  last_ok   INTEGER
);

-- Indexes back every hot query (rule evaluation on each ingest + cron minute, /api/state polling,
-- ingest's per-host task replacement, the MCP per-client caps and the retention purge). Each one is
-- paid for on writes, so only queries that run constantly are covered; test/queries.test.ts checks the
-- plans with EXPLAIN QUERY PLAN.
CREATE INDEX idx_events_at          ON events (at);                       -- /api/state last 50, purge
CREATE INDEX idx_events_kind_at     ON events (kind, at);                 -- rules: recent halt events
CREATE INDEX idx_events_halt        ON events (host, at) WHERE kind = 'halt'; -- rules: newest halts PER HOST, a bounded seek each (a flood of one host cannot make another host's scan longer)
CREATE INDEX idx_tasks_updated      ON tasks (updated);                   -- purge
CREATE INDEX idx_tasks_state_updated ON tasks (state, updated);           -- rules (blocked/running), /api/state (open + recent closed)
CREATE INDEX idx_tasks_agent        ON tasks (origin, host, project, agent, created); -- snapshot replace, newest dispatch per agent
CREATE INDEX idx_tasks_source       ON tasks (source_id, origin, state);  -- MCP open-task cap (seeks the OPEN states only)
CREATE INDEX idx_alerts_resolved    ON alerts (resolved, opened);         -- purge (resolved before a date, open since before a date)
CREATE INDEX idx_alerts_host        ON alerts (host, resolved, opened);   -- rules + /api/state: the open alerts of ONE host, oldest/newest first, and its recently resolved ones: a bounded seek each (the alerts of one host cannot lengthen another host's scan)
CREATE INDEX idx_sources_budget     ON sources (budget_until) WHERE budget_until > 0;      -- rules: sources whose budget is spent
CREATE INDEX idx_push_budget_suppressed ON push_budget (suppressed) WHERE suppressed > 0; -- cron: keys owed a push summary
