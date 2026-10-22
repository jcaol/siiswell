/**
 * @file Worker environment bindings and the tiny execution-context contract.
 * @module dashboard-worker/env
 */

import { BUILD } from "./build-info";
export const DASHBOARD_VERSION = BUILD.version;

export interface Env {
  /** D1 database (wrangler.toml [[d1_databases]]). */
  DB: D1Database;
  /** Static assets binding (wrangler.toml [assets]). */
  ASSETS: Fetcher;

  /** Public origin of the dashboard, e.g. "https://dash.example.com". */
  PUBLIC_URL: string;
  /** Zero Trust team domain ("myteam.cloudflareaccess.com"). Empty = Access not configured. */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application AUD tag. */
  ACCESS_AUD: string;

  /** Secrets (wrangler secret put). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;

  /** "1" keeps the `lastLine` text of host snapshots (the last status line of a task); unset / "0" (default) drops it before storage. */
  ACCEPT_LAST_LINE?: string;
  /** Server ceiling for task text: "full" | "minimal" (default) | "none". Applied to report_task / update_task before storage. */
  ACCEPT_TASK_TEXT?: string;
  /** Server ceiling for the free text of host snapshots and events: "full" | "brief" | "minimal" (default) | "none". */
  ACCEPT_HOST_TEXT?: string;
  /** Dev only (.dev.vars): "1" skips Access verification, honoured for localhost requests only. */
  DEV_NO_ACCESS?: string;
  /** Optional comma-separated extra push-service host suffixes accepted by /api/push/subscribe. */
  PUSH_ALLOWED_HOSTS?: string;
  /** Optional comma-separated extra Origins accepted by /mcp (besides PUBLIC_URL and localhost). */
  MCP_ALLOWED_ORIGINS?: string;
  /**
   * Optional comma-separated list of e-mail addresses allowed to use the browser API. When set, a valid
   * Access JWT must also carry one of them in its `email` claim (case-insensitive); service-token JWTs
   * (no e-mail) are then refused. Empty/unset = any identity the Access policy lets through. Set it.
   */
  ACCESS_ALLOWED_EMAILS?: string;

  /**
   * Workers Rate Limiting bindings (wrangler.toml [[ratelimits]]), keyed by source id. Optional on
   * purpose: when a binding is absent (tests, `wrangler dev` builds without it) limiting is a no-op.
   */
  RATE_LIMIT_HOST?: RateLimit;
  RATE_LIMIT_CLIENT?: RateLimit;

  /** Optional override of EVAL_MIN_INTERVAL_MS, in milliseconds ("0" = every ingest evaluates the rules). */
  RULES_MIN_INTERVAL_MS?: string;

  /**
   * How many days the retention purge keeps events, tasks, resolved alerts, snapshots and hosts (whole days, >= 1).
   * Unset / invalid = ALERT_DEFAULTS.retentionDays (30). Lower it (wrangler.toml [vars], or the dashboard) to keep
   * less data on Cloudflare.
   */
  RETENTION_DAYS?: string;

  /**
   * How many days the purge keeps usage_daily rows (whole days, >= 31, <= 3650). Unset / invalid = USAGE_RETENTION_DEFAULT_DAYS (800).
   * Numbers only live in that table, so it is kept far longer than RETENTION_DAYS.
   */
  USAGE_RETENTION_DAYS?: string;

  /**
   * "0" switches off the housekeeping that runs after an ingest / state read (retention purge, time-based rules:
   * see maintenance.ts). Leave it unset: it exists for tests, and for an operator whose cron trigger is known to
   * work and who wants requests to do nothing but their own work.
   */
  OPPORTUNISTIC_MAINTENANCE?: string;

  /**
   * Durable Object namespace of the ticker (wrangler.toml [[durable_objects.bindings]], class OrchTicker, one global
   * instance `idFromName("main")`): its alarm is the cron-independent clock, see ticker.ts. Optional on purpose: absent
   * in tests and wherever the binding was not deployed (nothing then starts it).
   */
  TICKER?: DurableObjectNamespace;
  /** "0" switches the ticker off: nothing arms an alarm and a pending alarm stops without re-arming. (The binding itself is named TICKER, so the switch cannot be.) */
  TICKER_ENABLED?: string;

