/**
 * @file The stress level (estimated), 0-100, and the data behind the You card's charts. PURE: no I/O, no clock, no AI.
 * @module dashboard-worker/wellbeing-stress
 *
 * Calculated from the AI-workload signals only (the indicators of wellbeing-metrics.ts); it is not a medical measure.
 *  1. Each indicator is normalised: 0 at 0, 50 at its first ("busy") threshold, 100 at its second and above, linear between.
 *  2. The raw level is the weighted mean of those (STRESS_WEIGHTS, the one table to tune); unknown values count as 0.
 *  3. It is smoothed with an exponential moving average by elapsed time: STRESS_TAU_MS = 20 min, so a step change is
 *     ~63 % through after 20 min and ~95 % after an hour. With no prior state (or a stale one), it starts at the raw value.
 *  4. Bands (wording only; the colour is the traffic light, wellbeing-light.ts): 0-29 Relaxed, 30-59 Steady, 60-79 Busy,
 *     80-100 Heavy. "Why" = the three biggest contributions in points.
 */
import { THRESHOLDS, type DayTrend, type Indicator, type MetricRow } from "./wellbeing-metrics";

/** Weights in points out of 100 (they sum to 100). */
export const STRESS_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  concurrency: 20,
  interrupts: 20,
  session: 15,
  offHours: 15,
  fanOut: 10,
  burn: 10,
  retry: 5,
  limit: 5,
});
export const STRESS_INDICATORS: readonly string[] = Object.keys(STRESS_WEIGHTS);

/** 0 at 0, 50 at the busy threshold, 100 at the overloaded threshold and above. */
export function normalise(name: string, v: number | null | undefined): number {
  const t = THRESHOLDS[name];
  if (!t || v === null || v === undefined || !Number.isFinite(v) || v <= 0) return 0;
  const [busy, over] = t;
  if (v >= over) return 100;
  if (v <= busy) return (50 * v) / busy;
  return 50 + (50 * (v - busy)) / (over - busy);
}

export interface Contribution { name: string; normalised: number; points: number }

/** The raw (unsmoothed) level and every indicator's contribution in points (weight x normalised / 100), biggest first. */
export function stressRaw(indicators: ReadonlyArray<Pick<Indicator, "name" | "value">>): { level: number; contributions: Contribution[] } {
  const by = new Map(indicators.map((i) => [i.name, i.value]));
  const total = Object.values(STRESS_WEIGHTS).reduce((a, b) => a + b, 0);
  const contributions = STRESS_INDICATORS.map((name) => {
    const n = normalise(name, by.get(name) ?? null);
    return { name, normalised: Math.round(n), points: Math.round(((STRESS_WEIGHTS[name] as number) * n) / total * 10) / 10 };
  }).sort((a, b) => b.points - a.points || (a.name < b.name ? -1 : 1));
  const level = Math.min(100, contributions.reduce((s, c) => s + c.points, 0));
  return { level: Math.round(level * 10) / 10, contributions };
}

/** EMA time constant: a step change is ~63 % through after 20 min and ~95 % after an hour. */
export const STRESS_TAU_MS = 20 * 60_000;

/** A stored state older than this is not smoothed against: the reading starts again at the raw level. */
export const STRESS_STATE_STALE_MS = 2 * 3_600_000;

/** One EMA step by elapsed time; no previous value, a stale one or a clock that went back starts at the raw level. */
export function emaStep(prev: { at: number; value: number } | null, raw: number, now: number, tau = STRESS_TAU_MS): number {
  if (prev && now === prev.at && Number.isFinite(prev.value)) return prev.value;
  if (!prev || !Number.isFinite(prev.value) || now < prev.at || now - prev.at > STRESS_STATE_STALE_MS) return raw;
  const a = 1 - Math.exp(-(now - prev.at) / tau);
  return Math.min(100, Math.max(0, prev.value + a * (raw - prev.value)));
}

export const BANDS = [
  { min: 0, key: "relaxed", label: "Relaxed", emoji: "😌" },
  { min: 30, key: "steady", label: "Steady", emoji: "🙂" },
  { min: 60, key: "strained", label: "Busy", emoji: "😐" },
  { min: 80, key: "overloaded", label: "Heavy", emoji: "😮‍💨" },
] as const;
/** The band of a level, judged on the level ROUNDED to the whole number the page shows (79.5 shows 80: Heavy). */
export function bandOf(level: number): (typeof BANDS)[number] {
  const shown = Math.round(level);
  let b: (typeof BANDS)[number] = BANDS[0];
  for (const x of BANDS) if (shown >= x.min) b = x;
  return b;
}

// ── chart data ───────────────────────────────────────────────────────────────

const avg = (xs: readonly number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** The value at quantile `q` (0..1) of `xs`, linear between neighbours; null without values. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return Math.round((s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)) * 10) / 10;
}

/**
 * Every indicator now (normalised) against the stored hours of the last 7 days (`n:<name>` rows): their average (`week`) and
 * the usual range (`lo` / `hi`: the middle half, 25th to 75th percentile), null without readings.
 */
