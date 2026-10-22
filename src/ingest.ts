/**
 * @file Host ingest: POST /api/ingest/{snapshot,events,heartbeat} (bearer token of kind `host`).
 * @module dashboard-worker/ingest
 *
 * The sender is never trusted:
 * - bodies are size-capped, `v` must be 1, enums are validated, unknown fields are dropped (the
 *   sanitizers build fresh objects), numbers are clamped, free text is re-clipped and re-redacted;
 * - IDENTIFIERS (host, project, agent, task/approval/discussion ids, chat senders) are validated
 *   against strict character sets and REJECTED with 400, never rewritten (redacting `sk-build-server`
 *   to `[redacted]` would break host binding and make different names collide). Agent names are
 *   lower-cased after validation so every comparison downstream is case-insensitive;
 * - a host token is bound to ONE host label (the source name): the payload `host` must equal it
 *   (403 otherwise) and every write uses the token-bound label.
 *
 * Host liveness lives in the small `hosts(host PK, source_id, last_seen, binary_version)` table
 * (chosen over deriving it from snapshots.received_at because a heartbeat carries no snapshot).
 */
import { RELAY_LABEL, STUCK_LABEL, LIMIT_LABEL, APPROVAL_LABEL, LIFECYCLE_LABEL } from "./shared/labels";
import { hostTaskTitle, hostTextMode, type HostTextMode } from "./shared/hosttext";
import { BRIEF_TITLE_MAX } from "./shared/tasktext";
import { ORIGIN_HOST, ORIGIN_RELAY, SQL_HOST_ORIGINS, SQL_RELAY_ORIGINS, canonicalOrigin } from "./shared/wire";
import {
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_TEXT_MODES,
  PUSH_HALT_SCENARIOS,
  MAX_EVENTS_PER_BATCH,
  MAX_SNAPSHOT_BYTES,
  MAX_TASKS_PER_SNAPSHOT,
  MAX_TEXT,
  MAX_TITLE,
  severityForScenario,
  type AgentSnapshot,
  type AgentState,
  type ApprovalSnapshot,
  type DashboardEvent,
  type EventKind,
  type Origin,
  type ProjectSnapshot,
  type ReportStatus,
  type Severity,
  type TaskSnapshot,
  type TaskState,
  type UsageWindow,
} from "./shared/schema";
import { clipText } from "./shared/redact";
import { sanitizeDiscussion, sanitizePoller, type IngestHelpers } from "./host-ext/ingest";
import { applyRules } from "./alerts";
import { authenticateBearer, type FetchLike } from "./auth";
import { DAY_MS, SQL_CLAIM_CRITICAL_HALTS, claim, claimHostWrites, flagBudgetExhausted } from "./budget";
import {
  all,
  deleteAbsentSnapshotTasks,
  insertEventsStmt,
  resolveAlertsStmt,
  upsertHost,
  touchProjectSeen,
  LIVENESS_WRITE_FLOOR_MS,
  upsertRelayTasksStmt,
  upsertSnapshot,
  upsertSnapshotTasks,
  type EventRow,
  type SourceRow,
  type TaskInsert,
  type TaskRow,
} from "./db";
import {
  EVENT_MAX_AGE_MS,
  MAX_CRITICAL_HALTS_PER_DAY,
  HOST_WRITES_BASE,
  HOST_WRITES_PER_PROJECT,
  MAX_HOST_WRITES_PER_DAY,
  MAX_OPEN_TASKS_PER_HOST,
  MAX_PROJECTS_PER_HOST,
  MAX_RELAY_TASKS_PER_HOST,
  MAX_RELAY_SENDERS_PER_HOST,
  MAX_RELAY_TASKS_PER_PROJECT,
  MAX_STORED_AGENTS,
  MAX_STORED_APPROVALS,
  MAX_STORED_DISCUSSIONS,
  MAX_STORED_SNAPSHOT_BYTES,
  RELAY_STALE_AFTER_MS,
  WRITE_COST,
  evalMinIntervalMs,
  hostWriteBudget,
  type AppCtx,
  type Env,
} from "./env";
import {
  BASE_CLI_RE,
  BadRequest,
  HOST_RE,
  ID_RE,
  PROJECT_RE,
  SCENARIO_RE,
  SENDER_RE,
  agentId,
  cleanKey,
  errorJson,
  ident,
  isObj,
  json,
  num,
  optAgentId,
  optIdent,
  readBodyText,
  sha256Hex,
} from "./util";

const AGENT_STATES: readonly AgentState[] = [
  "working", "idle", "frozen", "killed", "wedged", "benched", "usage-limit", "compacting", "unknown",
];
const TASK_STATES: readonly TaskState[] = [
  "queued", "delivered", "acked", "running", "blocked", "done", "failed", "skipped",
];
const REPORT_STATUSES: readonly ReportStatus[] = ["IN_PROGRESS", "BLOCKED", "DONE"];
const SEVERITIES: readonly Severity[] = ["info", "warn", "critical"];
const EVENT_KINDS: readonly EventKind[] = ["halt", "status", "approval", "lifecycle"];
/** `mcp` events are produced by the Worker itself, never accepted from a host. */
const INGEST_ORIGINS: readonly Origin[] = [ORIGIN_HOST, ORIGIN_RELAY];

const MAX_NAMES = 20;
const MAX_ETA_MIN = 7 * 24 * 60;

