/**
 * @file I/O glue around the pure rules: load the inputs from D1, apply the diff, dispatch pushes.
 * @module dashboard-worker/alerts
 *
 * Called on every snapshot/events ingest, on MCP mutations and by the cron. Safe to call
 * concurrently: opens are upserts, resolves are guarded updates, pushes are claimed with an
 * optimistic `UPDATE ... WHERE push_count = ?` before anything is sent.
 */
import { ORIGIN_HOST, ORIGIN_RELAY, SQL_HOST_ORIGINS, SQL_RELAY_ORIGINS, sqlCanonicalOrigin } from "./shared/wire";
import { ALERT_DEFAULTS, type ProjectSnapshot } from "./shared/schema";
import type { FetchLike } from "./auth";
import { DAY_MS, SQL_CHARGE_ALERT_OWNERS } from "./budget";
import { isNoWbColumn, openAlertsStmt, refreshNoticesStmt, resolveAlertsStmt, stmt, type SnapshotRow } from "./db";
import { MAX_PROJECTS_PER_HOST, MAX_STORED_SNAPSHOT_BYTES, RELAY_STALE_AFTER_MS, USAGE_HOURLY_RETENTION_DAYS, USAGE_RETENTION_DEFAULT_DAYS, WRITE_COST, type AppCtx, type Env } from "./env";
import { dispatchPushes, holdAlerts } from "./push";
import { applyPushPolicy, loadWbState, quietStampStatements } from "./wellbeing";
import {
  EVENT_ALERT_TTL_MS,
  REOPEN_GRACE_MS,
  evaluateRules,
  type RuleAlert,
  type RuleBudget,
  type RuleEvent,
  type RuleHost,
  type RuleInput,
  type RuleProjectSeen,
  type RuleOutput,
  type RuleScan,
  type RuleSnapshot,
  type RuleTask,
  type PushItem,
} from "./rules";

export function parseSnapshotRow(row: Pick<SnapshotRow, "host" | "project" | "json" | "received_at">): RuleSnapshot | null {
  try {
    const snap = JSON.parse(row.json) as ProjectSnapshot;
    if (!snap || !Array.isArray(snap.agents)) return null;
    snap.approvals ??= [];
    snap.tasks ??= []; // the stored JSON has none: they are rows of the tasks table
    return { host: row.host, project: row.project, receivedAt: row.received_at, snap };
  } catch {
    return null;
  }
}

// The queries that run on every changed ingest and every cron minute. Exported so test/queries.test.ts
// can EXPLAIN them: each must be index-backed (see the indexes in migrations/0001_init.sql).
//
// Every scan is PARTITIONED by owner (a host label, or an MCP client name), so one host (or one client) cannot crowd
// another out of it. Two kinds of limit:
//  - per partition: getting the (PART+1)th row of a partition is how the loader knows THAT partition was cut off (the
//    extra row is then dropped). A partition that was cut off freezes resolution only for the alerts that live in it
//    (see evaluateRules / RESOLVE_NEEDS in rules.ts);
//  - global, sized to many full hosts (an operator has a handful of sources): the scans come out in host-name order, so
//    when the global limit is hit the loader knows that every host from the first row it did NOT get on was not (fully)
//    read (`readFrom`), and only those hosts freeze. A scan never freezes the hosts before that point.
//
// Reads stay bounded WITHOUT trusting the data, and are paid per host, not per table: snapshots (<= MAX_PROJECTS_PER_HOST
// per host), open tasks (caps per host / client / relay) and open alerts (the caps of evaluateRules: <= ~300 per host)
// are all capped when they are written; the halt events and the alerts are each read through one bounded index seek per
// host (idx_events_halt, idx_alerts_host), however many rows a flooding host stored, and the hosts themselves are found
// by hopping over the index, one probe per host.
export const RULE_SNAPSHOT_LIMIT = 600; // 20 hosts x MAX_PROJECTS_PER_HOST
export const RULE_TASK_LIMIT = 4000; // 10 hosts x (200 host-agent + 200 relay)
export const RULE_EVENT_LIMIT = 2000; // 20 hosts x RULE_PART_EVENTS
export const RULE_ALERT_LIMIT = 4000; // 10 hosts x (RULE_PART_ALERTS + RULE_PART_ALERTS_RESOLVED)
export const RULE_HOST_LIMIT = 500;
export const RULE_PROJECT_LIMIT = 600; // 20 hosts x MAX_PROJECTS_PER_HOST silent projects at the very most
export const RULE_BUDGET_LIMIT = 200;
/** Per-partition limits. */
export const RULE_PART_SNAPSHOTS = MAX_PROJECTS_PER_HOST;
export const RULE_PART_TASKS = 200;
export const RULE_PART_EVENTS = 100;
/** Open alerts of one host: the caps keep it under ~300 (200 non-critical + 60 critical + the notices). */
export const RULE_PART_ALERTS = 400;
/** Recently resolved alerts of one host (their counters matter for a re-open within REOPEN_GRACE_MS; a miss is harmless). */
export const RULE_PART_ALERTS_RESOLVED = 100;

