// SPDX-License-Identifier: Apache-2.0
/**
 * @file Dashboard wire contract, version 1.
 * @module shared/schema
 *
 * Shared by the reporters that push data and the server (`src/*`), which imports this file by relative path. Types,
 * constants and tiny pure helpers ONLY: no Node/Bun/Workers APIs; the only imports are `./wire` (two string constants)
 * and the types of the optional host integration (`../host-ext/types`). Any change here is a protocol change: bump
 * DASHBOARD_SCHEMA_VERSION and keep the server accepting v1.
 *
 * Desktop clients only use the MCP tools at the end. The snapshot / events / heartbeat payloads are the optional advanced
 * host integration: a reporter process that runs next to a set of agents and pushes their state.
 */
import { ORIGIN_HOST, ORIGIN_RELAY } from "./wire";
import type { DiscussionSnapshot, PollerSnapshot } from "../host-ext/types";
export type { DiscussionSnapshot, PollerSnapshot } from "../host-ext/types";

export const DASHBOARD_SCHEMA_VERSION = 1 as const;

// ── Limits (enforced by the sender AND re-enforced by the Worker) ────────────
/** Any free-text field (status line, notice text, summary). */
export const MAX_TEXT = 300;
/** Task titles, thread topics, approval summaries. */
export const MAX_TITLE = 120;
export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_TASKS_PER_SNAPSHOT = 200;
/** Serialized snapshot body cap. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
/**
 * A host that sent nothing (snapshot, events or heartbeat) for this long is "offline". Must stay well above two
 * heartbeat intervals plus jitter, so that ONE lost heartbeat never looks like an outage.
 */
export const HOST_OFFLINE_AFTER_MS = 6 * 60_000;
/** A project whose reporter sent nothing (snapshot, heartbeat or events) for this long is "reporter offline", even on a live host. */
export const PROJECT_OFFLINE_AFTER_MS = HOST_OFFLINE_AFTER_MS;
/**
 * The `project-offline` alert stays open while a project has been silent for at most this long; after that the project is
 * taken for retired (removed from the host's config) and the alert resolves silently. The page still shows "reporter offline".
 */
export const PROJECT_OFFLINE_MAX_MS = 24 * 3_600_000;
/**
 * Reporters send a heartbeat at least this often even when nothing changed (a snapshot or an events batch that was
 * accepted counts as one). older reporters use 60 s; the server accepts either.
 */
export const HEARTBEAT_INTERVAL_MS = 120_000;
/**
 * A changed snapshot is sent at most this often per project (the first one after a start / config reload goes out
 * at once). Events are not held back by it.
 */
export const SNAPSHOT_MIN_INTERVAL_MS = 120_000;
/**
 * An URGENT change (a task newly blocked / failed, a new pending approval, an agent newly unresponsive / on hold / at its
 * usage limit) skips SNAPSHOT_MIN_INTERVAL_MS but still waits this long after the previous snapshot, so a flapping state cannot
 * spam the Worker.
 */
export const SNAPSHOT_URGENT_MIN_INTERVAL_MS = 15_000;
/**
 * The current snapshot is re-sent at least this often even when nothing changed (a quiet project sends heartbeats, not
 * snapshots), so anything the Worker lost, a retention purge or a D1 restore, heals within a day without waiting for the
 * next change. It counts as the heartbeat for that tick.
 */
export const SNAPSHOT_KEEPALIVE_MS = 24 * 3_600_000;

// ── Enumerations ─────────────────────────────────────────────────────────────
/**
 * An agent's state. Desktop clients only imply working / idle; a host integration may report the others (optional
 * host-integration values: a host may report agent states such as paused / asleep / unresponsive / on hold).
 */
export type AgentState =
  | "working"      // has an open task
  | "idle"         // no open task
  | "frozen"       // paused by its host while idle; resumes by itself
  | "killed"       // asleep: stopped by its host while idle, restarted when needed
  | "wedged"       // unresponsive: input sent to it was not taken
  | "benched"      // on hold: its host keeps it out of the current work
  | "usage-limit"  // its provider reported a usage limit that has not lifted
  | "compacting"   // shortening its context
  | "unknown";

