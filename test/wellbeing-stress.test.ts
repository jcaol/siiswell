/** Stress (workload estimate): normalisation, weights, cap, EMA, bands, contributors, chart data builders, API shape, wording. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "../src/index";
import { THRESHOLDS } from "../src/wellbeing-metrics";
import {
  BANDS, STRESS_TAU_MS, STRESS_WEIGHTS, bandOf, dayStress, emaStep, normalise, quantile, radarSeries, sparklines, stressRaw, stressTrend, weekCard, weekHourStress,
} from "../src/wellbeing-stress";
import { areaPath, bandFor, gaugeArc, gaugePoint, linePath, radarAxis, radarPoints, whyText } from "../public/wellbeing-format.js";
import { makeCtx, makeEnv, request } from "./d1-shim";

const MIN = 60_000;
const NOW = Date.parse("2027-01-15T10:20:00Z");
const ind = (o: Record<string, number | null>) => Object.entries(o).map(([name, value]) => ({ name, value }));

describe("stress formula", () => {
  test("weights: one table, the eight indicators, 100 in all", () => {
    expect(Object.keys(STRESS_WEIGHTS).sort()).toEqual(Object.keys(THRESHOLDS).sort());
    expect(Object.values(STRESS_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(STRESS_WEIGHTS).toMatchObject({ concurrency: 20, interrupts: 20, session: 15, offHours: 15, fanOut: 10, burn: 10, retry: 5, limit: 5 });
  });
  test("normalise: 0 at 0, 50 at the busy threshold, 100 at the red one, linear between, capped", () => {
    expect([0, 1.5, 3, 4, 5, 50].map((v) => normalise("concurrency", v))).toEqual([0, 25, 50, 75, 100, 100]);
    expect([4, 9, 6.5].map((v) => normalise("interrupts", v))).toEqual([50, 100, 75]);
    expect([null, undefined, -3, NaN].map((v) => normalise("burn", v as number))).toEqual([0, 0, 0, 0]);
    expect(normalise("nope", 5)).toBe(0);
  });
  test("raw level = weighted mean; contributions in points, biggest first; everything red = 100 (capped)", () => {
    const r = stressRaw(ind({ concurrency: 5, interrupts: 4, session: 0, offHours: 0, fanOut: 0, burn: null, retry: 0 }));
    expect(r.level).toBe(30); // 20 + 20 x 0.5
    expect(r.contributions.slice(0, 2)).toEqual([{ name: "concurrency", normalised: 100, points: 20 }, { name: "interrupts", normalised: 50, points: 10 }]);
    expect(r.contributions.length).toBe(8);
    const all = stressRaw(ind({ concurrency: 99, interrupts: 99, session: 999, offHours: 9, fanOut: 9, burn: 9, retry: 9, limit: 100 }));
    expect(all.level).toBe(100);
    expect(stressRaw([]).level).toBe(0);
  });
  test("EMA by elapsed time: first reading starts at the raw level; ~63 % after 20 min; clock going back starts again", () => {
    expect(emaStep(null, 80, NOW)).toBe(80);
    expect(emaStep({ at: NOW - STRESS_TAU_MS, value: 0 }, 100, NOW)).toBeCloseTo(63.2, 1);
    expect(emaStep({ at: NOW - 60 * MIN, value: 0 }, 100, NOW)).toBeCloseTo(95, 0);
    expect(emaStep({ at: NOW - MIN, value: 40 }, 40, NOW)).toBe(40);
    expect(emaStep({ at: NOW, value: 40 }, 90, NOW)).toBe(40); // same instant: unchanged
    expect(emaStep({ at: NOW + MIN, value: 40 }, 90, NOW)).toBe(90);
  });
  test("bands: edges 30 / 60 / 80 on the rounded level (29.9 shows 30), emoji per band (server and page agree)", () => {
    expect([0, 29.9, 30, 59, 60, 79, 80, 100].map((l) => bandOf(l).label)).toEqual(["Relaxed", "Steady", "Steady", "Steady", "Busy", "Busy", "Heavy", "Heavy"]);
    expect(BANDS.map((b) => b.emoji)).toEqual(["😌", "🙂", "😐", "😮‍💨"]);
    for (const l of [0, 29, 30, 60, 79, 80, 100]) expect(bandFor(l).label).toBe(bandOf(l).label);
  });
  test("why: the top contributors with their points", () => {
    expect(whyText([{ name: "concurrency", points: 20 }, { name: "session", points: 7.5 }, { name: "retry", points: 0 }])).toBe("Waiting +20 · Session +8");
    expect(whyText([])).toBe("Nothing adds much right now");
  });
});

describe("chart data builders", () => {
  const rows = [
    { day: "2027-01-15", hour: 9, name: "stress", value: 40 },
    { day: "2027-01-15", hour: 9, name: "interrupts", value: 3 },
    { day: "2027-01-15", hour: 10, name: "stress", value: 70 },
    { day: "2027-01-14", hour: 9, name: "stress", value: 20 },
    { day: "2027-01-13", hour: 15, name: "stress", value: 90 },
    { day: "2027-01-12", hour: 15, name: "stress", value: 10 },
    { day: "2027-01-14", hour: 9, name: "n:concurrency", value: 60 },
    { day: "2027-01-15", hour: 9, name: "n:concurrency", value: 40 },
  ];
  test("today's hours, the daily trend, the weekday x hour average", () => {
    const d = dayStress(rows, "2027-01-15");
    expect(d.length).toBe(24);
    expect([d[9], d[10], d[11]]).toEqual([{ hour: 9, stress: 40, interrupts: 3 }, { hour: 10, stress: 70, interrupts: 0 }, { hour: 11, stress: null, interrupts: 0 }]);
    expect(stressTrend(rows, ["2027-01-14", "2027-01-15", "2027-01-16"])).toEqual([{ day: "2027-01-14", stress: 20 }, { day: "2027-01-15", stress: 55 }, { day: "2027-01-16", stress: null }]);
    // 2027-01-13 and 2027-01-12 are a Wednesday and a Tuesday
    expect(weekHourStress(rows).filter((c) => c.h === 15)).toEqual([{ w: 2, h: 15, stress: 10, n: 1 }, { w: 3, h: 15, stress: 90, n: 1 }]);
  });
  test("indicators: now against the 7-day average and usual range (middle half); sparklines: the last hours per indicator", () => {
    const r = radarSeries(new Map([["concurrency", 100]]), rows);
    expect(r.find((x) => x.name === "concurrency")).toEqual({ name: "concurrency", now: 100, week: 50, lo: 45, hi: 55 });
    expect(r.find((x) => x.name === "session")).toEqual({ name: "session", now: 0, week: null, lo: null, hi: null });
    expect([quantile([], 0.5), quantile([10], 0.25), quantile([0, 10, 20, 30], 0.25), quantile([30, 0, 20, 10], 0.75)]).toEqual([null, 10, 7.5, 22.5]);
    expect(r.length).toBe(8);
    expect(sparklines(rows, [{ day: "2027-01-14", hour: 9 }, { day: "2027-01-15", hour: 8 }, { day: "2027-01-15", hour: 9 }]).concurrency).toEqual([60, null, 40]);
  });
  test("week card: mood emoji and key numbers; fewer than 3 days of readings = none", () => {
    const days = ["2027-01-12", "2027-01-13", "2027-01-14", "2027-01-15"];
    const w = weekCard(rows, days, days.map((day) => ({ day, activeHours: 5, offHours: 0, longestRest: 9, avgWaiting: 1, interrupts: 0 })));
    expect(w).toEqual({ emoji: "🙂", mood: "Steady", avgStress: 44, calmest: "Tue 😌", busiest: "Wed 😮‍💨", busiestHour: "09:00", activeHours: 20 });
    expect(weekCard(rows.slice(0, 2), days, [])).toBeNull();
  });
  test("SVG geometry: gauge, radar, line and area paths", () => {
    expect(gaugePoint(60, 60, 50, 0)).toEqual([10, 60]);
    expect(gaugePoint(60, 60, 50, 50)).toEqual([60, 10]);
    expect(gaugePoint(60, 60, 50, 100)).toEqual([110, 60]);
    expect(gaugeArc(60, 60, 50, 0, 100)).toBe("M10 60 A50 50 0 0 1 110 60");
    expect(radarPoints([100, 100, 100, 100], 50, 50, 40)).toBe("50,10 90,50 50,90 10,50");
    expect(radarPoints([0, null, 50, 200], 50, 50, 40)).toBe("50,50 50,50 50,70 10,50");
    expect(radarAxis(0, 8, 50, 50, 40)).toEqual([50, 10]);
    expect(linePath([0, 50, null, 100], 40, 10)).toBe("M5 10L15 5M35 0");
    expect(linePath([null, null], 40, 10)).toBe("");
    expect(areaPath([50, 50, null, 100], 40, 10)).toBe("M5 10L5 5L15 5L15 10ZM35 10L35 0L35 10Z");
  });
});

describe("API: GET /api/wellbeing has the stress block and is read-only", () => {
  test("shape and note; GET performs no writes; the live value is smoothed against the ticker's stored state", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const ins = t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened) VALUES (?, 'blocked', 'warn', 'host', 'h', 'p', 'x', ?)");
    for (let i = 0; i < 5; i++) ins.run(`b${i}`, NOW - (i + 1) * MIN);
    const get = async (now: number) => ((await (await route(request("/api/wellbeing"), t.env, ctx, { now })).json()) as any).stress;
    t.db.recordStatements = true;
    const n0 = t.db.statements.length;
    const s = await get(NOW);
    expect(s).toMatchObject({ title: "Stress (workload estimate)", note: "Calculated from your AI workload signals — not a medical measure.", weights: STRESS_WEIGHTS });
    expect(s.level).toBe(Math.round(s.raw)); // no stored state yet: the live value is the raw one
    expect(s.top.map((c: any) => c.name)).toEqual(["concurrency", "interrupts"]);
    expect(s.label).toBe(bandOf(s.level).label);
    expect(s.emoji).toBe(bandOf(s.level).emoji);
    for (const k of ["radar", "day", "trend", "sparklines", "weekHour"]) expect(s).toHaveProperty(k);
    expect(s.radar.length).toBe(8);
    expect(s.day[10].stress).toBe(s.level); // the current hour shows the live value
    expect(s.trend.length).toBe(30);
    await get(NOW + 5 * MIN);
    // GET performs no writes: no statement that changes anything, no stress rows, no EMA state
    expect(t.db.statements.slice(n0).filter((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b|\bINSERT INTO\b/i.test(q))).toEqual([]);
    expect(t.db.rows("SELECT name FROM wb_metrics")).toEqual([]);
    expect(t.db.rows("SELECT k FROM wb_settings WHERE k = 'rt:stress'")).toEqual([]);
    // with the ticker's reading stored (stress 10 a minute ago), the gauge shows THAT reading (it moves every 15 min, not live)
    t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('rt:stress', ?, 0)").run(JSON.stringify({ at: NOW + 9 * MIN, value: 10 }));
    expect((await get(NOW + 10 * MIN)).level).toBe(10);
    // a stale reading (over 20 min) is no longer shown as is: the live estimate, smoothed against it
    const smooth = await get(NOW + 35 * MIN);
    expect(smooth.level).toBeGreaterThan(10);
    expect(smooth.level).toBeLessThan(smooth.raw);
    expect(JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'rt:stress'")[0]?.v as string).value).toBe(10);
    expect(JSON.stringify(await (await route(request("/api/wellbeing"), t.env, ctx, { now: NOW + 11 * MIN })).json())).not.toMatch(/"metrics"|"normRows"/);
  });
});

describe("wording and UI", () => {
  test("neutral, non-medical strings; emoji have words for screen readers; SVG built with createElementNS, no markup", () => {
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    const fmt = readFileSync(join(import.meta.dir, "..", "public", "wellbeing-format.js"), "utf8");
    const srv = readFileSync(join(import.meta.dir, "..", "src", "wellbeing-stress.ts"), "utf8");
    for (const text of [js, fmt, srv]) expect(text).not.toMatch(/addict|psychosis|diagnos|disorder|danger|panic|burn-?out/i);
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|setAttribute\(\s*["']style/);
    expect(js).toContain("createElementNS");
    expect(js).toContain('"aria-hidden": "true" }, band.emoji');
    expect(js).toContain('"aria-label": view.light ? view.light.word : band.label'); // the light's words, never colour alone
    expect(fmt).toContain('concurrency: ["⏳", "waiting"]');
    for (const needle of ["ArrowLeft", "ArrowRight", '"Home"', '"End"', "aria-live"]) expect(js).toContain(needle);
    const css = readFileSync(join(import.meta.dir, "..", "public", "style.css"), "utf8");
    // motion only when it is not reduced: the 150 ms value change and the tile transitions live inside that media query
    const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference) {\n  .wb-tile"));
    expect(motion.slice(0, 400)).toMatch(/\.wb-tile \{ transition: [^}]*150ms/);
    expect(motion.slice(0, 400)).toContain("animation: wb-chg 150ms");
    expect(css.replace(motion.slice(0, 400), "")).not.toMatch(/animation: wb-chg/);
  });
});

import { runCron } from "../src/index";
import { recordStressIfDue } from "../src/wellbeing";
import { indicatorsFromRow, readStressInputs, stressTickMinute, wellbeingNumbers } from "../src/wellbeing-metrics";
import { WB_DEFAULTS } from "../src/wellbeing";

describe("the ticker's stress sample (every 15 min)", () => {
  const Q = Date.parse("2027-01-15T10:00:00Z"); // a quarter hour: minute % 15 = 0
  const fixture = () => {
    const t = makeEnv();
    const ins = t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened) VALUES (?, 'blocked', 'warn', 'host', 'h', 'p', 'x', ?)");
    for (let i = 0; i < 5; i++) ins.run(`b${i}`, Q - (i + 1) * MIN);
    const ev = t.db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, status, severity, text, at, received_at) VALUES ('s', ?, 'c', ?, 'status', 'mcp', ?, 'info', 'x', ?, ?)");
    ["IN_PROGRESS", "BLOCKED", "IN_PROGRESS", "BLOCKED"].forEach((st, i) => ev.run(`mcp:m-1:${i}:x`, ["web", "api", "docs", "ops"][i], st, Q - (i + 1) * 20 * MIN, Q));
    t.db.sqlite.run("INSERT INTO wb_metrics (day, hour, name, value) VALUES ('2027-01-15', 2, 'active', 1)");
    return t;
  };
  const stressRowsOf = (t: ReturnType<typeof makeEnv>) => t.db.rows<{ hour: number; value: number }>("SELECT hour, value FROM wb_metrics WHERE name = 'stress' ORDER BY day, hour");

  test("cadence: minute 7 of each quarter hour; minute 8 only as the catch-up; never else", async () => {
    expect([0, 6, 7, 8, 9, 14, 22, 23].map((m) => stressTickMinute(Q + m * MIN))).toEqual([0, 6, 7, 8, 9, 14, 7, 8]);
    const t = fixture();
    expect(await recordStressIfDue(t.env.DB, Q)).toBe(false);
    expect(await recordStressIfDue(t.env.DB, Q + 6 * MIN)).toBe(false);
    expect(await recordStressIfDue(t.env.DB, Q + 7 * MIN)).toBe(true);
    expect(await recordStressIfDue(t.env.DB, Q + 8 * MIN)).toBe(false); // minute 7 got it
    expect(stressRowsOf(t).length).toBe(1);
    const u = fixture();
    expect(await recordStressIfDue(u.env.DB, Q + 8 * MIN)).toBe(true); // minute 7 missed: caught up
    expect(t.db.rows("SELECT name FROM wb_metrics WHERE name LIKE 'n:%'").length).toBe(8);
  });

  test("the one-statement inputs give the same indicators as the page's read", async () => {
    const t = fixture();
    const now = Q + 7 * MIN;
    const s = { ...WB_DEFAULTS };
    const row = await readStressInputs(t.env.DB, s, now);
    const fromTick = indicatorsFromRow(row as any, s, now).map((i) => [i.name, i.value]).sort();
    const fromPage = (await wellbeingNumbers(t.env.DB, s, now)).indicators.map((i) => [i.name, i.value]).sort();
    expect(fromTick).toEqual(fromPage);
  });

  test("EMA with 15-minute samples: alpha from the real gap; hourly history = the LAST sample of the hour", async () => {
    const t = fixture();
    await recordStressIfDue(t.env.DB, Q + 7 * MIN);
    const first = stressRowsOf(t)[0]?.value as number;
    t.db.sqlite.run("UPDATE alerts SET resolved = 1, opened = 0"); // calm from now on
    await recordStressIfDue(t.env.DB, Q + 22 * MIN);
    const second = stressRowsOf(t)[0]?.value as number;
    // raw dropped; 15 min of a 20-min time constant: about 53 % of the way down, not all the way
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(first * 0.3);
    expect(stressRowsOf(t).length).toBe(1); // same hour: overwritten by the last sample
  });

  test("cron: the sample runs at minute 7 unless the purge ran in that invocation; then at minute 8", async () => {
    const t = fixture();
    const ctx = makeCtx();
    await runCron(t.env, ctx, Q + 7 * MIN); // first cron ever: the purge runs -> no sample
    expect(stressRowsOf(t).length).toBe(0);
    await runCron(t.env, ctx, Q + 8 * MIN);
    expect(stressRowsOf(t).length).toBe(1);
    await runCron(t.env, ctx, Q + 22 * MIN); // purge last ran at :07, not due until :22? 15 min -> due: skipped again
    await runCron(t.env, ctx, Q + 23 * MIN);
    const n = t.db.rows<{ k: string; v: string }>("SELECT v FROM wb_settings WHERE k = 'rt:stress'")[0];
    expect(JSON.parse(n?.v as string).at).toBe(Q + 23 * MIN);
    for (const m of [9, 10, 11, 12]) await runCron(t.env, ctx, Q + m * MIN);
    expect(JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'rt:stress'")[0]?.v as string).at).toBe(Q + 23 * MIN);
  });

  test("statements of the sample: settings and plan limit (each cached a minute per isolate) + 1 read + 1 batch of 2", async () => {
    const t = fixture();
    t.db.recordStatements = true;
    await recordStressIfDue(t.env.DB, Q + 7 * MIN);
    const n0 = t.db.statements.length;
    await recordStressIfDue(t.env.DB, Q + 22 * MIN);
    // 15 minutes later both per-isolate caches (1 min) have expired: settings + plan limit + 1 read + a batch of 2 = 5 at most
    expect(t.db.statements.length - n0).toBe(5);
  });
});

describe("charts: the trend has axes and keyboard; heatmap cells are labelled", () => {
  test("text-only DOM, y labels 0 / 50 / 100, band lines, day labels, focusable days with a live detail, cell labels", () => {
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    const trend = js.slice(js.indexOf("function stressTrendChart"), js.indexOf("/** Weekday x hour"));
    for (const needle of ["[0, 50, 100]", "[lt.yellow, lt.red]", "u-xtick", "ArrowLeft", '"Home"', '"End"', "aria-live", "tabindex", "average stress"]) expect(trend).toContain(needle);
    const heat = js.slice(js.indexOf("/** Weekday x hour"));
    expect(heat).toContain("· avg ${Math.round(c.stress)} · ${bandFor(c.stress).label}");
    expect(heat).toContain('role: "img", "aria-label": c ? `${tip} · ${b.word}` : tip, title:');
  });
});

import { STRESS_STATE_STALE_MS } from "../src/wellbeing-stress";
describe("tester5: rounding once, the EMA seed", () => {
  test("the band follows the rounded number shown: 29.5 / 59.5 / 79.5 / 79.4 (server and page agree)", () => {
    expect([29.5, 59.5, 79.5, 79.4, 29.4].map((l) => bandOf(l).label)).toEqual(["Steady", "Busy", "Heavy", "Busy", "Relaxed"]);
    for (const l of [29.5, 59.5, 79.5, 79.4, 29.4, 0.4, 99.6]) expect(bandFor(l).label).toBe(bandOf(l).label);
    expect(Math.round(79.5)).toBe(80);
  });
  test("the trend and the weekly card are rounded once, so the number and its band match", () => {
    const rows = [
      { day: "2027-01-13", hour: 9, name: "stress", value: 79 },
      { day: "2027-01-13", hour: 10, name: "stress", value: 80 }, // average 79.5 -> 80 Heavy
      { day: "2027-01-14", hour: 9, name: "stress", value: 79.4 },
      { day: "2027-01-15", hour: 9, name: "stress", value: 79.6 },
    ];
    const t = stressTrend(rows, ["2027-01-13", "2027-01-14", "2027-01-15"]);
    expect(t.map((x) => x.stress)).toEqual([80, 79, 80]);
    for (const x of t) expect(Number.isInteger(x.stress)).toBe(true);
    const w = weekCard(rows, ["2027-01-13", "2027-01-14", "2027-01-15"], []);
    expect([w?.avgStress, w?.mood]).toEqual([80, "Heavy"]); // (80 + 79 + 80) / 3 = 79.67 -> 80
    expect(weekHourStress([{ day: "2027-01-15", hour: 9, name: "stress", value: 79.5 }])[0]?.stress).toBe(80);
  });
  test("EMA: no prior state starts at the raw value; a stale one too; 20 min = ~63 %", () => {
    expect(emaStep(null, 72, NOW)).toBe(72);
    expect(emaStep({ at: NOW - STRESS_STATE_STALE_MS - MIN, value: 0 }, 72, NOW)).toBe(72);
    expect(emaStep({ at: NOW - STRESS_TAU_MS, value: 0 }, 100, NOW)).toBeCloseTo(100 * (1 - Math.exp(-1)), 5);
  });
  test("the first tick on an empty database stores the raw reading, not a lagging 0", async () => {
    const t = makeEnv();
    const ins = t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened) VALUES (?, 'blocked', 'warn', 'host', 'h', 'p', 'x', ?)");
    const Q = Date.parse("2027-01-15T10:07:00Z");
    for (let i = 0; i < 5; i++) ins.run(`b${i}`, Q - (i + 1) * MIN);
    expect(t.db.rows("SELECT * FROM wb_settings WHERE k = 'rt:stress'")).toEqual([]);
    expect(await recordStressIfDue(t.env.DB, Q)).toBe(true);
    const st = JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'rt:stress'")[0]?.v as string);
    expect(st.value).toBe(32); // concurrency 20 + interrupts 60 % of 20 = 12: the raw level, at once
  });
});

import { lastLocalHours } from "../src/wellbeing-stress";
import { localTime } from "../src/wellbeing";
describe("DST: the last 24 hours are calendar hours", () => {
  const label = (x: { day: string; hour: number }) => `${x.day}T${String(x.hour).padStart(2, "0")}`;
  const naive = (now: number) => Array.from({ length: 24 }, (_, i) => localTime(now - (23 - i) * 3_600_000, "Europe/London")).map((t) => label({ day: t.day, hour: t.hour }));
  test("BST -> GMT (25 Oct 2026, 01:00 happens twice): no repeated cell", () => {
    const now = Date.parse("2026-10-25T05:30:00Z"); // 05:30 GMT
    const lt = localTime(now, "Europe/London");
    const cal = lastLocalHours(lt.day, lt.hour).map(label);
    expect(cal.length).toBe(24);
    expect(new Set(cal).size).toBe(24);
    expect(cal[0]).toBe("2026-10-24T06");
    expect(cal[23]).toBe("2026-10-25T05");
    expect(new Set(naive(now)).size).toBe(23); // the old way repeated 01:00
  });
  test("GMT -> BST (29 Mar 2026, 01:00 does not exist): no skipped cell", () => {
    const now = Date.parse("2026-03-29T05:30:00Z"); // 06:30 BST
    const lt = localTime(now, "Europe/London");
    const cal = lastLocalHours(lt.day, lt.hour).map(label);
    expect(cal).toContain("2026-03-29T01");
    expect(cal[0]).toBe("2026-03-28T07");
    expect(cal[23]).toBe("2026-03-29T06");
    expect(naive(now)).not.toContain("2026-03-29T01"); // the old way skipped it
  });
});

import { BAND_TONE, INDICATOR_LABEL, LEVEL_TONE, TILE_ORDER, contributorBars, earlyState, indicatorValue } from "../public/wellbeing-format.js";
describe("hero and stat tiles (pure helpers)", () => {
  test("tile values: counts, hours and minutes, ×, %, —", () => {
    expect([indicatorValue("concurrency", 6), indicatorValue("session", 190), indicatorValue("session", 45), indicatorValue("session", 120), indicatorValue("offHours", 2), indicatorValue("burn", 2.43), indicatorValue("limit", 90.6), indicatorValue("burn", null)])
      .toEqual(["6", "3h 10m", "45m", "2h", "2h", "2.4×", "91%", "—"]);
    expect(TILE_ORDER.slice().sort()).toEqual(Object.keys(INDICATOR_LABEL).sort());
    expect(TILE_ORDER.length).toBe(8);
  });
  test("contributor bars: the top three with points, bar length against 20 points (at least a sliver)", () => {
    expect(contributorBars([{ name: "concurrency", points: 20 }, { name: "session", points: 7.5 }, { name: "retry", points: 0.6 }, { name: "burn", points: 3 }])).toEqual([
      { name: "concurrency", label: "Waiting for you", points: 20, pct: 100 },
      { name: "session", label: "Session", points: 8, pct: 37.5 },
      { name: "retry", label: "Retry loop", points: 1, pct: 4 },
    ]);
    expect(contributorBars([{ name: "x", points: 0 }])).toEqual([]);
  });
  test("tones: band -> token family; level -> status tone", () => {
    expect(BAND_TONE).toEqual({ relaxed: "calm", steady: "steady", strained: "strained", overloaded: "over" });
    expect(LEVEL_TONE).toEqual(["calm", "strained", "over"]);
  });
  test("early state: under 24 hourly readings the trend / pattern charts show a placeholder", () => {
    expect(earlyState({ weekHour: [{ n: 10 }, { n: 13 }] }).early).toBe(true);
    expect(earlyState({ weekHour: [{ n: 10 }, { n: 14 }] }).early).toBe(false);
    expect(earlyState(undefined).early).toBe(true);
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    expect(js).toContain("Collecting data — the stress trend appears after a day.");
    for (const t of ['sectionWith("today", "Today"', 'sectionWith("trends", "Trends"', 'sectionWith("patterns", "Patterns"']) expect(js).toContain(t);
  });
});

import { GAUGE, bandGradientStops, gaugeLayout, tileTone } from "../public/wellbeing-format.js";
describe("builders: behaviour, not source text", () => {
  test("gauge: every tick and the marker inside the viewBox; 0 and 100 under the arc ends, 50 above the top", () => {
    for (const level of [0, 1, 37, 50, 79.5, 100, 140, NaN]) {
      const g = gaugeLayout(level);
      for (const t of g.ticks) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThanOrEqual(GAUGE.w);
        expect(t.y).toBeGreaterThan(0);
        expect(t.y).toBeLessThanOrEqual(GAUGE.h);
      }
      expect(g.marker[0]).toBeGreaterThanOrEqual(GAUGE.cx - GAUGE.r);
      expect(g.marker[0]).toBeLessThanOrEqual(GAUGE.cx + GAUGE.r);
    }
    const g = gaugeLayout(66);
    const [t0, t50, t100] = g.ticks;
    expect([t0?.text, t50?.text, t100?.text]).toEqual(["0", "50", "100"]);
    expect([t0?.x, t100?.x]).toEqual([GAUGE.cx - GAUGE.r, GAUGE.cx + GAUGE.r]); // under the arc ends
    expect(t0!.y).toBeGreaterThan(GAUGE.cy); // below the ends
    expect(t50!.y).toBeLessThan(GAUGE.cy - GAUGE.r); // above the top of the arc
    expect(gaugeLayout(0).value).toBeNull();
    expect(gaugeLayout(66).scale.map((x) => x.key)).toEqual(["relaxed", "steady", "strained", "overloaded"]);
  });
  test("trend gradient: hard stops at 30 / 60 / 80, each band in its tone", () => {
    expect(bandGradientStops()).toEqual([
      { tone: "calm", offset: 0 }, { tone: "calm", offset: 30 }, { tone: "steady", offset: 30 }, { tone: "steady", offset: 60 },
      { tone: "strained", offset: 60 }, { tone: "strained", offset: 80 }, { tone: "over", offset: 80 }, { tone: "over", offset: 100 },
    ]);
  });
  test("tile tone: no value is muted 'none' (never green), else the level's tone", () => {
    expect([tileTone({ value: null, level: 0 }), tileTone({ value: undefined, level: 0 }), tileTone(undefined)]).toEqual(["none", "none", "none"]);
    expect([tileTone({ value: 0, level: 0 }), tileTone({ value: 4, level: 1 }), tileTone({ value: 9, level: 2 })]).toEqual(["calm", "strained", "over"]);
  });
  test("contributors under half a point are not shown (no '+0' bar)", () => {
    expect(contributorBars([{ name: "concurrency", points: 12 }, { name: "retry", points: 0.4 }, { name: "burn", points: 0.5 }]).map((b) => [b.name, b.points])).toEqual([["concurrency", 12], ["burn", 1]]);
  });
});

import { sparkPath } from "../public/wellbeing-format.js";
test("sparkline: fewer than two readings (a value but no 24 h history yet) = no path, so the dashed baseline shows", () => {
  expect(sparkPath([])).toBe("");
  expect(sparkPath([null, 40, null])).toBe("");
  expect(sparkPath(undefined)).toBe("");
  expect(sparkPath([10, null, 30], 100, 18)).toBe("M25 16.2L75 12.6");
});
