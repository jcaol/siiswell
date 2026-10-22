/**
 * @file Small typed helpers over D1. Everything is a prepared statement so callers can group
 * writes in one `db.batch()` (one round trip, one transaction, one subrequest).
 *
 * D1 limits that shape this file: <= 100 bound parameters and <= 100 KB SQL per statement, and
 * 50 queries per invocation on the Free plan. Lists of rows therefore go in as ONE JSON
 * parameter consumed with json_each(), never as N statements or N placeholders.
 * @module dashboard-worker/db
 */
import { ORIGIN_HOST, ORIGIN_RELAY, SQL_HOST_ORIGINS, SQL_RELAY_ORIGINS, sqlCanonicalOrigin } from "./shared/wire";
import { HEARTBEAT_INTERVAL_MS } from "./shared/schema";
import { REOPEN_GRACE_MS } from "./rules";

export type Bindable = string | number | null | undefined;

export interface SourceRow {
  id: string;
  name: string;
  kind: "host" | "client";
  token_sha256: string;
  created: number;
  last_seen: number | null;
  revoked: number;
  /** MCP mutation budget: start of the current fixed 24 h window and the changes claimed in it. */
  mut_window_start: number;
  mut_count: number;
  /** Host ingest write budget (estimated rows written in the current fixed 24 h window). */
  wr_window_start: number;
  wr_count: number;
  /** Critical-halt allowance of a host token (fixed 24 h window, see MAX_CRITICAL_HALTS_PER_DAY). */
  hl_window_start: number;
  hl_count: number;
  /** The source was refused for budget until this time (0 = never); drives the budget-exhausted alert. */
  budget_until: number;
  /** When a request of this source last ran the rule evaluation (the ingest-triggered evaluations are throttled). */
  eval_at: number;
  /** CLI version last reported in X-Siiswell-Client (migration 0013), or null. */
  client_version?: string | null;
  /** Per-client ceiling for task text (migration 0014): none | minimal | brief | full, null = the server default. */
  task_text?: string | null;
}

export interface SnapshotRow {
  source_id: string;
  host: string;
  project: string;
  json: string;
  received_at: number;
}

export interface HostRow {
  host: string;
  source_id: string | null;
  last_seen: number;
  binary_version: string | null;
}

export interface TaskRow {
  key: string;
  source_id: string;
  origin: string;
  host: string | null;
  project: string | null;
  agent: string | null;
  task_id: string;
  title: string;
  state: string;
  eta_at: number | null;
  last_line: string | null;
  created: number;
  updated: number;
}

export interface EventRow {
  key: string;
  host: string | null;
  project: string | null;
  kind: string;
  origin: string;
  agent: string | null;
  scenario: string | null;
  status: string | null;
  severity: string;
  text: string;
  sender: string | null;
  at: number;
  received_at: number;
}

export interface AlertRow {
  key: string;
  rule: string;
  severity: string;
  origin: string;
  host: string | null;
  project: string | null;
  agent: string | null;
  text: string;
  opened: number;
  last_pushed: number | null;
  push_count: number;
  /** Set when the alert was folded into a budget summary push instead of being pushed itself. */
  summarized_at: number | null;
  resolved: number | null;
}

export interface PushSubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  created: number;
  last_ok: number | null;
}

/** Prepare + bind; `undefined` becomes NULL (D1 throws on undefined). */
export function stmt(db: D1Database, sql: string, ...params: Bindable[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params.map((p) => (p === undefined ? null : p)));
}

export async function all<T>(db: D1Database, sql: string, ...params: Bindable[]): Promise<T[]> {
  const res = await stmt(db, sql, ...params).all<T>();
  return res.results ?? [];
}

