/** Stress round 2: the rules (15-minute gauge, nudge caps / cooldowns) and the items, one describe each. */
import { afterEach, describe, expect, test } from "bun:test";
import { configureDashboardTz } from "../src/tz";
import { route } from "../src/index";
import { NUDGE_LIMITS, dueNudges, nudgeAllowed } from "../src/wellbeing-metrics";
import { SHOWN_READING_MAX_AGE_MS, shownLevel } from "../src/wellbeing";
import { makeCtx, makeEnv, request } from "./d1-shim";

afterEach(() => {
  configureDashboardTz({}); // reset
});

const MIN = 60_000;
const H = 3_600_000;

describe("rules: the gauge moves every 15 minutes, nudges have caps and cooldowns", () => {
  test("the gauge shows the stored reading while fresh (<= 20 min), not a live value", () => {
    expect(SHOWN_READING_MAX_AGE_MS).toBe(20 * MIN);
    expect(shownLevel({ at: 0, value: 33 }, 80, 15 * MIN)).toBe(33);
    expect(shownLevel({ at: 0, value: 33 }, 80, 21 * MIN)).toBeGreaterThan(33);
    expect(shownLevel(null, 80, 0)).toBe(80);
  });
  test("a nudge: at most perDay new appearances a day, a new one only after its cooldown; the one on screen stays", () => {
    const day = "2027-07-01";
    expect(NUDGE_LIMITS.microbreak).toEqual({ perDay: 4, cooldownMs: 2 * H });
    expect(nudgeAllowed("microbreak", "b:2", { sd: day, sn: 1, sl: 0, ss: "b:1" }, day, H)).toBe(false); // cooldown
    expect(nudgeAllowed("microbreak", "b:2", { sd: day, sn: 1, sl: 0, ss: "b:1" }, day, 2 * H)).toBe(true);
    expect(nudgeAllowed("microbreak", "b:5", { sd: day, sn: 4, sl: 0, ss: "b:4" }, day, 9 * H)).toBe(false); // daily cap
    expect(nudgeAllowed("microbreak", "b:4", { sd: day, sn: 4, sl: 0, ss: "b:4" }, day, 9 * H)).toBe(true); // on screen
    expect(nudgeAllowed("microbreak", "b:5", { sd: "2027-06-30", sn: 4, sl: 0, ss: "b:4" }, day, 9 * H)).toBe(true); // a new day
    const base = { session: { minutes: 200, start: 5 }, quietActiveToday: 0, indicators: [], burnTop: null, today: day };
    expect(dueNudges(base, [], new Map([["session", { sd: day, sn: 2, sl: 0, ss: "s:1" }]]), 10 * H)).toEqual([]);
  });
  test("the page reports a shown nudge once; the count and the time are stored", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const post = (body: unknown, now: number) => route(request("/api/wellbeing/nudge", { body }), t.env, ctx, { now });
    expect((await post({ id: "session", until: "shown", scope: "s:5" }, 10 * H)).status).toBe(200);
    expect((await post({ id: "session", until: "shown", scope: "s:5" }, 10 * H + MIN)).status).toBe(200); // same appearance
    const v = JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'nudge:session'")[0]!.v);
    expect(v).toMatchObject({ sn: 1, sl: 10 * H, ss: "s:5" });
  });
});

import { ENERGY_START, energy, energyDay } from "../src/wellbeing-energy";
import { WB_DEFAULTS, validateSettings } from "../src/wellbeing";
import { energyLight } from "../public/wellbeing-light.js";

