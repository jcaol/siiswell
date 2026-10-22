// SPDX-License-Identifier: Apache-2.0
/**
 * @file `siiswell hook <event>`: what the app hooks installed by scripts/setup-client.sh run. No AI, nothing but the CLI's own
 * MCP calls, and never in the app's way.
 * @module cli/hooks
 *
 *   claude-notification  Claude Code `Notification` hook (it needs a permission, or has been waiting for input): the session's task
 *                        becomes BLOCKED (one is reported when the session has none), so the dashboard shows "waiting for you".
 *   claude-stop          Claude Code `Stop` hook (a turn finished): the session's hook task goes back to IN_PROGRESS (default,
 *                        `--on-stop heartbeat`), or is closed with `--on-stop done`. A session without a hook task sends nothing.
 *   claude-post-tool     Claude Code `PostToolUse` / `UserPromptSubmit` (`claude-prompt`): the session is working again (the
 *   claude-prompt        permission was granted, the user answered). A BLOCKED hook task goes back to IN_PROGRESS. Cheap on purpose
 *                        (PostToolUse fires a lot): decided from the state file alone, no network call unless the task is BLOCKED,
 *                        and at most one unblock per HOOK_UNBLOCK_THROTTLE_MS inside one BLOCKED episode (a Notification starts
 *                        a new episode and clears the throttle stamp `up`). The background runs of one session are serialised by
 *                        a per-session lock and apply events in the order of their time (`at`): the newest event wins.
 *   claude-session-end   Claude Code `SessionEnd` (Ctrl-C, /exit, a closed terminal): the session's hook task is closed (DONE,
 *                        `--on-end done`, the default) or only marked alive (`--on-end heartbeat`).
 *   codex-notify         Codex `notify` program (a turn finished): an MCP heartbeat for the project.
 *
 * Fast and safe for the app: the hook reads its input (stdin for Claude Code, the last argument for Codex), keeps only the session
 * id, the working directory and the kind of notification, starts ITSELF again in the background (detached, `--wait`) and exits 0
 * at once; the background run does the network call with a short timeout and never reports an error to the app. Nothing of the
 * hook input's free text (the notification message, Codex's messages) is ever sent: titles are fixed sentences, the project is a
 * folder NAME (mcpDefaultProject), and every text still goes through the shared redaction. Per-session task ids are kept in
 * `<state dir>/hook-sessions.json` (0600), dropped after HOOK_SESSION_TTL_MS.
 */
import { taskProject } from "./taskProject";
import { uploadHumanIfDue } from "./human";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, linkSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipText } from "../../src/shared/redact";
import { MAX_TITLE } from "../../src/shared/schema";
import { homeOf, type Config } from "./config";
import { postMcp, type FetchLike } from "./http";
import { applyTaskText } from "./tasktext";
import { ensureDir, readSmall, writePrivate } from "./usage/collect";

export const HOOK_EVENTS = ["claude-notification", "claude-stop", "claude-post-tool", "claude-prompt", "claude-session-end", "codex-notify"] as const;
/** At most one unblocking update per session this often (PostToolUse fires on every tool call). */
export const HOOK_UNBLOCK_THROTTLE_MS = 30_000;
// The fixed titles of hook tasks and the summary that marks them (the server expires a hook's BLOCKED task after 2 h).
import { HOOK_MARK, HOOK_TITLES } from "../../src/shared/hook";
export { HOOK_MARK, HOOK_TITLES };
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const HOOK_SESSION_TTL_MS = 7 * 86_400_000;
export const HOOK_TIMEOUT_MS = 8_000;
const MAX_INPUT = 1 << 20;

/** The only fields a hook keeps from its input. */
export interface HookInput {
  /** hashed session id (never the raw one) */
  session: string;
  /** the app's working directory: in the foreground process only, never passed to the background run or written */
  cwd?: string;
  /** the task's project LABEL (taskProject), what the foreground hands to the background run instead of `cwd` */
  p?: string;
  /** Claude Code: the notification is a permission request */
  permission?: boolean;
  /** Claude Code: the notification is idle or informational (IDLE_NOTIFICATION_TYPES, "waiting for your input"): not a block */
  idle?: boolean;
  /** when the app fired the hook (set by the foreground hook): the background run orders its writes by it */
  at?: number;
}

