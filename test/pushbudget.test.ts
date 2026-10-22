// Phone-push economy: per-source push budget + one summary push, and the limits of ONE Worker
// invocation (subscriptions read once, at most 5 notifications, claim -> send with rollback, a deadline).
import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { SQL_CLAIM_PUSH_SLOTS, SQL_PUSH_SUMMARIES_DUE } from "../src/budget";
import {
  MAX_PUSHES_PER_INVOCATION,
  MAX_PUSHES_PER_SOURCE_PER_WINDOW,
  MAX_PUSH_SUBREQUESTS,
  PUSH_WINDOW_MS,
} from "../src/env";
import { route, runCron } from "../src/index";
import { dispatchPushes, flushPushSummaries } from "../src/push";
import type { PushItem } from "../src/rules";
import { addSource, makeCtx, makeEnv, request, setupPush, type TestEnv } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown, id = 1) => rpc("tools/call", { name, arguments: args }, id);

/** An env with a VAPID key and `devices` push subscriptions (all pointing at the stub fetch). */
async function boot(devices = 1) {
  const t = makeEnv();
  const push = await setupPush(t);
  for (let i = 1; i < devices; i++) {
    t.db.sqlite
      .query("INSERT INTO push_subs (endpoint, p256dh, auth, created) SELECT endpoint || ?, p256dh, auth, created FROM push_subs ORDER BY endpoint LIMIT 1")
      .run(`-${i}`);
  }
  const ctx = makeCtx();
  const clientToken = await addSource(t.db, "client1", "client");
  const post = async (path: string, token: string, body: unknown, now: number) => {
    const res = await route(request(path, { token, body }), t.env, ctx, { now, fetch: push.fetch });
    await ctx.flush();
    return res;
  };
  const report = (i: number | string, now: number, token = clientToken, status = "BLOCKED") =>
    post("/mcp", token, call("report_task", { project: "p", title: `task ${i}`, status }), now);
  const cron = async (now: number) => {
    await runCron(t.env, ctx, now, { fetch: push.fetch });
    await ctx.flush();
  };
  /** The push budget row of a budget key (zeros when the key never pushed). */
  const src = (key: string) =>
    t.db.rows<{ push_count: number; push_suppressed: number; push_window_start: number }>("SELECT count AS push_count, suppressed AS push_suppressed, window_start AS push_window_start FROM push_budget WHERE k = ?", key)[0] ?? {
      push_count: 0,
      push_suppressed: 0,
      push_window_start: 0,
    };
  return { ...t, ctx, push, pushes: push.pushes, clientToken, post, report, cron, src };
}

