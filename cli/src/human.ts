// SPDX-License-Identifier: Apache-2.0
/**
 * @file The operator's own input, recorded by the hooks on this machine and uploaded as hourly COUNTS (the "You" side of the
 * well-being layer). What is recorded: the time and kind of an event, and a response time; never a prompt, a tool argument
 * or a command (the hooks do not even keep them).
 *
 *  - "prompt": UserPromptSubmit.
 *  - "approve": a permission prompt (a Notification asking for permission) followed by the session's next PostToolUse: the
 *    user granted it.
 *  - response time: from a PERMISSION Notification to the session's next prompt / approval (the idle "waiting for your
 *    input" Notification is not timed: it fires after about 60 s of idle by itself).
 *
 * Local files (state dir, mode 0600): `human.log` (one line per event: `<epoch ms> <p|a> <response ms or ->`, pruned to the
 * last 72 h) and `human-<session>.pend` (the time of the session's open Notification). The upload (every 10 minutes at most,
 * from a background run) sends the last 26 hours as {h, prompts, approvals, rapid, latN, latP50}: numbers only.
 */
import { appendFileSync, linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { send, type FetchLike } from "./http";
import { ensureDir, readSmall, writePrivate } from "./usage/collect";

const HOUR = 3_600_000;
/** Two operator events closer than this are "rapid-fire". */
export const RAPID_MS = 30_000;
/** A Notification older than this no longer counts as waiting (no response time, no approval). */
export const PENDING_MAX_MS = 6 * HOUR;
export const HUMAN_UPLOAD_EVERY_MS = 10 * 60_000;
/** The upload covers this many hours back (the server replaces each hour it gets). */
export const HUMAN_UPLOAD_HOURS = 26;
const LOG_KEEP_MS = 72 * HOUR;
const LOG_PRUNE_BYTES = 256 * 1024;

const logPath = (dir: string) => join(dir, "human.log");
const pendPath = (dir: string, session: string) => join(dir, `human-${session}.pend`);
const stampPath = (dir: string) => join(dir, "human-upload.stamp");

export type HumanEvent = "notification" | "prompt" | "tool";

/**
 * Record what one hook event says about the operator. Cheap (a stat, at most a tiny read and one appended line) and never
 * throws: a PostToolUse with no open permission prompt touches nothing but a stat.
 */
export function recordHuman(dir: string, session: string, event: HumanEvent, at: number, permission = false): void {
  try {
    const pend = pendPath(dir, session);
    if (event === "notification") {
      ensureDir(dir);
      writePrivate(pend, JSON.stringify({ at: Math.round(at), p: permission ? 1 : 0 }));
      return;
    }
    let open: { at: number; p: number } | null = null;
    try {
      statSync(pend);
      open = JSON.parse(readSmall(pend, 256) ?? "null") as { at: number; p: number } | null;
    } catch {
      if (event === "tool") return; // the common case: nothing waited for the operator
    }
    // a response time only after a PERMISSION prompt: the idle "waiting for your input" Notification comes after about 60 s of
    // idle, so the time from it says nothing about how fast you answer
    const waited = open && open.p === 1 && typeof open.at === "number" && at - open.at >= 0 && at - open.at <= PENDING_MAX_MS ? Math.round(at - open.at) : null;
    if (event === "tool") {
      // a tool ran after a PERMISSION prompt: the operator approved it
      if (!open || open.p !== 1) return;
      appendLine(dir, `${Math.round(at)} a ${waited ?? "-"}`);
    } else {
      appendLine(dir, `${Math.round(at)} p ${waited ?? "-"}`);
    }
    try { unlinkSync(pend); } catch { /* gone */ }
  } catch {
    /* a hook never fails over this */
  }
}

function appendLine(dir: string, line: string): void {
  ensureDir(dir);
  appendFileSync(logPath(dir), `${line}\n`, { mode: 0o600 });
}

export interface LoggedEvent { t: number; k: "p" | "a"; lat: number | null }

/** The log's events at or after `since`, oldest first. Lines that do not parse are skipped. */
export function readHumanLog(dir: string, since = 0): LoggedEvent[] {
  let text = "";
  try { text = readFileSync(logPath(dir), "utf8"); } catch { return []; }
  const out: LoggedEvent[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d{10,16}) ([pa]) (\d{1,9}|-)$/.exec(line);
    if (!m) continue;
    const t = Number(m[1]);
    if (t < since) continue;
    out.push({ t, k: m[2] as "p" | "a", lat: m[3] === "-" ? null : Number(m[3]) });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface HourRow { h: number; prompts: number; approvals: number; rapid: number; rapidMin: number; latN: number; latP50: number | null }

const medianOf = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
};

/**
 * Pure: events -> one row per UTC hour (oldest first). "rapid" counts the events that came less than RAPID_MS after the
 * previous event (of any kind, on this machine), "rapidMin" the distinct minutes they fell in; latP50 is the median response time of the hour's events that had one.
 */
export function hourRows(events: readonly LoggedEvent[]): HourRow[] {
  const by = new Map<number, { r: HourRow; lats: number[]; mins: Set<number> }>();
  let prev: number | null = null;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const h = Math.floor(e.t / HOUR) * HOUR;
    const a = by.get(h) ?? { r: { h, prompts: 0, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null }, lats: [], mins: new Set<number>() };
    if (e.k === "p") a.r.prompts++;
    else a.r.approvals++;
    if (prev !== null && e.t - prev < RAPID_MS) {
      a.r.rapid++;
      a.mins.add(Math.floor(e.t / 60_000)); // the minutes spent in rapid-fire (the pace nudge's measure)
    }
    if (e.lat !== null) a.lats.push(e.lat);
    prev = e.t;
    by.set(h, a);
  }
  return [...by.values()].sort((a, b) => a.r.h - b.r.h).map(({ r, lats, mins }) => ({ ...r, rapidMin: mins.size, latN: lats.length, latP50: medianOf(lats) }));
}

