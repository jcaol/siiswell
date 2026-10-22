// Audit part 2 (fix round 5): unbudgeted writes, snapshot size / structure caps, push budget semantics,
// an over-budget host that must not look offline, the bounded /api/state, and claims that never read `changes`.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRITICAL_PUSH_WINDOW_MS,
  MAX_CRITICAL_HALTS_PER_DAY,
  MAX_CRITICAL_PUSHES_PER_HOUR,
  hostWriteBudget,
  MAX_MCP_MUTATIONS_PER_DAY,
  MAX_OPEN_TASKS_PER_HOST,
  MAX_PROJECTS_PER_HOST,
  MAX_PUSHES_PER_SOURCE_PER_DAY,
  MAX_PUSHES_PER_SOURCE_PER_WINDOW,
  MAX_RELAY_SENDERS_PER_HOST,
  MAX_STORED_AGENTS,
  MAX_STORED_APPROVALS,
  MAX_STORED_DISCUSSIONS,
  MAX_STORED_SNAPSHOT_BYTES,
  WRITE_COST,
} from "../src/env";
import { route, runCron } from "../src/index";
import { HOST_WRITE_EVERY_MS, LIVENESS_WRITE_FLOOR_MS, PROJECT_SEEN_WRITE_FLOOR_MS } from "../src/db";
import { dispatchPushes } from "../src/push";
import { pushMessage, type PushItem } from "../src/rules";
import { STATE_MAX_BYTES, buildState } from "../src/state";
import { addSource, makeCtx, makeEnv, request, setupPush, shimOptions, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown, id = 1) => rpc("tools/call", { name, arguments: args }, id);

/** Count every write to the given tables (a trigger per operation: what D1 would bill as rows written). */
function countWrites(db: D1Shim, tables: string[]): (table: string) => number {
  db.sqlite.exec("CREATE TABLE IF NOT EXISTS _w5 (t TEXT)");
  for (const t of tables) for (const op of ["INSERT", "UPDATE", "DELETE"]) db.sqlite.exec(`CREATE TRIGGER IF NOT EXISTS w5_${t}_${op} AFTER ${op} ON ${t} BEGIN INSERT INTO _w5 VALUES ('${t}'); END;`);
  return (t) => db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM _w5 WHERE t = ?", t)[0]?.n ?? 0;
}

async function bootHost(over: Parameters<typeof makeEnv>[0] = {}) {
  const t = makeEnv(over);
  const push = await setupPush(t);
  const ctx = makeCtx();
  const token = await addSource(t.db, "hosta", "host");
  const post = async (path: string, body: unknown, now = NOW) => {
    const res = await route(request(path, { token, body }), t.env, ctx, { now, fetch: push.fetch });
    await ctx.flush();
    return res;
  };
  const cron = async (now: number) => {
    await runCron(t.env, ctx, now, { fetch: push.fetch });
    await ctx.flush();
  };
  const wr = () => (t.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'hosta'")[0] as { wr_count: number }).wr_count;
  const events = (list: unknown[], project = "proja") => ({ v: 1, host: "hosta", project, events: list });
  const snap = (over: Record<string, unknown> = {}, now = NOW) => snapshot({ host: "hosta", ...over } as never, now);
  return { ...t, ctx, push, token, post, cron, wr, events, snap };
}
const task = (id: string, over: Record<string, unknown> = {}) => ({ id, agent: "agent01", title: `task ${id}`, state: "running", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000, ...over });

// ── 1a. heartbeats ───────────────────────────────────────────────────────────

describe("1a. heartbeats cannot turn into an unbounded write path", () => {
  test("100 heartbeats alternating binaryVersion within one 90 s window write the hosts row only as often as the floor allows (it used to be 100 writes, none charged)", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const token = await addSource(t.db, "evil", "host");
    const writes = countWrites(t.db, ["hosts", "sources", "alerts"]);
    for (let i = 0; i < 100; i++) {
      const now = NOW + (i * HOST_WRITE_EVERY_MS) / 100;   // 100 heartbeats spread over 90 s
      const res = await route(request("/api/ingest/heartbeat", { token, body: { v: 1, host: "evil", binaryVersion: i % 2 ? "a" : "b" } }), t.env, ctx, { now });
      expect(res.status).toBe(200);
    }
    expect(writes("hosts")).toBeLessThanOrEqual(1 + Math.ceil(HOST_WRITE_EVERY_MS / LIVENESS_WRITE_FLOOR_MS)); // 1 insert + one update per floor
    expect(writes("sources")).toBe(1); // the (5-minute throttled) last_seen touch
    expect(writes("alerts")).toBe(0);
  });

  test("over an hour heartbeats are bounded by time, not by count: at most one hosts write per floor and one project_seen write per project floor, whatever they carry", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const token = await addSource(t.db, "evil", "host");
    t.db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'evil', 'p1', '{}', 1)").run();
    const writes = countWrites(t.db, ["hosts", "project_seen"]);
    for (let s = 0; s < 3600; s += 5) await route(request("/api/ingest/heartbeat", { token, body: { v: 1, host: "evil", project: "p1", binaryVersion: `v${s}` } }), t.env, ctx, { now: NOW + s * 1000 });
    expect(writes("hosts")).toBeLessThanOrEqual(1 + 3600_000 / LIVENESS_WRITE_FLOOR_MS); // 4,320 a day at the very worst
    expect(writes("project_seen")).toBeLessThanOrEqual(1 + 3600_000 / PROJECT_SEEN_WRITE_FLOOR_MS);
    expect(writes("project_seen")).toBeGreaterThan(10);
  });

  test("a heartbeat naming an INVENTED project grows nothing: project_seen only ever holds projects the host has a snapshot for", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const token = await addSource(t.db, "evil", "host");
    for (let i = 0; i < 200; i++) await route(request("/api/ingest/heartbeat", { token, body: { v: 1, host: "evil", project: `invented-${i}` } }), t.env, ctx, { now: NOW + i * 30_000 });
    expect(t.db.rows("SELECT * FROM project_seen")).toEqual([]);
  });
});