describe("1. energy battery", () => {
  const s = { ...WB_DEFAULTS, tz: "UTC" }; // quiet 23:00-07:00
  const T = Date.UTC(2027, 6, 3, 12, 0);
  const hr = (h: number, n: number) => ({ h, prompts: n, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null });
  test("rest charges (more at night), operator load drains (count, switches, after-hours); 0-100", () => {
    expect(energy([], new Map(), s, T).level).toBe(100); // 48 h without input: full
    const busy = Array.from({ length: 48 }, (_, i) => hr(T - (47 - i) * H, 80));
    const drained = energy(busy, new Map(), s, T);
    expect(drained.level).toBe(0);
    expect(drained.series.every((p) => p.kind === "drain")).toBe(true);
    // one hour each way from the start level: a day hour of rest +6, a night hour +12; a busy day hour -(3 + 5) and with 2 switches -(3 + 5 + 2)
    const one = (h: number, n: number, sw = 0) => energy(n ? [hr(h, n)] : [], new Map(sw ? [[h, sw]] : []), s, h + H - 1).series.at(-1)!.level;
    expect(ENERGY_START).toBe(60);
    const day = Date.UTC(2027, 6, 3, 10);
    const lvlBefore = energy([], new Map(), s, day - 1).level;
    expect(lvlBefore).toBe(100);
    expect(one(day, 40) < one(day, 0)).toBe(true);
    expect(one(day, 40, 2) < one(day, 40)).toBe(true);
  });
  test("today's hours for the chart; colours from the settings (green >= 50, yellow >= 25)", () => {
    const e = energy([hr(Date.UTC(2027, 6, 3, 9), 30)], new Map(), s, T);
    const d = energyDay(e.series, s, T);
    expect(d.length).toBe(24);
    expect(d[9]!.kind).toBe("drain");
    expect(d[13]!.level).toBeNull(); // not reached yet
    expect([energyLight(80, {})!.key, energyLight(30, {})!.key, energyLight(10, {})!.key]).toEqual(["green", "yellow", "red"]);
    expect(validateSettings({ energyGreen: 60, energyYellow: 30 }).ok).toBe(true);
    expect(validateSettings({ energyGreen: 20, energyYellow: 30 }).ok).toBe(false);
  });
});

import { afterHoursRatio, lightAbove, lightBelow, restBlock, restGap } from "../src/wellbeing-rest";

describe("3. after-hours ratio (7-day rolling)", () => {
  const s = { ...WB_DEFAULTS, tz: "UTC" }; // quiet 23:00-07:00
  const hr = (iso: string) => ({ h: Date.parse(iso), prompts: 1, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null });
  const NOW = Date.parse("2027-07-08T12:00:00Z");
  test("the share of active hours inside the quiet hours; yellow > 20 %, red > 35 % (editable)", () => {
    const hours = [hr("2027-07-07T23:00:00Z"), hr("2027-07-07T10:00:00Z"), hr("2027-07-07T11:00:00Z"), hr("2027-07-06T02:00:00Z"), hr("2027-06-20T02:00:00Z") /* older than 7 days */];
    expect(afterHoursRatio(hours, s, NOW)).toEqual({ pct: 50, active: 4, after: 2 });
    expect([lightAbove(20, 20, 35), lightAbove(21, 20, 35), lightAbove(36, 20, 35), lightAbove(null, 20, 35)]).toEqual(["green", "yellow", "red", null]);
    const b = restBlock(hours, [], s, NOW);
    expect(b.afterHours).toMatchObject({ pct: 50, light: "red" });
    expect(b.afterHours.action).toContain("wind-down");
    expect(validateSettings({ afterHoursYellow: 25, afterHoursRed: 40 }).ok).toBe(true);
    expect(validateSettings({ afterHoursYellow: 40, afterHoursRed: 25 }).ok).toBe(false);
  });
});

describe("4. longest rest gap per day", () => {
  const s = { ...WB_DEFAULTS, tz: "UTC" };
  const hr = (iso: string) => ({ h: Date.parse(iso), prompts: 1, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null });
  test("the longest run without input in the 24 h before the day's noon; yellow < 6 h, red < 4 h (editable)", () => {
    // input every hour 12:00 day-1 .. 11:00 day except 01:00-04:59 (4 h rest)
    const hours = Array.from({ length: 24 }, (_, i) => Date.parse("2027-07-06T12:00:00Z") + i * H).filter((t) => { const h = new Date(t).getUTCHours(); return h < 1 || h > 4; }).map((t) => hr(new Date(t).toISOString()));
    expect(restGap(hours, "2027-07-07", s, Date.parse("2027-07-07T15:00:00Z"))).toBe(4);
    expect(restGap(hours, "2027-07-08", s, Date.parse("2027-07-07T15:00:00Z"))).toBeNull(); // window still running
    expect(restGap([], "2027-07-07", s, Date.parse("2027-07-07T15:00:00Z"))).toBe(24);
    expect([lightBelow(6, 6, 4), lightBelow(5, 6, 4), lightBelow(3, 6, 4)]).toEqual(["green", "yellow", "red"]);
    const b = restBlock(hours, ["2027-07-06", "2027-07-07"], s, Date.parse("2027-07-07T15:00:00Z"));
    expect(b.lastGap).toMatchObject({ day: "2027-07-07", hours: 4, light: "yellow" });
    expect(validateSettings({ restYellow: 8, restRed: 5 }).ok).toBe(true);
    expect(validateSettings({ restYellow: 3, restRed: 5 }).ok).toBe(false);
  });
});

