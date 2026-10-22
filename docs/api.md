# Client API (wire contract v1)

The endpoints that agents and tools write to: **MCP task reporting** (`/mcp`) and the **usage collector**
(`/api/ingest/usage`). A lower-level host integration API for scripts and tools is in the appendix. The machine-readable version is
[`openapi.yaml`](openapi.yaml); the source of truth for field names is `src/shared/schema.ts` (MCP tool inputs and
the host integration API) and `src/usage.ts` (usage rows). The browser API (`/api/state`, `/api/usage`,
`/api/push/*`) is not part of this document.

**Compatibility:** v1 is frozen. Fields can be added but are never renamed or removed. Every body carries `"v": 1`,
and a server that adds a v2 keeps accepting v1.

## Authentication

`Authorization: Bearer oct_<43 base64url characters>`. The server refuses any other token shape before it looks the
token up.

| Token kind | May call | Shown on the dashboard as |
|---|---|---|
| `host` | `/api/ingest/usage` and the host integration API (`/api/ingest/{heartbeat,snapshot,events}`) | the token's **name** is the host label; every body's `host` must equal it |
| `client` | `/mcp` | `<agent>@<client name>`, and alerts end with ` · via <client name>` |

A token of the wrong kind gets **403**. A missing, malformed, unknown or revoked token gets **401** with
`WWW-Authenticate: Bearer`. Tokens are minted by the operator (`bun scripts/new-token.ts <name> host|client`) and
shown once.

Rules for any client implementation:

- Use `https://`. The official clients allow plain `http://` only for `localhost` / `127.0.0.1`.
- Never follow a redirect with the token attached: treat any 3xx as an error.
- Send no secrets in free text. The server scrubs and clips every text field (links are cut down to scheme and host,
  secret-looking values become `[redacted]`), and the official clients apply the same function
  (`src/shared/redact.ts`) before sending.

## Endpoints

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | `{"ok":true,"version":"..."}`: liveness and server version, no data |
| `POST /mcp` | client | MCP (Streamable HTTP, stateless, JSON responses): `report_task`, `update_task`, `heartbeat`, `list_tasks`, `operator_status` |
| `POST /api/ingest/usage` | host | Daily usage rows (`UsageUpload`), or `{v:1, host, mode:"erase"}` |
| `POST /api/ingest/{heartbeat,snapshot,events}` | host | Host integration API (advanced): see the appendix |
| `POST /api/ingest/otlp` | host | Optional, off unless the server sets `OTLP_INGEST=1`: Claude Code's OTLP/HTTP JSON metrics (`claude_code.token.usage`, `claude_code.cost.usage`, delta only) into the hourly usage; see [otel.md](otel.md) |

### MCP tools

| Tool | Arguments | Result text |
|---|---|---|
| `report_task` | `project` (`[A-Za-z0-9._-]{1,64}`), `title` (at most 120 characters), `kind` (one of `coding`, `debugging`, `testing`, `review`, `research`, `docs`, `deploy`, `ops`, `other`; an unknown word is stored as `other`), `status` (`IN_PROGRESS` / `BLOCKED` / `DONE`), `eta_min?` (1 to 10080), `summary?` (at most 300 characters), `agent?` (`[A-Za-z0-9._=/-]{1,31}`), `machine?` (`[A-Za-z0-9._-]{1,64}`), `client_ref?` (`[A-Za-z0-9_-]{16,64}`: a retry with the same value returns the task already created) | `{"task_id":"m-...","state":"running"}` |
| `update_task` | `task_id`, `status`, `eta_min?`, `summary?`, `kind?` | `{"task_id":"...","state":"..."}`. A closed task cannot be reopened, so report a new one |
| `heartbeat` | `project?` | `ok` |
| `list_tasks` | none | `{"now", "tasks":[{task_id, title, state, eta_at, created, updated}]}`: this client's open tasks, plus the ones closed as `stale` in the last 7 days, newest first (at most 50; read-only, free) |
| `operator_status` | none | `{"status":"away","until":ISO,"message"}` during the operator's wind-down window (default 23:00 to 07:00), else `{"status":"available","message"}`; read-only, free |

An open task with no update for 24 h is closed by the server as `stale` (never a `BLOCKED` one). `update_task` with `DONE`
on a stale task is still accepted; any other status gets `isError`. Call `update_task` with `DONE` before your final
reply, even for quick tests.

