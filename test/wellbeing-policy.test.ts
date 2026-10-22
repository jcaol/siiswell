/**
 * Well-being W1: fewer interruptions. Tiers, quiet hours, Focus, storm control, digest, settings validation, the page API
 * and its auth. Fixture time series only; the policy is ON here (WELLBEING_PUSH_POLICY unset).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route, runCron } from "../src/index";
import type { PushItem } from "../src/rules";
import { b64urlEncode } from "../src/util";
import {
  WB_DEFAULTS, applyPushPolicy, digestMessage, lastSummaryTime, isQuietAt, localTime, parseStoredSettings, repushCooldown, stormMessage, tierOf, validateSettings,
  type WbSettings,
} from "../src/wellbeing";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";
import { openAlertsStmt } from "../src/db";
import { REOPEN_GRACE_MS } from "../src/rules";

const MIN = 60_000;
const H = 3_600_000;
// 2027-01-15 is a Friday; January = GMT, so London time = UTC
const DAYTIME = Date.parse("2027-01-15T10:00:00Z");
const NIGHT = Date.parse("2027-01-15T23:30:00Z");

const item = (key: string, rule: string, opened: number, project: string | null = "web", over: Partial<PushItem> = {}): PushItem => ({
  key, rule: rule as PushItem["rule"], severity: "warn", opened, origin: "host", host: "hosta", project, agent: null, pushCount: 0, lastPushed: null, reminder: false, ...over,
});
const policy = (items: PushItem[], now: number, over: Partial<{ settings: WbSettings; focusUntil: number; quietLast: Map<string, number> }> = {}) =>
  applyPushPolicy(items, { now, settings: over.settings ?? { ...WB_DEFAULTS }, focusUntil: over.focusUntil ?? 0, quietLast: over.quietLast ?? new Map() });
const keys = (l: PushItem[]) => l.map((i) => i.key);

describe("tiers", () => {
  test("now / batch / info", () => {
    expect(["approval-waiting", "blocked", "host-offline", "usage-limit"].map((r) => tierOf(r))).toEqual(["now", "now", "now", "now"]);
    expect(["overdue", "agent-stuck", "project-offline", "no-update", "burn-rate"].map((r) => tierOf(r))).toEqual(["batch", "batch", "batch", "batch", "batch"]);
    expect(["budget-exhausted", "alerts-capped", "anything"].map((r) => tierOf(r))).toEqual(["info", "info", "info"]);
    // agent-stuck: critical (cli-gone, restart-failed) is now, anything else batch
    expect([tierOf("agent-stuck", "critical"), tierOf("agent-stuck", "warn"), tierOf("agent-stuck")]).toEqual(["now", "batch", "batch"]);
  });
  test("a critical agent-stuck is pushed at once (also in quiet hours, one per project an hour); a warn one is held", () => {
    const crit = item("cg", "agent-stuck", 1, "web", { severity: "critical" });
    const warn = item("bn", "agent-stuck", 2, "api", { severity: "warn" });
    expect([keys(policy([crit, warn], DAYTIME).send), keys(policy([crit, warn], DAYTIME).hold)]).toEqual([["cg"], ["bn"]]);
    expect(keys(policy([crit], NIGHT).send)).toEqual(["cg"]);
    expect(keys(policy([crit], DAYTIME, { focusUntil: DAYTIME + MIN }).hold)).toEqual(["cg"]); // Focus: approvals only
  });
});

describe("quiet hours and local time", () => {
  const s = { quietStart: "23:00", quietEnd: "07:00", weekendsQuiet: false };
  test("over midnight, edges included at the start and excluded at the end", () => {
    const at = (hour: number, minute = 0, weekday = 3) => isQuietAt({ hour, minute, weekday }, s);
    expect([at(22, 59), at(23, 0), at(2), at(6, 59), at(7, 0), at(12)]).toEqual([false, true, true, true, false, false]);
  });
  test("a same-day window, equal start and end = none, weekends on demand", () => {
    expect(isQuietAt({ hour: 13, minute: 0, weekday: 3 }, { quietStart: "12:00", quietEnd: "14:00", weekendsQuiet: false })).toBe(true);
    expect(isQuietAt({ hour: 3, minute: 0, weekday: 3 }, { quietStart: "07:00", quietEnd: "07:00", weekendsQuiet: false })).toBe(false);
    expect(isQuietAt({ hour: 12, minute: 0, weekday: 6 }, s)).toBe(false);
    expect(isQuietAt({ hour: 12, minute: 0, weekday: 6 }, { ...s, weekendsQuiet: true })).toBe(true);
    expect(isQuietAt({ hour: 12, minute: 0, weekday: 0 }, { ...s, weekendsQuiet: true })).toBe(true);
  });
  test("the zone decides: BST and GMT in London, another zone", () => {
    expect(localTime(Date.parse("2026-07-01T22:30:00Z"), "Europe/London")).toMatchObject({ day: "2026-07-01", hour: 23, minute: 30, weekday: 3 });
    expect(localTime(Date.parse("2026-12-01T22:30:00Z"), "Europe/London")).toMatchObject({ hour: 22 });
    expect(localTime(Date.parse("2026-12-01T22:30:00Z"), "Asia/Hong_Kong")).toMatchObject({ day: "2026-12-02", hour: 6, weekday: 3 });
  });
});

describe("push policy", () => {
  test("daytime: now tier is sent, batch held for the digest, info never pushed", () => {
    const p = policy([item("a", "blocked", 1), item("b", "overdue", 2), item("c", "budget-exhausted", 3), item("d", "host-offline", 4, null)], DAYTIME);
    expect([keys(p.send), keys(p.hold), keys(p.drop), p.quiet, p.focus]).toEqual([["a", "d"], ["b"], ["c"], false, false]);
  });
  test("quiet hours: one now-push per project per hour, oldest first; batch held", () => {
    const p = policy([item("w2", "blocked", 20), item("w1", "blocked", 10), item("a1", "blocked", 30, "api"), item("o", "agent-stuck", 5)], NIGHT);
    expect(p.quiet).toBe(true);
    expect(keys(p.send)).toEqual(["w1", "a1"]);
    expect(keys(p.hold).sort()).toEqual(["o", "w2"]);
    expect(p.quietStamped).toEqual(["web", "api"]);
    // web was pushed 30 min ago: held; api 61 min ago: allowed again
    const later = policy([item("w3", "blocked", 40), item("a2", "blocked", 41, "api")], NIGHT, { quietLast: new Map([["web", NIGHT - 30 * MIN], ["api", NIGHT - 61 * MIN]]) });
    expect([keys(later.send), keys(later.hold)]).toEqual([["a2"], ["w3"]]);
  });
  test("weekends quiet when switched on", () => {
    const saturdayNoon = Date.parse("2027-01-16T12:00:00Z");
    expect(policy([item("b", "overdue", 1)], saturdayNoon).quiet).toBe(false);
    expect(policy([item("b", "overdue", 1)], saturdayNoon, { settings: { ...WB_DEFAULTS, weekendsQuiet: true } }).quiet).toBe(true);
  });
  test("Focus: only approval-waiting is pushed; ends by itself", () => {
    const items = [item("ap", "approval-waiting", 1), item("bl", "blocked", 2), item("od", "overdue", 3)];
    const p = policy(items, DAYTIME, { focusUntil: DAYTIME + 30 * MIN });
    expect([keys(p.send), keys(p.hold), p.focus]).toEqual([["ap"], ["bl", "od"], true]);
    expect(keys(policy(items, DAYTIME + 31 * MIN, { focusUntil: DAYTIME + 30 * MIN }).send)).toEqual(["ap", "bl"]);
  });
  test("storm message: one push, the oldest named first, the rest counted", () => {
    const m = stormMessage([item("x", "blocked", 30, "api"), item("y", "approval-waiting", 10, "web"), item("z", "host-offline", 20, null)], "https://d.test/");
    expect(m.title).toBe("3 things need you");
    expect(m.body).toBe("Oldest first: web@hosta action waiting (+2 more)");
    expect(m.url).toBe("https://d.test/#alert=y");
  });
  test("re-push cooldown 15 -> 30 -> 60 -> 120 min, then digest only", () => {
    expect([1, 2, 3, 4, 5, 0].map(repushCooldown)).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN, null, null]);
  });
  test("digest text: counts per kind and project; the first after quiet hours is the morning one", () => {
    const rows = [
      { key: "a", rule: "overdue", host: "h", project: "web", opened: 1 },
      { key: "b", rule: "overdue", host: "h", project: "api", opened: 2 },
      { key: "c", rule: "agent-stuck", host: "h", project: "web", opened: 3 },
    ];
    expect(digestMessage(rows, "https://d.test", false)).toMatchObject({ title: "Scheduled Summary", body: "3 things in 2 projects: 2 task overdue, 1 agent stuck", tag: "wb:digest" });
    expect(digestMessage(rows.slice(0, 1), "https://d.test", true)).toMatchObject({ title: "While you were away", body: "1 thing in 1 project: 1 task overdue" });
  });
});

describe("settings validation", () => {
  test("a partial update keeps the rest; every field is checked; unknown keys are refused", () => {
    expect(validateSettings({ quietStart: "22:30", weekendsQuiet: true })).toEqual({ ok: true, value: { ...WB_DEFAULTS, quietStart: "22:30", weekendsQuiet: true } });
    expect(validateSettings({ tz: "Asia/Hong_Kong", digestMin: 60, nudges: false }).ok).toBe(true);
    for (const bad of [{ tz: "Mars/Base" }, { tz: "../etc" }, { quietStart: "24:00" }, { quietEnd: "7:00" }, { digestMin: 45 }, { digestMin: "30" }, { weekendsQuiet: "yes" }, { evil: 1 }, null, [1]]) {
      expect(validateSettings(bad).ok).toBe(false);
    }
  });
  test("stored JSON: junk falls back to the defaults field by field", () => {
    expect(parseStoredSettings(null)).toEqual(WB_DEFAULTS);
    expect(parseStoredSettings("{oops")).toEqual(WB_DEFAULTS);
    expect(parseStoredSettings(JSON.stringify({ tz: "Nope/Zone", digestMin: 15, quietStart: "21:00" }))).toEqual({ ...WB_DEFAULTS, digestMin: 15, quietStart: "21:00" });
  });
});

// ── end to end: the cron path with a push subscription ─────────────────────────────────────────────────────────

/** `groupWait: false` stores groupWaitSec 0, so these end-to-end flows push in the tick the alert opens (group_wait has its own test). */
async function boot(over: Record<string, string | undefined> = {}, opts: { groupWait?: boolean; windDown?: boolean } = {}) {
  const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", vapid.privateKey)) as JsonWebKey;
  const raw = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const t = makeEnv({
    VAPID_PUBLIC_KEY: b64urlEncode(new Uint8Array([4, ...raw(jwk.x as string), ...raw(jwk.y as string)])),
    VAPID_PRIVATE_KEY: jwk.d as string,
    VAPID_SUBJECT: "mailto:ops@example.com",
    WELLBEING_PUSH_POLICY: undefined,
    ...over,
  });
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  t.db.sqlite
    .query("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, 1)")
    .run("https://fcm.googleapis.com/fcm/send/dev", b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer)), b64urlEncode(crypto.getRandomValues(new Uint8Array(16))));
  // the wind-down summary (its own push at 23:00) is off here unless a test asks for it: these tests count the policy's pushes
  t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('settings', ?, 0)").run(JSON.stringify({ ...(opts.groupWait ? {} : { groupWaitSec: 0 }), ...(opts.windDown ? {} : { windDown: "" }) }));
  const ctx = makeCtx();
  const pushes: number[] = [];
  let clock = 0;
  const fetchImpl = async () => {
    pushes.push(clock);
    return new Response(null, { status: 201 });
  };
  const tick = async (now: number) => {
    clock = now;
    t.db.sqlite.query("DELETE FROM meta WHERE k = 'last_tick'").run(); // each call is its own minute
    await runCron(t.env, ctx, now, { fetch: fetchImpl });
    await ctx.flush();
  };
  const hostDown = (host: string, at: number) => t.db.sqlite.query("INSERT OR REPLACE INTO hosts (host, last_seen) VALUES (?, ?)").run(host, at);
  const blockedTask = (key: string, project: string, at: number) =>
    t.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 's', 'mcp', 'c', ?, 'c', ?, 'job', 'blocked', ?, ?)").run(key, project, key, at, at);
  const alerts = () => t.db.rows<{ key: string; rule: string; push_count: number; summarized: number; digested: number }>(
    "SELECT key, rule, push_count, summarized_at IS NOT NULL AS summarized, wb_digested IS NOT NULL AS digested FROM alerts ORDER BY key",
  );
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => route(request(path, { body, headers }), t.env, ctx, { now: clock || DAYTIME });
  return { ...t, ctx, pushes, tick, hostDown, blockedTask, alerts, post };
}

