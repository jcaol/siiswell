// What ONE leaked token can make the dashboard write: MCP heartbeat, JSON-RPC batches against the
// rate limiter, the host ingest write budget and the relay-task cap.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { MAX_EVENTS_PER_BATCH, type DashboardEvent } from "../src/shared/schema";
import { SQL_CLAIM_HOST_WRITES } from "../src/budget";
import { MAX_CRITICAL_HALTS_PER_DAY, MAX_OPEN_ALERTS_PER_HOST, MAX_OPEN_CRITICAL_ALERTS_PER_HOST, MAX_OPEN_ALERTS_PER_PROJECT, MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT, MAX_RELAY_SENDERS_PER_HOST, MAX_RELAY_TASKS_PER_PROJECT, RELAY_STALE_AFTER_MS, WRITE_COST, hostWriteBudget } from "../src/env";
import { route, runCron } from "../src/index";
import { MAX_BATCH_MESSAGES } from "../src/mcp";
import { addSource, makeCtx, makeEnv, request, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown, id = 1) => rpc("tools/call", { name, arguments: args }, id);

/** Count every UPDATE of the `sources` table (what D1 would bill as a row written). */
function countSourceUpdates(db: D1Shim): () => number {
  db.sqlite.exec("CREATE TABLE _sw (op TEXT); CREATE TRIGGER sw_u AFTER UPDATE ON sources BEGIN INSERT INTO _sw VALUES ('U'); END;");
  return () => db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM _sw")[0]?.n ?? 0;
}

describe("MCP heartbeat writes nothing beyond the auth touch", () => {
  test("a batch of 10 heartbeats is at most ONE sources write (the throttled last_seen touch); no other table changes", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const token = await addSource(t.db, "client1", "client");
    const updates = countSourceUpdates(t.db);
    const post = (body: unknown, now: number) => route(request("/mcp", { token, body }), t.env, ctx, { now });
    const hb = (n: number) => Array.from({ length: n }, (_, i) => call("heartbeat", {}, i + 1));
    const dump = () => JSON.stringify(["tasks", "events", "alerts", "hosts", "snapshots"].map((x) => t.db.rows(`SELECT * FROM ${x}`)));
    const before = dump();

    const res = await post(hb(MAX_BATCH_MESSAGES), NOW);
    expect(res.status).toBe(200);
    const out = (await res.json()) as any[];
    expect(out).toHaveLength(MAX_BATCH_MESSAGES);
    expect(out.every((r) => r.result.content[0].text === "ok")).toBe(true);
    expect(updates()).toBe(1);
    expect(t.db.rows<any>("SELECT last_seen, mut_count, wr_count FROM sources")[0]).toEqual({ last_seen: NOW, mut_count: 0, wr_count: 0 });

    await post(hb(MAX_BATCH_MESSAGES), NOW + 10_000); // inside the 30 s touch throttle: nothing at all
    expect(updates()).toBe(1);
    expect(dump()).toBe(before);

    await post(hb(1), NOW + 31_000); // the throttle expired: exactly one more touch
    expect(updates()).toBe(2);
  });
});