/** `?1` = per-partition limit + 1, `?2` = global limit + 1. */
export const SQL_RULE_SNAPSHOTS = `SELECT host, project, json, received_at, rn FROM (
    SELECT host, project, json, received_at, ROW_NUMBER() OVER (PARTITION BY host ORDER BY project) AS rn
      FROM snapshots WHERE length(json) <= ${MAX_STORED_SNAPSHOT_BYTES * 2}
  ) WHERE rn <= ?1 ORDER BY host, project LIMIT ?2`;
/** Longest-silent hosts first: they are the ones that can raise `host-offline`. */
export const SQL_RULE_HOSTS = `SELECT host, last_seen FROM hosts ORDER BY last_seen, host LIMIT ${RULE_HOST_LIMIT + 1}`;
/**
 * The projects whose reporter has been SILENT for longer than `?1` but not for longer than `?2` (older ones are taken for
 * retired, see projectOfflineAlerts), longest-silent first; `?3` = limit + 1. A range walk of idx_project_seen_last that
 * reads only the silent ones: a healthy installation returns no rows. Run on its own (not in the batch) so a Worker that is
 * live before migration 0002 was applied still evaluates everything else.
 */
export const SQL_RULE_PROJECTS = `SELECT host, project, last_seen FROM project_seen WHERE last_seen < ?1 AND last_seen >= ?2
  ORDER BY last_seen, host, project LIMIT ?3`;
/**
 * blocked/running tasks of any origin, partitioned by (host, origin) (a host label for host agent and relay
 * rows, the client name for MCP rows) and returned partition by partition (host, origin), newest first. For
 * host agent rows the newest dispatch of the same host+project+agent comes from a MAX() over idx_tasks_agent (computed
 * only for the BLOCKED rows that survive the limits: a running task has no alert to resolve that way), which is what
 * resolves a `blocked` alert when the operator replied.
 * `?1` = now - RELAY_STALE_AFTER_MS: a relayed task still open with no update since then is STALE (its agent
 * most likely finished without saying so) and takes no part in the rules. `?2` per partition + 1, `?3` global + 1.
 */
export const SQL_RULE_TASKS = `SELECT t.key, t.origin, t.host, t.project, t.agent, t.task_id, t.title, t.state, t.eta_at,
  t.last_line, t.created, t.updated, t.rn,
  CASE WHEN t.origin = '${ORIGIN_HOST}' AND t.state = 'blocked' THEN
    (SELECT MAX(n.created) FROM tasks n
      WHERE n.origin IN (${SQL_HOST_ORIGINS}) AND n.host = t.host AND n.project = t.project AND n.agent = t.agent)
  END AS latest_dispatch
  FROM (
    SELECT key, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated, rn FROM (
      SELECT key, ${sqlCanonicalOrigin("origin")} AS origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated,
             ROW_NUMBER() OVER (PARTITION BY host, ${sqlCanonicalOrigin("origin")} ORDER BY updated DESC, key) AS rn
        FROM tasks
       WHERE state IN ('blocked', 'running') AND (origin NOT IN (${SQL_RELAY_ORIGINS}) OR updated >= ?1)
    ) WHERE rn <= ?2
    ORDER BY host, origin, rn
    LIMIT ?3
  ) t ORDER BY t.host, t.origin, t.rn`;
