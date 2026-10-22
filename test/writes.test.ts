// D1 Free-plan economy (rows written / read) and push de-duplication across flapping alerts.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { SQL_RULE_SNAPSHOTS } from "../src/alerts";
import { HOST_WRITE_EVERY_MS, LIVENESS_WRITE_FLOOR_MS, openAlertsStmt, PROJECT_SEEN_WRITE_FLOOR_MS } from "../src/db";
import { route, runCron } from "../src/index";
import { REOPEN_GRACE_MS } from "../src/rules";
import { addSource, makeCtx, makeEnv, request, setupPush, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const FLOOR_MS = LIVENESS_WRITE_FLOOR_MS;

/** Count every INSERT / UPDATE / DELETE per table with triggers (that is what D1 bills as rows written). */
function logWrites(db: D1Shim): (table: string) => Record<string, number> {
  const sql = ["tasks", "hosts", "snapshots", "alerts", "events", "project_seen"]
    .flatMap((t) => [["I", "INSERT"], ["U", "UPDATE"], ["D", "DELETE"]].map(([op, ev]) => `CREATE TRIGGER w_${t}_${op} AFTER ${ev} ON ${t} BEGIN INSERT INTO _w VALUES ('${t}', '${op}'); END;`))
    .join("\n");
  db.sqlite.exec(`CREATE TABLE _w (t TEXT, op TEXT); ${sql}`);
  return (table) => {
    const out: Record<string, number> = {};
    for (const r of db.rows<{ op: string; n: number }>("SELECT op, COUNT(*) AS n FROM _w WHERE t = ? GROUP BY op", table)) out[r.op] = r.n;
    return out;
  };
}

function countingEnv() {
  const t = makeEnv();
  let evaluations = 0;
  const real = t.env.DB as any;
  t.env.DB = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => { if (sql === SQL_RULE_SNAPSHOTS) evaluations++; return target.prepare(sql); };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...t, evaluations: () => evaluations };
}

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, agent: "agent01", title: `task ${id}`, state: "running", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000, ...over,
});

async function boot() {
  const t = countingEnv();
  const ctx = makeCtx();
  const token = await addSource(t.db, "hosta", "host");
  const writes = logWrites(t.db);
  const post = (path: string, body: unknown, now = NOW, fetch?: (u: string) => Promise<Response>) =>
    route(request(path, { token, body }), t.env, ctx, { now, fetch }).then(async (r) => { await ctx.flush(); return r; });
  return { ...t, ctx, token, writes, post };
}

