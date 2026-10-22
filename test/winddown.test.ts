/** Human load step 2: the pace nudge and wind-down (safe-to-leave summary, operator_status, morning summary). */
import { describe, expect, test, afterEach } from "bun:test";
import { configureDashboardTz } from "../src/tz";
import { route } from "../src/index";
import { dueNudges } from "../src/wellbeing-metrics";
import { WB_DEFAULTS, validateSettings } from "../src/wellbeing";
import { MORNING_GRACE_MS, awayWindow, morningMessage, operatorStatus, runWindDown, windDownMessage } from "../src/wellbeing-winddown";
import { PACE_NUDGE_MINUTES, rapidMinutes } from "../src/wellbeing-you";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

// a route() with DASHBOARD_TZ sets the process-wide zone: back to the default after each test
afterEach(() => {
  configureDashboardTz({}); // reset
});

const MIN = 60_000;
const H = 3_600_000;
const s = { ...WB_DEFAULTS, tz: "Europe/London", windDown: "23:00", morning: "07:00" };
// 2027-07-01 is BST (UTC+1): 23:00 London = 22:00 UTC
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+01:00`);

describe("the away window (pure)", () => {
  test("over midnight, London time: 23:00 -> 07:00 is away; the night is the evening's day", () => {
    expect(awayWindow(s, at("2027-07-01", "22:59")).away).toBe(false);
    const w = awayWindow(s, at("2027-07-01", "23:00"));
    expect(w).toEqual({ away: true, night: "2027-07-01", from: at("2027-07-01", "23:00"), until: at("2027-07-02", "07:00") });
    expect(awayWindow(s, at("2027-07-02", "06:59"))).toMatchObject({ away: true, night: "2027-07-01" });
    expect(awayWindow(s, at("2027-07-02", "07:00"))).toMatchObject({ away: false, night: "2027-07-01" });
  });
  test("a same-day window, and off", () => {
    const d = { ...s, windDown: "01:00", morning: "06:00" };
    expect(awayWindow(d, at("2027-07-01", "03:00"))).toMatchObject({ away: true, night: "2027-07-01" });
    expect(awayWindow(d, at("2027-07-01", "12:00")).away).toBe(false);
    expect(awayWindow({ ...s, windDown: "" }, at("2027-07-01", "23:30"))).toEqual({ away: false, night: null, from: null, until: null });
  });
  test("settings: windDown HH:MM or empty (off); morning HH:MM", () => {
    expect(validateSettings({ windDown: "" }).ok).toBe(true);
    expect(validateSettings({ windDown: "22:30", morning: "06:45" }).ok).toBe(true);
    expect(validateSettings({ windDown: "11pm" }).ok).toBe(false);
    expect(validateSettings({ morning: "" }).ok).toBe(false);
  });
});

describe("operator_status", () => {
  test("pure: away with the morning time, or available", () => {
    expect(operatorStatus(s, at("2027-07-01", "23:30"))).toMatchObject({ status: "away", until: new Date(at("2027-07-02", "07:00")).toISOString() });
    expect(operatorStatus(s, at("2027-07-01", "23:30")).message).toContain("Continue on your own");
    expect(operatorStatus(s, at("2027-07-01", "15:00")).status).toBe("available");
  });
  test("the MCP tool: read-only, no arguments, answers from the dashboard's settings", async () => {
    const t = makeEnv({ DASHBOARD_TZ: "Europe/London" });
    const token = await addSource(t.db, "laptop", "client");
    const call = (args: unknown, now: number) => route(request("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "operator_status", arguments: args } }, headers: { Accept: "application/json, text/event-stream" } }), t.env, makeCtx(), { now });
    const away = (await (await call({}, at("2027-07-01", "23:30"))).json()) as any;
    expect(JSON.parse(away.result.content[0].text).status).toBe("away");
    const day = (await (await call({}, at("2027-07-01", "15:00"))).json()) as any;
    expect(JSON.parse(day.result.content[0].text).status).toBe("available");
    const bad = (await (await call({ x: 1 }, at("2027-07-01", "15:00"))).json()) as any;
    expect(bad.result.isError).toBe(true);
    expect(t.db.rows<{ mut_count: number }>("SELECT mut_count FROM sources WHERE name = 'laptop'")[0]?.mut_count ?? 0).toBe(0); // no budget spent
  });
});

describe("the wind-down and morning summaries (the ticker)", () => {
  test("once per night at wind-down, once in the morning (within the grace), never twice; counts in the text", async () => {
    const t = makeEnv();
    const db = t.env.DB;
    t.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES ('k1', 's', 'mcp', 'c', 'p', 'a', 'm-1', 'x', 'running', 1, 1)").run();
    const sent: Array<{ title: string; body: string }> = [];
    const stamps = () => {
      const m = new Map(t.db.rows<{ k: string; v: string }>("SELECT k, v FROM wb_settings WHERE k IN ('rt:wind', 'rt:morning')").map((r) => [r.k, r.v]));
      return { wind: m.get("rt:wind") ?? "", morning: m.get("rt:morning") ?? "" };
    };
    const tick = (now: number) => runWindDown(db, s, stamps(), now, "https://dash.example.com", async (m) => { sent.push(m); return true; });
    expect(await tick(at("2027-07-01", "22:00"))).toBeNull();
    expect(await tick(at("2027-07-01", "23:01"))).toBe("wind");
    expect(await tick(at("2027-07-01", "23:30"))).toBeNull(); // once per night
    expect(sent[0]!.title).toBe("Time to wind down");
    expect(sent[0]!.body).toContain("1 task still running");
    // overnight: the task finishes
    t.db.sqlite.query("UPDATE tasks SET state = 'done', updated = ? WHERE key = 'k1'").run(at("2027-07-02", "02:00"));
    expect(await tick(at("2027-07-02", "06:59"))).toBeNull(); // still away
    expect(await tick(at("2027-07-02", "07:02"))).toBe("morning");
    expect(await tick(at("2027-07-02", "07:30"))).toBeNull();
    expect(sent[1]).toMatchObject({ title: "Good morning" });
    expect(sent[1]!.body).toContain("1 task done");
    // a night without a wind-down (the ticker was down): no morning summary; nor one long after the morning
    t.db.sqlite.run("DELETE FROM wb_settings");
    expect(await tick(at("2027-07-03", "07:05"))).toBeNull();
    expect(MORNING_GRACE_MS).toBe(3 * H);
    expect(sent.length).toBe(2);
  });
  test("messages: plain and calm", () => {
    expect(windDownMessage({ running: 2, waiting: 1, done: 0, blocked: 0 }, "07:00", "https://d.example").body).toBe("2 tasks still running. Safe to leave: the agents carry on and keep their questions for the morning (07:00). 1 thing still waits for you; answer now or it waits until 07:00.");
    expect(morningMessage({ running: 0, waiting: 0, done: 3, blocked: 1 }, "https://d.example").body).toBe("Overnight: 3 tasks done, 1 blocked, 0 still running.");
  });
});

describe("the pace nudge", () => {
  const base = { session: { minutes: 0, start: null }, quietActiveToday: 0, indicators: [], burnTop: null, today: "2027-07-01", quietNow: false };
  test("20+ minutes of rapid-fire replies in the last hour; once per hour (scope), Not today / Never respected", () => {
    expect(PACE_NUDGE_MINUTES).toBe(20);
    const now = Date.UTC(2027, 6, 1, 10, 30);
    const cur = Date.UTC(2027, 6, 1, 10);
    const hours = [{ h: cur - H, prompts: 60, approvals: 0, rapid: 40, rapidMin: 16, latN: 0, latP50: null }, { h: cur, prompts: 40, approvals: 0, rapid: 30, rapidMin: 12, latN: 0, latP50: null }];
    const rm = rapidMinutes(hours, now);
    expect(rm).toBe(20); // 12 + 16 x 0.5
    const due = dueNudges({ ...base, rapidMinutes: rm, hourKey: "2027-07-01T10" }, [], new Map());
    expect(due).toEqual([{ id: "pace", title: "Your pace", text: ["Agents can wait — batch your replies every 10 min?"], scope: "h:2027-07-01T10" }]);
    expect(dueNudges({ ...base, rapidMinutes: 19, hourKey: "2027-07-01T10" }, [], new Map())).toEqual([]);
    expect(dueNudges({ ...base, rapidMinutes: 25, hourKey: "2027-07-01T10" }, [], new Map([["pace", { day: "2027-07-01" }]]))).toEqual([]);
    expect(dueNudges({ ...base, rapidMinutes: 25, hourKey: "2027-07-01T10" }, [], new Map([["pace", { never: true }]]))).toEqual([]);
    expect(MIN).toBe(60_000);
  });
});
