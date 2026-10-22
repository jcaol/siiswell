/** Pure helpers of the usage overview (public/format.js): KPI periods and deltas, shares, stacked series, rankings, weekday x hour, hourly coverage. */
import { describe, expect, test } from "bun:test";
import {
  appOf, appSlot, cacheShare, deltaPct, deltaText, fmtPct, hourlyCoverage, hourStampLabel, kpiPeriods, lastDays, ranking, stackSeries, sumAgg, unpricedShare, weekHourGrid,
} from "../public/format.js";

const a = (usd: number, requests = 1, more: Record<string, number> = {}) => ({ usd, requests, input: 10, output: 5, cacheRead: 100, cacheWrite: 0, unpricedTokens: 0, unpricedRequests: 0, ...more });

describe("KPI periods", () => {
  test("today / 7 d / 30 d against the period before, by London calendar day", () => {
    const today = "2026-10-16";
    const daily = [
      { day: "2026-10-16", ...a(5) },
      { day: "2026-10-15", ...a(4) },
      { day: "2026-10-10", ...a(1) },
      { day: "2026-10-09", ...a(2) }, // the previous 7 days
      { day: "2026-09-17", ...a(3) }, // the 30th day back: in d30
      { day: "2026-09-16", ...a(7) }, // the previous 30 days
    ];
    const k = kpiPeriods(daily, today);
    expect(k.today).toMatchObject({ soFar: true, cmp: null });
    expect(k.today.cur.usd).toBe(5);
    expect(k.today.cur.tokens).toBe(115);
    // 7 d shows today, compares complete days: 10-09..10-15 against 10-02..10-08
    expect([k.d7.cur.usd, k.d7.cmp.usd, k.d7.prev.usd]).toEqual([10, 7, 0]);
    expect([k.d30.cur.usd, k.d30.cmp.usd, k.d30.prev.usd]).toEqual([15, 17, 0]);
    expect(kpiPeriods([], today).d30.cur.usd).toBe(0);
  });
  test("today against yesterday up to the same hour, from the hourly rows", () => {
    const k = kpiPeriods([{ day: "2026-10-16", ...a(5) }], "2026-10-16", { hour: "13", today: a(4), yesterday: a(2) });
    expect(k.today).toMatchObject({ soFar: false, vs: "vs yesterday by 14:00" });
    expect([k.today.cmp.usd, k.today.prev.usd]).toEqual([4, 2]);
    // no hourly yesterday: so far, no delta
    expect(kpiPeriods([], "2026-10-16", { hour: "13", today: a(4), yesterday: a(0, 0) }).today.soFar).toBe(true);
  });
  test("deltas: percent, new, unchanged, nothing", () => {
    expect([deltaPct(12, 10), deltaPct(5, 10), deltaPct(1, 0), deltaPct(NaN, 1)]).toEqual([20, -50, null, null]);
    expect(deltaText(12, 10)).toMatchObject({ text: "▲ 20%", tone: "up" });
    expect(deltaText(5, 10)).toMatchObject({ text: "▼ 50%", tone: "down" });
    expect(deltaText(3, 0).text).toBe("new");
    expect(deltaText(0, 0).text).toBe("");
    expect(deltaText(10, 10).text).toBe("± 0%");
  });
  test("sumAgg ignores junk", () => {
    expect(sumAgg([a(1), null, { usd: "x" }, a(2)]).usd).toBe(3);
  });
});

