import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { ALERT_DEFAULTS, HOST_OFFLINE_AFTER_MS, PROJECT_OFFLINE_AFTER_MS, PROJECT_OFFLINE_MAX_MS } from "../src/shared/schema";
import { RULE_PROJECT_LIMIT, SQL_RULE_PROJECTS, isNoSuchTable, purgeOld } from "../src/alerts";
import { LIVENESS_WRITE_FLOOR_MS, PROJECT_SEEN_WRITE_FLOOR_MS } from "../src/db";
import { route, runCron } from "../src/index";
import { evaluateRules, pushDue, pushMessage, type RuleAlert, type RuleInput, type RuleProjectSeen } from "../src/rules";
import { addSource, makeCtx, makeEnv, request, setupPush, snapshot } from "./d1-shim";

/**
 * Per-project liveness: `project_seen` (migration 0002) is refreshed by snapshots, heartbeats and events; the page marks a
 * silent project "reporter offline"; the `project-offline` rule pushes once for a project that went quiet on a LIVE host.
 */
const NOW = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ── the rule (pure) ──────────────────────────────────────────────────────────

function input(over: Partial<RuleInput> = {}): RuleInput {
  return { now: NOW, snapshots: [], hosts: [{ host: "hosta", last_seen: NOW - 30 * SEC }], tasks: [], events: [], alerts: [], projectSeen: [], ...over };
}
const silent = (ms: number, over: Partial<RuleProjectSeen> = {}): RuleProjectSeen => ({ host: "hosta", project: "proja", last_seen: NOW - ms, ...over });

