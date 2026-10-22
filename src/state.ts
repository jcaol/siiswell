/**
 * @file GET /api/state aggregation (read-only, Access-protected by the router).
 * @module dashboard-worker/state
 */
import { HOOK_IDLE_LINE, HOOK_MARK, HOOK_STALE_LINE } from "./shared/hook";
import { SQL_RELAY_ORIGINS, sqlCanonicalOrigin } from "./shared/wire";
import {
  HOST_OFFLINE_AFTER_MS,
  type AgentSnapshot,
  type DashboardTextMode,
  type DiscussionSnapshot,
  type PollerSnapshot,
} from "./shared/schema";
import { META_RULES_TRUNCATED, SQL_META_GET, parseSnapshotRow } from "./alerts";
import { stmt, type AlertRow, type EventRow, type HostRow, type SnapshotRow, type TaskRow } from "./db";
import { activeDiscussions } from "./host-ext/state";
import { DASHBOARD_VERSION, MAX_STATE_ALERTS, MAX_STATE_ALERTS_PER_HOST, MAX_STORED_AGENTS, MAX_STORED_DISCUSSIONS, MAX_STORED_SNAPSHOT_BYTES } from "./env";

const DAY_MS = 86_400_000;
const MAX_TASKS = 300;
const MAX_EVENTS = 50;

// Polled every 20 s by every open tab, so each query is index-backed (EXPLAINed in test/queries.test.ts):
// open tasks and recently closed ones come from idx_tasks_state_updated, never a table scan.
/**
 * The open alerts, the newest `?1` of EACH HOST (a bounded seek of idx_alerts_host per host: the hosts are found by
 * hopping over that index, one probe each) and `?2` in all, newest first. Reads are the rows returned, not the number
 * of open alerts: a host that holds a thousand cannot lengthen the poll, nor push another host's alerts out of the
 * inbox (a plain "newest 200 of all" would let the noisiest host decide what the operator sees).
 */
export const SQL_STATE_ALERTS = `WITH RECURSIVE h(host) AS (
    SELECT MIN(host) FROM alerts
    UNION ALL
    SELECT (SELECT MIN(a.host) FROM alerts a WHERE a.host > h.host) FROM h WHERE h.host IS NOT NULL
    LIMIT 501
  )
  SELECT a.key, a.rule, a.severity, ${sqlCanonicalOrigin("a.origin")} AS origin, a.host, a.project, a.agent, a.text, a.opened, a.push_count, a.summarized_at
    FROM h JOIN alerts a ON a.rowid IN (
      SELECT x.rowid FROM alerts x WHERE x.host = h.host AND x.resolved IS NULL ORDER BY x.opened DESC LIMIT ?1)
   WHERE h.host IS NOT NULL
   ORDER BY a.opened DESC, a.key LIMIT ?2`;
/** Stored snapshots are capped at write time; a (legacy / hand-written) row over twice the cap is skipped, never parsed. */
export const SQL_STATE_SNAPSHOTS =
  `SELECT host, project, json, received_at FROM snapshots WHERE length(json) <= ${MAX_STORED_SNAPSHOT_BYTES * 2} ORDER BY host, project LIMIT 600`;
/** The whole response stays under this many bytes (the PWA downloads it every 20 s); see fitToBudget. */
export const STATE_MAX_BYTES = 1_000_000;
/** Tasks closed as stale (MCP, no update for 24 h) shown in the state at most: they are a hint, never a flood. */
export const MAX_STALE_TASKS = 50;
export const SQL_STATE_TASKS = `SELECT key, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated FROM (
    SELECT key, ${sqlCanonicalOrigin("origin")} AS origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated FROM tasks
      WHERE state IN ('queued', 'delivered', 'acked', 'running', 'blocked') AND (origin NOT IN (${SQL_RELAY_ORIGINS}) OR updated >= ?1)
    UNION ALL
    SELECT key, ${sqlCanonicalOrigin("origin")} AS origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated FROM tasks
      WHERE state IN ('done', 'failed') AND updated >= ?1
    UNION ALL
    SELECT * FROM (SELECT key, ${sqlCanonicalOrigin("origin")} AS origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated FROM tasks
      WHERE state = 'stale' AND updated >= ?1 ORDER BY updated DESC LIMIT ${MAX_STALE_TASKS})
  ) ORDER BY updated DESC, key LIMIT ${MAX_TASKS}`;
/** Per-project liveness: at most MAX_PROJECTS_PER_HOST rows per host, and the snapshot list below is cut at 600. */
export const SQL_STATE_PROJECT_SEEN = "SELECT host, project, last_seen FROM project_seen ORDER BY host, project LIMIT 600";
export const SQL_STATE_EVENTS = `SELECT key, host, project, kind, ${sqlCanonicalOrigin("origin")} AS origin, agent, scenario, status, severity, text, sender, at FROM events
  ORDER BY at DESC, key LIMIT ${MAX_EVENTS}`;