`machine` is optional and additive: the `siiswell mcp` stdio server adds it from its configuration, so the dashboard can show
the tasks of several apps on one machine (each with its own client token) together, as "machine / project". Through
`siiswell mcp`, `project` may also be left out: it is filled in like the usage collector does (the first-level folder under one
of `usage.roots`, never a path; outside the roots only with `usage.inferProjectOutsideRoots: true`, from the git checkout or folder name).
A server without the `machine` column stores the task without it.

A validation problem comes back as a tool result with `isError: true` and a sentence that names the field. It is
not a JSON-RPC error. Supported protocol versions: `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26` and
`2024-11-05`. An unknown version in `initialize` falls back to `2025-06-18`. An unknown `MCP-Protocol-Version`
header gets 400, and the `supported` list is in `error.data`.

### Usage upload

The body is
`{v:1, host, tz, generatedAt, mode:"recent"|"full", complete, completeDays:[...], rows:[...]}`. Each row is
`{day, project, agent, source, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, requests, usd}`
and carries numbers and labels only. Any label outside its character set rejects the whole request (400), because
the server never rewrites a label.

- `completeDays` makes those days **authoritative**: the request carries all of the host's rows for them, and the
  host's other rows on those days are deleted. Name only days that have rows in the request, and never split a day
  across requests.
- `mode:"full"` with `complete:true` on the **last** batch of a whole-history upload marks the history as complete.
  The answer includes `needFull` until that has happened.
- `model` must be an id from the price table (`src/shared/model-prices.json`). Anything else is stored as `unknown`.
  `usd` is the API-equivalent cost, or `null` for an unpriced model.
- Erase: send `{v:1, host, mode:"erase"}` repeatedly until the answer says `remaining: 0`. It removes the hourly rows too.
- **Hourly rows (optional, additive):** `hourly:[...]` carries the same rows keyed by the host's local hour
  (`{hour:"YYYY-MM-DDTHH", project, agent, source, model, ...counters, usd}`, hours `00`-`23`) for days the request carries
  rows for. When it is present, the `completeDays` are authoritative for their hours as well; when it is absent, the
  host's hourly rows are left alone (so a client that never sends it works as before). Hours older than 90 days are
  dropped (`hourlyDropped`), at most 4000 hourly rows per request and 1200 per host and day (`hourlyCapped`). The answer
  says `hourly: "ok"`, or `"pending"` while the server's hourly table does not exist yet (the daily rows are stored anyway).
- **The `agent` label** of the official collector is the app that made the requests: `claude-cli`, `claude-desktop`,
  `claude-ide`, `claude-sdk`, `codex-cli`, `codex-exec`, `codex-desktop`, `codex-ide` or `unknown` (a fixed vocabulary
  that names no project, sent under every privacy setting). Where project names may be sent, a worktree agent follows
  after a dot (`claude-cli.dev`).

## Limits

| What | Limit |
|---|---|
| Requests per token | 60 per minute (each message of a JSON-RPC batch counts), then 429 with `Retry-After: 60` |
| `/mcp` body | 64 KiB; batches of at most 10 messages (2025-03-26 only) |
| Client token | 50 open tasks, 1000 mutating calls per 24 h (`heartbeat` is free) |
| Snapshot (appendix) | 256 KiB body, 200 tasks, 30 projects per host; titles 120 and other text 300 characters (clipped) |
| Events (appendix) | 100 per batch |
| Usage | 1 MiB body, 2000 rows (and 4000 hourly rows) and 35 distinct days per request, 300 rows per host and day (1200 hourly), 60 000 allowance units per host and 24 h (1 per row plus 30 per day touched; requests with history may use 80 %) |
| Host writes | an estimated per-host row-write budget per 24 h (`src/env.ts`); heartbeats stay open past it |

## Errors

Errors outside MCP are `{"error": "<sentence>"}` with these status codes:

| Status | Meaning |
|---|---|
| 400 | Invalid body (the message names the field), or an ambiguous path (encoded dots or slashes) |
| 401 | Missing or bad token |
| 403 | Wrong token kind, `host` is not the token's name, or a disallowed `Origin` on `/mcp` |
| 405 | Wrong method |
| 413 | Body too large |
| 429 | Over the rate limit, the budget or the allowance. Honour `Retry-After` |
| 503 | Usage tables missing (migration not applied) |

## curl examples

