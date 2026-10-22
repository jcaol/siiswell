/**
 * @file MCP over Streamable HTTP for desktop clients: stateless, JSON responses, bearer `client` tokens.
 * @module dashboard-worker/mcp
 *
 * Transport rules implemented (checked against the spec text, see CLIENTS.md for the URLs):
 * - POST /mcp carries one JSON-RPC message (a batch array is accepted too, as in 2025-03-26).
 * - Requests are answered with `Content-Type: application/json`; notifications and responses
 *   with `202 Accepted` and an empty body. GET/DELETE -> 405 (no SSE stream, no sessions, no
 *   `Mcp-Session-Id` is ever issued).
 * - `Origin`, when present, must be ours (403 otherwise, DNS-rebinding guard).
 * - `MCP-Protocol-Version`, when present, must be a version we know (400 otherwise).
 * - Legacy era (<= 2025-11-25): `initialize` negotiates the version; any other request works
 *   without it because the server keeps no state.
 * - Modern era (2026-07-28): no handshake, every request carries `_meta` version + client
 *   capabilities and the mirrored `Mcp-Method` / `Mcp-Name` headers, which are validated;
 *   `server/discover` is implemented and results carry `resultType: "complete"`.
 */
import { operatorStatus } from "./wellbeing-winddown";
import { cachedSettings, wbDefaults } from "./wellbeing";
import {
  MAX_TEXT,
  MAX_TITLE,
  type ReportStatus,
  type Severity,
  type TaskState,
} from "./shared/schema";
import { clipText } from "./shared/redact";
import { applyRules } from "./alerts";
import { authenticateBearer, chargeExtraRequests, type FetchLike } from "./auth";
import { DAY_MS, SQL_CLAIM_MUTATIONS, claim, flagBudgetExhausted, refundMutations } from "./budget";
import { all, first, insertEventsStmt, stmt, type EventRow, type SourceRow, type TaskRow } from "./db";
import { DEFAULT_TASK_TEXT, TASK_KINDS, applyTaskText, normalizeKind, parseTaskText, stricterTaskText } from "./shared/tasktext";
import { DASHBOARD_VERSION, MAX_MCP_MUTATIONS_PER_DAY, MAX_OPEN_MCP_TASKS, type AppCtx, type Env } from "./env";
import {
  BadRequest,
  ID_RE,
  PROJECT_RE,
  accepted,
  errorJson,
  ident,
  isObj,
  json,
  num,
  randomBase36,
  readBodyText,
} from "./util";

export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];
/** Answered to `initialize` when the client asks for a version we do not know. */
export const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

const MAX_MCP_BODY_BYTES = 64 * 1024;
/** JSON-RPC batches (legacy 2025-03-26 only) are capped: each message can write to D1. */
export const MAX_BATCH_MESSAGES = 10;
const MAX_ETA_MIN = 7 * 24 * 60;
/** Longest `agent` argument; the stored agent is `<agent>@<client name>`. */
const MAX_AGENT_ARG = 31;
const AGENT_ARG_RE = new RegExp(`^[A-Za-z0-9._=/-]{1,${MAX_AGENT_ARG}}$`);
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const SERVER_INSTRUCTIONS =
  "Use this server to tell the operator's dashboard what you are working on. Call report_task when you start " +
  "any task that will take longer than about 10 minutes (status IN_PROGRESS, with eta_min), call update_task " +
  "when you are blocked and need the operator (status BLOCKED) and when you finish (status DONE), keeping the " +
  "task_id it returned. Give a short plain description of the action as the title (for example \"Fix login redirect bug\", at most 120 " +
  "characters; the operator's settings may shorten it) and a kind (coding, debugging, testing, review, research, docs, deploy, ops or other). " +
  "Summaries are at most 300 characters. Never put the prompt text, conversation content, file contents, customer data, secrets, " +
  "credentials or tokens in any of them. Always call update_task with status DONE before your final reply, " +
  "even for quick tests: a task left IN_PROGRESS shows as unfinished on the dashboard. Use heartbeat only to show you are alive. " +
  "Before you stop to ask the operator a question, call operator_status: while the operator is away (winding down for the " +
  "night), continue on your own with the safest reasonable choice instead of waiting.";

const STATUS_PROP = {
  type: "string",
  enum: ["IN_PROGRESS", "BLOCKED", "DONE"],
  description: "IN_PROGRESS = working on it, BLOCKED = you need the operator, DONE = finished.",
} as const;

const KIND_PROP = {
  type: "string",
  enum: [...TASK_KINDS],
  description: "The kind of work, one word from the list (an unknown word is stored as \"other\"). Shown next to the title.",
} as const;