import { readiness } from "../src/wellbeing-readiness";

describe("2. morning readiness", () => {
  const s = { ...WB_DEFAULTS, tz: "UTC", morning: "07:00" };
  const hr = (iso: string) => ({ h: Date.parse(iso), prompts: 2, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null });
  // yesterday 09:00-01:59 busy (late), rest 02:00-07:59 (6 h)
  const hours = Array.from({ length: 17 }, (_, i) => hr(new Date(Date.parse("2027-07-06T09:00:00Z") + i * H).toISOString()));
  test("from the morning time to noon only; label from rest, yesterday's load and after hours; ONE suggestion", () => {
    expect(readiness(hours, new Map(), s, Date.parse("2027-07-07T06:59:00Z"))).toBeNull();
    expect(readiness(hours, new Map(), s, Date.parse("2027-07-07T12:00:00Z"))).toBeNull();
    const r = readiness(hours, new Map([["2027-07-06", 75]]), s, Date.parse("2027-07-07T08:00:00Z"))!;
    expect(r.rest).toEqual({ hours: 6, light: "green" }); // 02:00-07:59 without input since 18:00 (up to now, 08:00)
    expect(r.yesterday).toMatchObject({ stress: 75, light: "red" });
    expect(r.afterHours).toEqual({ pct: 18, light: "green" }); // 23:00 + 00:00 + 01:00 = 3 of 17 hours
    expect(["Ready", "Take it steady", "Go easy today"]).toContain(r.label);
    expect(r.suggestion).toContain("projects or fewer today");
  });
  test("a calm night and day: Ready, with a plain suggestion", () => {
    const calm = [hr("2027-07-06T10:00:00Z"), hr("2027-07-06T11:00:00Z")];
    const r = readiness(calm, new Map([["2027-07-06", 20]]), s, Date.parse("2027-07-07T09:00:00Z"))!;
    expect(r.label).toBe("Ready");
    expect(r.suggestion).toContain("Keep to your plan");
  });
});

import { applyPushPolicy } from "../src/wellbeing";
import { blockAt, operatorStatus } from "../src/wellbeing-winddown";

describe("5. agent-free blocks", () => {
  const s = { ...WB_DEFAULTS, tz: "UTC", freeBlocks: ["13:00-14:00", "23:30-00:30"] };
  const at = (iso: string) => Date.parse(iso);
  test("inside a block (also over midnight): away for agents until its end", () => {
    expect(blockAt(s, at("2027-07-01T13:30:00Z"))).toEqual({ in: true, from: at("2027-07-01T13:00:00Z"), until: at("2027-07-01T14:00:00Z") });
    expect(blockAt(s, at("2027-07-01T14:00:00Z")).in).toBe(false);
    expect(blockAt(s, at("2027-07-02T00:10:00Z"))).toEqual({ in: true, from: at("2027-07-01T23:30:00Z"), until: at("2027-07-02T00:30:00Z") });
    const st = operatorStatus(s, at("2027-07-01T13:30:00Z"));
    expect(st).toMatchObject({ status: "away", until: "2027-07-01T14:00:00.000Z" });
    expect(st.message).toContain("agent-free block");
    expect(validateSettings({ freeBlocks: ["09:00-10:00"] }).ok).toBe(true);
    expect(validateSettings({ freeBlocks: ["9-10"] }).ok).toBe(false);
    expect(validateSettings({ freeBlocks: ["01:00-02:00", "03:00-04:00", "05:00-06:00", "07:00-08:00"] }).ok).toBe(false);
  });
  test("every push waits during a block (approvals too); outside it, as before", () => {
    const item = (rule: string) => ({ key: rule, rule, severity: "warn", host: "h", project: "p", agent: null, opened: 0, pushCount: 1, lastPushed: 0, summarizedAt: null }) as never;
    const r = applyPushPolicy([item("approval-waiting"), item("blocked")], { now: at("2027-07-01T13:30:00Z"), settings: { ...s, groupWaitSec: 0 }, focusUntil: 0, quietLast: new Map() });
    expect([r.send.length, r.hold.length]).toEqual([0, 2]);
    const o = applyPushPolicy([item("approval-waiting")], { now: at("2027-07-01T15:00:00Z"), settings: { ...s, groupWaitSec: 0 }, focusUntil: 0, quietLast: new Map() });
    expect(o.send.length).toBe(1);
  });
  test("the summary at the block's end (the ticker): held items go out at once, titled for the block", async () => {
    const { runDigest, loadWbState } = await import("../src/wellbeing");
    const t = makeEnv();
    t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('settings', ?, 0)").run(JSON.stringify({ tz: "UTC", freeBlocks: ["13:00-14:00"], quietStart: "23:00", quietEnd: "07:00" }));
    t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, push_count, summarized_at) VALUES ('a1', 'approval-waiting', 'warn', 'host', 'h', 'p', 'x', ?, 0, ?)").run(at("2027-07-01T13:10:00Z"), at("2027-07-01T13:11:00Z"));
    const sent: Array<{ title: string }> = [];
    const send = async (m: { title: string }) => { sent.push(m); return true; };
    const run = async (iso: string) => runDigest(t.env.DB, (await loadWbState(t.env.DB, at(iso)))!, at(iso), "https://d", send as never);
    expect(await run("2027-07-01T13:30:00Z")).toBe(0);
    expect(await run("2027-07-01T14:01:00Z")).toBe(1);
    expect(sent[0]!.title).toBe("After your agent-free block");
  });
});