// ── 2. snapshot structure and size ───────────────────────────────────────────

describe("2. a stored snapshot is small, capped and charged by size", () => {
  test("the stored JSON has no tasks (they are rows of the tasks table); unchanged detection uses the fingerprint", async () => {
    const b = await bootHost();
    const s1 = b.snap({ tasks: [task("t1"), task("t2")] });
    expect(((await (await b.post("/api/ingest/snapshot", s1)).json()) as any)).toMatchObject({ ok: true, unchanged: false, tasks: 2 });
    const stored = b.db.rows<{ json: string; fp: string; open_tasks: number }>("SELECT json, fp, open_tasks FROM snapshots")[0] as { json: string; fp: string; open_tasks: number };
    expect(JSON.parse(stored.json)).not.toHaveProperty("tasks");
    expect(stored.fp).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.open_tasks).toBe(2);
    expect(b.db.rows("SELECT task_id FROM tasks ORDER BY task_id")).toEqual([{ task_id: "t1" }, { task_id: "t2" }]);
    const again = (await (await b.post("/api/ingest/snapshot", b.snap({ tasks: [task("t1"), task("t2")], sentAt: NOW + 5000 }), NOW + 5000)).json()) as any;
    expect(again).toMatchObject({ unchanged: true });
    const changed = (await (await b.post("/api/ingest/snapshot", b.snap({ tasks: [task("t1", { state: "blocked" }), task("t2")] }), NOW + 10_000)).json()) as any;
    expect(changed).toMatchObject({ unchanged: false });
  });

  test("agents, discussions and approvals beyond their caps are dropped and counted", async () => {
    const b = await bootHost();
    const agents = Array.from({ length: 30 }, (_, i) => ({ name: `agent${i}`, state: "idle" }));
    const discussions = Array.from({ length: 15 }, (_, i) => ({ id: `d${i}`, topic: "t", status: "in_progress", round: 1, maxRounds: 2, messages: 1, maxMessages: 4, participants: ["a"], benched: [], updatedAt: NOW }));
    const approvals = Array.from({ length: 30 }, (_, i) => ({ id: `ap${i}`, summary: "x", requestedAt: NOW - 1000 }));
    const res = (await (await b.post("/api/ingest/snapshot", b.snap({ agents, discussions, approvals }))).json()) as any;
    expect(res.dropped).toBe(10 + 5 + 10);
    expect(res.firstError).toMatch(/only the first \d+ are kept/);
    const stored = JSON.parse((b.db.rows<{ json: string }>("SELECT json FROM snapshots")[0] as { json: string }).json);
    expect([stored.agents.length, stored.discussions.length, stored.approvals.length]).toEqual([MAX_STORED_AGENTS, MAX_STORED_DISCUSSIONS, MAX_STORED_APPROVALS]);
  });

  test("a stored snapshot over 32 KB is a 413 with the reason; nothing is stored; the host still counts as alive", async () => {
    const b = await bootHost();
    const fat = (i: number) => ({ id: `d${i}`, topic: "t".repeat(100), status: "in_progress", round: 1, maxRounds: 3, messages: 1, maxMessages: 9, participants: Array.from({ length: 20 }, (_, k) => `agent-${"x".repeat(80)}-${k}`), benched: Array.from({ length: 20 }, (_, k) => `bench-${"y".repeat(80)}-${k}`), updatedAt: NOW });
    const res = await b.post("/api/ingest/snapshot", b.snap({ discussions: Array.from({ length: MAX_STORED_DISCUSSIONS }, (_, i) => fat(i)) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/snapshot too large: \d+ bytes stored without its tasks, at most 32768/);
    expect(b.db.rows("SELECT * FROM snapshots")).toEqual([]);
    expect(b.db.rows("SELECT last_seen FROM hosts")).toEqual([{ last_seen: NOW }]);
  });

  test("a snapshot is charged what D1 bills: ONE row however large (an update 1, the first one of a project 2 with its key), plus the request", async () => {
    const b = await bootHost();
    const written = countWrites(b.db, ["snapshots"]);
    const discussions = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, topic: "t".repeat(100), status: "in_progress", round: 1, maxRounds: 3, messages: 1, maxMessages: 9, participants: Array.from({ length: 15 }, (_, k) => `agent-${"x".repeat(80)}-${k}`), benched: [], updatedAt: NOW }));
    await b.post("/api/ingest/snapshot", b.snap({ discussions }));
    const bytes = new TextEncoder().encode((b.db.rows<{ json: string }>("SELECT json FROM snapshots")[0] as { json: string }).json).length;
    expect(bytes).toBeGreaterThan(3 * 2048); // a 12 KB snapshot ...
    expect(b.wr()).toBe(WRITE_COST.request + WRITE_COST.snapshotInsert); // ... is not charged by its size (fix5 charged a row per 2 KB: a busy host ran out of budget on honest traffic)
    expect(written("snapshots")).toBe(1); // one row physically written
    const first = b.wr();
    await b.post("/api/ingest/snapshot", b.snap({ discussions, sentAt: NOW + 5000 }), NOW + 5000); // unchanged: the row is rewritten, nothing else
    expect(b.wr() - first).toBe(WRITE_COST.request + WRITE_COST.snapshotRow);
    expect(written("snapshots")).toBe(2);
    // a small one costs the same
    const small = await bootHost();
    await small.post("/api/ingest/snapshot", small.snap());
    expect(small.wr()).toBe(WRITE_COST.request + WRITE_COST.snapshotInsert);
  });

  test("at most MAX_PROJECTS_PER_HOST projects per host: the 31st new project is a 429 with the reason, existing ones keep working", async () => {
    const b = await bootHost();
    for (let p = 0; p < MAX_PROJECTS_PER_HOST; p++) expect((await b.post("/api/ingest/snapshot", b.snap({ project: `p${p}` }), NOW + p)).status).toBe(200);
    const res = await b.post("/api/ingest/snapshot", b.snap({ project: "one-too-many" }), NOW + 100);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/project limit: host 'hosta' already has 30 projects/);
    expect(b.db.rows("SELECT project FROM snapshots WHERE project = 'one-too-many'")).toEqual([]);
    expect((await b.post("/api/ingest/snapshot", b.snap({ project: "p3", sentAt: NOW + 200 }), NOW + 200)).status).toBe(200); // an existing one
    // events for a project the host does not have count against the limit as well, known ones do not
    const ev = { kind: "status", origin: ORIGIN_HOST, at: NOW - 1000, severity: "info", key: "e1", agent: "Agent01", status: "IN_PROGRESS", text: "x" };
    expect((await b.post("/api/ingest/events", b.events([ev], "brand-new"), NOW + 300)).status).toBe(429);
    expect((await b.post("/api/ingest/events", b.events([ev], "p3"), NOW + 300)).status).toBe(200);
  });

  test("at most MAX_OPEN_TASKS_PER_HOST running/blocked tasks per host across its projects: the surplus is dropped and counted", async () => {
    const b = await bootHost();
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => task(`${prefix}${i}`));
    await b.post("/api/ingest/snapshot", b.snap({ project: "a", tasks: many("a", 150) }));
    const res = (await (await b.post("/api/ingest/snapshot", b.snap({ project: "b", tasks: [...many("b", 100), task("done1", { state: "done" })] }), NOW + 1000)).json()) as any;
    expect(res.dropped).toBe(100 - (MAX_OPEN_TASKS_PER_HOST - 150));
    expect(res.firstError).toMatch(/at most 200 running\/blocked tasks/);
    expect(b.db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('running', 'blocked')")[0]?.n).toBe(MAX_OPEN_TASKS_PER_HOST);
    expect(b.db.rows("SELECT task_id FROM tasks WHERE task_id = 'done1'")).toHaveLength(1); // closed tasks are not "open"
  });
});

