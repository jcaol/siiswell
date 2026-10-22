/**
 * @file The stress line "You": the operator's OWN load, from the human input the hooks upload (src/human.ts). PURE: no I/O,
 * no clock, no AI. Agent-only work (agents running on their own) does not count here; it is the "Agents" line
 * (wellbeing-stress.ts) as before.
 *
 * Indicators (null = no data):
 *  - pace: the operator's prompts + approvals in the last 60 minutes
 *  - rapid: how many of those came less than 30 s after the previous one
 *  - response: the median time from "waiting for you" to the operator's answer over the last 2 hours, in seconds (FAST
 *    answers mean constant attention: 0 points at >= 180 s, 50 at 60 s, 100 at <= 15 s)
 *  - session: minutes of continuous operator activity (hours with input, back to back, up to now)
 *  - offHours: hours with operator input today inside the quiet hours
 * Each is normalised to 0-100 (0 at 0, 50 at the first threshold, 100 at the second), weighted (YOU_WEIGHTS), summed; the
 * ticker smooths it like the Agents line (EMA, 20 min).
 */
import type { HumanHourSum } from "./human";
import type { Contribution } from "./wellbeing-stress";
import { hourIsQuiet, localTime, type WbSettings } from "./wellbeing";

const HOUR = 3_600_000;

export const YOU_THRESHOLDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  /** the operator apps' requests in the last 60 min, in % of the operator's own 14-day median hour (100 = a usual hour) */
  activity: [100, 200],
  pace: [30, 60],
  rapid: [10, 25],
  session: [180, 300],
  offHours: [1, 2],
});
/** response: seconds at which the indicator is 100 (or faster), 50, and 0 (or slower). */
export const RESPONSE_POINTS = { fast: 15, mid: 60, slow: 180 } as const;
export const YOU_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({ pace: 20, rapid: 15, response: 10, session: 20, offHours: 15, activity: 20 });

export { OPERATOR_APPS } from "./wellbeing-metrics";

const medianOf = (xs: number[]): number | null => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
};

/**
 * The activity proxy for apps without a prompt hook (Claude Desktop, Codex, sessions without the hooks): the operator apps'
 * requests in the last 60 minutes (the previous hour pro rata) in % of the operator's own median active hour over 14 days.
 * null without any such usage. `activity`: UTC hour start -> requests.
 */
export function activityPercent(activity: ReadonlyMap<number, number>, now: number): number | null {
  const med = medianOf([...activity.entries()].filter(([h]) => h >= now - 14 * 24 * HOUR && h <= now).map(([, v]) => v));
  if (med === null) return null;
  const cur = Math.floor(now / HOUR) * HOUR;
  const frac = (now - cur) / HOUR;
  const last60 = (activity.get(cur) ?? 0) + (activity.get(cur - HOUR) ?? 0) * (1 - frac);
  return Math.round((last60 / med) * 100);
}
export const YOU_INDICATORS: readonly string[] = Object.keys(YOU_WEIGHTS);

export interface YouIndicator { name: string; value: number | null }

/** 0..100 for one indicator. */
export function youNormalise(name: string, v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 0;
  if (name === "response") {
    const { fast, mid, slow } = RESPONSE_POINTS;
    if (v <= fast) return 100;
    if (v >= slow) return 0;
    if (v <= mid) return 100 - (50 * (v - fast)) / (mid - fast);
    return 50 - (50 * (v - mid)) / (slow - mid);
  }
  const t = YOU_THRESHOLDS[name];
  if (!t || v <= 0) return 0;
  const [busy, over] = t;
  if (v >= over) return 100;
  if (v <= busy) return (50 * v) / busy;
  return 50 + (50 * (v - busy)) / (over - busy);
}

const weightedMedian = (pairs: Array<[number, number]>): number | null => {
  const xs = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  const total = xs.reduce((n, [, w]) => n + w, 0);
  if (!total) return null;
  let acc = 0;
  for (const [v, w] of xs) {
    acc += w;
    if (acc * 2 >= total) return v;
  }
  return null;
};

/**
 * The indicators at `now` from the summed hourly rows (UTC hour starts). Hourly counts, so "the last 60 minutes" is the current
 * hour plus the part of the previous hour still inside the window (pro rata). All null when there is no operator input in the
 * rows at all (no hooks installed): the You line then says "no data".
 */
