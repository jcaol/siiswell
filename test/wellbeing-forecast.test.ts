/** Plan-limit forecast: samples per window (a reset starts again), the least-squares line, the confidence guards, the wording. */
import { describe, expect, test } from "bun:test";
import { route } from "../src/index";
import { recordStressIfDue } from "../src/wellbeing";
import { appendSamples, fitLine, forecastFill, forecasts, windowLengthMs } from "../src/wellbeing-forecast";
import { makeCtx, makeEnv, request } from "./d1-shim";

const MIN = 60_000;
const H = 3_600_000;
const NOW = Date.parse("2027-01-15T14:00:00Z"); // London 14:00 (GMT)
const series = (n: number, stepMin: number, from: number, per: number) => Array.from({ length: n }, (_, i) => [NOW - (n - 1 - i) * stepMin * MIN, from + i * per] as [number, number]);

describe("history", () => {
  test("adds this tick's reading per window; a drop is a reset; at most 16 samples", () => {
    let h = appendSamples({}, [{ label: "5h", pct: 10 }], NOW - 30 * MIN);
    h = appendSamples(h, [{ label: "5h", pct: 20 }, { label: "weekly", pct: 50 }], NOW - 15 * MIN);
    expect(h).toEqual({ "5h": [[NOW - 30 * MIN, 10], [NOW - 15 * MIN, 20]], weekly: [[NOW - 15 * MIN, 50]] });
    h = appendSamples(h, [{ label: "5h", pct: 3 }], NOW);
    expect(h["5h"]).toEqual([[NOW, 3]]);
    let big = {};
    for (let i = 0; i < 30; i++) big = appendSamples(big, [{ label: "5h", pct: i }], NOW - (30 - i) * MIN);
    expect((big as any)["5h"].length).toBe(16);
  });
  test("window lengths from the labels", () => {
    expect([windowLengthMs("5h"), windowLengthMs("weekly"), windowLengthMs("90min"), windowLengthMs("odd")]).toEqual([5 * H, 7 * 86_400_000, 90 * MIN, null]);
  });
  test("least squares: slope and fit", () => {
    const f = fitLine([[0, 0], [1000, 10], [2000, 20]])!;
    expect(f.slope).toBeCloseTo(0.01);
    expect(f.r2).toBeCloseTo(1);
    expect(fitLine([[5, 1]])).toBeNull();
  });
});

describe("forecast and its guards", () => {
  test("a steady climb: 'At this pace the 5 h window fills around 16:40' (local time, no countdown)", () => {
    // 60 % now, +10 % every 25 min -> 40 % to go = 100 min -> 15:40 London
    const f = forecastFill("5h", series(4, 25, 30, 10), { pct: 60, resetsAt: NOW + 3 * H }, NOW, "Europe/London");
    expect(f).toMatchObject({ label: "5h", when: "15:40", text: "At this pace the 5 h window fills around 15:40.", points: 4 });
    expect(f!.text).not.toMatch(/\d+\s*(min|minutes|h) left|!/);
  });
  test("too few points, too short a span, a flat or falling line, a poor fit: no forecast", () => {
    expect(forecastFill("5h", series(2, 30, 50, 10), { pct: 60, resetsAt: null }, NOW, "UTC")).toBeNull();
    expect(forecastFill("5h", series(4, 5, 50, 3), { pct: 59, resetsAt: null }, NOW, "UTC")).toBeNull(); // 15 min span
    expect(forecastFill("5h", series(4, 20, 50, 0), { pct: 50, resetsAt: null }, NOW, "UTC")).toBeNull();
    expect(forecastFill("5h", series(4, 20, 50, -2), { pct: 44, resetsAt: null }, NOW, "UTC")).toBeNull();
    const noisy: Array<[number, number]> = [[NOW - 60 * MIN, 50], [NOW - 40 * MIN, 70], [NOW - 20 * MIN, 45], [NOW, 72]];
    expect(forecastFill("5h", noisy, { pct: 72, resetsAt: null }, NOW, "UTC")).toBeNull();
  });
  test("only when it is likely within the window: not after the reset, not beyond the window's length", () => {
    expect(forecastFill("5h", series(4, 25, 30, 10), { pct: 60, resetsAt: NOW + 60 * MIN }, NOW, "UTC")).toBeNull(); // resets first
    expect(forecastFill("5h", series(4, 20, 10, 1), { pct: 13, resetsAt: null }, NOW, "UTC")).toBeNull(); // 87 % at 3 %/h: far beyond 5 h
    expect(forecastFill("weekly", series(6, 60, 40, 2), { pct: 50, resetsAt: null }, NOW, "UTC")?.when).toBe("Sat 15:00"); // a later day
  });
  test("several windows: only those that pass", () => {
    const h = { "5h": series(4, 25, 30, 10), weekly: series(2, 60, 10, 1) };
    expect(forecasts(h, [{ label: "5h", pct: 60, resetsAt: null }, { label: "weekly", pct: 11, resetsAt: null }], NOW, "UTC").map((f) => f.label)).toEqual(["5h"]);
  });
});