// ── 4. push budgets ──────────────────────────────────────────────────────────

describe("4. push budgets: host-agent criticals are exempt, relay senders have their own", () => {
  const relay = (who: string, i: number, project = "proja", status = "BLOCKED") => ({ kind: "status", origin: ORIGIN_RELAY, at: NOW + i, key: `r${who}${i}${project}`, status, text: "STATUS: BLOCKED need input", sender: `@${who}:other.org`, agent: `claude@${who}` });

  test("probe F2: three relayed BLOCKED pushes, then hosta's own critical cli-gone is pushed at once, not 10 minutes later", async () => {
    const b = await bootHost();
    for (let i = 1; i <= 3; i++) await b.post("/api/ingest/events", b.events([relay(`bot${i}`, i * 1000)]), NOW + i * 1000);
    // three different relay senders: 3 pushes, each from its own budget
    expect(b.push.pushes).toHaveLength(3);
    const before = b.push.pushes.length;
    const halt = { kind: "halt", origin: ORIGIN_HOST, at: NOW + 59_000, key: "h1", scenario: "cli-gone", agent: "claude", text: "claude CLI is gone" };
    await b.post("/api/ingest/events", b.events([halt]), NOW + 60_000);
    expect(b.push.pushes.length).toBe(before + 1); // immediately
    expect(b.db.rows("SELECT push_count FROM alerts WHERE rule = 'agent-stuck'")).toEqual([{ push_count: 1 }]);
    // and it is not charged to the host's ordinary budget
    expect(b.db.rows("SELECT k, count FROM push_budget WHERE k = 'own|hosta'")).toEqual([]);
    expect(b.db.rows("SELECT k, count FROM push_budget WHERE k = 'ct|hosta'")).toEqual([{ k: "ct|hosta", count: 1 }]);
  });

  test("relayed alerts are budgeted PER SENDER (rs|host|sender): one chatty sender cannot spend its host's budget or another sender's", async () => {
    const b = await bootHost();
    // one sender BLOCKED in 5 projects = 5 alerts of the same sender; another sender in one project
    for (let p = 0; p < 5; p++) await b.post("/api/ingest/events", b.events([relay("chatty", p * 10, `p${p}`)], `p${p}`), NOW + p * 1000);
    await b.post("/api/ingest/events", b.events([relay("quiet", 99, "p0")], "p0"), NOW + 9000);
    const rows = b.db.rows<{ k: string; count: number; suppressed: number }>("SELECT k, count, suppressed FROM push_budget ORDER BY k");
    expect(rows.filter((r) => r.k.includes("@"))).toEqual([
      { k: "rs|hosta|@chatty:other.org", count: MAX_PUSHES_PER_SOURCE_PER_WINDOW, suppressed: 0 },
      { k: "rs|hosta|@quiet:other.org", count: 1, suppressed: 0 },
    ]);
    // the alerts held back by the sender's own budget are counted under the host's relay aggregate (ONE summary per host)
    expect(rows.find((r) => r.k === "rt|hosta")).toEqual({ k: "rt|hosta", count: 4, suppressed: 2 });
    // ... and the host's own warn alert still has its whole budget
    const tasks = Array.from({ length: 3 }, (_, i) => task(`B${i}`, { state: "blocked", agent: `a${i}` }));
    const before = b.push.pushes.length;
    await b.post("/api/ingest/snapshot", b.snap({ tasks }), NOW + 20_000);
    await b.cron(NOW + 80_000);
    expect(b.push.pushes.length - before).toBe(3);
  });

  test("host-agent criticals still have a SAFETY cap per host and hour; the surplus is summarised under ct|<host>", async () => {
    const t = makeEnv();
    const push = await setupPush(t);
    const items: PushItem[] = Array.from({ length: MAX_CRITICAL_PUSHES_PER_HOUR + 6 }, (_, i) => ({
      key: `agent-stuck|h|p|a${i}|benched`, rule: "agent-stuck", severity: "critical", opened: NOW, origin: ORIGIN_HOST, host: "h", project: "p", agent: `a${i}`, pushCount: 0, lastPushed: null, reminder: false,
    }));
    for (const it of items) t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, host, project, agent, text, opened) VALUES (?, 'agent-stuck', 'critical', 'h', 'p', ?, 'x', ?)").run(it.key, it.agent, NOW);
    for (let round = 0; round < 40; round++) {
      const open = t.db.rows<{ key: string }>("SELECT key FROM alerts WHERE push_count = 0 AND summarized_at IS NULL").map((r) => r.key);
      await dispatchPushes(t.env, items.filter((i) => open.includes(i.key)), NOW + round * 1000, push.fetch);
    }
    expect(push.pushes).toHaveLength(MAX_CRITICAL_PUSHES_PER_HOUR);
    expect(t.db.rows("SELECT k, count, suppressed FROM push_budget WHERE k = 'ct|h'")).toEqual([{ k: "ct|h", count: MAX_CRITICAL_PUSHES_PER_HOUR, suppressed: 6 }]);
    expect(t.db.rows("SELECT count FROM push_budget WHERE k = 'all|h'")).toEqual([{ count: MAX_CRITICAL_PUSHES_PER_HOUR }]); // and the owner's total counts them
    expect(CRITICAL_PUSH_WINDOW_MS).toBe(HOUR);
  });

  test("non-host-agent pushes have a DAILY cap per source (MAX_PUSHES_PER_SOURCE_PER_DAY): over it everything is summarised", async () => {
    const t = makeEnv();
    const push = await setupPush(t);
    t.db.sqlite.query("INSERT INTO push_budget (k, owner, window_start, count, day_start, day_count, touched) VALUES ('own|client1', 'client1', ?, 0, ?, ?, ?)").run(NOW - 20 * MIN, NOW - 2 * HOUR, MAX_PUSHES_PER_SOURCE_PER_DAY, NOW);
    t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened) VALUES ('blocked|client1|p|m-1', 'blocked', 'warn', 'mcp', 'client1', 'p', 'a', 'x', ?)").run(NOW);
    const item: PushItem = { key: "blocked|client1|p|m-1", rule: "blocked", severity: "warn", opened: NOW, origin: "mcp", host: "client1", project: "p", agent: "a", pushCount: 0, lastPushed: null, reminder: false };
    await dispatchPushes(t.env, [item], NOW, push.fetch);
    expect(push.pushes).toHaveLength(0); // the short window is free, the day is not
    expect(t.db.rows("SELECT push_count, summarized_at FROM alerts")).toEqual([{ push_count: 0, summarized_at: NOW }]);
    expect(t.db.rows("SELECT suppressed FROM push_budget")).toEqual([{ suppressed: 1 }]);
    // the next day it pushes again
    t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened) VALUES ('blocked|client1|p|m-2', 'blocked', 'warn', 'mcp', 'client1', 'p', 'a', 'x', ?)").run(NOW + DAY);
    await dispatchPushes(t.env, [{ ...item, key: "blocked|client1|p|m-2", opened: NOW + DAY }], NOW + DAY - 1000 + 2 * HOUR, push.fetch);
    expect(push.pushes).toHaveLength(1);
  });

  test("renotify: only critical alerts buzz again when they replace a notification; the service worker honours the flag", () => {
    const base = { key: "k", rule: "blocked" as const, host: "client1", project: "p", agent: "a", origin: "mcp" };
    expect(pushMessage({ ...base, severity: "warn" }, "https://x").renotify).toBe(false);
    expect(pushMessage({ ...base, severity: "critical" }, "https://x").renotify).toBe(true);
    const sw = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");
    expect(sw).toContain("data.renotify === true");
    expect(sw).not.toMatch(/renotify\s*=\s*true;/);
  });

  test("relay alerts get a per-sender notification tag (src:rs|host|sender)", () => {
    const m = pushMessage({ key: "blocked|hosta|p|@bot:srv", rule: "blocked", host: "hosta", project: "p", agent: "claude@bot", origin: ORIGIN_RELAY, severity: "warn", sender: "@bot:srv" }, "https://x");
    expect(m.tag).toBe("src:rs|hosta|@bot:srv");
  });
});