export type Sanitized<T> = { ok: true; value: T } | { ok: false; error: string };

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}
function clampPct(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.max(0, Math.min(100, n));
}
function ts(v: unknown, now: number): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.max(0, Math.min(n, now));
}
/**
 * Items rejected for a bad identifier. A snapshot/event batch is validated ITEM BY ITEM: a bad item is
 * dropped and counted (`dropped`, `firstError` in the response), never a reason to 400 the whole request:
 * a rejected snapshot would freeze that project on the dashboard (the sender keeps its old state).
 * Only `v`, `host` and `project` are batch-level.
 */
class Issues {
  dropped = 0;
  firstError?: string;
  note(err: BadRequest): void {
    this.dropped++;
    this.firstError ??= err.message;
  }
}

/** Run `fn`; a BadRequest is recorded and `fallback` returned (the field, not the item, is dropped). */
function tolerant<T>(issues: Issues, field: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof BadRequest)) throw err;
    issues.note(new BadRequest(`${field}: ${err.message}`));
    return fallback;
  }
}

function agentNames(v: unknown, field: string, issues: Issues): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  v.slice(0, MAX_NAMES).forEach((x, i) => {
    const name = tolerant<string | undefined>(issues, `${field}[${i}]`, () => agentId(x, field), undefined);
    if (name !== undefined) out.push(name);
  });
  return out;
}
function drop<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
/** Run a sanitizer; a BadRequest becomes `{ ok: false }` (HTTP 400), anything else is a bug and propagates. */
function guard<T>(fn: () => T): Sanitized<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof BadRequest) return { ok: false, error: err.message };
    throw err;
  }
}
function withField<T>(field: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof BadRequest) throw new BadRequest(`${field}: ${err.message}`);
    throw err;
  }
}

// ── snapshot ─────────────────────────────────────────────────────────────────

function sanitizeAgent(raw: unknown, now: number, issues: Issues): AgentSnapshot | null {
  if (!isObj(raw)) return null;
  const usage: UsageWindow[] = [];
  if (Array.isArray(raw.usage)) {
    for (const u of raw.usage.slice(0, 6)) {
      if (!isObj(u)) continue;
      const label = clipText(typeof u.label === "string" ? u.label : "", 24);
      const used = num(u.usedPercent);
      if (!label || used === undefined) continue;
      usage.push(drop({ label, usedPercent: Math.max(0, Math.min(100, used)), resetsAt: num(u.resetsAt) }));
    }
  }
  return drop({
    name: agentId(raw.name, "name"),
    baseCli: tolerant(issues, "baseCli", () => optIdent(raw.baseCli, BASE_CLI_RE, "baseCli"), undefined),
    state: oneOf(raw.state, AGENT_STATES) ?? "unknown",
    stateSince: ts(raw.stateSince, now),
    contextTokens: num(raw.contextTokens) === undefined ? undefined : Math.max(0, num(raw.contextTokens) as number),
    contextPercent: clampPct(raw.contextPercent),
    usage: usage.length ? usage : undefined,
    currentTaskId: tolerant(issues, "currentTaskId", () => optIdent(raw.currentTaskId, ID_RE, "currentTaskId"), undefined),
    lastReplyAt: ts(raw.lastReplyAt, now),
  });
}

function sanitizeTask(raw: unknown, now: number, acceptLastLine: boolean): TaskSnapshot | null {
  if (!isObj(raw)) return null;
  const id = ident(raw.id, ID_RE, "id");
  const agent = agentId(raw.agent, "agent");
  const state = oneOf(raw.state, TASK_STATES);
  if (!state) return null;
  const dispatchedAt = ts(raw.dispatchedAt, now) ?? now;
  const updatedAt = ts(raw.updatedAt, now) ?? dispatchedAt;
  return drop({
    id,
    agent,
    title: clipText(typeof raw.title === "string" ? raw.title : "", MAX_TITLE) || "(untitled)",
    state,
    dispatchedAt,
    updatedAt,
    etaAt: num(raw.etaAt),
    lastLine: acceptLastLine && typeof raw.lastLine === "string" ? clipText(raw.lastLine, MAX_TEXT) || undefined : undefined,
    originEventId: typeof raw.originEventId === "string" ? cleanKey(raw.originEventId, 200) || undefined : undefined,
    roomId: typeof raw.roomId === "string" ? cleanKey(raw.roomId, 200) || undefined : undefined,
  });
}

/** The generic helpers the optional host-integration sanitisers (src/host-ext) use. */
const HOST_EXT_HELPERS: IngestHelpers<Issues> = {
  isObj,
  ident,
  idRe: ID_RE,
  clipText,
  num,
  ts,
  agentNames,
  optAgent: (issues, v, field) => tolerant(issues, field, () => optAgentId(v, field), undefined),
  drop,
};

function sanitizeApproval(raw: unknown, now: number, issues: Issues): ApprovalSnapshot | null {
  if (!isObj(raw)) return null;
  return drop({
    id: ident(raw.id, ID_RE, "id"),
    summary: clipText(typeof raw.summary === "string" ? raw.summary : "", MAX_TITLE) || "(approval)",
    requestedAt: ts(raw.requestedAt, now),
    expiresAt: num(raw.expiresAt),
    // a bad agent label must not hide the approval itself: keep it, drop the field
    agent: tolerant(issues, "agent", () => optAgentId(raw.agent, "agent"), undefined),
  });
}

/** Sanitise a list item by item; an item that throws a BadRequest is dropped and counted. */
function each<T>(issues: Issues, field: string, list: unknown[], max: number, fn: (raw: unknown, i: number) => T | null): T[] {
  const out: T[] = [];
  list.slice(0, max).forEach((raw, i) => {
    try {
      const v = withField(`${field}[${i}]`, () => fn(raw, i));
      if (v !== null) out.push(v);
    } catch (err) {
      if (!(err instanceof BadRequest)) throw err;
      issues.note(err);
    }
  });
  return out;
}