export async function first<T>(db: D1Database, sql: string, ...params: Bindable[]): Promise<T | null> {
  return (await stmt(db, sql, ...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: Bindable[]): Promise<number> {
  const res = await stmt(db, sql, ...params).run();
  return res.meta?.changes ?? 0;
}

// ── sources ──────────────────────────────────────────────────────────────────

export function findSourceByHash(db: D1Database, tokenSha256: string): Promise<SourceRow | null> {
  return first<SourceRow>(db, "SELECT * FROM sources WHERE token_sha256 = ?", tokenSha256);
}

export function touchSource(db: D1Database, id: string, now: number): D1PreparedStatement {
  return stmt(db, "UPDATE sources SET last_seen = ? WHERE id = ?", now, id);
}

// ── hosts ────────────────────────────────────────────────────────────────────

/**
 * `hosts.last_seen` is refreshed by a request that was refused before it wrote anything (a budget 429, the project limit, a
 * 413) at most this often: 3/4 of the pusher's heartbeat interval, 90 s for the current 120 s heartbeat. Heartbeats,
 * snapshots and events are not held to it but to the much shorter LIVENESS_WRITE_FLOOR_MS: an events batch that landed at
 * 89 s used to reset the pusher's heartbeat timer without refreshing the row, so a host with ONE project could go ~380 s
 * between writes (and look offline) when the next heartbeat was lost.
 */
export const HOST_WRITE_EVERY_MS = (HEARTBEAT_INTERVAL_MS * 3) / 4;

/**
 * The HEARTBEAT, SNAPSHOT and EVENTS routes refresh `hosts.last_seen` on (almost) every message: only a message within this
 * floor of the last write skips it. No legitimate sender is that fast (a project sends at most one request per 15 s, usually one per
 * 2 minutes), so every real heartbeat is written; the floor is what keeps heartbeats, which are not budgeted, from becoming a
 * write path for a leaked token: <= 4,320 host-row writes a day however fast it sends (the rate limit alone would allow 86,400).
 */
export const LIVENESS_WRITE_FLOOR_MS = 20_000;

/**
 * `project_seen` rows are written at most this often per (host, project): the SAME floor as the host row, for the same reason. It was
 * 90 s, and a project that sends events at 89 s after a write and then loses one heartbeat went ~380 s between writes against a
 * 6 min limit; with 20 s every real message of a project is written. Keep it under 45 s: the worst silence after one lost
 * heartbeat is 2 x (120 s + 5 s tick + 20 s jitter) = 290 s, and that plus the floor must stay clear of PROJECT_OFFLINE_AFTER_MS
 * (360 s). Cost: ONE project row is at most 4,320 writes a day, but a leaked token that rotates over its 30 projects is bounded
 * by the rate limit only (one project row per request, <= 86,400 a day; with the 90 s floor it was 28,800).
 */
export const PROJECT_SEEN_WRITE_FLOOR_MS = LIVENESS_WRITE_FLOOR_MS;

/**
 * Touch a host. The update is conditional on `minGapMs` (HOST_WRITE_EVERY_MS unless the caller says otherwise): a
 * `last_seen` less than that old, from the same source, writes nothing. The binary version rides along when a write
 * happens, and triggers one on its own ONLY to fill a NULL: the row is often created by an events call (no version) a
 * moment before the first snapshot or heartbeat names it. A stored version is never overwritten by a request that does
 * not write (COALESCE never writes NULL back), so a sender that alternates `binaryVersion` on every heartbeat causes
 * exactly the writes a constant version would: none of them is for the version, and the NULL fill is at most one extra
 * write per host, ever.
 */
export function upsertHost(
  db: D1Database,
  host: string,
  sourceId: string,
  now: number,
  binaryVersion?: string,
  minGapMs: number = HOST_WRITE_EVERY_MS,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO hosts (host, source_id, last_seen, binary_version) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(host) DO UPDATE SET source_id = excluded.source_id, last_seen = excluded.last_seen,
       binary_version = COALESCE(excluded.binary_version, hosts.binary_version)
     WHERE excluded.last_seen - hosts.last_seen >= ?5
        OR hosts.source_id IS NOT excluded.source_id
        OR (hosts.binary_version IS NULL AND excluded.binary_version IS NOT NULL)`,
    host,
    sourceId,
    now,
    binaryVersion ?? null,
    minGapMs,
  );
}

// ── per-project liveness (migration 0002) ────────────────────────────────────

/**
 * A heartbeat / events batch for a project: record it only for a project the host already has a snapshot for (so a token
 * cannot grow the table with invented names; the per-host project limit bounds it), and not more often than `?4` ms.
 */
export const SQL_PROJECT_SEEN_TOUCH = `INSERT INTO project_seen (host, project, last_seen)
  SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM snapshots WHERE host = ?1 AND project = ?2)
  ON CONFLICT(host, project) DO UPDATE SET last_seen = excluded.last_seen WHERE excluded.last_seen - project_seen.last_seen >= ?4`;
/** A snapshot (its own row is written in the same request, and the per-host project limit was checked): upsert, throttled by `?4`. */
export const SQL_PROJECT_SEEN_UPSERT = `INSERT INTO project_seen (host, project, last_seen) VALUES (?1, ?2, ?3)
  ON CONFLICT(host, project) DO UPDATE SET last_seen = excluded.last_seen WHERE excluded.last_seen - project_seen.last_seen >= ?4`;

/**
 * Best effort, never part of the ingest batch: liveness must not turn a good ingest into an error, and a Worker deployed
 * before the migration was applied simply records nothing. `exists` = the heartbeat / events form (EXISTS guard).
 */
export async function touchProjectSeen(db: D1Database, host: string, project: string | undefined, now: number, exists: boolean): Promise<void> {
  if (!project) return;
  try {
    await stmt(db, exists ? SQL_PROJECT_SEEN_TOUCH : SQL_PROJECT_SEEN_UPSERT, host, project, now, PROJECT_SEEN_WRITE_FLOOR_MS).run();
  } catch {
    /* no table yet, or a transient D1 error: per-project liveness is best effort */
  }
}

// ── snapshots + host-agent tasks ──────────────────────────────────────────────

export function upsertSnapshot(
  db: D1Database,
  sourceId: string,
  host: string,
  project: string,
  jsonText: string,
  now: number,
  fp: string,
  openTasks: number,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO snapshots (source_id, host, project, json, received_at, fp, open_tasks) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, project) DO UPDATE SET source_id = excluded.source_id, json = excluded.json,
       received_at = excluded.received_at, fp = excluded.fp, open_tasks = excluded.open_tasks`,
    sourceId,
    host,
    project,
    jsonText,
    now,
    fp,
    openTasks,
  );
}