describe("a JSON-RPC batch is charged to the rate limiter per message", () => {
  const limiter = (budget: number) => {
    const calls: string[] = [];
    return {
      calls,
      binding: {
        limit: async (o: { key: string }) => {
          calls.push(o.key);
          return { success: budget-- > 0 };
        },
      },
    };
  };

  test("N messages cost N units (one at authentication, N-1 before the batch runs)", async () => {
    const l = limiter(1000);
    const t = makeEnv({ RATE_LIMIT_CLIENT: l.binding });
    const token = await addSource(t.db, "client1", "client");
    const post = (body: unknown) => route(request("/mcp", { token, body }), t.env, makeCtx(), { now: NOW });
    expect((await post(rpc("ping"))).status).toBe(200);
    expect(l.calls).toHaveLength(1);
    l.calls.length = 0;
    expect((await post(Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) => rpc("ping", undefined, i + 1)))).status).toBe(200);
    expect(l.calls).toHaveLength(MAX_BATCH_MESSAGES);
    expect(new Set(l.calls)).toEqual(new Set(["src-client1"]));
    l.calls.length = 0;
    const note = { jsonrpc: "2.0", method: "notifications/initialized" };
    expect((await post([note, note, note])).status).toBe(202);
    expect(l.calls).toHaveLength(3); // notifications are requests too
  });

  test("a budget that cannot cover the batch is a 429 BEFORE anything runs: no task, no event, no mutation counted", async () => {
    const l = limiter(5); // 1 for authentication, 4 of the 9 extra units
    const t = makeEnv({ RATE_LIMIT_CLIENT: l.binding });
    const token = await addSource(t.db, "client1", "client");
    const batch = Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) => call("report_task", { project: "p", title: `t${i}`, status: "BLOCKED" }, i + 1));
    const res = await route(request("/mcp", { token, body: batch }), t.env, makeCtx(), { now: NOW });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    for (const table of ["tasks", "events", "alerts"]) expect(t.db.rows(`SELECT * FROM ${table}`)).toHaveLength(0);
    expect(t.db.rows<any>("SELECT mut_count FROM sources")[0]).toEqual({ mut_count: 0 });
  });
});

// ── host ingest write budget ─────────────────────────────────────────────────

const ev = (i: number | string, over: Partial<DashboardEvent> = {}): DashboardEvent => ({
  kind: "status", origin: ORIGIN_HOST, at: NOW - 1000, severity: "info", key: `k${i}`, agent: "Agent01", status: "IN_PROGRESS", text: "working", ...over,
});
const relayEv = (i: number | string, over: Partial<DashboardEvent> = {}): DashboardEvent =>
  ev(`r${i}`, { origin: ORIGIN_RELAY, agent: `Bot${i}`, sender: `@bot${i}:srv`, ...over });
const batch = (events: unknown[], over: Record<string, unknown> = {}) => ({ v: 1, host: "hosta", project: "proja", events, ...over });
/** The budget of a host with (at most) one project, which is what every test of this file uses (it grows with the projects, see test/fix7.test.ts). */
const MAX_HOST_WRITES_PER_DAY = hostWriteBudget(1);
const R = WRITE_COST.request;
const ONE_EVENT = R + WRITE_COST.event;
const task = (id: string, over: Record<string, unknown> = {}) => ({ id, agent: "agent01", title: `task ${id}`, state: "running", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000, ...over });

async function bootHost() {
  const t = makeEnv();
  const ctx = makeCtx();
  const token = await addSource(t.db, "hosta", "host");
  const post = (path: string, body: unknown, now = NOW) =>
    route(request(path, { token, body }), t.env, ctx, { now }).then(async (r) => {
      await ctx.flush();
      return r;
    });
  const wr = () => t.db.rows<{ w: number; n: number }>("SELECT wr_window_start AS w, wr_count AS n FROM sources WHERE name = 'hosta'")[0] as { w: number; n: number };
  const setWr = (n: number, w = NOW) => t.db.sqlite.query("UPDATE sources SET wr_count = ?, wr_window_start = ? WHERE name = 'hosta'").run(n, w);
  const count = (table: string, where = "1") => t.db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0]?.n ?? 0;
  return { ...t, ctx, token, post, wr, setWr, count };
}

