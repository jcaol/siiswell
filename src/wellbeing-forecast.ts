/**
 * @file Plan-limit forecast: "at this pace the 5 h window fills around 16:40". PURE, rule-based (a least-squares line through
 * the recent samples of one window), no AI. Neutral wording, no countdown.
 * @module dashboard-worker/wellbeing-forecast
 *
 * The ticker keeps a short history per window (`rt:limits` in wb_settings: up to MAX_SAMPLES [time, percent] pairs, the samples
 * of the CURRENT window only: a drop in the percentage means the window reset, and the older samples are dropped). A forecast is
 * shown only when it is believable and soon:
 *  - at least MIN_POINTS samples spanning at least MIN_SPAN_MS, a rising line (slope > 0) that fits (R^2 >= MIN_R2);
 *  - the window would fill before it resets (when the agent reports the reset time) and within the window's own length.
 */
import { localTime } from "./wellbeing";

export type LimitHistory = Record<string, Array<[number, number]>>;

/** A window label from a snapshot is untrusted: a short name that starts with a letter or digit, never an Object prototype key. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,15}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
export const safeLabel = (l: unknown): l is string => typeof l === "string" && LABEL_RE.test(l) && !RESERVED.has(l.toLowerCase());
/** A history object without a prototype (labels are keys). */
export const newHistory = (): LimitHistory => Object.create(null) as LimitHistory;
const own = (h: LimitHistory, k: string): Array<[number, number]> | undefined => (Object.hasOwn(h, k) ? h[k] : undefined);
export const MAX_SAMPLES = 16;
export const MIN_POINTS = 3;
export const MIN_SPAN_MS = 30 * 60_000;
export const MIN_R2 = 0.6;
const HISTORY_MAX_AGE_MS = 8 * 86_400_000;

/** The length of a window from its label (`5h`, `weekly`, `90min`, `<N>h`); null when unknown. */
export function windowLengthMs(label: string): number | null {
  const l = label.trim().toLowerCase();
  if (l === "weekly" || l === "week" || l === "7d") return 7 * 86_400_000;
  if (l === "daily" || l === "day") return 86_400_000;
  const h = /^(\d{1,3})\s*h$/.exec(l);
  if (h) return Number(h[1]) * 3_600_000;
  const m = /^(\d{1,4})\s*min$/.exec(l);
  return m ? Number(m[1]) * 60_000 : null;
}

/** The history with this tick's readings added (a lower percentage than the last sample = a reset: the window starts again). */
export function appendSamples(history: LimitHistory, windows: ReadonlyArray<{ label: string; pct: number }>, now: number): LimitHistory {
  const out = newHistory();
  for (const label of Object.keys(history)) {
    const list = own(history, label);
    if (!safeLabel(label) || !Array.isArray(list)) continue;
    const kept = list.filter(([t, p]) => typeof t === "number" && typeof p === "number" && now - t < HISTORY_MAX_AGE_MS && t <= now);
    if (kept.length) out[label] = kept;
  }
  for (const w of windows) {
    if (!safeLabel(w.label)) continue;
    const list = own(out, w.label) ?? [];
    const last = list[list.length - 1];
    const next: Array<[number, number]> = last && w.pct < last[1] - 0.5 ? [] : list; // reset
    next.push([now, w.pct]);
    out[w.label] = next.slice(-MAX_SAMPLES);
  }
  return out;
}

/** Least squares through (t, p): slope per ms and R^2; null for fewer than two distinct times. */
export function fitLine(points: ReadonlyArray<[number, number]>): { slope: number; intercept: number; r2: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0]![0];
  const xs = points.map(([t]) => t - t0);
  const ys = points.map(([, p]) => p);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    syy += (ys[i]! - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx - slope * t0, r2 };
}

export interface Forecast { label: string; at: number; when: string; text: string; points: number }

/**
 * When the window would reach 100 % at the current pace, or null when that is not believable or not soon (see the file header).
 * `when` is the local time ("16:40", or "Tue 09:10" on another day) in the settings' time zone.
 */
export function forecastFill(label: string, samples: ReadonlyArray<[number, number]>, current: { pct: number; resetsAt: number | null }, now: number, tz: string): Forecast | null {
  if (!safeLabel(label) || !Array.isArray(samples) || samples.length < MIN_POINTS) return null;
  const span = samples[samples.length - 1]![0] - samples[0]![0];
  if (span < MIN_SPAN_MS) return null;
  const fit = fitLine(samples);
  if (!fit || fit.slope <= 0 || fit.r2 < MIN_R2) return null;
  if (current.pct >= 100) return null;
  const at = Math.round(now + (100 - current.pct) / fit.slope);
  if (current.resetsAt !== null && at >= current.resetsAt) return null; // it resets first
  const len = windowLengthMs(label);
  if (len !== null && at - now > len) return null;
  const a = localTime(at, tz);
  const n = localTime(now, tz);
  const hhmm = `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`;
  const when = a.day === n.day ? hhmm : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][a.weekday]} ${hhmm}`;
  const name = /^\d+\s*h$/i.test(label) ? `${label.replace(/\s*h$/i, "")} h` : label;
  return { label, at, when, text: `At this pace the ${name} window fills around ${when}.`, points: samples.length };
}

/** Every window's forecast that passes the guards. */
export function forecasts(history: LimitHistory, windows: ReadonlyArray<{ label: string; pct: number; resetsAt: number | null }>, now: number, tz: string): Forecast[] {
  return windows.filter((w) => safeLabel(w.label)).map((w) => forecastFill(w.label, own(history, w.label) ?? [], w, now, tz)).filter((f): f is Forecast => f !== null);
}
