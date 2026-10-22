import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dateTicks, dayOfWeek, fmtTokens, fmtUsd, isWeekend, niceTicks, tickLabel, usageDayLabel, usageDue, usageFreshness, usageLabel, usdCell, USAGE_REFRESH_MS, USAGE_STALE_MS } from "../public/format.js";

const pub = (f: string) => readFileSync(join(import.meta.dir, "..", "public", f), "utf8");

describe("usage formatting", () => {
  test("fmtTokens: a few characters, k / M / B", () => {
    expect([0, 7, 950, 1000, 12_345, 123_456, 1_200_000, 45_000_000, 4_500_000_000, NaN, -5, undefined].map((n) => fmtTokens(n as number))).toEqual(
      ["0", "7", "950", "1k", "12.3k", "123k", "1.2M", "45M", "4.5B", "0", "0", "0"],
    );
  });
  test("fmtUsd: cents, thousands, a trace, zero", () => {
    expect([0, 0.004, 0.01, 1.5, 12.345, 999.99, 1234.5, 1_419_000, NaN].map((n) => fmtUsd(n))).toEqual(["$0", "<$0.01", "$0.01", "$1.50", "$12.35", "$999.99", "$1,235", "$1,419,000", "$0"]);
  });
  test("usdCell: priced, nothing priced (an em dash), mixed (a lower bound with a note)", () => {
    expect(usdCell({ usd: 12.3, unpricedTokens: 0 })).toEqual({ text: "$12.30", note: "" });
    expect(usdCell({ usd: 0, unpricedTokens: 5000 })).toEqual({ text: "—", note: "5k tokens have no public price (unpriced)" });
    expect(usdCell({ usd: 3, unpricedTokens: 5000 }).text).toBe("$3.00");
    expect(usdCell({ usd: 3, unpricedTokens: 5000 }).note).toContain("at least");
    expect(usdCell({ usd: 0, unpricedTokens: 0 }).text).toBe("$0");
  });
  test("niceTicks: 3..5 round ticks from 0, the top covers the max (0, tiny, typical, huge)", () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], top: 1, step: 1 });
    expect(niceTicks(NaN).top).toBe(1);
    expect(niceTicks(-3).top).toBe(1);
    expect(niceTicks(150).ticks).toEqual([0, 50, 100, 150]);
    expect(niceTicks(100).ticks).toEqual([0, 50, 100]);
    expect(niceTicks(200).ticks).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(51).ticks).toEqual([0, 20, 40, 60]);
    expect(niceTicks(0.003).ticks).toEqual([0, 0.001, 0.002, 0.003]);
    expect(niceTicks(1.4e9).ticks).toEqual([0, 5e8, 1e9, 1.5e9]);
    for (const max of [0.0007, 0.01, 0.37, 1, 9.99, 10, 33, 87.5, 99.99, 100.01, 249, 1234.5, 98765, 4.2e6, 1e12]) {
      const t = niceTicks(max);
      expect(t.ticks.length).toBeGreaterThanOrEqual(3);
      expect(t.ticks.length).toBeLessThanOrEqual(5);
      expect(t.ticks[0]).toBe(0);
      expect(t.top).toBeGreaterThanOrEqual(max);
      expect(t.top).toBeLessThan(max * 2.01); // never a lot of empty space above the highest bar
      expect(t.ticks.every((v, i) => i === 0 || v > t.ticks[i - 1])).toBe(true);
    }
  });
  test("tickLabel: short axis labels", () => {
    expect([0, 5, 50, 1500, 12_000, 2_500_000, 1.5e9, 0.5, 0.002, 2.5, NaN].map(tickLabel)).toEqual(["$0", "$5", "$50", "$1,500", "$12k", "$2.5M", "$1.5B", "$0.5", "$0.002", "$2.5", "$0"]);
  });
  test("dayOfWeek / isWeekend / usageDayLabel", () => {
    expect([dayOfWeek("2026-10-12"), dayOfWeek("2026-10-14"), dayOfWeek("2026-10-17"), dayOfWeek("2026-10-18"), dayOfWeek("x")]).toEqual([1, 3, 6, 0, -1]);
    expect(["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"].map(isWeekend)).toEqual([false, true, true, false]);
    expect(usageDayLabel("2026-10-14")).toBe("Wed 14 Oct");
  });
  test("dateTicks: Mondays plus today, never closer than 4 columns, any window of 30 days", () => {
    const days = (end: string, n = 30) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${end}T00:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
    const d = days("2026-10-14"); // today is a Wednesday
    const t = dateTicks(d);
    expect(t[t.length - 1]).toBe(29);
    expect(t.slice(0, -1).every((i) => dayOfWeek(d[i]) === 1)).toBe(true);
    expect(t.map((i) => usageLabel(d[i]))).toEqual(["21 Sep", "28 Sep", "5 Oct", "14 Oct"]);
    for (let k = 0; k < 14; k++) {
      const w = dateTicks(days(new Date(Date.parse("2026-10-01T00:00:00Z") + k * 86_400_000).toISOString().slice(0, 10)));
      for (let j = 1; j < w.length; j++) expect(w[j] - w[j - 1]).toBeGreaterThanOrEqual(4);
      expect(w.length).toBeGreaterThanOrEqual(4);
      expect(w.length).toBeLessThanOrEqual(6);
    }
    expect(dateTicks([])).toEqual([]);
    expect(dateTicks(["2026-10-14"])).toEqual([0]);
  });
  test("usageLabel: months and days read like words", () => {
    expect([usageLabel("2026-10"), usageLabel("2026-10-04"), usageLabel("junk")]).toEqual(["Oct 2026", "4 Oct", "junk"]);
  });
  test("freshness: the newest host push wins; older than 6 h warns; nothing reported says so", () => {
    const now = 1_800_000_000_000;
    expect(usageFreshness([{ pushedAt: now - 5 * 60_000 }, { pushedAt: now - 9 * 3_600_000 }], now)).toEqual({ text: "updated 5 min ago", tone: "ok" });
    expect(usageFreshness([{ pushedAt: now - USAGE_STALE_MS - 1 }], now).tone).toBe("warn");
    expect(usageFreshness([], now).tone).toBe("idle");
    expect(usageFreshness(undefined, now).text).toContain("no host");
  });
  test("refetch: at most every 15 min; a clock that went backwards fetches again", () => {
    const now = 1_800_000_000_000;
    expect([undefined, 0, now - USAGE_REFRESH_MS + 1, now - USAGE_REFRESH_MS, now + 5].map((t) => usageDue(t as number, now))).toEqual([true, true, false, true, true]);
  });
});

