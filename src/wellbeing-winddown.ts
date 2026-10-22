/**
 * @file Wind-down: at the operator's wind-down time (settings `windDown`, default 23:00 local) a "safe to leave" summary goes
 * out and agents are told the operator is away (MCP `operator_status`) until the `morning` time, when the morning summary
 * goes out. Deterministic, zero AI.
 * @module dashboard-worker/wellbeing-winddown
 */
import { stmt } from "./db";
import type { PushMessage } from "./rules";
import { kvSet, localMinuteStart, localTime, type WbSettings } from "./wellbeing";

const DAY = 86_400_000;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const prevDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - DAY).toISOString().slice(0, 10);

export interface AwayWindow {
  away: boolean;
  /** the local day the window started on (the "night" it belongs to); null when wind-down is off */
  night: string | null;
  /** epoch ms the current / last window started and ends */
  from: number | null;
  until: number | null;
}

/** Is `now` inside the wind-down window [windDown, morning) (over midnight when morning is earlier)? Pure. */
export function awayWindow(s: Pick<WbSettings, "windDown" | "morning" | "tz">, now: number): AwayWindow {
  if (!s.windDown || s.windDown === s.morning) return { away: false, night: null, from: null, until: null };
  const lt = localTime(now, s.tz);
  const m = lt.hour * 60 + lt.minute;
  const a = minutesOf(s.windDown);
  const b = minutesOf(s.morning);
  const at = (day: string, hhmm: string) => localMinuteStart(day, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), s.tz);
  const next = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
  if (a > b) {
    // over midnight: 23:00 -> 07:00
    if (m >= a) return { away: true, night: lt.day, from: at(lt.day, s.windDown), until: at(next(lt.day), s.morning) };
    if (m < b) return { away: true, night: prevDay(lt.day), from: at(prevDay(lt.day), s.windDown), until: at(lt.day, s.morning) };
    return { away: false, night: prevDay(lt.day), from: at(prevDay(lt.day), s.windDown), until: at(lt.day, s.morning) };
  }
  // the same day: e.g. 01:00 -> 06:00
  if (m >= a && m < b) return { away: true, night: lt.day, from: at(lt.day, s.windDown), until: at(lt.day, s.morning) };
  const night = m >= b ? lt.day : prevDay(lt.day);
  return { away: false, night, from: at(night, s.windDown), until: at(night, s.morning) };
}

export interface NightCounts { running: number; waiting: number; done: number; blocked: number }

/** Open work and what changed since `since`, in ONE read (the tasks / alerts indexes; small tables). */
export const SQL_NIGHT_COUNTS = `SELECT
  (SELECT COUNT(*) FROM tasks WHERE state IN ('queued', 'delivered', 'acked', 'running')) AS running,
  (SELECT COUNT(*) FROM alerts WHERE resolved IS NULL AND rule IN ('approval-waiting', 'blocked')) AS waiting,
  (SELECT COUNT(*) FROM tasks WHERE state = 'done' AND updated >= ?1) AS done,
  (SELECT COUNT(*) FROM tasks WHERE state = 'blocked') AS blocked`;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function windDownMessage(c: NightCounts, morning: string, publicUrl: string): PushMessage {
  const waiting = c.waiting ? ` ${plural(c.waiting, "thing")} still wait${c.waiting === 1 ? "s" : ""} for you; answer now or ${c.waiting === 1 ? "it waits" : "they wait"} until ${morning}.` : "";
  return {
    title: "Time to wind down",
    body: `${plural(c.running, "task")} still running. Safe to leave: the agents carry on and keep their questions for the morning (${morning}).${waiting}`,
    tag: "wb:winddown",
    renotify: false,
    url: `${publicUrl.replace(/\/+$/, "")}/`,
  };
}

export function morningMessage(c: NightCounts, publicUrl: string): PushMessage {
  return {
    title: "Good morning",
    body: `Overnight: ${plural(c.done, "task")} done, ${c.blocked} blocked, ${c.running} still running${c.waiting ? `, ${c.waiting} waiting for you` : ""}.`,
    tag: "wb:morning",
    renotify: false,
    url: `${publicUrl.replace(/\/+$/, "")}/`,
  };
}