export function radarSeries(nowNormalised: ReadonlyMap<string, number>, rows7: readonly MetricRow[]): Array<{ name: string; now: number; week: number | null; lo: number | null; hi: number | null }> {
  return STRESS_INDICATORS.map((name) => {
    const vals = rows7.filter((r) => r.name === `n:${name}`).map((r) => r.value);
    return { name, now: Math.round(nowNormalised.get(name) ?? 0), week: avg(vals), lo: quantile(vals, 0.25), hi: quantile(vals, 0.75) };
  });
}

/** Today's 24 hours: stress (null = no reading that hour) and interrupts. */
export function dayStress(rows: readonly MetricRow[], today: string): Array<{ hour: number; stress: number | null; interrupts: number }> {
  const v = new Map(rows.filter((r) => r.day === today).map((r) => [`${r.hour}|${r.name}`, r.value]));
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, stress: v.has(`${h}|stress`) ? Math.round(v.get(`${h}|stress`) as number) : null, interrupts: v.get(`${h}|interrupts`) ?? 0 }));
}

/** Per day (oldest first): the average of the stored hourly stress readings, rounded once (shown and banded as is); null without one. */
export function stressTrend(rows: readonly MetricRow[], days: readonly string[]): Array<{ day: string; stress: number | null }> {
  return days.map((day) => {
    const a = avg(rows.filter((r) => r.day === day && r.name === "stress").map((r) => r.value));
    return { day, stress: a === null ? null : Math.round(a) };
  });
}

/** Sparklines: the last 24 stored hours of each indicator's normalised value (oldest first; null = no reading). */
export function sparklines(rows: readonly MetricRow[], hours: ReadonlyArray<{ day: string; hour: number }>): Record<string, Array<number | null>> {
  const v = new Map(rows.map((r) => [`${r.day}|${r.hour}|${r.name}`, r.value]));
  const out: Record<string, Array<number | null>> = {};
  for (const name of STRESS_INDICATORS) out[name] = hours.map((h) => v.get(`${h.day}|${h.hour}|n:${name}`) ?? null);
  return out;
}

/** Weekday (0 = Sunday) x hour: the average stress of the stored hours of the last 30 days; cells without data are omitted. */
export function weekHourStress(rows: readonly MetricRow[]): Array<{ w: number; h: number; stress: number; n: number }> {
  const acc = new Map<string, { w: number; h: number; s: number; n: number }>();
  for (const r of rows) {
    if (r.name !== "stress") continue;
    const w = new Date(`${r.day}T12:00:00Z`).getUTCDay();
    const k = `${w}|${r.hour}`;
    const a = acc.get(k) ?? { w, h: r.hour, s: 0, n: 0 };
    a.s += r.value;
    a.n++;
    acc.set(k, a);
  }
  return [...acc.values()].sort((a, b) => a.w - b.w || a.h - b.h).map((a) => ({ w: a.w, h: a.h, stress: Math.round(a.s / a.n), n: a.n }));
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The weekly card: a mood emoji (the band of the week's average stress) and a few key numbers. Pure; null with fewer than
 * 3 days of stress readings.
 */
export function weekCard(rows7: readonly MetricRow[], days7: readonly string[], trends7: readonly DayTrend[]): {
  emoji: string; mood: string; avgStress: number; calmest: string | null; busiest: string | null; busiestHour: string | null; activeHours: number;
} | null {
  const st = stressTrend(rows7, days7).filter((d): d is { day: string; stress: number } => d.stress !== null);
  if (st.length < 3) return null;
  const mean = Math.round(avg(st.map((d) => d.stress)) as number); // rounded once: the number and its band agree
  const calm = st.reduce((a, b) => (b.stress < a.stress ? b : a));
  const busy = st.reduce((a, b) => (b.stress > a.stress ? b : a));
  const byHour = new Map<number, number>();
  for (const r of rows7) if (r.name === "interrupts") byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.value);
  const top = [...byHour.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const wd = (d: string) => WEEKDAY[new Date(`${d}T12:00:00Z`).getUTCDay()] as string;
  const band = bandOf(mean);
  return {
    emoji: band.emoji,
    mood: band.label,
    avgStress: mean,
    calmest: `${wd(calm.day)} ${bandOf(calm.stress).emoji}`,
    busiest: `${wd(busy.day)} ${bandOf(busy.stress).emoji}`,
    busiestHour: top && top[1] > 0 ? `${String(top[0]).padStart(2, "0")}:00` : null,
    activeHours: trends7.reduce((n, d) => n + d.activeHours, 0),
  };
}

/**
 * The last `n` local calendar hours ending with (`day`, `hour`), oldest first: a calendar count, not now - i x 1 h, so a
 * day when the clocks change neither repeats the autumn hour nor skips the spring one in the sparklines / 24 h chart.
 */
export function lastLocalHours(day: string, hour: number, n = 24): Array<{ day: string; hour: number }> {
  const out: Array<{ day: string; hour: number }> = [];
  let d = day;
  let h = hour;
  for (let i = 0; i < n; i++) {
    out.push({ day: d, hour: h });
    h--;
    if (h < 0) {
      h = 23;
      d = new Date(Date.parse(`${d}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    }
  }
  return out.reverse();
}
