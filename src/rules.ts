/**
 * @file Alert rules and push policy. PURE: no I/O, no clock, no randomness; everything comes in
 * through `RuleInput`. Evaluated on every changed ingest and every cron minute, so it must be
 * idempotent: alert keys are deterministic (`rule|host|project|agent-or-task|...`) and the output is
 * a diff between "alerts that should be open now" and "alerts that are open".
 * @module dashboard-worker/rules
 *
 * | rule             | open                                      | resolve                                     | push                               |
 * |------------------|-------------------------------------------|---------------------------------------------|------------------------------------|
 * | approval-waiting | snapshot approval older than 5 min        | approval gone                               | on open, every 30 min, max 3       |
 * | blocked          | task state blocked (any origin)           | not blocked / newer task* / 6 h cap         | on open                            |
 * | agent-stuck      | halt event benched/restart-failed/cli-gone| snapshot BUILT after the halt shows the agent not wedged/benched, or 6 h | on open |
 * | usage-limit      | halt event usage-limit / agent state      | agent state not usage-limit (event: 6 h cap)| on open                            |
 * | host-offline     | host last seen > 6 min                    | host seen again                             | on open only                       |
 * | project-offline  | project last seen > 6 min (and < 24 h) on a host that is ONLINE | project seen again, host offline, 24 h | on open only        |
 * | overdue          | running and now > updated + 1.5 x ETA (not MCP tasks) | no longer running, or a new ETA | on open                            |
 * | budget-exhausted | a source was refused for budget           | its budget window ended                     | host: once on open; client: never  |
 *
 * Resolution only from COMPLETE inputs: a scan that hit its LIMIT is reported in `truncated`; the rule
 * families that read it may still open alerts but resolve none, and a truncated open-alert scan resolves
 * nothing (see RESOLVE_NEEDS). Pushes come out most urgent first (see prioritizePushes).
 *
 * Cross-cutting rules:
 * - Agent names are compared case-insensitively (they are lower-cased at ingest; compares here
 *   lower-case again so hand-built inputs behave the same).
 * - An alert that re-opens within REOPEN_GRACE_MS of being resolved is the SAME incident: it keeps its
 *   push counters (the `alerts` input therefore carries recently resolved rows too), so flapping never
 *   pushes twice.
 * - Alerts whose origin is not the host-agent origin (MCP clients, relayed foreign agents) are labelled
 *   ` · via <host or client>` in their text and in their push, so they cannot pass for a host-agent alert.
 */
import { ORIGIN_HOST, ORIGIN_RELAY } from "./shared/wire";
import {
  ALERT_DEFAULTS,
  PUSH_HALT_SCENARIOS,
  severityForScenario,
  type AlertRule,
  type ProjectSnapshot,
  type Severity,
} from "./shared/schema";
import { clipText } from "./shared/redact";
import { HOOK_IDLE_TITLE, HOOK_MARK } from "./shared/hook";
import { MAX_OPEN_ALERTS_PER_HOST, MAX_OPEN_ALERTS_PER_PROJECT, MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT, MAX_OPEN_CRITICAL_ALERTS_PER_HOST } from "./env";
import { budgetKey, decodeBudgetKey } from "./keys";

/** An event-derived alert (agent-stuck / event-sourced usage-limit) expires after this long. */
export const EVENT_ALERT_TTL_MS = 6 * 60 * 60_000;
/**
 * A `blocked` alert expires this long after the task entered the blocked state (its `updated`),
 * which is within a minute of the alert opening. Anchoring the cap on the task instead of the
 * alert row keeps the rule pure: a capped alert does not re-open on the next evaluation, because
 * the task's `updated` does not move. (* "newer task" resolution applies to host-agent tasks only.)
 */
export const BLOCKED_ALERT_TTL_MS = 6 * 60 * 60_000;
/**
 * A push that has not gone out yet (never claimed, or rolled back after a transient failure, or no
 * VAPID key / subscription existed yet) is attempted for this long after the alert opened. Older
 * alerts are never pushed late: this also bounds the burst when the first subscription appears.
 */
export const PUSH_RETRY_WINDOW_MS = 60 * 60_000;
/** A key that re-opens within this long of being resolved is the same incident: no second push. */
export const REOPEN_GRACE_MS = 30 * 60_000;

export interface RuleSnapshot {
  host: string;
  project: string;
  receivedAt: number;
  snap: ProjectSnapshot;
}
export interface RuleHost {
  host: string;
  last_seen: number;
}
/** When anything (snapshot, heartbeat, events) last arrived for a project; only the silent ones are loaded (see SQL_RULE_PROJECTS). */
export interface RuleProjectSeen {
  host: string;
  project: string;
  last_seen: number;
}
export interface RuleTask {
  key: string;
  origin: string;
  host: string | null;
  project: string | null;
  agent: string | null;
  task_id: string;
  title: string;
  state: string;
  eta_at: number | null;
  last_line: string | null;
  /** dispatchedAt for host-agent tasks, creation time for the others. */
  created: number;
  updated: number;
  /**
   * Newest `created` among the host-agent tasks of the same host+project+agent. Supplied by the loader
   * (an index-backed subquery) so `tasks` need not contain every task; when absent it is derived from
   * `tasks`.
   */
  latest_dispatch?: number | null;
}
export interface RuleEvent {
  key: string;
  host: string | null;
  project: string | null;
  kind: string;
  origin?: string | null;
  agent: string | null;
  scenario: string | null;
  at: number;
  text: string;
}
export interface RuleAlert {
  key: string;
  rule: string;
  /** The alert's host label / client name, project and origin: which scan partition its inputs live in, and which caps count it. */
  host?: string | null;
  project?: string | null;
  origin?: string | null;
  last_pushed: number | null;
  push_count: number;
  opened: number;
  resolved: number | null;
  /** When the condition behind the alert began (the cap ranking, see applyAlertCaps); null / absent = `opened`. */
  since?: number | null;
  /** When the alert was folded into a summary push instead of being pushed itself (null = never). */
  summarized_at?: number | null;
}