export interface StateResponse {
  now: number;
  /**
   * Rule inputs (`tasks`, `events`, `alerts`, `snapshots`, `hosts`, `budgets`) whose scan hit its LIMIT in the
   * last evaluation: the dependent alerts were not resolved, and a flood is the likely cause. Empty = healthy.
   */
  rulesTruncated: string[];
  /**
   * Parts that were dropped or cut to keep the response under STATE_MAX_BYTES (least important first):
   * `events`, `discussions`, `closed-tasks`, `agents`, `tasks`, `inbox`, `projects`. Empty = the full picture. `inbox` is
   * also named when a host has more open alerts than the inbox shows per host (the newest ones are shown).
   */
  truncated: string[];
  /** `push_count` = individual pushes really sent; `summarized_at` set = only a budget summary push mentioned it. */
  inbox: Array<Pick<AlertRow, "key" | "rule" | "severity" | "origin" | "host" | "project" | "agent" | "text" | "opened" | "push_count" | "summarized_at">>;
  hosts: Array<{ host: string; lastSeen: number; offline: boolean; binaryVersion: string | null; projects: string[]; clientVersion?: string | null }>;
  /**
   * `receivedAt` = when the last CHANGED snapshot arrived (an unchanged project sends heartbeats instead, so it can be hours old
   * on a healthy host); `lastSeen` = when anything (snapshot, heartbeat, events) last arrived for the project, null when not
   * recorded (a project that has not reported since migration 0002). The page calls a project whose `lastSeen` is older than
   * PROJECT_OFFLINE_AFTER_MS "reporter offline" even when its host is online.
   * `textMode` = the pusher's `dashboard.text` ("full" for a pusher that does not say): the UI says "details hidden" where text is missing.
   */
  projects: Array<{ host: string; project: string; poller: PollerSnapshot; agents: AgentSnapshot[]; receivedAt: number; lastSeen: number | null; textMode: DashboardTextMode }>;
  tasks: Array<{
    key: string;
    origin: string;
    host: string | null;
    project: string | null;
    agent: string | null;
    taskId: string;
    title: string;
    state: string;
    etaAt: number | null;
    lastLine: string | null;
    /** epoch ms the task was dispatched (host agent) or first reported (the other origins). */
    startedAt: number;
    updated: number;
    /** MCP tasks: the machine label the client sent (migration 0006), else null */
    machine: string | null;
    /** a value of TASK_KINDS (migration 0014), else null */
    kind: string | null;
  }>;
  /**
   * MCP-reported work grouped by machine (else the client token's name) and project: "laptop / web" holds the tasks of
   * agent@claude-code-laptop and agent@codex-laptop. Built from `tasks` (open, and closed in the last 24 h). Additive field.
   */
  mcpProjects: McpProject[];
  discussions: Array<DiscussionSnapshot & { host: string; project: string }>;
  clients: Array<{ name: string; lastSeen: number | null; clientVersion?: string | null }>;
  /** This server's version, for the "update available" note next to a source's reported CLI version. */
  serverVersion?: string;
  events: Array<{
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
  }>;
}

export interface McpProject {
  /** the machine label, or the client name when the client sent none (`byMachine` false) */
  group: string;
  byMachine: boolean;
  project: string;
  /** client token names that reported here */
  clients: string[];
  /** `agent@client` labels */
  agents: string[];
  open: number;
  blocked: number;
  lastUpdate: number;
  /** keys of the tasks (into `tasks`), open first */
  taskKeys: string[];
}
export const MAX_MCP_PROJECTS = 100;
const OPEN_TASK = new Set(["queued", "delivered", "acked", "running", "blocked"]);