/**
 * Recent halt events, the newest `?2` of EACH HOST (hosts enumerates the partitions; the seek per host is a bounded
 * walk of idx_events_halt), returned host by host. `?1` = oldest `at`, `?3` = global limit + 1.
 */
export const SQL_RULE_EVENTS = `SELECT e.key, e.host, e.project, e.kind, ${sqlCanonicalOrigin("e.origin")} AS origin, e.agent, e.scenario, e.at, e.text
  FROM hosts h
  JOIN events e ON e.rowid IN (
    SELECT x.rowid FROM events x WHERE x.kind = 'halt' AND x.host = h.host AND x.at >= ?1 ORDER BY x.at DESC LIMIT ?2)
  ORDER BY e.host, e.at DESC LIMIT ?3`;
/**
 * The alerts of every owner, host by host: first its OPEN alerts (oldest first, at most `?1`), then the ones resolved
 * since `?2` (newest first, at most `?3`) whose counters a re-open must keep. The owners are found by hopping over
 * idx_alerts_host (`MIN(host) WHERE host > ?`: one probe per distinct host, however many alerts it has, and including
 * a host that is no longer a source), and each owner is a bounded seek of that same index: the cost of the scan is
 * the alerts it RETURNS (<= ?1 + ?3 per host), not the size of the table. `?4` = global limit + 1.
 */
export const SQL_RULE_ALERTS = `WITH RECURSIVE h(host) AS (
    SELECT MIN(host) FROM alerts
    UNION ALL
    SELECT (SELECT MIN(a.host) FROM alerts a WHERE a.host > h.host) FROM h WHERE h.host IS NOT NULL
    LIMIT ${RULE_HOST_LIMIT + 1}
  )
  SELECT key, rule, host, project, origin, last_pushed, push_count, summarized_at, opened, resolved, since, part FROM (
    SELECT a.key, a.rule, a.host, a.project, ${sqlCanonicalOrigin("a.origin")} AS origin, a.last_pushed, a.push_count, a.summarized_at, a.opened, a.resolved, a.since, 0 AS part
      FROM h JOIN alerts a ON a.rowid IN (
        SELECT x.rowid FROM alerts x WHERE x.host = h.host AND x.resolved IS NULL ORDER BY x.opened LIMIT ?1)
     WHERE h.host IS NOT NULL
    UNION ALL
    SELECT a.key, a.rule, a.host, a.project, ${sqlCanonicalOrigin("a.origin")} AS origin, a.last_pushed, a.push_count, a.summarized_at, a.opened, a.resolved, a.since, 1 AS part
      FROM h JOIN alerts a ON a.rowid IN (
        SELECT x.rowid FROM alerts x WHERE x.host = h.host AND x.resolved >= ?2 ORDER BY x.resolved DESC LIMIT ?3)
     WHERE h.host IS NOT NULL
  ) ORDER BY host, part, opened LIMIT ?4`;
/** Sources refused for budget whose window has not ended (idx_sources_budget, partial). */
export const SQL_RULE_BUDGETS =
  `SELECT name, kind, budget_until FROM sources WHERE budget_until > 0 AND budget_until > ? LIMIT ${RULE_BUDGET_LIMIT + 1}`;
/** The rule inputs whose scan was cut off in the last evaluation (written only when it changes). */
export const META_RULES_TRUNCATED = "rules_truncated";
/** Maintenance stamps (epoch ms as text), see maintenance.ts: the last purge, the last cron run, the last opportunistic rules tick. */
export const META_LAST_PURGE = "last_purge";
export const META_LAST_CRON = "last_cron";
export const META_LAST_TICK = "last_tick";
export const SQL_META_GET = "SELECT v FROM meta WHERE k = ?";
const SQL_META_SET =
  "INSERT INTO meta (k, v, updated) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated WHERE meta.v <> excluded.v";
const SQL_META_CLEAR = "DELETE FROM meta WHERE k = ?";

export interface LoadedRuleInput extends RuleInput {
  /** The `rules_truncated` value stored by the previous evaluation (JSON), or null when none. */
  storedTruncated: string | null;
}

