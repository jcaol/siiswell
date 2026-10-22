/**
 * @file The human well-being layer, part 1: fewer interruptions (migration 0007). PURE policy + small D1 helpers.
 * @module dashboard-worker/wellbeing
 *
 * Everything here is rule-based (SQL + thresholds); nothing calls an AI. The push policy sits between the rules
 * (`evaluateRules` says which alerts are due) and the push dispatch:
 *  - tier: `now` (approval-waiting, blocked, host-offline, usage-limit, and a CRITICAL agent-stuck such as cli-gone) is pushed; `batch` (overdue, agent-stuck,
 *    project-offline and the time-based well-being items) waits for ONE digest push per interval; `info` (the rest) is never
 *    pushed, only shown on the page;
 *  - quiet hours (default 23:00-07:00 in the settings' time zone): only `now` alerts are pushed, at most one per project per
 *    hour; the rest waits for the first digest after quiet hours (the morning digest);
 *  - Focus (a time the operator chose on the page): nothing is pushed except approval-waiting, no digest either;
 *  - storm control: several `now` pushes due in the same tick go out as ONE push, oldest first (push.ts);
 *  - re-push cooldown of an alert that keeps repeating (approval reminders): 15 -> 30 -> 60 -> 120 min, then digest only
 *    (rules.ts `pushDue`).
 * An alert held back by the policy is marked `summarized_at` (so the rules stop offering it every minute) and is picked up by
 * the digest (`wb_digested` IS NULL). With migration 0007 missing, the policy is off and every push behaves as before.
 */
import { dashboardTz } from "./tz";
import { LIGHT_DEFAULTS, seriousCase, validateLight } from "./wellbeing-light";
import { BLOCK_RE, awayWindow, blockAt } from "./wellbeing-winddown";
import { energy, energyDay } from "./wellbeing-energy";
import { coverageOf, keptDays, restBlock, switchSummary } from "./wellbeing-rest";
import { readiness } from "./wellbeing-readiness";
import { dayLoads, highIntensityWeek, intensitySentences, intensityStreak, seriousInputs } from "./wellbeing-intensity";
import { humanHours, sumHours, type HumanHourSum } from "./human";
import { OPERATOR_APPS, YOU_WEIGHTS, rapidMinutes, youEstimate, youIndicators, youRaw } from "./wellbeing-you";
import { all, first, stmt } from "./db";
import type { DashboardRule, PushItem, PushMessage } from "./rules";
import { REPUSH_COOLDOWN_MS, RULE_WORDS } from "./rules";
export { REPUSH_COOLDOWN_MS, repushCooldown } from "./rules";
import { errorJson, isObj, json } from "./util";
import { type NudgeState, SQL_ACTIVITY_BY_TZ, STRESS_TICK_MINUTE, THRESHOLDS, dueNudges, activityOf, humanRowsOf, indicatorsFromRow, localHourStart, limitWindows, readStressInputs, stressTickMinute, weeklyReflection, wellbeingNumbers, type MetricRow, type WellbeingNumbers } from "./wellbeing-metrics";
import { appendSamples, forecasts, newHistory, safeLabel, type LimitHistory } from "./wellbeing-forecast";
import { calendarError, calendarFocusUntil, calendarUrlProblem, maskCalendarUrl, busyIntervals, fetchCalendar, CAL_ERR, CAL_TICK_MINUTE, CAL_WINDOW_MS } from "./wellbeing-calendar";
import { STRESS_WEIGHTS, bandOf, lastLocalHours, dayStress, emaStep, radarSeries, sparklines, stressRaw, stressTrend, weekCard, weekHourStress } from "./wellbeing-stress";

// ── settings ─────────────────────────────────────────────────────────────────

export interface WbSettings {
  /** IANA time zone the quiet hours and the day boundaries are in. */
  tz: string;
  /** `HH:MM` start / end of the quiet hours (end may be before start: over midnight). Equal = no quiet hours. */
  quietStart: string;
  quietEnd: string;
  /** Saturday and Sunday are quiet all day. */
  weekendsQuiet: boolean;
  /** Minutes between two digest pushes. */
  digestMin: number;
  /** Well-being nudges on the page (W3). */
  nudges: boolean;
  /** Scheduled Summary times (`HH:MM`, local): a summary also goes out at each of these, besides every `digestMin`. */
  summaryTimes: string[];
  /** group_wait: a NEW Time-Sensitive (`now`) alert waits this long so others of the same moment join its push (0 = at once). */
  groupWaitSec: number;
  /**
   * `HH:MM` wind-down (local; "" = off): a "safe to leave" summary goes out, and agents are told the operator is away
   * (MCP `operator_status`) until `morning`, when the morning summary goes out.
   */
  windDown: string;
  morning: string;
  /**
   * Approval inbox: 0 = off (an approval waiting for you is Time-Sensitive, pushed at once); 15 / 30 = approvals are held
   * and delivered together, at most every that many minutes (with the Scheduled Summary).
   */
  approvalBatchMin: number;
  /** The stress traffic light (wellbeing-light.ts): yellow from this level, red from `lightRed` (1-99, yellow < red). */
  lightYellow: number;
  lightRed: number;
  /** Energy battery colours: green at or above `energyGreen`, yellow from `energyYellow`, red below (1-99, yellow < green). */
  energyGreen: number;
  energyYellow: number;
  /** After-hours ratio (7 days, %): yellow above `afterHoursYellow`, red above `afterHoursRed` (1-99, yellow < red). */
  afterHoursYellow: number;
  afterHoursRed: number;
  /** Longest rest gap (hours): yellow below `restYellow`, red below `restRed` (1-23, red < yellow). */
  restYellow: number;
  restRed: number;
  /** Agent-free blocks, `HH:MM-HH:MM` local, up to 3: agents are told the operator is away, pushes wait, one summary after. */
  freeBlocks: string[];
  /** "Kept days": a day counts as ended early with no input from `keptEnd` to the morning, and rested with a rest of `keptRest` h+. */
  keptEnd: string;
  keptRest: number;
  /** Context switches per hour: yellow from `switchYellow`, red from `switchRed` (1-50, yellow < red). */
  switchYellow: number;
  switchRed: number;
  /** Daily load target: at most this many projects and active hours of your own input a day (the rings; a cue, not a goal). */
  maxProjects: number;
  maxActiveHours: number;
  /** Send the well-being reminders (micro-break, pace, after-hours, session, usage) as push too (wellbeing-push.ts). */
  wellbeingPush: boolean;
  /** Micro-break prompt after this many minutes of continuous activity of your own (15-240; at most once per 2 h, 4 a day). */
  microBreakMin: number;
}

/** The defaults; `tz` here is a placeholder: the live default is the dashboard's zone (wbDefaults). */
export const WB_DEFAULTS: Readonly<WbSettings> = Object.freeze({
  tz: "UTC",
  quietStart: "23:00",
  quietEnd: "07:00",
  weekendsQuiet: false,
  digestMin: 30,
  nudges: true,
  groupWaitSec: 30,
  summaryTimes: ["08:00", "18:00"],
  windDown: "23:00",
  morning: "07:00",
  approvalBatchMin: 0,
  lightYellow: LIGHT_DEFAULTS.yellow,
  lightRed: LIGHT_DEFAULTS.red,
  energyGreen: 50,
  energyYellow: 25,
  afterHoursYellow: 20,
  afterHoursRed: 35,
  restYellow: 6,
  restRed: 4,
  freeBlocks: [],
  keptEnd: "23:00",
  keptRest: 8,
  switchYellow: 4,
  switchRed: 8,
  maxProjects: 4,
  maxActiveHours: 10,
  microBreakMin: 90,
  wellbeingPush: true,
});