describe("end to end: the ticker keeps the history, the page shows the forecast (read-only)", () => {
  test("15-minute samples from the snapshots -> limitForecasts", async () => {
    const t = makeEnv();
    const snap = (pct: number, at: number) => t.db.sqlite.query("INSERT OR REPLACE INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'h', 'p', ?, ?)")
      .run(JSON.stringify({ agents: [{ name: "a", usage: [{ label: "5h", usedPercent: pct, resetsAt: NOW + 3 * H }] }] }), at);
    const Q = Date.parse("2027-01-15T13:07:00Z");
    for (const [i, pct] of [40, 50, 60, 70].entries()) {
      snap(pct, Q + i * 15 * MIN);
      expect(await recordStressIfDue(t.env.DB, Q + i * 15 * MIN)).toBe(true); // minute 7 of each quarter hour
    }
    const hist = JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'rt:limits'")[0]?.v as string);
    expect(hist["5h"].map((x: number[]) => x[1])).toEqual([40, 50, 60, 70]);
    const r = (await (await route(request("/api/wellbeing"), t.env, makeCtx(), { now: Q + 46 * MIN })).json()) as any;
    expect(r.limitForecasts.length).toBe(1);
    expect(r.limitForecasts[0].text).toMatch(/^At this pace the 5 h window fills around \d\d:\d\d\.$/);
  });
});

import { parseLimitHistory } from "../src/wellbeing";
import { safeLabel } from "../src/wellbeing-forecast";
describe("untrusted window labels (prototype pollution)", () => {
  test("labels must start alphanumeric and are never __proto__ / constructor / prototype", () => {
    expect(["5h", "weekly", "Opus weekly", "90min"].map(safeLabel)).toEqual([true, true, true, true]);
    expect(["__proto__", "constructor", "prototype", "Constructor", "_x", " 5h", "", "a".repeat(17), 5].map((l) => safeLabel(l as string))).toEqual(Array(9).fill(false));
  });
  test("appendSamples / forecasts / parseLimitHistory ignore them and never touch Object.prototype", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    let h = appendSamples(Object.create(null), [{ label: "__proto__", pct: 50 }, { label: "constructor", pct: 60 }, { label: "5h", pct: 10 }], NOW);
    h = appendSamples(h, [{ label: "__proto__", pct: 70 }], NOW + MIN);
    expect(Object.keys(h)).toEqual(["5h"]);
    expect(Object.getPrototypeOf(h)).toBeNull();
    const parsed = parseLimitHistory('{"__proto__": [[1, 2]], "constructor": [[1, 2]], "5h": [[1, 2]], "x": "not a list"}');
    expect(Object.keys(parsed)).toEqual(["5h"]);
    expect(({} as any).polluted).toBeUndefined();
    expect(forecasts(parsed, [{ label: "__proto__", pct: 99, resetsAt: null }, { label: "constructor", pct: 99, resetsAt: null }], NOW, "UTC")).toEqual([]);
    expect(forecastFill("5h", "not a list" as never, { pct: 50, resetsAt: null }, NOW, "UTC")).toBeNull();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });
});