/** A source whose budget was refused: the rules show a `budget-exhausted` alert until `budget_until`. */
export interface RuleBudget {
  name: string;
  kind: "host" | "client";
  budget_until: number;
}

/** The scans the rules read; each one is LIMITed, and a scan that hit its limit is "truncated". */
export type RuleScan = "snapshots" | "hosts" | "projects" | "tasks" | "events" | "alerts" | "budgets";

/**
 * Alert rules of this Worker: the shared contract's rules plus `budget-exhausted` (a dashboard-only
 * alert about the dashboard's own limits, so it is not part of the host agent / pusher contract).
 */
export type DashboardRule = AlertRule | "budget-exhausted" | "alerts-capped";

export interface RuleInput {
  now: number;
  snapshots: RuleSnapshot[];
  hosts: RuleHost[];
  /** The projects whose reporter has been silent for a while (`project-offline`); absent = none / not loaded. */
  projectSeen?: RuleProjectSeen[];
  tasks: RuleTask[];
  /** Halt events of the last EVENT_ALERT_TTL_MS are enough; older ones are ignored anyway. */
  events: RuleEvent[];
  /** Open alerts plus those resolved within REOPEN_GRACE_MS (older resolved rows are ignored). */
  alerts: RuleAlert[];
  /** Sources refused for budget whose window has not ended (absent = none). */
  budgets?: RuleBudget[];
  /**
   * Scans that were cut off by their LIMIT. An evaluation can only be trusted to say "this condition
   * no longer holds" for rules whose inputs it saw COMPLETELY, so a rule family that depends on a
   * truncated scan may still OPEN alerts but resolves none; a truncated open-alert scan resolves nothing.
   */
  truncated?: RuleScan[];
  /**
   * Partitions of a scan that were cut off by their per-partition limit (a host's snapshots, a host's or a
   * client's tasks per origin, a host's halt events, a host's alerts). They freeze resolution only for the
   * alerts that live in that partition: one flooding host can no longer blind the others. Keys: snapshots,
   * events, alerts = the host label; tasks = `<host>|<origin>`.
   */
  truncatedParts?: Partial<Record<RuleScan, string[]>>;
  /**
   * Scans whose GLOBAL row limit was hit: they are read host by host in name order, so every host that sorts at or
   * after the value here was not (fully) read. Only the alerts of those hosts freeze (their resolution is unknown, and
   * their new non-critical alerts wait); the hosts before it, which were read completely, evaluate as usual.
   */
  readFrom?: Partial<Record<RuleScan, string>>;
}

export interface AlertDraft {
  key: string;
  rule: DashboardRule;
  severity: Severity;
  /** host-agent origin | relay origin | mcp (the first two are legacy wire constants, kept for compatibility) */
  origin: string;
  host: string;
  project: string | null;
  agent: string | null;
  /** Dashboard-only text (never goes into a push). */
  text: string;
  /** The relayed foreign agent behind a relay-origin alert: it gets its own push budget (`host|sender`). */
  sender?: string | null;
  /**
   * When the condition behind the alert began (a task's `updated`, an approval's `requestedAt`): a stable ranking
   * for the per-project cap, so the newest conditions win and the choice never changes between evaluations.
   */
  since?: number;
}

export interface PushItem {
  key: string;
  rule: DashboardRule;
  severity: Severity;
  /** When the alert opened (a push that is only just opening is `now`): the fairness order is oldest first. */
  opened: number;
  origin: string;
  host: string;
  project: string | null;
  agent: string | null;
  /** push_count / last_pushed as seen when the decision was made (optimistic claim). */
  pushCount: number;
  lastPushed: number | null;
  /** true for the 2nd+ push of an alert. */
  reminder: boolean;
  sender?: string | null;
  /** The `summarized_at` the rules saw (optimistic guard of the claim); null = never summarised. */
  summarizedAt?: number | null;
}

export interface RuleOutput {
  /** Every alert whose condition holds right now. */
  desired: AlertDraft[];
  /** Desired alerts that are not open yet. */
  open: AlertDraft[];
  /** Keys of open alerts whose condition no longer holds AND whose inputs were seen completely. */
  resolve: string[];
  /** Pushes to send now (new alerts, approval reminders, retries), most urgent first (see prioritizePushes). */
  push: PushItem[];
  /** The scans that hit their global LIMIT in this evaluation (their rule families resolved nothing). */
  truncated: RuleScan[];
  /** The partitions of scans that hit their per-partition limit (only the alerts living in them resolved nothing). */
  truncatedParts: Partial<Record<RuleScan, string[]>>;
  /** The scans that hit their global row limit, and the first host they did not read (see RuleInput.readFrom). */
  readFrom: Partial<Record<RuleScan, string>>;
  /** `alerts-capped` items that are open already: their text carries a count that moves, so it is rewritten when it differs. */
  refresh: Array<{ key: string; text: string }>;
}

const STUCK_SCENARIOS: readonly string[] = PUSH_HALT_SCENARIOS.filter((s) => s !== "usage-limit");
const STUCK_STATES: readonly string[] = ["wedged", "benched"];

const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/**
 * `text` for the inbox: it starts with `<project>@<host>: ` (the project alone is ambiguous when two
 * hosts run a project of the same name) and non-host-agent alerts always end with ` · via <host or client>`.
 */
function labelled(text: string, origin: string, host: string, project: string | null): string {
  const prefix = project ? `${project}@${host}: ` : "";
  const suffix = origin === ORIGIN_HOST ? "" : ` · via ${host}`;
  return prefix + clipText(text, Math.max(20, 300 - prefix.length - suffix.length)) + suffix;
}

function snapIndex(snapshots: RuleSnapshot[]): Map<string, RuleSnapshot> {
  const m = new Map<string, RuleSnapshot>();
  for (const s of snapshots) m.set(`${s.host}|${s.project}`, s);
  return m;
}

// ── individual rules ─────────────────────────────────────────────────────────