describe("rule project-offline", () => {
  test("constants: 6 min like the host, retired after 24 h", () => {
    expect(PROJECT_OFFLINE_AFTER_MS).toBe(HOST_OFFLINE_AFTER_MS);
    expect(PROJECT_OFFLINE_AFTER_MS).toBe(6 * MIN);
    expect(PROJECT_OFFLINE_MAX_MS).toBe(24 * HOUR);
    expect(ALERT_DEFAULTS.projectOfflineAfterMs).toBe(PROJECT_OFFLINE_AFTER_MS);
  });

  test("opens strictly after 6 min of silence on a live host: critical, host agent, no agent, one per (host, project)", () => {
    expect(evaluateRules(input({ projectSeen: [silent(6 * MIN)] })).desired).toEqual([]);
    const out = evaluateRules(input({ projectSeen: [silent(6 * MIN + 1)] }));
    expect(out.open).toHaveLength(1);
    expect(out.open[0]).toMatchObject({ key: "project-offline|hosta|proja", rule: "project-offline", severity: "critical", origin: ORIGIN_HOST, host: "hosta", project: "proja", agent: null });
    expect(out.open[0].text).toBe("proja@hosta: Reporter sent nothing for more than 6 min (the host is online)");
    expect(out.push.map((p) => p.key)).toEqual(["project-offline|hosta|proja"]);        // pushed on open
  });

  test("pushed ONCE: an open alert that was pushed is not pushed again, and a re-open inside the grace keeps its counters", () => {
    const open: RuleAlert = { key: "project-offline|hosta|proja", rule: "project-offline", host: "hosta", project: "proja", origin: ORIGIN_HOST, opened: NOW - 20 * MIN, last_pushed: NOW - 20 * MIN, push_count: 1, resolved: null };
    expect(evaluateRules(input({ projectSeen: [silent(40 * MIN)], alerts: [open] })).push).toEqual([]);
    const flapped: RuleAlert = { ...open, resolved: NOW - 5 * MIN };
    const back = evaluateRules(input({ projectSeen: [silent(40 * MIN)], alerts: [flapped] }));
    expect(back.open.map((a) => a.key)).toEqual(["project-offline|hosta|proja"]);
    expect(back.push).toEqual([]);                                                    // same incident: no second push
    expect(pushDue({ rule: "project-offline", push_count: 0, last_pushed: null, opened: NOW - 5 * MIN }, NOW)).toBe(true);
    expect(pushDue({ rule: "project-offline", push_count: 1, last_pushed: NOW - 5 * MIN, opened: NOW - 5 * MIN }, NOW)).toBe(false);
  });

  test("resolves silently when the project reports again (it is no longer in the silent list)", () => {
    const open: RuleAlert = { key: "project-offline|hosta|proja", rule: "project-offline", host: "hosta", project: "proja", origin: ORIGIN_HOST, opened: NOW - 20 * MIN, last_pushed: NOW - 20 * MIN, push_count: 1, resolved: null };
    const out = evaluateRules(input({ projectSeen: [], alerts: [open] }));
    expect(out.resolve).toEqual(["project-offline|hosta|proja"]);
    expect(out.push).toEqual([]);
  });

  test("skipped when the WHOLE host is offline (host-offline says it once; no push per project), and resolved silently when that happens", () => {
    const hosts = [{ host: "hosta", last_seen: NOW - 7 * MIN }];
    const both = evaluateRules(input({ hosts, projectSeen: [silent(10 * MIN), silent(10 * MIN, { project: "web" })] }));
    expect(both.desired.map((d) => d.key)).toEqual(["host-offline|hosta"]);
    expect(both.push.map((p) => p.key)).toEqual(["host-offline|hosta"]);
    const open: RuleAlert = { key: "project-offline|hosta|proja", rule: "project-offline", host: "hosta", project: "proja", origin: ORIGIN_HOST, opened: NOW - 20 * MIN, last_pushed: NOW - 20 * MIN, push_count: 1, resolved: null };
    expect(evaluateRules(input({ hosts, projectSeen: [silent(10 * MIN)], alerts: [open] })).resolve).toEqual(["project-offline|hosta|proja"]);
    // a host the rules cannot see at all: nothing opens (it cannot be told apart from an offline one)
    expect(evaluateRules(input({ hosts: [], projectSeen: [silent(10 * MIN)] })).desired).toEqual([]);
  });

  test("a project silent for more than 24 h is taken for retired: no alert, an open one resolves silently", () => {
    expect(evaluateRules(input({ projectSeen: [silent(PROJECT_OFFLINE_MAX_MS)] })).open).toHaveLength(1);
    const gone = silent(PROJECT_OFFLINE_MAX_MS + 1);
    expect(evaluateRules(input({ projectSeen: [gone] })).desired).toEqual([]);
    const open: RuleAlert = { key: "project-offline|hosta|proja", rule: "project-offline", host: "hosta", project: "proja", origin: ORIGIN_HOST, opened: NOW - 25 * HOUR, last_pushed: NOW - 25 * HOUR, push_count: 1, resolved: null };
    expect(evaluateRules(input({ projectSeen: [gone], alerts: [open] })).resolve).toEqual(["project-offline|hosta|proja"]);
  });

  test("a scan that was cut off (or a host list that was) resolves nothing, but may still open", () => {
    const open: RuleAlert = { key: "project-offline|hosta|proja", rule: "project-offline", host: "hosta", project: "proja", origin: ORIGIN_HOST, opened: NOW - 20 * MIN, last_pushed: NOW - 20 * MIN, push_count: 1, resolved: null };
    expect(evaluateRules(input({ projectSeen: [], alerts: [open], truncated: ["projects"] })).resolve).toEqual([]);
    expect(evaluateRules(input({ projectSeen: [], alerts: [open], truncated: ["hosts"] })).resolve).toEqual([]);
    expect(evaluateRules(input({ projectSeen: [silent(10 * MIN)], truncated: ["projects"] })).open).toHaveLength(1);
  });

  test("never counted against the alert caps (bounded by the per-host project limit instead)", () => {
    const many = Array.from({ length: 30 }, (_, i) => silent(10 * MIN, { project: `p${i}` }));
    const out = evaluateRules(input({ projectSeen: many }));
    expect(out.open).toHaveLength(30);
    expect(out.desired.some((d) => d.rule === "alerts-capped")).toBe(false);
  });

  test("the push says what happened and where: `proja@hosta: reporter offline`", () => {
    expect(pushMessage({ key: "project-offline|hosta|proja", rule: "project-offline", host: "hosta", project: "proja", agent: null, origin: ORIGIN_HOST, severity: "critical" }, "https://x").body).toBe("proja@hosta: reporter offline");
  });
});