```sh
export SIISWELL_URL=https://dash.example.com
# health
curl -s "$SIISWELL_URL/api/health"

# MCP: list tools, report a task, finish it (client token)
H=(-H "Authorization: Bearer $SIISWELL_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
curl -s "$SIISWELL_URL/mcp" "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s "$SIISWELL_URL/mcp" "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"report_task","arguments":{"project":"web","title":"Migrate the session store","kind":"coding","status":"IN_PROGRESS","eta_min":45}}}'
curl -s "$SIISWELL_URL/mcp" "${H[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"update_task","arguments":{"task_id":"m-0a1b2c3d","status":"DONE"}}}'

# host heartbeat and one usage day (host token named "laptop")
curl -s "$SIISWELL_URL/api/ingest/heartbeat" -H "Authorization: Bearer $SIISWELL_HOST_TOKEN" \
  -H "Content-Type: application/json" -d '{"v":1,"host":"laptop"}'
curl -s "$SIISWELL_URL/api/ingest/usage" -H "Authorization: Bearer $SIISWELL_HOST_TOKEN" -H "Content-Type: application/json" \
  -d '{"v":1,"host":"laptop","tz":"UTC","mode":"recent","complete":false,"completeDays":["2026-10-16"],"rows":[{"day":"2026-10-16","project":"(other)","agent":"(other)","source":"claude","model":"claude-opus-5-5","input":1200,"output":800,"cacheRead":50000,"cacheWrite5m":3000,"cacheWrite1h":0,"requests":12,"usd":0.42}]}'
```

The `siiswell` CLI (`cli/`, see [INSTALL-CLIENTS.md](INSTALL-CLIENTS.md)) wraps all of these. Every way to connect, by
client type: [CLIENTS.md](../CLIENTS.md).

## Appendix: host integration API (advanced)

Any script or tool can show **hosts, projects, agents and tasks** on the dashboard without MCP, with a `host` token.
The token's name is the host label. A typical integration sends a heartbeat every 2 minutes and a snapshot when
something changes, at most every 2 minutes. Urgent changes can be sent every 15 seconds. An unchanged snapshot
should be re-sent once a day.

- `POST /api/ingest/heartbeat` with `{v:1, host, project?, binaryVersion?}` marks the host (and project) alive. It is
  always accepted, even when the write budget is spent; the answer then says `budgetExhausted`. A host that sends
  nothing for 6 minutes shows as offline.
- `POST /api/ingest/snapshot` sends the full current state of one project:

  ```json
  {
    "v": 1, "host": "build-box", "project": "web", "sentAt": 1797000000000,
    "poller": { "status": "running", "binaryVersion": "my-reporter 1.2" },
    "agents": [ { "name": "worker1", "baseCli": "claude", "state": "working", "contextPercent": 40 } ],
    "tasks": [ { "id": "worker1-abc", "agent": "worker1", "title": "Upgrade dependencies", "state": "running",
                 "dispatchedAt": 1796999000000, "updatedAt": 1797000000000, "etaAt": 1797001800000 } ]
  }
  ```

  `poller` describes the reporting process itself (its status and version). `agents[].state` is one of `working`,
  `idle`, `frozen` (paused), `killed` (asleep), `wedged` (stuck), `benched` (on hold), `usage-limit`, `compacting` or
  `unknown`. `tasks[].state` is one of `queued`, `delivered`, `acked`, `running`, `blocked`, `done`, `failed` or
  `skipped`, and `dispatchedAt` is when the task started. A `blocked` task raises an alert. Further optional fields
  are accepted as defined in `src/shared/schema.ts`; an integration does not need them. The host-only parts
  (`poller`, the optional `discussions` threads, the `relay` origin for agents a host forwards) are kept apart in
  `src/host-ext/` (server) and `public/host-ext.js` (page); their page sections stay hidden without data.
- `POST /api/ingest/events` sends up to 100 timestamped events of one project (`{v:1, host, project, events:[...]}`,
  `EventBatch` in `src/shared/schema.ts`). Examples are a status line with `status` and `etaMin`, or an incident with a
  `severity`. They appear under "Recent activity".

When agents on a machine are reported this way, mark their workspaces with a `.siiswell-agents` file in the project root
(or set `SIISWELL_AGENT=1` for them), so the `siiswell` hooks and `siiswell mcp` on that machine do not report the same
work again: see [INSTALL-CLIENTS.md](INSTALL-CLIENTS.md#agent-workspaces-run-by-an-orchestrator).

Each response is `{"ok":true, ...}` with counts (`dropped`, `firstError` when part of the body was refused). Errors
follow the table above. Text fields are scrubbed and clipped again by the server.
