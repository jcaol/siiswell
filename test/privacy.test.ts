/**
 * WP-PRIVACY (Worker side):
 *  1. every ingested / MCP text field loses URL paths, queries and fragments before it reaches D1;
 *  2. retention without the cron: an opportunistic purge and time-based rules after ingest / state reads;
 *  3. /api/state and /api/push/* refuse cross-site browser requests and never send CORS headers;
 *  4. HSTS on every response and in public/_headers;
 *  5. the pusher's `textMode` is accepted, stored and shown by /api/state.
 */
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALERT_DEFAULTS } from "../src/shared/schema";
import { META_LAST_CRON, META_LAST_PURGE, META_LAST_TICK, PUSH_BUDGET_IDLE_MS } from "../src/alerts";
import { isCrossSiteRequest } from "../src/auth";
import { retentionDaysOf } from "../src/env";
import { route, runCron } from "../src/index";
import { HSTS } from "../src/util";
import { CRON_FRESH_MS, PURGE_EVERY_MS, TICK_EVERY_MS, claimMeta, maintainOpportunistically, purgeIfDue, retentionDays } from "../src/maintenance";
import { PURGE_BATCH, purgeOld } from "../src/alerts";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const SIGNED = "https://bkt.s3.amazonaws.com/q3-contract.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=0123456789abcdef0123456789abcdef";
const LINKED = "https://bkt.s3.amazonaws.com/[link]";

async function boot(over: Parameters<typeof makeEnv>[0] = {}) {
  const t = makeEnv(over);
  const ctx = makeCtx();
  const host = await addSource(t.db, "hosta", "host");
  const client = await addSource(t.db, "client1", "client");
  const post = async (path: string, body: unknown, now = NOW) => {
    const res = await route(request(path, { token: host, body }), t.env, ctx, { now });
    await ctx.flush();
    return res;
  };
  const get = async (path: string, init: { headers?: Record<string, string>; method?: string; body?: unknown; now?: number } = {}) => {
    const res = await route(request(path, { headers: init.headers, method: init.method, body: init.body }), t.env, ctx, { now: init.now ?? NOW });
    await ctx.flush();
    return res;
  };
  const mcp = async (name: string, args: unknown, now = NOW) => {
    const res = await route(
      request("/mcp", { token: client, body: rpc("tools/call", { name, arguments: args }), headers: { Accept: "application/json, text/event-stream" } }),
      t.env,
      ctx,
      { now },
    );
    await ctx.flush();
    return res;
  };
  const count = (table: string, where = "1") => t.db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0]?.n ?? 0;
  const meta = (k: string) => t.db.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v;
  return { ...t, ctx, host, client, post, get, mcp, count, meta };
}

// ── 1. links never reach D1 ──────────────────────────────────────────────────────────────────────────────────

