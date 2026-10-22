# Reference

How the page and the alert rules behave, the update cadence, the abuse limits, a D1 quota estimate and security notes.
Deployment: [deploy.md](deploy.md).

## Layout

| Path | What |
|---|---|
| `wrangler.toml` | Worker, assets (`./public`, Worker first for `/api/*` and `/mcp`), D1 binding, cron, vars (`RETENTION_DAYS`) |
| `migrations/0001_init.sql` | D1 schema |
| `migrations/0004_neutral_origins.sql` | rewrites stored legacy `origin` values to `host` / `relay` (idempotent; only the origin columns hold them) |
| `migrations/0002_project_seen.sql` | `project_seen(host, project, last_seen)`: per-project liveness (what `project-offline` and the page's "reporter offline" read) |
| `src/index.ts` | fetch router + `scheduled` |
| `src/shared/` | `schema.ts` (wire contract), `redact.ts` (secret scrubbing), `pricing.ts` + `model-prices.json` (cost estimate), `brand.ts` (product name), `wire.ts` (origin values + legacy aliases) |
| `src/auth.ts` | bearer tokens (sha256 lookup), Cloudflare Access JWT (RS256, JWKS cached 1 h) |
| `src/ingest.ts` | snapshot / events / heartbeat: validation, re-clipping and redaction |
| `src/mcp.ts` | MCP Streamable HTTP, stateless JSON |
| `src/rules.ts` | PURE alert rules + push policy |
| `src/alerts.ts` | D1 glue for the rules (load, apply, send) and the bounded retention purge |
| `src/maintenance.ts` | the purge and the time-based rules without the cron: claimed, bounded, opportunistic after ingest / state reads |
| `src/push.ts` | Web Push: VAPID + RFC 8291 `aes128gcm` with WebCrypto, subscription routes |
| `src/state.ts` | `GET /api/state` |
| `src/otlp.ts` | optional `POST /api/ingest/otlp` (off unless `OTLP_INGEST=1`): Claude Code's OTLP/HTTP JSON token / cost counters into `usage_hourly` and `usage_daily`, retried exports deduplicated (migration 0009); name mapping in `docs/otel.md` |
| `src/usage.ts` | `POST /api/ingest/usage` (numbers and labels only, host token) and `GET /api/usage` (Access; usage and API-equivalent cost per project / day / month, one day's hours with `group=hour` (plus which hosts the hours cover), and `group=insights`: the overview's compact 60/30-day aggregates per app, project, model, host and weekday x hour; migration `0003_usage_daily.sql`, retention `USAGE_RETENTION_DAYS`, default 800) |
| `public/usage.js` | the page's "Usage & estimated cost" section |
| `src/keys.ts` | typed, escaped push-budget keys (no host label / client name / sender / agent name can spell another source's key) |
| `src/budget.ts` | the O(1) per-source budget claims and the push-budget SQL |
| `src/db.ts`, `src/util.ts`, `src/env.ts` | helpers, limits |
| `public/` | PWA: `index.html`, `app.js` (DOM), `format.js` (pure text / time / cadence helpers, unit-tested), `theme.js` (Auto / Light / Dark, a classic script loaded synchronously in `<head>`), `style.css`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `_headers` (CSP, HSTS) |
| `bridge/siiswell-bridge.mjs` | stdio to HTTPS MCP proxy for clients without remote-HTTP + header support |
| `scripts/new-token.ts`, `scripts/vapid.ts` | mint a token / a VAPID key pair (print only, run nothing) |
| `scripts/smoke-local.ts` | end-to-end smoke test against `wrangler dev --local` |
| `src/server/` | self-hosted server (docs/deploy.md "Deploy with Docker"): `bun.ts` (Bun.serve, assets, ticker), `d1-sqlite.ts` (D1 API over `bun:sqlite`, also the tests' database), `auth.ts` (builtin login / trusted proxy), `config.ts`, `net.ts` |
| `Dockerfile`, `docker-compose.yml` | container image and compose example |
| `scripts/hash-password.ts`, `scripts/recovery-token.ts`, `scripts/db-exec.ts` | admin password hash; one-time login recovery code; run SQL on the SQLite database |
| `test/` | `bun test` suite on the same SQLite adapter (`test/d1-shim.ts`) |
| `CLIENTS.md` | every way to connect (overview table), then per-client MCP config snippets (Codex, Claude Code/Desktop, Gemini, agy, grok, kilo, opencode), scripts, raw HTTP, OpenTelemetry and host integrations |
| `cli/` | the `siiswell` client (zero dependencies, Node >= 18 / Bun; `bun cli/build.ts` -> `cli/dist/siiswell.mjs`, not committed): `report`, `update` (a task, or the CLI itself), `tasks`, `heartbeat`, stdio `mcp`, `usage collect\|push\|show`, `hook`, `permissions suggest`, `config`, `doctor`; scheduling examples in `cli/examples/` |
| `docs/api.md`, `docs/openapi.yaml` | the client-facing wire contract v1 (ingest, `/mcp`, `/api/health`) |
| `docs/INSTALL-CLIENTS.md` | installing the client on Claude Code, Codex (CLI + desktop), Claude Desktop, agy and Gemini CLI, plus the hooks and the usage collector |
| `docs/otel.md` | usage fields vs OpenTelemetry names, and the optional `POST /api/ingest/otlp` |
| `docs/upgrade.md` | upgrading between releases (migrations, defaults that changed) |

## What the page shows

At the top: the title with two small controls, the **theme switch** (Auto / Light / Dark: one button that cycles; the
choice is saved in this browser's `localStorage`, Auto follows the device) and **Sign out** (a plain link to Cloudflare
Access's `/cdn-cgi/access/logout`; it 404s on a local `wrangler dev`, where there is no Access). Under it: the health pill and
`updated hh:mm` with a **refresh** button.

Top to bottom, in the order the operator asks: the **health pill** (all hosts online / N offline) and the
notifications button (gone once subscribed; "Send test push" then lives under Hosts & clients); a **summary
strip** (Needs you, Working, Blocked, Done 24 h, Projects; each tile jumps to its section); **Needs you** (the
inbox); **Working now** (open tasks, blocked first, then newest first, with ETA / overdue and a start time);
**Recent activity** (the newest 15 of the 50 `events`, 8 shown until "Show more"; tap a row to read it all);
**Recent results** (done / failed / skipped tasks of the last 24 h); **Projects** (host integrations only: the section, like **Threads**, and its summary tile are not rendered at all while there is no data; one row each, alerts / working
agents first; a chip per agent; tap a row for the per-agent detail); **Threads**; **Hosts & clients**
(collapsed). Task titles lose their transport tag (`[<Transport> from @x]`, `[Mattermost from x]`;
`[Forwarded from X]` becomes `↪ X:`). Agent states are shown in plain words: `killed` is **asleep** and `frozen`
is **paused** (both are the normal idle-suspend and wake on the next message, so they are calm, not red),
`wedged` is **stuck**, `usage-limit` is **limit**. The last-reply time is only shown when it is known.
`/api/state` tasks carry `startedAt` (the row's `created`: the start time for host-agent tasks) and projects carry `lastSeen` (when
anything last arrived for the project, `null` when not recorded): the page marks a project whose `lastSeen` is older than 6 min
"reporter offline" even when its host is online, and shows "last heard" instead of the (possibly hours-old) snapshot's last check. All text is
written with `textContent`; the pure text / time helpers are in `public/format.js` (`test/ui-format.test.ts`).

### You: the human side (well-being layer, migration 0007)

**"You" and "Agents".** The stress card leads with **You**: your own input only (prompts, approvals, how fast you answer,
rapid-fire replies, continuous activity, input in the quiet hours), from the counts the Claude Code hooks upload. **Agents**
(everything your agents put on you: waiting items, interrupts, fan-out, usage, limits) is the line under it. Agents working
on their own do not raise You.

**Pace nudge.** 20 minutes or more of rapid-fire replies (each < 30 s after the previous one) within the last hour shows
"Agents can wait — batch your replies every 10 min?", at most once per hour, with Not today / Never.

**Intensity.** A day of your own input is high-intensity with 18 or more active hours, or any input between 23:00 and
07:00. On the third such day in a row (today counts from its early hours), at 18:00 one neutral push and a page note suggest
planning a rest day. The weekly reflection lists the week's high-intensity days with their hours and what drove them (the
busiest projects and apps of the day) and adds 2-3 rule-based suggestions.

**Approval inbox (opt-in).** Settings "Approval inbox": off (default: each approval waiting for you is pushed at once) or
every 15 / 30 minutes (approvals are held and arrive together with the Scheduled Summary, at least that often). The shorter
interval applies only while held approvals wait; every other summary keeps its own interval. In inbox mode each approval
goes out in ONE digest: there is no reminder ladder (15 / 30 / 60 / 120 min) for it. Focus also holds approvals while
inbox mode is on (inbox mode means: batch everything).

**Wind-down.** At the wind-down time (default 23:00, settings) one "Time to wind down" push says what is still running and
what still waits for you; until the morning time (default 07:00) the MCP tool `operator_status` tells agents you are away
(they carry on and keep their questions); at the morning time one "Good morning" push says what happened overnight.


The **You** card at the top (above Needs you) looks after the person, not the agents. It is rule-based throughout (indexed SQL
over the existing tables plus fixed thresholds; no AI call anywhere, no new data collected from any client) and is **not a
medical tool**: it only counts timestamps and events.

- **State: Calm / Busy / Overloaded**, the worst of these indicators, always with the reasons ("Waiting for you 5 · Off-hours
  today 2h"). Thresholds [busy, overloaded]: interrupts in the last 60 min (`approval-waiting`, `blocked`, `overdue`, `agent-stuck`
  opened) [4, 9]; waiting for you now (open `approval-waiting` + `blocked`) [3, 5]; projects active in 60 min [4, 6]; session
  length (a gap of 45 min or more ends it) [3 h, 5 h]; active hours inside the quiet hours today [1, 2]; tokens today up to
  this hour against the median of the same span over the last 14 days [2x, 3x]; plan-limit use any agent reports [70 %,
  90 %]; most BLOCKED <-> IN_PROGRESS flips of one task in 24 h [3, 5]. Formulas: `src/wellbeing-metrics.ts`.
- **Stress level (estimated), 0-100**: "Calculated from your AI workload signals — not a medical measure." Each indicator is
  normalised (0 at 0, 50 at its busy threshold, 100 at the red one and above), weighted (one table, `STRESS_WEIGHTS` in
  `src/wellbeing-stress.ts`: waiting 20, interrupts 20, session 15, off-hours 15, fan-out 10, usage 10, retry 5, plan limit 5)
  and smoothed with an exponential moving average (time constant 20 min: ~63 % after 20 min, ~95 % after an hour; with no prior or a stale state it starts at the raw value). The band is judged on the rounded number that is shown. Bands 0-29 Relaxed 😌,
  30-59 Steady 🙂, 60-79 Strained 😬, 80-100 Overloaded 🥵; "Why" names the three biggest contributions in points. The ticker
  takes a reading every 15 minutes (minute 7 of each quarter hour, minute 8 when that invocation ran the purge) from ONE
  read of all inputs and stores it in ONE batch of two statements (the EMA state; the hour's `stress` and eight
  `n:<indicator>` rows of `wb_metrics`); `GET /api/wellbeing` is read-only: the page shows the live value (smoothed against the stored state) without storing it.
  The plan-limit indicator reads the snapshot of each host / project received in the last 6 hours, cached per isolate for a
  minute (shared by the page and the ticker). The hourly history is
  the LAST reading of the hour; the EMA's step uses the real time since the previous reading. Charts (hand-built SVG): a gauge, a radar of the eight indicators now against the 7-day average, today's stress
  line over the interrupt bars (quiet hours shaded, a "now" marker, keyboard like the usage charts), the 7 / 30-day stress
  trend, a sparkline under each indicator, and average stress per weekday and hour over 30 days.
- **Today's timeline** (24 hours, colour = interrupts, a dot = active, quiet hours shaded) and **7 / 30-day trends** (active
  hours, off-hours, longest break, average waiting), from `wb_metrics`: the ticker upserts the current hour's `active`,
  `interrupts`, `waiting` and `projects` in ONE statement a minute (the settings are read at most once a minute per isolate;
  a trigger keeps 90 days).
- **Pushes, fewer and better timed** (`src/wellbeing.ts`): tier `now` (`approval-waiting`, `blocked`, `host-offline`, `usage-limit`, and a critical `agent-stuck` such as `cli-gone`)
  is pushed, several of one minute merged into one push, oldest first; tier `batch` (`overdue`, a non-critical `agent-stuck`, `project-offline`)
  goes into ONE digest push per interval (default 30 min); everything else (`info`) is never pushed. In the **quiet hours**
  (default 23:00-07:00, weekends optional) only `now` items are pushed, and only the first per project in an hour; whatever is
  held then is not offered again until the quiet hours end (it arrives in the morning digest). In practice a project gets ONE push
  in a night, not one an hour: a later push for it needs a NEW urgent item at least an hour after the last one.
  **Focus 60 min** mutes everything except `approval-waiting` (an action waiting for you still gets through, since nothing can
  go on without it); everything else, a critical `agent-stuck` such as `cli-gone` included, is held for the first digest after
  Focus ends. An action that keeps waiting for you is pushed
  again after 15, 30, 60 and 120 minutes, then only the digest mentions it. `WELLBEING_PUSH_POLICY=0` switches the tiers,
  digest, quiet hours, Focus and storm merging off (every due push then goes out on its own, as before).
- **Names on the page (iOS-style)**: the `now` tier is shown as **Time-Sensitive** and the batch digest as the **Scheduled
  Summary**: every digest interval and also at fixed local times (Settings, default 08:00 and 18:00; up to four). The code
  keeps the names `now` / `batch` / digest.
- **Grouping (Alertmanager-style)**: `group_wait` (Settings, default 30 s; 0 = off): a NEW urgent alert waits that long so
  the urgent alerts of the same moment go out as ONE push (nothing is written while it waits; reminders never wait).
  `group_interval` is the digest interval; `repeat_interval` is the re-push ladder (15 -> 30 -> 60 -> 120 min, then the summary
  only), shown read-only. **Inhibition** (pushes only; the alerts stay open on the page): an offline host inhibits its
  `project-offline` and `agent-stuck` pushes, and a `blocked` task inhibits the `overdue` push of the same task
  (`inhibitedKeys` in `src/rules.ts`; applies with or without the well-being policy).
- **Calendar Focus** (`src/wellbeing-calendar.ts`): paste a private ICS URL in Settings (stored in D1 as `cal:url`, only its host
  is ever shown back). The ticker reads it at minute 11 of each quarter hour: https on port 443, no user info, a DNS name only
  (every IP literal is refused, in any IPv4 spelling and any IPv6 form, and special-use names such as localhost, .local,
  .internal, .lan, .home, .intranet, .corp, .arpa, .test, .invalid, .example), every redirect checked the same way (at most 3),
  5 s timeout, 1 MiB cap. Busy events (VEVENT with
  DTSTART / DTEND, simple RRULE FREQ=DAILY / WEEKLY with INTERVAL / COUNT / UNTIL; all-day, transparent and cancelled events
  skipped) switch Focus on for their duration. Not handled: EXDATE (a cancelled single occurrence still counts as busy) and
  RECURRENCE-ID (a moved single occurrence keeps its original time); a recurring event steps in fixed UTC days / weeks, so
  across a DST change it is an hour off in local time. Failures show only fixed texts (timeout, too large, refused URL,
  HTTP 4xx / 5xx, parse error, fetch failed). The fetch skips the invocation that ran the retention purge and catches up a
  minute later. Cost: 1 fetch subrequest (up to 4 with redirects) and 2 D1 statements in that
  one invocation a quarter hour. A Worker cannot resolve DNS before it fetches, so a public name pointing at a private address
  is not caught; use a feed URL from your calendar provider. On Cloudflare a Worker's fetch cannot reach private networks; the
  **Docker** build can, so run it with egress restrictions (no route to internal networks or metadata endpoints) when calendar
  feeds are used.
- **Plan-limit forecast** (`src/wellbeing-forecast.ts`): every 15 minutes the ticker keeps the recent readings of each
  plan-limit window (`5h`, `weekly`, ...; a drop means the window reset and starts again) in the same batch as the stress sample.
  The page says "At this pace the 5 h window fills around 16:40." only when a least-squares line through at least 3 readings over
  at least 30 minutes rises and fits (R² >= 0.6), and the window would fill before it resets and within its own length. No
  countdown, no alarm words.
- **Gentle nudges** (each with "Not today" and "Never"; all can be switched off): a pause after 3 hours without a long break,
  a note when you are active in your quiet hours, a neutral line when today's usage is 3x your usual, and a weekly
  reflection made from fixed sentence templates. No scores, streaks, rankings or countdowns.
- **Settings** (time zone, quiet hours, weekends, digest interval, nudges) are stored in D1 (`wb_settings`) and written with
  same-origin JSON POSTs to `/api/wellbeing/{settings,focus,nudge}`, behind the same Access gate as `/api/state`.

## Update cadence

Steady state is **one ingest request per project per 2 minutes**, and a page that is not open costs nothing:

- An unchanged snapshot is re-sent once every 24 h (`SNAPSHOT_KEEPALIVE_MS`) so a quiet project heals if the Worker lost its
  row (purge, D1 restore); it replaces that tick's heartbeat.
- **Host-side pusher** (the reference behaviour of a host agent; constants in `src/shared/schema.ts`): a *changed* snapshot
  is sent at most once per `SNAPSHOT_MIN_INTERVAL_MS` = 120 s (the first one after a start or config reload goes out at once, and so
  does a change after a quiet spell); otherwise a heartbeat every `HEARTBEAT_INTERVAL_MS` = 120 s. An accepted snapshot or events
  batch counts as a heartbeat. **Events** (incident events, STATUS lines) are never held back and do not move the snapshot schedule.
  "Changed" means something the page can show: the context window of a working agent is rewritten after every model turn, so the
  raw `contextTokens` is left out of the comparison and `contextPercent` / `usage[].usedPercent` count at the grain the page
  prints (5 % buckets for context, whole percent inside the 70 / 90 colour bands for usage); the snapshot that is sent still
  carries the exact numbers. Older pushers used a 60 s heartbeat and sent a changed
  snapshot at every 30 s rebuild.
  **Urgent changes do not wait for the 2 minutes**: a task that newly enters `blocked` or `failed`, a new pending action, or an
  agent that newly becomes wedged / paused / at its usage limit goes out at the next rebuild (<= 30 s + one tick), but never
  sooner than `SNAPSHOT_URGENT_MIN_INTERVAL_MS` = 15 s after the previous snapshot, so a flapping state cannot spam the Worker (the
  blocked push comes from the snapshot's task rows; the incident events that drive the other pushes are sent at once anyway).
  A clock that jumps BACKWARDS cannot stall the schedule (every "last sent" time is clamped to `now`; a backoff or auth pause that
  ended up further away than it can ever be is cut back to its maximum).
- **Worker:** every heartbeat, snapshot and events batch refreshes the host row (`hosts.last_seen`), held only to a 20 s floor
  (`LIVENESS_WRITE_FLOOR_MS`, far below any real sender, so every real message is written; the floor is what keeps the unbudgeted
  heartbeat from being a write path for a leaked token). A request refused before it wrote anything (a budget 429, the project
  limit, a 413) keeps the 90 s throttle (`HOST_WRITE_EVERY_MS`). A host is offline after **6 min** of silence, which one lost
  heartbeat after a late one (2 x (120 s + tick + jitter) = 290 s) never reaches (`test/liveness.test.ts`, incl. the single-project
  case "events batch, then a lost heartbeat"). Each project also records its own `last_seen` (`project_seen`, written by its
  snapshots, heartbeats and events, at most every 20 s per project, `PROJECT_SEEN_WRITE_FLOOR_MS`, same as the host row): a project that goes quiet on a live host is marked
  "reporter offline" on the page and raises the `project-offline` alert (see Rules). The Worker accepts either pusher: an older pusher (60 s heartbeat) writes the row every other heartbeat; a
  newer pusher against an older Worker works too (its 120 s throttle can skip a heartbeat that lands a hair early, which
  only matters if a second one is also lost). Deploy the Worker first.
- **Page:** polls `/api/state` every 60 s **only while visible** (a self-rescheduling timer, counted from the last fetch);
  nothing is fetched while the tab is hidden; coming back fetches at once when the data is older than 15 s; the refresh
  button fetches now. A project's "reporter offline" comes from the host row, never from the age of its snapshot (an unchanged
  project sends heartbeats, so its snapshot can be hours old on a healthy host: that is what "last change" shows).

## Behaviour worth knowing

- **Auth.** Ingest needs a `host` token, `/mcp` a `client` token (a token of the wrong kind is 403).
  A host token is **bound to one host label** (its source name, unique across all sources): the payload
  `host` is only compared with it (403 on mismatch, nothing written) and every row written from the
  request (snapshots, `hosts`, tasks including forwarded tasks, events, host-offline resolution) carries the
  token-bound label, never a value the payload asserts. A leaked token for `evilhost` therefore cannot
  write, delete, take over or resolve anything that belongs to `hosta`.
  Only the sha256 of a token is stored; tokens are never logged. `last_seen` is written at most every
  30 s per client token and every 5 min per host token (host liveness lives in `hosts`).
  `/api/state` and `/api/push/*` need a valid `Cf-Access-Jwt-Assertion` (RS256, `aud`, `iss`, `exp`).
  The JWKS is cached for an hour and refetched at most once a minute for an unknown `kid`;
  **stale-while-error**: if a refresh fails the cached keys keep being used for up to 24 h since the last
  good fetch (retried at most once a minute), only after that is it a 503. Static assets are protected by
  Access at the edge; with `run_worker_first = ["/api/*", "/mcp", "/mcp/*"]` the Worker itself only guards
  the API, and the static shell contains no data. Paths with dot segments, encoded dots/slashes or empty
  segments (`/api/ingest/%2e%2e/state`) are a 400 before routing, so the edge's Bypass policy for
  `/api/ingest/*` and the Worker can never disagree about which route a path is; `/api/state` has its own
  Access check regardless.
- **Identifiers are validated, never rewritten.** `host` and `project`: `^[A-Za-z0-9._-]{1,64}$`; agent
  names: `^[A-Za-z0-9._@=/+-]{1,96}$` (forwarded/MCP agents contain `@`); task, pending action and thread ids and
  chat senders have their own strict sets (`src/util.ts`). A violation names the field
  (`agents[1]: name must match ^[A-Za-z0-9._@=/+-]{1,96}$ (got 'a|b')`); the offending value is echoed with
  CR, LF and every other control character replaced by `?`, so a hostile value can never forge a log line
  or a second header. `host` / `project` / `v` problems are a `400` for the whole request (nothing is
  written); problems inside ONE item are per-item, see Ingest. Identifiers are not passed through the
  redactor (that would turn `sk-build-server` into `[redacted]` and make different names collide) and
  are compared raw, with one exception: **agent names are lower-cased** after validation, so every
  comparison (rules, UI) is case-insensitive. Free text (titles, summaries, status lines, topics) is still
  clipped and redacted.
- **Ingest.** Bodies over 256 KiB, `v != 1`, more than 100 events or 200 tasks are rejected. Enums are
  validated, unknown fields dropped, timestamps clamped to the server clock. **One bad item never costs the
  batch:** a snapshot's agent / task / thread / pending action that fails validation is dropped (so is a bad
  optional field such as an agent's `baseCli`), and the response says so
  (`{"ok":true,"dropped":2,"firstError":"tasks[3].id: ..."}`), exactly like events (`dropped` +
  `firstError`); the pusher keeps working and the next snapshot repairs it. Only `host`, `project`, `v`
  and the envelope are all-or-nothing. A snapshot replaces that host+project's host-agent task rows
  (its 24 h window is authoritative) and nothing else. Lists are written with one `json_each()`
  statement each, so a full snapshot costs a handful of D1 queries (the Free plan allows 50 per
  invocation). Writes are budgeted per host token, see [Abuse limits](#abuse-limits).

  **What one host token can make the Worker STORE and PARSE is capped** (every rule evaluation and every
  `/api/state` parses the stored snapshots, so size matters as much as row counts): at most
  `MAX_PROJECTS_PER_HOST` = **30 projects per host** (a snapshot - or an events batch - for a NEW project
  beyond that is a `429` with the reason; existing projects keep working); per snapshot at most **20 agents,
  10 threads and 20 pending actions** (the rest is dropped and counted in `dropped`); the stored JSON is the
  snapshot **without its tasks** (they are rows of the tasks table; `snapshots.fp` fingerprints agents +
  tasks + pending actions so an unchanged snapshot is recognised without reading them) and may not exceed **32 KB**
  (`413` with the reason, nothing stored); at most **200 running/blocked host-agent tasks per host** across its
  projects (`snapshots.open_tasks` is summed; the surplus is dropped and counted) and **200 forwarded tasks per
  host**. A snapshot is charged to the write budget **what D1 bills: ONE row however large** (the 32 KB cap bounds
  storage and reads, not writes): an update of the (host, project) row 1, the first snapshot of a project 2
  (row + key), plus the claim of the source row (1). fix5 charged a row per 2 KB stored, so a host with 14 agents
  per project (~4.5 KB) paid 4 per snapshot instead of 2 and exhausted its budget after 19 h on honest traffic.
  Events older than 24 h are refused
  (`at is older than 24 hours`, counted in `dropped`): an `at: 0` forwarded event used to make its task row
  stale the instant it was written, which hid it from the forwarded cap. One host token can therefore store at
  most ~30 x 32 KB = ~1 MB of snapshots, and `GET /api/state` is cut to <= 1 MB whatever the database
  holds (see Abuse limits). To remove everything a leaked source wrote, see `scripts/purge-source.ts` below.
- **Sender-chosen keys are scoped to their source.** `events` has `PRIMARY KEY (source_id, key)`, so
  a guessed key (e.g. a chat event id) can only collide with the same source's own earlier event and
  can never suppress another source's. `tasks.key` and `alerts.key` always start with a token-bound name
  (host label, or MCP client name; names are unique), task upserts only overwrite a row of the same
  origin and host, and MCP task ids are generated by the Worker (`m-` + 8 random base36 characters), never
  taken from the client. An MCP client can only read-modify rows whose `source_id` is its own.
  `migrations/0001_init.sql` was edited in place for this (events primary key + `source_id`, alert
  `origin`, indexes) because nothing had been deployed; a local database created from an earlier version
  must be recreated (delete `.wrangler/state` and re-run `d1 migrations apply --local`).
- **Desktop clients cannot pass for a host agent.** MCP agents are stored as `<agent>@<client name>`
  (default agent `agent`), and every alert whose origin is not the host-agent origin (MCP clients, forwarded third-party
  agents) ends with ` · via <client or host>` in the inbox text and in its push body, and carries an
  `origin` the UI shows as a badge. A prompt-injected client can at most produce
  `proja: claude@client2 blocked · via client2`.
- **Host liveness** lives in a small `hosts(host PK, source_id, last_seen, binary_version)` table
  rather than being derived from `snapshots.received_at`, because heartbeats carry no snapshot. It is
  refreshed by every heartbeat, snapshot and events batch unless a write happened in the last 20 s (`LIVENESS_WRITE_FLOOR_MS`:
  <= 4,320 writes a day however fast a token sends) **whatever the message carries** (the binary version rides along when
  that write happens; the only version-triggered write is filling a NULL, at most one extra write per host
  ever, because an events call creates the row without a version a moment before the first snapshot names it;
  a sender alternating `binaryVersion` on every heartbeat causes exactly the writes a constant version would), so "offline" is
  detected between 6 and 7 minutes after the last message (6 min of silence, then the page at once, the cron's `host-offline`
  within the next minute). A request that is refused BEFORE it wrote anything (a budget 429,
  the project limit, a 413) refreshes the host row too, so an over-budget host does not look offline while
  its pusher backs off. It is host-level: a single dead reporter on an otherwise live host
  is visible as an old snapshot age (and a `reporter offline` pill once the host goes quiet) in the Projects list, not as an alert.
- **Rules** (`src/rules.ts`; evaluated on every changed snapshot, every events batch, once per MCP request
  that wrote, and every cron minute; alert keys are deterministic so re-evaluation is idempotent):

  | rule | opens | resolves | push |
  |---|---|---|---|
  | `approval-waiting` | snapshot pending action with `requestedAt` older than 5 min | pending action gone | on open, +30 min, +60 min (max 3) |
  | blocked | task state `blocked` (any origin) | task not blocked; a host-agent task: a newer start (`dispatchedAt`) to the same host+project+agent; any origin: 6 h after the task entered `blocked` | on open |
  | agent-stuck | an incident event (kind `halt`) with scenario `benched`, `restart-failed` or `cli-gone` | the first snapshot BUILT after the incident (`sentAt` > incident `at`) that shows the agent neither `wedged` nor `benched` (an agent missing from it counts as recovered), or 6 h after the incident | once, on open |
  | usage-limit | incident event `usage-limit`, or agent state `usage-limit` | agent state not `usage-limit` (event-sourced: also 6 h) | on open |
  | host-offline | host silent for more than 6 min | host seen again (resolves silently) | on open only |
  | project-offline | a project's reporter silent for more than 6 min (and less than 24 h) while its HOST is online | the project reports again (its snapshot / heartbeat resolves it at once), the host goes offline (`host-offline` covers it), or 24 h pass (retired project) | on open only (once; a re-open within 30 min keeps its counters) |
  | overdue | `running` and now > `updated` + 1.5 x (`etaAt` - `updated`) | no longer running, or a new ETA | on open |
  | alerts-capped | a project, a host (non-critical, all projects together) or a host's criticals are over their cap (see Alert caps): ONE notice per cap, with the count | it no longer is | never (inbox only) |
  | budget-exhausted | a source was refused for budget (a host token: critical; a client token: `warn`, inbox only) | the budget window ends (cron resolves it, no request needed) | host: once on open; client: never |

  **agent-stuck lifecycle.** It is opened by the host's incident event, pushed once, and resolved by the first
  snapshot built after that notice that shows the agent healthy (or after 6 h). What to expect per
  scenario: `benched` clears when the thread ends and the agent is resumed; `restart-failed` stays
  open (the agent is shown `wedged`) until a later delivery succeeds; `cli-gone` clears after the automatic
  relaunch. For this to work the snapshot's `sentAt` must be the time the snapshot was BUILT, not sent
  (the host-side pusher keeps it that way): a snapshot built before the incident but delivered after it would otherwise
  resolve the alert early.

  **agent-stuck dedupe.** The alert key is `agent-stuck|<host>|<project>|<agent>|<scenario>`: it does NOT
  contain the incident's timestamp. A host that keeps announcing the same `restart-failed` / `cli-gone` every few
  minutes updates ONE alert (6 h TTL from the newest incident) instead of opening a new one per incident; two
  different scenarios of one agent are two alerts, and the newest incident of an agent supersedes its older
  one. Together with the 30-minute re-open grace below, a flapping agent pushes once per incident, not once
  per incident.

  **No double pushes.** An alert that re-opens less than 30 minutes after it was resolved is the same
  incident: it keeps its `opened`, `push_count` and `last_pushed`, so a flapping condition (for example
  that early snapshot, followed by a correct one) never pushes twice. Older resolved rows start a fresh
  episode that pushes again.

  **Stale forwarded tasks.** A task mirrored from a foreign agent's STATUS events (the forwarded origin) that is
  still `running` / `blocked` with NO update for 24 h (`RELAY_STALE_AFTER_MS`) is stale: its agent most
  likely finished without saying so. Stale forwarded tasks are excluded from the rules (so a forgotten
  "running, ETA 20 min" cannot stay `overdue` forever) and from the open tasks in `/api/state`; they are
  purged with the rest after 30 days. MCP and host-agent tasks are not affected.

  **Partitioned scans, and a truncated partition never resolves anything.** Every query the rules run is
  bounded, and bounded PER SOURCE, so one host or client cannot crowd another out of it: snapshots are
  numbered per host (`ROW_NUMBER() OVER (PARTITION BY host)`, 30 each), open tasks per (host, origin)
  (the host label for host-agent and forwarded rows, the client name for MCP rows; 200 each), and **the alerts
  and the incident events are read by ONE BOUNDED INDEX SEEK PER HOST** (`idx_alerts_host (host, resolved, opened)`,
  `idx_events_halt`): the hosts are found by hopping over the index (`MIN(host) WHERE host > ?`, one probe each),
  then a host's open alerts (at most 400, oldest first), its recently resolved ones (100) and its newest 100 incident
  events are taken from its own part of the index. The cost of the scan is what it RETURNS (<= ~360 alerts of a
  host at its caps), not the size of the table: with 30,000 alerts of one flooding host beside a quiet one
  sqlite3's own step counter reads 22,800 VM steps and 4 full-scan steps for the alert scan, where the old
  `ROW_NUMBER() OVER (PARTITION BY host)` over the whole table needed 2,487,391 steps and 30,002 full-scan steps
  (`test/queries.test.ts` repeats the measurement with the `sqlite3` binary and asserts that ten times the alerts
  cost the same). Each partition scan asks for ONE row more than it may use and reports the partition as
  truncated when it gets it. "This alert is no longer in the desired set" is only true if
  the evaluation SAW every input of that alert, so: **a rule family whose input partition was truncated may
  still OPEN alerts but resolves none of the alerts that live in that partition** (`blocked` / `overdue` read
  the task scan, `agent-stuck` the incident-event scan, `usage-limit` snapshots + events, `approval-waiting`
  snapshots, `host-offline` hosts, `budget-exhausted` the budget scan), and a truncated alert partition
  freezes that host's alerts only. Everybody else's alerts keep resolving normally during a flood. The ingest
  caps keep legitimate data far below every partition limit; the partitions are the net under them.

  **A scan's GLOBAL row limit freezes only the hosts it did not read.** Each scan also has a global limit sized for
  many full hosts (alerts 4,000 rows = 10 hosts at their caps, tasks 4,000, incident events 2,000, snapshots 600;
  `src/alerts.ts`). The scans come out host by host in name order, so when one is hit the loader knows the first host
  it did not read (`readFrom`): the hosts BEFORE it are complete and evaluate as usual (they open, evict and resolve),
  from there on a host's alerts of that scan are not resolved, its new non-critical alerts wait (they cannot be
  counted) and its critical ones still open. fix6 stopped everything instead: once 1,001 alerts were loaded NO host
  could open a non-critical alert or resolve one, which two flooding hosts (600 alerts each) were enough to cause;
  with 8 full hosts everything is read and evaluated (`test/fix7.test.ts`). `/api/state` carries
  `rulesTruncated: ["tasks", ...]` (kept in a one-row `meta` table, written only when it changes: it names every
  scan that was cut off, by partition or by its global limit) and the UI shows a warning banner while it is
  non-empty: look for the flooding source, revoke its token and run `scripts/purge-source.ts`.

  **Alert caps per OWNER (the alert `host`: a host label, or an MCP client name; the label is token-bound, so no
  source can place an alert in another's partition).** No source can grow the alert table, and with it every
  evaluation's reads, without bound, and none can evict another source's alerts:

  | what | cap | beyond it |
  |---|---|---|
  | open NON-critical alerts per host+project (`MAX_OPEN_ALERTS_PER_PROJECT`; pending actions: 20, the oldest requests first) | **50** | oldest evicted for the newest; ONE `alerts-capped|host|project` notice |
  | open NON-critical alerts per HOST, all projects together (`MAX_OPEN_ALERTS_PER_HOST`) | **200** | same, ONE `alerts-capped|host|!all` notice: spreading alerts over 30 projects (30 x 50 = 1,500 in fix6, which cut the host's partition at 800 and froze its resolution) buys nothing |
  | open CRITICAL alerts per host (`agent-stuck`, `usage-limit`, anything critical; `MAX_OPEN_CRITICAL_ALERTS_PER_HOST`) | **60** | oldest evicted for the newest; ONE CRITICAL `alerts-capped|host|!critical` notice counts them (inbox only, never pushed): a hundred invented agents can neither hide the real one behind a thousand rows nor make the host's partition unreadable (fix6: 600 critical alerts of one host, 1,030 open in all) |
  | `host-offline`, `project-offline`, `budget-exhausted`, the notices | never counted | at most one per host / (host, project) / source / scope |

  So a host holds at most ~300 open alerts (200 + 60 + notices), under its 400-row partition scan. **A host-agent alert
  always outranks a forwarded third-party agent's** in the non-critical caps (own first, then newest): a chat user
  behind a forwarder cannot push a host's own pending actions out by claiming a fresh timestamp. The ranking is by when the
  CONDITION began (`alerts.since`: a task's last update, a pending action's request, an incident's time), a fact that does not
  move, so an evicted alert is not re-opened by the next evaluation and nothing flaps. What counts is what is OPEN, not
  only what is desired this minute: an open alert that this evaluation cannot resolve (its scan was cut off, e.g. a
  host with more than 100 incident events in 6 h) takes part in the caps as a candidate, so a flood that outruns the scans
  cannot leave every older alert open beside the newest ones. The notices carry a count that moves, so the text of an
  OPEN notice is rewritten when it changes (one row, charged to the owner). A host whose alert partition was cut off
  opens no NEW non-critical alert (it cannot be counted) but keeps opening critical ones. The worst case of ONE host
  token (30 projects x (20 pending actions + 20 agents at the usage limit) + 200 blocked tasks) is ~263 open
  alerts for ~7 k charged rows (fix6: 1,030 open, scan cut off, resolution frozen) and
  `/api/state` shows the other hosts' alerts whatever it does (the inbox is read per host too, below).

  **Push counters.** `alerts.push_count` is the number of INDIVIDUAL pushes that really went out. An alert that
  only a budget summary push mentions has `summarized_at` set instead (and `push_count` 0), so the inbox and
  later analysis can tell them apart (`/api/state` returns both; the UI shows a "summarised" badge). A
  summarised alert is settled (it does not come up again every minute); a pending action's reminders still follow.

  Other notes: a pending action without `requestedAt` cannot age and never alerts; a host-agent task that ended
  with STATUS: BLOCKED is a closed ledger task that stays in snapshots for 24 h, hence the
  newer-start and 6 h rules; the 6 h cap is anchored on the task's `updated` (not on the alert row)
  so a capped alert never re-opens. Foreign agents' STATUS events (the forwarded origin) become one task
  row per sender (at most 50 per host+project, see Abuse limits) so they show up in Tasks and can raise
  `blocked`.
- **`project@host` everywhere.** The same project name can exist on two hosts, so every alert text, push
  body, inbox line and task row shows the scope as `<project>@<host>` (`proja@hosta: Agent01 blocked`);
  a host-level alert (`host-offline`) shows just the host.
- **Push.** The only text that leaves is `"<project>@<host>: <agent> <rule words>"` (plus ` · via <source>`
  for non-host-agent alerts) with title `Needs you` and a URL anchored on the alert; never task text.
  **Notification slot:** host-agent alerts use their alert key as the notification `tag`; every alert
  from MCP clients or forwarded third-party agents uses `src:<budget key>` (`src:own|client1`, `src:rs|hosta|@bot:srv`), so a
  noisy source can occupy at most ONE notification on the phone (a newer one replaces the older). Each push is claimed in D1 before it is
  sent (no double pushes between ingest and cron). **Claim -> send never loses an alert:** the claim and
  the send run inside one try/finally; whatever fails (an exception anywhere, a D1 error, the deadline,
  every device failing transiently) the claim and the source's push slot are rolled back and the next cron
  minute retries. **Without a VAPID key or without any subscription nothing is claimed**, so `push_count`
  is not consumed; an unsent push is attempted while the alert is less than 60 minutes old, which also
  bounds the burst when the first device subscribes (alerts older than an hour are never pushed late).
  404/410 deletes the subscription. Subscriptions are only accepted for https endpoints on the known push
  services (FCM, Mozilla, Apple, Windows; extend with `PUSH_ALLOWED_HOSTS`), and the POST routes demand a
  same-origin JSON request. Per-source push budget and per-invocation limits: see Abuse limits.
- **MCP.** `POST /mcp`, stateless, `application/json` responses, notifications -> 202, GET/DELETE ->
  405, no session ids, `Origin` checked, `MCP-Protocol-Version` validated. JSON-RPC batches (legacy
  2025-03-26 only) are limited to 10 messages (400 / `-32600` above that), every message of a batch is
  charged to the rate limiter (a batch of 10 costs 10 requests; if the budget cannot cover it the whole
  batch is a `429` before anything runs), and the alert rules run at most once per HTTP request (an evaluation follows a MUTATION, so the 1,000 a day of the mutation budget bound them). The
  `heartbeat` tool writes NOTHING itself: the only write a heartbeat can cause is the throttled
  `last_seen` touch of authentication (at most one per 30 s per client), so a batch of ten heartbeats is
  at most one row. Legacy `initialize` negotiation for 2025-11-25 / 2025-06-18 / 2025-03-26 /
  2024-11-05, plus the handshake-free 2026-07-28 revision (`server/discover`, per-request `_meta`,
  mirrored `Mcp-Method` / `Mcp-Name` headers). Every MCP mutation also writes an `events` row
  (origin `mcp`). Transport rules checked against
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports and
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http .
- **Time-based rules without the cron.** The clock-driven rules (host offline, pending action reminders, overdue) and the
  push-summary flush also run after an accepted ingest / state read, **at most once a minute** (meta `last_tick`, same
  conditional claim) **and only when the cron has not run for 2 minutes** (every cron run stamps meta `last_cron`),
  so they work whether or not the cron fires and a working cron is never doubled. `OPPORTUNISTIC_MAINTENANCE=0`
  switches the whole opportunistic path off (tests; an operator whose cron works).
  **The ticker closes the remaining gap.** The cron trigger has never fired for this Worker, so a Durable Object alarm
  (`OrchTicker`, see below) runs the same body every 60 s whatever the traffic: if the only host dies and nobody has the page
  open, `host-offline` is still opened and pushed. Only with `TICKER_ENABLED=0`, or if the alarm chain breaks and no request
  wakes the Worker to re-arm it, do the time-based rules wait for the next ingest / page read again.
- **Ticker (Durable Object alarm, a cron-independent clock).** One global SQLite-backed `OrchTicker` (`idFromName("main")`,
  no public route) fires an alarm every 60 s, runs the cron body (time-based rules, push summaries, the purge claim), stamps
  meta `last_alarm` and `last_cron` (so the opportunistic path backs off as it would for a working cron) and always re-arms,
  also after an error. The first ingest, `/api/state` read or scheduled call after a deploy arms it (`ensureTicker`, at most
  once per isolate per 10 min). `wrangler.toml` carries `[[durable_objects.bindings]] TICKER` and `[[migrations]] tag "v1"
  new_sqlite_classes = ["OrchTicker"]`; the deploy applies that migration (hard to undo: removing the class later needs a
  `deleted_classes` migration). Cost: ~43,200 alarm invocations per 30 days, negligible on Workers Paid; the DO only does D1 work.
- **Retention.** Every table a source can write to is purged at most every 15 minutes, so no token can grow one
  without bound (what a token may write in a day is capped by its budgets, and all of it is gone after the retention
  period: the `RETENTION_DAYS` var, default 30 = `ALERT_DEFAULTS.retentionDays`; lower it in `wrangler.toml [vars]` to keep
  less data on Cloudflare). **The purge no longer depends on the cron trigger**, which has never been seen to fire in
  production (nothing was purged): it runs from the cron when that works AND opportunistically after any accepted
  host ingest or `/api/state` read (`src/maintenance.ts`, inside `ctx.waitUntil`, never on the response path; an
  anonymous, refused or failing request starts nothing). Every run first claims the slot with one conditional write
  of meta key `last_purge` (`INSERT ... ON CONFLICT DO UPDATE ... WHERE <stamp old enough> RETURNING`: succeeded iff a
  row came back), so two concurrent requests, or the cron and a request, never both purge, and each run is bounded:
  at most 500 rows per table and statement (`PURGE_BATCH`, oldest index entries first), so a backlog (a lowered
  `RETENTION_DAYS`, a long stretch without any purge) is worked off over several runs instead of one CPU-hungry
  statement. What goes: `events`, tasks not updated, stale snapshots and hosts older than
  that; **alerts: resolved ones older than that AND open ones that were opened that long ago** (fix6 kept open rows for
  ever: a partition the rules can no longer see, e.g. of a deleted source, never resolved; a condition that really
  lasts 30 days opens again at once, one write); **push budgets: a row nobody claimed (ensured for a push that then did
  not happen: fix6 never purged those) after ONE hour, a claimed one idle for 2 days, a held-back summary nobody could
  send after the retention period.** The purge cannot take a budget row between its ensure and its claim: every row
  carries `touched` (set when it is created, ensured or claimed; a row that is used is re-touched every 10 minutes), so
  a row a sender is about to claim is always younger than the grace. `test/fix7.test.ts` floods one host token and one
  client token for 24 simulated hours, asserts the per-table bounds, and shows every one of those tables empty after one
  purge 31 days later. What bounds each table per owner (the rest is the retention period):

  | table | per owner (host token / client token) | gone |
  |---|---|---|
  | `events` | the write budget: <= 12.5 k a day at 4 rows each (a client: 1,000 mutations a day) | 30 d after `at` |
  | `tasks` | open: 200 host-agent + 200 forwarded per host, 50 per client; closed ones are replaced by the next snapshot (a client: 1,000 new a day) | 30 d after the last update |
  | `snapshots`, `hosts` | <= 30 snapshots and ONE host row per host | 30 d after the last one |
  | `alerts` | open: <= ~300 per host (the caps); resolved: what the budget paid for opening (<= ~4 k a day) | resolved 30 d after resolving, open 30 d after opening |
  | `push_budget` | <= ~150 rows per owner (4 fixed keys, <= 10 forwarding senders, <= 60 critical agents a day) | never claimed after 1 h, idle after 2 d, owed summaries after 30 d |
  | `meta`, `push_subs`, `sources` | one row, <= 25 devices, the operator's tokens | n/a |

## Abuse limits

One buggy pusher or a leaked token must not be able to spend the shared D1 / CPU budget.

- **Per-token rate limit** (Workers Rate Limiting bindings `RATE_LIMIT_HOST` 60 requests/min and
  `RATE_LIMIT_CLIENT` 60/min in `wrangler.toml`, keyed by source id; `429` with `Retry-After` on excess).
  60/min leaves room for a host with ~20 projects (each sends at most one request per 2 minutes in steady state with the current cadence, plus its
  events; 2-3 a minute before). A JSON-RPC batch of
  N messages is charged N units, not one.
  Syntax and the 10 s / 60 s period rule verified at
  https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ . Counters are per
  Cloudflare location and eventually consistent, so this is a guard rail, not accounting. The check
  needs the token's D1 lookup first, so it does not shield D1 from a flood of *random* tokens; that is the
  WAF rule's job (below). When a binding is absent (tests; local dev if the runtime lacks it) limiting is
  a no-op, and a failing limiter fails open.
- **WAF rate-limiting rule (recommended, configured in the dashboard, not in code).** In Security >
  WAF > Rate limiting rules add one for `http.host eq "dash.example.com"` and a path starting with
  `/api/ingest/` or `/mcp`, counting per IP, e.g. 600 requests per minute, action *Block*; it stops floods
  before the Worker runs at all. Which periods and how many rules your plan allows is plan-dependent:
  check the Cloudflare docs when you create it.
- **Per-client MCP caps:** at most 50 open MCP tasks per client token (`report_task` answers an `isError`
  result beyond that, a DONE report is not "open"; counting them reads at most the 50 open rows through
  `idx_tasks_source`, never the closed history); at most 10 messages per JSON-RPC batch; bodies over
  64 KiB are refused. There is no separate cap on a client's total task rows: they are bounded by the
  mutation budget below x the 30-day retention.
  - **Closed tasks are immutable.** `update_task` on a `done` / `failed` / `skipped` task is an `isError`
    result `task is closed; report a new task` (the UPDATE also re-checks the state atomically). Otherwise
    "report DONE, then move it back to IN_PROGRESS" would sidestep the open-task cap.
  - **Quiet and stale MCP tasks.** A desktop client without hooks often finishes without `update_task` DONE. An open MCP
    task with no update for its ETA + 30 min (2 h without an ETA) is shown under Working now as "No update since HH:MM
    (agent may have finished without reporting)" in a neutral style: no `overdue` alert, nothing in Needs you, no push
    (host-agent tasks keep the `overdue` rule unchanged). After 24 h without an update the maintenance tick closes it as
    `stale` (Recent results, labelled "no report"); BLOCKED tasks are never closed. A late `update_task` DONE on a stale
    task is still accepted; any other status is refused. `list_tasks` (MCP) / `siiswell tasks` (CLI) list a client's
    open tasks, and `siiswell update <task_id> --status DONE` closes one by hand.
  - **An update that changes nothing is free.** Same state, same ETA minute and no new summary writes
    nothing (no task row, no event, no rule run) and answers `{"task_id", "state", "unchanged": true}`, so a
    looping client cannot burn the D1 write quota with it, and it does not count towards the budget below.
  - **Mutation budget: at most `MAX_MCP_MUTATIONS_PER_DAY` = 1000** `report_task` + `update_task` calls that
    change something per client per **fixed 24 h window** (`src/env.ts`). The window is not rolling: it
    starts at the client's first change after the previous window ended and restarts exactly 24 h later
    (the first change after that starts the next one). The budget is an O(1) counter on the client's own
    `sources` row (`mut_window_start`, `mut_count`), claimed BEFORE the write with ONE conditional UPDATE
    (reset the window if it has ended, else increment, only while the count is below the cap; allowed
    exactly when one row changed, so concurrent claims cannot overshoot). Once the budget is spent that
    UPDATE is a primary-key lookup that reads one row and writes nothing, so an agent that retries the
    `isError` in a loop costs ~2 rows read per call (the token lookup and the claim): at the 60/min rate
    limit that is at most ~170 k rows read a day, not a scan. A write that fails after a successful claim
    (for example hitting the 50-open-tasks cap) still counts; updates that change nothing, `heartbeat` and
    `tools/list` never claim. Per mutation a client at its cap writes ~17 rows (claim 1, task row + indexes
    ~6, event + indexes ~4, the alert it opens ~6), so 1,000 a day is ~17 k rows written, 17 % of the Free allowance, and it stores at
    most 1,000 tasks + 1,000 events a day, i.e. at most ~30 k of each per client under the 30-day retention.
- **Host ingest write budget: `25,000 + 5,000 per project` estimated D1 rows per host token per fixed 24 h window,
  at most `MAX_HOST_WRITES_PER_DAY` = 50,000** (`hostWriteBudget` in `src/env.ts`: 1 project 30 k, 2 projects 35 k, 5 or
  more 50 k; same fixed-window O(1) counter pattern as the MCP budget, on the host's `sources` row:
  `wr_window_start`, `wr_count`). Each project is a reporter that legitimately sends a snapshot every 2 minutes (every minute with an older pusher), so the allowance
  grows with the projects the host has (30 at most); the ceiling is what one leaked token may cause (below). The unit is
  what D1 bills: a table row PLUS every index entry it touches (`WRITE_COST`: an event 4, a task insert or delete 6, a
  task update 4, a forwarded task 6 / 4, the claim of the source row itself 1 per request, **a snapshot row 1 (the first
  snapshot of a project 2): its size does not matter**). Before anything is
  written the request claims its estimated cost with ONE conditional UPDATE; over budget it is a
  `429 {"error":"write budget exhausted: ...","budgetExhausted":true,"budgetUntil":<ms>}` (every budget 429
  carries the flags, so the sender can stop retrying until then and keep heartbeating) with `Retry-After`
  (seconds until the window ends) and NOTHING is written (except the throttled liveness touch of the host row). An unchanged snapshot costs 2 (its row + the claim), an events batch of 100 costs
  401, a snapshot that replaces 100 tasks 1,202. The alerts a request opens or resolves are only known
  after the rules ran, so they are charged right after (opened 8 = row + key + the two alert indexes + its later
  resolve + its push claim, resolved 3, a rewritten notice 1): that can push the counter past the cap by at most one
  request's worth, and the next request is then refused. **Measured at the pusher's maximum cadence** (a changed
  snapshot per project per minute, the older maximum, twice what the current cadence sends; 6 agents, a task that flips every 15 minutes: `probe-p5-legit`, 24 h): 5 projects
  **16.6 k** rows (33 % of their 50 k), 8 projects **26.6 k** (53 % of 50 k); fix6 gave the same 16.6 k and ran the
  8-project host out of its 25 k after 22.5 h, and with 14 agents per project (4.5 KB stored) a 5-project host after
  19.3 h, because it also charged a row per 2 KB. `test/fix7.test.ts` repeats the simulation (one hour, extrapolated) and
  asserts that 2 and 14 agents cost the same and that 8 projects stay under 60 % of their budget. **Heartbeats are never budgeted** (they stay accepted, so a host over
  budget still shows as alive and `host-offline` stays quiet; their only possible writes are bounded by time:
  the host row once per 20 s and a project's `project_seen` row once per 90 s whatever they carry, `last_seen` once per 5
  minutes, and the resolve of an open host-offline / project-offline alert), and a spent budget costs one row read and no
  write per retry. The pusher should treat the 429 like any other transient error and back off for
  `Retry-After`.
  - **A spent budget is never silent.** (1) The first refusal of a window is recorded on the source
    (`budget_until`, one write per window) and the rules open a **critical `budget-exhausted` alert** for the
    host (pushed once; it is in the inbox and resolves by itself when the window ends). (2) The heartbeat
    response carries `{"ok":true,"budgetExhausted":true,"budgetUntil":<ms>}` while the budget is spent, so the
    pusher can log it (a host that is "alive" but refused would otherwise look healthy). (3) **Critical incident
    events (`benched`, `restart-failed`, `cli-gone`, `usage-limit`, i.e. `PUSH_HALT_SCENARIOS`) are always
    accepted, even over budget**, under their own small allowance of `MAX_CRITICAL_HALTS_PER_DAY` = 200 per
    host token and 24 h window (a separate counter, `hl_window_start` / `hl_count`): in that case ONLY the
    incidents of the batch are written (no other events, no forwarded rows), the answer is `200` with
    `"budgetExhausted":true,"budgetDropped":n`, and the agent-stuck alerts open and push as usual. A client
    token's spent MCP budget raises the same `budget-exhausted|<client>` alert at `warn` severity: an inbox
    item (` · via <client>`), never a push.
  - **Every alert is charged to the host that owns it, the cron included.** The rules run after every
    ingest AND every cron minute; the alerts one evaluation really opened or resolved (D1's `RETURNING` rows,
    not the rules' guess) are charged to the token whose label is `alert.host` (opened 8 = row + indexes + its
    later resolve + its push claim, resolved 3) with one statement, so alerts that age into existence in the
    cron (young pending actions, host-offline, overdue) are paid by their owner like any other write. It can push a
    counter past its cap by one evaluation's worth; the next claim is then refused.
  - **Worst case for one leaked host token** (everything it can make D1 write, per day): 50,000 budgeted
    rows (+ at most one evaluation's overshoot, ~1.5 k, + the critical-incident allowance: 200 incidents x (incident
    event 5 + alert 8) = 2.6 k) + liveness (the host row at most every 20 s = 4,320 writes, plus one `project_seen` row per
    project at most every 20 s = 4,320 a day for one project, and for a token that rotates over its 30 projects bounded only by
    the rate limit, <= 86,400 a day; no other write) + `last_seen` touches (<= 288) = **about 145 k rows written on the day
    (older cadence: ~55 k; the per-project liveness rows are the difference), and about double once the 30-day retention purge starts deleting what it wrote**: a token that is leaked for
    weeks and never revoked can use the whole Free allowance of 100 k/day by itself (on Workers Paid, the decided plan, it is
    nowhere near the 50 M a month that are included), which is the reason the budget
    has a CEILING (a ceiling of 175 k, 30 projects x 5 k, would not leave a day's room) and the `budget-exhausted`
    alert is critical and pushed. The normal load is ~11-17 k (see the quota estimate); a leaked host token at its
    ceiling AND a leaked client token at its cap (client: ~17 k, ~34 k with its purge) on top of the other hosts' normal
    load is ~55 k + ~17 k + ~11 k = ~83 k on the first day, then the purge doubles the write side: revoke a leaked token promptly, run
    `scripts/purge-source.ts`, and consider Workers Paid if you run many tokens. **Rows READ** are paid per
    evaluation and per request, see "Rule evaluations are throttled" below: one leaked host token that keeps every
    cap full and hammers at the rate limit can read up to **~9 M rows a day** (1.8 x the Free allowance) until it is
    revoked; a normal host with a tab open all day reads ~1 M. Its phone pushes are bounded too: at most 150 a day
    per host label (60 critical, 30 forwarded), see Push budgets.
  - **Rule evaluations are throttled per source, and their reads are bounded by the caps.** The rules run on every
    cron minute (1,440 a day) and after an ingest request, **but an ingest-triggered evaluation runs at most once per
    source per minute** (`EVAL_MIN_INTERVAL_MS` = 60 s, env `RULES_MIN_INTERVAL_MS` overrides, 0 = every request): the
    request that wins the slot stamps `sources.eval_at` in the SAME conditional UPDATE that claims its write budget
    (no extra statement, no extra write), the others are stored and left to the cron within the minute; an unchanged
    snapshot never evaluates or stamps; a critical incident that is accepted over a spent budget always evaluates (its own
    allowance of 200 a day bounds it); MCP evaluations follow mutations (1,000 a day). The first change after a quiet
    period evaluates at once, so a stuck agent is still pushed within seconds; during a burst the worst delay is the
    cron minute. **Rows read per evaluation** (`probe-rows`: rows returned x 2 for index + table, plus the probes): a
    normal 5-project host with a client **~56**; one leaked host token with EVERYTHING at its caps (30 snapshots, 400
    open tasks, 100 incident events, 362 alerts) **~2,000**. **Per day**: a normal 5-project host at the pusher's maximum
    cadence: <= 2,880 evaluations x 56 = ~160 k, its ingest requests (<= 3,600 changed snapshots, 5 projects x one per 2 min,
    x ~35: stored tasks, task upserts and deletes) ~126 k, one tab polling `/api/state` every 60 s while visible (~150 rows a
    call, 1,440 calls) **~216 k if left open 24 h (~72 k for 8 h)**: **about 0.5 M rows read a day, 10 % of the Free 5 M**; the
    older-cadence figure (a changed snapshot a minute, a poll every 20 s) was 1.1 M, the older README figure 1.6-2.7 M. **Worst case per leaked host token**: <= 2,880 evaluations x ~2,000 = 5.8 M, plus ~3 M for hammering
    the ingest at the 60-per-minute rate limit (each refused or unchanged request still reads the token row and the
    host's <= 30 project rows) = **up to ~9 M a day by itself** (fix6: ~10 M for evaluations alone from 1,030 open
    alerts, per the audit, and the alert scan and the inbox read EVERY open alert of every host, however many; now they
    read what they return), plus ~1.4 M if a tab is left polling its flooded inbox (~940 rows a poll, 1,440 polls; ~4 M at the older 20 s). The dominant term is the task scan (400 open tasks x index +
    table + the `latest_dispatch` seek of each blocked one): the caps `MAX_OPEN_TASKS_PER_HOST` and
    `MAX_RELAY_TASKS_PER_HOST` in `src/env.ts` are the levers if you hold many tokens.
  - **Worst case for one leaked host token, CPU** (what it can make every evaluation and every `/api/state`
    parse): at most 30 projects x 32 KB = ~1 MB of stored snapshots. Measured on the shim (so sqlite time
    included) with 30 snapshots of ~28 KB: a rule evaluation ~4 ms and `buildState` ~5 ms, against the Free
    plan's 10 ms CPU per request; before the caps 200 x 197 KB snapshots (39 MB) cost ~70 ms and ~80 ms. One
    leaked token therefore takes about half the Free CPU budget of a request, two take it all: Workers Paid
    (30 s) is the safe plan, and `scripts/purge-source.ts` the cure. The estimate is not a measurement; if
    you hold many tokens, lower `MAX_HOST_WRITES_PER_DAY` (and `HOST_WRITES_PER_PROJECT`) and the caps in `src/env.ts`.
  - **`GET /api/state` is bounded.** The inbox is read PER HOST (the newest `MAX_STATE_ALERTS_PER_HOST` = 100 open
    alerts of each host, 400 in all, a bounded seek of `idx_alerts_host` per host): a host with a thousand open alerts
    cannot lengthen the poll, and cannot push another host's alerts out of the inbox (a plain "newest 200 of all"
    showed none of `good`'s alerts while `evil` held 600 newer ones); when a host has more, `truncated` names `inbox`.
    Only ACTIVE threads (not finished ones), at most
    10 per project and 20 agents per project are returned, snapshot rows over twice the stored cap are skipped
    without being parsed, and the whole response is cut to <= 1 MB (`STATE_MAX_BYTES`): old events first, then
    threads, finished tasks, agent lists, open tasks, inbox items and finally projects. Whatever was cut is
    named in `truncated` and the UI shows a banner; a healthy installation (a few hundred KB) never sees any
    of it. (With 200 near-cap snapshots the old response was 39.7 MB, downloaded by every tab at every poll.)
  - **Claims never read `meta.changes`.** Every budget claim (MCP mutations, host writes, critical incidents,
    push slots, the open-task cap, the budget flag) is `UPDATE/INSERT ... RETURNING <column>`: it succeeded if
    and only if a row came back. D1 and the local runtime may count rows written by triggers in `changes`,
    so a future trigger on `sources` would otherwise make every request look over budget; `test/fix5.test.ts`
    runs the claims with a trigger on `sources` and a runtime that inflates `changes`, and a guard test fails
    if budget code starts reading `changes` again (see the comment in `migrations/0001_init.sql`).
- **Forwarded task cap: at most 10 distinct forwarded SENDERS per host** (`MAX_RELAY_SENDERS_PER_HOST`; stale ones, open
  with no update for 24 h, do not count), and behind it at most 50 task rows per host+project and 200 per host.
  The sender is a string the host's own payload names, so it cannot be what bounds the host: a host that
  invents senders gets the first 10 mirrored, the rest of its events are still stored but get no task row
  (`"relayDropped": n` in the response); senders already mirrored keep updating and may appear in many projects.
- **Push budgets (table `push_budget`, one row per budget key).** A push is charged to SEVERAL keys at once and
  must fit all of them, claimed atomically by ONE statement (every row remembers its own limits; a spent key
  leaves the others untouched). Names that come from the host's own payload (a forwarding sender, an agent name) can be
  invented at will, so none of them is what bounds a host. **The keys are typed and escaped** (`src/keys.ts`):
  `<kind>|<part>|...` with a fixed kind literal first, a fixed number of parts per kind, and every part escaped
  (`%` -> `%25`, `|` -> `%7C`), so no host label, client name, sender or agent can spell another source's key. fix6's
  keys were bare concatenations in ONE namespace: a host called `all` with a forwarding sender `victim` spelled the daily
  total `all|victim` of the client `victim`, and a host called `crit` forwarding for `relay` spelled the critical budget
  `crit|relay` of the host `relay`, so one source could spend (and exhaust) another's budget. The OWNER of a key (the
  host label / client name that pays for it) is stored in its own `owner` column, which is NOT NULL and what the
  code trusts (summaries are charged to it, `scripts/purge-source.ts` deletes by it); a key is never parsed to find
  it, and `ensure` never re-assigns it. `test/fix7.test.ts` builds every key kind over a set of adversarial names
  (`all`, `crit`, `relay`, `a|b`, `%7C`, `constructor` ...) and asserts that no two tuples, of any kinds, collide.

  | alert | keys it must fit |
  |---|---|
  | host-agent **critical** (agent-stuck, usage-limit, host-offline ...) | `ct|host`: 30 an hour and **60 a day**; `ca|host|agent`: **one per agent per 30 min**; `all|host` |
  | **forwarded** foreign agent | `rs|host|sender`: 3 per 10 min, 30 a day; `rt|host` over ALL its senders: **10 per 10 min and 30 a day**; `all|host` |
  | other host-agent (blocked, overdue, pending action ...) | `own|host`: 3 per 10 min; `all|host` |
  | MCP client | `own|client`: 3 per 10 min, 30 a day; `all|client` |

  `all|owner` is **everything one host label or client may push in a day: 150** (`MAX_PUSHES_PER_OWNER_PER_DAY`),
  summaries included. the host-agent's critical alerts are exempt from the ordinary 3-per-10-min budget (a critical
  cli-gone used to wait ~10 minutes behind three forwarded BLOCKED pushes) but are still deduplicated by alert key and
  meet the caps above. Alerts beyond a budget are NOT lost: they stay open in the inbox, are marked
  `summarized_at` (not `push_count`, see above), are counted on the budget key that held them (`suppressed`:
  `ct|host`, `rt|host`, or `own|owner`) and when its window is over the cron sends ONE push
  `N more items via <key>` (`flushPushSummaries`, at most 3 keys per minute). **A summary is a push like any
  other: it takes a slot from the key and from the owner's `all|owner` day**, so summaries count towards what a
  host may push per day and a host that is out of day pushes nothing more, critical alerts included (they are
  summarised for tomorrow). A failed summary puts the count and the slots back and is retried. The notification
  `tag` of everything that is not host-agent is `src:<key>`, and the push payload carries `renotify: false` for
  non-critical alerts. Without a VAPID key or a subscription nothing is consumed. Rows are purged by `touched`
  (see Retention): never-claimed ones after an hour, idle ones after two days.
  **A leaked host token's ceiling is therefore 150 phone pushes a day** (at most 60 of them critical, 30 forwarded),
  whatever agent names, forwarding senders or projects it invents; before, invented forwarding senders bought a push each
  (101 pushes measured in 24 h for 50 invented senders x 20 projects, now 12) and invented agent names 30 an hour
  (81 pushes in 24 h measured with the alert caps in the way, 720 in theory, now 60).
- **One invocation stays inside the Free plan (50 D1 queries, 50 subrequests).** `dispatchPushes` reads
  the subscriptions ONCE, handles at most `MAX_PUSHES_PER_INVOCATION` = 5 alerts per invocation (fewer
  when alerts x devices would exceed `MAX_PUSH_SUBREQUESTS` = 40 sends; the rest simply wait for the next
  cron minute, a backlog of 30 drains in six minutes), claims them with one statement, sends to every
  device in parallel under an overall `PUSH_DEADLINE_MS` = 20 s deadline (a push service that never
  answers cannot hold the invocation), and rolls back whatever was claimed but not delivered.
- **Push fairness: one noisy source cannot fill the slots.** The alerts due are ordered host-agent before
  MCP / forwarded, critical before the rest, then the OLDEST first (closest to ageing out of the 60-minute
  retry window). Budget keys that are already spent are taken out of the running (one lookup of their budget
  rows) and their alerts are summarised in bulk (at most 50 per invocation); the slots go round-robin over the
  remaining OWNERS (a host label or client name; forwarding senders and agent names collapse into their owner, and
  the host-agent's critical alerts of an owner are a group of their own), **at most
  `MAX_PUSH_SLOTS_PER_SOURCE_PER_INVOCATION` = 2 per group per invocation**. A client or a host that raises a
  thousand alerts, under however many invented names, therefore holds 2 of the 5 slots and delays no host-agent critical push (it goes out in
  the very first invocation), and every alert gets its turn within a few cron minutes, long before the
  retry window ends (`test/suppression.test.ts`).
  `test/pushbudget.test.ts` runs a batch of 10 MCP reports plus their pushes, and 30 simultaneous
  host-offline alerts through the cron, and asserts < 50 D1 statements and < 50 fetches each.
- **Per-source isolation** as described above: every source can only write rows that carry its own label.

### Usage ingest (`POST /api/ingest/usage`): worst case of a leaked host token

Every bound sits BEFORE any read of `usage_daily`, and a REFUSED request writes nothing. After the token lookup a request makes two atomic claims, in this
order: the host's ordinary write budget (the request, its statements and the `usage_hosts` stamp), then the host's usage allowance. Nothing is ever refunded.
- **Allowance**: 60 000 units per host and fixed 24 h window. A request is charged for the rows it SUBMITS (not for what survives the per-day cap or
  changes) plus 30 units per distinct day it touches (the per-day count / stale scan). A request carrying a day older than 40 days ("history") may use 80 % of
  the allowance; this is judged from the data, not from the client's `mode` label, so relabelling a batch changes nothing and recent pushes keep their 20 %.
  A request without rows needs no allowance and stamps liveness at most once a minute.
- **Over the per-day cap**: the pusher folds a day with more than 300 keys itself (the smallest into one `(other)` row, sums exact); if the Worker still refuses rows it
  answers `capped: n` and the pusher logs a warning once per rollup version.
- **Distinct days per request**: at most 35 (the rows' days; `completeDays` may only name days that HAVE rows), refused with 400 before any read.
- **Rows stored**: at most 300 distinct rows per host and day, enforced INSIDE the INSERT (atomic under concurrency); days outside [retention window .. tomorrow]
  are dropped; counters are capped (1e11 tokens, 1e7 requests, $1e7 per row-day) and every read sums with `TOTAL()`.
- **Deletes** (`completeDays` replaces the host's rows of those days) are charged AFTER the fact with their real count to the usage allowance (never to the host write
  budget, which is the snapshots'); they can only remove rows the host itself wrote, each of which was charged when it went in.
- **Rows read per request**: the INSERT counts each distinct day once by a primary-key seek (<= 300 rows), a declared day is scanned once more for stale rows
  (<= 300), plus about three point lookups per submitted row (insert guard, update, the stored-count): <= 35 x 600 + 6 000 ~ 27 k rows. A request touching 35 days costs >= 35 x 31 = 1 085 units, so at most
  ~55 such requests fit the allowance (~44 of history): **<= ~1.4 M rows read a day per leaked token** (uploads; erase adds <= ~2 M, below). Refused requests read ~4 rows each (the per-token
  rate limit and the host write budget, ~5 units a request, bound them to ~10 k a day: ~40 k rows).
- **Rows written per day**: <= 60 000 inserts / updates (the allowance) + deletes of rows the host wrote itself (post-charged to the same allowance, so they cannot
  run on top for free) ~ **<= ~120 k**, plus <= 50 000 bookkeeping writes of the host budget (one `sources` row per request). Paid-plan territory: the Free plan's
  100 k/day is not enough for a token that abuses this route (it is for normal use: ~1 000 units a push, 96 pushes a day).
- **When the reporter erases**: only when usage is turned off, or the privacy policy gets stricter (names "all" -> "dashboard", or a project left the dashboard); a project
  that JOINS only triggers the full re-upload (each day is replaced authoritatively). A malformed config needs two looks a poll apart before an erase starts.
- **A large first upload**: with ~60 rows a day the whole history (~800 days) is ~48 k rows, i.e. the whole 80 % share of the first window: toward the end of that
  window a recent push can answer 429 for some hours. Nothing is lost: the next window's lookback (30 h before the last DELIVERED rollup) re-sends what was refused.
- **Erase** (`{v: 1, host, mode: "erase"}`): deletes the token-bound host's OWN usage rows (<= 35 x 300 = 10 500 per request), found by one primary-key seek per day
  of the retention window (<= ~830 seeks, no scan of other hosts' rows); `remaining: 1` = send another request. Claimed first from the host write budget
  (a FIXED 20 units, a refusal writes nothing); the rows really deleted are charged to the USAGE allowance (so erasing 48 k rows cannot starve the snapshots'
  budget) and an erase is limited to what is left of it: with the allowance spent it answers 429 and the pusher continues in the next window. Worst case of abusing it: <= ~2.5 k requests a day (50 000 / 20) x ~0.85 k reads =
  **~2 M rows read**; deletes are bounded by what the host itself wrote and by the 60 000-unit allowance (writes <= 60 000 a day for erase + uploads together). The `usage_hosts` row (and with it the allowance window) is kept until its window is over, so erasing
  cannot be used to reset the allowance, and neither can the retention purge: it never removes a `usage_hosts` row whose allowance window is still running (condition on `win_start`,
  not on `pushed_at`). The erase reserves its rows with ONE atomic UPSERT (a missing row is created with a fresh window, concurrent first requests share it) and gives back what it did not use.
- A model id is stored only when it is an id of the price table (else `unknown`); no free text reaches the table.

## D1 quota estimate (5 projects)

D1 Free: **5 M rows read / day and 100 k rows written / day**, reset at 00:00 UTC; beyond that D1 refuses
queries until the next day. Rows read = rows *scanned* (so indexes matter; every hot query here is
index-backed, checked by `test/queries.test.ts` with `EXPLAIN QUERY PLAN`); rows written = every
INSERT/UPDATE/DELETE **plus one per index entry touched**
(https://developers.cloudflare.com/d1/platform/pricing/). Workers Free also allows 100,000 requests/day
and 10 ms CPU per request (https://developers.cloudflare.com/workers/platform/pricing/). The figures below
are an ESTIMATE from the query shapes, not a measurement: assume 5 projects on one host, a snapshot
every 2 minutes whenever something changes (the pusher's maximum; it used to be one a minute), one heartbeat per 2 minutes
otherwise, ~300 changed task rows, ~200 events and ~40 alert changes a day, one dashboard tab polling every 60 s while visible
(it was 20 s). The simulation figures quoted below (16.6 k rows written) were measured at the old once-a-minute maximum.

| per day | rows written | rows read |
|---|---|---|
| snapshots, changed (<= 3,600) | 7,200 (the row + the claim of the source row, 2 each; **measured 16.6 k a day for the whole simulated host at the old maximum of 7,200 snapshots**, task churn and alerts included: about half of that now) | ~126 k (about 35 rows each: the project list, the stored tasks, the task upsert and replace) |
| snapshots, unchanged | 2 each (row + claim), no task writes, no rule run | ~8 each |
| heartbeats (<= 3,600, shared with the snapshots) | ~0 for the heartbeat itself; **every message (snapshot, heartbeat, events batch) also writes the host row and the project's `project_seen` row, ~2 rows each: ~7.6 k a day for 5 projects** (alert resolve is a no-op) | ~10 k |
| task changes (~300 updates, ~100 inserts) | ~1,500 (an update touching `state`/`updated` writes ~3 rows, an insert ~6) | included above |
| events + forwarded tasks (~200) | ~1,100 (~4 each incl. indexes) | small |
| alerts (~40) + `sources.last_seen` (~300) | ~600 (an alert costs 4 rows to open, 3 to resolve, 1 per push) | small |
| rule evaluations: cron 1,440 + ingest-triggered <= 1,440 (one per minute per source) | the alerts they open / resolve (above) | **~160 k (about 56 rows per evaluation: 5 snapshots, 13 open tasks, 1 incident, 2 alerts, hosts, probes)** |
| purge, at most every 15th minute (cron or opportunistic, <= 500 rows per table and run) | ~1,500 once the first 30 days are full | small |
| `/api/state` polling, 60 s, visible tab only | 0 | ~150 rows per call (the inbox is a bounded seek per host): ~72 k for an 8 h day, ~216 k for a tab left open 24 h |
| **total, busy day** | **~22 k (about 22 % of 100 k): ~9.4 k snapshots and tasks, ~1.1 k events, ~0.6 k alerts, ~7.6 k host / project liveness rows, ~2 k purge** | **~0.4 M to ~0.5 M (about 8-10 % of 5 M)** |

The previous estimate (~11 k written, 1.6-2.7 M read) predates the measured simulation, the throttle and the
per-host seeks; the number of rows read per evaluation and per poll is the one `probe-rows` prints (rows returned x 2
for index + table, plus the probes). With a busier installation (300 tasks in the 24 h window, 100 events) a poll
reads ~700 rows and an evaluation ~250: ~1 M for a tab left open 24 h (3 M at the old 20 s poll), still inside the allowance.

Worker requests: ~4 k ingest (5 projects x 720 a day + events) + ~1.4 k state (a tab left open 24 h) + MCP/assets/cron, about 5 % of the 100 k/day
allowance (older cadence: ~14 k + ~4 k, about a fifth).

MCP clients are budgeted separately (`MAX_MCP_MUTATIONS_PER_DAY` = 1000 changing calls per client per
fixed 24 h window, no-op updates free, closed tasks immutable; see [Abuse limits](#abuse-limits)): a client
at its cap adds ~17 k rows written a day (the same again, deletes, once the purge catches up), and a
host token at its write budget (`25,000 + 5,000 per project`, at most `MAX_HOST_WRITES_PER_DAY` = 50,000, see Abuse limits)
up to ~55 k, then ~110 k a day with the purge. A client that keeps retrying after the budget is spent adds
only ~2 rows read per call (<= ~170 k a day at the 60/min limit). The rows a client can leave behind are
bounded by budget x retention: 1,000 tasks and 1,000 events a day, ~30 k of each over the 30 days. A
handful of busy or misbehaving clients still fits in the Free allowance, but ten of them at the cap would
not (that is also when to move to Paid).

**When Paid becomes necessary:** (1) most likely first, **CPU**: Free allows 10 ms per request and per cron
run, and parsing/sanitising a large snapshot or verifying an Access JWT can exceed that regardless of D1;
(2) **rows read** reach 5 M/day with roughly 15-20 continuously changing projects, or with two or three
dashboards left open around the clock (each is ~0.65 M with a normal inbox, ~4 M while a host floods it); (3) heavy MCP use (many clients reporting). Writes
are not the constraint. Because exhausting the Free quota silently blinds the dashboard and its alerts,
upgrade before adding projects beyond ~10 or a second always-on viewer. Paid (USD 5/month) includes 25 B
rows read and 50 M rows written per month.

## Security notes

- A leaked ingest or client token can only write fake status for its OWN host label / its own source,
  never act, and never touch another source's rows: v1 has no control surface.
- After revoking a leaked token run `bun scripts/purge-source.ts <name>` (it prints, never runs, the DELETEs
  for every row that source wrote: events, tasks, snapshots, hosts, its alerts and its push budgets, found by their `owner`) and then
  `new-token.ts --rotate` if the source should write again.
- No chat credential exists anywhere in Cloudflare or the browser.
- `ACCESS_ALLOWED_EMAILS` (set it, see the deploy checklist) is a second lock behind the Access policy for
  `/api/state` and the push routes.
- The stdio bridge `bridge/siiswell-bridge.mjs` never follows a redirect (`fetch(..., { redirect: "error" })`):
  a misconfigured or hijacked `SIISWELL_URL` that answers 30x cannot make it replay the bearer token
  to another host; it logs "the server answered with a redirect, which is refused" and reports the
  dashboard as unreachable.
- A bearer value that is not `oct_` + 43 base64url characters is rejected before any database lookup.
- Stored text is summaries only (<= 300 chars, redacted); retention is `RETENTION_DAYS` (default 30), enforced by a
  purge that works with or without the cron trigger (see Retention).
- **Links are never stored.** A shared document is one capability URL (a presigned S3 / GCS / Azure link, a pCloud
  `publink/show?code=`, a Google Drive `file/d/<id>`, a Dropbox `rlkey=`, an OAuth `?code=`), so every text field a
  host or an MCP client sends (task titles and last lines, thread topics, pending-action summaries, event text, MCP
  title / summary) goes through `clipText`, which strips every URL to scheme + host: `https://host/anything?x#y`
  becomes `https://host/[link]` (also `ftp://`, `s3://bucket/key`, `gs://`, `file:///`, `www.host/...`,
  `host.com/...` for the common public suffixes, markdown `[text](url)`, `<url>`, JSON-escaped `https:\/\/`; the user
  part of `user@host` goes too). It runs in the Worker on every ingest regardless of the pusher's version, so a
  Worker-only deploy protects D1 before any host-side pusher is updated. The step is `redactLinks` in the shared
  `src/shared/redact.ts` (linear time, covered by the ReDoS tests); `redactSecrets`, which the ledger and the
  chat notices use, deliberately keeps real links for the operator. Free text such as a client name or an amount in
  a task title is NOT stripped by the Worker: the host-side pusher's text-privacy mode does that before
  anything is sent: `full` = today's text, `titles` (the pusher's default) = titles cut to 80
  chars with money amounts masked, no reply text, STATUS events with state + ETA only, incidents with their headline
  only, pending actions as "action pending (agent)", no thread topics; `none` = `task for <agent>`. The pusher
  states its mode in the snapshot (`textMode`, stored with it, returned per project by `/api/state`; absent = an
  older pusher = `full`) and the page then shows "details hidden (privacy mode) - see the host's chat" on a working task
  without text; it also drops the chat channel id and sends chat event ids only as a 16-hex hash (the Worker
  uses the event key only to dedupe within a source; a pusher upgraded mid-run may show one event twice).
  Text modes are host-agent-only: an MCP client chooses its own wording (see [CLIENTS.md](../CLIENTS.md)).
- **Browser API: no cross-site reads.** `/api/state` and `/api/push/*` answer 403 to a request with
  `Sec-Fetch-Site: cross-site`, or with an `Origin` header that is not `PUBLIC_URL`'s origin (on a localhost request its
  own origin is accepted, for `wrangler dev`); requests with neither header (curl, same-origin GETs) pass to the
  Access check. The Worker never sends an `Access-Control-Allow-*` header, so another origin cannot read these
  responses even if a request went out with the viewer's Access cookie. **`PUBLIC_URL` must equal the origin the
  dashboard is actually opened on** (scheme + host + port, no path, e.g. `https://dash.example.com`): a browser that
  opens it under any other origin (another hostname, `http://`, a different port) sends an `Origin` that does not match,
  so its POSTs to `/api/push/*` (and any request with a foreign `Origin`) get 403. Change `PUBLIC_URL` together with the
  custom domain.
- **HSTS.** Every Worker response carries `Strict-Transport-Security: max-age=31536000`, and so do the static assets
  (`public/_headers`, because assets are served without running the Worker); the CSP is unchanged.
- The UI writes API data with `textContent` only, and `public/_headers` sets a strict CSP
  (`default-src 'none'`, scripts/styles/connect from self only). The theme script is an external file loaded from `<head>`
  (`theme.js`), not inline code, so the CSP needed no change; `test/theme.test.ts` fails if an inline script / style appears.
- Secrets live only as Worker secrets (`VAPID_*`) or in the gitignored `.dev.vars`; nothing secret is
  committed. Bearer tokens must never go in a URL, a repo or a screenshot. **Delete the `.dev.vars` you
  create for local runs (and the scratch `.wrangler/` state) when you are done**; `scripts/smoke-local.ts`
  needs it only while it runs.
- Rate limits and caps: see [Abuse limits](#abuse-limits).
- `workers_dev = false` and `preview_urls = false` keep the Worker off public `*.workers.dev` URLs.