export interface TaskInsert {
  key: string;
  agent: string;
  task_id: string;
  title: string;
  state: string;
  eta_at: number | null;
  last_line: string | null;
  created: number;
  updated: number;
}

/**
 * Upsert all of a snapshot's tasks in ONE statement (json_each).
 * - The WHERE keeps a snapshot from overwriting a row of another origin or host that happens to share
 *   its key (e.g. a host labelled "mcp" colliding with `mcp|<client>|<id>`).
 * - It also makes the write conditional: a row is only rewritten (and its indexes updated, which D1
 *   bills as rows written) when a stored column actually differs, so an unchanged task costs nothing.
 */
export function upsertSnapshotTasks(
  db: D1Database,
  sourceId: string,
  host: string,
  project: string,
  tasks: TaskInsert[],
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated)
     SELECT json_extract(value, '$.key'), ?1, '${ORIGIN_HOST}', ?2, ?3,
            json_extract(value, '$.agent'), json_extract(value, '$.task_id'), json_extract(value, '$.title'),
            json_extract(value, '$.state'), json_extract(value, '$.eta_at'), json_extract(value, '$.last_line'),
            json_extract(value, '$.created'), json_extract(value, '$.updated')
     FROM json_each(?4) WHERE true
     ON CONFLICT(key) DO UPDATE SET source_id = excluded.source_id, agent = excluded.agent, title = excluded.title,
       state = excluded.state, eta_at = excluded.eta_at, last_line = excluded.last_line,
       created = excluded.created, updated = excluded.updated, origin = excluded.origin
     WHERE tasks.origin IN (${SQL_HOST_ORIGINS}) AND tasks.host = excluded.host
       AND (tasks.source_id IS NOT excluded.source_id OR tasks.agent IS NOT excluded.agent
            OR tasks.title IS NOT excluded.title OR tasks.state IS NOT excluded.state
            OR tasks.eta_at IS NOT excluded.eta_at OR tasks.last_line IS NOT excluded.last_line
            OR tasks.created IS NOT excluded.created OR tasks.updated IS NOT excluded.updated)`,
    sourceId,
    host,
    project,
    JSON.stringify(tasks),
  );
}

export const SQL_DELETE_ABSENT_TASKS = `DELETE FROM tasks WHERE origin IN (${SQL_HOST_ORIGINS}) AND host = ?1 AND project = ?2
       AND key NOT IN (SELECT value FROM json_each(?3))`;

/** Delete this host+project's host-agent task rows that are not in the new snapshot (idx_tasks_agent prefix). */
export function deleteAbsentSnapshotTasks(
  db: D1Database,
  host: string,
  project: string,
  keepKeys: string[],
): D1PreparedStatement {
  return stmt(db, SQL_DELETE_ABSENT_TASKS, host, project, JSON.stringify(keepKeys));
}

// ── events ───────────────────────────────────────────────────────────────────

/**
 * Insert-or-ignore a whole batch of events in ONE statement. The primary key is (source_id, key),
 * so a sender-chosen key can only ever collide with the same source's own earlier event.
 */
export function insertEventsStmt(db: D1Database, sourceId: string, rows: EventRow[]): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO events (source_id, key, host, project, kind, origin, agent, scenario, status, severity, text, sender, at, received_at)
     SELECT ?1, json_extract(value, '$.key'), json_extract(value, '$.host'), json_extract(value, '$.project'),
            json_extract(value, '$.kind'), json_extract(value, '$.origin'), json_extract(value, '$.agent'),
            json_extract(value, '$.scenario'), json_extract(value, '$.status'), json_extract(value, '$.severity'),
            json_extract(value, '$.text'), json_extract(value, '$.sender'), json_extract(value, '$.at'),
            json_extract(value, '$.received_at')
     FROM json_each(?2) WHERE true`,
    sourceId,
    JSON.stringify(rows),
  );
}