describe("end to end (cron)", () => {
  test("daytime: two urgent items in one tick = ONE push; a batch item waits for the digest, which comes once per interval", async () => {
    const b = await boot();
    b.hostDown("h1", DAYTIME - 10 * MIN);
    b.blockedTask("mcp|c|m-1", "web", DAYTIME - MIN);
    // a host-agent task past 1.5 x its ETA: overdue (batch)
    b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, created, updated) VALUES ('h1|web|t', 's', 'host', 'h1', 'web', 'w', 't', 'long', 'running', ?, ?, ?)")
      .run(DAYTIME - 60 * MIN, DAYTIME - 100 * MIN, DAYTIME - 100 * MIN);
    await b.tick(DAYTIME);
    const a = b.alerts();
    expect(a.map((x) => [x.rule, x.push_count])).toEqual([["blocked", 1], ["host-offline", 1], ["overdue", 0]]);
    // one storm push + one digest (the overdue item; the digest interval starts now)
    expect(b.pushes).toEqual([DAYTIME, DAYTIME]);
    expect(a.find((x) => x.rule === "overdue")).toMatchObject({ summarized: 1, digested: 1 });
    // nothing more for the next 30 minutes, even with a new batch item
    b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, created, updated) VALUES ('h1|api|t2', 's', 'host', 'h1', 'api', 'w', 't2', 'long', 'running', ?, ?, ?)")
      .run(DAYTIME - 20 * MIN, DAYTIME - 50 * MIN, DAYTIME - 50 * MIN);
    for (let m = 1; m < 30; m += 7) await b.tick(DAYTIME + m * MIN);
    expect(b.pushes.length).toBe(2);
    await b.tick(DAYTIME + 30 * MIN);
    expect(b.pushes.length).toBe(3); // the digest with the new overdue item
    expect(b.alerts().filter((x) => x.rule === "overdue").every((x) => x.digested === 1 && x.push_count === 0)).toBe(true);
  });

  test("quiet hours: one push per project per hour; the held one comes in the morning digest", async () => {
    const b = await boot();
    b.hostDown("h1", NIGHT - 10 * MIN);
    b.hostDown("h2", NIGHT - 10 * MIN);
    await b.tick(NIGHT);
    expect(b.pushes.length).toBe(1);
    expect(b.alerts().map((x) => x.push_count).sort()).toEqual([0, 1]);
    for (let m = 10; m <= 60 * 7; m += 50) await b.tick(NIGHT + m * MIN); // all night: no digest, and h2 stays held
    expect(b.pushes.length).toBe(1);
    const morning = Date.parse("2027-01-16T07:05:00Z");
    await b.tick(morning);
    expect(b.pushes.length).toBe(2);
    expect(b.alerts().find((x) => x.push_count === 0)).toMatchObject({ digested: 1 });
  });

  test("Focus from the page: nothing urgent is pushed during it; afterwards the digest has it", async () => {
    const b = await boot();
    const res = await b.post("/api/wellbeing/focus", { minutes: 60 });
    expect(res.status).toBe(200);
    b.blockedTask("mcp|c|m-1", "web", DAYTIME - MIN);
    await b.tick(DAYTIME);
    await b.tick(DAYTIME + 30 * MIN);
    expect(b.pushes.length).toBe(0);
    await b.tick(DAYTIME + 61 * MIN);
    expect(b.pushes.length).toBe(1);
    expect(b.alerts()[0]).toMatchObject({ push_count: 0, digested: 1 });
  });

  test("without migration 0007 (or with the switch off) every due push goes out on its own, as before", async () => {
    for (const b of [await boot(), await boot({ WELLBEING_PUSH_POLICY: "0" })]) {
      if (b.env.WELLBEING_PUSH_POLICY !== "0") b.db.sqlite.run("DROP TABLE wb_settings");
      b.hostDown("h1", DAYTIME - 10 * MIN);
      b.blockedTask("mcp|c|m-1", "web", DAYTIME - MIN);
      await b.tick(DAYTIME);
      expect(b.pushes.length).toBe(2);
    }
  });
});