export type SnapshotResult =
  | { ok: true; value: ProjectSnapshot; dropped: number; firstError?: string }
  | { ok: false; error: string };

/** ACCEPT_LAST_LINE=1 keeps the `lastLine` of host snapshots; anything else (the default) drops it. */
export const acceptsLastLine = (env: { ACCEPT_LAST_LINE?: string }): boolean => env.ACCEPT_LAST_LINE === "1";

export function sanitizeSnapshot(raw: unknown, now: number, acceptLastLine = false): SnapshotResult {
  if (!isObj(raw)) return { ok: false, error: "body must be a JSON object" };
  if (raw.v !== DASHBOARD_SCHEMA_VERSION) return { ok: false, error: `unsupported schema version (expected v=${DASHBOARD_SCHEMA_VERSION})` };
  if (!isObj(raw.poller)) return { ok: false, error: "poller is required" };
  if (!Array.isArray(raw.agents) || !Array.isArray(raw.tasks)) return { ok: false, error: "agents and tasks must be arrays" };
  if (raw.tasks.length > MAX_TASKS_PER_SNAPSHOT) return { ok: false, error: `too many tasks (max ${MAX_TASKS_PER_SNAPSHOT})` };
  const p = raw.poller;
  const issues = new Issues();
  // Only `host` and `project` are batch-level (a snapshot for an unknown place cannot be stored); every
  // list item is validated on its own and a bad one is dropped and counted.
  const batch = guard(() => ({ host: ident(raw.host, HOST_RE, "host"), project: ident(raw.project, PROJECT_RE, "project") }));
  if (!batch.ok) return batch;
  const { host, project } = batch.value;
  const seen = new Set<string>();
  const tasks = each(issues, "tasks", raw.tasks as unknown[], MAX_TASKS_PER_SNAPSHOT, (t) => {
    const clean = sanitizeTask(t, now, acceptLastLine);
    if (!clean || seen.has(clean.id)) return null;
    seen.add(clean.id);
    return clean;
  });
  const value: ProjectSnapshot = {
    v: DASHBOARD_SCHEMA_VERSION,
    host,
    project,
    sentAt: ts(raw.sentAt, now) ?? now,
    poller: sanitizePoller(p, now, HOST_EXT_HELPERS),
    agents: each(issues, "agents", raw.agents as unknown[], MAX_STORED_AGENTS, (a) => sanitizeAgent(a, now, issues)),
    tasks,
    discussions: each(issues, "discussions", Array.isArray(raw.discussions) ? raw.discussions : [], MAX_STORED_DISCUSSIONS, (d) => sanitizeDiscussion(d, now, issues, HOST_EXT_HELPERS)),
    approvals: each(issues, "approvals", Array.isArray(raw.approvals) ? raw.approvals : [], MAX_STORED_APPROVALS, (a) => sanitizeApproval(a, now, issues)),
    // The pusher's privacy mode (`dashboard.text`), shown by the UI where text is missing. An unknown value = absent = full.
    ...(oneOf(raw.textMode, DASHBOARD_TEXT_MODES) ? { textMode: oneOf(raw.textMode, DASHBOARD_TEXT_MODES) } : {}),
  };
  // Lists longer than the stored caps are cut (the cap, not a validation error, so say it once).
  for (const [name, list, max] of [["agents", raw.agents, MAX_STORED_AGENTS], ["discussions", raw.discussions, MAX_STORED_DISCUSSIONS], ["approvals", raw.approvals, MAX_STORED_APPROVALS]] as const) {
    if (Array.isArray(list) && list.length > max) {
      issues.dropped += list.length - max;
      issues.firstError ??= `${name}: only the first ${max} are kept`;
    }
  }
  return { ok: true, value, dropped: issues.dropped, ...(issues.firstError ? { firstError: issues.firstError } : {}) };
}


const WORD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;
const WINDOW_RE = /^(\d{1,4}(h|min|d)|weekly|daily|monthly|week|day|session)$/i;
/** A one-word status / name, or "" (free text is dropped). */
const keepIdent = (v: string): string => (WORD_RE.test(v) ? v : "");
const lowAgent = (a: ProjectSnapshot["agents"][number]): ProjectSnapshot["agents"][number] =>
  a.usage ? { ...a, usage: a.usage.map((u) => ({ ...u, label: WINDOW_RE.test(u.label) ? u.label : "window" })) } : a;
const lowPoller = (p: ProjectSnapshot["poller"]): ProjectSnapshot["poller"] =>
  p ? { ...p, status: keepIdent(p.status), binaryVersion: VERSION_RE.test(p.binaryVersion) ? p.binaryVersion : "" } : p;

/**
 * ACCEPT_HOST_TEXT (with the source's own task_text): free text of a host snapshot limited BEFORE anything is stored, hashed,
 * evaluated or pushed. Task titles, approval summaries, discussion topics and `lastLine` (see src/shared/hosttext.ts).
 */