/** A task's state. Desktop clients use running / blocked / done; the earlier ones are optional host-integration values. */
export type TaskState =
  | "queued"     // handed to an agent, not yet confirmed
  | "delivered"  // the agent received it
  | "acked"      // the agent acknowledged it without a status
  | "running"    // reported IN_PROGRESS
  | "blocked"    // reported BLOCKED
  | "done"       // reported DONE
  | "failed"     // closed without a report, or could not be handed over
  | "skipped"    // closed for another reason (superseded, cancelled)
  | "stale";     // SERVER-SET only: an MCP task with no update for MCP_STALE_CLOSE_MS (the agent likely finished without reporting)

/** The status an agent reports for a task. */
export type ReportStatus = "IN_PROGRESS" | "BLOCKED" | "DONE";

export type Severity = "info" | "warn" | "critical";

export type EventKind =
  | "halt"       // a notice from the host that an agent stopped or needs attention (see HALT_SEVERITY)
  | "status"     // an agent's status report
  | "approval"   // approval requested / decided
  | "lifecycle"; // reporter / agent lifecycle notice

/** Where an event or task came from. */
export type Origin =
  | typeof ORIGIN_HOST   // produced by this host's own agents
  | typeof ORIGIN_RELAY  // forwarded by the host, from an agent it does not run
  | "mcp";             // reported directly by a desktop client over /mcp

// ── Snapshot (POST /api/ingest/snapshot) ─────────────────────────────────────
export interface UsageWindow {
  /** "5h", "weekly", "<N>h", "<N>min": the provider's usage window. */
  label: string;
  usedPercent: number;
  /** epoch ms */
  resetsAt?: number;
}

export interface AgentSnapshot {
  name: string;
  baseCli?: string;
  state: AgentState;
  /** epoch ms the current state was first observed, when known. */
  stateSince?: number;
  contextTokens?: number;
  /** 0–100, only when the context window size is known. */
  contextPercent?: number;
  usage?: UsageWindow[];
  currentTaskId?: string;
  /** epoch ms of the agent's last reply. */
  lastReplyAt?: number;
}

export interface TaskSnapshot {
  /** Stable per host+project: `${agent}-${dispatchedAt.toString(36)}`. */
  id: string;
  agent: string;
  /** ≤ MAX_TITLE, redacted. */
  title: string;
  state: TaskState;
  dispatchedAt: number;
  updatedAt: number;
  /** epoch ms; IN PROGRESS reply time + stated ETA. */
  etaAt?: number;
  /** Last status line or report excerpt, ≤ MAX_TEXT, redacted. */
  lastLine?: string;
  /** opaque id of the message that created the task, when known. */
  originEventId?: string;
  /** opaque id of the conversation it came from, when known. */
  roomId?: string;
}

export interface ApprovalSnapshot {
  id: string;
  /** What is waiting for approval, ≤ MAX_TITLE, redacted. */
  summary: string;
  requestedAt?: number;
  expiresAt?: number;
  agent?: string;
}

/**
 * How much free text a reporter sends (its privacy setting): `full` = task titles, reply summaries and event text
 * (URLs are always stripped), `titles` = short task titles only (money masked, no reply summaries, no terminal text),
 * `none` = no text at all (`task for <agent>`). The reporter states its mode in the snapshot so the UI
 * can say "details hidden (privacy mode)" where text is missing; a snapshot without it comes from an older
 * reporter and is `full`.
 */
export const DASHBOARD_TEXT_MODES = ["full", "titles", "none"] as const;
export type DashboardTextMode = (typeof DASHBOARD_TEXT_MODES)[number];

export interface ProjectSnapshot {
  v: typeof DASHBOARD_SCHEMA_VERSION;
  /** os.hostname() of the sending host. */
  host: string;
  /** the project's name on that host. */
  project: string;
  sentAt: number;
  /** the host's reporter process (optional host integration) */
  poller: PollerSnapshot;
  agents: AgentSnapshot[];
  /** Open tasks + tasks closed in the last 24 h, newest first, ≤ MAX_TASKS_PER_SNAPSHOT. */
  tasks: TaskSnapshot[];
  /** Optional host integration: active threads + those ended in the last 2 h ([] when the host has none). */
  discussions: DiscussionSnapshot[];
  approvals: ApprovalSnapshot[];
  /** The reporter's text mode (absent = an older reporter = `full`). */
  textMode?: DashboardTextMode;
}