// ── through the Worker ───────────────────────────────────────────────────────

async function boot() {
  const t = makeEnv();
  const push = await setupPush(t);
  const ctx = makeCtx();
  const token = await addSource(t.db, "hosta", "host");
  const send = async (path: string, body: unknown, now: number) => {
    const res = await route(request(path, { token, body }), t.env, ctx, { now, fetch: push.fetch });
    await ctx.flush();
    expect(res.status).toBe(200);
    return res;
  };
  const snap = (project: string, now: number) => send("/api/ingest/snapshot", snapshot({ host: "hosta", project, tasks: [], agents: [{ name: "Agent01", baseCli: "claude", state: "idle" }] } as never, now), now);
  const beat = (project: string | undefined, now: number) => send("/api/ingest/heartbeat", { v: 1, host: "hosta", ...(project ? { project } : {}), at: now, binaryVersion: "1.0.4" }, now);
  const cron = async (now: number) => { await runCron(t.env, ctx, now, { fetch: push.fetch }); await ctx.flush(); };
  const state = async (now: number) => (await (await route(request("/api/state"), t.env, ctx, { now })).json()) as any;
  const seen = () => Object.fromEntries(t.db.rows<{ project: string; last_seen: number }>("SELECT project, last_seen FROM project_seen").map((r) => [r.project, r.last_seen]));
  const alerts = () => t.db.rows<{ key: string; rule: string; resolved: number | null; push_count: number }>("SELECT key, rule, resolved, push_count FROM alerts ORDER BY key");
  return { ...t, ctx, token, push, send, snap, beat, cron, state, seen, alerts };
}

describe("project_seen is recorded by snapshots, heartbeats and events", () => {
  test("a snapshot creates the row; heartbeats and events of that project refresh it (20 s floor); other projects and invented names are not touched", async () => {
    expect(PROJECT_SEEN_WRITE_FLOOR_MS).toBe(LIVENESS_WRITE_FLOOR_MS);                // the same floor as the host row
    expect(PROJECT_SEEN_WRITE_FLOOR_MS).toBeLessThanOrEqual(45 * SEC);
    const b = await boot();
    await b.snap("proja", NOW);
    expect(b.seen()).toEqual({ proja: NOW });
    await b.beat("proja", NOW + 10 * SEC);                                              // inside the floor: no write
    expect(b.seen()).toEqual({ proja: NOW });
    await b.beat("proja", NOW + PROJECT_SEEN_WRITE_FLOOR_MS);
    expect(b.seen()).toEqual({ proja: NOW + PROJECT_SEEN_WRITE_FLOOR_MS });
    await b.send("/api/ingest/events", { v: 1, host: "hosta", project: "proja", events: [{ kind: "status", origin: ORIGIN_HOST, at: NOW + 3 * MIN, severity: "info", key: "e1", agent: "agent01", status: "DONE", text: "STATUS: DONE ok" }] }, NOW + 3 * MIN);
    expect(b.seen()).toEqual({ proja: NOW + 3 * MIN });
    await b.beat("web", NOW + 4 * MIN);                                               // no snapshot for it: nothing is invented
    await b.beat(undefined, NOW + 5 * MIN);                                           // a heartbeat without a project only touches the host
    expect(Object.keys(b.seen())).toEqual(["proja"]);
  });

  test("/api/state carries lastSeen per project (null when none is recorded yet)", async () => {
    const b = await boot();
    await b.snap("proja", NOW);
    await b.snap("web", NOW);
    b.db.sqlite.query("DELETE FROM project_seen WHERE project = 'web'").run();
    await b.beat("proja", NOW + 2 * MIN);
    const s = await b.state(NOW + 2 * MIN);
    const by = Object.fromEntries(s.projects.map((p: any) => [p.project, p.lastSeen]));
    expect(by).toEqual({ proja: NOW + 2 * MIN, web: null });
  });
});

