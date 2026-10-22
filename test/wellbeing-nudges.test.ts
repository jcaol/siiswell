/** Well-being W3: gentle nudges (session, quiet hours, usage) and the weekly reflection; dismissal per session / day / for good. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "../src/index";
import { dueNudges, weeklyReflection, type DayTrend, type Indicator } from "../src/wellbeing-metrics";
import { makeCtx, makeEnv, request } from "./d1-shim";

const NOW = Date.parse("2027-01-15T10:20:00Z");
const MIN = 60_000;
const ind = (name: string, value: number | null): Indicator => ({ name, value, level: 0, text: "" });
const base = { session: { minutes: 0, start: null as number | null }, quietActiveToday: 0, indicators: [ind("burn", null)], burnTop: null as string | null, today: "2027-01-15" };
const day = (d: string, o: Partial<DayTrend> = {}): DayTrend => ({ day: d, activeHours: 6, offHours: 0, longestRest: 9, avgWaiting: 1, interrupts: 2, ...o });

describe("nudges", () => {
  test("session >= 3 h, active in quiet hours >= 1 h, usage >= 3x; nothing below", () => {
    expect(dueNudges({ ...base, session: { minutes: 179, start: 1 } }, [], new Map())).toEqual([]);
    const all = dueNudges({ ...base, session: { minutes: 190, start: 5 }, quietActiveToday: 1, indicators: [ind("burn", 3.2)], burnTop: "web" }, [], new Map());
    expect(all.map((n) => [n.id, n.scope])).toEqual([["session", "s:5"], ["late", "d:2027-01-15"], ["burn", "d:2027-01-15"]]);
    expect(all[2]?.text[0]).toBe("Today's usage is about 3x your usual for this time of day, mostly in web.");
    expect(dueNudges({ ...base, indicators: [ind("burn", 2.9)] }, [], new Map())).toEqual([]);
    // the quiet-hours note only while the quiet hours are on
    expect(dueNudges({ ...base, quietActiveToday: 2, quietNow: false }, [], new Map())).toEqual([]);
    expect(dueNudges({ ...base, quietActiveToday: 2, quietNow: true }, [], new Map()).map((x) => x.id)).toEqual(["late"]);
  });
  test("calm wording: no countdowns, no alarm or medical words", () => {
    const text = JSON.stringify(dueNudges({ ...base, session: { minutes: 400, start: 5 }, quietActiveToday: 3, indicators: [ind("burn", 9)], burnTop: "x" }, ["r"], new Map()));
    expect(text).not.toMatch(/addict|psychosis|danger|warning|urgent|run out|countdown|left!|!/i);
  });
  test("not today hides it for this session / day; never for good; a new day brings it back", () => {
    const n = { ...base, session: { minutes: 200, start: 5 }, quietActiveToday: 2 };
    expect(dueNudges(n, [], new Map([["session", { day: "2027-01-15" }]])).map((x) => x.id)).toEqual(["late"]);
    expect(dueNudges(n, [], new Map([["session", { scope: "s:5", day: "2027-01-14" }]])).map((x) => x.id)).toEqual(["late"]);
    expect(dueNudges({ ...n, session: { minutes: 200, start: 9 } }, [], new Map([["session", { scope: "s:5", day: "2027-01-14" }]])).map((x) => x.id)).toEqual(["session", "late"]);
    expect(dueNudges(n, [], new Map([["late", { never: true }]])).map((x) => x.id)).toEqual(["session"]);
  });
});

describe("weekly reflection", () => {
  test("sentences from the last 7 days and the interruption sources; fewer than 3 days of data: none", () => {
    const week = [day("2027-01-09"), day("2027-01-10", { offHours: 2, longestRest: 14 }), day("2027-01-11", { activeHours: 2 }), day("2027-01-12", { offHours: 1 }), day("2027-01-13"), day("2027-01-14"), day("2027-01-15", { avgWaiting: 4 })];
    expect(weeklyReflection(week, [{ project: "web", n: 41 }, { project: "api", n: 59 }].sort((a, b) => b.n - a.n))).toEqual([
      "You were active for about 38 hours over the last 7 days.",
      "On 2 of those days you were active during your quiet hours.",
      "Your longest break was 14 hours, on Sun.",
      "Most interruptions came from api (59% of 100).",
      "In active hours, about 1.4 things were waiting for you on average.",
    ]);
    expect(weeklyReflection([day("a"), day("b"), day("c", { longestRest: null })], [])).toEqual([]);
    expect(weeklyReflection([day("2027-01-13"), day("2027-01-14"), day("2027-01-15")], [])[1]).toBe("You kept your quiet hours free on every day.");
  });
});

describe("API: nudges in GET /api/wellbeing, dismissal by POST", () => {
  test("a long session shows the nudge; not today / never / reset; switched off in the settings", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const ev = t.db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'h', 'web', 'status', 'host', 'info', 'x', ?, ?)");
    for (let m = 0; m <= 200; m += 20) ev.run(`e${m}`, NOW - m * MIN, NOW);
    const get = async () => ((await (await route(request("/api/wellbeing"), t.env, ctx, { now: NOW })).json()) as any).nudges.map((n: any) => n.id);
    const post = (path: string, body: unknown) => route(request(path, { body }), t.env, ctx, { now: NOW });
    expect(await get()).toEqual(["session"]);
    expect((await post("/api/wellbeing/nudge", { id: "session", until: "today" })).status).toBe(200);
    expect(await get()).toEqual([]);
    expect((await post("/api/wellbeing/nudge", { id: "session", until: "reset" })).status).toBe(200);
    expect(await get()).toEqual(["session"]);
    await post("/api/wellbeing/nudge", { id: "session", until: "never" });
    expect(await get()).toEqual([]);
    await post("/api/wellbeing/nudge", { id: "session", until: "reset" });
    await post("/api/wellbeing/settings", { nudges: false });
    expect(await get()).toEqual([]);
    for (const bad of [{ id: "evil", until: "today" }, { id: "session", until: "tomorrow" }, { id: "session" }, "x"]) expect((await post("/api/wellbeing/nudge", bad)).status).toBe(400);
  });
  test("the page renders nudges as text with Not today and Never", () => {
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    for (const needle of ['"Not today"', '"Never"', '"/api/wellbeing/nudge"', "Show dismissed nudges again"]) expect(js).toContain(needle);
  });
});