function approvalAlerts(snapshots: RuleSnapshot[], now: number, overflow: Map<string, number>): AlertDraft[] {
  const all: Array<AlertDraft & { requestedAt: number }> = [];
  for (const s of snapshots) {
    for (const a of s.snap.approvals ?? []) {
      // Without requestedAt the age is unknown: the contract field is effectively required here.
      if (typeof a.requestedAt !== "number") continue;
      if (now - a.requestedAt <= ALERT_DEFAULTS.approvalWaitingAfterMs) continue;
      all.push({
        key: `approval-waiting|${s.host}|${s.project}|${a.id}`,
        rule: "approval-waiting",
        severity: "warn",
        origin: ORIGIN_HOST,
        host: s.host,
        project: s.project,
        agent: a.agent ? lc(a.agent) : null,
        text: labelled(`Action waiting: ${a.summary}`, ORIGIN_HOST, s.host, s.project),
        requestedAt: a.requestedAt,
      });
    }
  }
  // At most MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT approval alerts per host+project, the OLDEST requests first (a
  // stable choice, so re-evaluating never flips which ones are open): a snapshot full of young approvals cannot
  // turn into a thousand alert rows a minute later, and one project's flood cannot hide another project's approval.
  // What does not fit is counted (it is reported by the project's `alerts-capped` warning).
  const perProject = new Map<string, number>();
  return all
    .sort((a, b) => a.requestedAt - b.requestedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((a) => {
      const scope = `${a.host}|${a.project ?? ""}`;
      const n = (perProject.get(scope) ?? 0) + 1;
      perProject.set(scope, n);
      if (n <= MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT) return true;
      overflow.set(scope, (overflow.get(scope) ?? 0) + 1);
      return false;
    })
    .map(({ requestedAt, ...draft }) => ({ ...draft, since: requestedAt }));
}

/** A hook task an older CLI filed for the idle Notification (the agent had finished; the user had not typed yet). */
const isIdleHookTask = (t: RuleTask): boolean => t.origin === "mcp" && t.title === HOOK_IDLE_TITLE && t.last_line === HOOK_MARK;

function blockedAlerts(tasks: RuleTask[], now: number): AlertDraft[] {
  // A host-agent task that ended with STATUS: BLOCKED is a CLOSED ledger task and stays in every
  // snapshot for up to 24 h. A newer dispatch to the same host+project+agent means the operator
  // already responded, so that alert resolves. (MCP and relay tasks are only unblocked by their
  // own update / STATUS line.)
  const scopeKey = (t: RuleTask) => `${t.host}|${t.project}|${lc(t.agent)}`;
  let derived: Map<string, number> | undefined;
  const latestDispatch = (t: RuleTask): number => {
    if (t.latest_dispatch !== undefined) return t.latest_dispatch ?? -Infinity;
    if (!derived) {
      derived = new Map();
      for (const x of tasks) {
        if (x.origin !== ORIGIN_HOST) continue;
        if (x.created > (derived.get(scopeKey(x)) ?? -Infinity)) derived.set(scopeKey(x), x.created);
      }
    }
    return derived.get(scopeKey(t)) ?? -Infinity;
  };
  const out: AlertDraft[] = [];
  for (const t of tasks) {
    if (t.state !== "blocked") continue;
    if (isIdleHookTask(t)) continue; // an older CLI's idle "Waiting for your input": not a block (closed at the next tick)
    if (now - t.updated >= BLOCKED_ALERT_TTL_MS) continue;
    if (t.origin === ORIGIN_HOST && latestDispatch(t) > t.created) continue;
    const host = t.host ?? "";
    out.push({
      key: `blocked|${host}|${t.project ?? ""}|${t.task_id}`,
      rule: "blocked",
      severity: "warn",
      origin: t.origin,
      host,
      project: t.project,
      agent: t.agent ? lc(t.agent) : null,
      text: labelled(`Blocked: ${t.last_line || t.title}`, t.origin, host, t.project),
      sender: t.origin === ORIGIN_RELAY ? t.task_id : null,
      since: t.updated,
    });
  }
  return out;
}

function overdueAlerts(tasks: RuleTask[], now: number): AlertDraft[] {
  const out: AlertDraft[] = [];
  for (const t of tasks) {
    if (t.state !== "running" || t.eta_at === null) continue;
    // MCP clients (desktop apps without hooks) often finish without update_task: a missed ETA there is not something the operator
    // must act on. The page shows such a task as "no update since ..." instead, and the maintenance tick closes it as `stale`.
    if (t.origin === "mcp") continue;
    const span = t.eta_at - t.updated; // the ETA the agent stated when it last reported
    if (span <= 0) continue;
    if (now <= t.updated + ALERT_DEFAULTS.overdueEtaFactor * span) continue;
    const host = t.host ?? "";
    out.push({
      // eta_at is in the key: a new ETA resolves this alert and (if also missed) opens a new one.
      key: `overdue|${host}|${t.project ?? ""}|${t.task_id}|${t.eta_at}`,
      rule: "overdue",
      severity: "warn",
      origin: t.origin,
      host,
      project: t.project,
      agent: t.agent ? lc(t.agent) : null,
      text: labelled(`Overdue: ${t.title}`, t.origin, host, t.project),
      sender: t.origin === ORIGIN_RELAY ? t.task_id : null,
      since: t.updated,
    });
  }
  return out;
}

function haltEventsOf(events: RuleEvent[], now: number): RuleEvent[] {
  return events.filter((e) => e.kind === "halt" && e.host && e.project && now - e.at <= EVENT_ALERT_TTL_MS);
}

function agentStuckAlerts(events: RuleEvent[], snaps: Map<string, RuleSnapshot>, now: number): AlertDraft[] {
  // Latest qualifying halt per agent wins (a newer halt supersedes an older one).
  const latest = new Map<string, RuleEvent>();
  for (const e of haltEventsOf(events, now)) {
    if (!e.scenario || !STUCK_SCENARIOS.includes(e.scenario)) continue;
    const k = `${e.host}|${e.project}|${lc(e.agent)}`;
    const prev = latest.get(k);
    if (!prev || e.at > prev.at || (e.at === prev.at && e.key > prev.key)) latest.set(k, e);
  }
  const out: AlertDraft[] = [];
  for (const e of latest.values()) {
    const snap = snaps.get(`${e.host}|${e.project}`);
    // A snapshot BUILT after the halt (sentAt > at) is the first one that can speak for the agent now.
    if (snap && snap.snap.sentAt > e.at) {
      // The alert stands only while the agent is still wedged/benched.
      const states = e.agent
        ? [snap.snap.agents.find((a) => lc(a.name) === lc(e.agent))?.state]
        : snap.snap.agents.map((a) => a.state);
      if (!states.some((st) => st !== undefined && STUCK_STATES.includes(st))) continue;
    }
    const origin = e.origin || ORIGIN_HOST;
    const host = e.host as string;
    out.push({
      key: `agent-stuck|${host}|${e.project}|${lc(e.agent) || "-"}|${e.scenario}`,
      rule: "agent-stuck",
      severity: severityForScenario(e.scenario ?? undefined),
      origin,
      host,
      project: e.project,
      agent: e.agent ? lc(e.agent) : null,
      text: labelled(e.text || `Agent stuck (${e.scenario})`, origin, host, e.project),
      since: e.at,
    });
  }
  return out;
}

function usageLimitAlerts(events: RuleEvent[], snapshots: RuleSnapshot[], snaps: Map<string, RuleSnapshot>, now: number): AlertDraft[] {
  const out = new Map<string, AlertDraft>();
  for (const s of snapshots) {
    for (const a of s.snap.agents) {
      if (a.state !== "usage-limit") continue;
      const key = `usage-limit|${s.host}|${s.project}|${lc(a.name)}`;
      out.set(key, {
        key,
        rule: "usage-limit",
        severity: "critical",
        origin: ORIGIN_HOST,
        host: s.host,
        project: s.project,
        agent: lc(a.name),
        text: labelled(`Usage limit reached: ${lc(a.name)}`, ORIGIN_HOST, s.host, s.project),
        // When the agent entered the state; a fact that does not move, so the per-host cap picks the same alerts every time.
        since: a.stateSince ?? 0,
      });
    }
  }
  for (const e of haltEventsOf(events, now)) {
    if (e.scenario !== "usage-limit") continue;
    const snap = snaps.get(`${e.host}|${e.project}`);
    // With a newer snapshot the snapshot's own agent states are authoritative (handled above).
    if (snap && snap.snap.sentAt > e.at) continue;
    const key = `usage-limit|${e.host}|${e.project}|${lc(e.agent) || "-"}`;
    if (!out.has(key)) {
      const origin = e.origin || ORIGIN_HOST;
      const host = e.host as string;
      out.set(key, {
        key,
        rule: "usage-limit",
        severity: "critical",
        origin,
        host,
        project: e.project,
        agent: e.agent ? lc(e.agent) : null,
        text: labelled(e.text || "Usage limit reached", origin, host, e.project),
        since: e.at,
      });
    }
  }
  return [...out.values()];
}

function hostOfflineAlerts(hosts: RuleHost[], now: number): AlertDraft[] {
  const out: AlertDraft[] = [];
  for (const h of hosts) {
    if (now - h.last_seen <= ALERT_DEFAULTS.hostOfflineAfterMs) continue;
    out.push({
      key: `host-offline|${h.host}`,
      rule: "host-offline",
      severity: "critical",
      origin: ORIGIN_HOST,
      host: h.host,
      project: null,
      agent: null,
      text: `No data from host ${h.host} for more than ${Math.round(ALERT_DEFAULTS.hostOfflineAfterMs / 60_000)} min`,
    });
  }
  return out;
}

/**
 * A project whose reporter sent nothing for longer than ALERT_DEFAULTS.projectOfflineAfterMs while its HOST is online (another
 * project of the host, or its own heartbeat path, keeps the host alive: without this a dead reporter on a live host would just
 * show stale data). Skipped when the whole host is offline (`host-offline` says it once, nobody needs a push per project) and
 * when the project has been silent for more than projectOfflineMaxMs (it was most likely removed from the host's config: the
 * alert resolves silently, the page still marks it). One alert per (host, project), bounded by the per-host project limit.
 */
function projectOfflineAlerts(projects: RuleProjectSeen[], hosts: RuleHost[], now: number): AlertDraft[] {
  const hostSeen = new Map(hosts.map((h) => [h.host, h.last_seen]));
  const out: AlertDraft[] = [];
  for (const p of projects) {
    const silent = now - p.last_seen;
    if (silent <= ALERT_DEFAULTS.projectOfflineAfterMs || silent > ALERT_DEFAULTS.projectOfflineMaxMs) continue;
    const hs = hostSeen.get(p.host);
    if (hs === undefined || now - hs > ALERT_DEFAULTS.hostOfflineAfterMs) continue;
    out.push({
      key: `project-offline|${p.host}|${p.project}`,
      rule: "project-offline",
      severity: "critical",
      origin: ORIGIN_HOST,
      host: p.host,
      project: p.project,
      agent: null,
      text: labelled(`Reporter sent nothing for more than ${Math.round(ALERT_DEFAULTS.projectOfflineAfterMs / 60_000)} min (the host is online)`, ORIGIN_HOST, p.host, p.project),
      since: p.last_seen,
    });
  }
  return out;
}

const untilText = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * A source that was refused for budget says so, instead of going quiet. A HOST token's refusal is
 * critical (and pushed once): snapshots and events of every project on that host are being dropped
 * (heartbeats keep the host "online", so nothing else would show it). A CLIENT token's is an inbox
 * item only. It resolves by itself when the budget window ends.
 */
function budgetAlerts(budgets: RuleBudget[], now: number): AlertDraft[] {
  const out: AlertDraft[] = [];
  for (const b of budgets) {
    if (b.budget_until <= now) continue;
    const host = b.kind === "host";
    out.push({
      key: `budget-exhausted|${b.name}`,
      rule: "budget-exhausted",
      severity: host ? "critical" : "warn",
      origin: host ? ORIGIN_HOST : "mcp",
      host: b.name,
      project: null,
      agent: null,
      text: host
        ? `Write budget exhausted for host ${b.name}: snapshots and events are refused until ${untilText(b.budget_until)} (heartbeats and critical halts are still accepted)`
        : labelled(`MCP budget exhausted for client ${b.name}: report_task / update_task are refused until ${untilText(b.budget_until)}`, "mcp", b.name, null),
    });
  }
  return out;
}

// ── push policy ──────────────────────────────────────────────────────────────

/**
 * Is a push due for this (open) alert right now?
 * - approval-waiting: on open, then again after 15, 30, 60 and 120 min (REPUSH_COOLDOWN_MS, each counted from the previous
 *   push), at most `approvalMaxPushes` in total; after that only the well-being digest mentions it.
 * - every other rule: exactly once on open. An unsent push (transient failure, no subscription yet) is
 *   attempted for PUSH_RETRY_WINDOW_MS after the alert opened; host-offline never pushes on resolve.
 */
/** The re-push cooldown after the n-th push of an alert: 15 -> 30 -> 60 -> 120 min, then digest only (well-being W1). */
export const REPUSH_COOLDOWN_MS: readonly number[] = [15, 30, 60, 120].map((m) => m * 60_000);
/** The wait after the n-th push (n >= 1); null = no more pushes. */
export function repushCooldown(pushCount: number): number | null {
  return pushCount >= 1 && pushCount <= REPUSH_COOLDOWN_MS.length ? (REPUSH_COOLDOWN_MS[pushCount - 1] as number) : null;
}

export function pushDue(
  alert: { rule: string; push_count: number; last_pushed: number | null; opened: number; summarized_at?: number | null },
  now: number,
): boolean {
  // `summarized_at`: the alert was folded into a budget summary instead of being pushed itself. That settles its
  // first push (it must not come up again every minute); only an approval's reminders can still follow it.
  const summarized = alert.summarized_at ?? null;
  if (alert.rule === "approval-waiting") {
    if (alert.push_count >= ALERT_DEFAULTS.approvalMaxPushes) return false;
    if (alert.push_count === 0 && summarized === null) return now - alert.opened <= PUSH_RETRY_WINDOW_MS;
    const last = Math.max(alert.last_pushed ?? 0, summarized ?? 0);
    const wait = repushCooldown(Math.max(1, alert.push_count));
    return wait !== null && last > 0 && now - last >= wait;
  }
  return alert.push_count === 0 && summarized === null && now - alert.opened <= PUSH_RETRY_WINDOW_MS;
}

export const RULE_WORDS: Record<DashboardRule, string> = {
  "approval-waiting": "action waiting",
  blocked: "blocked",
  "agent-stuck": "agent stuck",
  "usage-limit": "usage limit hit",
  "host-offline": "host offline",
  "project-offline": "reporter offline",
  overdue: "task overdue",
  "budget-exhausted": "write budget exhausted",
  "alerts-capped": "alert limit reached",
};

export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  /** Alert again when this replaces a notification with the same tag (critical alerts only). */
  renotify: boolean;
  url: string;
}