const str = (v: unknown, max = 4096): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const hashId = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** Extract the HookInput from the app's raw input (Claude Code: JSON on stdin; Codex: JSON as the last argument). Null = unusable. */
export function parseHookInput(event: HookEvent, raw: string): HookInput | null {
  if (!raw || raw.length > MAX_INPUT) return null;
  let o: Record<string, unknown>;
  try {
    const j = JSON.parse(raw) as unknown;
    if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
    o = j as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event === "codex-notify") {
    const thread = str(o["thread-id"], 200) ?? str(o.thread_id, 200) ?? "codex";
    return { session: hashId(`codex:${thread}`), cwd: str(o.cwd) };
  }
  const sid = str(o.session_id, 200);
  if (!sid) return null;
  const base = { session: hashId(`claude:${sid}`), cwd: str(o.cwd) };
  if (event !== "claude-notification") return base;
  const type = str(o.notification_type, 64) ?? "";
  const message = str(o.message, 500) ?? "";
  // idle only when the app says so; every other or unknown kind (permission_prompt, elicitation_dialog, a future type, a
  // reworded message) waits for the user: BLOCKED
  if (IDLE_NOTIFICATION_TYPES.has(type) || (!BLOCKING_NOTIFICATION_TYPES.has(type) && /waiting for your input/i.test(message))) return { ...base, idle: true };
  return { ...base, ...(/permission/i.test(`${type} ${message}`) ? { permission: true } : {}) };
}

/** Notification types that need nothing from the user: the end-of-turn idle prompt and informational ones. */
export const IDLE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(["idle_prompt", "auth_success"]);
/** Types that always wait for the user, whatever their message says. */
const BLOCKING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(["permission_prompt", "elicitation_dialog"]);

// ── per-session task ids ─────────────────────────────────────────────────────

/** taskId, when the session was last seen, the last state the hook SET (`st`) and when an unblock was last sent (`up`). */
type Sessions = Record<string, { taskId: string; at: number; st?: "BLOCKED" | "IN_PROGRESS"; up?: number }>;
const sessionsPath = (dir: string) => join(dir, "hook-sessions.json");

/**
 * The idempotency key of the report a session is sending (`hook-<session>.ref`), written BEFORE the send: a run killed after
 * the dashboard created the task but before the task id was saved retries with the same key and gets that task back.
 */
const refPath = (dir: string, session: string) => join(dir, `hook-${session}.ref`);
function pendingRef(dir: string, session: string): string {
  try {
    const r = (JSON.parse(readSmall(refPath(dir, session), 256) ?? "{}") as { ref?: unknown }).ref;
    if (typeof r === "string" && /^[0-9a-f]{16}$/.test(r)) return r;
  } catch { /* a new one */ }
  return "";
}