// ── summarised alerts keep push_count honest ─────────────────────────────────

describe("push_count counts individual pushes; summarised alerts are marked separately", () => {
  test("20 BLOCKED alerts of one client: 3 real pushes (push_count 1), the rest summarized_at with push_count 0; /api/state tells them apart", async () => {
    const t = makeEnv();
    const push = await setupPush(t);
    const ctx = makeCtx();
    const token = await addSource(t.db, "client1", "client");
    for (let i = 0; i < 20; i++) {
      await route(request("/mcp", { token, body: call("report_task", { project: "p", title: `task ${i}`, status: "BLOCKED" }) }), t.env, ctx, { now: NOW + i * 1000, fetch: push.fetch });
      await ctx.flush();
    }
    expect(push.pushes).toHaveLength(3);
    expect(t.db.rows("SELECT COUNT(*) AS n FROM alerts WHERE push_count > 0")).toEqual([{ n: 3 }]);
    expect(t.db.rows("SELECT COUNT(*) AS n FROM alerts WHERE push_count = 0 AND summarized_at IS NOT NULL")).toEqual([{ n: 17 }]);
    const state = (await (await route(request("/api/state"), t.env, ctx, { now: NOW + 30_000 })).json()) as any;
    expect(state.inbox.filter((a: any) => a.push_count === 1 && a.summarized_at === null)).toHaveLength(3);
    expect(state.inbox.filter((a: any) => a.push_count === 0 && a.summarized_at !== null)).toHaveLength(17);
    // once the window is over the ONE summary goes out
    await runCron(t.env, ctx, NOW + 11 * MIN, { fetch: push.fetch });
    await ctx.flush();
    expect(push.pushes).toHaveLength(4);
  });

  test("a summarised alert is not due again, and a re-open inside the grace keeps its mark", async () => {
    const { pushDue } = await import("../src/rules");
    const a = { rule: "blocked", push_count: 0, last_pushed: null, opened: NOW - MIN, summarized_at: NOW - 30_000 };
    expect(pushDue(a, NOW)).toBe(false);
    expect(pushDue({ ...a, summarized_at: null }, NOW)).toBe(true);
    // an approval's reminders still follow, counted from the summary
    expect(pushDue({ ...a, rule: "approval-waiting" }, NOW)).toBe(false);
    expect(pushDue({ ...a, rule: "approval-waiting" }, NOW + 31 * MIN)).toBe(true);
  });
});