  /**
   * "0" switches the well-being push policy off (wellbeing.ts: tiers, digest, quiet hours, Focus, storm control): every due
   * push then goes out on its own, as before migration 0007. Unset = on. The re-push cooldown (15 -> 30 -> 60 -> 120 min) is
   * part of the rules and applies either way.
   */
  WELLBEING_PUSH_POLICY?: string;

  /**
   * The dashboard's IANA time zone (default UTC): the usage page's days, the zone of uploads that name none, and the well-being
   * layer's zone until the user sets one. A deployment whose data was bucketed in another zone sets it here (src/tz.ts).
   */
  DASHBOARD_TZ?: string;

  /** "1" turns on `POST /api/ingest/otlp` (OTLP/HTTP JSON metrics from Claude Code into usage_hourly, see src/otlp.ts). Off otherwise. */
  OTLP_INGEST?: string;
}

/** Per-token request budget per minute (documented in wrangler.toml, enforced by the bindings). */
export const RATE_LIMIT_PER_MINUTE = { host: 60, client: 60 } as const;

/**
 * Host ingest write budget: the most D1 ROW WRITES (estimated, index entries included, see WRITE_COST)
 * one host token may cause per fixed 24 h window; over budget is a 429 (heartbeats stay accepted).
 * It SCALES WITH THE HOST'S PROJECTS (each project is a reporter that legitimately sends a snapshot a minute) up to
 * a ceiling, see `hostWriteBudget`: a busy 8-project host stays at about half of it, and one leaked token is still
 * bounded to the ceiling + one request's overshoot + the critical-halt allowance + ~1 k of heartbeat writes a day
 * (about double once the retention purge deletes what it wrote), below the Free plan's 100 k/day.
 */
export const HOST_WRITES_BASE = 25_000;
export const HOST_WRITES_PER_PROJECT = 5_000;
export const MAX_HOST_WRITES_PER_DAY = 50_000;
/** The write budget of a host that has `projects` projects (counting the one a request is about to create). */
export function hostWriteBudget(projects: number): number {
  return Math.min(MAX_HOST_WRITES_PER_DAY, HOST_WRITES_BASE + HOST_WRITES_PER_PROJECT * Math.max(0, Math.floor(projects)));
}
/**
 * Estimated rows written per logical write: 1 table row + the index entries it touches (what D1 bills). `request`
 * is the claim UPDATE of the source row itself (written by every accepted request). A snapshot is ONE row however
 * large (the byte cap bounds storage and reads, not writes): `snapshotRow` rewrites the (host, project) row, whose
 * key does not move, `snapshotInsert` is the first snapshot of a project (row + primary-key index). `alertOpen` is
 * an alert's whole life (insert 4 = row + key + the two alert indexes, its later resolve 3, the push claim 1),
 * charged AFTER the rules ran for the alerts a request opened or resolved, so alert churn cannot hide behind a
 * cheap snapshot or event.
 */
export const WRITE_COST = { request: 1, snapshotRow: 1, snapshotInsert: 2, taskInsert: 6, taskUpdate: 4, taskDelete: 6, event: 4, haltEvent: 5, relayInsert: 6, relayUpdate: 4, alertOpen: 8, alertResolve: 3, noticeRefresh: 1 } as const;
/**
 * Critical halt events (scenario in PUSH_HALT_SCENARIOS: benched, restart-failed, cli-gone, usage-limit) are
 * accepted even when the write budget is spent, under this separate small allowance per host token and
 * fixed 24 h window, so a spent budget can never silence the one signal the operator must get.
 */
export const MAX_CRITICAL_HALTS_PER_DAY = 200;
/** Relay (foreign agent) task rows one host+project may hold; new senders beyond it are not mirrored. */
export const MAX_RELAY_TASKS_PER_PROJECT = 50;
/** ... and one host may hold in all its projects (every rule scan partition stays within its limit). */
export const MAX_RELAY_TASKS_PER_HOST = 200;