describe("an unchanged snapshot is cheap", () => {
  test("same tasks/agents/approvals: no task writes and no rule evaluation; the snapshot row and discussions still update", async () => {
    const b = await boot();
    const s1 = snapshot({ tasks: [task("t1"), task("t2"), task("t3")], discussions: [] } as never, NOW);
    const first = await (await b.post("/api/ingest/snapshot", s1)).json() as any;
    expect(first).toMatchObject({ unchanged: false });
    expect(b.evaluations()).toBe(1);
    expect(b.writes("tasks")).toEqual({ I: 3 });

    const later = NOW + 20_000;
    const s2 = snapshot({
      tasks: [task("t1"), task("t2"), task("t3")], sentAt: later,
      poller: { status: "running", binaryVersion: "1.0.1", lastPoll: later },
      discussions: [{ id: "d1", topic: "new", status: "active", round: 1, maxRounds: 2, messages: 1, maxMessages: 4, participants: ["agent01"], benched: [], updatedAt: later }],
    } as never, NOW);
    const second = await (await b.post("/api/ingest/snapshot", s2, later)).json() as any;
    expect(second).toMatchObject({ ok: true, unchanged: true, alertsOpened: 0, alertsResolved: 0 });
    expect(b.writes("tasks")).toEqual({ I: 3 }); // not a single task row touched
    expect(b.evaluations()).toBe(1); // no rule evaluation
    const stored = JSON.parse(b.db.rows<any>("SELECT json FROM snapshots")[0].json);
    expect(stored.sentAt).toBe(later); // the stored snapshot is the newest one
    expect(stored.discussions).toHaveLength(1); // the new discussion made it into the stored snapshot
    expect(b.db.rows<any>("SELECT received_at FROM snapshots")[0].received_at).toBe(later);
  });

  test("a changed snapshot still evaluates the rules (and the cron covers time-based flips either way)", async () => {
    const b = await boot();
    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1")] } as never, NOW));
    expect(b.evaluations()).toBe(1);
    const res = await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1", { state: "blocked", lastLine: "STATUS: BLOCKED" })] } as never, NOW), NOW + 5000);
    expect(await res.json()).toMatchObject({ unchanged: false, alertsOpened: 1 });
    expect(b.evaluations()).toBe(2);
    // identical again -> skipped; the alert is untouched, nothing re-evaluated
    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1", { state: "blocked", lastLine: "STATUS: BLOCKED" })] } as never, NOW), NOW + 10_000);
    expect(b.evaluations()).toBe(2);
    expect(b.db.rows("SELECT * FROM alerts WHERE resolved IS NULL")).toHaveLength(1);
    // time passes: the cron (not ingest) is what notices time-based changes
    await runCron(b.env, b.ctx, NOW + 7 * 60 * MIN);
    await b.ctx.flush();
    expect(b.evaluations()).toBe(3);
  });
});

describe("task rows are only written when a stored column differs", () => {
  test("changing one task rewrites exactly that row; removing one deletes exactly one; unchanged rows cost nothing", async () => {
    const b = await boot();
    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1"), task("t2"), task("t3")] } as never, NOW));
    expect(b.writes("tasks")).toEqual({ I: 3 });

    // agents changed (so the snapshot is NOT skipped), the three tasks are identical -> no task write
    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1"), task("t2"), task("t3")], agents: [{ name: "agent01", state: "idle" }] } as never, NOW + 1000), NOW + 1000);
    expect(b.writes("tasks")).toEqual({ I: 3 });

    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1"), task("t2", { lastLine: "STATUS: IN PROGRESS" }), task("t3")], agents: [{ name: "agent01", state: "idle" }] } as never, NOW + 2000), NOW + 2000);
    expect(b.writes("tasks")).toEqual({ I: 3, U: 1 });

    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1"), task("t2", { lastLine: "STATUS: IN PROGRESS" })], agents: [{ name: "agent01", state: "idle" }] } as never, NOW + 3000), NOW + 3000);
    expect(b.writes("tasks")).toEqual({ I: 3, U: 1, D: 1 });
    expect(b.db.rows<any>("SELECT task_id FROM tasks ORDER BY task_id")).toEqual([{ task_id: "t1" }, { task_id: "t2" }]);
  });

  test("relay task rows are conditional too", async () => {
    const b = await boot();
    const relay = (at: number, text: string) => ({ v: 1, host: "hosta", project: "proja", events: [{ kind: "status", origin: ORIGIN_RELAY, at, severity: "info", key: `r${at}`, agent: "bot", sender: "@bot:srv", status: "IN_PROGRESS", text }] });
    await b.post("/api/ingest/events", relay(NOW - 3000, "STATUS: IN PROGRESS building"));
    await b.post("/api/ingest/events", relay(NOW - 2000, "STATUS: IN PROGRESS building")); // same task content, newer time -> `updated` differs -> 1 update
    expect(b.writes("tasks")).toEqual({ I: 1, U: 1 });
    await b.post("/api/ingest/events", relay(NOW - 2000, "STATUS: IN PROGRESS building")); // exact replay (same key too)
    expect(b.writes("tasks")).toEqual({ I: 1, U: 1 });
  });
});