describe("the Worker strips URL paths before storing any text field", () => {
  test("snapshot: task title and lastLine, discussion topic, approval summary", async () => {
    const b = await boot();
    const res = await b.post(
      "/api/ingest/snapshot",
      snapshot(
        {
          tasks: [{ id: "t1", agent: "Agent01", title: `Review ${SIGNED} today`, state: "running", dispatchedAt: NOW - 1000, updatedAt: NOW - 500, lastLine: `see https://drive.google.com/file/d/1AbCdEf/view?usp=sharing` }],
          discussions: [{ id: "d1", topic: `compare ${SIGNED}`, status: "active", round: 1, maxRounds: 3, messages: 1, maxMessages: 9, participants: ["Agent01"], benched: [], updatedAt: NOW }],
          approvals: [{ id: "a1", summary: `deploy ${SIGNED}`, requestedAt: NOW - 1000, agent: "Agent01" }],
        } as never,
        NOW,
      ),
    );
    expect(res.status).toBe(200);
    const dump = JSON.stringify([b.db.rows("SELECT * FROM tasks"), b.db.rows("SELECT json FROM snapshots")]);
    expect(dump).not.toMatch(/Amz|q3-contract|0123456789abcdef|file\/d|1AbCdEf|usp=sharing/);
    expect(b.db.rows<any>("SELECT title, last_line FROM tasks")).toEqual([{ title: `Review ${LINKED} today`, last_line: "see https://drive.google.com/[link]" }]);
    const state = (await (await b.get("/api/state")).json()) as any;
    expect(state.discussions[0].topic).toBe(`compare ${LINKED}`);
    expect(JSON.stringify(state)).not.toMatch(/Amz|q3-contract|0123456789abcdef/);
  });

  test("events (halt text, STATUS text) and the relay task row built from them", async () => {
    const b = await boot();
    const res = await b.post("/api/ingest/events", {
      v: 1,
      host: "hosta",
      project: "proja",
      events: [
        { kind: "halt", origin: ORIGIN_HOST, at: NOW, severity: "warn", key: "h1", scenario: "task-no-report", agent: "Agent01", text: `⚠️ **[Agent01] never reported** ${SIGNED}` },
        { kind: "status", origin: ORIGIN_RELAY, at: NOW, severity: "info", key: "s1", status: "IN_PROGRESS", agent: "claude@mac", sender: "@claude:mac.org", text: `STATUS: IN PROGRESS — uploading ${SIGNED}` },
      ],
    });
    expect(res.status).toBe(200);
    const dump = JSON.stringify([b.db.rows("SELECT * FROM events"), b.db.rows("SELECT * FROM tasks"), b.db.rows("SELECT * FROM alerts")]);
    expect(dump).not.toMatch(/Amz|q3-contract|0123456789abcdef/);
    expect(dump).toContain(LINKED);
  });

  test("MCP report_task / update_task title and summary", async () => {
    const b = await boot();
    const res = await b.mcp("report_task", { project: "web", title: `Check ${SIGNED}`, status: "IN_PROGRESS", summary: `from https://u.pcloud.link/publink/show?code=XZabc123` });
    expect(res.status).toBe(200);
    const dump = JSON.stringify(b.db.rows("SELECT * FROM tasks"));
    expect(dump).not.toMatch(/Amz|q3-contract|publink|XZabc123/);
    expect(dump).toContain("https://u.pcloud.link/[link]");
  });
});

// ── 2. retention without the cron ────────────────────────────────────────────────────────────────────────────