describe("one project, events then a lost heartbeat: the project never looks silent (the review's scenario, per project)", () => {
  const events = (b: Awaited<ReturnType<typeof boot>>, at: number) =>
    b.send("/api/ingest/events", { v: 1, host: "hosta", project: "proja", events: [{ kind: "status", origin: ORIGIN_HOST, at, severity: "info", key: `e${at}`, agent: "agent01", status: "DONE", text: "STATUS: DONE ok" }] }, at);
  /** Every 15 s: the page's own test (`lastSeen` older than 6 min) on /api/state, and the cron every wall-clock minute. */
  async function watch(b: Awaited<ReturnType<typeof boot>>, from: number, to: number) {
    for (let now = from; now <= to; now += 15 * SEC) {
      if ((now - NOW) % MIN === 0) await b.cron(now);
      const lastSeen = (await b.state(now)).projects.find((p: any) => p.project === "proja").lastSeen as number;
      expect({ at: now - from, silent: now - lastSeen > PROJECT_OFFLINE_AFTER_MS }).toEqual({ at: now - from, silent: false });
    }
  }

  test("write at W, events at W+89 s, the due heartbeat is LOST and the next arrives 145 s later (379 s after W): no project-offline, never marked silent", async () => {
    const b = await boot();
    const W = NOW;
    await b.snap("proja", W);
    await events(b, W + 89 * SEC);                                                    // resets the pusher's heartbeat timer; recorded under the 20 s floor
    await watch(b, W, W + 378 * SEC);
    await b.beat("proja", W + 379 * SEC);
    expect(b.alerts().filter((a) => a.rule === "project-offline")).toEqual([]);
  });

  test("write at W, events at W+89 s, a LATE heartbeat (+145 s) and one more lost: 290 s of silence, never project-offline", async () => {
    const b = await boot();
    const W = NOW;
    await b.snap("proja", W);
    await events(b, W + 89 * SEC);
    await b.beat("proja", W + 89 * SEC + 145 * SEC);
    await watch(b, W, W + 89 * SEC + 145 * SEC + 290 * SEC - 5 * SEC);
    await b.beat("proja", W + 89 * SEC + 145 * SEC + 290 * SEC);
    expect(b.alerts().filter((a) => a.rule === "project-offline")).toEqual([]);
  });
});

describe("a dead reporter on a live host", () => {
  test("proja goes quiet while web keeps heartbeating: ONE critical push after 6 min, the host stays online, it resolves the moment proja reports", async () => {
    const b = await boot();
    await b.snap("proja", NOW);
    await b.snap("web", NOW);
    let now = NOW;
    for (let i = 0; i < 4; i++) {                                                     // 8 minutes: web heartbeats every 2 min, proja is dead
      now += 2 * MIN;
      await b.beat("web", now);
      await b.cron(now);
    }
    expect(b.alerts().map((a) => a.rule)).toEqual(["project-offline"]);
    expect(b.alerts()[0]).toMatchObject({ key: "project-offline|hosta|proja", resolved: null, push_count: 1 });
    expect(b.push.pushes).toHaveLength(1);                                            // exactly one push
    for (let i = 0; i < 5; i++) { now += MIN; await b.beat("web", now); await b.cron(now); }
    expect(b.push.pushes).toHaveLength(1);                                            // and not another one, minute after minute
    const s = await b.state(now);
    expect(s.hosts[0].offline).toBe(false);
    expect(Object.fromEntries(s.projects.map((p: any) => [p.project, now - p.lastSeen > PROJECT_OFFLINE_AFTER_MS]))).toEqual({ proja: true, web: false });
    expect(s.inbox.map((a: any) => a.rule)).toEqual(["project-offline"]);

    await b.beat("proja", now + 10 * SEC);                                              // the reporter is back: resolved right away, no cron needed
    expect(b.alerts()[0].resolved).not.toBeNull();
    expect(b.push.pushes).toHaveLength(1);
  });

  test("a snapshot from the project resolves it too", async () => {
    const b = await boot();
    await b.snap("proja", NOW);
    await b.snap("web", NOW);
    await b.beat("web", NOW + 7 * MIN);
    await b.cron(NOW + 7 * MIN);
    expect(b.alerts()).toHaveLength(1);
    await b.snap("proja", NOW + 7 * MIN + 10 * SEC);
    expect(b.alerts()[0].resolved).not.toBeNull();
  });

  test("when the whole host goes quiet only host-offline fires (one push), never a push per project", async () => {
    const b = await boot();
    await b.snap("proja", NOW);
    await b.snap("web", NOW);
    for (let m = 1; m <= 12; m++) await b.cron(NOW + m * MIN);
    expect(b.alerts().map((a) => a.rule)).toEqual(["host-offline"]);
    expect(b.push.pushes).toHaveLength(1);
  });

  test("a project that stopped for good (> 24 h) stops alerting, silently; the page still marks it", async () => {
    const b = await boot();
    await b.snap("proja", NOW);
    await b.snap("web", NOW);
    await b.beat("web", NOW + 7 * MIN);
    await b.cron(NOW + 7 * MIN);
    expect(b.alerts()[0]).toMatchObject({ rule: "project-offline", resolved: null });
    await b.beat("web", NOW + 25 * HOUR);
    await b.cron(NOW + 25 * HOUR);
    expect(b.alerts()[0].resolved).not.toBeNull();
    expect(b.push.pushes).toHaveLength(1);
    const s = await b.state(NOW + 25 * HOUR);
    expect(s.projects.find((p: any) => p.project === "proja").lastSeen).toBe(NOW);
  });
});