describe("per-source push budget", () => {
  test("a client gets 3 pushes per 10 minutes; the rest stay in the inbox and are summarised in ONE later push", async () => {
    const b = await boot();
    for (let i = 0; i < 5; i++) await b.report(i, NOW + i * 1000);
    expect(b.pushes).toHaveLength(MAX_PUSHES_PER_SOURCE_PER_WINDOW);
    expect(b.db.rows("SELECT key FROM alerts WHERE resolved IS NULL")).toHaveLength(5); // every one is still an open alert (inbox)
    expect(b.src("own|client1")).toEqual({ push_count: 3, push_suppressed: 2, push_window_start: NOW });

    await b.cron(NOW + 5 * MIN); // window still open: the summary waits
    expect(b.pushes).toHaveLength(3);
    expect(b.src("own|client1")?.push_suppressed).toBe(2);

    await b.cron(NOW + PUSH_WINDOW_MS + 1000); // window over: ONE summary
    expect(b.pushes).toHaveLength(4);
    expect(b.src("own|client1")).toEqual({ push_count: 1, push_suppressed: 0, push_window_start: NOW + PUSH_WINDOW_MS + 1000 });
    for (let i = 2; i < 8; i++) await b.cron(NOW + PUSH_WINDOW_MS + i * MIN);
    expect(b.pushes).toHaveLength(4); // never again
  });

  test("a spent budget does not re-push when the window is open: later alerts of the source are only counted", async () => {
    const b = await boot();
    for (let i = 0; i < 3; i++) await b.report(i, NOW + i * 1000);
    expect(b.pushes).toHaveLength(3);
    for (let i = 3; i < 13; i++) await b.report(i, NOW + i * 1000);
    expect(b.pushes).toHaveLength(3);
    expect(b.src("own|client1")?.push_suppressed).toBe(10);
  });

  test("budgets are per source: another client and the host-agent host have their own", async () => {
    const b = await boot();
    const other = await addSource(b.db, "gemini-mac", "client");
    const hostToken = await addSource(b.db, "hosta", "host");
    for (let i = 0; i < 4; i++) await b.report(i, NOW + i * 1000);
    expect(b.pushes).toHaveLength(3);
    for (let i = 0; i < 4; i++) await b.report(`g${i}`, NOW + 10_000 + i * 1000, other);
    expect(b.pushes).toHaveLength(6);
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `T-${i}`, agent: `agent0${i}`, title: "x", state: "blocked", dispatchedAt: NOW - 60_000, updatedAt: NOW - 1000 }));
    await b.post("/api/ingest/snapshot", hostToken, { v: 1, host: "hosta", project: "proja", sentAt: NOW, poller: { status: "running", lastPoll: NOW, startedAt: NOW - 1000 }, agents: [], tasks, discussions: [], approvals: [] }, NOW + 20_000);
    expect(b.pushes).toHaveLength(8); // fairness: a source gets at most 2 slots per invocation, so 2 of the host's 5 alerts now
    await b.cron(NOW + 80_000); // the 3rd takes the last slot of its budget, the 4th is held back
    await b.cron(NOW + 140_000); // its budget is spent: the 5th is settled into the summary count in bulk
    expect(b.pushes).toHaveLength(9); // a host label is a source too: 3 of its 5 alerts
    expect(b.src("own|hosta")).toMatchObject({ push_count: 3, push_suppressed: 2 });
    expect(b.src("own|gemini-mac")).toMatchObject({ push_count: 3, push_suppressed: 1 });
  });

  test("without subscriptions or VAPID nothing is claimed and nothing is held back: the alert is still due when a device appears", async () => {
    const b = await boot();
    b.db.sqlite.query("DELETE FROM push_subs").run();
    for (let i = 0; i < 5; i++) await b.report(i, NOW + i * 1000);
    expect(b.pushes).toHaveLength(0);
    expect(b.src("own|client1")).toEqual({ push_count: 0, push_suppressed: 0, push_window_start: 0 });
    expect(b.db.rows("SELECT push_count FROM alerts WHERE push_count > 0 OR summarized_at IS NOT NULL")).toHaveLength(0);

    // a held-back count survives a summary attempt that has nobody to tell
    b.db.sqlite.query("INSERT INTO push_budget (k, owner, suppressed, window_start, touched) VALUES ('own|client1', 'client1', 2, ?, ?)").run(NOW - 20 * MIN, NOW);
    await b.cron(NOW);
    expect(b.src("own|client1")?.push_suppressed).toBe(2);
  });

  test("a failed summary delivery puts the count back and gives the slot back; the next cron retries", async () => {
    const b = await boot();
    for (let i = 0; i < 5; i++) await b.report(i, NOW + i * 1000);
    const later = NOW + PUSH_WINDOW_MS + 1000;
    await flushPushSummaries(b.env, later, async () => new Response(null, { status: 503 }));
    expect(b.src("own|client1")).toMatchObject({ push_suppressed: 2, push_count: 0, push_window_start: NOW }); // count restored, slot refunded, the OLD (ended) window back: the next cron minute retries
    await flushPushSummaries(b.env, later + MIN, b.push.fetch);
    expect(b.pushes).toHaveLength(4);
    expect(b.src("own|client1")?.push_suppressed).toBe(0);
  });

  test("two cron evaluators cannot both send the same summary", async () => {
    const b = await boot();
    for (let i = 0; i < 5; i++) await b.report(i, NOW + i * 1000);
    const later = NOW + PUSH_WINDOW_MS + 1000;
    await Promise.all([flushPushSummaries(b.env, later, b.push.fetch), flushPushSummaries(b.env, later, b.push.fetch)]);
    expect(b.pushes).toHaveLength(4);
  });

  test("the summary lookup is an index-backed search: nothing is read when no source is owed one", async () => {
    const b = await boot();
    b.db.statements.length = 0;
    await flushPushSummaries(b.env, NOW, b.push.fetch);
    expect(b.db.statements.map(norm)).toEqual([norm(SQL_PUSH_SUMMARIES_DUE)]);
    const plan = b.db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${SQL_PUSH_SUMMARIES_DUE}`).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_push_budget_suppressed");
  });
});

// ── limits of one invocation ─────────────────────────────────────────────────

/** Number of D1 statements and push requests one call issued. */
async function measure(b: Awaited<ReturnType<typeof boot>>, fn: () => Promise<unknown>) {
  b.db.statements.length = 0;
  const before = b.pushes.length;
  await fn();
  return { statements: b.db.statements.length, fetches: b.pushes.length - before };
}

describe("one invocation stays inside the Free-plan limits (50 D1 statements, 50 subrequests)", () => {
  test("a batch of 10 MCP reports + their pushes (2 devices)", async () => {
    const b = await boot(2);
    const batch = (status: string, ids: string[]) => ids.map((id, i) => call("report_task", { project: "p", title: id, status }, i + 1));
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const m = await measure(b, () => b.post("/mcp", b.clientToken, batch("BLOCKED", ids), NOW));
    expect(m.statements).toBeLessThan(50);
    expect(m.fetches).toBeLessThan(50);
    expect(m.statements + m.fetches).toBeLessThan(50 + 10); // statements are the scarcer resource; fetches here are bounded by the source budget (3 x 2 devices)
    expect(m.fetches).toBeLessThanOrEqual(MAX_PUSHES_PER_SOURCE_PER_WINDOW * 2);
    // updates in a batch: every task moves on, alerts resolve (no push), then block again (same incidents, no new push)
    const taskIds = b.db.rows<{ task_id: string }>("SELECT task_id FROM tasks ORDER BY task_id").map((r) => r.task_id);
    const upd = (status: string) => taskIds.map((task_id, i) => call("update_task", { task_id, status }, i + 1));
    const u1 = await measure(b, () => b.post("/mcp", b.clientToken, upd("IN_PROGRESS"), NOW + 1000));
    expect(u1.statements).toBeLessThan(50);
    const u2 = await measure(b, () => b.post("/mcp", b.clientToken, upd("BLOCKED"), NOW + 2000));
    // <= 50, not < 50: this batch of 10 updates sits exactly AT the Free plan's limit of 50 D1 queries per invocation, because every
    // rule evaluation now also runs the per-project liveness scan (migration 0002, one more query, kept apart from the batch so a
    // Worker that is live before the migration still evaluates everything else). That is fine on Workers Paid (1,000 per
    // invocation), the plan chosen for the deployment; on Free the margin is gone, which is why this is called out here.
    expect(u2.statements).toBeLessThanOrEqual(50);
    expect(b.pushes.length).toBeLessThanOrEqual(MAX_PUSHES_PER_SOURCE_PER_WINDOW * 2); // never past the source budget (3 pushes x 2 devices); incidents that were never pushed stay due
  });

  test("a batch of 10 reports from a source WITHOUT a push budget row cannot exceed the per-invocation cap either", async () => {
    const b = await boot(2);
    b.db.sqlite.query("UPDATE sources SET name = 'client1' WHERE name = 'client1'").run();
    // 30 alerts opened by a no-source origin (host labels that are not tokens): host-offline for 30 hosts
    for (let i = 0; i < 30; i++) b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES (?, ?)").run(`h${i}`, NOW - 7 * MIN);
    const first = await measure(b, () => b.cron(NOW));
    expect(first.statements).toBeLessThan(50);
    expect(first.fetches).toBe(MAX_PUSHES_PER_INVOCATION * 2);
    expect(b.db.rows("SELECT key FROM alerts WHERE push_count > 0")).toHaveLength(MAX_PUSHES_PER_INVOCATION);
    // the rest drain over the following cron minutes, 5 at a time, each one inside the limits
    for (let i = 1; i <= 5; i++) {
      const m = await measure(b, () => b.cron(NOW + i * MIN));
      expect(m.statements).toBeLessThan(50);
      expect(m.fetches).toBeLessThanOrEqual(MAX_PUSHES_PER_INVOCATION * 2);
    }
    expect(b.db.rows("SELECT key FROM alerts WHERE push_count = 1")).toHaveLength(30);
    expect(b.pushes).toHaveLength(60);
    const idle = await measure(b, () => b.cron(NOW + 6 * MIN));
    expect(idle.fetches).toBe(0);
  });

  test("many devices shrink the notifications per invocation so that notifications x devices <= the subrequest budget", async () => {
    const b = await boot(10);
    for (let i = 0; i < 8; i++) b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES (?, ?)").run(`h${i}`, NOW - 7 * MIN);
    const m = await measure(b, () => b.cron(NOW));
    expect(m.fetches).toBe(Math.floor(MAX_PUSH_SUBREQUESTS / 10) * 10); // 4 notifications x 10 devices
    expect(m.fetches).toBeLessThanOrEqual(MAX_PUSH_SUBREQUESTS);
    expect(b.db.rows("SELECT key FROM alerts WHERE push_count > 0")).toHaveLength(4);
  });

  test("the subscriptions are read ONCE per dispatch, however many alerts it handles", async () => {
    const b = await boot(2);
    for (let i = 0; i < 5; i++) {
      b.db.sqlite
        .query("INSERT INTO alerts (key, rule, severity, host, project, agent, text, opened, push_count) VALUES (?, 'blocked', 'warn', ?, 'p', 'a', 'x', ?, 0)")
        .run(`blocked|h${i}|p|T`, `h${i}`, NOW);
    }
    const items: PushItem[] = Array.from({ length: 5 }, (_, i) => ({ key: `blocked|h${i}|p|T`, rule: "blocked", origin: ORIGIN_HOST, host: `h${i}`, project: "p", agent: "a", pushCount: 0, lastPushed: null, reminder: false }));
    b.db.statements.length = 0;
    await dispatchPushes(b.env, items, NOW, b.push.fetch);
    expect(b.db.statements.filter((s) => /FROM push_subs/.test(s))).toHaveLength(1);
    expect(b.pushes).toHaveLength(10);
  });
});

// ── claim -> send is rolled back whatever fails ──────────────────────────────

describe("claim -> send never loses an alert", () => {
  const item = (over: Partial<PushItem> = {}): PushItem => ({
    key: "blocked|client1|p|T-1", rule: "blocked", origin: "mcp", host: "client1", project: "p", agent: "agent01", pushCount: 0, lastPushed: null, reminder: false, ...over,
  });
  const withAlert = async () => {
    const b = await boot();
    b.db.sqlite
      .query("INSERT INTO alerts (key, rule, severity, host, project, agent, text, opened, push_count) VALUES ('blocked|client1|p|T-1', 'blocked', 'warn', 'client1', 'p', 'agent01', 'x', ?, 0)")
      .run(NOW);
    return b;
  };

  test("an exception while taking the source's push slot gives the alert claim back", async () => {
    const b = await withAlert();
    const real = b.env.DB as unknown as { prepare(sql: string): unknown };
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const s = target.prepare(sql) as { bind(...a: unknown[]): unknown };
            if (norm(sql) !== norm(SQL_CLAIM_PUSH_SLOTS)) return s;
            const down = async () => { throw new Error("D1 went away"); };
            return { bind: () => ({ run: down, all: down, first: down }) };
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await dispatchPushes({ ...b.env, DB: flaky as unknown as D1Database }, [item()], NOW, b.push.fetch);
    expect(b.pushes).toHaveLength(0);
    expect(b.db.rows("SELECT push_count, last_pushed FROM alerts")[0]).toEqual({ push_count: 0, last_pushed: null }); // claim rolled back
    await dispatchPushes(b.env, [item()], NOW + MIN, b.push.fetch); // the next cron sends it
    expect(b.pushes).toHaveLength(1);
    expect(b.db.rows("SELECT push_count FROM alerts")[0]).toEqual({ push_count: 1 });
  });

  test("a push that never answers is cut off at the deadline: the invocation ends, claim and source slot are rolled back", async () => {
    const b = await withAlert();
    const t0 = Date.now();
    await dispatchPushes(b.env, [item()], NOW, () => new Promise<Response>(() => undefined), { deadlineMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(b.db.rows("SELECT push_count, last_pushed FROM alerts")[0]).toEqual({ push_count: 0, last_pushed: null });
    expect(b.src("own|client1")?.push_count).toBe(0); // the source slot was refunded too
  });

  test("a failure of every device rolls back both the alert and the source slot; a success keeps them", async () => {
    const b = await withAlert();
    await dispatchPushes(b.env, [item()], NOW, async () => new Response(null, { status: 503 }));
    expect(b.db.rows("SELECT push_count FROM alerts")[0]).toEqual({ push_count: 0 });
    expect(b.src("own|client1")?.push_count).toBe(0);
    await dispatchPushes(b.env, [item()], NOW + MIN, b.push.fetch);
    expect(b.db.rows("SELECT push_count FROM alerts")[0]).toEqual({ push_count: 1 });
    expect(b.src("own|client1")?.push_count).toBe(1);
  });
});

// ── agent-stuck dedupe ───────────────────────────────────────────────────────

describe("agent-stuck alerts: one incident per host|project|agent|scenario", () => {
  test("a flapping agent (restart-failed / cli-gone repeating every few minutes) pushes ONCE, however often it halts", async () => {
    const b = await boot();
    const hostToken = await addSource(b.db, "hosta", "host");
    const halt = (i: number, scenario: string, now: number) =>
      b.post("/api/ingest/events", hostToken, { v: 1, host: "hosta", project: "proja", events: [{ kind: "halt", origin: ORIGIN_HOST, at: now - 1000, severity: "critical", key: `halt:Agent02:${i}`, agent: "Agent02", scenario, text: `halted ${i}` }] }, now);
    for (let i = 0; i < 8; i++) await halt(i, i % 2 ? "restart-failed" : "cli-gone", NOW + i * 4 * MIN);
    const keys = b.db.rows<{ key: string; push_count: number }>("SELECT key, push_count FROM alerts ORDER BY key");
    expect(keys).toEqual([
      { key: "agent-stuck|hosta|proja|agent02|cli-gone", push_count: 1 },
      { key: "agent-stuck|hosta|proja|agent02|restart-failed", push_count: 0 }, // the same agent within 30 min: summarised, not pushed again
    ]);
    expect(b.db.rows("SELECT summarized_at FROM alerts WHERE key LIKE '%restart-failed'")[0]).not.toEqual({ summarized_at: null });
    expect(b.pushes).toHaveLength(1); // one per AGENT and 30 minutes, not one per scenario, not one per halt

    // resolved and flapping back inside the 30 min grace keeps the incident (and its push counter)
    b.db.sqlite.query("UPDATE alerts SET resolved = ?").run(NOW + 40 * MIN);
    await b.post("/api/ingest/heartbeat", hostToken, { v: 1, host: "hosta", at: NOW + 44 * MIN }, NOW + 44 * MIN); // the host is alive, so no host-offline alert muddies the count
    await b.cron(NOW + 45 * MIN);
    expect(b.db.rows("SELECT key, push_count, resolved FROM alerts ORDER BY key")).toEqual([
      { key: "agent-stuck|hosta|proja|agent02|cli-gone", push_count: 1, resolved: NOW + 40 * MIN }, // superseded by the newer restart-failed halt: stays resolved
      { key: "agent-stuck|hosta|proja|agent02|restart-failed", push_count: 0, resolved: null }, // re-opened as the SAME incident (30 min grace): no second push
    ]);
    expect(b.pushes).toHaveLength(1);
  });
});
