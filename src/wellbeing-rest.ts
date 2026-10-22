/**
 * @file Rest measures from the operator's own input (human_hourly). PURE: no I/O, no AI.
 *  - After-hours ratio (7-day rolling): the share of the operator's active hours that fell in the quiet hours. Yellow above
 *    `afterHoursYellow` %, red above `afterHoursRed` % (Settings; default 20 / 35).
 *  - Longest rest gap per day: the longest run of hours without input in the 24 hours before the day's noon (so the night
 *    before the day counts). Yellow below `restYellow` hours, red below `restRed` (Settings; default 6 / 4).
 *  - Coverage: a day counts only when there is data for it (Coverage). Before the operator's first data, or with no data around
 *    that day, "no input" means "not measured", never "a full rest": such a day is shown as no data and left out of the
 *    longest rest, the kept days and readiness. The after-hours ratio counts active hours only, so a day without data adds nothing.
 */
import type { HumanHourSum } from "./human";
import { isQuietAt, localTime, type WbSettings } from "./wellbeing";
import { localHourStart } from "./wellbeing-metrics";

const HOUR = 3_600_000;
export type Light = "green" | "yellow" | "red";

/** When the operator's data begins and the hours that have any (a human_hourly row or operator-app activity), sorted. */
export interface Coverage { first: number | null; hours: readonly number[] }

/** The coverage of the operator's own input (any human row, even one without prompts) and operator-app activity. Pure. */
export function coverageOf(hours: readonly HumanHourSum[], activity: ReadonlyMap<number, number> = new Map()): Coverage {
  const all = new Set<number>(hours.map((h) => h.h));
  for (const [h, n] of activity) if (n > 0) all.add(h);
  const sorted = [...all].sort((a, b) => a - b);
  return { first: sorted.length ? sorted[0]! : null, hours: sorted };
}

/** Is the stretch from `start` measured: the data began at or before `start`, and some data lies in [lo, hi)? Pure. */
export function covered(c: Coverage, start: number, lo: number, hi: number): boolean {
  if (c.first === null || start < c.first) return false;
  return c.hours.some((h) => h >= lo && h < hi);
}

/** Data around a rest window [noon - 24 h, noon): from its start up to the evening after it (a full rest ends with input). */
const gapCovered = (c: Coverage, noon: number): boolean => covered(c, noon - 24 * HOUR, noon - 24 * HOUR, noon + 12 * HOUR);

export function afterHoursRatio(hours: readonly HumanHourSum[], s: Pick<WbSettings, "tz" | "quietStart" | "quietEnd" | "weekendsQuiet">, now: number): { pct: number | null; active: number; after: number } {
  const since = now - 7 * 24 * HOUR;
  let active = 0;
  let after = 0;
  const seen = new Set<number>();
  for (const h of hours) {
    if (h.h < since || h.h > now || h.prompts + h.approvals <= 0 || seen.has(h.h)) continue;
    seen.add(h.h);
    active++;
    const lt = localTime(h.h, s.tz);
    if (isQuietAt({ hour: lt.hour, minute: 0, weekday: lt.weekday }, s)) after++;
  }
  return { pct: active ? Math.round((after / active) * 100) : null, active, after };
}

/** Above the thresholds = worse (after-hours %). */
export const lightAbove = (v: number | null, yellow: number, red: number): Light | null => (v === null ? null : v > red ? "red" : v > yellow ? "yellow" : "green");
/** Below the thresholds = worse (rest hours). */
export const lightBelow = (v: number | null, yellow: number, red: number): Light | null => (v === null ? null : v < red ? "red" : v < yellow ? "yellow" : "green");

/** The longest rest (hours without input) in the 24 h before local noon of `day`; null when that window is still running. */
export function restGap(hours: readonly HumanHourSum[], day: string, s: Pick<WbSettings, "tz">, now: number): number | null {
  const noon = localHourStart(day, 12, s.tz);
  if (noon > now) return null;
  const busy = new Set(hours.filter((h) => h.prompts + h.approvals > 0).map((h) => h.h));
  let best = 0;
  let run = 0;
  for (let h = noon - 24 * HOUR; h < noon; h += HOUR) {
    run = busy.has(h) ? 0 : run + 1;
    best = Math.max(best, run);
  }
  return best;
}