describe("the usage section in the page", () => {
  const html = pub("index.html");
  test("it sits after Discussions and before Hosts & clients, with a Day / Month switch and no inline script or style", () => {
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(at("sec-discussions")).toBeGreaterThan(0);
    expect(at("sec-usage")).toBeGreaterThan(at("sec-discussions"));
    expect(at("sec-hosts")).toBeGreaterThan(at("sec-usage"));
    expect(html).toContain('data-group="month"');
    expect(html).toContain('data-group="day"');
    expect(html).toMatch(/Usage &amp; estimated cost/);
    expect(html).not.toMatch(/\sstyle=/);
  });
  test("usage.js writes text only, fetches /api/usage (never /api/state), lazily, and says API-equivalent (est.)", () => {
    const js = pub("usage.js");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.setAttribute\(\s*["']style/);
    expect(js).toContain("/api/usage?group=");
    expect(js).not.toContain("/api/state");
    expect(js).toContain("IntersectionObserver");
    expect(js).toContain("API-equivalent (est.)");
    expect(js).toContain("Days in ${us.tz}");
    expect(js).toContain("flat-rate");
    expect(js).toMatch(/u-big[^\n]*u-plus/); // the big total carries the lower-bound "+" like the Total row
    expect(js).toContain("retrieved 2026-10-14");
    expect(pub("app.js")).toContain("initUsage()");
  });
  test("the chart: y ticks, weekly x labels, weekend tint, per-day detail, focusable columns; text only", () => {
    const js = pub("usage.js");
    for (const needle of ["niceTicks(", "dateTicks(", "isWeekend(", "u-yaxis", "u-grid", "u-xaxis", "u-detail", "aria-live", "mouseenter", '"click"', '"focus"', "ArrowLeft", "aria-label", "unpriced:", "unp"]) expect(js).toContain(needle);
    expect(js).toContain("dayDetail(");
    expect(js).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/);
  });
  test("the stylesheet styles the chart, uses tokens only (no hard-coded colours in the usage block) and never widens a phone", () => {
    const css = pub("style.css");
    for (const sel of [".u-yaxis", ".u-grid", ".u-xtick", ".u-col.we", ".u-stack", ".u-unp-dot", ".u-detail", ".u-col:focus-visible"]) expect(css).toContain(sel);
    const block = css.slice(css.indexOf("/* usage & estimated cost"), css.indexOf(".foot {"));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(block).toMatch(/\.u-chart-main \{[^}]*min-width: 0/);
  });
  test("the CSP stays strict (nothing was added for the usage section)", () => {
    const headers = pub("_headers");
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("style-src 'self'");
    expect(headers).not.toMatch(/unsafe-inline|unsafe-eval/);
  });
});