/**
 * Drop the (limit+1)th row of every partition and remember which partitions had one. `part` names the
 * partition of a row, `rank` its number inside it (`rn`, or counted here when the SQL has none).
 */
function partitioned<T>(rows: T[] | undefined, limit: number, part: (r: T) => string, rank: (r: T) => number): { kept: T[]; cut: string[] } {
  const kept: T[] = [];
  const cut = new Set<string>();
  for (const r of rows ?? []) {
    if (rank(r) > limit) cut.add(part(r));
    else kept.push(r);
  }
  return { kept, cut: [...cut] };
}

/** Keep at most `limit` rows; report whether the scan had more (it was asked for limit + 1). */
function bounded<T>(rows: T[] | undefined, limit: number, name: RuleScan, cut: RuleScan[]): T[] {
  const list = rows ?? [];
  if (list.length <= limit) return list;
  cut.push(name);
  return list.slice(0, limit);
}

/**
 * Apply a GLOBAL row limit to a scan that comes out host by host: the rows beyond it are dropped and the host of the
 * first one dropped is where reading stopped (every host from there on was not read completely, see RuleInput.readFrom).
 */
function globallyLimited<T extends { host?: string | null }>(rows: T[], limit: number, scan: RuleScan, readFrom: Partial<Record<RuleScan, string>>): T[] {
  if (rows.length <= limit) return rows;
  readFrom[scan] = (rows[limit] as T).host ?? "";
  return rows.slice(0, limit);
}

