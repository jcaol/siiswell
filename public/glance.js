// Pure helpers of the "at a glance" layer (no DOM): the shared time ranges, the viewer's own preferences (range, pinned
// cards), the usual-range band of an indicator, buckets for long usage ranges, splitting a value into number and unit, and the
// Highlights: fixed sentence templates from rule-based comparisons (no AI). Unit-tested in test/glance.test.ts.

import { fmtTokens, fmtUsd, heatValue, isNum, lastDays } from "./format.js";

// ── time ranges ──────────────────────────────────────────────────────────────

/** The ranges of the shared range control, shortest first. `days` is the span; `bucket` how a chart groups it. */
export const RANGES = Object.freeze([
  { key: "W", label: "W", name: "week", days: 7, bucket: "day" },
  { key: "M", label: "M", name: "month", days: 30, bucket: "day" },
  { key: "6M", label: "6M", name: "6 months", days: 182, bucket: "week" },
  { key: "Y", label: "Y", name: "year", days: 365, bucket: "month" },
]);
export const rangeOf = (key) => RANGES.find((r) => r.key === key) || null;

/** Only the ranges the data can fill: a range is offered when `daysOfData` covers it (no padded or invented days). */
export function rangesFor(daysOfData) {
  const n = isNum(daysOfData) ? daysOfData : 0;
  return RANGES.filter((r) => r.days <= n);
}

// ── the viewer's own preferences (this browser only; storage may be missing or throw) ──

const PREFIX = "siiswell.";

/** A saved preference, or `fallback` when it is missing, not allowed, or storage is unavailable. */
export function loadPref(storage, key, allowed, fallback) {
  try {
    const v = storage ? storage.getItem(PREFIX + key) : null;
    if (v === null || v === undefined) return fallback;
    if (Array.isArray(allowed)) return allowed.includes(v) ? v : fallback;
    return v;
  } catch {
    return fallback;
  }
}

/** Save a preference; false when storage is unavailable (the page works the same, it only forgets). */
export function savePref(storage, key, value) {
  try {
    if (!storage) return false;
    storage.setItem(PREFIX + key, String(value));
    return true;
  } catch {
    return false;
  }
}

/** The pinned card ids (oldest pin first), from a saved JSON list; anything unreadable is an empty list. */
export function parsePins(raw) {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && /^[a-z0-9:-]{1,40}$/.test(x)))].slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** Pin or unpin `id` (a new pin goes last). */
export const togglePin = (pins, id) => (pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id]);

/** Cards in display order: the pinned ones first (in pin order), then the rest in their own order. Unknown pins are ignored. */
export function pinOrder(ids, pins) {
  const known = new Set(ids);
  const first = pins.filter((p) => known.has(p));
  const set = new Set(first);
  return [...first, ...ids.filter((id) => !set.has(id))];
}

// ── the usual range ──────────────────────────────────────────────────────────

/**
 * Where "now" sits against the usual range of an indicator (`lo`..`hi`, the middle half of the last 7 days): below, within or
 * above. Calm words: being above your usual range is information, never a judgement.
 */
export function bandPlace(now, lo, hi) {
  if (!isNum(now) || !isNum(lo) || !isNum(hi)) return { key: "none", text: "no usual range yet" };
  if (now < lo) return { key: "below", text: "below your usual range" };
  if (now > hi) return { key: "above", text: "above your usual range" };
  return { key: "within", text: "within your usual range" };
}

/** Per indicator: now, the 7-day average and the usual range, clamped to 0..100 for drawing; rows without a reading keep nulls. */
export function rangeRows(series) {
  const c = (v) => (isNum(v) ? Math.max(0, Math.min(100, v)) : null);
  return (Array.isArray(series) ? series : []).map((x) => ({
    name: x.name, now: c(x.now), avg: c(x.week), lo: c(x.lo), hi: c(x.hi), place: bandPlace(x.now, x.lo, x.hi),
  }));
}

// ── long usage ranges ────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (day) => `${Number(day.slice(8, 10))} ${MONTH_NAMES[Number(day.slice(5, 7)) - 1]}`;

/**
 * The days of a range ending `today`, grouped as the range says: per day (W, M), per week starting Monday (6M) or per calendar
 * month (Y). `byDay`: Map day -> aggregate ({ usd, tokens, requests, ... }). Each bucket sums what it covers; days without data
 * count as zero (they are real days with nothing reported, not invented values).
 */