describe("host write budget: estimated rows written per 24 h window, one conditional UPDATE", () => {
  test("the weights follow the schema: an insert or delete costs the table row plus EVERY index entry", () => {
    const { db } = makeEnv();
    const entries = (table: string) => 1 + db.rows(`SELECT * FROM pragma_index_list('${table}')`).length;
    // a halt event also writes the partial per-host halt index (idx_events_halt), every other event does not
    expect(WRITE_COST.haltEvent).toBe(entries("events"));
    expect(WRITE_COST.event).toBe(entries("events") - 1);
    // the partial client_ref index (migration 0010) is only written for MCP reports that carry a client_ref, never by a host
    expect(WRITE_COST.taskInsert).toBe(entries("tasks") - 1);
    expect(WRITE_COST.relayInsert).toBe(entries("tasks") - 1);
    expect(WRITE_COST.taskDelete).toBe(entries("tasks") - 1);
    // an update that changes state + updated rewrites the table row and the (updated), (state, updated) and (source, origin, state) entries
    expect(WRITE_COST.taskUpdate).toBeGreaterThanOrEqual(4);
    expect(WRITE_COST.relayUpdate).toBeGreaterThanOrEqual(4);
  });

  test("exact accounting: events, snapshot rows, new / changed / removed tasks; heartbeats cost nothing", async () => {
    const b = await bootHost();
    expect(b.wr()).toEqual({ w: 0, n: 0 });
    await b.post("/api/ingest/events", batch([ev(1)]));
    expect(b.wr()).toEqual({ w: NOW, n: ONE_EVENT });
    await b.post("/api/ingest/events", batch(Array.from({ length: 100 }, (_, i) => ev(`b${i}`))), NOW + 1000);
    expect(b.wr()).toEqual({ w: NOW, n: ONE_EVENT + R + WRITE_COST.event * 100 }); // same window keeps counting
    let spent = ONE_EVENT + R + WRITE_COST.event * 100;

    await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: NOW }, NOW + 2000);
    expect(b.wr().n).toBe(spent);

    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1"), task("t2"), task("t3")] } as never, NOW), NOW + 3000);
    spent += R + WRITE_COST.snapshotInsert + 3 * WRITE_COST.taskInsert; // the first snapshot of the project: its row and its key
    expect(b.wr().n).toBe(spent);

    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1"), task("t2"), task("t3")], sentAt: NOW + 4000 } as never, NOW), NOW + 4000); // unchanged
    spent += R + WRITE_COST.snapshotRow;
    expect(b.wr().n).toBe(spent);

    await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1", { state: "blocked" }), task("t2")], sentAt: NOW + 5000 } as never, NOW), NOW + 5000); // t1 changed, t3 removed
    spent += R + WRITE_COST.snapshotRow + WRITE_COST.taskUpdate + WRITE_COST.taskDelete + WRITE_COST.alertOpen; // t1 is now blocked: the alert it opens is charged after the rules ran
    expect(b.wr().n).toBe(spent);
  });

  test("relay task rows are part of the cost of an events batch", async () => {
    const b = await bootHost();
    await b.post("/api/ingest/events", batch([relayEv(1), relayEv(2)]));
    expect(b.wr().n).toBe(R + 2 * WRITE_COST.event + 2 * WRITE_COST.relayInsert);
    await b.post("/api/ingest/events", batch([relayEv(1, { key: "again", status: "BLOCKED", at: NOW - 500 })]), NOW + 1000);
    expect(b.wr().n).toBe(2 * R + 3 * WRITE_COST.event + 2 * WRITE_COST.relayInsert + WRITE_COST.relayUpdate + WRITE_COST.alertOpen) // the BLOCKED update also opens an alert;
  });

  test("over budget: 429 with a clear error and Retry-After, NOTHING written, the counter untouched", async () => {
    const b = await bootHost();
    b.setWr(MAX_HOST_WRITES_PER_DAY - ONE_EVENT + 1, NOW - 1000); // one row short of an event
    const res = await b.post("/api/ingest/events", batch([ev(1)]));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String((DAY - 1000) / 1000));
    const body = (await res.json()) as { error: string; budgetExhausted: boolean; budgetUntil: number };
    const msg = body.error;
    expect(body).toMatchObject({ budgetExhausted: true, budgetUntil: NOW - 1000 + DAY }); // every budget 429 says so, for the sender to stop retrying
    expect(msg).toContain("write budget exhausted");
    expect(msg).toContain(String(MAX_HOST_WRITES_PER_DAY));
    expect(b.count("events")).toBe(0);
    expect(b.count("hosts")).toBe(1); // ... except that the refused request still shows the host as alive (throttled liveness touch)
    expect(b.db.rows("SELECT last_seen FROM hosts")).toEqual([{ last_seen: NOW }]);
    expect(b.wr().n).toBe(MAX_HOST_WRITES_PER_DAY - ONE_EVENT + 1 + WRITE_COST.alertOpen); // + its own budget-exhausted alert
  });

  test("a spent budget refuses snapshots too, but the heartbeat keeps the host alive", async () => {
    const b = await bootHost();
    b.setWr(MAX_HOST_WRITES_PER_DAY);
    const snap = await b.post("/api/ingest/snapshot", snapshot({ tasks: [task("t1")] } as never, NOW));
    expect(snap.status).toBe(429);
    expect(b.count("snapshots")).toBe(0);
    expect(b.count("tasks")).toBe(0);
    // the refusal itself refreshed last_seen (an over-budget host must not look offline); the heartbeat's version
    // is only taken when the host-row throttle allows a write
    const hb = await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: NOW + 3 * 60_000, binaryVersion: "1.0.2" }, NOW + 3 * 60_000);
    expect(hb.status).toBe(200);
    expect(b.db.rows("SELECT last_seen, binary_version FROM hosts")).toEqual([{ last_seen: NOW + 3 * 60_000, binary_version: "1.0.2" }]);
    expect(b.wr().n).toBe(MAX_HOST_WRITES_PER_DAY + WRITE_COST.alertOpen); // + its own budget-exhausted alert
  });

  test("the cap is inclusive: the claim that lands exactly on it works, the next one is refused", async () => {
    const b = await bootHost();
    b.setWr(MAX_HOST_WRITES_PER_DAY - ONE_EVENT);
    expect((await b.post("/api/ingest/events", batch([ev(1)]))).status).toBe(200);
    expect(b.wr().n).toBe(MAX_HOST_WRITES_PER_DAY);
    expect((await b.post("/api/ingest/events", batch([ev(2)]))).status).toBe(429);
  });

  test("fixed 24 h window: refused inside it, a fresh budget the moment it ends", async () => {
    const b = await bootHost();
    b.setWr(MAX_HOST_WRITES_PER_DAY, NOW - DAY + 1000);
    expect((await b.post("/api/ingest/events", batch([ev(1)]))).status).toBe(429);
    b.setWr(MAX_HOST_WRITES_PER_DAY, NOW - DAY);
    expect((await b.post("/api/ingest/events", batch([ev(2)]))).status).toBe(200);
    expect(b.wr()).toEqual({ w: NOW, n: ONE_EVENT });
  });

  test("concurrent requests cannot overshoot: with room for one batch, exactly one of five wins", async () => {
    const b = await bootHost();
    b.setWr(MAX_HOST_WRITES_PER_DAY - ONE_EVENT);
    const statuses = (await Promise.all([1, 2, 3, 4, 5].map((i) => b.post("/api/ingest/events", batch([ev(`c${i}`)]))))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429, 429, 429, 429]);
    expect(b.count("events")).toBe(1);
    // the claims never overshoot; what is added afterwards is the host's own budget-exhausted alert (6 rows)
    expect(b.wr().n).toBe(MAX_HOST_WRITES_PER_DAY + WRITE_COST.alertOpen);
  });

  test("an events request issues exactly ONE claim statement", async () => {
    const b = await bootHost();
    b.db.statements.length = 0;
    await b.post("/api/ingest/events", batch([ev(1)]));
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(b.db.statements.filter((s) => norm(s) === norm(SQL_CLAIM_HOST_WRITES))).toHaveLength(1);
  });

  test("leaked-token simulation: hammering max-size batches stops at the budget; a retry loop then writes nothing", async () => {
    const b = await bootHost();
    let ok = 0;
    let refused = 0;
    for (let i = 0; i < 200 && refused === 0; i++) {
      const res = await b.post("/api/ingest/events", batch(Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, j) => ev(`l${i}-${j}`))), NOW + i);
      if (res.status === 200) ok++;
      else {
        expect(res.status).toBe(429);
        refused++;
      }
    }
    expect(refused).toBe(1);
    expect(ok).toBe(Math.floor(MAX_HOST_WRITES_PER_DAY / (R + MAX_EVENTS_PER_BATCH * WRITE_COST.event))); // batches of 100, 401 rows each
    expect(b.count("events")).toBe(ok * MAX_EVENTS_PER_BATCH);
    expect(b.count("events") * WRITE_COST.event).toBeLessThanOrEqual(MAX_HOST_WRITES_PER_DAY);
    for (let i = 0; i < 5; i++) expect((await b.post("/api/ingest/events", batch(Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, j) => ev(`after${i}-${j}`))), NOW + 500 + i)).status).toBe(429); // 200 rows are left: a full batch no longer fits
    expect(b.count("events")).toBe(ok * MAX_EVENTS_PER_BATCH);
    expect((await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: NOW + 900 }, NOW + 900)).status).toBe(200);
  });

  test("alert churn cannot hide behind cheap events: the newest MAX_OPEN_CRITICAL_ALERTS_PER_HOST criticals stay open, every opened alert is charged to its owner, and the write budget bounds the churn", async () => {
    const b = await bootHost();
    // 100 halt events for 100 distinct agents = 100 new agent-stuck conditions per request
    const halts = (i: number) =>
      Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, j) => ev(`h${i}-${j}`, { kind: "halt", severity: "critical", at: NOW - 20_000 + i * 100 + j, agent: `Agent${i}x${j}`, scenario: "benched", status: undefined, text: "benched" }));
    const first = await b.post("/api/ingest/events", batch(halts(0)));
    // a host shows at most MAX_OPEN_CRITICAL_ALERTS_PER_HOST critical alerts; the rest are counted in ONE critical notice
    expect(await first.json()).toMatchObject({ accepted: 100, alertsOpened: MAX_OPEN_CRITICAL_ALERTS_PER_HOST + 1 });
    expect(b.wr().n).toBe(R + 100 * WRITE_COST.haltEvent + (MAX_OPEN_CRITICAL_ALERTS_PER_HOST + 1) * WRITE_COST.alertOpen);

    let ok = 1;
    for (let i = 1; i < 200; i++) {
      const res = await b.post("/api/ingest/events", batch(halts(i)), NOW + i);
      if (res.status === 429) break;
      ok++;
    }
    // What stops the flood is the budget: every request costs 501 + the alerts it opens (and the ones it evicts), ~900.
    expect(ok).toBeGreaterThan(10);
    expect(ok).toBeLessThan(40);
    // The table does not grow with the flood: 60 open criticals + the notice, whatever was sent
    expect(b.count("alerts", "rule = 'agent-stuck' AND resolved IS NULL")).toBe(MAX_OPEN_CRITICAL_ALERTS_PER_HOST);
    expect(b.db.rows("SELECT severity FROM alerts WHERE key = 'alerts-capped|hosta|!critical' AND resolved IS NULL")).toEqual([{ severity: "critical" }]);
    // ... and the NEWEST agent of the last accepted request is among them (the oldest are the ones evicted, never the newest refused)
    expect(b.count("alerts", `key = 'agent-stuck|hosta|proja|agent${ok - 1}x99|benched' AND resolved IS NULL`)).toBe(1);
    expect(b.count("alerts", "key = 'budget-exhausted|hosta' AND resolved IS NULL")).toBe(1); // and the refusal itself is visible
    // The counter may overshoot by at most one request plus the critical-halt allowance (every halt that can raise
    // an alert IS a critical halt, so once the budget is spent the next 200 of them are still accepted), never more.
    const request1 = R + 100 * WRITE_COST.haltEvent + (MAX_OPEN_CRITICAL_ALERTS_PER_HOST * (WRITE_COST.alertOpen + WRITE_COST.alertResolve) + WRITE_COST.alertOpen);
    expect(b.wr().n).toBeLessThanOrEqual(MAX_HOST_WRITES_PER_DAY + request1 + MAX_CRITICAL_HALTS_PER_DAY * (WRITE_COST.haltEvent + WRITE_COST.alertOpen));
    // real rows written (events + alerts, table rows + indexes) stay far below the 100 k/day D1 Free quota
    const physical = b.count("events") * WRITE_COST.haltEvent + b.count("alerts") * WRITE_COST.alertOpen;
    expect(physical).toBeLessThan(MAX_HOST_WRITES_PER_DAY + 4000);
  });

  test("a flood of NON-critical alerts in one project is capped at MAX_OPEN_ALERTS_PER_PROJECT, with one alerts-capped warning", async () => {
    const b = await bootHost();
    const tasks = Array.from({ length: 200 }, (_, i) => task(`B${i}`, { state: "blocked", agent: `agent${i}` }));
    await b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: "flood", tasks } as never, NOW));
    expect(b.count("alerts", "rule = 'blocked' AND resolved IS NULL")).toBe(MAX_OPEN_ALERTS_PER_PROJECT);
    expect(b.db.rows("SELECT key, severity FROM alerts WHERE rule = 'alerts-capped'")).toEqual([{ key: "alerts-capped|hosta|flood", severity: "warn" }]);
  });

  test("alerts opened by the CRON are charged to the host that owns them too (young approvals that age into alerts)", async () => {
    const b = await bootHost();
    const before = b.wr().n;
    // 20 projects x 50 approvals requested 299 s ago: they only become alerts a minute later, in the cron
    for (let p = 0; p < 20; p++) {
      const approvals = Array.from({ length: 50 }, (_, i) => ({ id: `a${p}-${i}`, summary: "x", requestedAt: NOW - 299_000 }));
      await b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: `p${p}`, approvals } as never, NOW));
    }
    const atIngest = b.wr().n - before;
    await runCron(b.env, b.ctx, NOW + 60_000);
    await b.ctx.flush();
    const open = b.count("alerts", "rule = 'approval-waiting' AND resolved IS NULL");
    expect(open).toBe(MAX_OPEN_ALERTS_PER_HOST); // 20 projects x 20 approvals are 400, a host keeps its newest 200 (not 1,000)
    // (the snapshot sanitiser had already dropped approvals 21..50 of every project, so no project is over its own cap;
    // the host is: ONE notice says so)
    expect(b.db.rows("SELECT key FROM alerts WHERE rule = 'alerts-capped'")).toEqual([{ key: "alerts-capped|hosta|!all" }]);
    expect(b.wr().n - before - atIngest).toBe((open + 1) * WRITE_COST.alertOpen); // and every one of them was paid for by hosta
  });

  test("snapshot churn (replace 100 tasks every time) is bounded as well", async () => {
    const b = await bootHost();
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      const tasks = Array.from({ length: 100 }, (_, j) => task(`s${i}-${j}`));
      const res = await b.post("/api/ingest/snapshot", snapshot({ tasks, sentAt: NOW + i } as never, NOW), NOW + i);
      if (res.status === 429) break;
      ok++;
    }
    // first snapshot: 1 + 100 inserts; every later one: 1 + 100 deletes + 100 inserts = 1201
    expect(ok).toBeGreaterThan(10);
    expect(ok).toBeLessThan(30);
    expect(b.wr().n).toBeLessThanOrEqual(MAX_HOST_WRITES_PER_DAY);
    expect(b.count("tasks")).toBe(100);
  });
});

