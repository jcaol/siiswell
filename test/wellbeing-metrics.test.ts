/**
 * Well-being W2: indicators, the hourly metrics the ticker writes, today's timeline and the 7 / 30-day trends, and the page's
 * pure helpers. Fixture time series only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route, runCron } from "../src/index";
import { WB_DEFAULTS } from "../src/wellbeing";
import {
  SQL_RECORD_HOUR, THRESHOLDS, burnRatio, dayTrends, levelOf, localHourStart, maxRetryFlips, median, recordHourMetrics, sessionMinutes, taskOfEvent, wellbeingNumbers,
} from "../src/wellbeing-metrics";
import { interruptLevel, levelFor, limitFromState, limitIndicator, overall, trendRows } from "../public/wellbeing-format.js";
import { makeCtx, makeEnv, request } from "./d1-shim";

const MIN = 60_000;
const H = 3_600_000;
const NOW = Date.parse("2027-01-15T10:20:00Z"); // Friday, GMT: London 10:20

describe("thresholds and levels", () => {
  test("every indicator: calm below busy, busy from it, overloaded from the second threshold", () => {
    const cases: Record<string, Array<[number, number]>> = {
      interrupts: [[3, 0], [4, 1], [8, 1], [9, 2]],
      concurrency: [[2, 0], [3, 1], [4, 1], [5, 2]],
      fanOut: [[3, 0], [4, 1], [5, 1], [6, 2]],
      session: [[179, 0], [180, 1], [299, 1], [300, 2]],
      offHours: [[0, 0], [1, 1], [2, 2]],
      burn: [[1.9, 0], [2, 1], [2.9, 1], [3, 2]],
      limit: [[69, 0], [70, 1], [89, 1], [90, 2]],
      retry: [[2, 0], [3, 1], [4, 1], [5, 2]],
    };
    expect(Object.keys(cases).sort()).toEqual(Object.keys(THRESHOLDS).sort());
    for (const [name, list] of Object.entries(cases)) for (const [v, lvl] of list) expect([name, v, levelOf(name, v)]).toEqual([name, v, lvl]);
    expect(levelOf("burn", null)).toBe(0);
    expect(levelOf("nope", 99)).toBe(0);
  });
});

describe("formulas", () => {
  test("session: a gap of 45 min or more ends it; no recent activity = no session", () => {
    const t = (m: number) => NOW - m * MIN;
    expect(sessionMinutes([t(5), t(30), t(60), t(100), t(200)], NOW)).toEqual({ minutes: 100, start: t(100) }); // 100 -> 200 is a 100-min gap
    expect(sessionMinutes([t(5), t(50)], NOW).minutes).toBe(5); // exactly 45 min: a break
    expect(sessionMinutes([t(46)], NOW)).toEqual({ minutes: 0, start: null });
    expect(sessionMinutes([], NOW).minutes).toBe(0);
    expect(sessionMinutes([NOW + MIN, t(1)], NOW).minutes).toBe(1); // future stamps ignored
  });
  test("session: a 44-minute gap does not end it", () => {
    expect(sessionMinutes([NOW - 5 * MIN, NOW - 49 * MIN], NOW).minutes).toBe(49);
  });
  test("median and burn ratio against 14 days (missing days count as 0; no baseline = null)", () => {
    expect([median([]), median([3]), median([1, 9, 2]), median([4, 1, 3, 2])]).toEqual([0, 3, 2, 2.5]);
    expect(burnRatio(300, Array(14).fill(100))).toBe(3);
    expect(burnRatio(300, [100, 100, 100])).toBeNull(); // 3 days of history, 11 zeros: the median is 0
    expect(burnRatio(300, Array(8).fill(100))).toBe(3); // 8 of 14 days: median 100
    expect(burnRatio(0, Array(14).fill(0))).toBeNull();
  });
  test("retry loop: BLOCKED <-> IN_PROGRESS flips of one task; other statuses ignored", () => {
    const ev = (task: string, status: string, at: number) => ({ task, status, at });
    expect(maxRetryFlips([ev("a", "IN_PROGRESS", 1), ev("a", "BLOCKED", 2), ev("a", "DONE", 3), ev("a", "IN_PROGRESS", 4), ev("a", "BLOCKED", 5), ev("b", "BLOCKED", 1)])).toEqual({ flips: 3, task: "a" });
    expect(maxRetryFlips([ev("a", "IN_PROGRESS", 2), ev("a", "IN_PROGRESS", 1)])).toEqual({ flips: 0, task: null });
    expect(taskOfEvent({ key: "mcp:m-1a:179:xyz", host: "c", project: "p", agent: "x" })).toBe("mcp:m-1a");
    expect(taskOfEvent({ key: "e1", host: "h", project: "p", agent: "w1" })).toBe("h|p|w1");
  });
  test("local hour start: GMT, BST, another zone", () => {
    expect(new Date(localHourStart("2027-01-15", 10, "Europe/London")).toISOString()).toBe("2027-01-15T10:00:00.000Z");
    expect(new Date(localHourStart("2026-07-01", 10, "Europe/London")).toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(new Date(localHourStart("2026-07-01", 10, "Asia/Hong_Kong")).toISOString()).toBe("2026-07-01T02:00:00.000Z");
  });
  test("day trends: active and off-hours, the longest rest, the average waiting; a day without rows has no rest figure", () => {
    const rows = [
      ...[9, 10, 11, 23].map((hour) => ({ day: "2027-01-14", hour, name: "active", value: 1 })),
      { day: "2027-01-14", hour: 9, name: "waiting", value: 4 },
      { day: "2027-01-14", hour: 10, name: "waiting", value: 2 },
      { day: "2027-01-14", hour: 10, name: "interrupts", value: 5 },
    ];
    const [d1, d2] = dayTrends(rows, ["2027-01-14", "2027-01-15"], { ...WB_DEFAULTS });
    expect(d1).toEqual({ day: "2027-01-14", activeHours: 4, offHours: 1, longestRest: 11, avgWaiting: 1.5, interrupts: 5 }); // 12..22 idle
    expect(d2).toEqual({ day: "2027-01-15", activeHours: 0, offHours: 0, longestRest: null, avgWaiting: null, interrupts: 0 });
  });
});

describe("the ticker's hourly metrics (one statement)", () => {
  test("active, interrupts, waiting, projects of the current local hour; the hour's maximum is kept", async () => {
    const t = makeEnv();
    const db = t.env.DB;
    const s = { ...WB_DEFAULTS };
    const alert = (key: string, rule: string, opened: number, resolved: number | null = null) =>
      t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, resolved) VALUES (?, ?, 'warn', 'host', 'h', 'p', 'x', ?, ?)").run(key, rule, opened, resolved);
    alert("a1", "blocked", NOW - 10 * MIN);
    alert("a2", "approval-waiting", NOW - 5 * MIN);
    alert("a3", "overdue", NOW - 25 * MIN); // 09:55: the previous hour
    alert("a4", "host-offline", NOW - 2 * MIN); // not an interrupt rule
    t.db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', 'e1', 'h', 'web', 'status', 'host', 'info', 'x', ?, ?)").run(NOW - 3 * MIN, NOW);
    t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES ('2027-01-15T10', 'h', 'api', 'claude-cli', 'claude', 'm', 1, 1, 0, 0, 0, 3, 0, 0)").run();
    await recordHourMetrics(db, s, NOW);
    const m = () => Object.fromEntries(t.db.rows<{ name: string; value: number }>("SELECT name, value FROM wb_metrics WHERE day = '2027-01-15' AND hour = 10").map((r) => [r.name, r.value]));
    expect(m()).toEqual({ active: 1, interrupts: 2, waiting: 2, projects: 2 });
    // later in the hour: both waiting alerts resolved -> waiting keeps the hour's maximum
    t.db.sqlite.run("UPDATE alerts SET resolved = 1");
    await recordHourMetrics(db, s, NOW + 10 * MIN);
    expect(m().waiting).toBe(2);
    expect(SQL_RECORD_HOUR).toContain("ON CONFLICT(day, hour, name) DO UPDATE SET value = MAX(value, excluded.value)");
  });
  test("retention by trigger: a new hour removes rows older than 90 days", async () => {
    const t = makeEnv();
    t.db.sqlite.run("INSERT INTO wb_metrics (day, hour, name, value) VALUES ('2026-10-01', 3, 'active', 1), ('2026-10-20', 3, 'active', 1)");
    await recordHourMetrics(t.env.DB, { ...WB_DEFAULTS }, NOW);
    expect(t.db.rows<{ day: string }>("SELECT DISTINCT day FROM wb_metrics ORDER BY day").map((r) => r.day)).toEqual(["2026-10-20", "2027-01-15"]);
  });
  test("the cron writes them each minute (without a push key too); a missing migration is a no-op", async () => {
    const t = makeEnv({ WELLBEING_PUSH_POLICY: undefined });
    await runCron(t.env, makeCtx(), NOW);
    expect(t.db.rows("SELECT name FROM wb_metrics ORDER BY name").length).toBe(4);
    const u = makeEnv();
    u.db.sqlite.run("DROP TABLE wb_settings");
    await runCron(u.env, makeCtx(), NOW);
    expect(u.db.rows("SELECT * FROM wb_metrics")).toEqual([]);
  });
});

describe("GET /api/wellbeing: the You card's numbers", () => {
  test("indicators from a fixture: waiting, interrupts, fan-out, session, off-hours, burn, retry; timeline and 30 trend days", async () => {
    const t = makeEnv();
    const ins = t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, resolved) VALUES (?, ?, 'warn', 'host', 'h', 'p', 'x', ?, NULL)");
    for (let i = 0; i < 5; i++) ins.run(`b${i}`, "blocked", NOW - (i + 1) * MIN);
    const ev = t.db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, status, severity, text, at, received_at) VALUES ('s', ?, 'c', ?, 'status', 'mcp', ?, 'info', 'x', ?, ?)");
    // one MCP task flipping 5 times in the last hours, across 4 projects; activity every 20 min for 3.5 h
    const statuses = ["IN_PROGRESS", "BLOCKED", "IN_PROGRESS", "BLOCKED", "IN_PROGRESS", "BLOCKED"];
    statuses.forEach((st, i) => ev.run(`mcp:m-1:${i}:x`, "web", st, NOW - (i + 1) * 30 * MIN, NOW));
    ["a", "b", "c"].forEach((p, i) => ev.run(`e-${p}`, p, "IN_PROGRESS", NOW - (i + 1) * 5 * MIN, NOW));
    // usage: today 3x the usual same span (14 days of 100 tokens up to 10:xx)
    const uh = t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, 'h', ?, 'claude-cli', 'claude', 'm', ?, 0, 0, 0, 0, 1, 0, 0)");
    for (let d = 1; d <= 14; d++) uh.run(`${new Date(NOW - d * 86_400_000).toISOString().slice(0, 10)}T09`, "web", 100);
    uh.run("2027-01-15T09", "web", 100);
    uh.run("2027-01-15T10", "api", 200);
    uh.run("2027-01-14T23", "web", 1); // yesterday late: not today's burn
    // stored hours: active in the quiet hours this morning (02 and 03)
    t.db.sqlite.run("INSERT INTO wb_metrics (day, hour, name, value) VALUES ('2027-01-15', 2, 'active', 1), ('2027-01-15', 3, 'active', 1), ('2027-01-15', 9, 'interrupts', 6)");
    const n = await wellbeingNumbers(t.env.DB, { ...WB_DEFAULTS }, NOW);
    const by = Object.fromEntries(n.indicators.map((i) => [i.name, i]));
    expect(by.concurrency).toMatchObject({ value: 5, level: 2, text: "Waiting for you 5" });
    expect(by.interrupts).toMatchObject({ value: 5, level: 1 });
    expect(by.fanOut).toMatchObject({ value: 4, level: 1 });
    expect(by.session.value).toBe(180); // 07:20 -> 10:20
    expect(by.session).toMatchObject({ level: 1, text: "Session 3h" });
    expect(by.offHours).toMatchObject({ value: 2, level: 2, text: "Off-hours today 2h" });
    expect(by.burn).toMatchObject({ value: 3, level: 2, text: "Usage vs usual 3x" });
    expect(by.retry).toMatchObject({ value: 5, level: 2 });
    expect(n.burnTop).toBe("api");
    expect(n.timeline.length).toBe(24);
    expect(n.timeline[9]).toMatchObject({ interrupts: 6, quiet: false });
    expect(n.timeline[2]).toMatchObject({ active: true, quiet: true });
    expect(n.hourNow).toBe(10);
    expect(n.trends.length).toBe(30);
    expect(n.trends[29]).toMatchObject({ day: "2027-01-15", activeHours: 2, offHours: 2 });
  });
  test("the route returns them with the thresholds; an empty dashboard is calm", async () => {
    const t = makeEnv();
    const r = (await (await route(request("/api/wellbeing"), t.env, makeCtx(), { now: NOW })).json()) as any;
    expect(r.thresholds).toEqual(JSON.parse(JSON.stringify(THRESHOLDS)));
    expect(r.indicators.every((i: any) => i.level === 0)).toBe(true);
    expect(r.trends.length).toBe(30);
  });
});

describe("the page's helpers (public/wellbeing-format.js)", () => {
  test("overall = the worst level, with the reasons worst first; calm says so", () => {
    const o = overall([{ name: "a", level: 1, text: "Session 3h" }, { name: "b", level: 2, text: "Waiting for you 5" }, { name: "c", level: 0, text: "x" }]);
    expect(o).toEqual({ level: 2, label: "Heavy", reasons: ["Waiting for you 5", "Session 3h"], why: "Waiting for you 5 · Session 3h" });
    expect(overall([{ level: 0, text: "x" }])).toMatchObject({ level: 0, label: "Calm", why: "Nothing is pressing right now" });
    expect(overall(undefined).label).toBe("Calm");
  });
  test("plan limit from the page's state: the highest window of any agent", () => {
    const state = { projects: [{ agents: [{ usage: [{ label: "5h", usedPercent: 40 }, { label: "weekly", usedPercent: 91 }] }, { usage: [] }] }, { agents: [] }] };
    expect(limitFromState(state)).toBe(91);
    expect(limitFromState({ projects: [] })).toBeNull();
    expect(limitIndicator(91, { limit: [70, 90] })).toEqual({ name: "limit", value: 91, level: 2, text: "Plan limit 91%" });
    expect(limitIndicator(null, { limit: [70, 90] })).toMatchObject({ level: 0, text: "Plan limit —" });
    expect([levelFor(69, [70, 90]), levelFor(70, [70, 90]), levelFor(undefined, [1, 2])]).toEqual([0, 1, 0]);
  });
  test("trend rows: last n days, quartile levels, averages; a short rest is the strong colour", () => {
    const trends = Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, activeHours: i % 5, offHours: 0, longestRest: i < 29 ? 10 : 2, avgWaiting: null }));
    const rows = trendRows(trends, 7);
    expect(rows.map((r) => r.key)).toEqual(["activeHours", "offHours", "longestRest", "avgWaiting"]);
    expect(rows[0].cells.length).toBe(7);
    expect(rows[0].avgText).toBe(`${Math.round(([3, 4, 0, 1, 2, 3, 4].reduce((a, b) => a + b, 0) / 7) * 10) / 10}h`);
    expect(rows[2].cells[6].level).toBe(4); // 2 h rest = the most load
    expect(rows[3]).toMatchObject({ avg: null, avgText: "—" });
    expect([0, 1, 2, 3, 4, 8, 9].map(interruptLevel)).toEqual([0, 1, 2, 2, 3, 3, 4]);
  });
  test("UI: the You card sits above Needs you; text only; settings and Focus go through same-origin JSON POSTs", () => {
    const html = readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf8");
    expect(html.indexOf('id="sec-you"')).toBeLessThan(html.indexOf('id="sec-inbox"'));
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\(\s*["']style/);
    for (const needle of ['"/api/wellbeing/settings"', '"/api/wellbeing/focus"', '"Content-Type": "application/json"', "aria-label", "role: \"status\""]) expect(js).toContain(needle);
    expect(js + readFileSync(join(import.meta.dir, "..", "public", "wellbeing-format.js"), "utf8")).not.toMatch(/addict|psychosis/i);
  });
});
