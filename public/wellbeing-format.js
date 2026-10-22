// Pure helpers of the "You" card (public/wellbeing.js): the overall state, its reasons, the plan-limit indicator from the
// page's own state, the trend rows and the weekly reflection sentences. Rule-based only (thresholds and sentence templates):
// nothing here calls an AI. Plain ES module; the tests import it too.

import { heatLevel, heatThresholds, isNum } from "./format.js";

export const STATE_LABELS = ["Calm", "Busy", "Heavy"];

/** 0 calm, 1 busy, 2 overloaded for a value against [busy, overloaded] thresholds; null / unknown = calm. */
export function levelFor(v, t) {
  if (!isNum(v) || !Array.isArray(t)) return 0;
  return v >= t[1] ? 2 : v >= t[0] ? 1 : 0;
}

/** The highest plan-limit use (5 h / weekly %) any agent reports in /api/state; null when none reports one. */
export function limitFromState(state) {
  let max = null;
  for (const p of (state && Array.isArray(state.projects) ? state.projects : [])) {
    for (const a of Array.isArray(p.agents) ? p.agents : []) {
      for (const u of Array.isArray(a.usage) ? a.usage : []) if (isNum(u.usedPercent)) max = Math.max(max ?? 0, u.usedPercent);
    }
  }
  return max;
}

/**
 * The overall state = the worst indicator; `reasons` = the indicators that are not calm, worst first, as their texts
 * ("Waiting for you 5 · Off-hours today 2h"). Every state says why; a calm one says so plainly.
 */
export function overall(indicators) {
  const list = (Array.isArray(indicators) ? indicators : []).filter((i) => i && isNum(i.level));
  const level = list.reduce((m, i) => Math.max(m, i.level), 0);
  const reasons = list.filter((i) => i.level > 0).sort((a, b) => b.level - a.level).map((i) => i.text);
  return { level, label: STATE_LABELS[level], reasons, why: reasons.length ? reasons.join(" · ") : "Nothing is pressing right now" };
}

/** The page's limit indicator, in the server's indicator shape. */
export function limitIndicator(pct, thresholds) {
  const t = thresholds && thresholds.limit;
  return { name: "limit", value: pct, level: levelFor(pct, t), text: pct === null || !isNum(pct) ? "Plan limit —" : `Plan limit ${Math.round(pct)}%` };
}

export const TREND_ROWS = [
  ["activeHours", "Active hours", (v) => `${v}h`],
  ["offHours", "Off-hours", (v) => `${v}h`],
  ["longestRest", "Longest rest", (v) => `${v}h`],
  ["avgWaiting", "Avg waiting", (v) => String(v)],
];

/**
 * Trend rows for the last `n` days (oldest first): per row the cells with a heat level (quartiles of the row's non-zero
 * values, like the usage calendar) and the row's average. Longest rest is shaded the other way round (a short rest is the
 * strong colour), so "more colour" always means "more load".
 */
export function trendRows(trends, n) {
  const days = (Array.isArray(trends) ? trends : []).slice(-n);
  return TREND_ROWS.map(([key, label, fmt]) => {
    const vals = days.map((d) => (isNum(d[key]) ? d[key] : null));
    const load = key === "longestRest" ? vals.map((v) => (v === null ? null : Math.max(0, 24 - v))) : vals;
    const th = heatThresholds(load.filter(isNum));
    const known = vals.filter(isNum);
    const avg = known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
    return {
      key, label, avg, avgText: avg === null ? "—" : fmt(avg),
      cells: days.map((d, i) => ({ day: d.day, value: vals[i], text: vals[i] === null ? "no data" : fmt(vals[i]), level: load[i] === null ? 0 : heatLevel(load[i], th) })),
    };
  });
}

/** Interrupt count -> 0..4 for the 24-hour timeline (fixed steps: one cell means the same on every day). */
export function interruptLevel(n) {
  if (!isNum(n) || n <= 0) return 0;
  return n <= 1 ? 1 : n <= 3 ? 2 : n <= 8 ? 3 : 4;
}

// ── stress level charts: pure geometry (SVG path / point strings) ────────────

export const STRESS_BANDS = [
  { min: 0, max: 30, key: "relaxed", label: "Relaxed", emoji: "😌" },
  { min: 30, max: 60, key: "steady", label: "Steady", emoji: "🙂" },
  { min: 60, max: 80, key: "strained", label: "Busy", emoji: "😐" },
  { min: 80, max: 100, key: "overloaded", label: "Heavy", emoji: "😮‍💨" },
];
/** The band of a level, judged on the level ROUNDED to the whole number shown (the same rule as the server's bandOf). */
export const bandFor = (level) => STRESS_BANDS.reduce((b, x) => (isNum(level) && Math.round(level) >= x.min ? x : b), STRESS_BANDS[0]);