export const TOOLS = [
  {
    name: "report_task",
    description:
      "Register a long-running task (anything over ~10 minutes) on the operator's dashboard and get its task_id. " +
      "Call it when you start, with status IN_PROGRESS and a realistic eta_min. Returns {\"task_id\", \"state\"}.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", pattern: PROJECT_RE.source, maxLength: 64, description: "Project label: letters, digits, '.', '_' or '-' (e.g. the repo or folder name)." },
        title: { type: "string", maxLength: MAX_TITLE, description: "A short plain description of the action, under 60 characters (e.g. \"Fix login redirect bug\"). Never prompt text, conversation content, file contents, customer data or secrets." },
        status: STATUS_PROP,
        eta_min: { type: "number", minimum: 1, maximum: MAX_ETA_MIN, description: "Estimated minutes until done (IN_PROGRESS only)." },
        summary: { type: "string", maxLength: MAX_TEXT, description: "Optional one-paragraph status (max 300 chars). No secrets or file contents." },
        kind: KIND_PROP,
        agent: { type: "string", pattern: `^[A-Za-z0-9._=/-]{1,${MAX_AGENT_ARG}}$`, description: "Optional agent label (letters, digits, '.', '_', '=', '/', '-'; default \"agent\"). The dashboard always shows it as <agent>@<this client's name>." },
        machine: { type: "string", pattern: PROJECT_RE.source, maxLength: 64, description: "Optional machine label (filled in by the siiswell stdio server from its config; leave it out). Groups the tasks of several apps on one machine." },
        client_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{16,64}$", description: "Optional idempotency key chosen by the client: a retried call with the same key returns the task already created. Leave it out unless you retry." },
      },
      required: ["project", "title", "kind", "status"],
      additionalProperties: false,
    },
    annotations: { title: "Report a task", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "update_task",
    description:
      "Update a task you registered with report_task: set BLOCKED when you need the operator, DONE when finished, or " +
      "IN_PROGRESS with a new eta_min. An IN_PROGRESS update without eta_min clears the ETA.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", maxLength: 64, description: "The task_id returned by report_task (e.g. m-0a1b2c3d)." },
        status: STATUS_PROP,
        eta_min: { type: "number", minimum: 1, maximum: MAX_ETA_MIN, description: "New estimate in minutes (IN_PROGRESS only)." },
        summary: { type: "string", maxLength: MAX_TEXT, description: "Optional status text (max 300 chars). No secrets or file contents." },
        kind: KIND_PROP,
      },
      required: ["task_id", "status"],
      additionalProperties: false,
    },
    annotations: { title: "Update a task", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "heartbeat",
    description: "Show the dashboard that this client is alive. Cheap; call it only if asked or while idle between long tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", maxLength: 64, description: "Optional project label." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Heartbeat", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_tasks",
    description: "List this client's open tasks (task_id, title, state, eta, last update), newest first. Read-only; use it to find a task_id to close with update_task.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List my open tasks", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "operator_status",
    description: "Is the operator available, or away (winding down for the night) until a given time? Read-only. While away: " +
      "continue on your own with the safest reasonable choice instead of waiting.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Operator status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

type RpcId = string | number;
interface RpcOk {
  jsonrpc: "2.0";
  id: RpcId;
  result: Record<string, unknown>;
}
interface RpcErr {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: { code: number; message: string; data?: unknown };
}
type RpcResponse = RpcOk | RpcErr;

const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_HEADER_MISMATCH = -32020;
const E_UNSUPPORTED_VERSION = -32022;

function rpcError(id: RpcId | null, code: number, message: string, data?: unknown): RpcErr {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function idOf(msg: unknown): RpcId | null {
  return isObj(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
}

interface Call {
  env: Env;
  ctx: AppCtx;
  source: SourceRow;
  now: number;
  fetchImpl?: FetchLike;
  /** Modern (2026-07-28) request: results get resultType + serverInfo meta. */
  modern: boolean;
  /** Shared by every message of one HTTP request: set when a tool wrote, so the rules run ONCE at the end. */
  rules: { dirty: boolean; preclaimed: number; used: number };
}

function ok(id: RpcId, result: Record<string, unknown>, c: Call): RpcOk {
  if (!c.modern) return { jsonrpc: "2.0", id, result };
  const meta = isObj(result._meta) ? result._meta : {};
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...result,
      _meta: { ...meta, [META_SERVER_INFO]: { name: "siiswell", version: DASHBOARD_VERSION } },
    },
  };
}

// ── tool input validation ────────────────────────────────────────────────────

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function normalizeStatus(v: unknown): ReportStatus | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return s === "IN_PROGRESS" || s === "BLOCKED" || s === "DONE" ? s : null;
}

function checkEta(v: unknown): Checked<number | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  const n = num(v);
  if (n === undefined || n <= 0 || n > MAX_ETA_MIN) return { ok: false, error: `eta_min must be a number between 1 and ${MAX_ETA_MIN}` };
  return { ok: true, value: n };
}

function checkOptionalText(v: unknown, field: string, max: number): Checked<string | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "string") return { ok: false, error: `${field} must be a string` };
  return { ok: true, value: clipText(v, max) || undefined };
}