/**
 * The push budget an alert is charged to. A relayed foreign agent has ITS OWN (`rs|host|sender`), so one chatty
 * relay sender cannot spend its host's; the host agent's own CRITICAL alerts are exempt from the ordinary budget
 * (a critical cli-gone must never wait behind relayed BLOCKED pushes) and only meet a generous safety cap, kept
 * under `ct|host`; everything else is charged to the host label / MCP client name (`own|owner`). The keys are
 * typed and escaped (see keys.ts): no host label, client name, sender or agent can spell another source's key.
 */
export interface PushBudgetOf {
  key: string;
  /** The per-window budget does not apply (the safety cap under `key` does). */
  exempt: boolean;
}
export function pushBudgetOf(item: { origin: string; severity?: string; host: string; sender?: string | null }): PushBudgetOf {
  if (item.origin === ORIGIN_HOST && item.severity === "critical") return { key: budgetKey("ct", item.host), exempt: true };
  if (item.origin === ORIGIN_RELAY && item.sender) return { key: budgetKey("rs", item.host, item.sender), exempt: false };
  return { key: budgetKey("own", item.host), exempt: false };
}

/**
 * The ONLY text that ever leaves in a push: `<project>@<host>: <agent> <rule words>`, plus ` · via <host
 * or client>` when the alert is not from host agent itself. Never task text.
 *
 * `tag`: one notification per alert for host-agent alerts; ONE per budget key (source, or relay sender) for every
 * other origin, so a desktop client (or a relayed agent) that raises many alerts replaces its own notification
 * on the phone instead of stacking them. `renotify` (alert again when a notification with the same tag is
 * replaced) only for critical alerts: a replacement of a non-critical one is silent.
 */