describe("6. timeline band on the 24 h chart", () => {
  test("blue = rest, orange = your input per hour of today, the hour's traffic-light dot; labelled for screen readers", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    const combo = js.slice(js.indexOf("function dayCombo"), js.indexOf("const WD ="));
    for (const needle of ['"wb-band"', '"load" : x.kind === "charge" ? "rest"', "lightOf(hours[x.hour].stress, lt)", '"rest"', '"your input"', 'role: "img"']) expect(combo).toContain(needle);
    const css = readFileSync(join(import.meta.dir, "..", "public", "style.css"), "utf8");
    expect(css).toMatch(/\.wb-band-c\.rest \{[^}]*--wb-steady-line/); // blue
    expect(css).toMatch(/\.wb-band-c\.load \{[^}]*--wb-strained-line/); // orange
    const e = energy([{ h: Date.UTC(2027, 6, 3, 9), prompts: 5, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null }], new Map(), { ...WB_DEFAULTS, tz: "UTC" }, Date.UTC(2027, 6, 3, 12));
    const day = energyDay(e.series, { tz: "UTC" }, Date.UTC(2027, 6, 3, 12));
    expect([day[8]!.kind, day[9]!.kind, day[10]!.kind]).toEqual(["charge", "drain", "charge"]);
  });
});

import { keptDays } from "../src/wellbeing-rest";

describe("7. kept days (count good days, no streaks)", () => {
  const s = { ...WB_DEFAULTS, tz: "UTC", keptEnd: "23:00", keptRest: 8, morning: "07:00" };
  const hr = (iso: string) => ({ h: Date.parse(iso), prompts: 1, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null });
  test("of the last 7 completed days: ended before 23:00, and rested 8 h or more", () => {
    const NOW = Date.parse("2027-07-08T12:00:00Z");
    const hours = [
      hr("2027-07-07T23:00:00Z"), // 7 Jul did not end before 23:00
      hr("2027-07-06T22:00:00Z"), // 6 Jul ended before 23:00
      hr("2027-07-05T01:00:00Z"), hr("2027-07-05T05:00:00Z"), // the night before 5 Jul: rests of 3 h, then 6 h... before noon
    ];
    // measured throughout (data every hour): the counts below are about the input, not about coverage
    const all = { first: 0, hours: Array.from({ length: 24 * 14 }, (_, i) => NOW - i * H) };
    const k = keptDays(hours, s, NOW, all);
    expect(k.days).toBe(7);
    expect(k.endedEarly).toBe(5); // not 7 Jul (23:00) nor 4 Jul (input at 01:00 that night)
    expect(k.rested).toBe(7); // every 24 h window before noon still has a run of 8 h or more without input
    const tight = keptDays([...hours, ...Array.from({ length: 10 }, (_, i) => hr(new Date(Date.parse("2027-07-06T12:00:00Z") + i * 2 * H).toISOString()))], s, NOW, all);
    expect(tight.rested).toBe(6); // input every 2 h from 6 Jul noon: the window before 7 Jul noon has no 8 h rest
    expect(validateSettings({ keptEnd: "22:30", keptRest: 7 }).ok).toBe(true);
    expect(validateSettings({ keptRest: 0 }).ok).toBe(false);
  });
});