/** Group the MCP tasks of the state by (machine or client) and project. */
export function groupMcpProjects(tasks: StateResponse["tasks"]): McpProject[] {
  const groups = new Map<string, McpProject>();
  for (const t of tasks) {
    if (t.origin !== "mcp" || !t.project) continue;
    const client = t.host ?? t.key.split("|")[1] ?? "client";
    const group = t.machine ?? client;
    const k = `${group}\u0000${t.project}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { group, byMachine: t.machine !== null, project: t.project, clients: [], agents: [], open: 0, blocked: 0, lastUpdate: 0, taskKeys: [] }));
    if (!g.clients.includes(client)) g.clients.push(client);
    if (t.agent && !g.agents.includes(t.agent)) g.agents.push(t.agent);
    if (OPEN_TASK.has(t.state)) g.open++;
    if (t.state === "blocked") g.blocked++;
    g.lastUpdate = Math.max(g.lastUpdate, t.updated);
    g.taskKeys.push(t.key);
  }
  const open = new Map(tasks.map((t) => [t.key, OPEN_TASK.has(t.state)] as const));
  for (const g of groups.values()) {
    g.clients.sort();
    g.agents.sort();
    g.taskKeys.sort((a, b) => Number(open.get(b)) - Number(open.get(a)));
  }
  return [...groups.values()]
    .sort((a, b) => b.blocked - a.blocked || b.open - a.open || b.lastUpdate - a.lastUpdate || a.group.localeCompare(b.group) || a.project.localeCompare(b.project))
    .slice(0, MAX_MCP_PROJECTS);
}

/** The machine label of the given MCP task keys (migration 0006: a missing column means none). Primary-key lookups only. */
async function machinesOf(db: D1Database, keys: string[], column: "machine" | "kind" = "machine"): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  try {
    const res = await db.prepare(`SELECT key, ${column} AS v FROM tasks WHERE key IN (SELECT value FROM json_each(?1)) AND ${column} IS NOT NULL`).bind(JSON.stringify(keys)).all();
    for (const r of (res.results ?? []) as Array<{ key: string; v: string }>) out.set(r.key, r.v);
  } catch (err) {
    if (!/no such column|has no column/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  return out;
}

/** Fixed server / hook lines carry no typed text, so they are shown whatever ACCEPT_LAST_LINE says. */
const isFixedLine = (l: string | null): boolean => l === HOOK_MARK || l === HOOK_STALE_LINE || l === HOOK_IDLE_LINE;

export async function buildState(db: D1Database, now: number, acceptLastLine = false): Promise<StateResponse> {
  const [alerts, hosts, snapshots, tasks, clients, events, meta] = await db.batch([
    db.prepare(SQL_STATE_ALERTS).bind(MAX_STATE_ALERTS_PER_HOST + 1, MAX_STATE_ALERTS + 1),
    db.prepare("SELECT host, last_seen, binary_version FROM hosts ORDER BY host LIMIT 500"),
    db.prepare(SQL_STATE_SNAPSHOTS),
    db.prepare(SQL_STATE_TASKS).bind(now - DAY_MS),
    db.prepare("SELECT name, last_seen FROM sources WHERE kind = 'client' AND revoked = 0 ORDER BY name LIMIT 200"),
    db.prepare(SQL_STATE_EVENTS),
    stmt(db, SQL_META_GET, META_RULES_TRUNCATED),
  ]);
  // Per-project liveness (migration 0002), on its own so that a missing table costs nothing else.
  const seen = new Map<string, number>();
  try {
    const res = await db.prepare(SQL_STATE_PROJECT_SEEN).all();
    for (const r of (res.results ?? []) as unknown as Array<{ host: string; project: string; last_seen: number }>) seen.set(`${r.host}|${r.project}`, r.last_seen);
  } catch {
    /* no table yet: lastSeen is null for every project */
  }
  // The CLI version each source last reported (migration 0013), on its own so that a missing column costs nothing else.
  const reported = new Map<string, string>();
  try {
    const res = await db.prepare("SELECT kind, name, client_version FROM sources WHERE revoked = 0 AND client_version IS NOT NULL LIMIT 700").all();
    for (const r of (res.results ?? []) as unknown as Array<{ kind: string; name: string; client_version: string }>) reported.set(`${r.kind}|${r.name}`, r.client_version);
  } catch {
    /* no column yet: no version is shown */
  }
  let rulesTruncated: string[] = [];
  try {
    const stored = JSON.parse(((meta?.results ?? [])[0] as { v?: string } | undefined)?.v ?? "[]") as unknown;
    if (Array.isArray(stored)) rulesTruncated = stored.filter((x): x is string => typeof x === "string");
  } catch {
    /* an unreadable flag is no flag */
  }

  const parsed = ((snapshots?.results ?? []) as unknown as SnapshotRow[])
    .map(parseSnapshotRow)
    .filter((s): s is NonNullable<ReturnType<typeof parseSnapshotRow>> => s !== null);

  const projectsByHost = new Map<string, string[]>();
  for (const s of parsed) {
    const list = projectsByHost.get(s.host) ?? [];
    list.push(s.project);
    projectsByHost.set(s.host, list);
  }

  // One more than shown, per host and in all, is how the inbox knows it was cut (and says so in `truncated`).
  const inboxAll = (alerts?.results ?? []) as unknown as StateResponse["inbox"];
  const perHost = new Map<string, number>();
  let inboxCut = inboxAll.length > MAX_STATE_ALERTS;
  const inbox = inboxAll.slice(0, MAX_STATE_ALERTS).filter((a) => {
    const n = (perHost.get(a.host ?? "") ?? 0) + 1;
    perHost.set(a.host ?? "", n);
    if (n <= MAX_STATE_ALERTS_PER_HOST) return true;
    inboxCut = true;
    return false;
  });

  const state: StateResponse = {
    now,
    rulesTruncated,
    truncated: inboxCut ? ["inbox"] : [],
    inbox,
    hosts: ((hosts?.results ?? []) as unknown as HostRow[]).map((h) => ({
      host: h.host,
      lastSeen: h.last_seen,
      offline: now - h.last_seen > HOST_OFFLINE_AFTER_MS,
      binaryVersion: h.binary_version,
      projects: projectsByHost.get(h.host) ?? [],
      clientVersion: reported.get(`host|${h.host}`) ?? null,
    })),
    projects: parsed.map((s) => ({
      host: s.host,
      project: s.project,
      poller: s.snap.poller,
      agents: s.snap.agents.slice(0, MAX_STORED_AGENTS),
      receivedAt: s.receivedAt,
      lastSeen: seen.get(`${s.host}|${s.project}`) ?? null,
      textMode: s.snap.textMode ?? "full",
    })),
    tasks: ((tasks?.results ?? []) as unknown as TaskRow[]).map((t) => ({
      key: t.key,
      origin: t.origin,
      host: t.host,
      project: t.project,
      agent: t.agent,
      taskId: t.task_id,
      title: t.title,
      state: t.state,
      etaAt: t.eta_at,
      lastLine: acceptLastLine || isFixedLine(t.last_line) ? t.last_line : null,
      startedAt: t.created,
      updated: t.updated,
      machine: null as string | null,
      kind: null as string | null,
    })),
    mcpProjects: [],
    // Only ACTIVE discussions, at most MAX_STORED_DISCUSSIONS per project (the stored snapshot is capped the same way).
    discussions: parsed.flatMap((s) => activeDiscussions(s.snap.discussions, s.host, s.project, MAX_STORED_DISCUSSIONS)),
    clients: ((clients?.results ?? []) as unknown as Array<{ name: string; last_seen: number | null }>).map((c) => ({
      name: c.name,
      lastSeen: c.last_seen,
      clientVersion: reported.get(`client|${c.name}`) ?? null,
    })),
    serverVersion: DASHBOARD_VERSION,
    events: ((events?.results ?? []) as unknown as EventRow[]).map((e) => ({
      key: e.key,
      host: e.host,
      project: e.project,
      kind: e.kind,
      origin: e.origin,
      agent: e.agent,
      scenario: e.scenario,
      status: e.status,
      severity: e.severity,
      text: e.text,
      sender: e.sender,
      at: e.at,
    })),
  };
  const mcpKeys = state.tasks.filter((t) => t.origin === "mcp").map((t) => t.key);
  const machines = await machinesOf(db, mcpKeys);
  const kinds = await machinesOf(db, mcpKeys, "kind");
  for (const t of state.tasks) {
    t.machine = machines.get(t.key) ?? null;
    t.kind = kinds.get(t.key) ?? null;
  }
  state.mcpProjects = groupMcpProjects(state.tasks);
  return fitToBudget(state);
}

const sizeOf = (v: unknown): number => JSON.stringify(v).length;

/**
 * Cap the whole response at STATE_MAX_BYTES, whatever is in the database. Parts are dropped or cut least
 * important first (old events, discussions, finished tasks, agent lists, open tasks, inbox, then projects), each
 * step only while the response is still too big, and every step taken is named in `truncated` so the UI says
 * so. Normal installations (a few hundred KB at most) never see any of it.
 */
export function fitToBudget(state: StateResponse): StateResponse {
  let size = sizeOf(state);
  const cut = (name: string, apply: () => void): boolean => {
    if (size <= STATE_MAX_BYTES) return false;
    apply();
    if (!state.truncated.includes(name)) state.truncated.push(name);
    size = sizeOf(state);
    return true;
  };
  cut("events", () => (state.events = []));
  cut("discussions", () => (state.discussions = []));
  cut("closed-tasks", () => (state.tasks = state.tasks.filter((t) => t.state !== "done" && t.state !== "failed" && t.state !== "skipped" && t.state !== "stale")));
  cut("agents", () => (state.projects = state.projects.map((p) => ({ ...p, agents: p.agents.slice(0, 5) }))));
  cut("tasks", () => (state.tasks = state.tasks.slice(0, 100)));
  cut("inbox", () => (state.inbox = state.inbox.slice(0, 100)));
  cut("projects", () => (state.projects = state.projects.slice(0, 60)));
  cut("mcp-projects", () => (state.mcpProjects = state.mcpProjects.slice(0, 20)));
  // last resort: the response is still over budget, so shed whole sections that are not needed to see the problem
  while (size > STATE_MAX_BYTES && state.projects.length > 1) {
    state.projects = state.projects.slice(0, Math.ceil(state.projects.length / 2));
    if (!state.truncated.includes("projects")) state.truncated.push("projects");
    size = sizeOf(state);
  }
  return state;
}