// ── 5. an over-budget host is alive ──────────────────────────────────────────

describe("5. an over-budget host must not look offline", () => {
  test("30 simulated minutes of refused snapshots (and no heartbeat) raise NO host-offline alert; every budget 429 carries the flags", async () => {
    const b = await bootHost();
    b.db.sqlite.query("UPDATE sources SET wr_count = ?, wr_window_start = ? WHERE name = 'hosta'").run(hostWriteBudget(1), NOW - 1000);
    let last: any;
    for (let m = 0; m < 30; m += 3) {
      const res = await b.post("/api/ingest/snapshot", b.snap({ sentAt: NOW + m * MIN }, NOW + m * MIN), NOW + m * MIN);
      expect(res.status).toBe(429);
      last = await res.json();
      await b.cron(NOW + m * MIN + 30_000);
    }
    expect(last).toMatchObject({ budgetExhausted: true, budgetUntil: NOW - 1000 + DAY });
    expect(b.db.rows("SELECT key FROM alerts WHERE rule = 'host-offline'")).toEqual([]);
    expect(b.db.rows<{ last_seen: number }>("SELECT last_seen FROM hosts")[0]?.last_seen).toBeGreaterThan(NOW + 25 * MIN);
    // the exhaustion IS visible: the budget-exhausted alert, and the events route says so too
    expect(b.db.rows("SELECT key FROM alerts WHERE rule = 'budget-exhausted'")).toEqual([{ key: "budget-exhausted|hosta" }]);
    const ev = await b.post("/api/ingest/events", b.events([{ kind: "status", origin: ORIGIN_HOST, at: NOW + 29 * MIN, severity: "info", key: "e", agent: "A", status: "IN_PROGRESS", text: "x" }]), NOW + 29 * MIN);
    expect(await ev.json()).toMatchObject({ budgetExhausted: true, budgetUntil: NOW - 1000 + DAY });
  });
});