/**
 * Task rows mirroring foreign agents' latest STATUS line (the relay origin), one statement.
 * A row is only overwritten by an event that is at least as new, so replays never regress state.
 */
export function upsertRelayTasksStmt(db: D1Database, sourceId: string, rows: TaskRow[]): D1PreparedStatement {
  const sorted = [...rows].sort((a, b) => a.updated - b.updated);
  return stmt(
    db,
    `INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated)
     SELECT json_extract(value, '$.key'), ?1, '${ORIGIN_RELAY}', json_extract(value, '$.host'), json_extract(value, '$.project'),
            json_extract(value, '$.agent'), json_extract(value, '$.task_id'), json_extract(value, '$.title'),
            json_extract(value, '$.state'), json_extract(value, '$.eta_at'), json_extract(value, '$.last_line'),
            json_extract(value, '$.created'), json_extract(value, '$.updated')
     FROM json_each(?2) WHERE true
     ON CONFLICT(key) DO UPDATE SET source_id = excluded.source_id, agent = excluded.agent, title = excluded.title,
       state = excluded.state, eta_at = excluded.eta_at, last_line = excluded.last_line, updated = excluded.updated, origin = excluded.origin
     WHERE tasks.origin IN (${SQL_RELAY_ORIGINS}) AND tasks.host = excluded.host AND excluded.updated >= tasks.updated
       AND (tasks.source_id IS NOT excluded.source_id OR tasks.agent IS NOT excluded.agent
            OR tasks.title IS NOT excluded.title OR tasks.state IS NOT excluded.state
            OR tasks.eta_at IS NOT excluded.eta_at OR tasks.last_line IS NOT excluded.last_line
            OR tasks.updated IS NOT excluded.updated)`,
    sourceId,
    JSON.stringify(sorted),
  );
}

// ── alerts ───────────────────────────────────────────────────────────────────

export interface AlertInsert {
  key: string;
  rule: string;
  severity: string;
  origin: string;
  host: string | null;
  project: string | null;
  agent: string | null;
  text: string;
  /** When the condition behind the alert began (see the alerts table); null = now. */
  since: number | null;
}