describe("the page API", () => {
  test("GET shows the defaults; POST settings validates and stores; focus 0..240 min", async () => {
    const b = await boot({}, { groupWait: true, windDown: true });
    const get = async () => (await (await route(request("/api/wellbeing"), b.env, b.ctx, { now: DAYTIME })).json()) as any;
    expect(await get()).toMatchObject({ settings: WB_DEFAULTS, focusUntil: 0, pending: false, quietNow: false, focus: false });
    expect((await b.post("/api/wellbeing/settings", { quietStart: "09:00", quietEnd: "11:00" })).status).toBe(200);
    expect(await get()).toMatchObject({ settings: { quietStart: "09:00", quietEnd: "11:00", tz: "UTC" }, quietNow: true });
    const bad = await b.post("/api/wellbeing/settings", { digestMin: 7 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain("digestMin");
    expect((await b.post("/api/wellbeing/focus", { minutes: 241 })).status).toBe(400);
    expect((await b.post("/api/wellbeing/focus", { minutes: 1.5 })).status).toBe(400);
    expect((await b.post("/api/wellbeing/focus", { minutes: 0 })).status).toBe(200);
    expect((await b.post("/api/wellbeing/nope", {})).status).toBe(404);
  });
  test("writes: same-origin JSON only; cross-site refused; Access required", async () => {
    const b = await boot();
    const form = await route(request("/api/wellbeing/focus", { rawBody: "minutes=60", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), b.env, b.ctx, { now: DAYTIME });
    expect(form.status).toBe(400);
    expect((await b.post("/api/wellbeing/focus", { minutes: 60 }, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await b.post("/api/wellbeing/focus", { minutes: 60 }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await route(request("/api/wellbeing/focus", { method: "GET" }), b.env, b.ctx, { now: DAYTIME })).status).toBe(405);
    const locked = makeEnv({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud", DEV_NO_ACCESS: undefined });
    const call = (path: string, body?: unknown) => route(request(path, { body }), locked.env, makeCtx(), { now: DAYTIME, fetch: async () => new Response("{}", { status: 500 }) });
    expect((await call("/api/wellbeing")).status).toBe(403);
    expect((await call("/api/wellbeing/settings", { tz: "UTC" })).status).toBe(403);
    expect(locked.db.rows("SELECT * FROM wb_settings")).toEqual([]);
  });
  test("without migration 0007: defaults, pending, writes refused with 503", async () => {
    const b = await boot();
    b.db.sqlite.run("DROP TABLE wb_settings");
    expect(((await (await route(request("/api/wellbeing"), b.env, b.ctx, { now: DAYTIME })).json()) as any).pending).toBe(true);
    expect((await b.post("/api/wellbeing/focus", { minutes: 60 })).status).toBe(503);
  });
});

describe("reviewer fixes", () => {
  test("a reopened alert (after the grace) is digested / pushed again; within the grace it stays digested", async () => {
    const t = makeEnv();
    const row = (key: string, resolved: number) => t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, resolved, push_count, summarized_at, wb_digested) VALUES (?, 'overdue', 'warn', 'host', 'h', 'p', 'x', 1, ?, 0, 5, 7)").run(key, resolved);
    row("old", DAYTIME - REOPEN_GRACE_MS - 1);
    row("recent", DAYTIME - MIN);
    const a = (key: string) => ({ key, rule: "overdue", severity: "warn", origin: "host", host: "h", project: "p", agent: null, text: "x" });
    await openAlertsStmt(t.env.DB, [a("old"), a("recent")], DAYTIME).run();
    expect(t.db.rows("SELECT key, resolved, summarized_at, wb_digested FROM alerts ORDER BY key")).toEqual([
      { key: "old", resolved: null, summarized_at: null, wb_digested: null },
      { key: "recent", resolved: null, summarized_at: 5, wb_digested: 7 },
    ]);
  });

  test("end to end: a host held at night and digested in the morning, back online, then offline again later: pushed again", async () => {
    const b = await boot();
    b.hostDown("h1", NIGHT - 10 * MIN);
    b.hostDown("h2", NIGHT - 10 * MIN);
    await b.tick(NIGHT);
    const morning = Date.parse("2027-01-16T07:05:00Z");
    await b.tick(morning);
    const held = b.alerts().find((x) => x.digested === 1 && x.push_count === 0) as { key: string };
    const host = held.key.split("|")[1] as string;
    b.hostDown(host, morning + MIN); // back
    await b.tick(morning + 2 * MIN);
    expect(b.alerts().find((x) => x.key === held.key)).toBeTruthy();
    const before = b.pushes.length;
    await b.tick(morning + 2 * MIN + REOPEN_GRACE_MS + 10 * MIN); // offline again, a fresh episode
    expect(b.pushes.length).toBe(before + 1);
    expect(b.alerts().find((x) => x.key === held.key)).toMatchObject({ push_count: 1, digested: 0 });
  });

  test("quiet hours: an approval that was held is not offered again every 15 min (no repeated writes)", async () => {
    const b = await boot();
    const hostToken = await addSource(b.db, "hosta", "host");
    // proja already had its one quiet-hours push this hour: the approval is held
    b.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('rt:qh:proja', ?, ?)").run(String(NIGHT - 5 * MIN), NIGHT - 5 * MIN);
    const snap = (now: number) => route(request("/api/ingest/snapshot", { body: snapshot({ approvals: [{ id: "ap1", summary: "x", requestedAt: NIGHT - 10 * MIN }] }, now), token: hostToken }), b.env, b.ctx, { now });
    await snap(NIGHT);
    await b.ctx.flush();
    await b.tick(NIGHT);
    const first = b.db.rows<{ summarized_at: number; push_count: number }>("SELECT summarized_at, push_count FROM alerts WHERE rule = 'approval-waiting'")[0];
    expect(first).toMatchObject({ push_count: 0 });
    expect(first?.summarized_at).toBeGreaterThan(0);
    b.db.recordStatements = true;
    const n0 = b.db.statements.length;
    for (const m of [16, 31, 46, 61, 76]) {
      await snap(NIGHT + m * MIN);
      await b.ctx.flush();
      await b.tick(NIGHT + m * MIN);
    }
    expect(b.db.rows<{ summarized_at: number }>("SELECT summarized_at FROM alerts WHERE rule = 'approval-waiting'")[0]?.summarized_at).toBe(first?.summarized_at);
    expect(b.db.statements.slice(n0).filter((q) => /UPDATE alerts SET summarized_at/.test(q)).length).toBe(0);
    expect(b.pushes.length).toBe(0);
  });

  test("the digest is sent once Focus has ended (and not during it)", async () => {
    const b = await boot();
    b.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('focus_until', ?, 0)").run(String(DAYTIME + 20 * MIN));
    b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, created, updated) VALUES ('h1|web|t', 's', 'host', 'h1', 'web', 'w', 't', 'long', 'running', ?, ?, ?)")
      .run(DAYTIME - 60 * MIN, DAYTIME - 100 * MIN, DAYTIME - 100 * MIN);
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('h1', ?)").run(DAYTIME + 10 * 60 * MIN);
    await b.tick(DAYTIME);
    await b.tick(DAYTIME + 19 * MIN);
    expect(b.pushes.length).toBe(0);
    await b.tick(DAYTIME + 21 * MIN);
    expect(b.pushes.length).toBe(1);
    expect(b.alerts().find((x) => x.rule === "overdue")).toMatchObject({ digested: 1, push_count: 0 });
  });

  test("before migration 0007: a reopen falls back to the old statement (no wb_digested column)", async () => {
    const b = await boot();
    b.db.sqlite.run("DROP INDEX IF EXISTS idx_alerts_opened");
    b.db.sqlite.run("ALTER TABLE alerts DROP COLUMN wb_digested");
    b.db.sqlite.run("DROP TABLE wb_settings");
    b.db.sqlite.run("DROP TABLE wb_metrics");
    b.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, resolved, push_count) VALUES ('host-offline|h1', 'host-offline', 'warn', 'host', 'h1', NULL, 'x', 1, ?, 1)").run(DAYTIME - REOPEN_GRACE_MS - MIN);
    b.hostDown("h1", DAYTIME - 10 * MIN);
    await b.tick(DAYTIME);
    expect(b.db.rows("SELECT key, resolved, push_count FROM alerts")).toEqual([{ key: "host-offline|h1", resolved: null, push_count: 1 }]);
    expect(b.pushes.length).toBe(1);
  });

  test("policy: an item already held in quiet hours is skipped, not held again", () => {
    const held = item("ap", "approval-waiting", 1, "web", { summarizedAt: NIGHT - 20 * MIN, lastPushed: null, pushCount: 0 });
    const p = policy([held], NIGHT);
    expect([keys(p.send), keys(p.hold), keys(p.skip)]).toEqual([[], [], ["ap"]]);
    // after a push the reminder is not a held one: it is subject to the per-project hour as usual
    expect(keys(policy([{ ...held, lastPushed: NIGHT - 10 * MIN, pushCount: 1 }], NIGHT).send)).toEqual(["ap"]);
    // daytime: offered as usual
    expect(keys(policy([held], DAYTIME).send)).toEqual(["ap"]);
  });
});

describe("group_wait and inhibition", () => {
  test("group_wait: a new Time-Sensitive alert waits (nothing written), then goes out with the others of that moment; reminders never wait", () => {
    const s = { ...WB_DEFAULTS, groupWaitSec: 30 };
    const fresh = item("a", "blocked", DAYTIME - 10_000);
    const older = item("b", "host-offline", DAYTIME - 40_000, null);
    const p = policy([fresh, older], DAYTIME, { settings: s });
    expect([keys(p.send), keys(p.skip), keys(p.hold)]).toEqual([["b"], ["a"], []]);
    expect(keys(policy([fresh], DAYTIME + 21_000, { settings: s }).send)).toEqual(["a"]);
    expect(keys(policy([{ ...fresh, pushCount: 1, lastPushed: DAYTIME - 20 * MIN }], DAYTIME, { settings: s }).send)).toEqual(["a"]);
    expect(keys(policy([fresh], DAYTIME, { settings: { ...s, groupWaitSec: 0 } }).send)).toEqual(["a"]);
    expect(validateSettings({ groupWaitSec: 30 }).ok).toBe(true);
    expect(validateSettings({ groupWaitSec: 45 }).ok).toBe(false);
  });
  test("end to end: the default group_wait sends two alerts of one moment as ONE push on the next tick", async () => {
    const b = await boot({}, { groupWait: true });
    b.hostDown("h1", DAYTIME - 10 * MIN);
    b.blockedTask("mcp|c|m-1", "web", DAYTIME - MIN);
    await b.tick(DAYTIME);
    expect(b.pushes.length).toBe(0); // opened this tick: waiting
    await b.tick(DAYTIME + MIN);
    expect(b.pushes.length).toBe(1);
    expect(b.alerts().filter((a) => a.push_count === 1).length).toBe(2);
  });
  test("inhibition: an offline host inhibits its project-offline / agent-stuck pushes; a blocked task its overdue push", async () => {
    const { inhibitedKeys } = await import("../src/rules");
    const d = (key: string, rule: string, host: string) => ({ key, rule, host }) as any;
    expect([...inhibitedKeys([
      d("host-offline|h1", "host-offline", "h1"),
      d("project-offline|h1|web", "project-offline", "h1"),
      d("agent-stuck|h1|web|a1|cli-gone", "agent-stuck", "h1"),
      d("agent-stuck|h2|web|a1|cli-gone", "agent-stuck", "h2"),
      d("blocked|h2|web|t1", "blocked", "h2"),
      d("overdue|h2|web|t1|123", "overdue", "h2"),
      d("overdue|h2|web|t2|123", "overdue", "h2"),
    ])].sort()).toEqual(["agent-stuck|h1|web|a1|cli-gone", "overdue|h2|web|t1|123", "project-offline|h1|web"]);
  });
});

describe("Time-Sensitive / Scheduled Summary (iOS naming; internal tiers unchanged)", () => {
  test("summary times: validated, sorted; the latest one at or before now within 24 h", () => {
    expect(validateSettings({ summaryTimes: ["18:00", "08:00"] })).toMatchObject({ ok: true, value: { summaryTimes: ["08:00", "18:00"] } });
    for (const bad of [["8:00"], ["08:00", "08:00"], ["01:00", "02:00", "03:00", "04:00", "05:00"], "08:00"]) expect(validateSettings({ summaryTimes: bad }).ok).toBe(false);
    expect(validateSettings({ summaryTimes: [] }).ok).toBe(true);
    const s = { ...WB_DEFAULTS, summaryTimes: ["08:00", "18:00"] };
    expect(lastSummaryTime(s, DAYTIME)).toBe(Date.parse("2027-01-15T08:00:00Z"));
    expect(lastSummaryTime(s, Date.parse("2027-01-15T07:00:00Z"))).toBe(Date.parse("2027-01-14T18:00:00Z"));
    expect(lastSummaryTime({ ...s, summaryTimes: [] }, DAYTIME)).toBeNull();
  });
  test("a Scheduled Summary goes out at its time even when the interval has not passed", async () => {
    const b = await boot();
    b.db.sqlite.run("UPDATE wb_settings SET v = ? WHERE k = 'settings'", [JSON.stringify({ groupWaitSec: 0, digestMin: 120, summaryTimes: ["10:05"] })]);
    const overdue = (key: string, at: number) => b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, created, updated) VALUES (?, 's', 'host', 'h1', 'web', 'w', ?, 'long', 'running', ?, ?, ?)").run(key, key, at + 40 * MIN, at, at);
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('h1', ?)").run(DAYTIME + 10 * 60 * MIN);
    overdue("t1", DAYTIME - 100 * MIN);
    await b.tick(DAYTIME); // the first summary (nothing sent before): 1 push
    expect(b.pushes.length).toBe(1);
    overdue("t2", DAYTIME - 95 * MIN);
    await b.tick(DAYTIME + 3 * MIN); // interval (120 min) not over, 10:05 not reached
    expect(b.pushes.length).toBe(1);
    await b.tick(DAYTIME + 6 * MIN); // 10:06: the 10:05 Scheduled Summary
    expect(b.pushes.length).toBe(2);
    await b.tick(DAYTIME + 9 * MIN);
    expect(b.pushes.length).toBe(2);
  });
  test("the page names the tiers Time-Sensitive and Scheduled Summary", () => {
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    expect(js).toContain("Time-Sensitive items are pushed at once");
    expect(js).toContain("Scheduled Summary every");
  });
});

describe("digest: never-pushed Time-Sensitive alerts", () => {
  test("a now alert that never got pushed (failures past the retry window) is carried by the next digest; one in its group_wait is not", async () => {
    const b = await boot({}, { groupWait: true });
    const ins = b.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, push_count) VALUES (?, 'blocked', 'warn', 'mcp', 'c', 'web', 'x', ?, 0)");
    ins.run("blocked|c|web|old", DAYTIME - 70 * MIN); // push failed for over an hour: the rules no longer offer it
    ins.run("blocked|c|web|new", DAYTIME - 10_000); // still inside its 30 s group_wait
    // the tasks behind them so the rules keep both open
    for (const id of ["old", "new"]) b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 's', 'mcp', 'c', 'web', 'c', ?, 'job', 'blocked', ?, ?)").run(`mcp|c|${id}`, id, DAYTIME - 70 * MIN, DAYTIME - 70 * MIN);
    await b.tick(DAYTIME);
    const a = b.db.rows<{ key: string; digested: number }>("SELECT key, wb_digested IS NOT NULL AS digested FROM alerts ORDER BY key");
    expect(a).toEqual([{ key: "blocked|c|web|new", digested: 0 }, { key: "blocked|c|web|old", digested: 1 }]);
  });
});
