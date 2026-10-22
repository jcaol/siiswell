/** The "You" side of the well-being layer: the operator's own input (hooks -> counts -> human_hourly -> the You line). */
import { describe, expect, test, afterEach } from "bun:test";
import { configureDashboardTz } from "../src/tz";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RAPID_MS, hourRows, humanUploadBody, readHumanLog, recordHuman } from "../cli/src/human";
import { HUMAN_MIN_INTERVAL_MS, sanitizeHuman, sumHours, weightedMedian } from "../src/human";
import { route } from "../src/index";
import { recordStressIfDue, WB_DEFAULTS } from "../src/wellbeing";
import { RESPONSE_POINTS, YOU_WEIGHTS, youIndicators, youNormalise, youRaw } from "../src/wellbeing-you";
import { cli, scratchHome, startServer } from "./cli-helpers";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

// a route() with DASHBOARD_TZ sets the process-wide zone: back to the default after each test
afterEach(() => {
  configureDashboardTz({}); // reset
});

const H = 3_600_000;
const MIN = 60_000;
const SID = "a".repeat(24);
const SECRET = "rm -rf /private/SECRET-PROMPT-TEXT";

describe("on the machine: what the hooks record (times and kinds only)", () => {
  test("prompt, approve (a permission Notification then the next PostToolUse) and the response time", () => {
    const dir = join(scratchHome(), "st");
    const T = Date.UTC(2027, 3, 1, 10, 0);
    recordHuman(dir, SID, "tool", T); // nothing waited: nothing recorded
    expect(readHumanLog(dir)).toEqual([]);
    recordHuman(dir, SID, "notification", T + 1000, true);
    recordHuman(dir, SID, "tool", T + 9_000); // approved after 8 s
    recordHuman(dir, SID, "tool", T + 10_000); // the next tool: nothing more
    recordHuman(dir, SID, "notification", T + 20_000, false); // "waiting for your input"
    recordHuman(dir, SID, "tool", T + 21_000); // not a permission prompt: no approval
    recordHuman(dir, SID, "prompt", T + 50_000); // the idle notice is not timed (it comes after ~60 s of idle by itself)
    recordHuman(dir, SID, "notification", T + 55_000, true); // a permission prompt answered by a prompt after 5 s
    recordHuman(dir, SID, "prompt", T + 60_000);
    expect(readHumanLog(dir)).toEqual([
      { t: T + 9_000, k: "a", lat: 8_000 },
      { t: T + 50_000, k: "p", lat: null },
      { t: T + 60_000, k: "p", lat: 5_000 },
    ]);
    // nothing in the state dir but numbers: the log lines are `<ms> <p|a> <ms|->`
    for (const line of readFileSync(join(dir, "human.log"), "utf8").trim().split("\n")) expect(line).toMatch(/^\d+ [pa] (\d+|-)$/);
  });

  test("hour rows: counts, rapid-fire (< 30 s after the previous event), the median response time", () => {
    const T = Date.UTC(2027, 3, 1, 10, 0);
    const rows = hourRows([
      { t: T + 0, k: "p", lat: 10_000 },
      { t: T + 10_000, k: "a", lat: 20_000 }, // rapid
      { t: T + 10_000 + RAPID_MS, k: "p", lat: 40_000 }, // exactly 30 s: not rapid
      { t: T + H + 5, k: "p", lat: null }, // next hour; 1 h after: not rapid
      { t: T + H + 6, k: "p", lat: null }, // rapid
    ]);
    expect(rows).toEqual([
      { h: T, prompts: 2, approvals: 1, rapid: 1, rapidMin: 1, latN: 3, latP50: 20_000 },
      { h: T + H, prompts: 2, approvals: 0, rapid: 1, rapidMin: 1, latN: 0, latP50: null },
    ]);
  });

  test("privacy: a prompt's text never reaches the state dir or the upload; the upload body is numbers only", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const fire = (event: string, input: Record<string, unknown>) => cli(["hook", event], env, { input: JSON.stringify({ session_id: "sess-h", cwd: "/w/p", ...input }), spawnBackground: () => undefined });
      await fire("claude-notification", { message: `Claude needs your permission to use Bash: ${SECRET}` });
      await fire("claude-post-tool", { tool_name: "Bash", tool_input: { command: SECRET } });
      await fire("claude-prompt", { prompt: SECRET });
      const dir = join(home, ".local", "state", "siiswell");
      for (const f of readdirSync(dir)) expect([f, readFileSync(join(dir, f), "utf8").includes("SECRET")]).toEqual([f, false]);
      const body = humanUploadBody(dir, Date.now());
      expect(body.hours.length).toBe(1);
      expect(Object.keys(body.hours[0]!).sort()).toEqual(["approvals", "h", "latN", "latP50", "prompts", "rapid", "rapidMin"]);
      for (const v of Object.values(body.hours[0]!)) expect(v === null || typeof v === "number").toBe(true);
      expect(JSON.stringify(body)).not.toContain("SECRET");
      expect(body.hours[0]).toMatchObject({ prompts: 1, approvals: 1 });
    } finally {
      s.stop();
    }
  });

  test("a background run uploads the counts (batched: at most every 10 minutes) with the client token", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const input = JSON.stringify({ session_id: "sess-u", cwd: "/w/p", message: "Claude needs your permission to use Bash" });
      const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      await cli(["hook", "claude-notification"], env, { input, spawnBackground: (args, e) => { spawned.push({ args, env: e }); } });
      await cli(["hook", "claude-prompt"], env, { input, spawnBackground: () => undefined });
      await cli(spawned[0]!.args, { ...env, SIISWELL_HOOK_INPUT: spawned[0]!.env.SIISWELL_HOOK_INPUT });
      const ups = s.seen.filter((x) => x.path === "/api/ingest/human");
      expect(ups.length).toBe(1);
      expect(ups[0]!.auth).toBe(true);
      expect((s.t.db.sqlite.query("SELECT SUM(prompts) AS p FROM human_hourly").get() as { p: number }).p).toBe(1);
    } finally {
      s.stop();
    }
  });
});