describe("shares", () => {
  test("cache share = cache read / all prompt input; unpriced share of requests; percent text", () => {
    expect(cacheShare({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBeCloseTo(0.8);
    expect(cacheShare({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(unpricedShare({ requests: 10, unpricedRequests: 3 })).toBeCloseTo(0.3);
    expect(unpricedShare({ requests: 0 })).toBeNull();
    expect([fmtPct(0.623), fmtPct(0.001), fmtPct(0), fmtPct(null)]).toEqual(["62%", "<1%", "0%", "—"]);
  });
});

describe("stacked series and colours", () => {
  test("apps keep a fixed colour slot; unknown labels are neutral", () => {
    expect([appSlot("claude-cli"), appSlot("codex-cli"), appSlot("unknown"), appSlot("(other app)"), appSlot("x")]).toEqual([1, 3, 8, 8, 8]);
  });
  test("top keys by total, the rest folded, per-day parts in key order", () => {
    const days = lastDays("2026-10-03", 3);
    expect(days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    const rows = [
      { day: "2026-10-01", k: "web", ...a(5) },
      { day: "2026-10-02", k: "api", ...a(3) },
      { day: "2026-10-02", k: "docs", ...a(1) },
      { day: "2026-10-03", k: "misc", ...a(0.5) },
      { day: "2026-10-03", k: "zero", ...a(0) },
    ];
    const s = stackSeries(rows, days, { top: 3 });
    expect(s.keys.map((k) => [k.k, k.total, k.slot])).toEqual([["web", 5, 1], ["api", 3, 2], ["(rest)", 1.5, 8]]);
    expect(s.days.map((d) => d.parts.map((p) => p.v))).toEqual([[5, 0, 0], [0, 3, 1], [0, 0, 0.5]]);
    expect(s.days.map((d) => d.total)).toEqual([5, 4, 0.5]);
    // no fold when everything fits
    expect(stackSeries(rows, days, { top: 6 }).keys.map((k) => k.k)).toEqual(["web", "api", "docs", "misc"]);
    // apps: keyOf folds labels and the slot is the app's own
    const apps = stackSeries([{ day: "2026-10-01", k: "codex-cli", ...a(2) }, { day: "2026-10-01", k: "agent7", ...a(1) }], days, { keyOf: appOf, apps: true });
    expect(apps.keys.map((k) => [k.k, k.slot])).toEqual([["codex-cli", 3], ["(other app)", 8]]);
  });
});

describe("ranking", () => {
  test("biggest first, share of the whole, bar length against the biggest, zero rows left out", () => {
    const r = ranking([{ k: "a", ...a(1) }, { k: "b", ...a(3) }, { k: "c", ...a(0) }], { limit: 5 });
    expect(r.map((x) => [x.name, x.share, x.len])).toEqual([["b", 0.75, 1], ["a", 0.25, 1 / 3]]);
    expect(ranking([{ k: "a", ...a(1) }, { k: "b", ...a(3) }], { limit: 1 }).length).toBe(1);
  });
});

describe("weekday x hour", () => {
  test("Monday first, 24 hours each, thresholds and the busiest cell", () => {
    const g = weekHourGrid([{ w: 0, h: "22", ...a(1, 2) }, { w: 1, h: "09", ...a(1, 9) }]);
    expect(g.rows.map((r) => r.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(g.rows.every((r) => r.cells.length === 24)).toBe(true);
    expect(g.rows[0].cells[9].v).toBe(9);
    expect(g.rows[6].cells[22].v).toBe(2);
    expect(g.peak).toEqual({ w: 1, h: "09", v: 9 });
    expect(weekHourGrid([]).peak).toBeNull();
  });
});

describe("hourly coverage of a day", () => {
  test("none / partial / full / empty, and the hosts without hours", () => {
    expect(hourlyCoverage({ coverage: [{ host: "old", requests: 30, hourly: 0 }], dayTotal: { requests: 30 }, total: { requests: 0 } })).toEqual({ kind: "none", share: 0, missing: ["old"] });
    const p = hourlyCoverage({ coverage: [{ host: "new", requests: 62, hourly: 62 }, { host: "old", requests: 38, hourly: 0 }], dayTotal: { requests: 100 }, total: { requests: 62 } });
    expect(p).toEqual({ kind: "partial", share: 0.62, missing: ["old"] });
    expect(hourlyCoverage({ coverage: [{ host: "new", requests: 5, hourly: 5 }], dayTotal: { requests: 5 }, total: { requests: 5 } }).kind).toBe("full");
    expect(hourlyCoverage({ coverage: [], dayTotal: { requests: 0 }, total: { requests: 0 } }).kind).toBe("empty");
    // an older server without `coverage`: judged from the totals
    expect(hourlyCoverage({ dayTotal: { requests: 10 }, total: { requests: 0 } }).kind).toBe("none");
  });
  test("hour stamps read like words", () => {
    expect(hourStampLabel("2026-10-14T09")).toBe("14 Oct 2026 09:00");
    expect(hourStampLabel("junk")).toBe("junk");
  });
});

import { dateTicks, tickGap } from "../public/format.js";
describe("x labels by width", () => {
  test("a phone gets fewer, never touching labels; a desktop keeps weekly ones", () => {
    expect(tickGap(1190, 30)).toBe(4);
    expect(tickGap(300, 30)).toBe(5);
    expect(tickGap(0, 30)).toBe(4);
    const days = Array.from({ length: 30 }, (_, i) => new Date(Date.parse("2026-09-17T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
    const t = dateTicks(days, tickGap(300, 30));
    for (let j = 1; j < t.length; j++) expect(t[j] - t[j - 1]).toBeGreaterThanOrEqual(5);
    expect(t[t.length - 1]).toBe(29);
  });
});

import { clockLabel, mcpQuietSince } from "../public/format.js";
describe("MCP tasks that went quiet", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-10-17T15:00:00Z");
  test("ETA + 30 min, or 2 h without an ETA; never blocked, closed or host-agent tasks", () => {
    const t = (o: Record<string, unknown>) => ({ origin: "mcp", state: "running", updated: now - H, etaAt: null, ...o });
    expect(mcpQuietSince(t({ etaAt: now - 31 * 60_000 }), now)).toBe(now - H);
    expect(mcpQuietSince(t({ etaAt: now - 29 * 60_000 }), now)).toBeNull();
    expect(mcpQuietSince(t({}), now)).toBeNull(); // 1 h, no ETA
    expect(mcpQuietSince(t({ updated: now - 2 * H - 1 }), now)).toBe(now - 2 * H - 1);
    expect(mcpQuietSince(t({ updated: now - 5 * H, state: "blocked" }), now)).toBeNull();
    expect(mcpQuietSince(t({ updated: now - 5 * H, state: "done" }), now)).toBeNull();
    expect(mcpQuietSince(t({ updated: now - 5 * H, origin: "host" }), now)).toBeNull();
  });
  test("clock labels: time today, weekday + time before", () => {
    const d = new Date(now);
    expect(clockLabel(now - 60_000, now)).toMatch(/^\d{2}:\d{2}$/);
    expect(clockLabel(now - 3 * 86_400_000, now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
    expect(d).toBeTruthy();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
test("the page shows quiet MCP tasks neutrally and stale ones as 'no report' (text only)", () => {
  const js = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");
  for (const needle of ["mcpQuietSince(", "No update since", "agent may have finished without reporting", '"no report"', 'stale: "idle"', '"skipped", "stale"].includes(s)']) expect(js).toContain(needle);
  expect(readFileSync(join(import.meta.dir, "..", "public", "style.css"), "utf8")).toContain(".wk.quiet");
});