// ── relay task cap ───────────────────────────────────────────────────────────

describe("relay (foreign agent) task rows: at most MAX_RELAY_SENDERS_PER_HOST distinct senders per host", () => {
  const relayCount = (b: Awaited<ReturnType<typeof bootHost>>, project = "proja") => b.count("tasks", `origin = '${ORIGIN_RELAY}' AND project = '${project}'`);

  test("a flood of distinct (invented) senders mirrors the first 10 only; the events are still stored and the response says what was dropped", async () => {
    const b = await bootHost();
    const res = await b.post("/api/ingest/events", batch(Array.from({ length: 60 }, (_, i) => relayEv(i))));
    expect(await res.json()).toMatchObject({ ok: true, accepted: 60, relayDropped: 60 - MAX_RELAY_SENDERS_PER_HOST });
    expect(relayCount(b)).toBe(MAX_RELAY_SENDERS_PER_HOST);
    expect(b.count("events")).toBe(60);
    // only the rows that are really written are charged
    expect(b.wr().n).toBe(R + 60 * WRITE_COST.event + MAX_RELAY_SENDERS_PER_HOST * WRITE_COST.relayInsert);

    const again = await b.post("/api/ingest/events", batch([relayEv(99)]), NOW + 1000);
    expect(await again.json()).toMatchObject({ relayDropped: 1 });
    expect(relayCount(b)).toBe(MAX_RELAY_SENDERS_PER_HOST);
  });

  test("known senders keep updating at the cap, and one sender may appear in several projects (the cap counts senders, not rows)", async () => {
    const b = await bootHost();
    await b.post("/api/ingest/events", batch(Array.from({ length: MAX_RELAY_SENDERS_PER_HOST }, (_, i) => relayEv(i))));
    const res = await b.post("/api/ingest/events", batch([relayEv(7, { key: "upd", status: "BLOCKED", at: NOW - 100, text: "STATUS: BLOCKED need a key" })]), NOW + 1000);
    expect(await res.json()).not.toHaveProperty("relayDropped");
    expect(b.db.rows("SELECT state FROM tasks WHERE key = 'relay|hosta|proja|@bot7:srv'")).toEqual([{ state: "blocked" }]);
    // the same known sender in other projects: new rows, no new sender
    for (const project of ["p2", "p3", "p4"]) {
      expect(await (await b.post("/api/ingest/events", batch([relayEv(3, { key: `again-${project}` })], { project }), NOW + 2000)).json()).not.toHaveProperty("relayDropped");
    }
    expect(b.count("tasks", "origin = '" + ORIGIN_RELAY + "' AND task_id = '@bot3:srv'")).toBe(4);
  });

  test("stale rows (open, no update for 24 h) do not count: their senders free their places", async () => {
    const b = await bootHost();
    await b.post("/api/ingest/events", batch(Array.from({ length: MAX_RELAY_SENDERS_PER_HOST }, (_, i) => relayEv(i))));
    b.db.sqlite.query("UPDATE tasks SET updated = ? WHERE key IN (SELECT key FROM tasks ORDER BY key LIMIT 3)").run(NOW + 1000 - RELAY_STALE_AFTER_MS - 1);
    const res = await b.post("/api/ingest/events", batch(Array.from({ length: 5 }, (_, i) => relayEv(`n${i}`))), NOW + 1000);
    expect(await res.json()).toMatchObject({ relayDropped: 2 }); // 3 free places, 5 new senders
  });

  test("the per-project (50) and per-host (200) row caps still stand behind it, for rows that were already there", async () => {
    const b = await bootHost();
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < MAX_RELAY_TASKS_PER_PROJECT; i++) {
      b.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 's', '" + ORIGIN_RELAY + "', 'hosta', 'proja', 'a', ?, 't', 'running', ?, ?)").run(`relay|hosta|proja|@old${i}:srv`, "@bot0:srv", NOW, NOW);
    }
    b.db.sqlite.exec("COMMIT");
    // all 50 rows belong to ONE sender (so the sender cap is not what refuses): the project's row cap is
    const res = await b.post("/api/ingest/events", batch([relayEv(0, { sender: "@bot0:srv", key: "x1" })]), NOW + 1000);
    expect(await res.json()).toMatchObject({ relayDropped: 1 });
  });
});
