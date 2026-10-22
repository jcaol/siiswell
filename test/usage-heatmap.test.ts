/**
 * The Day view of the usage section: the 12-month calendar heatmap (Monday-first weeks of Europe/London calendar days, so a BST
 * change never shifts a cell), its colour levels and metric toggle, the chosen day's 24 hours, and the host > app > project > model
 * table. Pure helpers from public/format.js plus static checks of usage.js / style.css (no browser).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appOf, dayOfWeek, heatLevel, heatmapMonths, heatmapWeeks, heatThresholds, heatValue, hourLabel, longDayLabel, usageTree } from "../public/format.js";

const pub = (f: string) => readFileSync(join(import.meta.dir, "..", "public", f), "utf8");

describe("heatmapWeeks", () => {
  test("53 Monday-first columns ending with today's week; days after today are empty", () => {
    const { cols, from, to } = heatmapWeeks("2026-10-16"); // a Friday
    expect(cols.length).toBe(53);
    expect(cols.every((c) => c.length === 7)).toBe(true);
    expect(dayOfWeek(from)).toBe(1);
    expect(to).toBe("2026-10-16");
    expect(cols[52]).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", null, null]);
    expect(cols.flat().filter(Boolean).every((d, i, a) => i === 0 || d! > a[i - 1]!)).toBe(true);
    // Saturdays and Sundays are always rows 6 and 7
    for (const col of cols) for (let r = 0; r < 7; r++) if (col[r]) expect(dayOfWeek(col[r]) ).toBe((r + 1) % 7);
    // the range fits one /api/usage read (at most 400 days)
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1).toBeLessThanOrEqual(371);
  });
  test("BST changes and leap days never shift or repeat a day", () => {
    for (const today of ["2026-03-29", "2026-10-25", "2028-02-29", "2027-01-04", "2026-10-18"]) {
      const days = heatmapWeeks(today).cols.flat().filter(Boolean) as string[];
      expect(new Set(days).size).toBe(days.length);
      for (let i = 1; i < days.length; i++) expect(Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)).toBe(86_400_000);
      expect(days[days.length - 1]).toBe(today);
    }
    expect(heatmapWeeks("junk").cols).toEqual([]);
  });
  test("month labels: at most one per month, never crowded", () => {
    const m = heatmapMonths(heatmapWeeks("2026-10-16").cols);
    expect(m.length).toBeGreaterThanOrEqual(11);
    expect(m.length).toBeLessThanOrEqual(13);
    for (let i = 1; i < m.length; i++) expect(m[i]!.i - m[i - 1]!.i).toBeGreaterThanOrEqual(3);
    expect(m.map((x) => x.label)).toContain("Oct");
  });
});

describe("colour levels and metrics", () => {
  const a = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, requests: 3, usd: 1.25 };
  test("heatValue: $, all tokens, requests", () => {
    expect([heatValue(a, "usd"), heatValue(a, "tokens"), heatValue(a, "requests"), heatValue(undefined, "usd")]).toEqual([1.25, 116, 3, 0]);
  });
  test("quartiles of the non-zero days; zero is level 0; all-zero has no levels", () => {
    const t = heatThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8, 0]);
    expect(t.length).toBe(4);
    expect([0, 1, 3, 5, 8, 100].map((v) => heatLevel(v, t))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(heatThresholds([0, 0])).toEqual([]);
    expect(heatLevel(5, [])).toBe(0);
  });
  test("labels for screen readers and hours", () => {
    expect(longDayLabel("2026-10-16")).toBe("Friday 16 October 2026");
    expect([hourLabel("09"), hourLabel(0), hourLabel(23)]).toEqual(["09:00", "00:00", "23:00"]);
  });
});

describe("host > app > project > model", () => {
  test("appOf: the app part of the agent label; older labels are (other app)", () => {
    expect(["claude-cli", "claude-cli.dev", "codex-desktop", "codex-exec", "unknown", "operator", "(other)", "agent01", "claude-clix"].map(appOf)).toEqual(
      ["claude-cli", "claude-cli", "codex-desktop", "codex-exec", "unknown", "(other app)", "(other app)", "(other app)", "(other app)"],
    );
  });
  test("usageTree sums every level and sorts by $", () => {
    const r = (host: string, agent: string, project: string, model: string, usd: number) => ({ host, agent, project, source: "claude", model, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1, usd, unpricedTokens: 0 });
    const tree = usageTree([r("mac", "claude-cli", "web", "opus", 3), r("mac", "claude-cli.dev", "web", "haiku", 1), r("mac", "codex-cli", "api", "gpt", 5), r("box", "operator", "(other)", "opus", 0.5)]);
    expect(tree.map((h) => [h.name, h.agg.usd])).toEqual([["mac", 9], ["box", 0.5]]);
    expect(tree[0]!.apps.map((a) => [a.name, a.agg.usd])).toEqual([["codex-cli", 5], ["claude-cli", 4]]);
    const web = tree[0]!.apps[1]!.projects[0]!;
    expect([web.name, web.agg.requests, web.rows.map((x) => `${x.model}/${x.worktree}`)]).toEqual(["web", 2, ["opus/", "haiku/dev"]]);
    expect(tree[1]!.apps[0]!.name).toBe("(other app)");
    expect(tree[1]!.apps[0]!.projects[0]!.rows[0]!.worktree).toBe("operator");
    expect(usageTree(undefined as never)).toEqual([]);
  });
});

describe("the Day view in the page", () => {
  const js = pub("usage.js");
  const css = pub("style.css");
  test("Day is the calendar + hours (not the month view), fetched lazily from /api/usage", () => {
    expect(js).toContain("renderDay(");
    expect(js).toContain("/api/usage?group=hour&day=");
    expect(js).toContain("heatmapWeeks(dashToday()).from");
    expect(js).toContain("timeZone: us.tz");
  });
  test("accessible: roving tabindex, arrows by day / week, Home / End, aria labels, pressed state, polite detail", () => {
    for (const needle of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", '"Home"', '"End"', "tabindex", "aria-pressed", "aria-label", "aria-live", "longDayLabel("]) expect(js).toContain(needle);
  });
  test("metric toggle $ / tokens / requests", () => {
    expect(js).toMatch(/\["usd", "\$"\], \["tokens", "Tokens"\], \["requests", "Requests"\]/);
  });
  test("text only, no inline style attributes in markup; colours from tokens in light and dark; the calendar scrolls in its own box", () => {
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.setAttribute\(\s*["']style/);
    const block = css.slice(css.indexOf("/* usage: Day view"), css.indexOf(".foot {"));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    for (const lvl of [0, 1, 2, 3, 4]) expect(block).toContain(`.u-hc.h${lvl}`);
    expect(block).toMatch(/\.u-heat-scroll \{[^}]*overflow-x: auto/);
  });
});