/** The emoji and plain words of each indicator chip (the emoji is decoration; the words are what a screen reader reads). */
export const INDICATOR_ICONS = {
  concurrency: ["⏳", "waiting"], interrupts: ["🔔", "interrupts"], fanOut: ["🧭", "fan-out"], session: ["⏱️", "session"],
  offHours: ["🌙", "off-hours"], burn: ["🔥", "usage"], limit: ["📊", "limit"], retry: ["🔁", "retry"],
  // the "You" line (your own input)
  pace: ["✍️", "pace"], rapid: ["⚡", "rapid-fire"], response: ["⏲️", "response time"], activity: ["📈", "app activity"],
};
export const INDICATOR_SHORT = { concurrency: "Waiting", interrupts: "Interrupts", fanOut: "Fan-out", session: "Session", offHours: "Off-hours", burn: "Usage", limit: "Limit", retry: "Retry", pace: "Pace", rapid: "Rapid-fire", response: "Response time", activity: "App activity" };

const r2 = (x) => Math.round(x * 100) / 100;

/** A point on the gauge's semicircle: pct 0 = left end, 100 = right end, over the top. */
export function gaugePoint(cx, cy, r, pct) {
  const a = Math.PI * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return [r2(cx + r * Math.cos(a)), r2(cy - r * Math.sin(a))];
}

/** SVG path of the gauge arc from `from` to `to` percent (a band). */
export function gaugeArc(cx, cy, r, from, to) {
  const [x1, y1] = gaugePoint(cx, cy, r, from);
  const [x2, y2] = gaugePoint(cx, cy, r, to);
  return `M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}`;
}

/** Radar polygon points for values 0-100 around (cx, cy), the first axis straight up, clockwise. */
export function radarPoints(values, cx, cy, r) {
  const n = values.length;
  return values.map((v, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const k = (Math.max(0, Math.min(100, isNum(v) ? v : 0)) / 100) * r;
    return `${r2(cx + k * Math.cos(a))},${r2(cy + k * Math.sin(a))}`;
  }).join(" ");
}

/** The outer end of radar axis i of n (for the axis lines and labels). */
export function radarAxis(i, n, cx, cy, r) {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return [r2(cx + r * Math.cos(a)), r2(cy + r * Math.sin(a))];
}

/**
 * A line through the values (0..max) across `w` x `h`, one point per slot centred in it; a null breaks the line.
 * Returns the SVG path ("" when there is nothing to draw).
 */
export function linePath(values, w, h, max = 100) {
  const n = values.length;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (!isNum(v)) { pen = false; return; }
    const x = r2(((i + 0.5) / n) * w);
    const y = r2(h - (Math.max(0, Math.min(max, v)) / max) * h);
    d += `${pen ? "L" : "M"}${x} ${y}`;
    pen = true;
  });
  return d;
}

/** The filled area under the line (each unbroken run closed down to the baseline). */
export function areaPath(values, w, h, max = 100) {
  const n = values.length;
  const runs = [];
  let cur = [];
  values.forEach((v, i) => {
    if (isNum(v)) cur.push([r2(((i + 0.5) / n) * w), r2(h - (Math.max(0, Math.min(max, v)) / max) * h)]);
    else if (cur.length) { runs.push(cur); cur = []; }
  });
  if (cur.length) runs.push(cur);
  return runs.map((run) => `M${run[0][0]} ${h}${run.map(([x, y]) => `L${x} ${y}`).join("")}L${run[run.length - 1][0]} ${h}Z`).join("");
}

/** "Why": the top contributors as words with their points ("Waiting for you +10 · Session +4"). */
export function whyText(top) {
  const list = Array.isArray(top) ? top.filter((c) => c && c.points > 0) : [];
  if (!list.length) return "Nothing adds much right now";
  return list.map((c) => `${INDICATOR_SHORT[c.name] || c.name} +${Math.round(c.points)}`).join(" · ");
}

// ── hero and stat tiles ──────────────────────────────────────────────────────

/** The token family of a stress band (CSS `--wb-<tone>-*`). */
export const BAND_TONE = { relaxed: "calm", steady: "steady", strained: "strained", overloaded: "over" };
/** The status dot / sparkline tone of an indicator level (0 normal, 1 raised, 2 high). */
export const LEVEL_TONE = ["calm", "strained", "over"];
export const LEVEL_WORD = ["normal", "raised", "high"];

export const INDICATOR_LABEL = {
  concurrency: "Waiting for you", interrupts: "Interrupts · 60 min", fanOut: "Projects · 60 min", session: "Session",
  offHours: "Off-hours today", burn: "Usage vs usual", limit: "Plan limit", retry: "Retry loop",
};
/** The "You" line's indicators (your own input). */
export const YOU_LABEL = { pace: "Your replies · 60 min", rapid: "Rapid replies (< 30 s)", response: "Quick answers", session: "Your session", offHours: "Your off-hours today", activity: "Your apps · 60 min vs usual" };
/** The tile order (the radar's too): what asks for you first, then time, then usage. */
export const TILE_ORDER = ["concurrency", "interrupts", "fanOut", "retry", "session", "offHours", "burn", "limit"];