// ── Events (POST /api/ingest/events) ─────────────────────────────────────────
export interface DashboardEvent {
  kind: EventKind;
  origin: Origin;
  at: number;
  severity: Severity;
  /** Dedupe key, unique per logical event: e.g. a message id, or `${kind}:${agent}:${at}`. */
  key: string;
  agent?: string;
  /** halt: scenario name (a key of HALT_SEVERITY, or any other name, shown as info). */
  scenario?: string;
  /** status: parsed report status. */
  status?: ReportStatus;
  etaMin?: number;
  /** One-line human summary, ≤ MAX_TEXT, redacted. */
  text: string;
  /** relay origin: the id of the agent that sent it. */
  sender?: string;
  taskId?: string;
}

export interface EventBatch {
  v: typeof DASHBOARD_SCHEMA_VERSION;
  host: string;
  project: string;
  events: DashboardEvent[];
}

// ── Heartbeat (POST /api/ingest/heartbeat) ───────────────────────────────────
export interface Heartbeat {
  v: typeof DASHBOARD_SCHEMA_VERSION;
  host: string;
  project?: string;
  at: number;
  binaryVersion?: string;
}

// ── MCP tools (POST /mcp, desktop clients) ───────────────────────────────────
export interface ReportTaskInput {
  /** Free-form project label, e.g. the repo or folder name. */
  project: string;
  title: string;
  status: ReportStatus;
  eta_min?: number;
  summary?: string;
  /** Defaults to the client source name (e.g. "client2"). */
  agent?: string;
}
export interface UpdateTaskInput {
  task_id: string;
  status: ReportStatus;
  eta_min?: number;
  summary?: string;
}
export interface HeartbeatInput {
  project?: string;
}

// ── Alerting vocabulary (server rules; a host integration may use it for severities) ─────
/**
 * Halt scenarios that page the operator immediately ("agent stuck"): an agent on hold, one that could not be restarted,
 * one whose CLI is gone, one at its usage limit.
 */
export const PUSH_HALT_SCENARIOS: readonly string[] = ["benched", "restart-failed", "cli-gone", "usage-limit"];

/** Severity of a halt scenario as shown on the dashboard. Unlisted → "info". */
export const HALT_SEVERITY: Readonly<Record<string, Severity>> = {
  benched: "critical",
  "restart-failed": "critical",
  "cli-gone": "critical",
  "usage-limit": "critical",
  "task-no-report": "warn",
  "turn-not-submitted": "warn",
  "nudge-not-submitted": "warn",
  "turn-skipped": "warn",
  "discussion-paused": "warn",
  "context-full": "warn",
  "discussion-ended": "info",
};

export type AlertRule = "approval-waiting" | "blocked" | "agent-stuck" | "host-offline" | "project-offline" | "overdue" | "usage-limit";

/** Default thresholds for the server's alert rules. */
export const ALERT_DEFAULTS = {
  approvalWaitingAfterMs: 5 * 60_000,
  /** the FIRST reminder; later ones back off (rules.ts REPUSH_COOLDOWN_MS: 15 -> 30 -> 60 -> 120 min) */
  approvalReminderEveryMs: 15 * 60_000,
  /** the first push and four reminders, then the digest only */
  approvalMaxPushes: 5,
  hostOfflineAfterMs: HOST_OFFLINE_AFTER_MS,
  projectOfflineAfterMs: PROJECT_OFFLINE_AFTER_MS,
  projectOfflineMaxMs: PROJECT_OFFLINE_MAX_MS,
  overdueEtaFactor: 1.5,
  /** Default retention of the Worker (its `RETENTION_DAYS` var overrides it). */
  retentionDays: 30,
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────
export function severityForScenario(scenario: string | undefined): Severity {
  return (scenario && HALT_SEVERITY[scenario]) || "info";
}

export function taskIdFor(agent: string, dispatchedAt: number): string {
  return `${agent}-${dispatchedAt.toString(36)}`;
}