function checkIdent(v: unknown, re: RegExp, field: string): Checked<string> {
  try {
    return { ok: true, value: ident(v, re, field) };
  } catch (err) {
    if (err instanceof BadRequest) return { ok: false, error: err.message };
    throw err;
  }
}

interface ReportArgs {
  project: string;
  title: string;
  status: ReportStatus;
  etaMin?: number;
  summary?: string;
  /** a value of TASK_KINDS (migration 0014), when the client sends one */
  kind?: string;
  /** Lower-cased `agent` argument (default "agent"), WITHOUT the `@<client>` suffix. */
  agent: string;
  /** the machine the task was reported from (migration 0006), when the client says */
  machine?: string;
  /** the client's idempotency key (migration 0010): a repeat returns the task already created */
  clientRef?: string;
}

const CLIENT_REF_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** A database without migration 0010 has no `client_ref` column: the task is then stored without it (no dedupe). */
const isNoClientRefColumn = (err: unknown): boolean => /no (such )?column( named)?:? ?client_ref/i.test(err instanceof Error ? err.message : String(err));

/** The task this source already created with this client_ref, if any (null also without migration 0010). */
async function taskForRef(c: Call, ref: string): Promise<{ task_id: string; state: string } | null> {
  try {
    return await first<{ task_id: string; state: string }>(c.env.DB, "SELECT task_id, state FROM tasks WHERE source_id = ? AND client_ref = ? AND origin = 'mcp'", c.source.id, ref);
  } catch (err) {
    if (isNoClientRefColumn(err)) return null;
    throw err;
  }
}

const DEFAULT_TASK_TITLE = "Task";
/** The `kind` argument as `{kind}` from the fixed list (unknown words become "other"), or nothing. */
const kindOf = (args: Record<string, unknown>): { kind?: string } => {
  const k = normalizeKind(args.kind);
  return k ? { kind: k } : {};
};

function checkReport(args: unknown): Checked<ReportArgs> {
  if (!isObj(args)) return { ok: false, error: "arguments must be an object" };
  const project = checkIdent(args.project, PROJECT_RE, "project");
  if (!project.ok) return project;
  // a client that sends no title (its `taskText` setting is "none") gets a neutral placeholder
  const noTitle = args.title === undefined || args.title === null;
  const title = noTitle ? DEFAULT_TASK_TITLE : typeof args.title === "string" ? clipText(args.title, MAX_TITLE) : "";
  if (!title) return { ok: false, error: "title must be a non-empty string when given" };
  const status = normalizeStatus(args.status);
  if (!status) return { ok: false, error: "status must be one of IN_PROGRESS, BLOCKED, DONE" };
  const eta = checkEta(args.eta_min);
  if (!eta.ok) return eta;
  const summary = checkOptionalText(args.summary, "summary", MAX_TEXT);
  if (!summary.ok) return summary;
  let agent = "agent";
  if (args.agent !== undefined && args.agent !== null) {
    const a = checkIdent(args.agent, AGENT_ARG_RE, "agent");
    if (!a.ok) return a;
    agent = a.value.toLowerCase();
  }
  let machine: string | undefined;
  if (args.machine !== undefined && args.machine !== null) {
    const m = checkIdent(args.machine, PROJECT_RE, "machine");
    if (!m.ok) return m;
    machine = m.value;
  }
  let clientRef: string | undefined;
  if (args.client_ref !== undefined && args.client_ref !== null) {
    if (typeof args.client_ref !== "string" || !CLIENT_REF_RE.test(args.client_ref)) return { ok: false, error: "client_ref must be 16-64 characters: letters, digits, '_' or '-'" };
    clientRef = args.client_ref;
  }
  return { ok: true, value: { project: project.value, title, status, etaMin: eta.value, summary: summary.value, ...kindOf(args), agent, ...(machine ? { machine } : {}), ...(clientRef ? { clientRef } : {}) } };
}

interface UpdateArgs {
  taskId: string;
  status: ReportStatus;
  etaMin?: number;
  summary?: string;
  kind?: string;
}

function checkUpdate(args: unknown): Checked<UpdateArgs> {
  if (!isObj(args)) return { ok: false, error: "arguments must be an object" };
  const taskId = checkIdent(args.task_id, ID_RE, "task_id");
  if (!taskId.ok) return taskId;
  const status = normalizeStatus(args.status);
  if (!status) return { ok: false, error: "status must be one of IN_PROGRESS, BLOCKED, DONE" };
  const eta = checkEta(args.eta_min);
  if (!eta.ok) return eta;
  const summary = checkOptionalText(args.summary, "summary", MAX_TEXT);
  if (!summary.ok) return summary;
  return { ok: true, value: { taskId: taskId.value, status, etaMin: eta.value, summary: summary.value, ...kindOf(args) } };
}