export function pushMessage(
  alert: { key: string; rule: DashboardRule; host: string; project: string | null; agent: string | null; origin?: string | null; severity?: string; sender?: string | null },
  publicUrl: string,
): PushMessage {
  const scope = alert.project ? `${alert.project}@${alert.host}` : alert.host || "siiswell";
  const words = RULE_WORDS[alert.rule] ?? "needs you";
  const foreign = Boolean(alert.origin && alert.origin !== ORIGIN_HOST);
  let body = alert.agent ? `${scope}: ${alert.agent} ${words}` : `${scope}: ${words}`;
  if (foreign) body += ` · via ${alert.host}`;
  const base = publicUrl.replace(/\/+$/, "");
  const tag = foreign ? `src:${pushBudgetOf({ origin: alert.origin as string, severity: alert.severity, host: alert.host, sender: alert.sender }).key}` : alert.key;
  return { title: "Needs you", body, tag, renotify: alert.severity === "critical", url: `${base}/#alert=${encodeURIComponent(alert.key)}` };
}

/**
 * One push standing in for alerts a budget key was not allowed to push individually. The label is worded from the
 * key's kind and parts (`ct|h` reads "h (critical)", `rt|h` "h / relay"); a key that is not one of ours reads as
 * itself, which cannot happen for a row this Worker wrote.
 */