/** A morning summary is sent only within this long after the morning time (a ticker that was down does not send it at noon). */
export const MORNING_GRACE_MS = 3 * 3_600_000;

/**
 * The ticker's wind-down step: the wind-down summary once per night (at or after windDown, while away) and the morning
 * summary once (at or after morning, within MORNING_GRACE_MS, only after a night that had a wind-down). `sent` holds the
 * nights already handled (kv `rt:wind` / `rt:morning`). D1: nothing unless one is due; then 1 read + 1 write (+ the push).
 */
export async function runWindDown(
  db: D1Database,
  s: WbSettings,
  sent: { wind: string; morning: string },
  now: number,
  publicUrl: string,
  send: (m: PushMessage) => Promise<boolean>,
): Promise<"wind" | "morning" | null> {
  const w = awayWindow(s, now);
  if (!w.night || w.from === null || w.until === null) return null;
  if (w.away && sent.wind !== w.night) {
    await kvSet(db, "rt:wind", w.night, now).run(); // claimed first: once per night even if the push fails
    const c = await stmt(db, SQL_NIGHT_COUNTS, w.from).first<NightCounts>();
    if (c) await send(windDownMessage(c, s.morning, publicUrl));
    return "wind";
  }
  if (!w.away && now >= w.until && now - w.until < MORNING_GRACE_MS && sent.wind === w.night && sent.morning !== w.night) {
    await kvSet(db, "rt:morning", w.night, now).run();
    const c = await stmt(db, SQL_NIGHT_COUNTS, w.from).first<NightCounts>();
    if (c) await send(morningMessage(c, publicUrl));
    return "morning";
  }
  return null;
}

/** `HH:MM-HH:MM` (over midnight allowed). */
export const BLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Agent-free blocks (settings `freeBlocks`): is `now` inside one, and until when? Pure. During a block the agents are told
 * the operator is away and every push waits; one summary goes out when it ends.
 */
export function blockAt(s: Pick<WbSettings, "freeBlocks" | "tz">, now: number): { in: boolean; from: number | null; until: number | null } {
  const lt = localTime(now, s.tz);
  const m = lt.hour * 60 + lt.minute;
  for (const b of s.freeBlocks ?? []) {
    const x = BLOCK_RE.exec(b);
    if (!x) continue;
    const a = Number(x[1]) * 60 + Number(x[2]);
    const e = Number(x[3]) * 60 + Number(x[4]);
    if (a === e) continue;
    const inside = a < e ? m >= a && m < e : m >= a || m < e;
    if (!inside) continue;
    const startDay = a < e || m >= a ? lt.day : prevDay(lt.day);
    const endDay = a < e || m < e ? lt.day : new Date(Date.parse(`${lt.day}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
    return { in: true, from: localMinuteStart(startDay, Number(x[1]), Number(x[2]), s.tz), until: localMinuteStart(endDay, Number(x[3]), Number(x[4]), s.tz) };
  }
  return { in: false, from: null, until: null };
}

/** What `operator_status` answers (MCP, read-only). */
export function operatorStatus(s: WbSettings, now: number): { status: "away" | "available"; until?: string; message: string } {
  const blk = blockAt(s, now);
  if (blk.in && blk.until !== null) {
    const until = new Date(blk.until).toISOString();
    return {
      status: "away",
      until,
      message: `The operator is in an agent-free block until ${until}. Continue on your own with the safest reasonable choice; queue your questions and approvals (they are delivered together when the block ends) instead of waiting.`,
    };
  }
  const w = awayWindow(s, now);
  if (w.away && w.until !== null) {
    const until = new Date(w.until).toISOString();
    return {
      status: "away",
      until,
      message: `The operator is away until ${s.morning} (${s.tz}, ${until}). Continue on your own with the safest reasonable choice; collect your questions in the task summary instead of waiting, and report BLOCKED only when nothing else can be done.`,
    };
  }
  return { status: "available", message: "The operator is available. Ask when you need a decision." };
}