describe("retention", () => {
  const addEvent = (b: Awaited<ReturnType<typeof boot>>, key: string, at: number) =>
    b.db.sqlite.query("INSERT INTO events (source_id, key, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'halt', '" + ORIGIN_HOST + "', 'info', 'x', ?, ?)").run(key, at, at);
  const heartbeat = (b: Awaited<ReturnType<typeof boot>>, now: number) => b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: now }, now);

  test("RETENTION_DAYS: default 30, a valid whole number >= 1 wins, anything else falls back", () => {
    expect(ALERT_DEFAULTS.retentionDays).toBe(30);
    expect(retentionDays({})).toBe(30);
    expect(retentionDays({ RETENTION_DAYS: "7" })).toBe(7);
    expect(retentionDays({ RETENTION_DAYS: " 14 " })).toBe(14);
    expect(retentionDays({ RETENTION_DAYS: "2.9" })).toBe(2);
    for (const bad of ["", "0", "-3", "abc", "NaN", "Infinity"]) expect(retentionDays({ RETENTION_DAYS: bad })).toBe(30);
    expect(retentionDaysOf({ RETENTION_DAYS: "999999" }, 30)).toBe(3650);
  });

  test("a successful ingest purges old rows without any cron, and not again within 15 minutes", async () => {
    const b = await boot({ OPPORTUNISTIC_MAINTENANCE: "1" });
    addEvent(b, "old1", NOW - 31 * DAY);
    addEvent(b, "new", NOW - DAY);
    await heartbeat(b, NOW);
    expect(b.db.rows<any>("SELECT key FROM events")).toEqual([{ key: "new" }]);
    expect(b.meta(META_LAST_PURGE)).toBe(String(NOW));

    addEvent(b, "old2", NOW - 31 * DAY);
    await heartbeat(b, NOW + PURGE_EVERY_MS - MIN); // 14 min later: not due
    expect(b.count("events", "key = 'old2'")).toBe(1);
    await heartbeat(b, NOW + PURGE_EVERY_MS); // 15 min later: due
    expect(b.count("events", "key = 'old2'")).toBe(0);
    expect(b.meta(META_LAST_PURGE)).toBe(String(NOW + PURGE_EVERY_MS));
  });

  test("/api/state also runs the housekeeping (an open dashboard keeps a quiet installation tidy)", async () => {
    const b = await boot({ OPPORTUNISTIC_MAINTENANCE: "1" });
    addEvent(b, "old", NOW - 40 * DAY);
    expect((await b.get("/api/state")).status).toBe(200);
    expect(b.count("events")).toBe(0);
  });

  test("a refused or failing request starts nothing (no token, bad body, cross-site state read)", async () => {
    const b = await boot({ OPPORTUNISTIC_MAINTENANCE: "1" });
    addEvent(b, "old", NOW - 40 * DAY);
    const res = await route(request("/api/ingest/heartbeat", { token: "oct_wrong", body: { v: 1, host: "hosta", at: NOW } }), b.env, b.ctx, { now: NOW });
    await b.ctx.flush();
    expect(res.status).toBe(401);
    expect((await route(request("/api/ingest/snapshot", { token: b.host, rawBody: "{nope" }), b.env, b.ctx, { now: NOW })).status).toBe(400);
    await b.ctx.flush();
    expect((await route(request("/api/state", { headers: { "Sec-Fetch-Site": "cross-site" } }), b.env, b.ctx, { now: NOW })).status).toBe(403);
    await b.ctx.flush();
    expect(b.count("events")).toBe(1);
    expect(b.meta(META_LAST_PURGE)).toBeUndefined();
  });

  test("RETENTION_DAYS=7 keeps a week", async () => {
    const b = await boot({ OPPORTUNISTIC_MAINTENANCE: "1", RETENTION_DAYS: "7" });
    addEvent(b, "eight", NOW - 8 * DAY);
    addEvent(b, "six", NOW - 6 * DAY);
    await heartbeat(b, NOW);
    expect(b.db.rows<any>("SELECT key FROM events")).toEqual([{ key: "six" }]);
  });

  test("two concurrent requests do not both purge: the claim is one conditional write", async () => {
    const b = await boot();
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimMeta(b.env.DB, META_LAST_PURGE, NOW, PURGE_EVERY_MS)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimMeta(b.env.DB, META_LAST_PURGE, NOW + PURGE_EVERY_MS - 1, PURGE_EVERY_MS)).toBe(false);
    expect(await claimMeta(b.env.DB, META_LAST_PURGE, NOW + PURGE_EVERY_MS, PURGE_EVERY_MS)).toBe(true);
    // purgeIfDue on top: the same stamp decides
    addEvent(b, "old", NOW - 40 * DAY);
    expect(await purgeIfDue(b.env, NOW + PURGE_EVERY_MS + 1)).toBeNull();
    expect(b.count("events")).toBe(1);
    expect(await purgeIfDue(b.env, NOW + 2 * PURGE_EVERY_MS)).toMatchObject({ events: 1 });
  });

  test("bounded work: one run deletes at most PURGE_BATCH rows per table, the rest follow in later runs", async () => {
    const b = await boot();
    b.db.sqlite.exec("BEGIN");
    const ins = b.db.sqlite.query("INSERT INTO events (source_id, key, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'status', '" + ORIGIN_HOST + "', 'info', 'x', ?, ?)");
    for (let i = 0; i < PURGE_BATCH * 2 + 100; i++) ins.run(`e${i}`, NOW - 40 * DAY, NOW - 40 * DAY);
    b.db.sqlite.exec("COMMIT");
    expect(PURGE_BATCH).toBe(500);
    expect(await purgeIfDue(b.env, NOW)).toMatchObject({ events: PURGE_BATCH });
    expect(b.count("events")).toBe(PURGE_BATCH + 100);
    expect(await purgeIfDue(b.env, NOW + PURGE_EVERY_MS)).toMatchObject({ events: PURGE_BATCH });
    expect(await purgeIfDue(b.env, NOW + 2 * PURGE_EVERY_MS)).toMatchObject({ events: 100 });
    expect(b.count("events")).toBe(0);
  });

  test("the purge covers every table (same set as before) and push_budget keeps its own rules", async () => {
    const b = await boot();
    const old = NOW - 31 * DAY;
    b.db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'h1', 'p', '{}', ?)").run(old);
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('gone', ?)").run(old);
    b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, task_id, title, state, created, updated) VALUES ('k', 's', 'mcp', 'a', 't', 'done', 1, ?)").run(old);
    b.db.sqlite.query("INSERT INTO push_budget (k, owner, touched, day_start) VALUES ('own|x', 'x', ?, ?)").run(NOW - PUSH_BUDGET_IDLE_MS - 1, NOW - 3 * DAY);
    const removed = await purgeIfDue(b.env, NOW);
    expect(removed).toEqual({ events: 0, tasks: 1, alerts: 0, openAlerts: 0, snapshots: 1, hosts: 1, projectSeen: 0, usageDaily: 0, usageHourly: 0, usageHosts: 0, pushBudget: 1 });
  });

  test("one failing table does not stop the purge of the others, and the error still surfaces", async () => {
    const b = await boot();
    const old = NOW - 31 * DAY;
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('gone', ?)").run(old);
    b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, task_id, title, state, created, updated) VALUES ('k', 's', 'mcp', 'a', 't', 'done', 1, ?)").run(old);
    b.db.sqlite.query("DROP TABLE events").run(); // the FIRST table in the purge order: a real error, not "no such table" handling
    await expect(purgeOld(b.env.DB, NOW, 30)).rejects.toThrow(/events:/);
    expect(b.count("tasks")).toBe(0); // tables after the failing one were still purged
    expect(b.db.rows<any>("SELECT host FROM hosts")).toEqual([]);
  });

  test("a quiet project that still reports keeps its old snapshot; a silent one loses it", async () => {
    const b = await boot();
    const old = NOW - 31 * DAY;
    b.db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'h1', 'quiet', '{}', ?)").run(old);
    b.db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'h1', 'gone', '{}', ?)").run(old);
    b.db.sqlite.query("INSERT INTO project_seen (host, project, last_seen) VALUES ('h1', 'quiet', ?)").run(NOW - MIN);
    b.db.sqlite.query("INSERT INTO project_seen (host, project, last_seen) VALUES ('h1', 'gone', ?)").run(old);
    const removed = await purgeIfDue(b.env, NOW);
    expect(removed).toMatchObject({ snapshots: 1, projectSeen: 1 });
    expect(b.db.rows<any>("SELECT project FROM snapshots ORDER BY project")).toEqual([{ project: "quiet" }]);
    expect(b.db.rows<any>("SELECT project FROM project_seen ORDER BY project")).toEqual([{ project: "quiet" }]);
  });

  test("the cron keeps purging (same claim) and stamps last_cron", async () => {
    const b = await boot({ OPPORTUNISTIC_MAINTENANCE: "1" });
    addEvent(b, "old", NOW - 40 * DAY);
    await runCron(b.env, b.ctx, NOW);
    expect(b.count("events")).toBe(0);
    expect(b.meta(META_LAST_CRON)).toBe(String(NOW));
    expect(b.meta(META_LAST_PURGE)).toBe(String(NOW));
  });
});