/** Keep only the last 72 h of the log once it grows past 256 KB. */
function pruneLog(dir: string, now: number): void {
  try {
    if (statSync(logPath(dir)).size < LOG_PRUNE_BYTES) return;
    const keep = readHumanLog(dir, now - LOG_KEEP_MS).map((e) => `${e.t} ${e.k} ${e.lat ?? "-"}`);
    writePrivate(logPath(dir), keep.length ? `${keep.join("\n")}\n` : "");
  } catch { /* next time */ }
}

/** The upload body: the last HUMAN_UPLOAD_HOURS hours' rows. Numbers only (the privacy test checks the shape). */
export function humanUploadBody(dir: string, now: number): { v: 1; hours: HourRow[] } {
  const since = Math.floor(now / HOUR) * HOUR - (HUMAN_UPLOAD_HOURS - 1) * HOUR;
  return { v: 1, hours: hourRows(readHumanLog(dir, since)) };
}

/** After a failed upload (any status but 200, or no network) the next try waits 10, 20, 40, then 60 minutes; a success resets it. */
export const HUMAN_BACKOFF_MS: readonly number[] = [10, 20, 40, 60].map((m) => m * 60_000);
/** A claim older than this belongs to a run that died before it recorded the outcome. */
const CLAIM_STALE_MS = 2 * 60_000;
const statePath = (dir: string) => join(dir, "human-upload.json");
const claimPath = (dir: string, slot: number) => join(dir, `human-upload.${slot}.claim`);

/** The upload state: the earliest next upload and the failures in a row (an older install's stamp counts as one success). */
export function humanUploadState(dir: string): { next: number; n: number } {
  try {
    const j = JSON.parse(readSmall(statePath(dir), 256) ?? "null") as { next?: unknown; n?: unknown } | null;
    if (j && typeof j.next === "number" && typeof j.n === "number") return { next: j.next, n: j.n };
  } catch { /* none */ }
  const last = Number(readSmall(stampPath(dir), 64) ?? "0") || 0;
  return { next: last > 0 ? last + HUMAN_UPLOAD_EVERY_MS : 0, n: 0 };
}

/**
 * Is an upload due? Its time has come (the state's `next`: 10 minutes after the last upload, later after failures) and the
 * log has something. Cheap enough for a foreground hook: a stat and a tiny read; no network.
 */
export function humanUploadDue(dir: string, now: number): boolean {
  try {
    if (statSync(logPath(dir)).size <= 0) return false;
  } catch {
    return false;
  }
  return now >= humanUploadState(dir).next;
}

/**
 * Claim the upload of the slot `slot` (the state's `next`) atomically: a private temp file hard-linked into place (link fails
 * when it exists), so of two sessions only one uploads in a window. A stale claim (a run that died) is taken over.
 */
function claimSlot(dir: string, slot: number, now: number): boolean {
  const p = claimPath(dir, slot);
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      writeFileSync(tmp, String(now), { mode: 0o600 });
      try {
        linkSync(tmp, p);
        return true;
      } finally {
        try { unlinkSync(tmp); } catch { /* gone */ }
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return false;
      const at = Number(readSmall(p, 64) ?? "0") || 0;
      if (!(now - at > CLAIM_STALE_MS || at > now + 60_000)) return false;
      try { unlinkSync(p); } catch { /* another one took it */ }
    }
  }
  return false;
}

/**
 * Upload the hourly counts when due (see humanUploadDue) and there is something to send. The human upload has its OWN
 * backoff (HUMAN_BACKOFF_MS) and never touches the session's (a 429 / 400 / 503 here must not delay the task hooks).
 * Called from a background run that already has the network; never throws.
 */
export async function uploadHumanIfDue(cfg: Config, now: number, fetch?: FetchLike): Promise<"sent" | "not-due" | "nothing" | "failed"> {
  try {
    if (!cfg.url || !cfg.token) return "nothing";
    const dir = cfg.stateDir;
    const st = humanUploadState(dir);
    if (now < st.next) return "not-due";
    pruneLog(dir, now);
    const body = humanUploadBody(dir, now);
    if (!body.hours.length) return "nothing";
    ensureDir(dir);
    if (!claimSlot(dir, st.next, now)) return "not-due"; // another session uploads this window
    let ok = false;
    try {
      const r = await send(cfg.url, "/api/ingest/human", { token: cfg.token, body: JSON.stringify(body), timeoutMs: 8_000, fetch });
      ok = r.status === 200;
    } catch { ok = false; }
    const n = ok ? 0 : st.n + 1;
    const wait = ok ? HUMAN_UPLOAD_EVERY_MS : (HUMAN_BACKOFF_MS[Math.min(n - 1, HUMAN_BACKOFF_MS.length - 1)] as number);
    writePrivate(statePath(dir), JSON.stringify({ next: now + wait, n }));
    try { unlinkSync(claimPath(dir, st.next)); } catch { /* gone */ }
    return ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** What `siiswell doctor` says about the human recording on this machine (no network). */
export function humanDiagnostics(dir: string, home: string, now: number): { hookInstalled: boolean; logLines: number; lastLine: number | null; nextUpload: number; failures: number } {
  let hookInstalled = false;
  try {
    const t = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    hookInstalled = t.includes("siiswell") && t.includes("hook claude-prompt");
  } catch { /* no Claude Code settings */ }
  const events = readHumanLog(dir);
  const st = humanUploadState(dir);
  void now;
  return { hookInstalled, logLines: events.length, lastLine: events.length ? (events[events.length - 1] as LoggedEvent).t : null, nextUpload: st.next, failures: st.n };
}