describe("host liveness: every heartbeat, snapshot and events batch refreshes it (floor only); a refused request keeps the 90 s throttle", () => {
  const FLOOR = LIVENESS_WRITE_FLOOR_MS;
  test(`heartbeats and events refresh last_seen unless one just did (${FLOOR / 1000} s floor); the binary version never triggers a write by itself`, async () => {
    const b = await boot();
    const hb = (now: number, binaryVersion?: string) => b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: now, ...(binaryVersion ? { binaryVersion } : {}) }, now);
    const ev = (now: number) => b.post("/api/ingest/events", { v: 1, host: "hosta", project: "proja", events: [{ kind: "status", origin: ORIGIN_HOST, at: now, severity: "info", key: `e${now}`, agent: "agent01", status: "DONE", text: "STATUS: DONE ok" }] }, now);
    await hb(NOW, "1.0.1");
    expect(b.writes("hosts")).toEqual({ I: 1 });
    await hb(NOW + FLOOR - 1000);                                  // inside the floor: nothing
    expect(b.writes("hosts")).toEqual({ I: 1 });
    expect(b.db.rows<any>("SELECT last_seen FROM hosts")[0].last_seen).toBe(NOW);
    await hb(NOW + FLOOR);                                         // every real heartbeat (>= 60 s apart) lands here
    expect(b.writes("hosts")).toEqual({ I: 1, U: 1 });
    expect(b.db.rows<any>("SELECT last_seen, binary_version FROM hosts")[0]).toEqual({ last_seen: NOW + FLOOR, binary_version: "1.0.1" });
    await hb(NOW + FLOOR + 5000, "1.0.2");                       // a NEW version inside the floor: no write, version unchanged
    expect(b.writes("hosts")).toEqual({ I: 1, U: 1 });
    expect(b.db.rows<any>("SELECT binary_version FROM hosts")[0].binary_version).toBe("1.0.1");
    await hb(NOW + 2 * FLOOR, "1.0.2");                          // the write the heartbeat would have made anyway takes it along
    expect(b.writes("hosts")).toEqual({ I: 1, U: 2 });
    expect(b.db.rows<any>("SELECT binary_version FROM hosts")[0].binary_version).toBe("1.0.2");

    // events refresh it under the same floor (an accepted events batch resets the pusher's heartbeat timer, so it must count)
    const W = NOW + 2 * FLOOR;
    await ev(W + FLOOR - 1000);
    expect(b.writes("hosts")).toEqual({ I: 1, U: 2 });
    await ev(W + FLOOR);
    expect(b.writes("hosts")).toEqual({ I: 1, U: 3 });
    // a host coming back after a long silence is written immediately (that is what clears host-offline)
    await hb(NOW + 60 * MIN);
    expect(b.writes("hosts")).toEqual({ I: 1, U: 4 });
  });

  test("a NULL binary version is filled by the first call that names it, at most once per host; alternating versions cost exactly the writes of a constant one", async () => {
    const run = async (version: (i: number) => string | undefined) => {
      const b = await boot();
      const hb = (now: number, binaryVersion?: string) => b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: now, ...(binaryVersion ? { binaryVersion } : {}) }, now);
      await hb(NOW); // the row exists (an events call creates it the same way) with no version
      expect(b.writes("hosts")).toEqual({ I: 1 });
      expect(b.db.rows<any>("SELECT last_seen, binary_version FROM hosts")[0]).toEqual({ last_seen: NOW, binary_version: null });
      await hb(NOW + 5000); // still no version, inside the floor: nothing
      expect(b.writes("hosts")).toEqual({ I: 1 });
      await hb(NOW + 10_000, "1.0.2"); // the first version: written NOW (the NULL fill), not a floor later
      expect(b.writes("hosts")).toEqual({ I: 1, U: 1 });
      expect(b.db.rows<any>("SELECT binary_version FROM hosts")[0].binary_version).toBe("1.0.2");
      for (let i = 1; i <= 50; i++) await hb(NOW + 10_000 + i * 1000, version(i));
      return { b, writes: b.writes("hosts").U ?? 0, hb };
    };
    const alternating = await run((i) => (i % 2 ? "a" : "b"));
    const constant = await run(() => "1.0.2");
    const unversioned = await run(() => undefined);
    // 50 s of heartbeats one second apart: only the floor decides, so all three cost the same (1 NULL fill + one write per 20 s)
    expect(alternating.writes).toBe(constant.writes);
    expect(alternating.writes).toBe(unversioned.writes);
    expect(alternating.writes).toBeLessThanOrEqual(1 + Math.ceil(50_000 / LIVENESS_WRITE_FLOOR_MS));
    // an unversioned call never blanks the stored version
    expect(unversioned.b.db.rows<any>("SELECT binary_version FROM hosts")[0].binary_version).toBe("1.0.2");
    // a later write adopts the sender's new version
    await alternating.hb(NOW + 10_000 + 50_000 + FLOOR, "1.0.3");
    expect(alternating.b.db.rows<any>("SELECT binary_version FROM hosts")[0].binary_version).toBe("1.0.3");
  });

  test("a snapshot refreshes the host row too (floor only), a refused request keeps the 90 s throttle", async () => {
    const b = await boot();
    await b.post("/api/ingest/snapshot", snapshot({ poller: { status: "running", binaryVersion: "1.0.2" } } as never, NOW), NOW);
    expect(b.writes("hosts")).toEqual({ I: 1 });
    await b.post("/api/ingest/snapshot", snapshot({ poller: { status: "running", binaryVersion: "1.0.2" } } as never, NOW + FLOOR_MS - 1000), NOW + FLOOR_MS - 1000);
    expect(b.writes("hosts")).toEqual({ I: 1 });
    await b.post("/api/ingest/snapshot", snapshot({ poller: { status: "running", binaryVersion: "1.0.2" } } as never, NOW + FLOOR_MS), NOW + FLOOR_MS);
    expect(b.writes("hosts")).toEqual({ I: 1, U: 1 });
  });

  test("an events call creates the host row without a version; the snapshot that follows names it right away (one extra write)", async () => {
    const b = await boot();
    await b.post("/api/ingest/events", { v: 1, host: "hosta", project: "proja", events: [{ kind: "status", origin: ORIGIN_HOST, at: NOW, severity: "info", key: "e1", agent: "agent01", status: "DONE", text: "STATUS: DONE ok" }] });
    expect(b.db.rows<any>("SELECT binary_version FROM hosts")[0].binary_version).toBeNull();
    expect(b.writes("hosts")).toEqual({ I: 1 });
    await b.post("/api/ingest/snapshot", snapshot({ poller: { status: "running", binaryVersion: "1.0.2" } } as never, NOW + 3000), NOW + 3000);
    expect(b.db.rows<any>("SELECT last_seen, binary_version FROM hosts")[0]).toEqual({ last_seen: NOW + 3000, binary_version: "1.0.2" });
    expect(b.writes("hosts")).toEqual({ I: 1, U: 1 });
    await b.post("/api/ingest/snapshot", snapshot({ poller: { status: "running", binaryVersion: "1.0.3" } } as never, NOW + 6000), NOW + 6000); // a changed version waits for the window
    expect(b.writes("hosts")).toEqual({ I: 1, U: 1 });
  });

  test("a heartbeat with nothing to resolve writes nothing to alerts", async () => {
    const b = await boot();
    await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: NOW });
    expect(b.writes("alerts")).toEqual({});
  });
});