export function readSessions(dir: string, now: number): Sessions {
  try {
    const f = JSON.parse(readSmall(sessionsPath(dir), 1 << 20) ?? "{}") as { v?: number; sessions?: Sessions };
    const out: Sessions = {};
    for (const [k, v] of Object.entries(f.v === 1 && f.sessions ? f.sessions : {})) {
      if (/^[0-9a-f]{24}$/.test(k) && typeof v?.taskId === "string" && /^m-[a-z0-9]{1,32}$/.test(v.taskId) && typeof v.at === "number" && now - v.at < HOOK_SESSION_TTL_MS) {
        out[k] = { taskId: v.taskId, at: v.at, ...(v.st === "BLOCKED" || v.st === "IN_PROGRESS" ? { st: v.st } : {}), ...(typeof v.up === "number" ? { up: v.up } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeSessions(dir: string, s: Sessions): void {
  ensureDir(dir);
  writePrivate(sessionsPath(dir), JSON.stringify({ v: 1, sessions: s }));
}

// ── the work (background run) ────────────────────────────────────────────────

interface ToolAnswer { ok: boolean; text: string }

async function tool(cfg: Config, name: string, rawArgs: Record<string, unknown>, fetch?: FetchLike): Promise<ToolAnswer> {
  const args = applyTaskText(name, rawArgs, cfg.taskText);
  const r = await postMcp(cfg.url!, cfg.token!, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { fetch, timeoutMs: HOOK_TIMEOUT_MS });
  const j = r.json as { result?: { content?: Array<{ text?: string }>; isError?: boolean } } | null;
  const text = j?.result?.content?.[0]?.text ?? "";
  return { ok: r.status === 200 && !!j?.result && !j.result.isError, text };
}

export interface HookRun {
  /** what was done, for tests and `--wait` output (never shown to the app) */
  action: "reported" | "updated" | "closed" | "heartbeat" | "nothing" | "skipped";
  detail?: string;
}

/**
 * Does this unblock event (claude-post-tool / claude-prompt) need any work? Decided from the state file alone (no network): only
 * when the session's hook task was last set BLOCKED and no unblock was sent in the last HOOK_UNBLOCK_THROTTLE_MS. The foreground
 * hook checks this before it starts anything in the background.
 */
export function unblockNeeded(input: HookInput, stateDir: string, now: number): boolean {
  const cur = readSessions(stateDir, now)[input.session];
  return !!cur && cur.st === "BLOCKED" && !(typeof cur.up === "number" && now - cur.up >= 0 && now - cur.up < HOOK_UNBLOCK_THROTTLE_MS);
}

// ── the event queue: one small file per event, so nothing is ever lost ─────────
//
// The foreground hook (fast, in the app's way) only WRITES its event (`hook-<session>.ev.<time>.<pid>.<n>.json`, created with
// O_EXCL) and starts a background run. A background run takes the session's lock and processes EVERY queued event of the session
// in time order, then deletes the files it handled. So a run that could not get the lock in time loses nothing (the next run, or
// its own retry, picks the event up), and the server sees the session's events in the order they happened, whatever order the
// processes ran in. Events closer together than ~100 ms are truly concurrent and have no defined order; from 200 ms apart the
// order is the order of the events.

export const HOOK_LOCK_WAIT_MS = 30_000;
/**
 * A lock or runner marker whose owner cannot be checked (no /proc, e.g. macOS, or an old file) is stale after this. An owner
 * that is checked is taken over AT ONCE when it is dead or its pid now belongs to another process, and kept while it lives
 * (up to HOOK_LIVE_OWNER_MAX_MS, so a wedged process cannot block the session for ever).
 */
export const HOOK_STALE_MS = 60_000;
export const HOOK_LIVE_OWNER_MAX_MS = 10 * 60_000;

/** Who holds a lock or a runner marker: the pid, the process's start time (Linux: /proc/<pid>/stat field 22) and since when. */
export interface Owner { pid: number; start?: string; at: number }
/** The start time of a process (clock ticks since boot, as text), or undefined where /proc is not available. */
export function procStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) ": field 3 is f[0], field 22 is f[19]
    return /^\d+$/.test(f[19] ?? "") ? f[19] : undefined;
  } catch {
    return undefined;
  }
}
export const ownerOf = (pid: number, at: number): Owner => {
  const start = procStart(pid);
  return { pid, ...(start ? { start } : {}), at };
};
function parseOwner(body: string, fallbackAt: number): Owner {
  try {
    const o = JSON.parse(body) as Partial<Owner> | number;
    if (typeof o === "object" && o && typeof o.pid === "number" && typeof o.at === "number") {
      return { pid: o.pid, at: o.at, ...(typeof o.start === "string" ? { start: o.start } : {}) };
    }
    if (typeof o === "number" && o > 0) return { pid: 0, at: o }; // an older marker: just a time
  } catch { /* an older lock: a random token */ }
  return { pid: 0, at: fallbackAt };
}
/**
 * Create `p` with `body` only if it does not exist, atomically WITH its content (a private temp file hard-linked into place:
 * link() fails with EEXIST like O_EXCL), so a reader never sees an empty lock or marker. Throws EEXIST when it exists.
 */
function createExclusive(p: string, body: string): void {
  const tmp = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try { linkSync(tmp, p); } finally { unlinkQuiet(tmp); }
}
/**
 * Take over a lock / marker judged gone, whose content was `seen`. Renaming it aside is atomic, so of several takers only one
 * moves it; that one then checks it moved the file it judged (not a fresh one created meanwhile) and puts a fresh one back.
 * Never unlink + create: two takers could then each remove the other's new file.
 */
function takeOver(p: string, seen: string): boolean {
  const aside = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.gone`;
  try { renameSync(p, aside); } catch { return false; } // another taker was first
  let body = "";
  try { body = readFileSync(aside, "utf8"); } catch { /* gone */ }
  if (body !== seen) {
    // moved a file we did not judge: put it back. If a newer one is already in place, leave ours aside for the sweep (never
    // delete a lock or marker that was not judged gone); the caller retries.
    try { linkSync(aside, p); unlinkQuiet(aside); } catch { /* EEXIST: abandoned, swept after an hour */ }
    return false;
  }
  unlinkQuiet(aside);
  return true;
}
/** Can this lock / marker be taken over now? */
export function ownerGone(o: Owner, now: number): boolean {
  if (o.at > now + 60_000) return true; // from the future: a clock jump
  if (o.pid > 0) {
    try {
      process.kill(o.pid, 0);
    } catch (err) {
      if ((err as { code?: string }).code === "ESRCH") return true; // dead
    }
    const start = procStart(o.pid);
    if (start !== undefined && o.start !== undefined) return start !== o.start || now - o.at > HOOK_LIVE_OWNER_MAX_MS; // reused pid
  }
  return now - o.at > HOOK_STALE_MS;
}
/** queued events older than this are dropped unprocessed (the session is long gone) */
export const HOOK_EVENT_MAX_AGE_MS = 60 * 60_000;
const lockPath = (dir: string, session: string) => join(dir, `hook-${session}.lock`);
const evPrefix = (session: string) => `hook-${session}.ev.`;

const PROJECT_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface QueuedEvent {
  e: HookEvent;
  /** the event's time (ms, sub-ms precision): taken as early as the process could */
  at: number;
  permission?: boolean;
  /**
   * The task's project LABEL (taskProject: already the policy's label, often none), worked out when the event is queued: the
   * working directory itself is never written to disk. `cwd` is only read from files of an older version.
   */
  p?: string;
  cwd?: string;
  /** Stop / SessionEnd: close the task (DONE) rather than keep it IN_PROGRESS */
  done?: boolean;
  /** file name (tie-break: pid and a per-process counter) */
  file?: string;
}

let queueCounter = 0;
/** Queue one event of a session (never throws; returns false when it could not be written). */
export function queueEvent(dir: string, session: string, ev: Omit<QueuedEvent, "file">): boolean {
  try {
    ensureDir(dir);
    capQueue(dir, session);
    const name = `${evPrefix(session)}${ev.at.toFixed(3).padStart(18, "0")}.${process.pid}.${queueCounter++}.json`;
    const fd = openSync(join(dir, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, JSON.stringify(ev)); } finally { closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

/** At most this many queued events per session: when full, the oldest non-Notification events go first. */
export const HOOK_QUEUE_CAP = 200;
function capQueue(dir: string, session: string): void {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.startsWith(evPrefix(session)) && n.endsWith(".json")).sort(); } catch { return; }
  let excess = names.length - (HOOK_QUEUE_CAP - 1);
  if (excess <= 0) return;
  const isNotification = (n: string) => {
    try { return (JSON.parse(readSmall(join(dir, n), 4096) ?? "{}") as { e?: string }).e === "claude-notification"; } catch { return false; }
  };
  const others = names.filter((n) => !isNotification(n));
  for (const n of [...others, ...names.filter((x) => !others.includes(x))]) {
    if (excess-- <= 0) break;
    unlinkQuiet(join(dir, n));
  }
}

/** Queued events, runner markers and backoff stamps of ANY session older than this are swept away. */
export const HOOK_SWEEP_AGE_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;
/**
 * Delete hook-*.ev.* files (and stale runner / backoff files) older than an hour in the whole state dir. Called on every drain
 * and, at most every 10 minutes (a stamp file), from any hook. Never throws.
 */
export function sweepStateDir(dir: string, now: number, force = false): number {
  try {
    const stamp = join(dir, "hook-sweep.stamp");
    if (!force) {
      // the stamp holds the hook clock's time (not the mtime), so a wrong file clock cannot stop or force sweeps
      try { const last = Number(readSmall(stamp, 64)); if (last > 0 && now - last < SWEEP_EVERY_MS && last <= now) return 0; } catch { /* first sweep */ }
    }
    ensureDir(dir);
    writePrivate(stamp, String(now));
    let n = 0;
    for (const name of readdirSync(dir)) {
      if (!/^hook-[0-9a-f]{24}\.(ev\..+\.json|runner|backoff|ref|(lock|runner)\.\d+\.[0-9a-f]{8}\.(tmp|gone))$/.test(name) && !/^human-[0-9a-f]{24}\.pend$/.test(name) && !/^human-upload\.\d+\.claim$/.test(name)) continue;
      const p = join(dir, name);
      try {
        // the time in the name (events), the time inside (runner marker), the backoff's end; the mtime only as a fallback
        const m = /\.ev\.(\d+\.\d{3})\./.exec(name);
        let t = m ? Number(m[1]) : NaN;
        if (!m) {
          const body = readSmall(p, 256) ?? "";
          const o = JSON.parse(body || "{}") as { until?: number; at?: number } | number;
          t = typeof o === "number" ? o : Number(o.until ?? o.at);
          if (!(t > 0)) t = statSync(p).mtimeMs;
        }
        if (now - t > HOOK_SWEEP_AGE_MS) { unlinkSync(p); n++; }
      } catch { /* gone */ }
    }
    return n;
  } catch {
    return 0;
  }
}

// ── one runner per session, and a backoff while the dashboard cannot be reached ──

const runnerPath = (dir: string, session: string) => join(dir, `hook-${session}.runner`);
const backoffPath = (dir: string, session: string) => join(dir, `hook-${session}.backoff`);

/**
 * Claim the session's runner slot for `pid` (the foreground claims it for itself, then hands it to the child it starts); false
 * while a live runner holds it. A marker whose process is dead or reused is taken over at once.
 */
export function claimRunner(dir: string, session: string, now: number, pid = process.pid): boolean {
  const p = runnerPath(dir, session);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensureDir(dir);
      createExclusive(p, JSON.stringify(ownerOf(pid, now)));
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return false;
      try {
        const seen = readSmall(p, 512) ?? "";
        if (ownerGone(parseOwner(seen, statSync(p).mtimeMs), now) && takeOver(p, seen)) continue;
      } catch { continue; }
      return false;
    }
  }
  return false;
}
/** The marker now names `pid` (the started child, or the runner refreshing its own entry while it sleeps or works). */
export function adoptRunner(dir: string, session: string, pid: number, now: number): void {
  try { writePrivate(runnerPath(dir, session), JSON.stringify(ownerOf(pid, now))); } catch { /* best effort */ }
}
/** Remove the marker only if it is this process's (a marker taken over by another runner stays). */
export function releaseRunner(dir: string, session: string): void {
  const p = runnerPath(dir, session);
  try { if (parseOwner(readSmall(p, 512) ?? "", 0).pid === process.pid) unlinkSync(p); } catch { /* gone */ }
}
export const runnerAlive = (dir: string, session: string, now: number): boolean => {
  const p = runnerPath(dir, session);
  try { return !ownerGone(parseOwner(readSmall(p, 512) ?? "", statSync(p).mtimeMs), now); } catch { return false; }
};

/** 30 s, 60 s, 120 s, ... up to 5 min after consecutive failed sends. */
export const BACKOFF_STEPS_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000, 300_000];
export function backoffUntil(dir: string, session: string): number {
  try { return (JSON.parse(readSmall(backoffPath(dir, session), 256) ?? "{}") as { until?: number }).until ?? 0; } catch { return 0; }
}
function recordFailure(dir: string, session: string, now: number): void {
  let n = 0;
  try { n = (JSON.parse(readSmall(backoffPath(dir, session), 256) ?? "{}") as { n?: number }).n ?? 0; } catch { n = 0; }
  const wait = BACKOFF_STEPS_MS[Math.min(n, BACKOFF_STEPS_MS.length - 1)] as number;
  try { writePrivate(backoffPath(dir, session), JSON.stringify({ n: n + 1, until: now + wait })); } catch { /* best effort */ }
}
const clearBackoff = (dir: string, session: string) => unlinkQuiet(backoffPath(dir, session));

/** The session's queued events, oldest first (time, then file name). */
export function queuedEvents(dir: string, session: string, now: number): QueuedEvent[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith(evPrefix(session)) && n.endsWith(".json")); } catch { return []; }
  const out: QueuedEvent[] = [];
  for (const file of names) {
    try {
      const o = JSON.parse(readSmall(join(dir, file), 4096) ?? "null") as QueuedEvent | null;
      if (!o || !(HOOK_EVENTS as readonly string[]).includes(o.e) || typeof o.at !== "number") { unlinkQuiet(join(dir, file)); continue; }
      if (now - o.at > HOOK_EVENT_MAX_AGE_MS) { unlinkQuiet(join(dir, file)); continue; }
      out.push({ e: o.e, at: o.at, ...(o.permission ? { permission: true } : {}), ...(typeof o.p === "string" && PROJECT_LABEL_RE.test(o.p) ? { p: o.p } : {}), ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}), ...(o.done ? { done: true } : {}), file });
    } catch { /* being written: the next run takes it */ }
  }
  return out.sort((x, y) => x.at - y.at || ((x.file ?? "") < (y.file ?? "") ? -1 : 1));
}
const unlinkQuiet = (p: string) => { try { unlinkSync(p); } catch { /* gone */ } };

/**
 * Take the session's lock (O_EXCL create), waiting up to HOOK_LOCK_WAIT_MS; a lock whose holder is gone (see ownerGone: a killed
 * run) is broken. Held across read -> network -> write. Returns the release function, or null when the wait timed out (the
 * event stays queued for the next run).
 */
export async function acquireHookLock(dir: string, session: string, waitMs = HOOK_LOCK_WAIT_MS): Promise<(() => void) | null> {
  ensureDir(dir);
  const p = lockPath(dir, session);
  const until = Date.now() + waitMs;
  for (;;) {
    const body = JSON.stringify({ ...ownerOf(process.pid, Date.now()), token: randomUUID() });
    try {
      createExclusive(p, body);
      return () => {
        try { if (readFileSync(p, "utf8") === body) unlinkSync(p); } catch { /* gone */ }
      };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return null;
      try {
        // a dead holder (killed run) is replaced at once; a live one is waited for
        const seen = readSmall(p, 512) ?? "";
        if (ownerGone(parseOwner(seen, statSync(p).mtimeMs), Date.now()) && takeOver(p, seen)) continue;
      } catch { continue; }
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 20)));
    }
  }
}

/** The server's answers that mean "this task is gone, report a new one" (update_task in src/mcp.ts). */
const GONE_RE = /^(task is closed; report a new task|unknown task_id: |task was closed after 24 h without an update)/;

/**
 * Claude Code's idle Notification (`idle_prompt`, "Claude is waiting for your input", about 60 s after a turn ended) and the
 * informational types (IDLE_NOTIFICATION_TYPES) are NOT a block: the Stop hook already handled the end of the turn. Every other
 * Notification makes the task BLOCKED.
 */
export function isIdleNotification(event: HookEvent, input: Pick<HookInput, "idle">): boolean {
  return event === "claude-notification" && input.idle === true;
}

/** Is an unblock event worth queuing (the session's task is, or is about to be, BLOCKED and not throttled)? No network. */
export function unblockWorthQueuing(input: HookInput, stateDir: string, now: number): boolean {
  if (unblockNeeded(input, stateDir, now)) return true;
  return queuedEvents(stateDir, input.session, now).some((e) => e.e === "claude-notification");
}

/**
 * The event this process stands for, queued (unless the foreground already did), then every queued event of the session is
 * processed under the session's lock. Never throws (a hook must not fail the app).
 */
export async function runHook(event: HookEvent, input: HookInput, cfg: Config, env: Record<string, string | undefined>, opts: { now?: number; fetch?: FetchLike; onStop?: "done" | "heartbeat"; onEnd?: "done" | "heartbeat"; queued?: boolean; runner?: boolean; sleep?: (ms: number) => Promise<void>; lockWaitMs?: number } = {}): Promise<HookRun> {
  try {
    if (!cfg.url || !cfg.token) return { action: "skipped", detail: "no dashboard URL or client token configured" };
    const at = input.at ?? opts.now ?? Date.now();
    if (event === "codex-notify") {
      const project = cfg.project ?? input.p ?? (input.cwd ? taskProject(input.cwd, cfg, homeOf(env)) : undefined) ?? "other";
      const r = await tool(cfg, "heartbeat", project ? { project } : {}, opts.fetch);
      return { action: r.ok ? "heartbeat" : "skipped" };
    }
    if (!opts.queued) {
      if (isIdleNotification(event, input)) return { action: "nothing" };
      if ((event === "claude-post-tool" || event === "claude-prompt") && !unblockWorthQueuing(input, cfg.stateDir, at)) return { action: "nothing" };
      const done = event === "claude-session-end" ? (opts.onEnd ?? "done") === "done" : event === "claude-stop" ? (opts.onStop ?? "heartbeat") === "done" : false;
      const label = input.p ?? (input.cwd ? taskProject(input.cwd, cfg, homeOf(env)) : undefined);
      if (!queueEvent(cfg.stateDir, input.session, { e: event, at, ...(input.permission ? { permission: true } : {}), ...(label ? { p: label } : {}), ...(done ? { done: true } : {}) })) {
        return { action: "skipped", detail: "the event could not be queued" };
      }
    }
    const dir = cfg.stateDir;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    // the hook clock: the injected time (tests) moves on by what this run slept
    let slept = 0;
    const clock = () => (opts.now !== undefined ? opts.now + slept : Date.now());
    const mine = () => { try { return parseOwner(readSmall(join(dir, `hook-${input.session}.runner`), 512) ?? "", 0).pid === process.pid; } catch { return false; } };
    // wait for the backoff to end, keeping the marker fresh (every 20 s)
    const sitOutBackoff = async () => {
      for (let left = backoffUntil(dir, input.session) - clock(); left > 0; left = backoffUntil(dir, input.session) - clock()) {
        const step = Math.min(left, 20_000);
        await sleep(step);
        slept += step;
        if (mine()) adoptRunner(dir, input.session, process.pid, clock());
      }
    };
    const startedAt = clock();
    // started for a Notification during a backoff: wait for its end, then send
    if (opts.runner) await sitOutBackoff();
    let r: HookRun = { action: "nothing" };
    // The runner keeps its marker while it works and loops while events are queued, so no other run is started meanwhile.
    for (let pass = 0; pass < 20; pass++) {
      let release = await acquireHookLock(dir, input.session, opts.lockWaitMs);
      // the wait timed out: one more look, the holder may just have finished and left events behind
      if (!release && queuedEvents(dir, input.session, clock()).length) release = await acquireHookLock(dir, input.session, 2_000);
      if (!release) { r = { action: "skipped", detail: "the session is busy; the event stays queued for the next run" }; break; }
      try {
        const t = clock();
        sweepStateDir(dir, t, true);
        // the dashboard cannot be reached at all (fetch throws): the same as a failed send, the queue stays
        try { r = await drain(input.session, cfg, env, opts.fetch, t); } catch { r = { action: "skipped", detail: "the dashboard could not be reached (send failed); the events stay queued" }; }
        // a send that failed backs this session off (30 s -> 5 min): the foreground then only queues (Notifications), it starts no runs
        if (r.action === "skipped" && /failed/.test(r.detail ?? "")) recordFailure(dir, input.session, t);
        else if (r.action !== "skipped") clearBackoff(dir, input.session);
      } finally {
        release();
      }
      const left = queuedEvents(dir, input.session, clock());
      if (!opts.runner || !left.length) break;
      if (r.action === "skipped") {
        // the send failed and a Notification is still queued: the user waits at the prompt, so no other hook will come. Keep the
        // marker, sit out the backoff and try again (at most 20 passes, never past the events' 1 h lifetime)
        if (!/failed/.test(r.detail ?? "") || !left.some((e) => e.e === "claude-notification") || !mine()) break;
        await sitOutBackoff();
        if (clock() - startedAt >= HOOK_EVENT_MAX_AGE_MS) break;
        continue;
      }
      if (mine()) adoptRunner(dir, input.session, process.pid, clock());
    }
    // the operator's hourly counts go up from here (this run already talks to the dashboard), at most every 10 minutes
    // the human upload keeps its own backoff (cli/src/human.ts): its failures never hold up the task hooks
    if (r.action !== "skipped") await uploadHumanIfDue(cfg, clock(), opts.fetch);
    if (opts.runner) {
      releaseRunner(dir, input.session);
      // an event queued between the last look and the release found a live marker and started nothing: take it (only a runner re-claims)
      if (r.action !== "skipped" && queuedEvents(dir, input.session, clock()).length && claimRunner(dir, input.session, clock())) {
        return await runHook(event, input, cfg, env, { ...opts, queued: true, ...(opts.now !== undefined ? { now: clock() } : {}) });
      }
    }
    return r;
  } catch {
    return { action: "skipped", detail: "error" };
  }
}

/**
 * Process every queued event of the session (under its lock), oldest first: the state they lead to is computed first, then
 * at most a report (a Notification with no task yet) and one update are sent; the newest event's state is what the server ends
 * with. A Notification whose report fails stays queued (retried by the next run); other events are done with.
 */
async function drain(session: string, cfg: Config, env: Record<string, string | undefined>, fetch: FetchLike | undefined, now: number): Promise<HookRun> {
  const events = queuedEvents(cfg.stateDir, session, now);
  if (!events.length) return { action: "nothing" };
  const sessions = readSessions(cfg.stateDir, now);
  const cur = sessions[session];
  let taskId: string | undefined = cur?.taskId;
  if (taskId) unlinkQuiet(refPath(cfg.stateDir, session)); // the report it stood for was saved: never reuse it for a new task
  let st: "BLOCKED" | "IN_PROGRESS" | "DONE" | undefined = cur?.st;
  let up = cur?.up;
  let lastAt = cur?.at ?? 0;
  let notification: QueuedEvent | undefined;
  for (const ev of events) {
    if (ev.at < lastAt) continue; // older than what was applied: superseded
    lastAt = ev.at;
    if (ev.e === "claude-notification") {
      notification = ev;
      st = "BLOCKED";
      up = undefined; // a new BLOCKED episode: the unblock throttle starts again
    } else if (ev.e === "claude-post-tool" || ev.e === "claude-prompt") {
      if (st === "BLOCKED" && !(typeof up === "number" && ev.at - up >= 0 && ev.at - up < HOOK_UNBLOCK_THROTTLE_MS)) {
        st = "IN_PROGRESS";
        up = ev.at;
      }
    } else if ((taskId || notification) && (ev.e === "claude-stop" || ev.e === "claude-session-end")) {
      st = ev.done ? "DONE" : "IN_PROGRESS";
    }
  }
  const forget = (files: QueuedEvent[]) => { for (const f of files) if (f.file) unlinkQuiet(join(cfg.stateDir, f.file)); };
  const write = () => {
    const all = readSessions(cfg.stateDir, now);
    if (!taskId || st === "DONE") delete all[session];
    else all[session] = { taskId, at: lastAt, ...(st === "BLOCKED" || st === "IN_PROGRESS" ? { st } : {}), ...(typeof up === "number" ? { up } : {}) };
    writeSessions(cfg.stateDir, all);
    unlinkQuiet(refPath(cfg.stateDir, session)); // the task id is saved: the key has done its job
  };
  let action = "nothing" as HookRun["action"];
  const report = async (ev: QueuedEvent): Promise<boolean> => {
    const project = cfg.project ?? ev.p ?? (ev.cwd ? taskProject(ev.cwd, cfg, homeOf(env)) : undefined) ?? "other";
    const title = clipText(ev.permission ? HOOK_TITLES[0] : HOOK_TITLES[2], MAX_TITLE);
    // the fixed summary marks a hook's task: the dashboard closes such a BLOCKED task after 2 h without any update from it
    let ref = pendingRef(cfg.stateDir, session);
    if (!ref) {
      ref = randomBytes(8).toString("hex");
      writePrivate(refPath(cfg.stateDir, session), JSON.stringify({ ref, at: now })); // throws -> no send without a saved key
    }
    const r = await tool(cfg, "report_task", { project, title, status: "BLOCKED", summary: HOOK_MARK, agent: "claude", client_ref: ref, ...(cfg.machine ? { machine: cfg.machine } : {}) }, fetch);
    let id: string | undefined;
    try { id = (JSON.parse(r.text) as { task_id?: unknown }).task_id as string | undefined; } catch { /* no id */ }
    if (r.ok && typeof id === "string" && /^m-[a-z0-9]{1,32}$/.test(id)) {
      taskId = id;
      action = "reported";
      return true;
    }
    return false;
  };
  // a Notification for a session without a task: report it (BLOCKED); if that fails, keep the Notification queued
  if (notification && !taskId) {
    if (!(await report(notification))) {
      forget(events.filter((e) => e.e !== "claude-notification"));
      return { action: "skipped", detail: "the report failed; the Notification stays queued" };
    }
    if (st === "BLOCKED") { write(); forget(events); return { action } ; }
  }
  if (!taskId || !st) { forget(events); write(); return { action }; }
  // a Notification is never folded away: the dashboard sees the prompt (BLOCKED) even when a later event in this batch already
  // answered it; the later state follows in a second update
  if (notification && action !== "reported" && st !== "BLOCKED") {
    const b = await tool(cfg, "update_task", { task_id: taskId, status: "BLOCKED" }, fetch);
    if (!b.ok && !GONE_RE.test(b.text)) {
      forget(events.filter((e) => e.e !== "claude-notification"));
      return { action: "skipped", detail: "the update failed; the Notification stays queued" };
    }
    if (b.ok) action = "updated";
    else {
      // the task was closed on the server: the prompt gets a new task
      taskId = undefined;
      if (!(await report(notification))) {
        forget(events.filter((e) => e.e !== "claude-notification"));
        write();
        return { action: "skipped", detail: "the report failed; the Notification stays queued" };
      }
    }
  }
  const serverSt = action === "reported" || (notification && action === "updated") ? "BLOCKED" : cur?.st;
  if (st !== serverSt || (notification && st === "BLOCKED")) {
    let r = await tool(cfg, "update_task", { task_id: taskId, status: st }, fetch);
    if (!r.ok && GONE_RE.test(r.text)) {
      taskId = undefined;
      if (st === "BLOCKED" && notification) {
        if (!(await report(notification))) {
          forget(events.filter((e) => e.e !== "claude-notification"));
          write();
          return { action: "skipped", detail: "the report failed; the Notification stays queued" };
        }
        r = { ok: true, text: "" };
      }
    }
    if (r.ok && action !== "reported") action = st === "DONE" ? "closed" : "updated";
    if (!r.ok && taskId) {
      // not delivered: the Notification stays queued; the unblock is throttled from its stamp anyway
      if (notification) {
        st = cur?.st;
        forget(events.filter((e) => e.e !== "claude-notification"));
        write();
        return { action: "skipped", detail: "the update failed; the Notification stays queued" };
      }
      st = cur?.st;
      forget(events);
      write();
      return { action: "skipped", detail: "the update failed" };
    }
  }
  forget(events);
  write();
  return { action };
}