export const AFTER_HOURS_ACTIONS: Readonly<Record<Light, string>> = Object.freeze({
  green: "Your quiet hours are mostly yours.",
  yellow: "Worth ending one evening early this week.",
  red: "A wind-down time (Settings) lets the agents carry on while you rest.",
});
export const REST_ACTIONS: Readonly<Record<Light, string>> = Object.freeze({
  green: "A good stretch of rest.",
  yellow: "A longer break tonight would help.",
  red: "Short rest lately: an earlier stop tonight would help.",
});

/** The page's rest block: the 7-day after-hours ratio and the rest gaps of `days` (oldest first), each with a light and an action. */
export function restBlock(hours: readonly HumanHourSum[], days: readonly string[], s: Pick<WbSettings, "tz" | "quietStart" | "quietEnd" | "weekendsQuiet" | "afterHoursYellow" | "afterHoursRed" | "restYellow" | "restRed">, now: number, cov: Coverage = coverageOf(hours)) {
  const ah = afterHoursRatio(hours, s, now);
  const ahLight = lightAbove(ah.pct, s.afterHoursYellow, s.afterHoursRed);
  const gaps = days.map((day) => {
    const g = restGap(hours, day, s, now);
    // a finished window without data: not measured (shown as "–"), never a 24 h rest
    if (g !== null && !gapCovered(cov, localHourStart(day, 12, s.tz))) return { day, hours: null, light: null, noData: true };
    return { day, hours: g, light: lightBelow(g, s.restYellow, s.restRed) };
  });
  const last = [...gaps].reverse().find((g) => g.hours !== null) ?? null;
  return {
    afterHours: { ...ah, light: ahLight, action: ahLight ? AFTER_HOURS_ACTIONS[ahLight] : null },
    gaps,
    lastGap: last ? { ...last, action: last.light ? REST_ACTIONS[last.light] : null } : null,
  };
}

/**
 * "Kept days" (count good days, no streaks): of the last 7 completed days, how many ended before `keptEnd` (no input from
 * that time until the next morning time) and how many had a rest of `keptRest` hours or more (restGap). Pure.
 */
export function keptDays(hours: readonly HumanHourSum[], s: Pick<WbSettings, "tz" | "keptEnd" | "keptRest" | "morning">, now: number, cov: Coverage = coverageOf(hours)): { days: number; endedEarly: number; rested: number; end: string; rest: number } {
  const busy = new Set(hours.filter((h) => h.prompts + h.approvals > 0).map((h) => h.h));
  const today = localTime(now, s.tz).day;
  const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  let endedEarly = 0;
  let rested = 0;
  let days = 0;
  for (let n = 1; n <= 7; n++) {
    const d = day(n);
    const next = day(n - 1);
    const from = localHourStart(d, Number(s.keptEnd.slice(0, 2)), s.tz) + Number(s.keptEnd.slice(3, 5)) * 60_000;
    const until = localHourStart(next, Number(s.morning.slice(0, 2)), s.tz);
    if (until > now) continue; // that night is not over yet
    if (!covered(cov, from, from - 12 * HOUR, until + 12 * HOUR)) continue; // not measured: neither kept nor missed
    days++;
    let late = false;
    for (let h = Math.floor(from / HOUR) * HOUR; h < until; h += HOUR) if (busy.has(h) && h + HOUR > from) { late = true; break; }
    if (!late) endedEarly++;
    const g = restGap(hours, next, s, now);
    if (g !== null && g >= s.keptRest && gapCovered(cov, localHourStart(next, 12, s.tz))) rested++;
  }
  return { days, endedEarly, rested, end: s.keptEnd, rest: s.keptRest };
}

export const SWITCH_ACTIONS: Readonly<Record<Light, string>> = Object.freeze({
  green: "Focused hours.",
  yellow: "Worth staying with one project for a while.",
  red: "Many switches: an agent-free block (Settings) gives a calmer stretch.",
});

/** Context switches (distinct project / app pairs - 1, per hour): this hour and today's busiest hour, with a light. Pure. */
export function switchSummary(byHour: ReadonlyMap<number, number>, s: Pick<WbSettings, "tz" | "switchYellow" | "switchRed">, now: number) {
  const cur = Math.floor(now / HOUR) * HOUR;
  const today = localTime(now, s.tz).day;
  let max = 0;
  let maxHour: number | null = null;
  for (const [h, n] of byHour) if (localTime(h, s.tz).day === today && n > max) { max = n; maxHour = localTime(h, s.tz).hour; }
  const nowN = byHour.get(cur) ?? 0;
  const light = nowN >= s.switchRed ? "red" : nowN >= s.switchYellow ? "yellow" : "green";
  return { now: nowN, max, maxHour, light: light as Light, action: SWITCH_ACTIONS[light as Light] };
}