describe("the server: POST /api/ingest/human", () => {
  const NOW = Date.UTC(2027, 3, 1, 10, 30);
  const hour = (h: number, extra: Record<string, unknown> = {}) => ({ h, prompts: 5, approvals: 2, rapid: 1, rapidMin: 1, latN: 3, latP50: 20_000, ...extra });

  test("validation: whole UTC hours of the last 7 days, whole counts, a bounded latency; unknown fields are not stored", () => {
    const h0 = Math.floor(NOW / H) * H;
    expect(sanitizeHuman({ v: 1, hours: [hour(h0, { text: SECRET })] }, NOW)).toEqual({ ok: true, rows: [hour(h0)] });
    for (const bad of [hour(h0 + 1), hour(h0 - 8 * 24 * H), hour(h0 + 2 * H), hour(h0, { prompts: -1 }), hour(h0, { rapid: 1.5 }), hour(h0, { latP50: "x" })]) {
      expect(sanitizeHuman({ v: 1, hours: [bad] }, NOW).ok).toBe(false);
    }
    expect(sanitizeHuman({ v: 1, hours: [hour(h0), hour(h0)] }, NOW).ok).toBe(false);
    expect(sanitizeHuman({ v: 1, hours: Array.from({ length: 49 }, (_, i) => hour(h0 - i * H)) }, NOW).ok).toBe(false);
  });

  test("client token only; replaces an hour; one upload per source every 4 minutes", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const client = await addSource(t.db, "laptop", "client");
    const host = await addSource(t.db, "hosta", "host");
    const h0 = Math.floor(NOW / H) * H;
    const post = (token: string, body: unknown, now: number) => route(request("/api/ingest/human", { token, body }), t.env, ctx, { now });
    expect((await post(host, { v: 1, hours: [hour(h0)] }, NOW)).status).toBe(403);
    expect((await post(client, { v: 1, hours: [hour(h0)] }, NOW)).status).toBe(200);
    expect((await post(client, { v: 1, hours: [hour(h0, { prompts: 9 })] }, NOW + MIN)).status).toBe(429);
    expect((await post(client, { v: 1, hours: [hour(h0, { prompts: 9 })] }, NOW + HUMAN_MIN_INTERVAL_MS)).status).toBe(200);
    expect(t.db.rows("SELECT prompts, approvals, rapid, lat_n, lat_p50_ms FROM human_hourly")).toEqual([{ prompts: 9, approvals: 2, rapid: 1, lat_n: 3, lat_p50_ms: 20_000 }]);
  });

  test("several machines: counts add up, the response time is the weighted median of their medians", () => {
    expect(weightedMedian([[10, 1], [20, 1], [90, 5]])).toBe(90);
    expect(weightedMedian([[10, 3], [20, 1], [90, 1]])).toBe(10);
    expect(weightedMedian([])).toBeNull();
    expect(sumHours([
      { hour: 0, prompts: 2, approvals: 1, rapid: 0, lat_n: 1, lat_p50_ms: 5000 },
      { hour: 0, prompts: 3, approvals: 0, rapid: 2, lat_n: 4, lat_p50_ms: 60_000 },
    ])).toEqual([{ h: 0, prompts: 5, approvals: 1, rapid: 2, rapidMin: 0, latN: 5, latP50: 60_000 }]);
  });
});