describe("without migration 0002 (a Worker deployed before the table exists)", () => {
  test("ingest, rules, state and purge keep working; nothing per-project is recorded and nothing alerts", async () => {
    const b = await boot();
    b.db.sqlite.exec("DROP TABLE project_seen");
    await b.snap("proja", NOW);
    await b.beat("proja", NOW + 2 * MIN);
    await b.send("/api/ingest/events", { v: 1, host: "hosta", project: "proja", events: [{ kind: "status", origin: ORIGIN_HOST, at: NOW, severity: "info", key: "e1", agent: "agent01", status: "DONE", text: "STATUS: DONE ok" }] }, NOW + 2 * MIN);
    await b.cron(NOW + 7 * MIN);
    const s = await b.state(NOW + 7 * MIN);
    expect(s.projects[0].lastSeen).toBeNull();
    expect(s.rulesTruncated).toEqual([]);                                             // a missing table is not "a flood"
    expect((await purgeOld(b.env.DB, NOW, 30)).projectSeen).toBe(0);
    expect(b.alerts().filter((a) => a.rule === "project-offline")).toEqual([]);
  });
});

describe("retention purge of project_seen", () => {
  const rawDb = (b: Awaited<ReturnType<typeof boot>>) => b.env.DB;
  const DAY = 24 * HOUR;

  test("rows older than the retention period are REALLY deleted, oldest first, at most `limit` per run (it used to be swallowed silently)", async () => {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO project_seen (host, project, last_seen) VALUES (?, ?, ?)");
    for (let i = 0; i < 5; i++) ins.run("old", `p${i}`, NOW - 31 * DAY - i * HOUR);     // p4 is the oldest
    ins.run("new", "p", NOW - DAY);
    b.db.statements.length = 0;
    const first = await purgeOld(rawDb(b), NOW, 30, 2);
    expect(first.projectSeen).toBe(2);
    expect(b.db.statements.find((q) => q.includes("DELETE FROM project_seen"))).toContain("ORDER BY last_seen LIMIT");   // the statement itself walks the index in age order
    expect(b.db.rows<{ project: string }>("SELECT project FROM project_seen WHERE host = 'old' ORDER BY project").map((r) => r.project)).toEqual(["p0", "p1", "p2"]); // the two OLDEST went
    expect((await purgeOld(rawDb(b), NOW, 30, 2)).projectSeen).toBe(2);
    expect((await purgeOld(rawDb(b), NOW, 30, 2)).projectSeen).toBe(1);
    expect((await purgeOld(rawDb(b), NOW, 30, 2)).projectSeen).toBe(0);
    expect(b.db.rows("SELECT host FROM project_seen")).toEqual([{ host: "new" }]);
    const plan = (b.db.sqlite.query("EXPLAIN QUERY PLAN SELECT host, project FROM project_seen WHERE last_seen < ?1 ORDER BY last_seen LIMIT ?2").all(NOW, 2) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_project_seen_last");
    expect(plan).not.toContain("TEMP B-TREE");                                           // no sort: the index order is the delete order
  });

  test("an error that is not a missing table SURFACES (a wrong parameter count, an outage); only 'no such table' is tolerated", async () => {
    const b = await boot();
    const failing = (needle: RegExp, message: string): D1Database =>
      new Proxy(rawDb(b), {
        get(target, prop) {
          if (prop !== "prepare") return (target as any)[prop].bind?.(target) ?? (target as any)[prop];
          return (sql: string) => (needle.test(sql) ? { bind: () => ({ run: async () => { throw new Error(message); } }) } : target.prepare(sql));
        },
      }) as unknown as D1Database;
    await expect(purgeOld(failing(/DELETE FROM project_seen/, "D1_ERROR: wrong parameter count"), NOW, 30)).rejects.toThrow("wrong parameter count");
    await expect(purgeOld(failing(/DELETE FROM snapshots/, "D1_ERROR: database is locked"), NOW, 30)).rejects.toThrow("database is locked");
    // ... but the missing table (migration 0002 not applied yet) is tolerated, and snapshots fall back to received_at
    expect(isNoSuchTable(new Error("D1_ERROR: no such table: project_seen: SQLITE_ERROR"))).toBe(true);
    expect(isNoSuchTable(new Error("D1_ERROR: wrong parameter count"))).toBe(false);
    const old = NOW - 31 * DAY;
    b.db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'h', 'p', '{}', ?)").run(old);
    b.db.sqlite.exec("DROP TABLE project_seen");
    const removed = await purgeOld(rawDb(b), NOW, 30);
    expect(removed.snapshots).toBe(1);                                                    // the fallback ran
    expect(removed.projectSeen).toBe(0);
  });
});