/**
 * Open alerts in ONE statement. The rules only ask to open keys that have no OPEN row, so an
 * existing row is a resolved earlier episode. If it was resolved less than REOPEN_GRACE_MS ago it
 * is re-opened as the SAME incident (opened / push_count / last_pushed kept, so a flapping condition
 * such as a snapshot built before a halt but delivered after it cannot trigger a second push);
 * older rows start a fresh episode that pushes again. `RETURNING key, host`: the rows that really changed,
 * so callers charge (and report) what was written, not what the rules asked for.
 */
export function openAlertsStmt(db: D1Database, alerts: AlertInsert[], now: number, opts: { wbDigested?: boolean } = { wbDigested: true }): D1PreparedStatement {
  // migration 0007: a fresh episode must be digested again (a reopen within the grace is the same incident and keeps it).
  // Without that column (0007 not applied) the caller retries with wbDigested: false, the statement as before.
  const wb = opts.wbDigested !== false ? "\n       wb_digested = CASE WHEN ?1 - alerts.resolved < ?3 THEN alerts.wb_digested ELSE NULL END," : "";
  return stmt(
    db,
    `INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened, last_pushed, push_count, resolved, since)
     SELECT json_extract(value, '$.key'), json_extract(value, '$.rule'), json_extract(value, '$.severity'),
            json_extract(value, '$.origin'), json_extract(value, '$.host'), json_extract(value, '$.project'),
            json_extract(value, '$.agent'), json_extract(value, '$.text'), ?1, NULL, 0, NULL, COALESCE(json_extract(value, '$.since'), ?1)
     FROM json_each(?2) WHERE true
     ON CONFLICT(key) DO UPDATE SET rule = excluded.rule, severity = excluded.severity, origin = excluded.origin,
       host = excluded.host, project = excluded.project, agent = excluded.agent, text = excluded.text,
       opened = CASE WHEN ?1 - alerts.resolved < ?3 THEN alerts.opened ELSE excluded.opened END,
       last_pushed = CASE WHEN ?1 - alerts.resolved < ?3 THEN alerts.last_pushed ELSE NULL END,
       push_count = CASE WHEN ?1 - alerts.resolved < ?3 THEN alerts.push_count ELSE 0 END,
       summarized_at = CASE WHEN ?1 - alerts.resolved < ?3 THEN alerts.summarized_at ELSE NULL END,${wb}
       since = excluded.since,
       resolved = NULL
     WHERE alerts.resolved IS NOT NULL
     RETURNING key, host`,
    now,
    JSON.stringify(alerts),
    REOPEN_GRACE_MS,
  );
}

/** "no such column: wb_digested": the database has no migration 0007 yet. */
export const isNoWbColumn = (err: unknown): boolean => /no such column:?\s*(alerts\.)?wb_digested/i.test(err instanceof Error ? err.message : String(err));

/**
 * Rewrite the text of OPEN `alerts-capped` items whose count has moved (`?1`: JSON array of {key, text}). Only a row
 * whose text really differs is written (`RETURNING key, host`: what changed, so the owner is charged for it).
 */
export function refreshNoticesStmt(db: D1Database, notices: Array<{ key: string; text: string }>): D1PreparedStatement {
  const next = "(SELECT json_extract(value, '$.text') FROM json_each(?1) WHERE json_extract(value, '$.key') = alerts.key)";
  return stmt(
    db,
    `UPDATE alerts SET text = ${next}
      WHERE resolved IS NULL AND rule = 'alerts-capped' AND key IN (SELECT json_extract(value, '$.key') FROM json_each(?1))
        AND text IS NOT ${next}
      RETURNING key, host`,
    JSON.stringify(notices),
  );
}

export function resolveAlertsStmt(db: D1Database, keys: string[], now: number): D1PreparedStatement {
  return stmt(
    db,
    "UPDATE alerts SET resolved = ?1 WHERE resolved IS NULL AND key IN (SELECT value FROM json_each(?2)) RETURNING key, host",
    now,
    JSON.stringify(keys),
  );
}