describe("the You line (formula)", () => {
  const s = { ...WB_DEFAULTS, tz: "Europe/London" };
  const T = Date.UTC(2027, 3, 1, 22, 15); // 23:15 in London (BST): quiet hours
  const row = (h: number, n: number, extra: Partial<{ rapid: number; rapidMin: number; latN: number; latP50: number | null }> = {}) => ({ h, prompts: n, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null, ...extra });
  const cur = Math.floor(T / H) * H;

  test("normalisation: 50 at the first threshold, 100 at the second; response time is inverted (fast answers = high)", () => {
    expect([youNormalise("pace", 30), youNormalise("pace", 60), youNormalise("pace", 15), youNormalise("rapid", 25)]).toEqual([50, 100, 25, 100]);
    expect([youNormalise("response", RESPONSE_POINTS.fast), youNormalise("response", RESPONSE_POINTS.mid), youNormalise("response", RESPONSE_POINTS.slow), youNormalise("response", null)]).toEqual([100, 50, 0, 0]);
    expect(Object.values(YOU_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  test("indicators: pace over 60 min (the previous hour pro rata), session of back-to-back hours, off-hours in London quiet hours", () => {
    const ind = youIndicators([row(cur - 3 * H, 4), row(cur - 2 * H, 4), row(cur - H, 40, { rapid: 8, latN: 4, latP50: 12_000 }), row(cur, 10, { rapid: 4, latN: 2, latP50: 30_000 })], T, s)!;
    const v = Object.fromEntries(ind.map((i) => [i.name, i.value]));
    expect(v.pace).toBe(40); // 10 + 40 x 0.75
    expect(v.rapid).toBe(10); // 4 + 8 x 0.75
    expect(v.response).toBe(12); // weighted median of 12 s (4) and 30 s (2)
    expect(v.session).toBe(3 * 60 + 15); // four hours back to back, 15 min into the last
    expect(v.offHours).toBe(1); // London 20:00-23:59 had input; only 23:xx is inside the quiet hours 23:00-07:00
  });

  test("no operator input at all: no You line (null)", () => {
    expect(youIndicators([], T, s)).toBeNull();
    expect(youIndicators([row(cur, 0)], T, s)).toBeNull();
  });

  test("youRaw: weighted points, biggest first", () => {
    const r = youRaw([{ name: "pace", value: 60 }, { name: "rapid", value: 0 }, { name: "response", value: null }, { name: "session", value: 300 }, { name: "offHours", value: 0 }]);
    expect(r.level).toBe(40); // pace 20 + session 20 (weights with the activity proxy);
    expect(r.contributions.slice(0, 2).map((c) => c.name)).toEqual(["pace", "session"]);
  });
});

describe("the page and the ticker", () => {
  test("GET /api/wellbeing: the headline is You with the hooks' data, Agents without; the ticker stores stressYou", async () => {
    const NOW = Date.UTC(2027, 3, 1, 10, 7);
    const t = makeEnv({ DASHBOARD_TZ: "Europe/London" });
    const ctx = makeCtx();
    const get = async () => ((await (await route(request("/api/wellbeing"), t.env, ctx, { now: NOW })).json()) as { stress: { headline: string; you: { level: number; indicators: unknown[] } | null } }).stress;
    expect((await get()).headline).toBe("agents");
    expect((await get()).you).toBeNull();
    const h0 = Math.floor(NOW / H) * H;
    t.db.sqlite.query("INSERT INTO human_hourly (source_id, hour, prompts, approvals, rapid, lat_n, lat_p50_ms, updated) VALUES ('s1', ?, 50, 10, 20, 5, 10000, ?)").run(h0, NOW);
    const st = await get();
    expect(st.headline).toBe("you");
    expect(st.you!.level).toBeGreaterThan(0);
    expect(st.you!.indicators.length).toBe(6);
    expect(await recordStressIfDue(t.env.DB, NOW)).toBe(true);
    expect(t.db.rows<{ name: string }>("SELECT name FROM wb_metrics WHERE name IN ('stress', 'stressYou') ORDER BY name").map((r) => r.name)).toEqual(["stress", "stressYou"]);
  });
});

import { activityPercent } from "../src/wellbeing-you";
import { operatorActivity } from "../src/wellbeing";

describe("B. the activity proxy (apps without a prompt hook)", () => {
  test("the operator apps' requests of the last 60 min in % of the 14-day median hour; exact app labels only", async () => {
    const now = Date.UTC(2027, 6, 10, 12, 30);
    const cur = Date.UTC(2027, 6, 10, 12);
    const act = new Map<number, number>();
    for (let d = 1; d <= 10; d++) act.set(cur - d * 24 * H, 20); // a usual hour: 20 requests
    act.set(cur, 30);
    act.set(cur - H, 20);
    expect(activityPercent(act, now)).toBe(200); // (30 + 20 x 0.5) / 20
    expect(activityPercent(new Map(), now)).toBeNull();
    const t = makeEnv();
    const ins = t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES ('2027-07-10T12', 'mac', 'p', ?, 'claude', 'm', 1, 1, 0, 0, 0, ?, 0, 1)");
    for (const [a, n] of [["claude-desktop", 5], ["codex-cli", 3], ["claude-cli.dev", 50], ["codex-exec", 40], ["claude-sdk", 40]] as const) ins.run(a, n);
    const m = await operatorActivity(t.env.DB, Date.UTC(2027, 6, 10, 0), "UTC");
    expect([...m.entries()]).toEqual([[cur, 8]]); // worktree agents, exec runs and the SDK are not the operator
  });
  test("You exists from app activity alone (no hook) and counts it", () => {
    const now = Date.UTC(2027, 6, 10, 12, 30);
    const cur = Date.UTC(2027, 6, 10, 12);
    const act = new Map<number, number>([[cur - 24 * H, 10], [cur - 48 * H, 10], [cur, 30], [cur - H, 20]]);
    const ind = youIndicators([], now, { ...WB_DEFAULTS, tz: "UTC" }, act)!;
    expect(ind.find((i) => i.name === "activity")!.value).toBe(267); // (30 + 20 x 0.5) / median(10, 10, 20, 30) = 40 / 15
    expect(youRaw(ind).contributions.find((c) => c.name === "activity")!.points).toBe(20);
  });
});

import { youCoverage, youEstimate } from "../src/wellbeing-you";

describe("C. coverage-aware You", () => {
  const s = { ...WB_DEFAULTS, tz: "UTC" };
  const now = Date.UTC(2027, 6, 10, 18, 30);
  const cur = Date.UTC(2027, 6, 10, 18);
  // the live case: 4 prompts between 14:00 and 15:00 (one machine with the hooks), heavy app usage 10:00-18:59
  const hours = [{ h: Date.UTC(2027, 6, 10, 14), prompts: 4, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null }];
  const activity = new Map<number, number>();
  for (let d = 1; d <= 14; d++) activity.set(cur - d * 24 * H, 40); // a usual hour: 40 requests
  for (let h = 10; h <= 18; h++) activity.set(Date.UTC(2027, 6, 10, h), 120);
  test("prompts low, usage high: partial data, and the reading is not a near-zero calm one", () => {
    expect(youCoverage(hours, activity, now)).toBeCloseTo(1 / 9, 5);
    const precise = youRaw(youIndicators(hours, now, s, activity)!).level;
    const est = youEstimate(hours, activity, now, s)!;
    expect(est.partial).toBe(true);
    expect(est.raw.level).toBeGreaterThan(precise);
    expect(est.raw.level).toBeGreaterThanOrEqual(40); // nine busy hours in a row at 3x the usual: session + activity
    expect(est.ind.find((i) => i.name === "session")!.value).toBeGreaterThanOrEqual(8 * 60);
  });
  test("with the hooks covering the active hours: the precise reading, not partial", () => {
    const covered = [...activity.keys()].filter((h) => h > now - 24 * H).map((h) => ({ h, prompts: 5, approvals: 1, rapid: 0, rapidMin: 0, latN: 0, latP50: null }));
    const est = youEstimate(covered, activity, now, s)!;
    expect(est.partial).toBe(false);
    expect(est.coverage).toBe(1);
  });
  test("the page says partial data", async () => {
    const t = makeEnv({ DASHBOARD_TZ: "UTC" });
    const ins = t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, 'mac', 'p', 'claude-desktop', 'claude', 'm', 1, 1, 0, 0, 0, ?, 0, 1)");
    for (const [h, n] of activity) ins.run(new Date(h).toISOString().slice(0, 13), n);
    t.db.sqlite.query("INSERT INTO human_hourly (source_id, hour, prompts, approvals, rapid, rapid_min, lat_n, lat_p50_ms, updated) VALUES ('s', ?, 4, 0, 0, 0, 0, NULL, 1)").run(Date.UTC(2027, 6, 10, 14));
    const d = (await (await route(request("/api/wellbeing"), t.env, makeCtx(), { now })).json()) as any;
    expect(d.stress.headline).toBe("you");
    expect(d.stress.you.partial).toBe(true);
    expect(d.stress.you.level).toBeGreaterThanOrEqual(40);
    expect(d.stress.you.note).toContain("Partial data");
  });
});