describe("time-based rules without the cron", () => {
  // host `silent` last seen 7 minutes ago (HOST_OFFLINE_AFTER_MS is 6 min); host `hosta` is the one that sends the request.
  async function bootSilent(over: Parameters<typeof makeEnv>[0] = {}) {
    const b = await boot({ OPPORTUNISTIC_MAINTENANCE: "1", ...over });
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('silent', ?)").run(NOW - 7 * MIN);
    return b;
  }
  const hb = (b: Awaited<ReturnType<typeof boot>>, now: number) => b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: now }, now);
  const offline = (b: Awaited<ReturnType<typeof boot>>) => b.db.rows<any>("SELECT key, resolved FROM alerts WHERE key = 'host-offline|silent'");

  test("an ingest opens host-offline when the cron has never run", async () => {
    const b = await bootSilent();
    await hb(b, NOW);
    expect(offline(b)).toEqual([{ key: "host-offline|silent", resolved: null }]);
    expect(b.meta(META_LAST_TICK)).toBe(String(NOW));
    expect(b.meta(META_LAST_CRON)).toBeUndefined();
  });

  test("not while the cron runs (last_cron younger than 2 minutes), and again once it stopped", async () => {
    const b = await bootSilent();
    await runCron(b.env, b.ctx, NOW - MIN); // the cron ran a minute ago ... and its own evaluation is what we want to ignore:
    b.db.sqlite.exec("DELETE FROM alerts");
    await hb(b, NOW);
    expect(offline(b)).toEqual([]); // the cron owns the rules
    await hb(b, NOW - MIN + CRON_FRESH_MS + 1); // the cron has been silent for more than 2 minutes
    expect(offline(b)).toHaveLength(1);
  });

  test("at most once per minute", async () => {
    const b = await bootSilent();
    await hb(b, NOW);
    b.db.sqlite.exec("DELETE FROM alerts");
    await hb(b, NOW + 30_000); // inside the minute: no tick
    expect(offline(b)).toEqual([]);
    await hb(b, NOW + TICK_EVERY_MS);
    expect(offline(b)).toHaveLength(1);
    expect(b.meta(META_LAST_TICK)).toBe(String(NOW + TICK_EVERY_MS));
  });

  test("concurrent requests: one tick (the claim is a conditional write)", async () => {
    const b = await bootSilent();
    const claims = await Promise.all(Array.from({ length: 6 }, () => claimMeta(b.env.DB, META_LAST_TICK, NOW, TICK_EVERY_MS)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  test("OPPORTUNISTIC_MAINTENANCE=0 switches it all off", async () => {
    const b = await bootSilent({ OPPORTUNISTIC_MAINTENANCE: "0" });
    await hb(b, NOW);
    expect(offline(b)).toEqual([]);
    await maintainOpportunistically(b.env, b.ctx, NOW);
    expect(offline(b)).toEqual([]);
  });

  test("a failing database never throws out of the maintenance", async () => {
    const b = await bootSilent();
    const broken = { ...b.env, DB: { prepare() { throw new Error("D1 is down"); }, batch() { throw new Error("D1 is down"); } } as unknown as D1Database };
    const orig = console.error;
    console.error = () => undefined;
    try {
      await expect(maintainOpportunistically(broken, b.ctx, NOW)).resolves.toBeUndefined();
      await expect(purgeIfDue(broken, NOW)).resolves.toBeNull();
    } finally {
      console.error = orig;
    }
  });
});

describe("maintenance ON (the production default): a full invocation stays within a D1 statement budget", () => {
  // The whole suite runs with OPPORTUNISTIC_MAINTENANCE=0 so it can count statements exactly; this is the one place
  // that runs the real flow with it ON: the response's own work (inline rules included) plus, in ctx.waitUntil, the
  // purge claim + bounded deletes, the last_cron read, the tick claim and the time-based rules. Statements are counted
  // as the shim sees them (every member of a D1 batch counts, a batch is one subrequest in production), so the bound
  // is conservative. Every invocation stays under the Free plan's 50 queries with this many statements (47: the
  // well-being metrics upsert, migration 0007, is the one statement a minute that came last), and under 45 SUBREQUESTS
  // (a D1 batch is one subrequest), counted separately below.
  const MAX_STATEMENTS = 47;
  const MAX_SUBREQUESTS = 45;
  /** What maintenance may add to the same invocation (measured 10 for a tick, 18-20 with a purge; + 2 for the well-being tick). */
  const MAX_MAINTENANCE_EXTRA = 29; // + the usage_hourly purge (migration 0005) + the stale MCP task close + well-being (0007: settings read, metrics upsert, wb_metrics purge)

  async function scenario(maintenance: "0" | "1") {
    const t = makeEnv({ OPPORTUNISTIC_MAINTENANCE: maintenance });
    const ctx = makeCtx();
    const host = await addSource(t.db, "hosta", "host");
    t.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('silent', ?)").run(NOW - 7 * MIN); // a silent host: the time rules have something to open
    t.db.sqlite.exec("BEGIN");
    const ins = t.db.sqlite.query("INSERT INTO events (source_id, key, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'status', '" + ORIGIN_HOST + "', 'info', 'x', ?, ?)");
    for (let i = 0; i < 40; i++) ins.run(`old${i}`, NOW - 40 * DAY, NOW - 40 * DAY); // ... and the purge has something to delete
    t.db.sqlite.exec("COMMIT");
    const used: Record<string, number> = {};
    const subrequests: Record<string, number> = {};
    const measure = async (label: string, req: Request, now: number) => {
      const before = t.db.statements.length;
      const inBatch = t.db.executed;
      const batches = t.db.batches;
      const res = await route(req, t.env, ctx, { now });
      await ctx.flush(); // everything handed to waitUntil
      expect(res.status).toBe(200);
      used[label] = t.db.statements.length - before;
      subrequests[label] = used[label] - (t.db.executed - inBatch) + (t.db.batches - batches);
    };
    const snap = snapshot(
      {
        tasks: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, agent: "Agent01", title: `task ${i}`, state: i % 2 ? "blocked" : "running", dispatchedAt: NOW - 20 * MIN, updatedAt: NOW - MIN })),
        approvals: [{ id: "a1", summary: "x", requestedAt: NOW - 10 * MIN, agent: "Agent01" }, { id: "a2", summary: "y", requestedAt: NOW - 9 * MIN }],
        discussions: [{ id: "d1", topic: "t", status: "active", round: 1, maxRounds: 3, messages: 1, maxMessages: 9, participants: ["Agent01"], benched: [], updatedAt: NOW }],
      } as never,
      NOW,
    );
    const events = {
      v: 1,
      host: "hosta",
      project: "proja",
      events: Array.from({ length: 10 }, (_, i) => ({ kind: i === 0 ? "halt" : "status", origin: ORIGIN_HOST, at: NOW + 60_000 - i, severity: i === 0 ? "critical" : "info", key: `e${i}`, agent: "Agent01", ...(i === 0 ? { scenario: "cli-gone" } : { status: "IN_PROGRESS" }), text: "x" })),
    };
    // One call a minute (each is the first of its minute, so each may run the maintenance tick), then one inside the same minute, then one 16 minutes on (a purge is due again).
    await measure("snapshot", request("/api/ingest/snapshot", { token: host, body: snap }), NOW);
    await measure("events", request("/api/ingest/events", { token: host, body: events }), NOW + MIN + 1000);
    await measure("state", request("/api/state"), NOW + 2 * MIN + 2000);
    await measure("heartbeat", request("/api/ingest/heartbeat", { token: host, body: { v: 1, host: "hosta", at: NOW + 3 * MIN } }), NOW + 3 * MIN + 3000);
    await measure("state, same minute", request("/api/state"), NOW + 3 * MIN + 10_000);
    await measure("state, 16 min on", request("/api/state"), NOW + 16 * MIN);
    // minute 22 is a quarter hour's minute 7: the well-being stress sample runs with the tick (the purge is not due again)
    await measure("snapshot, stress sample minute", request("/api/ingest/snapshot", { token: host, body: { ...snap, sentAt: NOW + 22 * MIN } }), NOW + 22 * MIN);
    return { t, used, subrequests };
  }

  test("every invocation is under the statement budget, maintenance adds a bounded amount, and inside the same minute it adds nothing", async () => {
    const off = await scenario("0");
    const on = await scenario("1");
    for (const [label, n] of Object.entries(on.used)) {
      expect([label, n <= MAX_STATEMENTS]).toEqual([label, true]);
      expect([label, (on.subrequests[label] as number) <= MAX_SUBREQUESTS]).toEqual([label, true]);
      expect([label, n - off.used[label] <= MAX_MAINTENANCE_EXTRA]).toEqual([label, true]);
      expect(n).toBeGreaterThanOrEqual(off.used[label]);
    }
    expect(on.used["state, same minute"]).toBe(off.used["state, same minute"]); // the per-isolate throttle: no D1 query at all
    expect(on.used["snapshot"]).toBeGreaterThan(off.used["snapshot"]); // ... and the test is not vacuous: maintenance really ran
  });

  test("the maintenance in those invocations did its jobs: purged, opened host-offline from the clock, kept the cron stamps clean", async () => {
    const { t } = await scenario("1");
    const n = (sql: string) => t.db.rows<{ n: number }>(sql)[0].n;
    expect(n("SELECT COUNT(*) AS n FROM events WHERE key LIKE 'old%'")).toBe(0); // purged by an opportunistic run
    expect(n("SELECT COUNT(*) AS n FROM alerts WHERE key = 'host-offline|silent' AND resolved IS NULL")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM alerts WHERE rule = 'agent-stuck'")).toBe(1); // the halt from the events batch (the later snapshot resolves it)
    expect(n("SELECT COUNT(*) AS n FROM meta WHERE k = 'last_cron'")).toBe(0); // only the real cron writes it
    expect(n("SELECT COUNT(*) AS n FROM wb_metrics WHERE name = 'stress'")).toBe(1); // the 15-minute stress sample ran at minute 22 (inside the budget above)
    expect(n("SELECT COUNT(*) AS n FROM meta WHERE k IN ('last_purge', 'last_tick')")).toBe(2);
  });
});