/** One D1 round trip: every table the rules read. */
export async function loadRuleInput(db: D1Database, now: number): Promise<LoadedRuleInput> {
  const [snapshots, hosts, tasks, events, alerts, budgets, meta] = await db.batch([
    db.prepare(SQL_RULE_SNAPSHOTS).bind(RULE_PART_SNAPSHOTS + 1, RULE_SNAPSHOT_LIMIT + 1),
    db.prepare(SQL_RULE_HOSTS),
    db.prepare(SQL_RULE_TASKS).bind(now - RELAY_STALE_AFTER_MS, RULE_PART_TASKS + 1, RULE_TASK_LIMIT + 1),
    db.prepare(SQL_RULE_EVENTS).bind(now - EVENT_ALERT_TTL_MS, RULE_PART_EVENTS + 1, RULE_EVENT_LIMIT + 1),
    db.prepare(SQL_RULE_ALERTS).bind(RULE_PART_ALERTS + 1, now - REOPEN_GRACE_MS, RULE_PART_ALERTS_RESOLVED, RULE_ALERT_LIMIT + 1),
    db.prepare(SQL_RULE_BUDGETS).bind(now),
    stmt(db, SQL_META_GET, META_RULES_TRUNCATED),
  ]);
  const truncated: RuleScan[] = [];
  const truncatedParts: Partial<Record<RuleScan, string[]>> = {};
  const readFrom: Partial<Record<RuleScan, string>> = {};

  // Silent projects (migration 0002). Not part of the batch above: a missing table must not stop every other rule. Any other
  // failure marks the scan as cut off, so no project-offline alert is resolved on the strength of a list that was not read.
  let projectSeen: RuleProjectSeen[] = [];
  try {
    const res = await db
      .prepare(SQL_RULE_PROJECTS)
      .bind(now - ALERT_DEFAULTS.projectOfflineAfterMs, now - ALERT_DEFAULTS.projectOfflineMaxMs, RULE_PROJECT_LIMIT + 1)
      .all();
    projectSeen = bounded((res.results ?? []) as unknown as RuleProjectSeen[], RULE_PROJECT_LIMIT, "projects", truncated);
  } catch (err) {
    if (!isNoSuchTable(err)) truncated.push("projects");
  }

  // snapshots: per host
  const snapAll = globallyLimited((snapshots?.results ?? []) as unknown as Array<SnapshotRow & { rn: number }>, RULE_SNAPSHOT_LIMIT, "snapshots", readFrom);
  const snapRows = partitioned(snapAll, RULE_PART_SNAPSHOTS, (r) => r.host, (r) => r.rn);
  if (snapRows.cut.length) truncatedParts.snapshots = snapRows.cut;

  // tasks: per (host, origin)
  const taskAll = globallyLimited((tasks?.results ?? []) as unknown as Array<RuleTask & { rn: number }>, RULE_TASK_LIMIT, "tasks", readFrom);
  const taskRows = partitioned(taskAll, RULE_PART_TASKS, (r) => `${r.host ?? ""}|${r.origin}`, (r) => r.rn);
  if (taskRows.cut.length) truncatedParts.tasks = taskRows.cut;

  // events: per host (the SQL gives each host its newest PART + 1)
  const perHost = new Map<string, number>();
  const eventRows: RuleEvent[] = [];
  const eventCut = new Set<string>();
  for (const e of globallyLimited((events?.results ?? []) as unknown as RuleEvent[], RULE_EVENT_LIMIT, "events", readFrom)) {
    const n = (perHost.get(e.host ?? "") ?? 0) + 1;
    perHost.set(e.host ?? "", n);
    if (n > RULE_PART_EVENTS) eventCut.add(e.host ?? "");
    else eventRows.push(e);
  }
  if (eventCut.size) truncatedParts.events = [...eventCut];

  // alerts: per host, the open ones first (part 0) and then the recently resolved (part 1): a host only hides an OPEN
  // alert when it has more than RULE_PART_ALERTS of them
  const alertAll = globallyLimited((alerts?.results ?? []) as unknown as Array<RuleAlert & { part: number }>, RULE_ALERT_LIMIT, "alerts", readFrom);
  const openPerHost = new Map<string, number>();
  const alertRows: RuleAlert[] = [];
  const alertCut = new Set<string>();
  for (const a of alertAll) {
    if (a.part === 0) {
      const n = (openPerHost.get(a.host ?? "") ?? 0) + 1;
      openPerHost.set(a.host ?? "", n);
      if (n > RULE_PART_ALERTS) {
        alertCut.add(a.host ?? "");
        continue;
      }
    }
    alertRows.push(a);
  }
  if (alertCut.size) truncatedParts.alerts = [...alertCut];

  return {
    now,
    snapshots: snapRows.kept.map(parseSnapshotRow).filter((s): s is RuleSnapshot => s !== null),
    hosts: bounded((hosts?.results ?? []) as unknown as RuleHost[], RULE_HOST_LIMIT, "hosts", truncated),
    projectSeen,
    tasks: taskRows.kept,
    events: eventRows,
    alerts: alertRows,
    budgets: bounded((budgets?.results ?? []) as unknown as RuleBudget[], RULE_BUDGET_LIMIT, "budgets", truncated),
    truncated,
    truncatedParts,
    readFrom,
    storedTruncated: ((meta?.results ?? [])[0] as { v?: string } | undefined)?.v ?? null,
  };
}

/** The scans that were cut off, for the read API: the name of every scan that was cut off as a whole, for a partition or by its global limit. */
export function truncationSummary(out: Pick<RuleOutput, "truncated" | "truncatedParts" | "readFrom">): string[] {
  const names = new Set<string>(out.truncated);
  for (const [scan, parts] of Object.entries(out.truncatedParts)) if (parts?.length) names.add(scan);
  for (const scan of Object.keys(out.readFrom ?? {})) names.add(scan);
  return [...names].sort();
}

export interface AppliedRules extends RuleOutput {
  /** Alert rows this evaluation really inserted / re-opened / resolved (D1's own `changes`, not the rules' guess). */
  opened: number;
  resolved: number;
}

/**
 * Evaluate the rules against D1, persist opens/resolves, charge them to the sources that own them, and hand
 * due pushes to `ctx.waitUntil` (so ingest answers without waiting on push services). Never throws into the
 * caller: a rules failure must not turn a successful ingest into an error.
 */