export function summaryPushMessage(key: string, n: number, publicUrl: string): PushMessage {
  const base = publicUrl.replace(/\/+$/, "");
  const d = decodeBudgetKey(key);
  const label = !d
    ? key
    : d.kind === "ct"
      ? `${d.parts[0]} (critical)`
      : d.kind === "ca"
        ? `${d.parts[0]} / ${d.parts[1]} (critical)`
        : d.kind === "rt"
          ? `${d.parts[0]} / relay`
          : d.parts.join(" / ");
  return { title: "Needs you", body: `${n} more item${n === 1 ? "" : "s"} via ${label}`, tag: `src:${key}`, renotify: false, url: `${base}/` };
}

// ── evaluation ───────────────────────────────────────────────────────────────

/**
 * The scans each rule family's resolution depends on. An alert is resolved when its condition is no
 * longer in the DESIRED set, which is only a statement about the world if every input of that rule was
 * read completely.
 */
const RESOLVE_NEEDS: Record<DashboardRule, readonly RuleScan[]> = {
  "approval-waiting": ["snapshots"],
  blocked: ["tasks"],
  overdue: ["tasks"],
  "agent-stuck": ["events"], // a missing snapshot keeps the alert, it never resolves it
  "usage-limit": ["snapshots", "events"],
  "host-offline": ["hosts"],
  "project-offline": ["hosts", "projects"], // a missing host row keeps the alert; so does a cut-off list of silent projects
  "budget-exhausted": ["budgets"],
  "alerts-capped": [], // a pure function of the alerts of the same evaluation
};

/**
 * Most urgent first, so a noisy source can never sit in front of an important push: the host agent's own alerts
 * before MCP / relay ones, critical before the rest, then the oldest alert first (it is the closest to
 * ageing out of PUSH_RETRY_WINDOW_MS), then by key for a stable order.
 */