// ── tools ────────────────────────────────────────────────────────────────────

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(t: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

const STATE_FOR_STATUS: Record<ReportStatus, TaskState> = { IN_PROGRESS: "running", BLOCKED: "blocked", DONE: "done" };
const SEVERITY_FOR_STATUS: Record<ReportStatus, Severity> = { IN_PROGRESS: "info", BLOCKED: "warn", DONE: "info" };

/** Events carry the token-bound client name as host and are stored under the calling source. */
function mcpEvent(
  c: Call,
  p: { project: string; agent: string; taskId: string; status: ReportStatus; text: string },
): EventRow {
  return {
    key: `mcp:${p.taskId}:${c.now}:${randomBase36(4)}`,
    host: c.source.name,
    project: p.project,
    kind: "status",
    origin: "mcp",
    agent: p.agent,
    scenario: null,
    status: p.status,
    severity: SEVERITY_FOR_STATUS[p.status],
    text: clipText(p.text, MAX_TEXT),
    sender: null,
    at: c.now,
    received_at: c.now,
  };
}

/**
 * Insert the task only while the client has fewer than MAX_OPEN_MCP_TASKS open tasks (one atomic
 * statement; a DONE report is not open). The open count is a seek per OPEN state on idx_tasks_source,
 * so it reads at most the client's open rows (<= the cap), never its closed history. There is no
 * per-client total-rows cap any more: stored rows are bounded by the mutation budget x retention.
 */
export const INSERT_CAPPED_TASK = `INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated)
  SELECT ?1, ?2, 'mcp', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
  WHERE ?14 = 1 OR (SELECT COUNT(*) FROM tasks
                     WHERE source_id = ?2 AND origin = 'mcp' AND state IN ('queued', 'delivered', 'acked', 'running', 'blocked')) < ?13
  RETURNING key`;

/** INSERT_CAPPED_TASK with the reporting machine (`?15`, migration 0006). */
export const INSERT_CAPPED_TASK_MACHINE = INSERT_CAPPED_TASK
  .replace("created, updated)\n", "created, updated, machine)\n")
  .replace("?11, ?12\n", "?11, ?12, ?15\n");
/** INSERT_CAPPED_TASK with the client's idempotency key (`?16`, migration 0010) and, when `machine`, the machine (`?15`). */
export const insertCappedTaskSql = (machine: boolean, clientRef: boolean, kind = false): string => {
  const cols = [...(machine ? ["machine"] : []), ...(clientRef ? ["client_ref"] : []), ...(kind ? ["kind"] : [])];
  const vals = [...(machine ? ["?15"] : []), ...(clientRef ? ["?16"] : []), ...(kind ? ["?17"] : [])];
  if (!cols.length) return INSERT_CAPPED_TASK;
  return INSERT_CAPPED_TASK.replace("created, updated)\n", `created, updated, ${cols.join(", ")})\n`).replace("?11, ?12\n", `?11, ?12, ${vals.join(", ")}\n`);
};
/** A database without migration 0014 has no `kind` column: the task is then stored without it. */
export const isNoKindColumn = (err: unknown): boolean => /no (such )?column( named)?:? ?kind|has no column named kind/i.test(err instanceof Error ? err.message : String(err));
/** A database without migration 0006 has no `machine` column: the task is then stored without it. */
export const isNoMachineColumn = (err: unknown): boolean => /no (such )?column( named)?:? ?machine/i.test(err instanceof Error ? err.message : String(err));

const CLOSED_STATES: readonly string[] = ["done", "failed", "skipped"];

/**
 * Claim one mutation from the client's budget (see src/budget.ts: ONE conditional UPDATE on its own
 * `sources` row, O(1) reads, nothing written once the budget is spent, concurrent claims cannot
 * overshoot). A JSON-RPC batch pre-claims one slot per mutating call in a single statement
 * (`rules.preclaimed`) and gives back the ones it did not need, so a batch of N costs 2 budget
 * statements instead of N. A failed write after a successful claim still counts.
 */
async function claimMutation(c: Call): Promise<boolean> {
  if (c.rules.preclaimed > c.rules.used) {
    c.rules.used++;
    return true;
  }
  const ok = await claim(c.env.DB, SQL_CLAIM_MUTATIONS, c.source.id, c.now, DAY_MS, MAX_MCP_MUTATIONS_PER_DAY, 1);
  if (!ok) await flagMutationBudget(c);
  return ok;
}

/**
 * The budget is spent: record it once per window (`budget_until`) so the rules show a `budget-exhausted` inbox
 * item for this client (no push), instead of the refusal being visible only to the agent that got the error.
 * The first refusal of the window makes the request run the rules once at its end.
 */
async function flagMutationBudget(c: Call): Promise<void> {
  try {
    const f = await flagBudgetExhausted(c.env.DB, "mut_window_start", c.source, c.now);
    if (f.newlyFlagged) c.rules.dirty = true;
  } catch {
    /* the tool result already tells the agent; the inbox item is best effort */
  }
}

const BUDGET_MESSAGE =
  `mutation budget exhausted: a client may make at most ${MAX_MCP_MUTATIONS_PER_DAY} report_task / update_task ` +
  "calls that change something per 24-hour window (the window starts at its first change and restarts " +
  "24 hours later); try again later (updates that change nothing are free)";

/** Minute buckets: restating the same ETA a few seconds later is not a change. */
const etaBucket = (ms: number | null): number | null => (ms === null ? null : Math.round(ms / 60_000));


/**
 * The ceiling for task text is the stricter of the server's ACCEPT_TASK_TEXT (default brief) and the client's own `sources.task_text`
 * (migration 0014, NULL = the server's): applied before anything is validated or stored. The client's own setting was applied by the client.
 */
function limitText(tool: string, args: unknown, c: Call): unknown {
  if (!isObj(args)) return args;
  const mode = stricterTaskText(parseTaskText(c.env.ACCEPT_TASK_TEXT) ?? DEFAULT_TASK_TEXT, parseTaskText(c.source.task_text));
  return mode === "full" ? args : applyTaskText(tool, args, mode);
}

async function reportTask(args: unknown, c: Call): Promise<ToolResult> {
  const v = checkReport(limitText("report_task", args, c));
  if (!v.ok) return text(v.error, true);
  const a = v.value;
  // a retry of a report that already reached us (the client died before it saved the reply): the same task, no budget
  if (a.clientRef) {
    try {
      const seen = await taskForRef(c, a.clientRef);
      if (seen) return text(JSON.stringify({ task_id: seen.task_id, state: seen.state, repeated: true }));
    } catch {
      return text("could not store the task, please retry", true);
    }
  }
  if (!(await claimMutation(c))) return text(BUDGET_MESSAGE, true);
  const host = c.source.name;
  const taskId = `m-${randomBase36(8)}`;
  const state = STATE_FOR_STATUS[a.status];
  // Namespaced with the token-bound client name, so "proja: claude blocked" can only ever be shown as
  // "claude@<client>": a desktop client cannot pose as a host-agent agent.
  const agent = `${a.agent}@${host}`;
  const etaAt = a.status === "IN_PROGRESS" && a.etaMin ? c.now + Math.round(a.etaMin * 60_000) : null;
  try {
    const binds = [`mcp|${host}|${taskId}`, c.source.id, host, a.project, agent, taskId, a.title, state, etaAt, a.summary ?? null, c.now, c.now, MAX_OPEN_MCP_TASKS, state === "done" ? 1 : 0] as const;
    // ONE insert with the machine and the client_ref; a database without those columns (0006 / 0010) gets the task without them
    let withMachine = !!a.machine;
    let withRef = !!a.clientRef;
    let withKind = !!a.kind;
    let inserted: D1Result | undefined;
    for (let attempt = 0; !inserted && attempt < 4; attempt++) {
      try {
        const extra = withKind ? [a.machine ?? null, a.clientRef ?? null, a.kind!] : withRef ? [a.machine ?? null, a.clientRef!] : withMachine ? [a.machine!] : [];
        inserted = await stmt(c.env.DB, insertCappedTaskSql(withMachine, withRef, withKind), ...binds, ...extra).all();
      } catch (err) {
        if (withKind && isNoKindColumn(err)) { withKind = false; continue; }
        if (withRef && isNoClientRefColumn(err)) { withRef = false; continue; }
        if (withMachine && isNoMachineColumn(err)) { withMachine = false; continue; }
        // the unique (source_id, client_ref) index: a concurrent request with the same key won; answer with its task
        if (withRef && /unique|constraint/i.test(err instanceof Error ? err.message : String(err))) {
          const seen = await taskForRef(c, a.clientRef!);
          if (seen) return text(JSON.stringify({ task_id: seen.task_id, state: seen.state, repeated: true }));
        }
        throw err;
      }
    }
    if (!inserted) throw new Error("task insert failed");
    if ((inserted.results?.length ?? 0) !== 1) { // RETURNING: a row came back <=> inserted (never meta.changes)
      return text(
        `too many open tasks for this client (max ${MAX_OPEN_MCP_TASKS}): ` +
          "finish or update the existing ones with update_task (status DONE) first",
        true,
      );
    }
    await insertEventsStmt(c.env.DB, c.source.id, [
      mcpEvent(c, { project: a.project, agent, taskId, status: a.status, text: `${a.status}: ${a.title}${a.summary ? ` - ${a.summary}` : ""}` }),
    ]).run();
  } catch {
    return text("could not store the task, please retry", true);
  }
  c.rules.dirty = true;
  return text(JSON.stringify({ task_id: taskId, state }));
}

async function updateTask(args: unknown, c: Call): Promise<ToolResult> {
  const v = checkUpdate(limitText("update_task", args, c));
  if (!v.ok) return text(v.error, true);
  const a = v.value;
  // Owned-by-this-source lookup; an unknown id and someone else's id are indistinguishable.
  const existing = await first<TaskRow>(
    c.env.DB,
    "SELECT * FROM tasks WHERE key = ? AND source_id = ? AND origin = 'mcp'",
    `mcp|${c.source.name}|${a.taskId}`,
    c.source.id,
  );
  if (!existing) return text(`unknown task_id: ${a.taskId}`, true);
  // Closed tasks are immutable: re-opening one would bypass the open-task cap (report DONE, then move
  // it back to IN_PROGRESS). A finished piece of work that starts again is a NEW task.
  if (CLOSED_STATES.includes(existing.state)) return text("task is closed; report a new task", true);
  // Closed by the server for silence (`stale`): a late DONE still records the real outcome; anything else is a new task.
  if (existing.state === "stale" && a.status !== "DONE") return text("task was closed after 24 h without an update; report a new task (DONE is still accepted)", true);
  const state = STATE_FOR_STATUS[a.status];
  const etaAt = a.status === "IN_PROGRESS" && a.etaMin ? c.now + Math.round(a.etaMin * 60_000) : null;
  // An update that changes nothing (same state, same ETA minute, no new summary) writes nothing and
  // costs nothing: a looping client cannot burn the D1 write quota with it.
  if (existing.state === state && etaBucket(existing.eta_at) === etaBucket(etaAt) && (a.summary === undefined || a.summary === existing.last_line) && (a.kind === undefined || a.kind === (existing as { kind?: string | null }).kind)) {
    return text(JSON.stringify({ task_id: a.taskId, state, unchanged: true }));
  }
  if (!(await claimMutation(c))) return text(BUDGET_MESSAGE, true);
  try {
    // The UPDATE re-checks `state` atomically, so a concurrent DONE cannot be re-opened by a racing update.
    const runUpdate = (withKind: boolean) => stmt(
      c.env.DB,
      `UPDATE tasks SET state = ?, eta_at = ?, last_line = COALESCE(?, last_line), updated = ?${withKind ? ", kind = ?" : ""}
       WHERE key = ? AND source_id = ? AND state NOT IN ('done', 'failed', 'skipped')
       RETURNING key`,
      state, etaAt, a.summary ?? null, c.now, ...(withKind ? [a.kind!] : []), existing.key, c.source.id,
    ).all();
    let updated: D1Result;
    try {
      updated = await runUpdate(!!a.kind);
    } catch (err) {
      if (!a.kind || !isNoKindColumn(err)) throw err;
      updated = await runUpdate(false); // a database without migration 0014
    }
    if ((updated.results?.length ?? 0) !== 1) return text("task is closed; report a new task", true);
    await insertEventsStmt(c.env.DB, c.source.id, [
      mcpEvent(c, {
        project: existing.project ?? "",
        agent: existing.agent ?? "",
        taskId: a.taskId,
        status: a.status,
        text: `${a.status}: ${existing.title}${a.summary ? ` - ${a.summary}` : ""}`,
      }),
    ]).run();
  } catch {
    return text("could not update the task, please retry", true);
  }
  c.rules.dirty = true;
  return text(JSON.stringify({ task_id: a.taskId, state }));
}

/** operator_status: away (wind-down window) or available; read-only, no budget. Defaults when migration 0007 is missing. */
async function operatorStatusTool(args: unknown, c: Call): Promise<ToolResult> {
  if (args !== undefined && args !== null && (!isObj(args) || Object.keys(args).length)) return text("operator_status takes no arguments", true);
  const s = (await cachedSettings(c.env.DB, c.now).catch(() => null)) ?? wbDefaults();
  return text(JSON.stringify(operatorStatus(s, c.now)));
}

async function listTasksTool(args: unknown, c: Call): Promise<ToolResult> {
  if (args !== undefined && args !== null && (!isObj(args) || Object.keys(args).length)) return text("list_tasks takes no arguments", true);
  // Only this source's own MCP tasks: open ones, plus those closed as stale in the last 7 days (a late DONE still records the outcome).
  const rows = await all<{ task_id: string; title: string; state: string; eta_at: number | null; created: number; updated: number }>(
    c.env.DB,
    `SELECT task_id, title, state, eta_at, created, updated FROM tasks
     WHERE source_id = ?1 AND origin = 'mcp' AND (state IN ('queued', 'delivered', 'acked', 'running', 'blocked') OR (state = 'stale' AND updated >= ?3))
     ORDER BY updated DESC LIMIT ?2`,
    c.source.id,
    MAX_OPEN_MCP_TASKS,
    c.now - 7 * DAY_MS,
  );
  const tasks = rows.map((r) => ({ task_id: r.task_id, title: r.title, state: r.state, eta_at: r.eta_at, created: r.created, updated: r.updated }));
  return text(JSON.stringify({ now: c.now, tasks }));
}

async function heartbeatTool(args: unknown, _c: Call): Promise<ToolResult> {
  if (args !== undefined && args !== null && !isObj(args)) return text("arguments must be an object", true);
  if (isObj(args) && args.project !== undefined) {
    const p = checkIdent(args.project, PROJECT_RE, "project");
    if (!p.ok) return text(p.error, true);
  }
  // Nothing to write: the auth path already refreshes `sources.last_seen` (throttled to once per 30 s per client).
  return text("ok");
}


// ── method dispatch ──────────────────────────────────────────────────────────

/** Returns the response for a request, or null for notifications / client responses. */
async function handleMessage(msg: unknown, c: Call): Promise<RpcResponse | null> {
  if (!isObj(msg)) return rpcError(null, E_INVALID_REQUEST, "Invalid Request");
  if (typeof msg.method !== "string") {
    // A client *response* (result/error, no method) is accepted and ignored.
    if (("result" in msg || "error" in msg) && !("method" in msg)) return null;
    return rpcError(idOf(msg), E_INVALID_REQUEST, "Invalid Request");
  }
  if (msg.jsonrpc !== "2.0") return rpcError(idOf(msg), E_INVALID_REQUEST, "Invalid Request: jsonrpc must be \"2.0\"");
  if (!("id" in msg)) return null; // notification
  const id = idOf(msg);
  if (id === null) return rpcError(null, E_INVALID_REQUEST, "Invalid Request: id must be a string or number");
  const params = isObj(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      if (c.modern) return rpcError(id, E_METHOD_NOT_FOUND, "Method not found: initialize (this request uses protocol 2026-07-28, which has no handshake)");
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const legacy = (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested);
      return ok(
        id,
        {
          protocolVersion: legacy ? requested : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "siiswell", version: DASHBOARD_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        },
        c,
      );
    }
    case "ping":
      return ok(id, {}, c);
    case "server/discover":
      return ok(
        id,
        {
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          instructions: SERVER_INSTRUCTIONS,
        },
        { ...c, modern: true },
      );
    case "tools/list":
      return ok(id, { tools: TOOLS }, c);
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return rpcError(id, E_INVALID_PARAMS, "tools/call requires params.name");
      let result: ToolResult;
      if (name === "report_task") result = await reportTask(params.arguments, c);
      else if (name === "update_task") result = await updateTask(params.arguments, c);
      else if (name === "heartbeat") result = await heartbeatTool(params.arguments, c);
      else if (name === "list_tasks") result = await listTasksTool(params.arguments, c);
      else if (name === "operator_status") result = await operatorStatusTool(params.arguments, c);
      else return rpcError(id, E_INVALID_PARAMS, `Unknown tool: ${clipText(name, 64)}`);
      return ok(id, { ...result }, c);
    }
    default:
      return rpcError(id, E_METHOD_NOT_FOUND, `Method not found: ${clipText(msg.method, 64)}`);
  }
}