/** A tile's value: `6`, `3h 10m`, `1h`, `2.4×`, `91%`, `—`. */
export function indicatorValue(name, v) {
  if (!isNum(v)) return "—";
  if (name === "session") return v >= 60 ? `${Math.floor(v / 60)}h${v % 60 ? ` ${v % 60}m` : ""}` : `${v}m`;
  if (name === "offHours") return `${v}h`;
  if (name === "burn") return `${Math.round(v * 10) / 10}×`;
  if (name === "limit") return `${Math.round(v)}%`;
  return String(v);
}

/** The three biggest contributions as bars: label, points, and the bar's length against the biggest possible (20 points). */
export function contributorBars(top, maxPoints = 20, you = false) {
  // under half a point rounds to "+0": not worth a bar
  return (Array.isArray(top) ? top : []).filter((c) => c && c.points >= 0.5).slice(0, 3).map((c) => ({
    name: c.name, label: (you ? YOU_LABEL[c.name] : INDICATOR_LABEL[c.name]) || c.name, points: Math.round(c.points), pct: Math.max(4, Math.min(100, (c.points / maxPoints) * 100)),
  }));
}

/** Less than one day of hourly readings (24): the trend / pattern charts show a placeholder instead of near-empty grids. */
export function earlyState(stress) {
  const readings = (stress && Array.isArray(stress.weekHour) ? stress.weekHour : []).reduce((n, c) => n + (isNum(c.n) ? c.n : 0), 0);
  return { early: readings < 24, readings };
}

/** The gauge's geometry (viewBox 0 0 160 100): the arc, the value marker, and the 0 / 50 / 100 ticks (0 and 100 below the arc ends). */
export const GAUGE = { w: 160, h: 100, cx: 80, cy: 78, r: 60 };
export function gaugeLayout(level, segments = null) {
  const { cx, cy, r } = GAUGE;
  const v = isNum(level) ? Math.max(0, Math.min(100, level)) : 0;
  const [top50x, top50y] = gaugePoint(cx, cy, r + 17, 50);
  return {
    track: gaugeArc(cx, cy, r, 0, 100),
    value: v > 0 ? gaugeArc(cx, cy, r, 0, Math.max(1, v)) : null,
    marker: gaugePoint(cx, cy, r, v),
    // the traffic light's segments when given (wellbeing-light.js lightScale), else the four bands
    scale: (segments || STRESS_BANDS.map((b) => ({ key: b.key, tone: null, min: b.min, max: b.max }))).map((b) => ({ key: b.key, tone: b.tone, d: gaugeArc(cx, cy, r + 10, b.min + 0.8, b.max - 0.8) })),
    ticks: [
      { text: "0", x: gaugePoint(cx, cy, r, 0)[0], y: cy + 19 },
      { text: "50", x: top50x, y: top50y },
      { text: "100", x: gaugePoint(cx, cy, r, 100)[0], y: cy + 19 },
    ],
  };
}

/** The band gradient of the stress trend: hard stops at 30 / 60 / 80 (offset % from the bottom, the tone of each band). */
export function bandGradientStops() {
  return [["calm", 0, 30], ["steady", 30, 60], ["strained", 60, 80], ["over", 80, 100]].flatMap(([tone, a, b]) => [{ tone, offset: a }, { tone, offset: b }]);
}

/** A stat tile's tone: no value = "none" (muted, never green), else the level's tone. */
export function tileTone(indicator) {
  if (!indicator || !isNum(indicator.value)) return "none";
  return LEVEL_TONE[indicator.level] || "calm";
}

/**
 * A tile's sparkline path: the hours with a reading, joined (an hour without one is left out rather than breaking the line).
 * Fewer than two readings ("" ) means the tile shows the muted dashed baseline, also when it has a value but no history yet.
 */
export function sparkPath(values, w = 100, h = 18) {
  const pts = (Array.isArray(values) ? values : []).filter(isNum);
  return pts.length >= 2 ? linePath(pts, w, h) : "";
}

/** A rest cell's value: "7h", "–" (no data: not measured, never a full rest) or "·" (the window is still running). */
export const gapCell = (x) => (x.noData ? "–" : x.hours === null ? "·" : `${x.hours}h`);
export const gapWords = (x) => (x.noData ? "no data" : x.hours === null ? "not yet" : `${x.hours} h`);
/** "Mon" for a YYYY-MM-DD day (the day's own calendar, no zone shift). */
export const weekdayShort = (day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T12:00:00Z`).getUTCDay()] ?? "";