// ── structural caps per host token: what one token can make the Worker STORE and PARSE ──────────────
/** Projects one host may have (a snapshot for a new project beyond it is a 429; existing ones keep working). */
export const MAX_PROJECTS_PER_HOST = 30;
/** Stored (and counted) per snapshot: items beyond these are dropped and reported in `dropped`. */
export const MAX_STORED_AGENTS = 20;
export const MAX_STORED_DISCUSSIONS = 10;
export const MAX_STORED_APPROVALS = 20;
/** A stored snapshot (without its tasks) larger than this is refused with 413. */
export const MAX_STORED_SNAPSHOT_BYTES = 32 * 1024;
/** Running + blocked host-agent tasks one host may have across its projects; further ones are dropped (counted). */
export const MAX_OPEN_TASKS_PER_HOST = 200;
/**
 * Open alerts per owner (a host label, or an MCP client name) are capped at THREE levels, so no source can grow the
 * alert table (and with it every evaluation's reads) and none can touch another source's alerts (the alert `host`
 * is the token-bound label, see alerts.host):
 *  - NON-CRITICAL alerts per host+project (and, within them, approval-waiting alerts per host+project);
 *  - NON-CRITICAL alerts per host in all (the sum over its projects stays under the per-host scan limit);
 *  - CRITICAL alerts (agent-stuck, usage-limit, ...) per host in all.
 * Beyond a cap the oldest are evicted for the newest (a host-agent alert outranks a relayed foreign agent's) and ONE
 * `alerts-capped` item per cap says how many did not fit, so nothing disappears silently. host-offline,
 * budget-exhausted and the alerts-capped items themselves are never counted (at most one per host / source / scope).
 */
export const MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT = 20;
export const MAX_OPEN_ALERTS_PER_PROJECT = 50;
export const MAX_OPEN_ALERTS_PER_HOST = 200;
export const MAX_OPEN_CRITICAL_ALERTS_PER_HOST = 60;
/** Events older than this are refused (their `at` is what the rules and the relay stale check go by). */
export const EVENT_MAX_AGE_MS = 24 * 60 * 60_000;
/** Relay task rows still open (running/blocked) with no update for this long are stale: not shown, not alerted. */
export const RELAY_STALE_AFTER_MS = 24 * 60 * 60_000;

/** Phone pushes: at most this many per source per window; the rest are summarised in ONE later push. */
export const MAX_PUSHES_PER_SOURCE_PER_WINDOW = 3;
export const PUSH_WINDOW_MS = 10 * 60_000;
/** Daily cap per budget key for everything that is NOT a host-agent alert (MCP clients, relayed agents). */
export const MAX_PUSHES_PER_SOURCE_PER_DAY = 30;
/**
 * the host agent's own CRITICAL alerts are exempt from the ordinary per-window budget (a critical cli-gone must
 * not wait behind relayed BLOCKED pushes); they are still deduplicated by key and capped by this generous
 * safety limit per host and hour.
 */
export const MAX_CRITICAL_PUSHES_PER_HOUR = 30;
export const CRITICAL_PUSH_WINDOW_MS = 60 * 60_000;
/**
 * ... and per DAY, plus one critical push per host+agent per 30 minutes: agent names (like relay senders) come
 * from the host's own payload, so a leaked token could otherwise mint a "new" critical alert per invented name
 * and buy 30 pushes an hour all day.
 */
export const MAX_CRITICAL_PUSHES_PER_DAY = 60;
export const CRITICAL_AGENT_DEDUPE_MS = 30 * 60_000;
/**
 * A relayed foreign agent's alerts have a budget of their own per sender, but the sender is a string the host
 * sends, so ALL relay senders of a host also share this aggregate budget, and a host may only have this many
 * distinct relay senders.
 */