describe("a re-opened alert keeps its push counters inside the 30 min grace", () => {
  function seed(db: D1Shim, resolvedAgo: number) {
    db.sqlite
      .query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened, last_pushed, push_count, resolved) VALUES ('blocked|h|p|t', 'blocked', 'warn', '" + ORIGIN_HOST + "', 'h', 'p', 'a', 'old text', ?, ?, 2, ?)")
      .run(NOW - 60 * MIN, NOW - 20 * MIN, NOW - resolvedAgo);
  }
  const reopen = async (db: D1Shim) => {
    await openAlertsStmt(db as unknown as D1Database, [{ key: "blocked|h|p|t", rule: "blocked", severity: "warn", origin: "mcp", host: "h", project: "p", agent: "a", text: "new text" }], NOW).run();
    return db.rows<any>("SELECT origin, text, opened, last_pushed, push_count, resolved FROM alerts")[0];
  };

  test("resolved less than REOPEN_GRACE_MS ago: same incident (opened, last_pushed, push_count kept; text and origin refreshed)", async () => {
    const { db } = makeEnv();
    seed(db, REOPEN_GRACE_MS - 1);
    expect(await reopen(db)).toEqual({ origin: "mcp", text: "new text", opened: NOW - 60 * MIN, last_pushed: NOW - 20 * MIN, push_count: 2, resolved: null });
  });

  test("resolved REOPEN_GRACE_MS or longer ago: a fresh episode (counters reset)", async () => {
    const { db } = makeEnv();
    seed(db, REOPEN_GRACE_MS);
    expect(await reopen(db)).toEqual({ origin: "mcp", text: "new text", opened: NOW, last_pushed: null, push_count: 0, resolved: null });
  });

  test("an alert that is still open is never touched by an open request", async () => {
    const { db } = makeEnv();
    seed(db, 1);
    db.sqlite.query("UPDATE alerts SET resolved = NULL").run();
    expect(await reopen(db)).toMatchObject({ text: "old text", push_count: 2, opened: NOW - 60 * MIN });
  });
});