import { switchSummary } from "../src/wellbeing-rest";
import { switchesByHour } from "../src/wellbeing";

describe("8. context-switch counter", () => {
  test("distinct project / app pairs per hour - 1, from the usage; this hour and today's busiest; light (editable)", async () => {
    const t = makeEnv();
    const ins = t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, 'h', ?, ?, 'claude', 'm', 1, 1, 0, 0, 0, 3, 0, 1)");
    for (const [hour, p, a] of [["2027-07-01T10", "web", "claude-cli"], ["2027-07-01T10", "api", "claude-cli"], ["2027-07-01T10", "api", "codex-cli"], ["2027-07-01T11", "web", "claude-cli"]] as const) ins.run(hour, p, a);
    const m = await switchesByHour(t.env.DB, Date.UTC(2027, 6, 1, 0), "UTC");
    expect([...m.entries()]).toEqual([[Date.UTC(2027, 6, 1, 10), 2], [Date.UTC(2027, 6, 1, 11), 0]]);
    const s = { ...WB_DEFAULTS, tz: "UTC" };
    expect(switchSummary(m, s, Date.UTC(2027, 6, 1, 10, 30))).toMatchObject({ now: 2, max: 2, maxHour: 10, light: "green" });
    expect(switchSummary(new Map([[Date.UTC(2027, 6, 1, 10), 5]]), s, Date.UTC(2027, 6, 1, 10, 30)).light).toBe("yellow");
    expect(switchSummary(new Map([[Date.UTC(2027, 6, 1, 10), 9]]), s, Date.UTC(2027, 6, 1, 10, 30))).toMatchObject({ light: "red", action: expect.stringContaining("agent-free block") });
    expect(validateSettings({ switchYellow: 3, switchRed: 6 }).ok).toBe(true);
    expect(validateSettings({ switchYellow: 6, switchRed: 3 }).ok).toBe(false);
  });
});

import { projectsToday } from "../src/wellbeing";

describe("9. daily load target (rings)", () => {
  test("settings, today's projects from the usage, the rings in the page (full = amber cue, never red)", async () => {
    expect([WB_DEFAULTS.maxProjects, WB_DEFAULTS.maxActiveHours]).toEqual([4, 10]);
    expect(validateSettings({ maxProjects: 3, maxActiveHours: 8 }).ok).toBe(true);
    expect(validateSettings({ maxProjects: 0 }).ok).toBe(false);
    expect(validateSettings({ maxActiveHours: 25 }).ok).toBe(false);
    const t = makeEnv();
    const ins = t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, 'h', ?, 'claude-cli', 'claude', 'm', 1, 1, 0, 0, 0, 3, 0, 1)");
    for (const [hour, p] of [["2027-07-01T09", "web"], ["2027-07-01T10", "api"], ["2027-07-01T11", "web"], ["2027-06-30T23", "old"]] as const) ins.run(hour, p);
    expect(await projectsToday(t.env.DB, "2027-07-01")).toBe(2);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    const rings = js.slice(js.indexOf("function targetRings"), js.indexOf("/** One status line"));
    expect(rings).toContain('pct >= 100 ? "strained" : "calm"');
    expect(rings).not.toContain('"over"');
    expect(rings).toContain("a good moment to stop");
  });
});