/** The defaults in effect: the dashboard's zone (DASHBOARD_TZ) until the user picks one. */
export const wbDefaults = (): WbSettings => ({ ...WB_DEFAULTS, summaryTimes: [...WB_DEFAULTS.summaryTimes], freeBlocks: [], tz: dashboardTz() });

export const GROUP_WAIT_CHOICES = [0, 15, 30, 60] as const;

export const DIGEST_CHOICES = [15, 30, 60, 120] as const;
export const APPROVAL_BATCH_CHOICES = [0, 15, 30] as const;
/** The longest Focus period the page can ask for. */
export const MAX_FOCUS_MS = 4 * 3_600_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length < 1 || tz.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A partial settings object from the page -> the complete validated settings, or the first problem. Unknown keys are refused. */
export function validateSettings(raw: unknown, base: WbSettings = WB_DEFAULTS): { ok: true; value: WbSettings } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "settings must be an object" };
  const known = new Set(Object.keys(WB_DEFAULTS));
  for (const k of Object.keys(raw)) if (!known.has(k)) return { ok: false, error: `unknown setting: ${k.slice(0, 40)}` };
  const v: WbSettings = { ...base };
  if (raw.tz !== undefined) {
    if (!validTimeZone(raw.tz)) return { ok: false, error: "tz must be an IANA time zone such as Europe/London" };
    v.tz = raw.tz;
  }
  if (raw.windDown !== undefined) {
    if (raw.windDown !== "" && (typeof raw.windDown !== "string" || !HHMM.test(raw.windDown))) return { ok: false, error: "windDown must be HH:MM, or empty for off" };
    v.windDown = raw.windDown as string;
  }
  for (const [k, min, max] of [["maxProjects", 1, 30], ["maxActiveHours", 1, 24], ["microBreakMin", 15, 240]] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "number" || !Number.isInteger(raw[k]) || (raw[k] as number) < min || (raw[k] as number) > max) return { ok: false, error: `${k} must be a whole number ${min}-${max}` };
    v[k] = raw[k] as number;
  }
  if (raw.keptRest !== undefined) {
    if (typeof raw.keptRest !== "number" || !Number.isInteger(raw.keptRest) || raw.keptRest < 1 || raw.keptRest > 23) return { ok: false, error: "keptRest must be whole hours 1-23" };
    v.keptRest = raw.keptRest;
  }
  for (const k of ["quietStart", "quietEnd", "morning", "keptEnd"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "string" || !HHMM.test(raw[k] as string)) return { ok: false, error: `${k} must be HH:MM (00:00-23:59)` };
    v[k] = raw[k] as string;
  }
  for (const k of ["weekendsQuiet", "nudges", "wellbeingPush"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "boolean") return { ok: false, error: `${k} must be true or false` };
    v[k] = raw[k] as boolean;
  }
  if (raw.summaryTimes !== undefined) {
    const t = raw.summaryTimes;
    if (!Array.isArray(t) || t.length > 4 || !t.every((x) => typeof x === "string" && HHMM.test(x)) || new Set(t).size !== t.length) {
      return { ok: false, error: "summaryTimes must be up to 4 different HH:MM times" };
    }
    v.summaryTimes = [...(t as string[])].sort();
  }
  if (raw.groupWaitSec !== undefined) {
    if (!(GROUP_WAIT_CHOICES as readonly unknown[]).includes(raw.groupWaitSec)) return { ok: false, error: `groupWaitSec must be one of ${GROUP_WAIT_CHOICES.join(", ")}` };
    v.groupWaitSec = raw.groupWaitSec as number;
  }
  if (raw.lightYellow !== undefined || raw.lightRed !== undefined) {
    const l = validateLight(raw, v);
    if (!l.ok) return { ok: false, error: l.error };
    v.lightYellow = l.yellow;
    v.lightRed = l.red;
  }
  if (raw.energyGreen !== undefined || raw.energyYellow !== undefined) {
    const l = validateLight({ lightYellow: raw.energyYellow ?? v.energyYellow, lightRed: raw.energyGreen ?? v.energyGreen }, { lightYellow: v.energyYellow, lightRed: v.energyGreen });
    if (!l.ok) return { ok: false, error: "energyYellow and energyGreen must be whole numbers 1-99, energyYellow below energyGreen" };
    v.energyYellow = l.yellow;
    v.energyGreen = l.red;
  }
  for (const [lo, hi, max, label] of [["afterHoursYellow", "afterHoursRed", 99, "afterHoursYellow below afterHoursRed, 1-99"], ["restRed", "restYellow", 23, "restRed below restYellow, 1-23"], ["switchYellow", "switchRed", 50, "switchYellow below switchRed, 1-50"]] as const) {
    if (raw[lo] === undefined && raw[hi] === undefined) continue;
    const a = raw[lo] ?? v[lo];
    const b = raw[hi] ?? v[hi];
    const ok = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= max;
    if (!ok(a) || !ok(b) || a >= b) return { ok: false, error: `${lo} / ${hi}: whole numbers, ${label}` };
    v[lo] = a;
    v[hi] = b;
  }
  if (raw.freeBlocks !== undefined) {
    const b = raw.freeBlocks;
    if (!Array.isArray(b) || b.length > 3 || !b.every((x) => typeof x === "string" && BLOCK_RE.test(x) && x.slice(0, 5) !== x.slice(6)) || new Set(b).size !== b.length) {
      return { ok: false, error: "freeBlocks must be up to 3 different HH:MM-HH:MM windows (start and end differ)" };
    }
    v.freeBlocks = [...(b as string[])].sort();
  }
  if (raw.approvalBatchMin !== undefined) {
    if (!(APPROVAL_BATCH_CHOICES as readonly unknown[]).includes(raw.approvalBatchMin)) return { ok: false, error: `approvalBatchMin must be one of ${APPROVAL_BATCH_CHOICES.join(", ")}` };
    v.approvalBatchMin = raw.approvalBatchMin as number;
  }
  if (raw.digestMin !== undefined) {
    if (!(DIGEST_CHOICES as readonly unknown[]).includes(raw.digestMin)) return { ok: false, error: `digestMin must be one of ${DIGEST_CHOICES.join(", ")}` };
    v.digestMin = raw.digestMin as number;
  }
  return { ok: true, value: v };
}

/** Settings validated as pairs (the order matters between them). */
const PAIRED = new Set<string>(["lightYellow", "lightRed", "energyGreen", "energyYellow", "afterHoursYellow", "afterHoursRed", "restYellow", "restRed", "switchYellow", "switchRed"]);

/** Stored settings JSON -> settings (anything unreadable falls back to the defaults, field by field). */
export function parseStoredSettings(json: string | null | undefined): WbSettings {
  if (!json) return wbDefaults();
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: WbSettings = wbDefaults();
    for (const k of Object.keys(WB_DEFAULTS) as Array<keyof WbSettings>) {
      if (PAIRED.has(k)) continue; // pairs: validated together below
      const r = validateSettings({ [k]: raw[k] });
      if (raw[k] !== undefined && r.ok) (out as unknown as Record<string, unknown>)[k] = r.value[k];
    }
    const l = validateLight({ lightYellow: raw.lightYellow, lightRed: raw.lightRed }, out);
    if (l.ok) { out.lightYellow = l.yellow; out.lightRed = l.red; }
    for (const pair of [["energyGreen", "energyYellow"], ["afterHoursYellow", "afterHoursRed"], ["restYellow", "restRed"], ["switchYellow", "switchRed"]] as const) {
      if (raw[pair[0]] === undefined && raw[pair[1]] === undefined) continue;
      const e = validateSettings({ [pair[0]]: raw[pair[0]], [pair[1]]: raw[pair[1]] }, out);
      if (e.ok) { out[pair[0]] = e.value[pair[0]]; out[pair[1]] = e.value[pair[1]]; }
    }
    return out;
  } catch {
    return wbDefaults();
  }
}