// ── INFO ─────────────────────────────────────────────────────────────────────

describe("INFO items", () => {
  test("events with `at` older than 24 h are refused (and counted): relay `at: 0` cannot dodge the per-project relay cap", async () => {
    const b = await bootHost();
    const old = (i: number) => ({ kind: "status", origin: ORIGIN_RELAY, at: 0, key: `z${i}`, status: "BLOCKED", text: "x", sender: `@bot${i}:srv`, agent: `bot${i}` });
    const res = (await (await b.post("/api/ingest/events", b.events(Array.from({ length: 60 }, (_, i) => old(i))))).json()) as any;
    expect(res).toMatchObject({ accepted: 0, dropped: 60 });
    expect(res.firstError).toMatch(/at is older than 24 hours/);
    expect(b.db.rows("SELECT * FROM tasks")).toEqual([]);
    // an event from 23 h ago is fine, and its relay row is NOT instantly stale (it counts against the cap)
    const ok = Array.from({ length: MAX_RELAY_SENDERS_PER_HOST + 5 }, (_, i) => ({ ...old(i), at: NOW - 23 * HOUR }));
    expect(await (await b.post("/api/ingest/events", b.events(ok), NOW + 1000)).json()).toMatchObject({ relayDropped: 5 });
  });

  test("a D1 error in the middle of a JSON-RPC batch gives the unused pre-claimed budget slots back", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const token = await addSource(t.db, "client1", "client");
    const send = (env: typeof t.env, body: unknown, now: number) => route(request("/mcp", { token, body }), env, ctx, { now });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await (await send(t.env, call("report_task", { project: "p", title: `t${i}`, status: "IN_PROGRESS" }), NOW + i)).json()) as any;
      ids.push(JSON.parse(r.result.content[0].text).task_id);
    }
    t.db.sqlite.query("UPDATE sources SET mut_count = 0").run();
    // the lookup of the SECOND update fails
    let lookups = 0;
    const real = t.env.DB as any;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/^SELECT \* FROM tasks WHERE key = \? AND source_id = \? AND origin = 'mcp'/.test(sql.trim()) && ++lookups === 2) throw new Error("D1 went away");
            return target.prepare(sql);
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const batch = ids.map((task_id, i) => call("update_task", { task_id, status: "BLOCKED" }, i + 1));
    const res = await send({ ...t.env, DB: flaky }, batch, NOW + 100);
    expect(res.status).toBe(500);
    // 3 slots were pre-claimed, ONE update went through: the other two are back
    expect(t.db.rows("SELECT mut_count FROM sources")).toEqual([{ mut_count: 1 }]);
  });
});