describe("stale snapshot sequence end to end: one push for one incident", () => {
  test("halt -> stale snapshot resolves -> fresh snapshot re-opens: a single push, push_count stays 1", async () => {
    const b = await boot();
    const push = await setupPush(b);
    const T = NOW;
    const snap = (sentAt: number, state: string) => snapshot({ host: "hosta", sentAt, agents: [{ name: "Agent02", state }] } as never, NOW);
    const step = async (path: string, body: unknown, now: number) => (await b.post(path, body, now, push.fetch)).json() as Promise<any>;

    // 1. the bot's halt notice arrives
    const a = await step("/api/ingest/events", { v: 1, host: "hosta", project: "proja", events: [{ kind: "halt", origin: ORIGIN_HOST, at: T, severity: "critical", key: "h1", agent: "Agent02", scenario: "benched", text: "Agent02 benched" }] }, T + 1_000);
    expect(a).toMatchObject({ accepted: 1, alertsOpened: 1 });
    expect(push.pushes).toHaveLength(1);

    // 2. a snapshot BUILT before the halt but with a later sentAt (the WP-A race): agent still idle -> resolves
    const stale = await step("/api/ingest/snapshot", snap(T + 5_000, "idle"), T + 6_000);
    expect(stale).toMatchObject({ alertsResolved: 1 });
    expect(b.db.rows<any>("SELECT resolved FROM alerts")[0].resolved).toBe(T + 6_000);

    // 3. the next snapshot shows the agent benched: the condition holds again -> re-opened, NOT pushed again
    const fresh = await step("/api/ingest/snapshot", snap(T + 65_000, "benched"), T + 66_000);
    expect(fresh).toMatchObject({ alertsOpened: 1 });
    expect(push.pushes).toHaveLength(1);
    expect(b.db.rows<any>("SELECT resolved, push_count, last_pushed FROM alerts")[0]).toEqual({ resolved: null, push_count: 1, last_pushed: T + 1_000 });

    // 4. and it stays quiet
    await runCron(b.env, b.ctx, T + 120_000, { fetch: push.fetch });
    await b.ctx.flush();
    expect(push.pushes).toHaveLength(1);
  });
});