// ── 3. cross-site ─────────────────────────────────────────────────────────────────────────────────────────

describe("cross-site browser requests are refused", () => {
  const PUBLIC = "https://dash.test";
  const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "x", auth: "y" } };

  test("isCrossSiteRequest", () => {
    const env = { PUBLIC_URL: PUBLIC };
    const req = (headers: Record<string, string>, url = "https://dash.test/api/state") => new Request(url, { headers });
    expect(isCrossSiteRequest(req({}), env)).toBe(false);
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "same-origin" }), env)).toBe(false);
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "none" }), env)).toBe(false);
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "cross-site" }), env)).toBe(true);
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "Cross-Site" }), env)).toBe(true);
    // a sibling subdomain (same-site) is not the dashboard either, and neither is any value a browser does not send
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "same-site" }), env)).toBe(true);
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "same-site", Origin: PUBLIC }), env)).toBe(true);
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "SAME-ORIGIN" }), env)).toBe(false);
    expect(isCrossSiteRequest(req({ "Sec-Fetch-Site": "something-new" }), env)).toBe(true);
    expect(isCrossSiteRequest(req({ Origin: PUBLIC }), env)).toBe(false);
    expect(isCrossSiteRequest(req({ Origin: "https://evil.example.com" }), env)).toBe(true);
    expect(isCrossSiteRequest(req({ Origin: "null" }), env)).toBe(true);
    expect(isCrossSiteRequest(req({ Origin: "http://dash.test" }), env)).toBe(true); // other scheme = other origin
    expect(isCrossSiteRequest(req({ Origin: "https://dash.test.evil.com" }), env)).toBe(true);
    // the request's own origin counts only on localhost (wrangler dev), never for a public host
    expect(isCrossSiteRequest(req({ Origin: "http://localhost:8787" }, "http://localhost:8787/api/state"), env)).toBe(false);
    expect(isCrossSiteRequest(req({ Origin: "https://other.example.com" }, "https://other.example.com/api/state"), env)).toBe(true);
    // PUBLIC_URL unset: nothing matches it
    expect(isCrossSiteRequest(req({ Origin: PUBLIC }), { PUBLIC_URL: "" })).toBe(true);
  });

  test("/api/state: 403 for a cross-site fetch or a foreign Origin, 200 for the page itself and for curl; never an Access-Control-* header", async () => {
    const b = await boot();
    const ok = await b.get("/api/state");
    expect(ok.status).toBe(200);
    for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.example.com" }, { Origin: "null" }, { "Sec-Fetch-Site": "same-origin", Origin: "https://evil.example.com" }]) {
      const res = await b.get("/api/state", { headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross-site request refused" });
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
    for (const headers of [{ "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "none" }, { Origin: PUBLIC }]) expect((await b.get("/api/state", { headers })).status).toBe(200);
    expect([...ok.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  test("/api/push/*: the same refusal, before anything is read or written", async () => {
    const b = await boot();
    for (const [path, method, body] of [["/api/push/key", "GET", undefined], ["/api/push/subscribe", "POST", SUB], ["/api/push/test", "POST", {}]] as const) {
      for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.example.com" }]) {
        const res = await b.get(path, { method, body, headers });
        expect(res.status).toBe(403);
        expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
      }
    }
    expect(b.count("push_subs")).toBe(0);
    // an OPTIONS preflight from another origin is refused too
    expect((await b.get("/api/state", { method: "OPTIONS", headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "GET" } })).status).toBe(403);
  });

  test("ingest and MCP are not browser routes: a missing Origin / Sec-Fetch-Site never matters there", async () => {
    const b = await boot();
    expect((await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: NOW })).status).toBe(200);
  });
});

// ── 4. HSTS ───────────────────────────────────────────────────────────────────────────────────────────────

describe("Strict-Transport-Security", () => {
  test("every response carries it: ingest (2xx and refusals), state, health, 404, MCP, assets", async () => {
    const b = await boot();
    const responses: Response[] = [
      await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: NOW }),
      await route(request("/api/ingest/heartbeat", { token: "oct_wrong", body: {} }), b.env, b.ctx, { now: NOW }),
      await b.get("/api/state"),
      await b.get("/api/state", { headers: { "Sec-Fetch-Site": "cross-site" } }),
      await b.get("/api/health"),
      await b.get("/api/nope"),
      await b.get("/%2e%2e/state"),
      await b.mcp("heartbeat", {}),
      await b.get("/"),
    ];
    for (const res of responses) expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    expect(HSTS).toBe("max-age=31536000");
  });

  test("a response with immutable headers (the assets binding) is copied, not mutated", async () => {
    const t = makeEnv();
    const frozen = new Response("asset", { status: 200, headers: { "Content-Type": "text/html" } });
    Object.defineProperty(frozen, "headers", { value: new Proxy(frozen.headers, { get: (target, p) => (p === "set" ? () => { throw new TypeError("immutable"); } : (target as any)[p]?.bind?.(target) ?? (target as any)[p]) }) });
    (t.env as any).ASSETS = { fetch: async () => frozen };
    const res = await route(request("/"), t.env, makeCtx(), { now: NOW });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset");
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  });

  test("public/_headers sets it for the static assets (they bypass the Worker) and keeps the CSP", () => {
    const text = readFileSync(join(import.meta.dir, "..", "public", "_headers"), "utf8");
    expect(text).toContain("Strict-Transport-Security: max-age=31536000");
    expect(text).toContain("Content-Security-Policy: default-src 'none'");
    expect(text).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=()");
    expect(text).toContain("Cross-Origin-Opener-Policy: same-origin");
  });

  test("wrangler.toml exposes RETENTION_DAYS (30) as a var", () => {
    const text = readFileSync(join(import.meta.dir, "..", "wrangler.toml"), "utf8");
    expect(text).toMatch(/^RETENTION_DAYS = "30"$/m);
  });
});

// ── 5. textMode ───────────────────────────────────────────────────────────────────────────────────────────

describe("the pusher's text mode", () => {
  const projectsOf = async (b: Awaited<ReturnType<typeof boot>>) => ((await (await b.get("/api/state")).json()) as any).projects;

  test("full / titles / none are stored and returned by /api/state; absent or unknown = full", async () => {
    for (const mode of ["full", "titles", "none"] as const) {
      const b = await boot();
      expect((await b.post("/api/ingest/snapshot", { ...snapshot({}, NOW), textMode: mode })).status).toBe(200);
      expect((await projectsOf(b))[0].textMode).toBe(mode);
    }
    for (const mode of [undefined, "everything", 7, null, "TITLES"]) {
      const b = await boot();
      expect((await b.post("/api/ingest/snapshot", { ...snapshot({}, NOW), textMode: mode })).status).toBe(200);
      expect((await projectsOf(b))[0].textMode).toBe("full");
      expect(b.db.rows<{ json: string }>("SELECT json FROM snapshots")[0].json).not.toContain("textMode");
    }
  });
});

describe("hashed chat event keys (new pushers) next to raw ones (old pushers)", () => {
  const halt = (key: string, at = NOW - 1000) => ({ v: 1, host: "hosta", project: "proja", events: [{ kind: "halt", origin: ORIGIN_HOST, at, severity: "critical", key, scenario: "cli-gone", agent: "Agent01", text: "x gone" }] });

  test("keys are opaque dedupe strings: the same key twice is one event, a raw and a hashed key are two (never an error), and the alert does not depend on either", async () => {
    const b = await boot();
    const hashed = "0123456789abcdef";
    expect((await b.post("/api/ingest/events", halt("$RawEventId:example.org"))).status).toBe(200);
    expect((await b.post("/api/ingest/events", halt("$RawEventId:example.org"))).status).toBe(200); // a retry of the old pusher's batch
    expect(b.count("events")).toBe(1);
    expect((await b.post("/api/ingest/events", halt(hashed))).status).toBe(200); // the upgraded pusher re-sends the same halt
    expect((await b.post("/api/ingest/events", halt(hashed))).status).toBe(200);
    expect(b.count("events")).toBe(2); // one extra row at the moment of the upgrade, never more
    expect(b.db.rows<any>("SELECT key FROM alerts WHERE rule = 'agent-stuck' AND resolved IS NULL")).toHaveLength(1); // ... and still ONE alert
  });
});