export function prioritizePushes<T extends Pick<PushItem, "key" | "origin" | "severity" | "opened">>(items: T[]): T[] {
  const rank = (i: T): number => (i.origin === ORIGIN_HOST ? 0 : 2) + (i.severity === "critical" ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.opened - b.opened || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Which partition of scan `scan` an alert's inputs live in (global-only scans have none). */
function partitionOf(scan: RuleScan, a: RuleAlert): string | null {
  switch (scan) {
    case "snapshots":
    case "events":
      return a.host ?? "";
    case "tasks":
      return `${a.host ?? ""}|${a.origin ?? ""}`;
    default:
      return null;
  }
}

/** Was `host` not (fully) read by a scan that hit its global limit? Hosts are read in name order, see RuleInput.readFrom. */
function isUnread(readFrom: RuleInput["readFrom"], scan: RuleScan, host: string): boolean {
  const from = readFrom?.[scan];
  return from !== undefined && host >= from;
}

/** Never counted, never refused: at most one per host (host-offline), per host + project (project-offline, <= the per-host project limit), per source (budget-exhausted) or per scope (alerts-capped). */
const ALWAYS_KEPT = new Set<string>(["host-offline", "project-offline", "budget-exhausted", "alerts-capped"]);
const isCriticalClass = (d: AlertDraft): boolean => d.rule === "agent-stuck" || d.rule === "usage-limit" || d.severity === "critical";

interface CapsInput {
  drafts: AlertDraft[];
  openMap: Map<string, RuleAlert>;
  recentlyResolved: Map<string, RuleAlert>;
  /** Open alerts that are not desired now but cannot be resolved by this evaluation: they hold their slot until they lose it. */
  occupants: RuleAlert[];
  /** Approvals dropped by approvalAlerts' own per-project cap, per `host|project`. */
  overflow: Map<string, number>;
  now: number;
  /** The host's alert partition was not read completely (its open alerts cannot be counted). */
  unread: (host: string) => boolean;
}

interface CapsOutput {
  /** Keys that are not to be opened (and not pushed). */
  cappedKeys: Set<string>;
  /** Open keys displaced by newer ones. */
  evict: string[];
  /** The `alerts-capped` items that say how much did not fit. */
  notices: AlertDraft[];
}

/** One alert that counts against a cap: a desired draft, or an open alert that cannot be resolved right now. */
interface Candidate {
  key: string;
  host: string;
  project: string | null;
  origin: string;
  since: number;
  draft: AlertDraft | null;
}

/**
 * The caps on how many alerts one owner (the alert `host`: a host label, or an MCP client name) may have open, so no
 * source can grow the alert table, and with it every evaluation's reads, without bound, and none can reach another
 * source's alerts (every cap is inside one host):
 *  - NON-CRITICAL alerts: at most MAX_OPEN_ALERTS_PER_PROJECT per host+project (approvals: MAX_OPEN_APPROVAL_ALERTS_PER_
 *    PROJECT, applied in approvalAlerts), then at most MAX_OPEN_ALERTS_PER_HOST over all the projects of the host, so
 *    spreading alerts over many projects buys nothing;
 *  - CRITICAL alerts (agent-stuck, usage-limit, anything critical): at most MAX_OPEN_CRITICAL_ALERTS_PER_HOST per host.
 *    One host's flood of fabricated agents can neither hide its own real ones behind a thousand rows nor make the host's
 *    partition unreadable;
 *  - host-offline, project-offline, budget-exhausted and the alerts-capped items are never counted (see ALWAYS_KEPT).
 * What counts is what is OPEN, not only what is desired this minute: an open alert that this evaluation cannot resolve
 * (its inputs were cut off) competes for its slot like a desired one (see `occupants`), otherwise a flood that outruns the
 * scans would leave every older alert open beside the newest ones, without limit.
 * The OLDEST are evicted for the newest (the old ones were pushed long ago, the new one is what the operator has not
 * seen), and a host-agent alert always outranks a relayed foreign agent's: a chat user behind the relay cannot push a
 * host's own alerts out by claiming a fresh timestamp. The ranking is by when the condition began (`since`), a fact that
 * does not move, so an evicted alert is not re-opened by the next evaluation and nothing flaps. ONE `alerts-capped` item
 * per cap says how many did not fit: nothing is dropped silently.
 */
export function applyAlertCaps(input: CapsInput): CapsOutput {
  const { drafts, openMap, recentlyResolved, overflow, now } = input;
  const cappedKeys = new Set<string>();
  const evict: string[] = [];
  const counts = new Map<string, { host: string; project: string | null; kind: "project" | "host" | "critical"; n: number }>();
  const note = (kind: "project" | "host" | "critical", host: string, project: string | null, n: number): void => {
    const key = kind === "project" ? `${host}|${project ?? ""}` : `${host}|${kind === "host" ? "!all" : "!critical"}`;
    const e = counts.get(key) ?? { host, project: kind === "project" ? project : null, kind, n: 0 };
    e.n += n;
    counts.set(key, e);
  };
  const lose = (c: Candidate, kind: "project" | "host" | "critical"): void => {
    if (openMap.has(c.key)) evict.push(c.key);
    if (c.draft) cappedKeys.add(c.key);
    note(kind, c.host, c.project, 1);
  };

  // Stable ranking: when the condition began (`since`), else when the alert opened, else now. It must not depend on WHEN
  // the evaluation runs, or the capped-out candidates would out-rank the open alerts every minute and flap.
  const sinceOf = (d: AlertDraft): number => {
    const row = openMap.get(d.key) ?? recentlyResolved.get(d.key);
    return d.since ?? row?.since ?? row?.opened ?? now;
  };
  const byKey = (a: Candidate, b: Candidate): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const newestFirst = (a: Candidate, b: Candidate): number => b.since - a.since || byKey(a, b);
  const ownFirst = (a: Candidate, b: Candidate): number => Number(a.origin !== ORIGIN_HOST) - Number(b.origin !== ORIGIN_HOST) || newestFirst(a, b);

  const plain = new Map<string, Map<string, Candidate[]>>(); // host -> project scope -> non-critical candidates
  const critical = new Map<string, Candidate[]>(); // host -> critical candidates
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => void m.set(k, [...(m.get(k) ?? []), v]);
  const add = (c: Candidate, isCritical: boolean): void => {
    if (isCritical) {
      push(critical, c.host, c);
      return;
    }
    const byProject = plain.get(c.host) ?? new Map<string, Candidate[]>();
    push(byProject, c.project ?? "", c);
    plain.set(c.host, byProject);
  };
  for (const d of drafts) {
    if (ALWAYS_KEPT.has(d.rule)) continue;
    add({ key: d.key, host: d.host, project: d.project, origin: d.origin, since: sinceOf(d), draft: d }, isCriticalClass(d));
  }
  for (const a of input.occupants) {
    if (ALWAYS_KEPT.has(a.rule)) continue;
    add({ key: a.key, host: a.host ?? "", project: a.project ?? null, origin: a.origin ?? ORIGIN_HOST, since: a.since ?? a.opened, draft: null }, a.rule === "agent-stuck" || a.rule === "usage-limit");
  }

  for (const [host, byProject] of plain) {
    if (input.unread(host)) {
      // Cannot count what is open: nothing is evicted, and only alerts that are open already are kept.
      for (const list of byProject.values()) for (const c of list) if (c.draft && !openMap.has(c.key)) {
        cappedKeys.add(c.key);
        note("project", c.host, c.project, 1);
      }
      continue;
    }
    const survivors: Candidate[] = [];
    for (const list of byProject.values()) {
      const sorted = [...list].sort(ownFirst);
      survivors.push(...sorted.slice(0, MAX_OPEN_ALERTS_PER_PROJECT));
      for (const c of sorted.slice(MAX_OPEN_ALERTS_PER_PROJECT)) lose(c, "project");
    }
    const sorted = survivors.sort(ownFirst);
    for (const c of sorted.slice(MAX_OPEN_ALERTS_PER_HOST)) lose(c, "host");
  }
  for (const list of critical.values()) {
    const sorted = [...list].sort(newestFirst);
    for (const c of sorted.slice(MAX_OPEN_CRITICAL_ALERTS_PER_HOST)) lose(c, "critical");
  }
  for (const [scope, n] of overflow) {
    const [host = "", project = ""] = scope.split("|");
    note("project", host, project || null, n);
  }

  const notices: AlertDraft[] = [];
  for (const [scope, e] of counts) {
    if (e.n < 1) continue;
    const plural = `${e.n} alert${e.n === 1 ? "" : "s"}`;
    const text =
      e.kind === "project"
        ? `Alert limit reached: ${plural} over the limit of ${MAX_OPEN_ALERTS_PER_PROJECT} open (${MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT} approvals) for this project; the oldest are not shown.`
        : e.kind === "host"
          ? `Alert limit reached: ${plural} over the limit of ${MAX_OPEN_ALERTS_PER_HOST} open non-critical alerts for host ${e.host} (all its projects together); the oldest are not shown.`
          : `Critical alert limit reached: ${plural} older than the newest ${MAX_OPEN_CRITICAL_ALERTS_PER_HOST} critical alerts of host ${e.host} are not shown; look at the host itself.`;
    notices.push({
      key: `alerts-capped|${scope}`,
      rule: "alerts-capped",
      severity: e.kind === "critical" ? "critical" : "warn",
      origin: ORIGIN_HOST,
      host: e.host,
      project: e.project,
      agent: null,
      text: labelled(text, ORIGIN_HOST, e.host, e.project),
    });
  }
  return { cappedKeys, evict, notices };
}

/**
 * Inhibition rules (pushes only; every alert stays open and on the page):
 *  - a host that is offline inhibits that host's `project-offline` and `agent-stuck` alerts (the one cause is pushed, not
 *    its symptoms);
 *  - a `blocked` task inhibits the `overdue` alert of the same task (it waits for the operator; it is not late).
 * Returns the keys whose push is inhibited. Pure.
 */
export function inhibitedKeys(desired: ReadonlyArray<Pick<AlertDraft, "key" | "rule" | "host">>): Set<string> {
  const offline = new Set(desired.filter((d) => d.rule === "host-offline").map((d) => d.host));
  const blockedTasks = new Set(desired.filter((d) => d.rule === "blocked").map((d) => d.key.split("|").slice(1, 4).join("|")));
  const out = new Set<string>();
  for (const d of desired) {
    if ((d.rule === "project-offline" || d.rule === "agent-stuck") && offline.has(d.host)) out.add(d.key);
    if (d.rule === "overdue" && blockedTasks.has(d.key.split("|").slice(1, 4).join("|"))) out.add(d.key);
  }
  return out;
}

export function evaluateRules(input: RuleInput): RuleOutput {
  const { now } = input;
  const snaps = snapIndex(input.snapshots);
  const truncated: RuleScan[] = [...new Set(input.truncated ?? [])];
  const parts = input.truncatedParts ?? {};

  const overflow = new Map<string, number>(); // approvals beyond their own cap, per host|project
  const drafts: AlertDraft[] = [
    ...approvalAlerts(input.snapshots, now, overflow),
    ...blockedAlerts(input.tasks, now),
    ...agentStuckAlerts(input.events, snaps, now),
    ...usageLimitAlerts(input.events, input.snapshots, snaps, now),
    ...hostOfflineAlerts(input.hosts, now),
    ...projectOfflineAlerts(input.projectSeen ?? [], input.hosts, now),
    ...overdueAlerts(input.tasks, now),
    ...budgetAlerts(input.budgets ?? [], now),
  ];

  const openMap = new Map<string, RuleAlert>();
  const recentlyResolved = new Map<string, RuleAlert>();
  for (const a of input.alerts) {
    if (a.resolved === null) openMap.set(a.key, a);
    else if (now - a.resolved < REOPEN_GRACE_MS) recentlyResolved.set(a.key, a);
  }

  // Resolve only what this evaluation could really see end: nothing when the open-alert scan was cut off globally
  // or for the alert's host; otherwise only the rule families whose own inputs were read completely, globally AND
  // in the alert's own partition. An unknown rule name depends on everything.
  const blind = (a: RuleAlert): boolean => {
    if (truncated.includes("alerts") || (parts.alerts ?? []).includes(a.host ?? "") || isUnread(input.readFrom, "alerts", a.host ?? "")) return true;
    const needs = (RESOLVE_NEEDS as Record<string, readonly RuleScan[] | undefined>)[a.rule] ?? (["snapshots", "hosts", "projects", "tasks", "events", "budgets"] as const);
    return needs.some((scan) => {
      if (truncated.includes(scan) || isUnread(input.readFrom, scan, a.host ?? "")) return true;
      const part = partitionOf(scan, a);
      return part !== null && (parts[scan] ?? []).includes(part);
    });
  };

  // Caps (see applyAlertCaps): what does not fit is not opened (an open one is evicted) and is counted in an
  // `alerts-capped` item. An alert that is open, no longer desired and that this evaluation cannot resolve (its inputs
  // were cut off, e.g. a host with more than 100 halt events) still holds a slot: it takes part in the caps as a
  // candidate (ranked by when it opened), so a flood whose older alerts are frozen cannot grow the table past them.
  // A host whose alert partition was not read completely cannot be counted: its new non-critical alerts wait, nothing
  // of it is evicted.
  const draftKeys = new Set(drafts.map((d) => d.key));
  const caps = applyAlertCaps({
    drafts,
    openMap,
    recentlyResolved,
    occupants: [...openMap.values()].filter((a) => !draftKeys.has(a.key) && blind(a)),
    overflow,
    now,
    unread: (host) => truncated.includes("alerts") || (parts.alerts ?? []).includes(host) || isUnread(input.readFrom, "alerts", host),
  });
  drafts.push(...caps.notices);
  const cappedKeys = caps.cappedKeys; // not opened (and not pushed)
  const evict = caps.evict; // open, displaced by newer ones

  const desiredMap = new Map<string, AlertDraft>();
  for (const d of drafts) desiredMap.set(d.key, d);
  const desired = [...desiredMap.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const open = desired.filter((d) => !openMap.has(d.key) && !cappedKeys.has(d.key));

  const resolve = [
    ...new Set([
      ...[...openMap.values()].filter((a) => !desiredMap.has(a.key) && !blind(a)).map((a) => a.key),
      ...evict, // displaced by the per-project cap, whatever the scans saw
    ]),
  ].sort();

  const push: PushItem[] = [];
  const inhibited = inhibitedKeys(desired);
  for (const d of desired) {
    if (cappedKeys.has(d.key)) continue;
    // Inhibition (Alertmanager-style): the alert stays open and visible, only its push is left out
    if (inhibited.has(d.key)) continue;
    // A client's exhausted budget and the alert-cap warning are inbox items, never a push.
    if ((d.rule === "budget-exhausted" && d.severity !== "critical") || d.rule === "alerts-capped") continue;
    // A key resolved moments ago re-opens as the same incident (openAlertsStmt keeps its counters),
    // so its push state is the old row's, not a fresh one.
    const state = openMap.get(d.key) ?? recentlyResolved.get(d.key) ?? { rule: d.rule, push_count: 0, last_pushed: null, opened: now };
    if (!pushDue(state, now)) continue;
    push.push({
      key: d.key,
      rule: d.rule,
      severity: d.severity,
      opened: state.opened,
      origin: d.origin,
      host: d.host,
      project: d.project,
      agent: d.agent,
      pushCount: state.push_count,
      lastPushed: state.last_pushed,
      reminder: state.push_count > 0,
      sender: d.sender ?? null,
      summarizedAt: (state as RuleAlert).summarized_at ?? null,
    });
  }
  const refresh = desired.filter((d) => d.rule === "alerts-capped" && openMap.has(d.key)).map((d) => ({ key: d.key, text: d.text }));
  return { desired, open, resolve, push: prioritizePushes(push), truncated, truncatedParts: parts, readFrom: input.readFrom ?? {}, refresh };
}