// ── (a) /api/state is bounded ────────────────────────────────────────────────

describe("(a) /api/state never exceeds ~1 MB, whatever the database holds", () => {
  const seedSnapshots = (db: D1Shim, n: number, discussionPad: number, closed = 0) => {
    db.sqlite.exec("BEGIN");
    const ins = db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', ?, ?, ?, ?)");
    for (let p = 0; p < n; p++) {
      const discussions = Array.from({ length: 10 + closed }, (_, i) => ({ id: `d${i}`, topic: "t", status: i < 10 ? "in_progress" : "completed", round: 1, maxRounds: 3, messages: 1, maxMessages: 9, participants: [`${"x".repeat(discussionPad)}`], benched: [], updatedAt: NOW }));
      const agents = Array.from({ length: 20 }, (_, i) => ({ name: `agent${i}`, state: "idle" }));
      ins.run(`host${p % 7}`, `p${String(p).padStart(3, "0")}`, JSON.stringify({ v: 1, host: `host${p % 7}`, project: `p${p}`, sentAt: NOW, poller: { status: "running" }, agents, discussions, approvals: [] }), NOW);
    }
    db.sqlite.exec("COMMIT");
  };
  const stateOf = async (t: ReturnType<typeof makeEnv>) => ((await (await route(request("/api/state"), t.env, makeCtx(), { now: NOW })).json()) as any);

  test("200 hand-inserted snapshots far over the stored cap are skipped, not parsed: the response stays tiny", async () => {
    const t = makeEnv();
    seedSnapshots(t.db, 200, 100_000); // ~100 KB of discussion text per snapshot (the old probe stored 197 KB each: 39 MB)
    const body = JSON.stringify(await stateOf(t));
    expect(body.length).toBeLessThan(STATE_MAX_BYTES);
    expect(JSON.parse(body).projects).toEqual([]);
  });

  test("200 valid snapshots near the 32 KB cap (6 MB of rows): the response is cut to <= 1 MB and says what was dropped", async () => {
    const t = makeEnv();
    seedSnapshots(t.db, 200, 2500); // 10 discussions x 2.5 KB ~ 25 KB + 20 agents per snapshot, under the cap
    const s = await stateOf(t);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(STATE_MAX_BYTES);
    expect(s.truncated.length).toBeGreaterThan(0);
    expect(s.truncated).toContain("discussions"); // the least important parts go first
    expect(s.projects.length).toBeGreaterThan(0);
  });

  test("only ACTIVE discussions, at most 10 per project, and a normal response is not flagged", async () => {
    const t = makeEnv();
    seedSnapshots(t.db, 2, 50, 5); // 10 active + 5 completed per project
    const s = await stateOf(t);
    expect(s.discussions).toHaveLength(2 * MAX_STORED_DISCUSSIONS);
    expect(s.discussions.every((d: any) => d.status === "in_progress")).toBe(true);
    expect(s.truncated).toEqual([]);
  });

  test("buildState itself (not only the route) applies the bound", async () => {
    const t = makeEnv();
    seedSnapshots(t.db, 200, 2500);
    const s = await buildState(t.env.DB, NOW);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(STATE_MAX_BYTES);
  });
});