// ── HTTP layer ───────────────────────────────────────────────────────────────

function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const allowed = new Set<string>([new URL(req.url).origin]);
  try {
    allowed.add(new URL(env.PUBLIC_URL).origin);
  } catch {
    /* PUBLIC_URL unset in a test env */
  }
  for (const o of (env.MCP_ALLOWED_ORIGINS ?? "").split(",")) if (o.trim()) allowed.add(o.trim());
  return allowed.has(origin);
}

function decodeNameHeader(v: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1] as string), (ch) => ch.charCodeAt(0)));
  } catch {
    return "\u0000invalid";
  }
}

/**
 * 2026-07-28 request checks. Returns an error Response, or null when the request is valid.
 * Status codes per the spec: 400 for header/body mismatch, missing _meta, unsupported version.
 */
function checkModernRequest(req: Request, msg: Record<string, unknown>): Response | null {
  const id = idOf(msg);
  const bad = (status: number, code: number, message: string, data?: unknown): Response =>
    json(rpcError(id, code, message, data), status);
  const params = isObj(msg.params) ? msg.params : {};
  const meta = isObj(params._meta) ? params._meta : {};
  const bodyVersion = meta[META_VERSION];
  if (typeof bodyVersion !== "string" || !isObj(meta[META_CAPS])) {
    return bad(400, E_INVALID_PARAMS, `_meta must carry ${META_VERSION} and ${META_CAPS}`);
  }
  if (!(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(bodyVersion)) {
    return bad(400, E_UNSUPPORTED_VERSION, "Unsupported protocol version", {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: bodyVersion,
    });
  }
  const headerVersion = req.headers.get("mcp-protocol-version");
  if (headerVersion !== bodyVersion) {
    return bad(400, E_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version must equal the _meta protocol version");
  }
  const method = req.headers.get("mcp-method");
  if (method !== msg.method) return bad(400, E_HEADER_MISMATCH, "Header mismatch: Mcp-Method must equal the request method");
  if (msg.method === "tools/call") {
    const nameHeader = req.headers.get("mcp-name");
    if (nameHeader === null || decodeNameHeader(nameHeader) !== params.name) {
      return bad(400, E_HEADER_MISMATCH, "Header mismatch: Mcp-Name must equal params.name");
    }
  }
  return null;
}

/** A tools/call of report_task or update_task: the only calls that can change something (and claim budget). */
function isMutatingCall(msg: unknown): boolean {
  return (
    isObj(msg) &&
    msg.method === "tools/call" &&
    "id" in msg &&
    isObj(msg.params) &&
    (msg.params.name === "report_task" || msg.params.name === "update_task")
  );
}

function isModernMessage(req: Request, msg: unknown): boolean {
  const header = req.headers.get("mcp-protocol-version");
  if (header && (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(header)) return true;
  if (!isObj(msg) || !isObj(msg.params) || !isObj(msg.params._meta)) return false;
  return typeof msg.params._meta[META_VERSION] === "string";
}

export async function handleMcp(
  req: Request,
  env: Env,
  ctx: AppCtx,
  now: number,
  fetchImpl?: FetchLike,
): Promise<Response> {
  if (req.method !== "POST") {
    // No server-initiated stream (GET) and no sessions to terminate (DELETE).
    return errorJson(405, "this MCP endpoint only accepts POST", { Allow: "POST" });
  }
  if (!originAllowed(req, env)) return errorJson(403, "origin not allowed");

  const auth = await authenticateBearer(req, env, "client", now);
  if (!auth.ok) return auth.response;

  const headerVersion = req.headers.get("mcp-protocol-version");
  if (headerVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion)) {
    return json(
      rpcError(null, E_UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: headerVersion.slice(0, 40),
      }),
      400,
    );
  }

  const body = await readBodyText(req, MAX_MCP_BODY_BYTES);
  if (!body.ok) return errorJson(413, "payload too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return json(rpcError(null, E_PARSE, "Parse error"), 400);
  }

  const rules = { dirty: false, preclaimed: 0, used: 0 };
  const base = { env, ctx, source: auth.source, now, fetchImpl, rules };
  // The alert rules run at most once per HTTP request, after every message has been handled. No extra throttle: an
  // evaluation follows a MUTATION, and a client may make MAX_MCP_MUTATIONS_PER_DAY of those a day, which already bounds
  // its evaluations (better than the 30-second throttle of host ingest would).
  const evaluate = async (): Promise<void> => {
    if (rules.dirty) await applyRules(env, ctx, now, fetchImpl);
  };

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return json(rpcError(null, E_INVALID_REQUEST, "Invalid Request: empty batch"), 400);
    if (parsed.length > MAX_BATCH_MESSAGES) {
      return json(rpcError(null, E_INVALID_REQUEST, `Invalid Request: batch too large (max ${MAX_BATCH_MESSAGES} messages)`), 400);
    }
    // A batch of N messages is N requests: charge the other N-1 to the rate limit before running any.
    const limited = await chargeExtraRequests(env, auth.source, parsed.length - 1);
    if (limited) return limited;
    // Pre-claim one budget slot per mutating call in ONE statement (the unused ones are given back below).
    // If the whole batch does not fit, each call claims lazily and only the ones that fit succeed.
    const mutating = parsed.filter(isMutatingCall).length;
    if (mutating > 1 && (await claim(env.DB, SQL_CLAIM_MUTATIONS, auth.source.id, now, DAY_MS, MAX_MCP_MUTATIONS_PER_DAY, mutating))) {
      rules.preclaimed = mutating;
    }
    const out: RpcResponse[] = [];
    try {
      for (const m of parsed) {
        const r = await handleMessage(m, { ...base, modern: false });
        if (r) out.push(r);
      }
    } finally {
      // Whatever happened (a D1 error in the middle of the batch included), the slots no call used go back.
      if (rules.preclaimed > rules.used) {
        try {
          await refundMutations(env.DB, auth.source.id, rules.preclaimed - rules.used);
        } catch {
          /* best effort: the budget is only ever too strict by the unused slots, until the window ends */
        }
      }
    }
    await evaluate();
    return out.length ? json(out) : accepted();
  }

  const modern = isModernMessage(req, parsed);
  if (modern && isObj(parsed) && typeof parsed.method === "string" && "id" in parsed) {
    const bad = checkModernRequest(req, parsed);
    if (bad) return bad;
  }
  const res = await handleMessage(parsed, { ...base, modern });
  await evaluate();
  if (!res) return accepted();
  if ("error" in res) {
    const status =
      res.error.code === E_METHOD_NOT_FOUND && modern ? 404 : res.error.code === E_INVALID_REQUEST || (res.error.code === E_INVALID_PARAMS && modern) ? 400 : 200;
    return json(res, status);
  }
  return json(res);
}