export function applyHostText(snap: ProjectSnapshot, mode: HostTextMode): ProjectSnapshot {
  if (mode === "full") return snap;
  const low = mode === "minimal" || mode === "none";
  return {
    ...snap,
    ...(low ? { agents: snap.agents.map(lowAgent), poller: lowPoller(snap.poller) } : {}),
    tasks: snap.tasks.map((t) => {
      const { lastLine, ...rest } = t;
      return { ...rest, title: hostTaskTitle(t.title, t.agent, mode), ...(low || lastLine === undefined ? {} : { lastLine }) };
    }),
    approvals: (snap.approvals ?? []).map((a) => ({ ...a, summary: APPROVAL_LABEL })),
    discussions: (snap.discussions ?? []).map((d) => ({ ...d, topic: low ? "" : clipText(d.topic, BRIEF_TITLE_MAX), ...(low ? { status: keepIdent(d.status) } : {}) })),
  };
}

/**
 * The parts of a snapshot the alert rules and the task table depend on. When a new snapshot has the
 * same fingerprint as the stored one, no task row changes and no rule can flip because of it (time-based
 * flips are the cron's job), so ingest skips the task writes and the rule evaluation.
 */
export function snapshotFingerprint(s: Pick<ProjectSnapshot, "agents" | "tasks" | "approvals">): string {
  return JSON.stringify([s.agents, s.tasks, s.approvals ?? []]);
}

// ── events ───────────────────────────────────────────────────────────────────

export function sanitizeEvent(raw: unknown, now: number): DashboardEvent | null {
  if (!isObj(raw)) return null;
  const kind = oneOf(raw.kind, EVENT_KINDS);
  const origin = oneOf(canonicalOrigin(raw.origin), INGEST_ORIGINS); // legacy values are accepted and stored canonical
  const key = cleanKey(raw.key, 200);
  const at_ = num(raw.at);
  if (!kind || !origin || !key || at_ === undefined) return null;
  // `at` drives the rules' windows and the relay rows' staleness: one older than a day (`at: 0` would make a
  // relay row stale the instant it is written, and so invisible to the per-project row cap) is refused, and a
  // future one is clamped to the server clock.
  if (at_ < now - EVENT_MAX_AGE_MS) throw new BadRequest(`at is older than ${EVENT_MAX_AGE_MS / 3_600_000} hours`);
  const scenarioRaw = optIdent(raw.scenario, SCENARIO_RE, "scenario");
  const scenario = scenarioRaw?.toLowerCase();
  const eta = num(raw.etaMin);
  return drop({
    kind,
    origin,
    at: Math.min(at_, now),
    severity: oneOf(raw.severity, SEVERITIES) ?? severityForScenario(scenario),
    key,
    agent: optAgentId(raw.agent, "agent"),
    scenario,
    status: oneOf(raw.status, REPORT_STATUSES),
    etaMin: eta !== undefined && eta > 0 && eta <= MAX_ETA_MIN ? eta : undefined,
    text: clipText(typeof raw.text === "string" ? raw.text : "", MAX_TEXT),
    sender: optIdent(raw.sender, SENDER_RE, "sender"),
    taskId: optIdent(raw.taskId, ID_RE, "taskId"),
  });
}

export function sanitizeEventBatch(
  raw: unknown,
  now: number,
): Sanitized<{ host: string; project: string; events: DashboardEvent[]; dropped: number; firstError?: string }> {
  if (!isObj(raw)) return { ok: false, error: "body must be a JSON object" };
  if (raw.v !== DASHBOARD_SCHEMA_VERSION) return { ok: false, error: `unsupported schema version (expected v=${DASHBOARD_SCHEMA_VERSION})` };
  if (!Array.isArray(raw.events)) return { ok: false, error: "events must be an array" };
  if (raw.events.length > MAX_EVENTS_PER_BATCH) return { ok: false, error: `too many events (max ${MAX_EVENTS_PER_BATCH})` };
  const list = raw.events;
  return guard(() => {
    const host = ident(raw.host, HOST_RE, "host");
    const project = ident(raw.project, PROJECT_RE, "project");
    // Events are validated ONE BY ONE: a single bad event (e.g. an unusual relay sender) is dropped and
    // counted, never a reason to reject the whole batch — the sender drops a 400'd batch, which would also
    // lose the valid halt notices travelling with it.
    let firstError: string | undefined;
    const events: DashboardEvent[] = [];
    list.slice(0, MAX_EVENTS_PER_BATCH).forEach((e, i) => {
      try {
        const v = withField(`events[${i}]`, () => sanitizeEvent(e, now));
        if (v !== null) events.push(v);
      } catch (err) {
        if (!(err instanceof BadRequest)) throw err;
        firstError ??= err.message;
      }
    });
    return { host, project, events, dropped: list.length - events.length, ...(firstError ? { firstError } : {}) };
  });
}

/** The fixed label stored instead of a relayed agent's pane / reply text when ACCEPT_LAST_LINE is not "1". */

/** Without ACCEPT_LAST_LINE=1: the event with its free text replaced by the fixed label of its kind. */
function fixedEventText(e: DashboardEvent, all = false): DashboardEvent {
  // Exhaustive over every event kind: no path falls through to the raw text of a host-origin event when `all` is set.
  switch (e.kind) {
    case "halt":
      return { ...e, text: e.scenario === "usage-limit" ? LIMIT_LABEL : STUCK_LABEL };
    case "status":
      return all || e.origin === ORIGIN_RELAY ? { ...e, text: RELAY_LABEL } : e;
    case "approval":
      return all ? { ...e, text: APPROVAL_LABEL } : e;
    case "lifecycle":
      return all ? { ...e, text: LIFECYCLE_LABEL } : e;
    default:
      // a kind added later: a generic fixed label, never the raw text
      return all ? { ...e, text: LIFECYCLE_LABEL } : { ...e, text: RELAY_LABEL };
  }
}