describe("10. micro-break prompt", () => {
  const base = { session: { minutes: 0, start: null }, quietActiveToday: 0, indicators: [], burnTop: null, today: "2027-07-01", microBreakMin: 90, microSlot: "2027-07-01T10" };
  test("only after long continuous activity of your own, not in Focus; once per 2 h and 4 a day", () => {
    expect(dueNudges({ ...base, youSessionMin: 89 }, [], new Map(), 10 * H)).toEqual([]);
    const due = dueNudges({ ...base, youSessionMin: 95 }, [], new Map(), 10 * H);
    expect(due).toEqual([{ id: "microbreak", title: "Worth a break", text: ["You've been at it a while — a five-minute break now? The agents keep going."], scope: "b:2027-07-01T10" }]);
    expect(dueNudges({ ...base, youSessionMin: 95, focus: true }, [], new Map(), 10 * H)).toEqual([]);
    // shown at 10:00: the next 2-hour slot only after the cooldown; 4 a day at most
    const shown = new Map([["microbreak", { sd: "2027-07-01", sn: 1, sl: 10 * H, ss: "b:2027-07-01T10" }]]);
    expect(dueNudges({ ...base, youSessionMin: 200, microSlot: "2027-07-01T12" }, [], shown, 11 * H)).toEqual([]);
    expect(dueNudges({ ...base, youSessionMin: 200, microSlot: "2027-07-01T12" }, [], shown, 12 * H).length).toBe(1);
    const four = new Map([["microbreak", { sd: "2027-07-01", sn: 4, sl: 10 * H, ss: "b:2027-07-01T10" }]]);
    expect(dueNudges({ ...base, youSessionMin: 200, microSlot: "2027-07-01T16" }, [], four, 16 * H)).toEqual([]);
    expect(validateSettings({ microBreakMin: 60 }).ok).toBe(true);
    expect(validateSettings({ microBreakMin: 5 }).ok).toBe(false);
  });
});

describe("11. one-tap self-rating", () => {
  test("one value per day (1-3, no text), replaced when tapped again; returned with the day for the trend", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const NOW = Date.UTC(2027, 6, 1, 18);
    const post = (body: unknown) => route(request("/api/wellbeing/rating", { body }), t.env, ctx, { now: NOW });
    expect((await post({ value: 2 })).status).toBe(200);
    expect((await post({ value: 3 })).status).toBe(200);
    expect((await post({ value: 4 })).status).toBe(400);
    expect((await post({ value: "great", note: "text" })).status).toBe(400);
    expect(t.db.rows("SELECT day, hour, name, value FROM wb_metrics WHERE name = 'rating'")).toEqual([{ day: "2027-07-01", hour: -1, name: "rating", value: 3 }]);
    const d = (await (await route(request("/api/wellbeing"), t.env, ctx, { now: NOW })).json()) as { ratings: Record<string, number> };
    expect(d.ratings).toEqual({ "2027-07-01": 3 });
  });
});

describe("reviewer5 LOW: the pace nudge's hour scope", () => {
  test("Not today with an h: scope (and b: for the micro-break) is accepted and stored", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const post = (body: unknown) => route(request("/api/wellbeing/nudge", { body }), t.env, ctx, { now: 10 * H });
    expect((await post({ id: "pace", until: "today", scope: "h:2027-07-01T10" })).status).toBe(200);
    expect(JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'nudge:pace'")[0]!.v).scope).toBe("h:2027-07-01T10");
    expect((await post({ id: "microbreak", until: "today", scope: "b:2027-07-01T10" })).status).toBe(200);
    expect(JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'nudge:microbreak'")[0]!.v).scope).toBe("b:2027-07-01T10");
  });
});

describe("blocks: critical Time-Sensitive items still go out; a block must have a length", () => {
  test("host-offline / critical agent-stuck / usage-limit (critical) are pushed during a block; the rest is held", () => {
    const s = { ...WB_DEFAULTS, tz: "UTC", freeBlocks: ["13:00-14:00"], groupWaitSec: 0 };
    const item = (rule: string, severity: string) => ({ key: `${rule}-${severity}`, rule, severity, host: "h", project: "p", agent: null, opened: 0, pushCount: 1, lastPushed: 0, summarizedAt: null }) as never;
    const r = applyPushPolicy([item("host-offline", "critical"), item("agent-stuck", "critical"), item("usage-limit", "critical"), item("approval-waiting", "warn"), item("blocked", "warn"), item("agent-stuck", "warn")],
      { now: Date.parse("2027-07-01T13:30:00Z"), settings: s, focusUntil: 0, quietLast: new Map() });
    expect(r.send.map((i: any) => i.key).sort()).toEqual(["agent-stuck-critical", "host-offline-critical", "usage-limit-critical"]);
    expect(r.hold.map((i: any) => i.key).sort()).toEqual(["agent-stuck-warn", "approval-waiting-warn", "blocked-warn"]);
    expect(validateSettings({ freeBlocks: ["13:00-13:00"] }).ok).toBe(false);
  });
});