export async function applyRules(env: Env, ctx: AppCtx, now: number, fetchImpl?: FetchLike): Promise<AppliedRules> {
  const empty: AppliedRules = { desired: [], open: [], resolve: [], push: [], truncated: [], truncatedParts: {}, readFrom: {}, refresh: [], opened: 0, resolved: 0 };
  try {
    const loaded = await loadRuleInput(env.DB, now);
    const out = evaluateRules(loaded);
    const writes: D1PreparedStatement[] = [];
    let openIdx = -1;
    let resolveIdx = -1;
    let refreshIdx = -1;
    const opening = out.open.map((a) => ({
      key: a.key, rule: a.rule, severity: a.severity, origin: a.origin, host: a.host, project: a.project, agent: a.agent, text: a.text, since: a.since ?? null,
    }));
    if (out.open.length) {
      openIdx = writes.length;
      writes.push(openAlertsStmt(env.DB, opening, now));
    }
    if (out.resolve.length) {
      resolveIdx = writes.length;
      writes.push(resolveAlertsStmt(env.DB, out.resolve, now));
    }
    if (out.refresh.length) {
      refreshIdx = writes.length;
      writes.push(refreshNoticesStmt(env.DB, out.refresh));
    }
    // The read API shows which scans were cut off; the row is only written when that set changes.
    const summary = truncationSummary(out);
    const flag = summary.length ? JSON.stringify(summary) : null;
    if (flag !== loaded.storedTruncated) {
      writes.push(flag ? stmt(env.DB, SQL_META_SET, META_RULES_TRUNCATED, flag, now) : stmt(env.DB, SQL_META_CLEAR, META_RULES_TRUNCATED));
    }
    let results: D1Result[] = [];
    if (writes.length) {
      try {
        results = await env.DB.batch(writes);
      } catch (err) {
        // A database without migration 0007 has no alerts.wb_digested: the same batch again with the statement as before.
        if (openIdx < 0 || !isNoWbColumn(err)) throw err;
        writes[openIdx] = openAlertsStmt(env.DB, opening, now, { wbDigested: false });
        results = await env.DB.batch(writes);
      }
    }
    if (summary.length) console.warn(`rules: scan(s) cut off by their limit, the alerts that depend on them are not resolved this round: ${summary.join(", ")}`);

    // What really changed, charged to the host that owns each alert (alert.host is the token-bound label): the
    // cron and every other source's request open alerts too, and none of them may be free.
    const rowsOf = (i: number): Array<{ key: string; host: string | null }> => (i >= 0 ? ((results[i]?.results ?? []) as Array<{ key: string; host: string | null }>) : []);
    const openedRows = rowsOf(openIdx);
    const resolvedRows = rowsOf(resolveIdx);
    const refreshedRows = rowsOf(refreshIdx);
    const owed = new Map<string, number>();
    for (const r of openedRows) if (r.host) owed.set(r.host, (owed.get(r.host) ?? 0) + WRITE_COST.alertOpen);
    for (const r of resolvedRows) if (r.host) owed.set(r.host, (owed.get(r.host) ?? 0) + WRITE_COST.alertResolve);
    for (const r of refreshedRows) if (r.host) owed.set(r.host, (owed.get(r.host) ?? 0) + WRITE_COST.noticeRefresh);
    if (owed.size) {
      try {
        await stmt(env.DB, SQL_CHARGE_ALERT_OWNERS, JSON.stringify([...owed].map(([h, n]) => ({ h, n }))), now, DAY_MS).run();
      } catch {
        /* the alerts are written; only their accounting failed */
      }
    }
    if (out.push.length) ctx.waitUntil(policyThenDispatch(env, out.push, now, fetchImpl).catch(() => undefined));
    return { ...out, opened: openedRows.length, resolved: resolvedRows.length };
  } catch (err) {
    console.error("rules evaluation failed:", err instanceof Error ? err.message : String(err));
    return empty;
  }
}

/**
 * The well-being push policy (wellbeing.ts) between the rules and the dispatcher: `now` alerts go out (several as one storm
 * push), `batch` ones and everything outside the quiet-hours / Focus allowance are held for the digest, `info` is never
 * pushed. Without migration 0007 every due push goes out as before. D1: 1 read, plus 1 write per held group / quiet stamp.
 */
