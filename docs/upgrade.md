# Upgrading

Migrations are additive and applied in order with `bunx wrangler d1 migrations apply <db-name> --remote` (Cloudflare)
or automatically at start (Docker). Deploy the new server first, then apply the migrations, unless a section below says
otherwise. Check with `bunx wrangler d1 migrations list <db-name> --remote` (nothing pending). `<db-name>` is the
`database_name` in `wrangler.toml` (see [deploy.md](deploy.md)).

**Agent workspaces (CLI 0.5.4).** The hooks and `siiswell mcp` now recognise agent workspaces only by a
`.siiswell-agents` file in the project root (or `SIISWELL_AGENT=1`). On a machine where an agent orchestrator runs
agents in `<project>/worktrees/...`, add the file to each such project **before** updating the CLI, then run
`scripts/setup-client.sh --reuse` so the agent rule gets the new wording. Without the marker, those agents' prompts
count as your own input and their tasks are reported twice.

**Docker:** `git pull && docker compose up -d --build`. The server applies new migrations itself when it starts; there is
nothing else to run. Clients: `siiswell update` on each computer.

Configs and state from earlier versions keep working: the CLI, `siiswell mcp` and the hooks read them as before.
Clients update themselves with `siiswell update` (see [CLIENTS.md](../CLIENTS.md#updating-the-cli)). The stdio bridge
is `bridge/siiswell-bridge.mjs`; a client config that starts the bridge by its file path needs that path (or switch it
to `siiswell mcp`, which reads the same `SIISWELL_URL` / `SIISWELL_TOKEN`).

## The well-being layer (migration 0007)

Additive, any order: `bunx wrangler d1 migrations apply <db-name> --remote` applies `0007_wellbeing.sql` (tables
`wb_settings` and `wb_metrics` with its retention trigger, `alerts.wb_digested`, `idx_alerts_opened`). A Worker without the
migration shows the You card with defaults ("not set up yet") and pushes as before; once it is applied, the push policy is
on with the defaults (the dashboard's `DASHBOARD_TZ`, default UTC; quiet 23:00-07:00; digest every 30 min). Set `WELLBEING_PUSH_POLICY = "0"` in
`wrangler.toml` [vars] to keep the old one-push-per-alert behaviour. The re-push back-off of `approval-waiting` (15 -> 30 -> 60 -> 120 min,
5 pushes) applies either way.


## The "You" line (migration 0011)

Additive: `human_hourly` holds the hourly counts of the operator's own input that the Claude Code hooks upload
(`POST /api/ingest/human`, client token). Deploy the server, then apply the migration; until then uploads get 503 and the
stress card shows "Agents" only. Clients need the new CLI (re-run `scripts/setup-client.sh` or copy `cli/dist/siiswell.mjs`).

## Time zone (DASHBOARD_TZ)

The server shows its days in `DASHBOARD_TZ` (an IANA name, default `UTC`); the well-being layer uses it until a zone
is saved on the page, and usage uploads that name no zone are taken to be in it. Older releases assumed
`Europe/London`: an installation whose usage was bucketed in that zone sets `DASHBOARD_TZ = "Europe/London"` in
`wrangler.toml` `[vars]` (or the environment of the Docker server) BEFORE deploying this release.

## Client defaults

**Task project names.** Installs from before 0.2.x (their usage bank predates the privacy defaults) keep their task
project names: `siiswell mcp` and the hooks still fill in the folder name under the configured roots, as before. Set
`usage.projectNames` to `"hashed"` or `"other"` to hide them; `siiswell doctor` prints a reminder until you do.

The CLI's `usage.roots` default is now "none" (every working directory counts) and its usage time zone defaults to the
system's. A machine that already collected usage keeps the earlier defaults (its bank says so), so its history does not
move; set `usage.roots` / `usage.tz` explicitly to change them.