export function youIndicators(hours: readonly HumanHourSum[], now: number, s: WbSettings, activity: ReadonlyMap<number, number> = new Map(), proxy = false): YouIndicator[] | null {
  const active = hours.filter((h) => h.prompts + h.approvals > 0);
  const act = activityPercent(activity, now);
  if (!active.length && act === null) return null;
  const by = new Map(hours.map((h) => [h.h, h]));
  const cur = Math.floor(now / HOUR) * HOUR;
  const frac = (now - cur) / HOUR;
  const c = by.get(cur);
  const p = by.get(cur - HOUR);
  const n = (x: HumanHourSum | undefined) => (x ? x.prompts + x.approvals : 0);
  const pace = Math.round(n(c) + n(p) * (1 - frac));
  const rapid = Math.round((c?.rapid ?? 0) + (p?.rapid ?? 0) * (1 - frac));
  const lat = weightedMedian([c, p].filter((x): x is HumanHourSum => !!x && x.latP50 !== null).map((x) => [x.latP50 as number, x.latN]));
  // an active hour: input from the hooks, or (the proxy estimate) the operator apps' usage
  const isActive = (hh: number) => n(by.get(hh)) > 0 || (proxy && (activity.get(hh) ?? 0) > 0);
  // session: back-to-back active hours, ending at the current hour (or the previous one when this hour has none yet)
  let h = isActive(cur) ? cur : isActive(cur - HOUR) && frac < 0.75 ? cur - HOUR : null;
  let run = 0;
  while (h !== null && isActive(h)) { run++; h -= HOUR; }
  const session = run ? Math.round((run - 1) * 60 + (isActive(cur) ? frac * 60 : 60)) : 0;
  const today = localTime(now, s.tz).day;
  let off = 0;
  const activeHours = new Set([...active.map((x) => x.h), ...(proxy ? [...activity.entries()].filter(([, v]) => v > 0).map(([k]) => k) : [])]);
  for (const hh of activeHours) {
    const lt = localTime(hh, s.tz);
    if (lt.day === today && hh <= now && hourIsQuiet(lt.hour, lt.weekday, s)) off++;
  }
  return [
    { name: "pace", value: pace },
    { name: "rapid", value: rapid },
    { name: "response", value: lat === null ? null : Math.round(lat / 1000) },
    { name: "session", value: session },
    { name: "offHours", value: off },
    { name: "activity", value: act },
  ];
}

/** Below this share of the active hours covered by hook data, the You line is "partial" (see youEstimate). */
export const COVERAGE_PARTIAL = 0.5;

/**
 * Of the last 24 hours in which the operator apps were active (usage), the share that also has hook data (prompts /
 * approvals). null when the usage shows no operator activity at all.
 */
export function youCoverage(hours: readonly HumanHourSum[], activity: ReadonlyMap<number, number>, now: number): number | null {
  const human = new Set(hours.filter((h) => h.prompts + h.approvals > 0).map((h) => h.h));
  const used = [...activity.entries()].filter(([h, v]) => v > 0 && h > now - 24 * HOUR && h <= now).map(([h]) => h);
  if (!used.length) return null;
  return used.filter((h) => human.has(h)).length / used.length;
}

/**
 * The You level to show: from the hooks' data, or, when they cover less than half of the hours the apps were active
 * ("partial data"), the higher of that and the proxy estimate (session and late hours from the app usage too), so the line
 * never reads calm while the usage shows heavy work. null without any data.
 */
export function youEstimate(hours: readonly HumanHourSum[], activity: ReadonlyMap<number, number>, now: number, s: WbSettings) {
  const ind = youIndicators(hours, now, s, activity);
  if (!ind) return null;
  const precise = youRaw(ind);
  const coverage = youCoverage(hours, activity, now);
  const partial = coverage !== null && coverage < COVERAGE_PARTIAL;
  if (!partial) return { ind, raw: precise, coverage, partial };
  const pInd = youIndicators(hours, now, s, activity, true)!;
  const proxyRaw = youRaw(pInd);
  return proxyRaw.level > precise.level ? { ind: pInd, raw: proxyRaw, coverage, partial } : { ind, raw: precise, coverage, partial };
}

/** Minutes spent in rapid-fire replies (an answer < 30 s after the previous one) in the last 60 minutes (pro rata). */
export function rapidMinutes(hours: readonly HumanHourSum[], now: number): number {
  const cur = Math.floor(now / HOUR) * HOUR;
  const frac = (now - cur) / HOUR;
  const by = new Map(hours.map((h) => [h.h, h]));
  return Math.round((by.get(cur)?.rapidMin ?? 0) + (by.get(cur - HOUR)?.rapidMin ?? 0) * (1 - frac));
}
/** The pace nudge: at least this many minutes of rapid-fire replies in the last hour. */
export const PACE_NUDGE_MINUTES = 20;

/** The raw You level (0-100) and each indicator's contribution in points, biggest first. */
export function youRaw(indicators: readonly YouIndicator[]): { level: number; contributions: Contribution[] } {
  const by = new Map(indicators.map((i) => [i.name, i.value]));
  const total = Object.values(YOU_WEIGHTS).reduce((a, b) => a + b, 0);
  const contributions = YOU_INDICATORS.map((name) => {
    const nrm = youNormalise(name, by.get(name) ?? null);
    return { name, normalised: Math.round(nrm), points: Math.round(((YOU_WEIGHTS[name] as number) * nrm) / total * 10) / 10 };
  }).sort((a, b) => b.points - a.points || (a.name < b.name ? -1 : 1));
  const level = Math.min(100, contributions.reduce((sum, x) => sum + x.points, 0));
  return { level: Math.round(level * 10) / 10, contributions };
}