/** STATUS event of a foreign (relayed) agent -> the task row that mirrors its latest report. */
function relayTaskFor(host: string, project: string, e: DashboardEvent, now: number, acceptText: boolean): TaskRow | null {
  if (e.origin !== ORIGIN_RELAY || e.kind !== "status" || !e.status) return null;
  const who = e.sender ?? e.agent ?? "unknown";
  const state = e.status === "IN_PROGRESS" ? "running" : e.status === "BLOCKED" ? "blocked" : "done";
  return {
    key: `relay|${host}|${project}|${who}`,
    source_id: "",
    origin: ORIGIN_RELAY,
    host,
    project,
    agent: e.agent ?? who.toLowerCase(),
    task_id: who,
    title: acceptText ? clipText(e.text, MAX_TITLE) || "(status)" : RELAY_LABEL,
    state,
    eta_at: state === "running" && e.etaMin ? e.at + e.etaMin * 60_000 : null,
    last_line: acceptText ? e.text || null : null,
    created: e.at,
    updated: Math.min(e.at, now),
  };
}

// ── heartbeat ────────────────────────────────────────────────────────────────

export function sanitizeHeartbeat(raw: unknown): Sanitized<{ host: string; project?: string; binaryVersion?: string }> {
  if (!isObj(raw)) return { ok: false, error: "body must be a JSON object" };
  if (raw.v !== DASHBOARD_SCHEMA_VERSION) return { ok: false, error: `unsupported schema version (expected v=${DASHBOARD_SCHEMA_VERSION})` };
  return guard(() =>
    drop({
      host: ident(raw.host, HOST_RE, "host"),
      project: optIdent(raw.project, PROJECT_RE, "project"),
      binaryVersion: typeof raw.binaryVersion === "string" ? clipText(raw.binaryVersion, 40) || undefined : undefined,
    }),
  );
}

// ── body reading ─────────────────────────────────────────────────────────────

export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** Read + parse a JSON body, refusing anything over `max` bytes (declared or actual). */
export async function readJsonBody(req: Request, max: number): Promise<BodyResult> {
  const text = await readBodyText(req, max);
  if (!text.ok) return { ok: false, response: errorJson(413, "payload too large") };
  try {
    return { ok: true, value: JSON.parse(text.text) };
  } catch {
    return { ok: false, response: errorJson(400, "body is not valid JSON") };
  }
}

// ── route handler ────────────────────────────────────────────────────────────

export type IngestRoute = "snapshot" | "events" | "heartbeat";

interface StoredTask {
  task_id: string;
  agent: string;
  title: string;
  state: string;
  eta_at: number | null;
  last_line: string | null;
  created: number;
  updated: number;
}

/**
 * Estimated D1 rows written (index entries included) to bring the stored host-agent tasks of a host+project
 * to `tasks`: what the snapshot upsert will actually touch, compared field by field with the rows that are
 * in the tasks table now (the stored snapshot JSON no longer carries them).
 */
export function taskWriteCost(stored: StoredTask[], tasks: TaskSnapshot[]): number {
  const old = new Map(stored.map((t) => [t.task_id, t]));
  let cost = 0;
  const present = new Set<string>();
  for (const t of tasks) {
    present.add(t.id);
    const prev = old.get(t.id);
    if (!prev) cost += WRITE_COST.taskInsert;
    else if (
      prev.agent !== t.agent || prev.title !== t.title || prev.state !== t.state || prev.eta_at !== (t.etaAt ?? null) ||
      prev.last_line !== (t.lastLine ?? null) || prev.created !== t.dispatchedAt || prev.updated !== t.updatedAt
    ) {
      cost += WRITE_COST.taskUpdate;
    }
  }
  for (const id of old.keys()) if (!present.has(id)) cost += WRITE_COST.taskDelete;
  return cost;
}

interface BudgetFlag {
  retryAfter: number;
  until: number;
  newlyFlagged: boolean;
}

/** Events whose loss would silence the one thing the operator must hear about: a stuck / benched / gone agent. */
const isCriticalHalt = (e: DashboardEvent): boolean => e.kind === "halt" && !!e.scenario && PUSH_HALT_SCENARIOS.includes(e.scenario);

const isOpenTaskState = (state: string): boolean => state === "running" || state === "blocked";

/** The host row is refreshed (throttled, so usually no write) by a request that is refused before it wrote anything. */
async function touchHost(db: D1Database, host: string, sourceId: string, now: number): Promise<void> {
  try {
    await upsertHost(db, host, sourceId, now).run();
  } catch {
    /* liveness is best effort */
  }
}

/**
 * 429 for a host token whose estimated write budget for the 24 h window is spent (heartbeats stay open).
 * The refusal is never silent: the first one of a window is recorded on the source (`budget_until`) and the
 * rules are evaluated right away, so the critical `budget-exhausted` alert for this host opens and is pushed
 * now; every budget 429 says so in its body (`budgetExhausted`, `budgetUntil`) so the sender can stop
 * retrying until then and keep heartbeating, and the host still counts as alive (its `last_seen` is
 * refreshed here, otherwise an over-budget host would look offline).
 */