describe("the scan", () => {
  test("SQL_RULE_PROJECTS reads only the silent ones through idx_project_seen_last, oldest first", async () => {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO project_seen (host, project, last_seen) VALUES (?, ?, ?)");
    for (let i = 0; i < 200; i++) ins.run(`h${i % 10}`, `p${i}`, NOW - (i % 3 === 0 ? 10 * MIN + i : 10 * SEC));
    b.db.sqlite.exec("ANALYZE");
    const args = [NOW - PROJECT_OFFLINE_AFTER_MS, NOW - PROJECT_OFFLINE_MAX_MS, RULE_PROJECT_LIMIT + 1];
    const plan = (b.db.sqlite.query(`EXPLAIN QUERY PLAN ${SQL_RULE_PROJECTS}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_project_seen_last");
    expect(plan).not.toMatch(/SCAN project_seen\s*(\||$)/);
    const rows = b.db.sqlite.query(SQL_RULE_PROJECTS).all(...args) as Array<{ last_seen: number }>;
    expect(rows).toHaveLength(67);
    expect(rows.every((r) => r.last_seen < NOW - PROJECT_OFFLINE_AFTER_MS)).toBe(true);
    expect(rows.map((r) => r.last_seen)).toEqual([...rows.map((r) => r.last_seen)].sort((a, c) => a - c));
  });

  test("the per-host project limit bounds the table: 30 projects per host, a 31st snapshot is refused and records nothing", async () => {
    const b = await boot();
    for (let i = 0; i < 30; i++) await b.snap(`p${i}`, NOW + i);
    const res = await route(request("/api/ingest/snapshot", { token: b.token, body: snapshot({ host: "hosta", project: "p-extra" } as never, NOW + 100) }), b.env, b.ctx, { now: NOW + 100 });
    expect(res.status).toBe(429);
    expect(Object.keys(b.seen())).toHaveLength(30);
    expect(b.seen()["p-extra"]).toBeUndefined();
  });
});