export const MAX_RELAY_PUSHES_PER_WINDOW = 10;
export const MAX_RELAY_PUSHES_PER_DAY = 30;
export const MAX_RELAY_SENDERS_PER_HOST = 10;
/** Everything one owner (host label / client name) may push per day, whatever the names it invents; summaries count. */
export const MAX_PUSHES_PER_OWNER_PER_DAY = 150;
/** Pushes sent per Worker invocation (the rest wait for the next cron minute), and the subrequest budget they share. */
export const MAX_PUSHES_PER_INVOCATION = 5;
export const MAX_PUSH_SUBREQUESTS = 40;
/** Fairness: of those, no source may take more than this many slots in one invocation (round-robin). */
export const MAX_PUSH_SLOTS_PER_SOURCE_PER_INVOCATION = 2;
/** Alerts of sources whose push budget is spent that one invocation settles into their summary count. */
export const MAX_SETTLED_PER_INVOCATION = 50;
/** Overall deadline for one dispatch (each push request also has its own 8 s timeout). */
export const PUSH_DEADLINE_MS = 20_000;
/** Open alerts /api/state returns per host (newest first, a bounded seek of idx_alerts_host each) and in all. */
export const MAX_STATE_ALERTS_PER_HOST = 100;
export const MAX_STATE_ALERTS = 400;
/**
 * Ingest-triggered rule evaluations run at most once per source per this long (the cron evaluates every minute
 * anyway): a source cannot buy an evaluation (a few hundred rows read) per request. `RULES_MIN_INTERVAL_MS` in the
 * environment overrides it (0 = every request evaluates, which the tests use).
 */
export const EVAL_MIN_INTERVAL_MS = 60_000;
/** Most open MCP tasks one client may hold. */
export const MAX_OPEN_MCP_TASKS = 50;
/**
 * Most report_task + update_task calls that CHANGE something one client may make per 24-hour window
 * (a FIXED window starting at its first change, kept as a counter on its `sources` row: O(1) to claim).
 * Stored MCP rows are therefore bounded by this x the retention (1000/day x 30 days).
 */
export const MAX_MCP_MUTATIONS_PER_DAY = 1000;

/** The only part of ExecutionContext the app needs (tests pass a collecting stub). */
export interface AppCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/** The throttle of ingest-triggered rule evaluations in effect (env override, else the default). */
export function evalMinIntervalMs(env: Pick<Env, "RULES_MIN_INTERVAL_MS">): number {
  const raw = env.RULES_MIN_INTERVAL_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : EVAL_MIN_INTERVAL_MS;
}

/** The retention period in effect, in days: `RETENTION_DAYS` (a whole number >= 1), else `fallback`. */
export function retentionDaysOf(env: Pick<Env, "RETENTION_DAYS">, fallback: number): number {
  const raw = env.RETENTION_DAYS;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(3650, Math.floor(n)) : fallback;
}

/** Usage rows (numbers and labels only, no free text) are kept this long unless `USAGE_RETENTION_DAYS` says otherwise. */
export const USAGE_RETENTION_DEFAULT_DAYS = 800;
/** The usage retention in effect, in whole days. */
export function usageRetentionDaysOf(env: Pick<Env, "USAGE_RETENTION_DAYS">): number {
  const raw = env.USAGE_RETENTION_DAYS;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 31 ? Math.min(3650, Math.floor(n)) : USAGE_RETENTION_DEFAULT_DAYS;
}

// ── usage ingest / read limits ───────────────────────────────────────────────────────────────────────
/** Rows per usage ingest request, and the request body cap. */
export const MAX_USAGE_ROWS_PER_REQUEST = 2000;
export const MAX_USAGE_BODY_BYTES = 1024 * 1024;
/** Usage rows one host token may submit per fixed 24 h window (rows, claimed before anything is written; a full history is ~40 k). */
export const MAX_USAGE_ROWS_PER_HOST_PER_DAY = 60_000;
/** Distinct (project, agent, source, model) rows one host may hold for ONE day: invented labels cannot grow the table past this. */
export const MAX_USAGE_ROWS_PER_HOST_DAY = 300;
/** `/api/usage`: widest day range, rows of the per-project / breakdown / series answers. */
export const MAX_USAGE_RANGE_DAYS = 400;
export const MAX_USAGE_PROJECTS = 100;
export const MAX_USAGE_BREAKDOWN = 600;
/** Hourly usage rows (migration 0005): per request, per host and day, and how many days they are kept (daily rows stay far longer). */
export const MAX_USAGE_HOURLY_ROWS_PER_REQUEST = 4000;
export const MAX_USAGE_HOURLY_ROWS_PER_HOST_DAY = 1200;
export const USAGE_HOURLY_RETENTION_DAYS = 90;
