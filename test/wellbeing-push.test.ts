/** D. Well-being reminders as push: gentle, capped, never in Focus / quiet hours / an agent-free block. */
import { describe, expect, test } from "bun:test";
import { WB_DEFAULTS, loadWbState, validateSettings } from "../src/wellbeing";
import { WB_PUSH_DAILY_CAP, runWellbeingPushes, wbPushCandidates } from "../src/wellbeing-push";
import { makeEnv } from "./d1-shim";

const H = 3_600_000;
const MIN = 60_000;
const base = { burn: null, rapidMin: 0, youSessionMin: 0, microBreakMin: 90, quiet: false, activeThisHour: false };
const BANNED = /\b(danger|warning|critical|alert|emergency|urgent)\b|!/i;

describe("candidates (pure)", () => {
  test("each reminder with its threshold; gentle words; in the quiet hours only the after-hours one when activity begins", () => {
    const all = wbPushCandidates({ ...base, burn: 3.4, rapidMin: 25, youSessionMin: 200 });
    expect(all.map((c) => c.id)).toEqual(["microbreak", "pace", "session", "burn"]);
    for (const c of all) expect([c.title, c.body].some((t) => BANNED.test(t))).toBe(false);
    expect(wbPushCandidates({ ...base, youSessionMin: 200, quiet: true }).map((c) => c.id)).toEqual([]);
    expect(wbPushCandidates({ ...base, quiet: true, activeThisHour: true }).map((c) => c.id)).toEqual(["late"]);
    expect(wbPushCandidates(base)).toEqual([]);
  });
  test("the setting: on by default, a boolean", () => {
    expect(WB_DEFAULTS.wellbeingPush).toBe(true);
    expect(validateSettings({ wellbeingPush: false }).ok).toBe(true);
    expect(validateSettings({ wellbeingPush: "yes" }).ok).toBe(false);
  });
});

describe("the ticker's push step", () => {
  // four busy hours in a row of a person's app (usage), no quiet hours: the micro-break reminder is due
  const NOW = Date.UTC(2027, 6, 10, 15, 7); // minute 7 of a quarter hour: the stress minute
  const boot = (settings: Record<string, unknown> = {}) => {
    const t = makeEnv({ DASHBOARD_TZ: "UTC" });
    t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('settings', ?, 0)").run(JSON.stringify({ tz: "UTC", quietStart: "00:00", quietEnd: "00:00", ...settings }));
    const ins = t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, 'mac', 'p', 'claude-desktop', 'claude', 'm', 1, 1, 0, 0, 0, ?, 0, 1)");
    for (let h = 12; h <= 15; h++) ins.run(`2027-07-10T${h}`, 30);
    for (let d = 1; d <= 5; d++) ins.run(`2027-07-0${10 - d}T12`, 30);
    const sent: Array<{ title: string; tag?: string }> = [];
    const send = async (m: { title: string; tag?: string }) => { sent.push(m); return true; };
    const run = async (now: number) => runWellbeingPushes(t.env.DB, (await loadWbState(t.env.DB, now))!, now, "https://d", send as never);
    return { t, run, sent };
  };
  test("sends one reminder, each at most once a day, only at the stress minute", async () => {
    const b = boot();
    expect(await b.run(NOW - MIN)).toBeNull(); // not the stress minute
    expect(await b.run(NOW)).toBe("microbreak");
    expect(b.sent[0]).toMatchObject({ title: "Worth a break", tag: "wb:microbreak" });
    // one per tick; the next one due (four busy hours: the session reminder) on a later tick; none twice
    expect(await b.run(NOW + 15 * MIN)).toBe("session");
    expect(await b.run(NOW + 30 * MIN)).toBeNull();
    expect(b.sent.map((m) => m.tag)).toEqual(["wb:microbreak", "wb:session"]);
  });
  test("never in Focus or an agent-free block; off with the setting; Not today / Never suppress it", async () => {
    const focus = boot();
    focus.t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('focus_until', ?, 0)").run(String(NOW + H));
    expect(await focus.run(NOW)).toBeNull();
    expect(await boot({ freeBlocks: ["15:00-16:00"] }).run(NOW)).toBeNull();
    expect(await boot({ wellbeingPush: false }).run(NOW)).toBeNull();
    const today = boot();
    today.t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('nudge:microbreak', ?, 0)").run(JSON.stringify({ day: "2027-07-10" }));
    expect(await today.run(NOW)).toBe("session"); // not the micro-break: "Not today" holds for its push too
    const never = boot();
    never.t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('nudge:microbreak', ?, 0)").run(JSON.stringify({ never: true }));
    expect(await never.run(NOW)).toBe("session"); // "Never" for the micro-break
  });
  test(`at most ${WB_PUSH_DAILY_CAP} well-being pushes a day in total`, async () => {
    const b = boot();
    b.t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('rt:wbpush', ?, 0)").run(JSON.stringify({ day: "2027-07-10", n: 4, sent: ["pace", "session", "burn", "late"] }));
    expect(await b.run(NOW)).toBeNull();
    b.t.db.sqlite.query("UPDATE wb_settings SET v = ? WHERE k = 'rt:wbpush'").run(JSON.stringify({ day: "2027-07-09", n: 4, sent: ["microbreak"] }));
    expect(await b.run(NOW)).toBe("microbreak"); // a new day
  });
  test("agents busy for 6 h with no operator activity: no session push (the agents' session is not the operator's)", async () => {
    const t = makeEnv({ DASHBOARD_TZ: "UTC" });
    t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('settings', ?, 0)").run(JSON.stringify({ tz: "UTC", quietStart: "00:00", quietEnd: "00:00" }));
    const ev = t.db.sqlite.query("INSERT INTO events (source_id, host, project, kind, origin, at, received_at, severity, key, agent, status, text) VALUES ('s', 'h', 'p', 'status', 't' || 'mux-orch', ?1, ?1, 'info', ?2, 'a', 'IN_PROGRESS', 'x')");
    const use = t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, 'srv', 'p', 'claude-cli.subagent', 'claude', 'm', 1, 1, 0, 0, 0, 50, 0, 1)");
    for (let m = 6 * 60; m >= 0; m -= 10) ev.run(NOW - m * MIN, `k${m}`);
    for (let h = 9; h <= 15; h++) use.run(`2027-07-10T${h}`);
    const sent: unknown[] = [];
    const { indicatorsFromRow, readStressInputs } = await import("../src/wellbeing-metrics");
    const st = (await loadWbState(t.env.DB, NOW))!;
    expect(indicatorsFromRow((await readStressInputs(t.env.DB, st.settings, NOW))!, st.settings, NOW).find((i) => i.name === "session")!.value).toBeGreaterThanOrEqual(180);
    const r = await runWellbeingPushes(t.env.DB, st, NOW, "https://d", async (m) => { sent.push(m); return true; });
    expect(r).toBeNull();
    expect(sent).toEqual([]);
  });
  test("in the quiet hours: only the after-hours note, once, when late activity begins", async () => {
    const b = boot({ quietStart: "15:00", quietEnd: "07:00" });
    expect(await b.run(NOW)).toBe("late");
    expect(await b.run(NOW + 15 * MIN)).toBeNull();
  });
});