// ── (b) claims never read `changes` ──────────────────────────────────────────

describe("(b) budget claims use RETURNING, never meta.changes", () => {
  test("with a trigger on `sources` and a runtime that counts trigger writes in `changes`, every counter still claims correctly", async () => {
    shimOptions.inflateChanges = true;
    try {
      const t = makeEnv();
      t.db.sqlite.exec("CREATE TABLE _trig (n INTEGER); CREATE TRIGGER sources_audit AFTER UPDATE ON sources BEGIN INSERT INTO _trig VALUES (1); END; CREATE TRIGGER pb_audit AFTER INSERT ON push_budget BEGIN INSERT INTO _trig VALUES (2); END;");
      const push = await setupPush(t);
      const ctx = makeCtx();
      const host = await addSource(t.db, "hosta", "host");
      const client = await addSource(t.db, "client1", "client");
      const ev = (i: number, extra: Record<string, unknown> = {}) => ({ kind: "status", origin: ORIGIN_HOST, at: NOW - 1000, severity: "info", key: `e${i}`, agent: "A", status: "IN_PROGRESS", text: "x", ...extra });
      const events = (list: unknown[]) => ({ v: 1, host: "hosta", project: "proja", events: list });
      const post = (token: string, path: string, body: unknown, now = NOW) => route(request(path, { token, body }), t.env, ctx, { now, fetch: push.fetch }).then(async (r) => (await ctx.flush(), r));

      // host writes: claimed, then refused exactly at the cap
      expect((await post(host, "/api/ingest/events", events([ev(1)]))).status).toBe(200);
      t.db.sqlite.query("UPDATE sources SET wr_count = ? WHERE name = 'hosta'").run(hostWriteBudget(1) - WRITE_COST.request - WRITE_COST.event);
      expect((await post(host, "/api/ingest/events", events([ev(2)]))).status).toBe(200);
      expect((await post(host, "/api/ingest/events", events([ev(3)]))).status).toBe(429);
      // critical halts over budget: their own allowance claims (and the budget-exhausted flag was written once)
      const halt = { kind: "halt", origin: ORIGIN_HOST, at: NOW - 500, severity: "critical", key: "h1", agent: "Agent02", scenario: "benched", text: "benched" };
      const res = await post(host, "/api/ingest/events", events([halt]));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: 1, budgetExhausted: true });
      expect(t.db.rows("SELECT hl_count FROM sources WHERE name = 'hosta'")).toEqual([{ hl_count: 1 }]);
      expect(t.db.rows("SELECT budget_until FROM sources WHERE name = 'hosta'")[0]).toEqual({ budget_until: NOW + DAY });
      // MCP mutations: claimed, then refused at the cap
      const report = (title: string) => post(client, "/mcp", call("report_task", { project: "p", title, status: "IN_PROGRESS" }));
      expect(((await (await report("one")).json()) as any).result.isError).toBeUndefined();
      t.db.sqlite.query("UPDATE sources SET mut_count = ? WHERE name = 'client1'").run(MAX_MCP_MUTATIONS_PER_DAY);
      expect(((await (await report("two")).json()) as any).result.isError).toBe(true);
      // push slots: the budget row is created and claimed (alerts of the halt above were pushed once)
      expect(push.pushes.length).toBeGreaterThan(0);
      expect(t.db.rows("SELECT COUNT(*) AS n FROM push_budget")[0]).toEqual({ n: expect.any(Number) });
    } finally {
      shimOptions.inflateChanges = false;
    }
  });

  test("the budget code never reads `meta.changes` (static guard)", () => {
    for (const f of ["budget.ts", "push.ts", "ingest.ts", "mcp.ts"]) {
      expect(readFileSync(join(import.meta.dir, "..", "src", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/meta\??\.changes/);
    }
    expect(readFileSync(join(import.meta.dir, "..", "migrations", "0001_init.sql"), "utf8")).toMatch(/BUDGET LOGIC MUST NOT DEPEND ON `meta\.changes`/);
  });
});