// ── local time ───────────────────────────────────────────────────────────────

export interface LocalTime {
  /** `YYYY-MM-DD` in the zone */
  day: string;
  hour: number;
  minute: number;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function localTime(ms: number, tz: string): LocalTime {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "");
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday };
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is this local hour:minute (on this weekday) inside the quiet hours? */
export function isQuietAt(t: Pick<LocalTime, "hour" | "minute" | "weekday">, s: Pick<WbSettings, "quietStart" | "quietEnd" | "weekendsQuiet">): boolean {
  if (s.weekendsQuiet && (t.weekday === 0 || t.weekday === 6)) return true;
  const m = t.hour * 60 + t.minute;
  const a = minutesOf(s.quietStart);
  const b = minutesOf(s.quietEnd);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

export const isQuiet = (now: number, s: WbSettings): boolean => isQuietAt(localTime(now, s.tz), s);

/** Is the whole local hour `h` (0-23) of a day with this weekday quiet? (its first minute decides; used for the timeline shading) */
export const hourIsQuiet = (h: number, weekday: number, s: WbSettings): boolean => isQuietAt({ hour: h, minute: 0, weekday }, s);

// ── tiers and the push policy ────────────────────────────────────────────────

export type Tier = "now" | "batch" | "info";
const NOW_RULES: readonly string[] = ["approval-waiting", "blocked", "host-offline", "usage-limit"];
const BATCH_RULES: readonly string[] = ["overdue", "agent-stuck", "project-offline", "no-update", "burn-rate"];

/** A CRITICAL agent-stuck (the CLI is gone, a restart failed) is `now`; a non-critical one waits for the digest. */
export function tierOf(rule: string, severity?: string): Tier {
  if (NOW_RULES.includes(rule)) return "now";
  if (rule === "agent-stuck" && severity === "critical") return "now";
  if (BATCH_RULES.includes(rule)) return "batch";
  return "info";
}
/** The rules a digest may carry (SQL list), and the batch ones among them. */
export const SQL_DIGEST_RULES = [...NOW_RULES, ...BATCH_RULES].map((r) => `'${r}'`).join(", ");
export const SQL_BATCH_RULES = BATCH_RULES.map((r) => `'${r}'`).join(", ");

/** One project may get at most one push per this long during quiet hours. */
export const QUIET_PER_PROJECT_MS = 3_600_000;

export interface PolicyInput {
  now: number;
  settings: WbSettings;
  focusUntil: number;
  /** project label ("" = none) -> when it last got a quiet-hours push */
  quietLast: ReadonlyMap<string, number>;
}
export interface PolicyOutput {
  /** push now (the dispatcher merges several into one) */
  send: PushItem[];
  /** do not push; mark as handled, the digest carries it later */
  hold: PushItem[];
  /** never pushed (info tier) */
  drop: PushItem[];
  /** left alone this round, nothing written: an item already held in these quiet hours (an approval's reminder comes
   *  back every 15 min; holding it again would only rewrite summarized_at) */
  skip: PushItem[];
  /** projects that got their one quiet-hours push in this round */
  quietStamped: string[];
  quiet: boolean;
  focus: boolean;
}

/** Decide, for the pushes the rules found due, which go out now. Pure. */
export function applyPushPolicy(items: readonly PushItem[], p: PolicyInput): PolicyOutput {
  const out: PolicyOutput = { send: [], hold: [], drop: [], skip: [], quietStamped: [], quiet: isQuiet(p.now, p.settings), focus: p.now < p.focusUntil };
  const inBlock = blockAt(p.settings, p.now).in;
  const stamped = new Set<string>();
  // oldest first: when a project may only get one push, it is for what has waited longest
  const ordered = [...items].sort((a, b) => a.opened - b.opened || (a.key < b.key ? -1 : 1));
  for (const i of ordered) {
    const tier = tierOf(i.rule, i.severity);
    if (tier === "info") {
      out.drop.push(i);
      continue;
    }
    // an agent-free block: everything waits for the summary at its end (one held already is left alone), except a CRITICAL
    // Time-Sensitive item (host offline, a critical agent-stuck such as cli-gone, usage limit): that one is still pushed
    if (inBlock && !(tier === "now" && i.severity === "critical")) {
      if (i.summarizedAt !== null && i.summarizedAt !== undefined && i.summarizedAt >= (i.lastPushed ?? 0)) out.skip.push(i);
      else out.hold.push(i);
      continue;
    }
    // approval inbox (opt-in): approvals wait for the next batch instead of a push of their own; one already held is left
    // alone (no rewrite every 15 min) until the batch carries it
    if (i.rule === "approval-waiting" && p.settings.approvalBatchMin > 0) {
      if (i.summarizedAt !== null && i.summarizedAt !== undefined && i.summarizedAt >= (i.lastPushed ?? 0)) out.skip.push(i);
      else out.hold.push(i);
      continue;
    }
    if (out.focus) {
      (i.rule === "approval-waiting" ? out.send : out.hold).push(i);
      continue;
    }
    if (tier === "batch") {
      out.hold.push(i);
      continue;
    }
    // group_wait: a new Time-Sensitive alert waits a little for others of the same moment (one storm push then carries them all);
    // nothing is written, it is offered again on the next tick. Reminders never wait.
    if (i.pushCount === 0 && p.now - i.opened < p.settings.groupWaitSec * 1000) {
      out.skip.push(i);
      continue;
    }
    if (out.quiet) {
      // held already (its last mark is a hold, newer than its last push): it waits for the morning digest, untouched
      if (i.summarizedAt !== null && i.summarizedAt !== undefined && i.summarizedAt >= (i.lastPushed ?? 0)) {
        out.skip.push(i);
        continue;
      }
      const proj = i.project ?? "";
      const last = p.quietLast.get(proj) ?? 0;
      if (stamped.has(proj) || p.now - last < QUIET_PER_PROJECT_MS) {
        out.hold.push(i);
        continue;
      }
      stamped.add(proj);
      out.quietStamped.push(proj);
    }
    out.send.push(i);
  }
  return out;
}

/** Several `now` pushes of one tick as ONE message: the oldest first, named; the rest counted. */
export function stormMessage(items: ReadonlyArray<Pick<PushItem, "key" | "rule" | "host" | "project" | "agent" | "opened">>, publicUrl: string): PushMessage {
  const sorted = [...items].sort((a, b) => a.opened - b.opened);
  const first = sorted[0];
  const base = publicUrl.replace(/\/+$/, "");
  const scope = (i: typeof first) => (i?.project ? `${i.project}@${i.host}` : i?.host || "siiswell");
  const words = first ? RULE_WORDS[first.rule as DashboardRule] ?? "needs you" : "needs you";
  return {
    title: `${items.length} things need you`,
    body: `Oldest first: ${scope(first)} ${words}${items.length > 1 ? ` (+${items.length - 1} more)` : ""}`,
    tag: "wb:storm",
    renotify: false,
    url: `${base}/#alert=${encodeURIComponent(first?.key ?? "")}`,
  };
}


// ── digest ───────────────────────────────────────────────────────────────────

export interface DigestRow {
  key: string;
  rule: string;
  host: string | null;
  project: string | null;
  opened: number;
}

/** "5 things in 3 projects: 2 overdue, 2 agent stuck, 1 blocked" (oldest named). `morning` = the first one after quiet hours. */
export function digestMessage(rows: readonly DigestRow[], publicUrl: string, morning: boolean): PushMessage {
  const base = publicUrl.replace(/\/+$/, "");
  const projects = new Set(rows.map((r) => r.project ?? r.host ?? ""));
  const byRule = new Map<string, number>();
  for (const r of rows) byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
  const parts = [...byRule.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([rule, n]) => `${n} ${RULE_WORDS[rule as DashboardRule] ?? rule}`);
  const n = rows.length;
  return {
    title: morning ? "While you were away" : "Scheduled Summary",
    body: `${n} thing${n === 1 ? "" : "s"} in ${projects.size} project${projects.size === 1 ? "" : "s"}: ${parts.join(", ")}`,
    tag: "wb:digest",
    renotify: false,
    url: `${base}/`,
  };
}

/** The latest Scheduled Summary time at or before `now` (UTC ms) within the last 24 h, or null. */
export function lastSummaryTime(s: Pick<WbSettings, "summaryTimes" | "tz">, now: number): number | null {
  const lt = localTime(now, s.tz);
  let best: number | null = null;
  for (const day of [lt.day, new Date(Date.parse(`${lt.day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)]) {
    for (const t of s.summaryTimes) {
      const at = localMinuteStart(day, Number(t.slice(0, 2)), Number(t.slice(3, 5)), s.tz);
      if (at <= now && now - at < 86_400_000 && (best === null || at > best)) best = at;
    }
  }
  return best;
}

/** UTC ms of local `day` `hh:mm` in `tz` (the same offset method as wellbeing-metrics' localHourStart). */
export function localMinuteStart(day: string, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hh, mm);
  const lt = localTime(guess, tz);
  const asUtc = Date.UTC(Number(lt.day.slice(0, 4)), Number(lt.day.slice(5, 7)) - 1, Number(lt.day.slice(8, 10)), lt.hour, lt.minute);
  return guess - (asUtc - guess);
}

/** At most this many alerts per digest (the count says if there were more). */
export const MAX_DIGEST_ROWS = 50;

// ── D1 ───────────────────────────────────────────────────────────────────────

export const isNoTable = (err: unknown): boolean => /no such (table|column)/i.test(err instanceof Error ? err.message : String(err));

export interface WbState {
  settings: WbSettings;
  focusUntil: number;
  quietLast: Map<string, number>;
  lastDigest: number;
  /** when the last Scheduled Summary time was handled */
  lastSummary: number;
  /** the quiet hours were on at the last digest check (the next digest outside them is the morning one) */
  wasQuiet: boolean;
  /** the nights whose wind-down / morning summary went out (wellbeing-winddown.ts) */
  windSent: { wind: string; morning: string };
  /** the local day whose "plan a rest day" suggestion went out */
  intenseSent: string;
  /** an agent-free block was on at the last digest check (its end brings one summary at once) */
  wasBlock: boolean;
}

/**
 * Everything the push policy needs, in ONE query (the settings, the focus end, the policy's bookkeeping); null when
 * migration 0007 is not applied (the policy is then off).
 */
/** Per isolate: the settings row is read at most once a minute by the ticker (a write from the page clears it). */
const settingsCache = new WeakMap<object, { at: number; settings: WbSettings }>();
export const SETTINGS_CACHE_MS = 60_000;
/** The settings alone (the metrics tick): cached per database binding for SETTINGS_CACHE_MS. null = migration missing. */
export async function cachedSettings(db: D1Database, now: number): Promise<WbSettings | null> {
  const hit = settingsCache.get(db as object);
  if (hit && now >= hit.at && now - hit.at < SETTINGS_CACHE_MS) return hit.settings;
  const r = await readSettings(db);
  if (r.pending) return null;
  settingsCache.set(db as object, { at: now, settings: r.settings });
  return r.settings;
}

export async function loadWbState(db: D1Database, now: number = Date.now()): Promise<WbState | null> {
  try {
    const rows = await all<{ k: string; v: string }>(db, "SELECT k, v FROM wb_settings WHERE k IN ('settings', 'focus_until', 'rt:digest', 'rt:summary', 'rt:was_quiet', 'rt:cal', 'rt:wind', 'rt:morning', 'rt:intense', 'rt:was_block') OR k >= 'rt:qh:' AND k < 'rt:qh;' LIMIT 200");
    const m = new Map(rows.map((r) => [r.k, r.v]));
    const quietLast = new Map<string, number>();
    for (const r of rows) if (r.k.startsWith("rt:qh:")) quietLast.set(r.k.slice(6), Number(r.v) || 0);
    return {
      settings: parseStoredSettings(m.get("settings")),
      // Focus from the page, or a busy calendar event that is on now (whichever ends later)
      focusUntil: Math.max(Number(m.get("focus_until")) || 0, calendarFocusUntil(parseCalState(m.get("rt:cal") ?? null).busy, now)),
      quietLast,
      lastDigest: Number(m.get("rt:digest")) || 0,
      lastSummary: Number(m.get("rt:summary")) || 0,
      wasQuiet: m.get("rt:was_quiet") === "1",
      windSent: { wind: m.get("rt:wind") ?? "", morning: m.get("rt:morning") ?? "" },
      intenseSent: m.get("rt:intense") ?? "",
      wasBlock: m.get("rt:was_block") === "1",
    };
  } catch (err) {
    if (isNoTable(err)) return null;
    throw err;
  }
}

const SQL_KV_SET = "INSERT INTO wb_settings (k, v, updated) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated";
export const kvSet = (db: D1Database, k: string, v: string, now: number): D1PreparedStatement => stmt(db, SQL_KV_SET, k, v, now);

/** Quiet-hours stamps older than this are dropped (they no longer limit anything). */
const QUIET_STAMP_TTL_MS = 2 * QUIET_PER_PROJECT_MS;
export function quietStampStatements(db: D1Database, projects: readonly string[], now: number): D1PreparedStatement[] {
  if (!projects.length) return [];
  return [
    ...projects.slice(0, 20).map((p) => kvSet(db, `rt:qh:${p}`, String(now), now)),
    stmt(db, "DELETE FROM wb_settings WHERE k >= 'rt:qh:' AND k < 'rt:qh;' AND updated < ?1", now - QUIET_STAMP_TTL_MS),
  ];
}

/**
 * The digest: at most once per `digestMin`, never during quiet hours or Focus. Reads the open alerts of the digest's rules
 * that were never pushed (or ran out of re-pushes) and are not digested yet; sends ONE push; marks them digested.
 * `send` delivers one message to every subscription and says whether at least one delivery worked. Returns the count.
 * D1: 1 claim + 1 read (+ 1 write when something was sent).
 */
export async function runDigest(
  db: D1Database,
  st: WbState,
  now: number,
  publicUrl: string,
  send: (m: PushMessage) => Promise<boolean>,
): Promise<number> {
  const quiet = isQuiet(now, st.settings);
  // an agent-free block: nothing now; its end brings one summary at once
  if (blockAt(st.settings, now).in) {
    if (!st.wasBlock) await kvSet(db, "rt:was_block", "1", now).run();
    return 0;
  }
  // entering quiet hours is remembered: the first digest after them is the morning one
  if (quiet && !st.wasQuiet) await kvSet(db, "rt:was_quiet", "1", now).run();
  if (quiet || now < st.focusUntil) return 0;
  // due: the interval has passed, or a Scheduled Summary time passed since the last one handled
  const scheduled = lastSummaryTime(st.settings, now);
  const scheduledDue = scheduled !== null && scheduled > st.lastSummary && scheduled > st.lastDigest;
  if (!scheduledDue && !st.wasBlock && now - st.lastDigest < st.settings.digestMin * 60_000) {
    // the approval inbox: earlier than the Scheduled Summary interval ONLY while held approvals wait (one indexed read then);
    // otherwise every other summary keeps its own interval
    const inbox = st.settings.approvalBatchMin;
    if (!(inbox > 0 && now - st.lastDigest >= inbox * 60_000)) return 0;
    const held = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM alerts WHERE resolved IS NULL AND rule = 'approval-waiting' AND wb_digested IS NULL AND summarized_at IS NOT NULL");
    if (!held?.n) return 0;
  }
  if (scheduledDue) await kvSet(db, "rt:summary", String(now), now).run();
  const rows = await all<DigestRow>(
    db,
    `SELECT key, rule, host, project, opened FROM alerts
     WHERE resolved IS NULL AND wb_digested IS NULL AND rule IN (${SQL_DIGEST_RULES}) AND (push_count = 0 OR push_count > ?1)
       -- a Time-Sensitive alert once the policy HELD it, it ran out of re-pushes, or it was never pushed at all past its
       -- group_wait (push failures, no subscription, no VAPID key): only one still inside its group_wait is left out
       AND (rule IN (${SQL_BATCH_RULES}) OR summarized_at IS NOT NULL OR push_count > ?1 OR (push_count = 0 AND opened < ?3))
     ORDER BY opened LIMIT ?2`,
    REPUSH_COOLDOWN_MS.length,
    MAX_DIGEST_ROWS,
    now - st.settings.groupWaitSec * 1000,
  );
  // the interval runs from this check whether or not there was anything to say (one row write per interval at most)
  await kvSet(db, "rt:digest", String(now), now).run();
  if (st.wasBlock) await kvSet(db, "rt:was_block", "0", now).run();
  if (!rows.length) {
    if (st.wasQuiet) await kvSet(db, "rt:was_quiet", "0", now).run();
    return 0;
  }
  const msg = digestMessage(rows, publicUrl, st.wasQuiet);
  const ok = await send(st.wasBlock && !st.wasQuiet ? { ...msg, title: "After your agent-free block" } : msg);
  if (!ok) return 0;
  await stmt(db, "UPDATE alerts SET wb_digested = ?1 WHERE key IN (SELECT value FROM json_each(?2))", now, JSON.stringify(rows.map((r) => r.key))).run();
  if (st.wasQuiet) await kvSet(db, "rt:was_quiet", "0", now).run();
  return rows.length;
}

// ── the page's API (behind the same gate as /api/state; writes are same-origin JSON only) ──────────────────

/** Read the stored settings + Focus (defaults when migration 0007 is missing: `pending`). */
type Dismissal = NudgeState;
export async function readSettings(db: D1Database): Promise<{ settings: WbSettings; focusUntil: number; pending: boolean; dismissed: Map<string, Dismissal>; stressState?: { at: number; value: number } | null; stressYouState?: { at: number; value: number } | null; limitHistory?: LimitHistory; calendar?: { configured: boolean; host?: string; lastFetch?: number | null; ok?: boolean; error?: string; busy?: Array<[number, number]> } }> {
  try {
    const rows = await all<{ k: string; v: string }>(db, "SELECT k, v FROM wb_settings WHERE k IN ('settings', 'focus_until', 'rt:stress', 'rt:stressYou', 'rt:limits', 'cal:url', 'rt:cal') OR (k >= 'nudge:' AND k < 'nudge;') LIMIT 20");
    const m = new Map(rows.map((r) => [r.k, r.v]));
    const dismissed = new Map<string, Dismissal>();
    for (const r of rows) {
      if (!r.k.startsWith("nudge:")) continue;
      try { dismissed.set(r.k.slice(6), JSON.parse(r.v) as Dismissal); } catch { /* ignore a bad row */ }
    }
    const emaState = (k: string): { at: number; value: number } | null => {
      try {
        const st = JSON.parse(m.get(k) ?? "null") as { at?: unknown; value?: unknown } | null;
        return st && typeof st.at === "number" && typeof st.value === "number" ? { at: st.at, value: st.value } : null;
      } catch { return null; } // start again
    };
    const stressState = emaState("rt:stress");
    const stressYouState = emaState("rt:stressYou");
    const url = m.get("cal:url");
    const cal = parseCalState(m.get("rt:cal") ?? null);
    // the feed URL is a secret: only its host goes back to the page
    const calendar = url ? { configured: true, host: maskCalendarUrl(url), lastFetch: cal.at || null, ok: cal.ok, ...(cal.error ? { error: cal.error } : {}), busy: cal.busy } : { configured: false };
    return { settings: parseStoredSettings(m.get("settings")), focusUntil: Number(m.get("focus_until")) || 0, pending: false, dismissed, stressState, stressYouState, limitHistory: parseLimitHistory(m.get("rt:limits") ?? null), calendar };
  } catch (err) {
    if (isNoTable(err)) return { settings: wbDefaults(), focusUntil: 0, pending: true, dismissed: new Map() };
    throw err;
  }
}

function jsonWriteOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json") && (!origin || origin === new URL(req.url).origin);
}

async function bodyOf(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 4096) throw new Error("body too large");
  return JSON.parse(text) as unknown;
}

/**
 * `/api/wellbeing/settings` (POST a partial settings object) and `/api/wellbeing/focus` (POST {minutes}: 1-240 starts or
 * extends Focus from now, 0 ends it). The read (`GET /api/wellbeing`) is `handleWellbeingRead`.
 */
export async function handleWellbeingWrite(req: Request, db: D1Database, path: string, now: number): Promise<Response> {
  if (req.method !== "POST") return errorJson(405, "POST only", { Allow: "POST" });
  if (!jsonWriteOk(req)) return errorJson(400, "expected a same-origin application/json request");
  let body: unknown;
  try {
    body = await bodyOf(req);
  } catch {
    return errorJson(400, "body is not valid JSON (at most 4 KiB)");
  }
  const cur = await readSettings(db);
  if (cur.pending) return errorJson(503, "well-being storage is not set up yet (apply migration 0007)");
  if (path === "/api/wellbeing/settings") {
    const v = validateSettings(body, cur.settings);
    if (!v.ok) return errorJson(400, v.error);
    await kvSet(db, "settings", JSON.stringify(v.value), now).run();
    settingsCache.delete(db as object);
    return json({ ok: true, settings: v.value });
  }
  if (path === "/api/wellbeing/focus") {
    const minutes = isObj(body) ? body.minutes : undefined;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes * 60_000 > MAX_FOCUS_MS) return errorJson(400, `minutes must be a whole number from 0 to ${MAX_FOCUS_MS / 60_000}`);
    const until = minutes === 0 ? 0 : now + minutes * 60_000;
    await kvSet(db, "focus_until", String(until), now).run();
    return json({ ok: true, focusUntil: until });
  }
  if (path === "/api/wellbeing/calendar") {
    // {url: "https://..."} stores the private feed (never shown back); {url: null} removes it and its busy times
    const url = isObj(body) ? body.url : undefined;
    if (url === null) {
      await db.batch([stmt(db, "DELETE FROM wb_settings WHERE k IN ('cal:url', 'rt:cal')")]);
      return json({ ok: true, calendar: { configured: false } });
    }
    const problem = calendarUrlProblem(url);
    if (problem) return errorJson(400, problem);
    await db.batch([kvSet(db, "cal:url", url as string, now), stmt(db, "DELETE FROM wb_settings WHERE k = 'rt:cal'")]);
    return json({ ok: true, calendar: { configured: true, host: maskCalendarUrl(url as string) } });
  }
  if (path === "/api/wellbeing/rating") {
    // one-tap self-rating: ONE value per local day (1 = 😌, 2 = 🙂, 3 = 😬), replaced when tapped again; no text at all
    const value = isObj(body) ? body.value : undefined;
    if (value !== 1 && value !== 2 && value !== 3) return errorJson(400, "value must be 1, 2 or 3");
    const day = localTime(now, cur.settings.tz).day;
    await stmt(db, "INSERT INTO wb_metrics (day, hour, name, value) VALUES (?1, -1, 'rating', ?2) ON CONFLICT(day, hour, name) DO UPDATE SET value = excluded.value", day, value).run();
    return json({ ok: true, day, value });
  }
  if (path === "/api/wellbeing/nudge") {
    // {id, until: "today" | "never" | "reset" | "shown"}: "not today" hides it for this day and session, "never" for good;
    // "shown" (the page displayed it) counts it against its daily cap and starts its cooldown (NUDGE_LIMITS)
    const id = isObj(body) ? body.id : undefined;
    const until = isObj(body) ? body.until : undefined;
    if (typeof id !== "string" || !NUDGE_IDS.includes(id)) return errorJson(400, `id must be one of ${NUDGE_IDS.join(", ")}`);
    if (until !== "today" && until !== "never" && until !== "reset" && until !== "shown") return errorJson(400, "until must be today, never, reset or shown");
    if (until === "reset") {
      await stmt(db, "DELETE FROM wb_settings WHERE k = ?1", `nudge:${id}`).run();
      return json({ ok: true });
    }
    const scope = isObj(body) && typeof body.scope === "string" && /^[sdhbr]:[0-9T:-]{1,24}$/.test(body.scope) ? body.scope : undefined;
    const day = localTime(now, cur.settings.tz).day;
    const prev = cur.dismissed.get(id) ?? {};
    if (until === "shown") {
      if (!scope || prev.ss === scope) return json({ ok: true }); // already counted
      const sn = prev.sd === day ? (prev.sn ?? 0) + 1 : 1;
      await kvSet(db, `nudge:${id}`, JSON.stringify({ ...prev, sd: day, sn, sl: now, ss: scope }), now).run();
      return json({ ok: true });
    }
    const shown = { ...(prev.sd ? { sd: prev.sd, sn: prev.sn, sl: prev.sl, ss: prev.ss } : {}) };
    await kvSet(db, `nudge:${id}`, JSON.stringify(until === "never" ? { never: true } : { day, ...(scope ? { scope } : {}), ...shown }), now).run();
    return json({ ok: true });
  }
  return errorJson(404, "not found");
}

export const NUDGE_IDS: readonly string[] = ["session", "late", "burn", "weekly", "pace", "intensity", "microbreak", "readiness"];

/** `GET /api/wellbeing`: settings, Focus, whether quiet hours are on now. */
export async function handleWellbeingRead(req: Request, db: D1Database, now: number): Promise<Response> {
  if (req.method !== "GET") return errorJson(405, "GET only", { Allow: "GET" });
  const s = await readSettings(db);
  const numbers = s.pending ? null : await wellbeingNumbers(db, s.settings, now);
  const human = numbers ? await humanHours(db, now - 7 * 86_400_000) : [];
  const hourKey = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString().slice(0, 13);
  const loads = dayLoads(human, s.settings);
  const switches = numbers ? await switchesByHour(db, now - 48 * 3_600_000, s.settings.tz) : new Map<number, number>();
  const battery = numbers ? energy(human, switches, s.settings, now) : null;
  const days7 = numbers ? numbers.trends.slice(-7).map((d) => d.day) : [];
  const intensity = numbers ? highIntensityWeek(loads, days7, await dayDrivers(db, days7), s.settings, approvalsPerDay(human, s.settings)) : { days: [], suggestions: [] };
  const streak = intensityStreak(human, s.settings, now);
  const reflection = numbers ? [...weeklyReflection(numbers.trends.slice(-7), numbers.byProject), ...intensitySentences(intensity)] : [];
  // the serious case (red You days in a row + very short rest + late nights) alone allows stronger wording
  const dailyYou = new Map<string, number>();
  if (numbers) {
    const acc = new Map<string, number[]>();
    for (const r of numbers.metrics) if (r.name === "stressYou") acc.set(r.day, [...(acc.get(r.day) ?? []), r.value]);
    for (const [day, v] of acc) dailyYou.set(day, Math.round(v.reduce((a, b) => a + b, 0) / v.length));
  }
  const serious = numbers ? seriousCase(seriousInputs(dailyYou, human, numbers.today, s.settings.lightRed, s.settings)) : false;
  const nudges = numbers && s.settings.nudges ? dueNudges({ ...numbers, quietNow: isQuiet(now, s.settings), rapidMinutes: rapidMinutes(human, now), hourKey, intenseDays: streak, serious,
    youSessionMin: youIndicators(human, now, s.settings)?.find((i) => i.name === "session")?.value ?? 0, microBreakMin: s.settings.microBreakMin,
    microSlot: new Date(Math.floor(now / 7_200_000) * 7_200_000).toISOString().slice(0, 13), focus: now < s.focusUntil }, reflection, s.dismissed, now) : [];
  const activity = numbers ? await operatorActivity(db, now - 14 * 86_400_000, s.settings.tz) : new Map<number, number>();
  const cov = coverageOf(human, activity); // days before the operator's first data, or without any, are "no data"
  const stress = numbers ? stressAndCharts(s.settings, numbers, s.stressState ?? null, now, { hours: human, prev: s.stressYouState ?? null, activity }) : null;
  const limitForecasts = numbers ? forecasts(s.limitHistory ?? {}, await limitWindows(db, now), now, s.settings.tz) : [];
  const { dismissed: _d, stressState: _s, stressYouState: _y, limitHistory: _l, calendar, ...shown } = s;
  const calFocus = calendar?.busy ? calendarFocusUntil(calendar.busy, now) : 0;
  const calendarOut = calendar?.configured ? { ...calendar, busy: undefined, focusUntil: calFocus || null } : { configured: false };
  const { metrics: _m, normRows: _n, ...nums } = numbers ?? ({} as Partial<typeof numbers & object>);
  return json({ now, ...shown, quietNow: isQuiet(now, s.settings), away: awayWindow(s.settings, now), block: blockAt(s.settings, now), intensity, rest: numbers && human.length ? { ...restBlock(human, days7, s.settings, now, cov), kept: keptDays(human, s.settings, now, cov) } : null, readiness: numbers ? readiness(human, dailyYou, s.settings, now, cov) : null, switches: numbers ? switchSummary(switches, s.settings, now) : null,
    ratings: numbers ? Object.fromEntries(numbers.metrics.filter((r) => r.name === "rating" && r.hour === -1).map((r) => [r.day, r.value])) : {},
    target: numbers ? { projects: await projectsToday(db, numbers.today), maxProjects: s.settings.maxProjects, activeHours: loads.get(numbers.today)?.activeHours ?? 0, maxActiveHours: s.settings.maxActiveHours } : null, energy: battery && human.length ? { level: battery.level, day: energyDay(battery.series, s.settings, now), note: "An estimate from your input and rest, not a physiological measure." } : null, focus: now < Math.max(s.focusUntil, calFocus), calendarFocus: calFocus > now, calendar: calendarOut, digestRules: { now: NOW_RULES, batch: BATCH_RULES }, thresholds: THRESHOLDS, ...nums, nudges, ...(stress ? { stress } : {}), limitForecasts });
}

/**
 * Store one stress reading: the EMA state and the hour's rows (`stress` and the eight `n:<indicator>`; the LAST reading of
 * an hour wins) in ONE batch of two statements. Never throws.
 */
export async function storeStressReading(db: D1Database, rows: readonly MetricRow[], value: number, now: number, extra: D1PreparedStatement[] = []): Promise<void> {
  try {
    await db.batch([
      ...extra,
      kvSet(db, "rt:stress", JSON.stringify({ at: now, value }), now),
      stmt(db, `INSERT INTO wb_metrics (day, hour, name, value)
        SELECT json_extract(j.value, '$.day'), json_extract(j.value, '$.hour'), json_extract(j.value, '$.name'), json_extract(j.value, '$.value') FROM json_each(?1) j WHERE true
        ON CONFLICT(day, hour, name) DO UPDATE SET value = excluded.value`, JSON.stringify(rows)),
    ]);
  } catch (err) {
    if (!isNoTable(err)) console.error("stress store failed:", err instanceof Error ? err.message : String(err));
  }
}

/** The stress rows of one reading (`stress` + `n:<indicator>`) for the local hour of `now`. */
export function stressRows(s: WbSettings, now: number, value: number, contributions: ReadonlyArray<{ name: string; normalised: number }>): MetricRow[] {
  const lt = localTime(now, s.tz);
  return [{ day: lt.day, hour: lt.hour, name: "stress", value }, ...contributions.map((c) => ({ day: lt.day, hour: lt.hour, name: `n:${c.name}`, value: c.normalised }))];
}

/**
 * The ticker's stress sample: at minute 7 of every quarter hour (UTC minute % 15), or at minute 8 when the sample of minute
 * 7 is missing (that invocation ran the purge, see maintenance.ts). D1: the settings (cached per isolate), ONE read of every
 * input (SQL_STRESS_INPUTS) and ONE batch of two writes. So the history does not depend on the page being open. Never throws.
 */
export async function recordStressIfDue(db: D1Database, now: number): Promise<boolean> {
  const m = stressTickMinute(now);
  if (m !== STRESS_TICK_MINUTE && m !== STRESS_TICK_MINUTE + 1) return false;
  try {
    const s = await cachedSettings(db, now);
    if (!s) return false;
    const row = await readStressInputs(db, s, now);
    if (!row) return false;
    let prev: { at: number; value: number } | null = null;
    try {
      const p = JSON.parse(row.ema ?? "null") as { at?: unknown; value?: unknown } | null;
      if (p && typeof p.at === "number" && typeof p.value === "number") prev = { at: p.at, value: p.value };
    } catch { /* start again */ }
    if (m === STRESS_TICK_MINUTE + 1 && prev && now - prev.at < 10 * 60_000) return false; // minute 7 got its sample
    const windows = await limitWindows(db, now);
    const lim = windows.length ? Math.round(Math.max(...windows.map((w) => w.pct))) : null;
    const raw = stressRaw(indicatorsFromRow(row, s, now, lim));
    const value = Math.round(emaStep(prev, raw.level, now) * 10) / 10;
    // the "You" line: the operator's own input (human_hourly), smoothed against its own EMA state
    const youEst = youEstimate(sumHours(humanRowsOf(row)), activityOf(row, s.tz), now, s);
    let youValue: number | null = null;
    if (youEst) {
      let prevYou: { at: number; value: number } | null = null;
      try {
        const p = JSON.parse(row.emaYou ?? "null") as { at?: unknown; value?: unknown } | null;
        if (p && typeof p.at === "number" && typeof p.value === "number") prevYou = { at: p.at, value: p.value };
      } catch { /* start again */ }
      youValue = Math.round(emaStep(prevYou, youEst.raw.level, now) * 10) / 10;
    }
    // the plan-limit history for the forecast rides in the same batch (no extra subrequest)
    const extra = windows.length ? [kvSet(db, "rt:limits", JSON.stringify(appendSamples(parseLimitHistory(row.limits ?? null), windows, now)), now)] : [];
    const rows = stressRows(s, now, value, raw.contributions);
    if (youValue !== null) {
      extra.push(kvSet(db, "rt:stressYou", JSON.stringify({ at: now, value: youValue }), now));
      rows.push({ ...rows[0]!, name: "stressYou", value: youValue });
    }
    await storeStressReading(db, rows, value, now, extra);
    return true;
  } catch (err) {
    if (!isNoTable(err)) console.error("stress sample failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * The stress level (estimated) and the chart data. READ-ONLY: the live value is computed from the numbers already read and
 * smoothed against the ticker's stored EMA state; it is shown (the current hour of the charts uses it) but never stored.
 * Only the ticker (recordStressIfDue) writes readings.
 */
function stressAndCharts(s: WbSettings, n: WellbeingNumbers, prev: { at: number; value: number } | null, now: number, human: { hours: HumanHourSum[]; prev: { at: number; value: number } | null; activity: ReadonlyMap<number, number> }) {
  const raw = stressRaw(n.indicators);
  // the gauge moves at most every 15 minutes: the ticker's stored reading while it is fresh, else the live estimate
  const value = shownLevel(prev, raw.level, now);
  const norm = new Map(raw.contributions.map((c) => [c.name, c.normalised]));
  const current = stressRows(s, now, value, raw.contributions);
  const key = (r: MetricRow) => `${r.day}|${r.hour}|${r.name}`;
  const merge = (rows: readonly MetricRow[], add: readonly MetricRow[]) => [...rows.filter((r) => !add.some((a) => key(a) === key(r))), ...add];
  const metrics = merge(n.metrics, current.filter((r) => r.name === "stress"));
  const normRows = merge(n.normRows, current.filter((r) => r.name.startsWith("n:")));
  const days30 = n.trends.map((d) => d.day);
  const days7 = days30.slice(-7);
  const lt = localTime(now, s.tz);
  const last24 = lastLocalHours(lt.day, lt.hour, 24); // calendar hours: a DST day neither repeats nor skips a cell
  const band = bandOf(value); // bandOf rounds: the band of the number shown
  const you = youLine(s, human.hours, human.prev, now, n.metrics, n.today, human.activity);
  return {
    // the headline is "You" (the operator's own load) when the hooks report it; "Agents" is everything below
    headline: you ? "you" : "agents",
    you,
    level: Math.round(value),
    raw: Math.round(raw.level),
    band: band.key,
    label: band.label,
    emoji: band.emoji,
    title: "Stress (workload estimate)",
    note: "Calculated from your AI workload signals — not a medical measure.",
    weights: STRESS_WEIGHTS,
    top: raw.contributions.filter((c) => c.points > 0).slice(0, 3),
    contributions: raw.contributions,
    radar: radarSeries(norm, normRows.filter((r) => days7.includes(r.day))),
    day: dayStress(metrics, n.today),
    trend: stressTrend(metrics, days30),
    sparklines: sparklines(normRows, last24),
    weekHour: weekHourStress(metrics),
    week: weekCard(metrics.filter((r) => days7.includes(r.day)), days7, n.trends.slice(-7)),
  };
}

/** Per local day of `days`: the busiest projects and apps by requests (usage_hourly; ONE bounded read). Never throws. */
/**
 * Context switches per UTC hour from `since`: the distinct (project, app) pairs of the usage that hour, minus one (one pair =
 * no switch). The usage hours are host-local labels; they are read in the dashboard's zone. ONE bounded read; never throws.
 */
export async function switchesByHour(db: D1Database, since: number, tz: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const lt = localTime(since, tz);
    const rows = await all<{ hour: string; n: number }>(
      db,
      "SELECT hour, COUNT(*) AS n FROM (SELECT DISTINCT hour, project, agent FROM usage_hourly WHERE hour >= ?1 AND requests > 0) GROUP BY hour ORDER BY hour LIMIT 400",
      `${lt.day}T${String(lt.hour).padStart(2, "0")}`,
    );
    for (const r of rows) out.set(localHourStart(r.hour.slice(0, 10), Number(r.hour.slice(11, 13)), tz), Math.max(0, r.n - 1));
  } catch { /* no usage table: no switches */ }
  return out;
}

/** Today's distinct projects of the usage (labels as uploaded; `(other)` counts once). ONE read; never throws. */
export async function projectsToday(db: D1Database, today: string): Promise<number> {
  try {
    return (await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM (SELECT DISTINCT project FROM usage_hourly WHERE hour >= ?1 AND hour < ?2 AND requests > 0 LIMIT 200)", `${today}T00`, `${today}T99`))?.n ?? 0;
  } catch {
    return 0;
  }
}

/** The operator apps' requests per UTC hour from `since` (usage_hourly, OPERATOR_APPS; ONE bounded read). Never throws. */
export async function operatorActivity(db: D1Database, since: number, tz: string): Promise<Map<number, number>> {
  try {
    const lt = localTime(since, tz);
    const rows = await all<{ hour: string; r: number; tz: string }>(db, SQL_ACTIVITY_BY_TZ, `${lt.day}T${String(lt.hour).padStart(2, "0")}`);
    return activityOf({ activity: rows.map((r) => `${r.hour}=${r.r}=${r.tz}`).join(",") }, tz);
  } catch {
    return new Map();
  }
}

export async function dayDrivers(db: D1Database, days: readonly string[]): Promise<Map<string, { projects: string[]; apps: string[] }>> {
  const out = new Map<string, { projects: string[]; apps: string[] }>();
  if (!days.length) return out;
  try {
    const rows = await all<{ d: string; project: string; agent: string; r: number }>(
      db,
      `SELECT substr(hour, 1, 10) AS d, project, agent, SUM(requests) AS r FROM usage_hourly WHERE hour >= ?1 AND hour < ?2
       GROUP BY d, project, agent ORDER BY r DESC LIMIT 500`,
      `${days[0]}T00`, `${days[days.length - 1]}T99`,
    );
    const acc = new Map<string, { p: Map<string, number>; a: Map<string, number> }>();
    for (const r of rows) {
      const x = acc.get(r.d) ?? { p: new Map(), a: new Map() };
      x.p.set(r.project, (x.p.get(r.project) ?? 0) + r.r);
      x.a.set(r.agent, (x.a.get(r.agent) ?? 0) + r.r);
      acc.set(r.d, x);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((k) => k && k !== "(other)").slice(0, 2);
    for (const [d, x] of acc) out.set(d, { projects: top(x.p), apps: top(x.a) });
  } catch { /* no usage table yet: no drivers */ }
  return out;
}

/** Average approvals per day over the local days (last 7) that had any operator input; 0 without. */
export function approvalsPerDay(hours: readonly HumanHourSum[], s: Pick<WbSettings, "tz">): number {
  const days = new Map<string, number>();
  for (const h of hours) {
    if (h.prompts + h.approvals <= 0) continue;
    const d = localTime(h.h, s.tz).day;
    days.set(d, (days.get(d) ?? 0) + h.approvals);
  }
  return days.size ? Math.round([...days.values()].reduce((a, b) => a + b, 0) / days.size) : 0;
}

/** A stored reading counts as fresh this long (the ticker samples every 15 minutes, with a catch-up minute). */
export const SHOWN_READING_MAX_AGE_MS = 20 * 60_000;
/** What the gauge shows: the stored (15-minute) reading while fresh, else the live estimate smoothed against it. */
export function shownLevel(prev: { at: number; value: number } | null, raw: number, now: number): number {
  if (prev && now - prev.at >= 0 && now - prev.at <= SHOWN_READING_MAX_AGE_MS) return prev.value;
  return Math.round(emaStep(prev, raw, now) * 10) / 10;
}

/** The "You" line for the page: the live (smoothed, not stored) level, its reasons and today's hours; null without data. */
function youLine(s: WbSettings, hours: HumanHourSum[], prev: { at: number; value: number } | null, now: number, metrics: readonly MetricRow[], today: string, activity: ReadonlyMap<number, number>) {
  const est = youEstimate(hours, activity, now, s);
  if (!est) return null;
  const { ind, raw } = est;
  const value = shownLevel(prev, raw.level, now);
  const band = bandOf(value);
  const lt = localTime(now, s.tz);
  const stored = new Map(metrics.filter((r) => r.day === today && r.name === "stressYou").map((r) => [r.hour, Math.round(r.value)]));
  stored.set(lt.hour, Math.round(value));
  return {
    level: Math.round(value), raw: Math.round(raw.level), band: band.key, label: band.label, emoji: band.emoji,
    title: "Stress (workload estimate) · You",
    note: est.partial
      ? "Partial data: some of your apps have no hook, so this also estimates from their activity; agents working on their own do not count here."
      : "From your own input (prompts, approvals, response times) and your apps' activity; agents working on their own do not count here.",
    partial: est.partial,
    coverage: est.coverage === null ? null : Math.round(est.coverage * 100),
    weights: YOU_WEIGHTS,
    indicators: ind,
    top: raw.contributions.filter((c) => c.points > 0).slice(0, 3),
    contributions: raw.contributions,
    day: Array.from({ length: 24 }, (_, h) => ({ hour: h, stress: stored.get(h) ?? null })),
    // approvals per day over the days with input in the last 7 (the page suggests `siiswell permissions suggest` when high)
    approvalsPerDay: approvalsPerDay(hours, s),
  };
}

/** Stored `rt:limits` -> the history (anything unreadable starts again). */
export function parseLimitHistory(json: string | null): LimitHistory {
  try {
    const o = JSON.parse(json ?? "{}") as unknown;
    const out = newHistory();
    if (!isObj(o)) return out;
    for (const [k, v] of Object.entries(o)) {
      if (!safeLabel(k) || !Array.isArray(v)) continue;
      out[k] = v.filter((x): x is [number, number] => Array.isArray(x) && x.length === 2 && typeof x[0] === "number" && typeof x[1] === "number").slice(-16);
    }
    return out;
  } catch {
    return newHistory();
  }
}

// ── Calendar Focus (wellbeing-calendar.ts) ───────────────────────────────────

export interface CalState { at: number; ok: boolean; error?: string; busy: Array<[number, number]> }
export function parseCalState(json: string | null): CalState {
  try {
    const o = JSON.parse(json ?? "null") as Partial<CalState> | null;
    if (!o || typeof o.at !== "number") return { at: 0, ok: false, busy: [] };
    const busy = Array.isArray(o.busy) ? o.busy.filter((x): x is [number, number] => Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "number").slice(0, 50) : [];
    return { at: o.at, ok: o.ok === true, ...(typeof o.error === "string" ? { error: calendarError(new Error(o.error)) } : {}), busy };
  } catch {
    return { at: 0, ok: false, busy: [] };
  }
}

/**
 * At minute CAL_TICK_MINUTE of each quarter hour: fetch the private calendar (if one is set) and keep its busy intervals of the
 * next 24 hours. D1: 1 read + 1 write; 1 fetch subrequest (at most 3 more for redirects). Never throws.
 */
export async function refreshCalendarIfDue(db: D1Database, now: number, fetchImpl: (url: string, init: RequestInit) => Promise<Response>): Promise<boolean> {
  const minute = Math.floor(now / 60_000) % 15;
  if (minute !== CAL_TICK_MINUTE && minute !== CAL_TICK_MINUTE + 1) return false;
  try {
    const rows = await all<{ k: string; v: string }>(db, "SELECT k, v FROM wb_settings WHERE k IN ('cal:url', 'settings', 'rt:cal')");
    const m = new Map(rows.map((r) => [r.k, r.v]));
    const url = m.get("cal:url");
    if (!url) return false;
    // minute 12 is only the catch-up when minute 11 shared its invocation with the purge
    if (minute === CAL_TICK_MINUTE + 1 && now - parseCalState(m.get("rt:cal") ?? null).at < 10 * 60_000) return false;
    const tz = parseStoredSettings(m.get("settings")).tz;
    let state: CalState;
    try {
      const ics = await fetchCalendar(url, fetchImpl);
      let busy: Array<[number, number]>;
      try { busy = busyIntervals(ics, now, now + CAL_WINDOW_MS, tz); } catch { throw new Error(CAL_ERR.parse); }
      state = { at: now, ok: true, busy };
    } catch (err) {
      // keep what was known (still valid for the next hours); say why the refresh failed (no URL in the message)
      const prev = parseCalState(m.get("rt:cal") ?? null);
      state = { at: now, ok: false, error: calendarError(err), busy: prev.busy.filter(([, e]) => e > now) };
    }
    await kvSet(db, "rt:cal", JSON.stringify(state), now).run();
    return true;
  } catch (err) {
    if (!isNoTable(err)) console.error("calendar refresh failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