export function bucketRange(byDay, today, rangeKey) {
  const r = rangeOf(rangeKey);
  if (!r) return [];
  const days = lastDays(today, r.days);
  const key = (d) => {
    if (r.bucket === "day") return d;
    if (r.bucket === "month") return d.slice(0, 7);
    const t = new Date(`${d}T00:00:00Z`);
    const back = (t.getUTCDay() + 6) % 7; // days since Monday
    return new Date(t.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  };
  const out = new Map();
  for (const d of days) {
    const k = key(d);
    if (!out.has(k)) out.set(k, { key: k, from: d, to: d, usd: 0, tokens: 0, requests: 0, unpricedTokens: 0 });
    const b = out.get(k);
    b.to = d;
    const a = byDay.get(d);
    if (!a) continue;
    b.usd += heatValue(a, "usd");
    b.tokens += heatValue(a, "tokens");
    b.requests += heatValue(a, "requests");
    if (isNum(a.unpricedTokens)) b.unpricedTokens += a.unpricedTokens;
  }
  return [...out.values()].map((b) => ({
    ...b,
    label: r.bucket === "month" ? `${MONTH_NAMES[Number(b.key.slice(5, 7)) - 1]} ${b.key.slice(0, 4)}` : r.bucket === "week" ? `week of ${dayLabel(b.from)}` : dayLabel(b.key),
    tick: r.bucket === "month" ? MONTH_NAMES[Number(b.key.slice(5, 7)) - 1] : dayLabel(b.from),
  }));
}

// ── a value as number + unit ─────────────────────────────────────────────────

/**
 * A formatted value split into parts for the big-number style: digits big, units small (`$1,234` -> [$][1,234], `3h 10m` ->
 * [3][h ][10][m], `12.3M` -> [12.3][M], `91%` -> [91][%]). Each part: { text, unit } (unit = shown small and muted).
 */
export function valueParts(text) {
  const s = String(text ?? "");
  const parts = [];
  for (const m of s.matchAll(/([<>±▲▼]?\s?[0-9][0-9.,]*)|([^0-9]+)/g)) {
    if (m[1]) parts.push({ text: m[1], unit: false });
    else if (m[2]) parts.push({ text: m[2], unit: true });
  }
  return parts.length ? parts : [{ text: s, unit: false }];
}

// ── Highlights ───────────────────────────────────────────────────────────────

const mean = (xs) => {
  const k = xs.filter(isNum);
  return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null;
};
/** "lower" / "higher" / "similar": a change counts from 10 % (relative) and 3 points (absolute), so noise reads as "similar". */
function compare(cur, prev, minAbs = 3) {
  if (!isNum(cur) || !isNum(prev)) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < minAbs || (prev > 0 && Math.abs(diff) / prev < 0.1)) return "similar";
  return diff < 0 ? "lower" : "higher";
}

/**
 * The Highlights cards: one plain sentence each, from fixed templates over data the page already has. Only a card whose data is
 * there is returned (at least 3 known days on each side of a comparison). Every card: { id, cat, title, value, unit, text,
 * spark: [numbers or null], sparkLabel }. Wording is neutral: more or less is information, never praise or blame.
 */
export function highlights({ wb, ins } = {}) {
  const out = [];
  // usage: the last 7 days against the 7 before
  if (ins && Array.isArray(ins.daily) && ins.today) {
    const byDay = new Map(ins.daily.map((d) => [d.day, d]));
    const days = lastDays(ins.today, 14);
    const usd = days.map((d) => (byDay.get(d) && isNum(byDay.get(d).usd) ? byDay.get(d).usd : 0));
    const cur = usd.slice(7).reduce((a, b) => a + b, 0);
    const prev = usd.slice(0, 7).reduce((a, b) => a + b, 0);
    const known = days.slice(0, 7).filter((d) => byDay.has(d)).length >= 3 && days.slice(7).filter((d) => byDay.has(d)).length >= 3;
    if (cur > 0) {
      const c = known ? compare(cur, prev, 0.5) : null;
      const pct = prev > 0 ? Math.round((Math.abs(cur - prev) / prev) * 100) : null;
      const tokens = days.slice(7).reduce((n, d) => n + heatValue(byDay.get(d), "tokens"), 0);
      out.push({
        id: "hl-usage", cat: "usage", title: "Usage", value: fmtUsd(cur), unit: "last 7 days",
        text: c === null ? `${fmtTokens(tokens)} tokens in the last 7 days.`
          : c === "similar" ? "About the same as the 7 days before."
          : `About ${pct}% ${c === "lower" ? "less" : "more"} than the 7 days before.`,
        spark: usd, sparkLabel: "API-equivalent cost per day, last 14 days",
      });
    }
  }
  if (wb && !wb.pending) {
    // workload: this week's average stress against last week's
    const trend = wb.stress && Array.isArray(wb.stress.trend) ? wb.stress.trend.map((x) => x.stress) : [];
    if (trend.filter(isNum).length >= 3) {
      const cur = trend.slice(-7);
      const prev = trend.slice(-14, -7);
      const a = mean(cur);
      const b = prev.filter(isNum).length >= 3 ? mean(prev) : null;
      const c = compare(a, b);
      out.push({
        id: "hl-stress", cat: "you", title: "Workload", value: String(Math.round(a)), unit: "/100 avg this week",
        text: c === null ? "Your weekly average, from the stress estimate." : c === "similar" ? "Similar to the week before." : c === "lower" ? "A lighter week than the one before." : "A busier week than the one before.",
        spark: trend.slice(-14), sparkLabel: "Daily average stress, last 14 days",
      });
    }
    // rest: how many recent days ended before the quiet hours
    const k = wb.rest && wb.rest.kept;
    if (k && k.days >= 3) {
      out.push({
        id: "hl-rest", cat: "rest", title: "Evenings", value: String(k.endedEarly), unit: `of ${k.days} days`,
        text: k.endedEarly === k.days ? `Every day ended before ${k.end}.` : `${k.endedEarly === 1 ? "One day" : `${k.endedEarly} days`} ended before ${k.end}.`,
        spark: null, sparkLabel: "",
      });
    }
    // active hours per day: this week against last week
    const rows = Array.isArray(wb.trends) ? wb.trends : [];
    const act = rows.map((d) => (isNum(d.activeHours) ? d.activeHours : null));
    if (act.slice(-7).filter(isNum).length >= 3) {
      const a = mean(act.slice(-7));
      const b = act.slice(-14, -7).filter(isNum).length >= 3 ? mean(act.slice(-14, -7)) : null;
      const c = compare(a, b, 0.5);
      out.push({
        id: "hl-active", cat: "you", title: "Active hours", value: `${Math.round(a * 10) / 10}h`, unit: "a day this week",
        text: c === null ? "Hours with your own input, per day." : c === "similar" ? "About the same as the week before." : `${c === "lower" ? "Fewer" : "More"} than the week before (${Math.round(b * 10) / 10}h).`,
        spark: act.slice(-14), sparkLabel: "Active hours per day, last 14 days",
      });
    }
  }
  return out;
}