async function refuseOverBudget(env: Env, ctx: AppCtx, source: SourceRow, now: number, fetchImpl: FetchLike | undefined, cap: number, flag?: BudgetFlag): Promise<Response> {
  const f = flag ?? (await flagBudgetExhausted(env.DB, "wr_window_start", source, now));
  await touchHost(env.DB, source.name, source.id, now);
  if (f.newlyFlagged) await applyRules(env, ctx, now, fetchImpl);
  return json(
    {
      error:
        `write budget exhausted: this host token may cause at most ${cap} estimated row writes per 24-hour window ` +
        `(${HOST_WRITES_BASE} plus ${HOST_WRITES_PER_PROJECT} per project, at most ${MAX_HOST_WRITES_PER_DAY}; snapshots, tasks, events and the alerts they open count; ` +
        `heartbeats and up to ${MAX_CRITICAL_HALTS_PER_DAY} critical halt events a day are still accepted); retry in ${f.retryAfter} s`,
      budgetExhausted: true,
      budgetUntil: f.until,
    },
    429,
    { "Retry-After": String(f.retryAfter) },
  );
}

export async function handleIngest(
  req: Request,
  env: Env,
  ctx: AppCtx,
  route: IngestRoute,
  now: number,
  fetchImpl?: FetchLike,
): Promise<Response> {
  if (req.method !== "POST") return errorJson(405, "POST only", { Allow: "POST" });
  const auth = await authenticateBearer(req, env, "host", now);
  if (!auth.ok) return auth.response;
  const source = auth.source;

  const body = await readJsonBody(req, MAX_SNAPSHOT_BYTES);
  if (!body.ok) return body.response;
  const db = env.DB;

  // A host token is bound to ONE host label: the source name. The payload's `host` is only checked
  // against it, and every write below uses `host` (= source.name), never a value the payload asserts,
  // so one token cannot write, delete, take over or resolve anything that belongs to another host.
  const host = source.name;
  const mismatch = (label: string): Response => errorJson(403, `host label '${label}' does not match this token`);
  /** A request refused before it wrote anything still shows the host as alive. */
  const reject = async (res: Response): Promise<Response> => {
    await touchHost(db, host, source.id, now);
    return res;
  };
  const projectLimit = (): Response =>
    errorJson(429, `project limit: host '${host}' already has ${MAX_PROJECTS_PER_HOST} projects, a new one is refused (existing projects keep working); remove an unused project's snapshot or ask the operator`, { "Retry-After": "3600" });

  if (route === "snapshot") {
    const textMode = hostTextMode(env.ACCEPT_HOST_TEXT, source.task_text);
    const s = sanitizeSnapshot(body.value, now, acceptsLastLine(env));
    if (!s.ok) return errorJson(400, s.error);
    const snap = applyHostText(s.value, textMode);
    if (snap.host !== host) return mismatch(snap.host);

    // What this host already has: its projects (at most MAX_PROJECTS_PER_HOST, new ones beyond that are refused),
    // each one's fingerprint (unchanged detection) and open-task count (the per-host cap is their sum).
    const projects = await all<{ project: string; fp: string; open_tasks: number }>(db, "SELECT project, fp, open_tasks FROM snapshots WHERE host = ?1 LIMIT 100", host);
    const mine = projects.find((p) => p.project === snap.project);
    if (!mine && projects.length >= MAX_PROJECTS_PER_HOST) return reject(projectLimit());

    // Per-host cap on running/blocked host-agent tasks (the rules scan them per host): the surplus is dropped and counted.
    let room = Math.max(0, MAX_OPEN_TASKS_PER_HOST - projects.filter((p) => p.project !== snap.project).reduce((n, p) => n + p.open_tasks, 0));
    let dropped = s.dropped;
    let firstError = s.firstError;
    const kept: TaskSnapshot[] = [];
    for (const t of snap.tasks) {
      if (isOpenTaskState(t.state)) {
        if (room <= 0) {
          dropped++;
          firstError ??= `tasks: a host may have at most ${MAX_OPEN_TASKS_PER_HOST} running/blocked tasks, the rest are dropped`;
          continue;
        }
        room--;
      }
      kept.push(t);
    }
    snap.tasks = kept;
    const openTasks = kept.filter((t) => isOpenTaskState(t.state)).length;
    const inserts: TaskInsert[] = kept.map((t) => ({
      key: `${host}|${snap.project}|${t.id}`,
      agent: t.agent,
      task_id: t.id,
      title: t.title,
      state: t.state,
      eta_at: t.etaAt ?? null,
      last_line: t.lastLine ?? null,
      created: t.dispatchedAt,
      updated: t.updatedAt,
    }));

    // The stored JSON has NO tasks (they are rows of the tasks table) and is capped: every rule evaluation and
    // every /api/state parses all of them.
    const { tasks: _tasks, ...storable } = snap;
    void _tasks;
    const storedJson = JSON.stringify(storable);
    const storedBytes = new TextEncoder().encode(storedJson).length;
    if (storedBytes > MAX_STORED_SNAPSHOT_BYTES) {
      return reject(errorJson(413, `snapshot too large: ${storedBytes} bytes stored without its tasks, at most ${MAX_STORED_SNAPSHOT_BYTES} (agents and the optional thread and pending-action lists are what count)`));
    }

    // Same tasks/agents/approvals as the stored snapshot? Then only the snapshot row (poller,
    // discussions, timestamps) and host liveness are written: no task writes, no rule evaluation.
    const fp = await sha256Hex(snapshotFingerprint({ agents: snap.agents, tasks: kept, approvals: snap.approvals }));
    const unchanged = mine !== undefined && mine.fp === fp;
    const storedTasks = unchanged
      ? []
      : await all<StoredTask>(db, `SELECT task_id, agent, title, state, eta_at, last_line, created, updated FROM tasks WHERE origin IN (${SQL_HOST_ORIGINS}) AND host = ?1 AND project = ?2`, host, snap.project);
    // Write budget: claim the estimated rows BEFORE writing (one conditional UPDATE of the token's row). A snapshot
    // is ONE row however large (its size is capped at 32 KB, which bounds storage and reads, not writes): charged
    // what D1 will bill, an update of the (host, project) row 1, the first snapshot of a project 2 (row + key). The
    // budget grows with the host's projects, each of which legitimately sends a snapshot a minute.
    const cap = hostWriteBudget(projects.length + (mine ? 0 : 1));
    const cost = WRITE_COST.request + (mine ? WRITE_COST.snapshotRow : WRITE_COST.snapshotInsert) + (unchanged ? 0 : taskWriteCost(storedTasks, kept));
    // The same UPDATE stamps the evaluation throttle: an unchanged snapshot cannot flip a rule (no stamp, no evaluation),
    // a changed one evaluates the rules at most once per RULES_MIN_INTERVAL (the cron runs them every minute anyway).
    const everyMs = evalMinIntervalMs(env);
    const claimed = await claimHostWrites(db, source.id, now, cap, cost, unchanged ? 0 : everyMs);
    if (!claimed.ok) return refuseOverBudget(env, ctx, source, now, fetchImpl, cap);
    const evaluate = !unchanged && (everyMs === 0 || claimed.stamped);
    const stmts = [
      upsertSnapshot(db, source.id, host, snap.project, storedJson, now, fp, openTasks),
      // Every snapshot proves the host is alive (held only to the floor, see LIVENESS_WRITE_FLOOR_MS), and a project that
      // reports again resolves its own `project-offline` alert (the cron re-evaluates everything else).
      upsertHost(db, host, source.id, now, snap.poller.binaryVersion || undefined, LIVENESS_WRITE_FLOOR_MS),
      resolveAlertsStmt(db, [`project-offline|${host}|${snap.project}`], now),
    ];
    if (!unchanged) {
      // The snapshot's 24 h window is authoritative for this host+project's host-agent tasks.
      stmts.push(deleteAbsentSnapshotTasks(db, host, snap.project, inserts.map((t) => t.key)));
      if (inserts.length) stmts.push(upsertSnapshotTasks(db, source.id, host, snap.project, inserts));
    }
    await db.batch(stmts);
    await touchProjectSeen(db, host, snap.project, now, false);
    const out = evaluate ? await applyRules(env, ctx, now, fetchImpl) : null;
    return json({
      ok: true,
      tasks: inserts.length,
      unchanged,
      dropped,
      ...(firstError ? { firstError } : {}),
      alertsOpened: out?.opened ?? 0,
      alertsResolved: out?.resolved ?? 0,
    });
  }

  if (route === "events") {
    const b = sanitizeEventBatch(body.value, now);
    if (!b.ok) return errorJson(400, b.error);
    const { project, dropped, firstError } = b.value;
    // Relayed agents' status events carry pane / reply text: without ACCEPT_LAST_LINE=1 only a fixed label is kept.
    const textMode = hostTextMode(env.ACCEPT_HOST_TEXT, source.task_text);
    const lowText = textMode === "minimal" || textMode === "none";
    const acceptText = acceptsLastLine(env) && !lowText;
    // Host halt events (stuck / usage limit) carry host-supplied text too: a fixed per-kind label replaces it, and under
    // ACCEPT_HOST_TEXT minimal / none every kind of event text is a fixed label.
    let events = lowText ? b.value.events.map((e) => fixedEventText(e, true)) : acceptText ? b.value.events : b.value.events.map((e) => fixedEventText(e));
    if (b.value.host !== host) return mismatch(b.value.host);
    // Events refresh the host row under the floor too (not the 90 s throttle): the pusher counts an accepted events batch as a
    // heartbeat and sends the next one a full interval later, so a batch that was NOT recorded followed by one lost heartbeat
    // left ~380 s between writes. The route is budgeted (every batch is claimed first), so this adds no unmetered write path.
    const stmts = [upsertHost(db, host, source.id, now, undefined, LIVENESS_WRITE_FLOOR_MS)];
    let relayDropped = 0;
    let overBudget: BudgetFlag | null = null; // set when only the critical halts of this batch were accepted
    let budgetDropped = 0;
    let cap = hostWriteBudget(1); // the host's budget, scaled by its projects once they are known
    let evaluate = false;
    if (events.length) {
      // A project the host has no snapshot for counts towards the per-host project limit as well.
      const projects = await all<{ project: string }>(db, "SELECT project FROM snapshots WHERE host = ?1 LIMIT 100", host);
      if (projects.length >= MAX_PROJECTS_PER_HOST && !projects.some((p) => p.project === project)) return reject(projectLimit());
      cap = hostWriteBudget(Math.max(1, projects.length));
      // Relay (foreign agent) task rows: refuse NEW senders beyond MAX_RELAY_TASKS_PER_PROJECT per host+project
      // and MAX_RELAY_TASKS_PER_HOST per host (stale rows, open for 24 h without an update, do not count; an
      // event older than 24 h is refused outright, so a stale `at` cannot dodge the cap), still update known ones.
      let relay = events.map((e) => relayTaskFor(host, project, e, now, acceptText)).filter((t): t is TaskRow => t !== null);
      let relayCost = 0;
      if (relay.length) {
        const known = await all<{ key: string; project: string; task_id: string }>(
          db,
          `SELECT key, project, task_id FROM tasks WHERE origin IN (${SQL_RELAY_ORIGINS}) AND host = ?1 AND updated >= ?2 LIMIT 401`,
          host,
          now - RELAY_STALE_AFTER_MS,
        );
        const keys = new Set(known.map((r) => r.key));
        // The relay SENDER is a string the host's own payload names, so it cannot be what bounds the host: only
        // MAX_RELAY_SENDERS_PER_HOST distinct senders are mirrored at a time (the push budget has an aggregate
        // per host for the same reason).
        const senders = new Set(known.map((r) => r.task_id));
        let hostCount = keys.size;
        let projectCount = known.filter((r) => r.project === project).length;
        const kept: TaskRow[] = [];
        for (const r of relay) {
          if (keys.has(r.key)) {
            relayCost += WRITE_COST.relayUpdate;
            kept.push(r);
          } else if (projectCount < MAX_RELAY_TASKS_PER_PROJECT && hostCount < MAX_RELAY_TASKS_PER_HOST && (senders.has(r.task_id) || senders.size < MAX_RELAY_SENDERS_PER_HOST)) {
            keys.add(r.key);
            senders.add(r.task_id);
            hostCount++;
            projectCount++;
            relayCost += WRITE_COST.relayInsert;
            kept.push(r);
          } else {
            relayDropped++;
          }
        }
        relay = kept;
      }
      // Write budget: events (rows + indexes) and relay rows, claimed before anything is written.
      const eventCost = events.reduce((n, e) => n + (e.kind === "halt" ? WRITE_COST.haltEvent : WRITE_COST.event), 0);
      const everyMs = evalMinIntervalMs(env);
      const claimed = await claimHostWrites(db, source.id, now, cap, WRITE_COST.request + eventCost + relayCost, everyMs);
      evaluate = claimed.ok && (everyMs === 0 || claimed.stamped);
      if (!claimed.ok) {
        // Over budget. Say so (alert + heartbeat flag), but never drop a critical halt: those have their own
        // small allowance, and ONLY they are written (no relay rows, no other events) when it applies.
        const flag = await flagBudgetExhausted(db, "wr_window_start", source, now);
        const usedHalts = now - source.hl_window_start >= DAY_MS ? 0 : source.hl_count;
        const critical = events.filter(isCriticalHalt).slice(0, Math.max(0, MAX_CRITICAL_HALTS_PER_DAY - usedHalts));
        if (!critical.length || !(await claim(db, SQL_CLAIM_CRITICAL_HALTS, source.id, now, DAY_MS, MAX_CRITICAL_HALTS_PER_DAY, critical.length))) {
          return refuseOverBudget(env, ctx, source, now, fetchImpl, cap, flag);
        }
        overBudget = flag;
        evaluate = true; // an agent-stuck halt must open its alert now: bounded by the critical-halt allowance, not by the throttle
        budgetDropped = events.length - critical.length;
        events = critical;
        relay = [];
      }
      const rows: EventRow[] = events.map((e) => ({
        key: e.key,
        host,
        project,
        kind: e.kind,
        origin: e.origin,
        agent: e.agent ?? null,
        scenario: e.scenario ?? null,
        status: e.status ?? null,
        severity: e.severity,
        text: e.text,
        sender: e.sender ?? null,
        at: e.at,
        received_at: now,
      }));
      // Event keys are only deduplicated within one source, so a guessed key cannot suppress
      // another source's event.
      stmts.push(insertEventsStmt(db, source.id, rows));
      if (relay.length) stmts.push(upsertRelayTasksStmt(db, source.id, relay));
    }
    await db.batch(stmts);
    await touchProjectSeen(db, host, project, now, true); // events prove the project's reporter is alive too
    const out = evaluate && events.length ? await applyRules(env, ctx, now, fetchImpl) : null;
    return json({
      ok: true,
      accepted: events.length,
      dropped,
      ...(firstError ? { firstError } : {}),
      ...(relayDropped ? { relayDropped } : {}),
      ...(overBudget ? { budgetExhausted: true, budgetUntil: overBudget.until, budgetDropped, retryAfter: overBudget.retryAfter } : {}),
      alertsOpened: out?.opened ?? 0,
    });
  }

  // heartbeat: always accepted (no write budget), so a host over budget still shows as alive. It also says so
  // (`budgetExhausted`), because "alive" would otherwise hide that its snapshots and events are being refused.
  // Its only possible writes are throttled: the host row and the project's `project_seen` row at most once per
  // LIVENESS_WRITE_FLOOR_MS / PROJECT_SEEN_WRITE_FLOOR_MS (whatever `binaryVersion` it carries), the source's `last_seen`,
  // and the resolve of an open host-offline / project-offline alert.
  const h = sanitizeHeartbeat(body.value);
  if (!h.ok) return errorJson(400, h.error);
  if (h.value.host !== host) return mismatch(h.value.host);
  await db.batch([
    // Held only to the floor (LIVENESS_WRITE_FLOOR_MS), not to the 90 s events throttle: every real heartbeat refreshes the row.
    upsertHost(db, host, source.id, now, h.value.binaryVersion, LIVENESS_WRITE_FLOOR_MS),
    // "host seen again" resolves a host-offline alert right away (and the project's own project-offline alert);
    // the cron re-evaluates everything else.
    resolveAlertsStmt(db, h.value.project ? [`host-offline|${host}`, `project-offline|${host}|${h.value.project}`] : [`host-offline|${host}`], now),
  ]);
  await touchProjectSeen(db, host, h.value.project, now, true);
  return json({ ok: true, ...(source.budget_until > now ? { budgetExhausted: true, budgetUntil: source.budget_until } : {}) });
}