async function policyThenDispatch(env: Env, items: PushItem[], now: number, fetchImpl?: FetchLike): Promise<void> {
  const st = env.WELLBEING_PUSH_POLICY === "0" ? null : await loadWbState(env.DB, now).catch(() => null);
  if (!st) return dispatchPushes(env, items, now, fetchImpl);
  const p = applyPushPolicy(items, { now, settings: st.settings, focusUntil: st.focusUntil, quietLast: st.quietLast });
  if (p.hold.length) await holdAlerts(env.DB, p.hold, now);
  const stamps = quietStampStatements(env.DB, p.quietStamped, now);
  if (stamps.length) await env.DB.batch(stamps);
  if (p.send.length) await dispatchPushes(env, p.send, now, fetchImpl, { storm: true });
}

/** A push-budget row nobody has claimed (it was ensured for a push that then did not happen) is dead after this long. */
export const PUSH_BUDGET_UNCLAIMED_GRACE_MS = 60 * 60_000;
/** A claimed push-budget row that has been idle for this long (longer than any of its windows) is just bookkeeping. */
export const PUSH_BUDGET_IDLE_MS = 2 * 86_400_000;

/** D1 / SQLite say "no such table: project_seen" for a query against a table whose migration has not been applied. */
export function isNoSuchTable(err: unknown): boolean {
  return /no such table/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Rows one purge run deletes from ONE table at most: a backlog (a lowered RETENTION_DAYS, a long stretch without any
 * purge) is worked off over several runs, never in one CPU-hungry statement.
 */
export const PURGE_BATCH = 500;

/**
 * Retention purge. Returns rows removed per table, for tests and logs. Called through `purgeIfDue` (maintenance.ts:
 * by the cron when it fires, opportunistically from ingest and `/api/state` when it does not), so it is bounded: at
 * most `limit` rows per table and statement (`rowid IN (SELECT ... LIMIT)`, a bounded walk of the index the
 * migration names for it). EVERY table a source can write to ends up here, so no token can grow one
 * without bound (what a token may write in a day is bounded by its budgets, and everything it wrote is gone after
 * the retention period):
 *  - events, tasks, snapshots, hosts: older than the retention period (their own timestamps);
 *  - alerts: resolved ones older than the retention period, and OPEN ones that were opened that long ago (a partition
 *    the rules can no longer see, e.g. of a source that was deleted, would otherwise keep its rows for ever; a condition
 *    that really lasts that long opens again at once, one write and no more than one more push);
 *  - push_budget: never-claimed rows after one hour (`touched` is set when a row is ensured and the claim follows within
 *    seconds, and a row that is still in use is re-touched every 10 minutes, so the purge cannot delete a row between
 *    its ensure and its claim), idle claimed rows after two days, and whatever is left (a summary nobody could send)
 *    after the retention period;
 *  - usage_daily / usage_hosts (migration 0003): see below (its own, longer retention).
 */
export async function purgeOld(db: D1Database, now: number, retentionDays: number, limit: number = PURGE_BATCH, usageRetentionDays: number = USAGE_RETENTION_DEFAULT_DAYS): Promise<Record<string, number>> {
  const cutoff = now - retentionDays * 86_400_000;
  /** `DELETE FROM t WHERE <where> LIMIT ?n` (D1 has no DELETE ... LIMIT); `n` = the number of the limit parameter. */
  const bounded = (table: string, where: string, n: number): string =>
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?${n})`;
  const run = async (sql: string, ...binds: Array<number | string>): Promise<number> => (await db.prepare(sql).bind(...binds, limit).run()).meta?.changes ?? 0;
  /**
   * Migration 0002 may not be applied yet: ONLY "no such table" is tolerated (the fallback runs, or nothing is deleted). Any other
   * error (a wrong parameter count, a D1 outage, a typo in the SQL) surfaces, because swallowing it would leave the table
   * un-purged without anyone ever seeing why.
   */
  const unlessNoTable = <T>(fallback: () => Promise<T>) => (err: unknown): Promise<T> => {
    if (isNoSuchTable(err)) return fallback();
    throw err;
  };
  // Every table is purged on its own: an error in one (it surfaces, see above) must not leave the tables after it
  // un-purged for ever. The errors are collected and thrown together AFTER all tables ran, so the caller still logs them.
  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  };
  const removed: Record<string, number> = {
    events: await step("events", () => run(bounded("events", "at < ?1", 2), cutoff)),
    // Closed tasks, and open ones nobody has touched for the whole retention period.
    tasks: await step("tasks", () => run(bounded("tasks", "updated < ?1", 2), cutoff)),
    alerts: await step("alerts", () => run(bounded("alerts", "resolved IS NOT NULL AND resolved < ?1", 2), cutoff)),
    openAlerts: await step("openAlerts", () => run(bounded("alerts", "resolved IS NULL AND opened < ?1", 2), cutoff)),
    // A quiet project only re-sends its snapshot when something CHANGES (heartbeats otherwise), so `received_at` alone
    // would purge the snapshot of a healthy project that has been idle for the whole retention period. Keep it while
    // project_seen (migration 0002) shows the project still reporting; without that table, fall back to received_at.
    snapshots: await step("snapshots", () =>
      run(
        bounded("snapshots", "received_at < ?1 AND NOT EXISTS (SELECT 1 FROM project_seen ps WHERE ps.host = snapshots.host AND ps.project = snapshots.project AND ps.last_seen >= ?1)", 2),
        cutoff,
      ).catch(unlessNoTable(() => run(bounded("snapshots", "received_at < ?1", 2), cutoff))),
    ),
    hosts: await step("hosts", () => run(bounded("hosts", "last_seen < ?1", 2), cutoff)),
    // project_seen is WITHOUT ROWID, so it cannot use the rowid form of `bounded`; migration 0002 may not be applied yet.
    projectSeen: await step("projectSeen", () =>
      run(
        "DELETE FROM project_seen WHERE (host, project) IN (SELECT host, project FROM project_seen WHERE last_seen < ?1 ORDER BY last_seen LIMIT ?2)",
        cutoff,
      ).catch(unlessNoTable(async () => 0)),
    ),
    // usage_daily (migration 0003) is WITHOUT ROWID with `day` first: the oldest days go first, a bounded walk of the primary key.
    // Its retention is its own (USAGE_RETENTION_DAYS, default 800: numbers only). usage_hosts rows of hosts silent for the
    // (shorter) general retention go too: the host then simply sends its whole history again when it returns.
    usageDaily: await step("usageDaily", () =>
      run(
        "DELETE FROM usage_daily WHERE (day, host, project, agent, source, model) IN (SELECT day, host, project, agent, source, model FROM usage_daily WHERE day < ?1 ORDER BY day LIMIT ?2)",
        new Date(now - usageRetentionDays * 86_400_000).toISOString().slice(0, 10),
      ).catch(unlessNoTable(async () => 0)),
    ),
    // usage_hourly (migration 0005): hour first, the oldest hours go first; kept USAGE_HOURLY_RETENTION_DAYS (the daily rows stay).
    usageHourly: await step("usageHourly", () =>
      run(
        "DELETE FROM usage_hourly WHERE (hour, host, project, agent, source, model) IN (SELECT hour, host, project, agent, source, model FROM usage_hourly WHERE hour < ?1 ORDER BY hour LIMIT ?2)",
        `${new Date(now - USAGE_HOURLY_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)}T00`,
      ).catch(unlessNoTable(async () => 0)),
    ),
    usageHosts: await step("usageHosts", () =>
      // Never a row whose ALLOWANCE WINDOW is still running (win_start + 24 h > now), whatever its pushed_at says: deleting it would hand the host a fresh allowance.
      run("DELETE FROM usage_hosts WHERE host IN (SELECT host FROM usage_hosts WHERE pushed_at < ?1 AND win_start <= ?2 ORDER BY pushed_at LIMIT ?3)", cutoff, now - 86_400_000).catch(unlessNoTable(async () => 0)),
    ),
    pushBudget: await step("pushBudget", async () =>
      (await run(bounded("push_budget", "suppressed = 0 AND ((day_start = 0 AND touched < ?1) OR touched < ?2)", 3), now - PUSH_BUDGET_UNCLAIMED_GRACE_MS, now - PUSH_BUDGET_IDLE_MS)) +
      (await run(bounded("push_budget", "touched < ?1", 2), cutoff)),
    ),
  };
  if (errors.length) throw new Error(`purge failed for ${errors.length} table(s): ${errors.join("; ")}`);
  return removed;
}
