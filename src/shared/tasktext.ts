// SPDX-License-Identifier: Apache-2.0
/**
 * @file The `taskText` policy: how much free text of a task (title, summary) is kept. One implementation for the client
 * (CLI, MCP stdio relay, hooks: applied before upload) and the server (ACCEPT_TASK_TEXT: applied before storage, the ceiling).
 * - full: title and summary as given (still clipped and redacted by the callers).
 * - `kind` (fixed vocabulary) is kept in every mode.
 * - brief (default): the title is kept but clipped to 60 characters (after redaction); the summary is dropped unless it is the
 *   hook's fixed mark. Order: none < minimal < brief < full; the server applies min(server, per-source).
 * - minimal: the title becomes a fixed generic label unless it is one of the hook's own fixed titles; the summary is
 *   dropped unless it is the hook's fixed mark; update_task carries no title; unknown argument keys are dropped.
 * - none: no title and no summary at all (the server shows a neutral placeholder).
 * @module shared/tasktext
 */
import { HOOK_MARK, HOOK_TITLES } from "./hook";
import { clipText } from "./redact";

/** Ordered from least to most text: none < minimal < brief < full. */
export const TASK_TEXT_MODES = ["none", "minimal", "brief", "full"] as const;
export type TaskTextMode = (typeof TASK_TEXT_MODES)[number];
export const DEFAULT_TASK_TEXT: TaskTextMode = "brief";
/** The title length kept in `brief` mode (after redaction). */
export const BRIEF_TITLE_MAX = 60;

/** The fixed vocabulary of a task's `kind`: no free text, so it is kept in every mode. */
export const TASK_KINDS = ["coding", "debugging", "testing", "review", "research", "docs", "deploy", "ops", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
/** A kind from the fixed list; anything else that is a string becomes "other". Not a string / empty: undefined (nothing given). */
export function normalizeKind(v: unknown): TaskKind | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const k = v.trim().toLowerCase();
  return (TASK_KINDS as readonly string[]).includes(k) ? (k as TaskKind) : "other";
}

/** The more private of two modes (the lower one). */
export function stricterTaskText(a: TaskTextMode, b: TaskTextMode | undefined): TaskTextMode {
  return b && TASK_TEXT_MODES.indexOf(b) < TASK_TEXT_MODES.indexOf(a) ? b : a;
}
/** The generic title used in `minimal` mode. */
export const MINIMAL_TITLE = "Task";

export function parseTaskText(v: unknown): TaskTextMode | undefined {
  return typeof v === "string" && (TASK_TEXT_MODES as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as TaskTextMode) : undefined;
}

const REPORT_KEYS = ["project", "title", "status", "eta_min", "summary", "agent", "machine", "client_ref", "kind"];
const UPDATE_KEYS = ["task_id", "status", "eta_min", "summary", "kind"];

/** The task tools, matched case-insensitively (a case variant must not slip past the policy). */
export const taskToolKind = (tool: unknown): "report_task" | "update_task" | null => {
  const t = typeof tool === "string" ? tool.toLowerCase() : "";
  return t === "report_task" || t === "update_task" ? t : null;
};

/** A copy of the arguments of report_task / update_task limited per `mode` (other tools, and `full`: unchanged). */
export function applyTaskText(tool: string, args: Record<string, unknown>, mode: TaskTextMode): Record<string, unknown> {
  const kind = taskToolKind(tool);
  if (!kind) return args;
  if (mode === "full") return "kind" in args ? withKind({ ...args }) : args;
  const allowed = kind === "report_task" ? REPORT_KEYS : UPDATE_KEYS;
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (k in args) out[k] = args[k];
  withKind(out);
  if (mode === "none") {
    delete out.title;
    delete out.summary;
    return out;
  }
  if (mode === "brief") {
    if (kind === "report_task" && typeof out.title === "string" && !(HOOK_TITLES as readonly string[]).includes(out.title)) out.title = clipText(out.title, BRIEF_TITLE_MAX) || MINIMAL_TITLE;
    if (out.summary !== HOOK_MARK) delete out.summary;
    return out;
  }
  if (kind === "report_task" && "title" in out && !(typeof out.title === "string" && (HOOK_TITLES as readonly string[]).includes(out.title))) out.title = MINIMAL_TITLE;
  if (out.summary !== HOOK_MARK) delete out.summary;
  return out;
}

/** Replace `kind` by a value of the fixed list (or drop it when it is not a string), in place. */
function withKind(o: Record<string, unknown>): Record<string, unknown> {
  if ("kind" in o) {
    const k = normalizeKind(o.kind);
    if (k) o.kind = k;
    else delete o.kind;
  }
  return o;
}
