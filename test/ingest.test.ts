import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_SCHEMA_VERSION,
  MAX_EVENTS_PER_BATCH,
  MAX_SNAPSHOT_BYTES,
  MAX_TASKS_PER_SNAPSHOT,
  MAX_TEXT,
  MAX_TITLE,
  type DashboardEvent,
  type TaskSnapshot,
} from "../src/shared/schema";
import { route } from "../src/index";
import { acceptsLastLine, sanitizeEvent, sanitizeSnapshot } from "../src/ingest";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";

const NOW = 1_800_000_000_000;

async function boot() {
  const t = makeEnv();
  const ctx = makeCtx();
  const hostToken = await addSource(t.db, "hosta", "host");
  const clientToken = await addSource(t.db, "client1", "client");
  const call = (req: Request, fetchImpl?: (u: string, i?: RequestInit) => Promise<Response>) =>
    route(req, t.env, ctx, { now: NOW, fetch: fetchImpl });
  return { ...t, ctx, hostToken, clientToken, call };
}

const task = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: "Agent01-abc",
  agent: "agent01",
  title: "implement the thing",
  state: "running",
  dispatchedAt: NOW - 600_000,
  updatedAt: NOW - 300_000,
  etaAt: NOW + 600_000,
  lastLine: "STATUS: IN PROGRESS ETA 10 min",
  ...over,
});

const event = (over: Partial<DashboardEvent> = {}): DashboardEvent => ({
  kind: "halt",
  origin: ORIGIN_HOST,
  at: NOW - 1000,
  severity: "critical",
  key: "halt:Agent02:1",
  agent: "Agent02",
  scenario: "benched",
  text: "Agent02 was benched",
  ...over,
});

const batch = (events: unknown[], over: Record<string, unknown> = {}) => ({ v: 1, host: "hosta", project: "proja", events, ...over });

describe("auth scoping", () => {
  test("no token, bad token and revoked token are 401; client token on ingest is 403", async () => {
    const { call, db, hostToken, clientToken } = await boot();
    const revoked = await addSource(db, "old-host", "host", { revoked: true });
    const snap = snapshot({}, NOW);
    expect((await call(request("/api/ingest/snapshot", { body: snap }))).status).toBe(401);
    expect((await call(request("/api/ingest/snapshot", { body: snap, token: "oct_notarealtoken0000" }))).status).toBe(401);
    expect((await call(request("/api/ingest/snapshot", { body: snap, token: revoked }))).status).toBe(401);
    const forbidden = await call(request("/api/ingest/snapshot", { body: snap, token: clientToken }));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()) as { error: string }).toEqual({ error: "a 'client' token cannot call this endpoint" });
    expect((await call(request("/api/ingest/snapshot", { body: snap, token: hostToken }))).status).toBe(200);
  });

  test("only POST is accepted", async () => {
    const { call, hostToken } = await boot();
    const res = await call(request("/api/ingest/snapshot", { method: "GET", token: hostToken }));
    expect(res.status).toBe(405);
  });

  test("the token is stored hashed and never echoed", async () => {
    const { call, db, hostToken } = await boot();
    const res = await call(request("/api/ingest/snapshot", { body: snapshot({}, NOW), token: hostToken }));
    expect(await res.text()).not.toContain(hostToken);
    expect(JSON.stringify(db.rows("SELECT * FROM sources"))).not.toContain(hostToken);
  });
});

describe("limits and versioning", () => {
  test("v != 1 is rejected on all three routes", async () => {
    const { call, hostToken } = await boot();
    const bad = { ...snapshot({}, NOW), v: 2 };
    expect((await call(request("/api/ingest/snapshot", { body: bad, token: hostToken }))).status).toBe(400);
    expect((await call(request("/api/ingest/events", { body: batch([event()], { v: 2 }), token: hostToken }))).status).toBe(400);
    expect((await call(request("/api/ingest/heartbeat", { body: { v: 0, host: "hosta", at: NOW }, token: hostToken }))).status).toBe(400);
    expect((await call(request("/api/ingest/snapshot", { body: { ...bad, v: undefined }, token: hostToken }))).status).toBe(400);
  });

  test("bodies over MAX_SNAPSHOT_BYTES are rejected (declared and streamed)", async () => {
    const { call, hostToken } = await boot();
    const big = JSON.stringify(snapshot({ project: "x".repeat(MAX_SNAPSHOT_BYTES) }, NOW));
    const declared = await call(request("/api/ingest/snapshot", { rawBody: big, token: hostToken }));
    expect(declared.status).toBe(413);

    const stream = new Request("http://localhost:8787/api/ingest/snapshot", {
      method: "POST",
      headers: { Authorization: `Bearer ${hostToken}`, "Content-Type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big.slice(0, MAX_SNAPSHOT_BYTES)));
          c.enqueue(new TextEncoder().encode(big.slice(MAX_SNAPSHOT_BYTES)));
          c.close();
        },
      }),
      // @ts-expect-error bun/undici need this for streamed request bodies
      duplex: "half",
    });
    expect((await call(stream)).status).toBe(413);
  });

  test("more than MAX_EVENTS_PER_BATCH events or MAX_TASKS_PER_SNAPSHOT tasks is rejected", async () => {
    const { call, hostToken } = await boot();
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => event({ key: `k${i}` }));
    expect((await call(request("/api/ingest/events", { body: batch(many), token: hostToken }))).status).toBe(400);
    const exactly = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) => event({ key: `k${i}` }));
    expect((await call(request("/api/ingest/events", { body: batch(exactly), token: hostToken }))).status).toBe(200);

    const tasks = Array.from({ length: MAX_TASKS_PER_SNAPSHOT + 1 }, (_, i) => task({ id: `t${i}` }));
    expect((await call(request("/api/ingest/snapshot", { body: snapshot({ tasks }, NOW), token: hostToken }))).status).toBe(400);
  });

  test("invalid JSON and non-object bodies are 400", async () => {
    const { call, hostToken } = await boot();
    expect((await call(request("/api/ingest/snapshot", { rawBody: "{nope", token: hostToken }))).status).toBe(400);
    expect((await call(request("/api/ingest/snapshot", { rawBody: "[1,2]", token: hostToken }))).status).toBe(400);
    expect((await call(request("/api/ingest/snapshot", { rawBody: "null", token: hostToken }))).status).toBe(400);
  });
});

describe("sanitising (the sender is never trusted)", () => {
  test("text is re-clipped and redacted: a Bearer token in a title comes back redacted", async () => {
    const { call, db, hostToken } = await boot();
    const snap = snapshot(
      {
        tasks: [
          task({ title: "deploy with Authorization: Bearer abcdef0123456789ABCDEF", lastLine: `token=sk-live-abcdef0123456789 ${"y".repeat(400)}` }),
          task({ id: "long", title: "t".repeat(500) }),
        ],
        approvals: [{ id: "ap", summary: "run with password=hunter2hunter2", requestedAt: NOW - 1000 }],
        discussions: [{ id: "d1", topic: "ghp_abcdefghijklmnop1234 is the key", status: "active", round: 1, maxRounds: 3, messages: 2, maxMessages: 9, participants: ["Agent01"], benched: [], updatedAt: NOW }],
      },
      NOW,
    );
    expect((await call(request("/api/ingest/snapshot", { body: snap, token: hostToken }))).status).toBe(200);
    const rows = db.rows<{ title: string; last_line: string | null; task_id: string }>("SELECT task_id, title, last_line FROM tasks ORDER BY task_id");
    const secret = rows.find((r) => r.task_id === "Agent01-abc");
    expect(secret?.title).toBe("deploy with Authorization: Bearer [redacted]");
    expect(secret?.last_line).toContain("token=[redacted]");
    expect((secret?.last_line ?? "").length).toBeLessThanOrEqual(MAX_TEXT);
    expect(rows.find((r) => r.task_id === "long")?.title.length).toBe(MAX_TITLE);
    const stored = db.rows<{ json: string }>("SELECT json FROM snapshots")[0]?.json ?? "";
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toContain("abcdef0123456789ABCDEF");
    expect(stored).not.toContain("ghp_abcdefghijklmnop1234");
    expect(stored).not.toContain("sk-live");
  });

  test("events: text redacted + clipped, bad enums dropped, mcp origin refused, future timestamps clamped", async () => {
    const { call, db, hostToken } = await boot();
    const events = [
      event({ key: "e-secret", text: `Bearer abcdefghijklmnop ${"z".repeat(500)}` }),
      { ...event({ key: "e-badkind" }), kind: "nope" },
      { ...event({ key: "e-mcp" }), origin: "mcp" },
      { ...event({ key: "e-future" }), at: NOW + 10 * 86_400_000 },
      { ...event({ key: "e-sev" }), severity: "apocalyptic" },
      { kind: "halt" },
    ];
    const res = await call(request("/api/ingest/events", { body: batch(events), token: hostToken }));
    expect(await res.json()).toMatchObject({ ok: true, accepted: 3, dropped: 3 });
    const rows = db.rows<{ key: string; text: string; at: number; severity: string }>("SELECT key, text, at, severity FROM events ORDER BY key");
    expect(rows.map((r) => r.key)).toEqual(["e-future", "e-secret", "e-sev"]);
    expect(rows[1]?.text.startsWith("Bearer [redacted]")).toBe(true);
    expect(rows[1]?.text.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(rows[0]?.at).toBe(NOW); // clamped to the server clock
    expect(rows[2]?.severity).toBe("critical"); // derived from the benched scenario
  });

  test("unknown fields are dropped and enums/numbers are normalised", () => {
    const raw = {
      ...snapshot({}, NOW),
      evil: "<script>",
      agents: [{ name: "Agent.B", state: "levitating", contextPercent: 900, extra: 1, usage: [{ label: "5h", usedPercent: -5, nope: 1 }] }],
      tasks: [task({ state: "weird" as never }), { ...task({ id: "ok" }), sneaky: true }],
    };
    const r = sanitizeSnapshot(raw, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toHaveProperty("evil");
    expect(r.value.agents[0]).toEqual({ name: "agent.b", state: "unknown", contextPercent: 100, usage: [{ label: "5h", usedPercent: 0 }] });
    expect(r.value.tasks.map((t) => t.id)).toEqual(["ok"]);
    expect(r.value.tasks[0]).not.toHaveProperty("sneaky");
    expect(r.value.v).toBe(DASHBOARD_SCHEMA_VERSION);
  });

  test("an event without key / at / valid kind is refused by sanitizeEvent", () => {
    expect(sanitizeEvent({ kind: "halt", origin: ORIGIN_HOST, at: 1, text: "x" }, NOW)).toBeNull();
    expect(sanitizeEvent({ ...event(), at: "now" }, NOW)).toBeNull();
    expect(sanitizeEvent(event({ scenario: "Benched" }), NOW)?.scenario).toBe("benched"); // lower-cased after validation
    expect(() => sanitizeEvent(event({ scenario: "Benched; DROP TABLE" }), NOW)).toThrow(/scenario must match/); // rejected, not rewritten
  });
});

describe("snapshot ingest", () => {
  test("upserts snapshots/hosts/tasks and a second snapshot replaces only that host+project's host-agent tasks", async () => {
    const { call, db, hostToken } = await boot();
    const other = (host: string, project: string, id: string, origin = ORIGIN_HOST) =>
      db.sqlite
        .query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 's', ?, ?, ?, 'A', ?, 't', 'running', 1, 1)")
        .run(`${host}|${project}|${id}`, origin, host, project, id);
    other("hosta", "other-project", "keep1");
    other("otherhost", "proja", "keep2");
    other("hosta", "proja", "relay1", ORIGIN_RELAY);
    db.sqlite
      .query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES ('mcp|client1|m-1', 's', 'mcp', 'client1', 'proja', 'A', 'm-1', 't', 'running', 1, 1)")
      .run();

    const first = snapshot({ tasks: [task({ id: "t1" }), task({ id: "t2" }), task({ id: "t3" })] }, NOW);
    expect((await call(request("/api/ingest/snapshot", { body: first, token: hostToken }))).status).toBe(200);
    expect(db.rows("SELECT task_id FROM tasks WHERE host = 'hosta' AND project = 'proja' AND origin = '" + ORIGIN_HOST + "'")).toHaveLength(3);

    // 24 h window moved on: t1 is gone, t2 changed state, t4 is new.
    const second = snapshot({ tasks: [task({ id: "t2", state: "done", title: "renamed" }), task({ id: "t4" })] }, NOW);
    expect((await call(request("/api/ingest/snapshot", { body: second, token: hostToken }))).status).toBe(200);
    const mine = db.rows<{ task_id: string; state: string; title: string }>(
      "SELECT task_id, state, title FROM tasks WHERE host = 'hosta' AND project = 'proja' AND origin = '" + ORIGIN_HOST + "' ORDER BY task_id",
    );
    expect(mine).toEqual([
      { task_id: "t2", state: "done", title: "renamed" },
      { task_id: "t4", state: "running", title: "implement the thing" },
    ]);
    const untouched = db.rows<{ key: string }>("SELECT key FROM tasks WHERE task_id IN ('keep1', 'keep2', 'relay1', 'm-1') ORDER BY key");
    expect(untouched.map((r) => r.key)).toEqual(["hosta|other-project|keep1", "hosta|proja|relay1", "mcp|client1|m-1", "otherhost|proja|keep2"]);
    expect(db.rows("SELECT * FROM snapshots")).toHaveLength(1);
  });

  test("a blocked task alert (closed ledger task kept in the snapshot) resolves when the same agent gets a newer dispatch", async () => {
    const { call, db, hostToken } = await boot();
    const blocked = task({ id: "Agent01-old", state: "blocked", dispatchedAt: NOW - 3_600_000, updatedAt: NOW - 3_000_000, lastLine: "STATUS: BLOCKED need creds" });
    const first = await call(request("/api/ingest/snapshot", { body: snapshot({ tasks: [blocked] }, NOW), token: hostToken }));
    expect(await first.json()).toMatchObject({ alertsOpened: 1 });
    expect(db.rows<any>("SELECT key, resolved FROM alerts")).toEqual([{ key: "blocked|hosta|proja|Agent01-old", resolved: null }]);

    // Same snapshot again: still blocked, no second alert, nothing re-opened.
    const again = await call(request("/api/ingest/snapshot", { body: snapshot({ tasks: [blocked] }, NOW), token: hostToken }));
    expect(await again.json()).toMatchObject({ alertsOpened: 0, alertsResolved: 0 });

    // Another agent's newer task does not count.
    await call(request("/api/ingest/snapshot", { body: snapshot({ tasks: [blocked, task({ id: "Agent02-new", agent: "Agent02", state: "queued", dispatchedAt: NOW - 1000, updatedAt: NOW - 1000 })] }, NOW), token: hostToken }));
    expect(db.rows<any>("SELECT resolved FROM alerts")[0].resolved).toBeNull();

    // The operator answered: Agent01 gets a new task while the blocked one is still in the 24 h window.
    const answered = await call(request("/api/ingest/snapshot", {
      body: snapshot({ tasks: [blocked, task({ id: "Agent01-new", state: "delivered", dispatchedAt: NOW - 1000, updatedAt: NOW - 1000, etaAt: undefined })] }, NOW),
      token: hostToken,
    }));
    expect(await answered.json()).toMatchObject({ alertsResolved: 1 });
    expect(db.rows<any>("SELECT resolved FROM alerts")[0].resolved).toBe(NOW);
    expect(db.rows("SELECT * FROM tasks WHERE state = 'blocked'")).toHaveLength(1); // the closed task is still listed
  });

  test("an empty task list clears the project's host-agent tasks", async () => {
    const { call, db, hostToken } = await boot();
    await call(request("/api/ingest/snapshot", { body: snapshot({ tasks: [task()] }, NOW), token: hostToken }));
    expect(db.rows("SELECT * FROM tasks")).toHaveLength(1);
    await call(request("/api/ingest/snapshot", { body: snapshot({ tasks: [] }, NOW), token: hostToken }));
    expect(db.rows("SELECT * FROM tasks")).toHaveLength(0);
  });

  test("a full snapshot (200 tasks) is written in a handful of statements, not one per task", async () => {
    const { call, db, hostToken } = await boot();
    const tasks = Array.from({ length: MAX_TASKS_PER_SNAPSHOT }, (_, i) => task({ id: `t${i}` }));
    const before = db.executed;
    const res = await call(request("/api/ingest/snapshot", { body: snapshot({ tasks }, NOW), token: hostToken }));
    expect(res.status).toBe(200);
    expect(db.rows("SELECT * FROM tasks")).toHaveLength(MAX_TASKS_PER_SNAPSHOT);
    expect(db.executed - before).toBeLessThan(15);
  });

  test("updates host liveness and binary version", async () => {
    const { call, db, hostToken } = await boot();
    await call(request("/api/ingest/snapshot", { body: snapshot({ poller: { status: "running", binaryVersion: "1.0.1" } }, NOW), token: hostToken }));
    expect(db.rows("SELECT host, last_seen, binary_version FROM hosts")).toEqual([{ host: "hosta", last_seen: NOW, binary_version: "1.0.1" }]);
  });

  test("evaluates the rules: an old approval opens an alert", async () => {
    const { call, db, hostToken } = await boot();
    const res = await call(
      request("/api/ingest/snapshot", {
        body: snapshot({ approvals: [{ id: "ap1", summary: "rm -rf build", requestedAt: NOW - 6 * 60_000, agent: "Agent01" }] }, NOW),
        token: hostToken,
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, alertsOpened: 1 });
    expect(db.rows("SELECT key, rule, severity, project, agent, push_count FROM alerts")[0]).toMatchObject({
      key: "approval-waiting|hosta|proja|ap1",
      rule: "approval-waiting",
      agent: "agent01",
    });
  });
});

describe("events ingest", () => {
  test("is idempotent by key (re-sent batches do not duplicate)", async () => {
    const { call, db, hostToken } = await boot();
    const body = batch([event({ key: "same" }), event({ key: "other", scenario: "turn-not-submitted", severity: "warn" })]);
    await call(request("/api/ingest/events", { body, token: hostToken }));
    await call(request("/api/ingest/events", { body, token: hostToken }));
    expect(db.rows("SELECT key FROM events ORDER BY key")).toEqual([{ key: "other" }, { key: "same" }]);
  });

  test("one invalid event is dropped and counted; the valid ones in the same batch still land (no whole-batch 400)", async () => {
    const { call, db, hostToken } = await boot();
    const body = batch([
      event({ key: "good-halt" }),
      event({ key: "bad-agent", kind: "status", origin: ORIGIN_RELAY, agent: "bad agent!", status: "BLOCKED", scenario: undefined }),
      event({ key: "plus-agent", kind: "status", origin: ORIGIN_RELAY, agent: "mac+bot@relay", sender: "@mac+bot:other.org", status: "DONE", severity: "info", scenario: undefined }),
    ]);
    const res = await call(request("/api/ingest/events", { body, token: hostToken }));
    expect(res.status).toBe(200);
    const j = await res.json() as { accepted: number; dropped: number; firstError?: string };
    expect(j).toMatchObject({ accepted: 2, dropped: 1 });
    expect(j.firstError).toContain("agent");
    expect(db.rows("SELECT key FROM events ORDER BY key")).toEqual([{ key: "good-halt" }, { key: "plus-agent" }]);
  });

  test("a benched halt event opens an agent-stuck alert", async () => {
    const { call, db, hostToken } = await boot();
    const res = await call(request("/api/ingest/events", { body: batch([event()]), token: hostToken }));
    expect(await res.json()).toMatchObject({ accepted: 1, alertsOpened: 1 });
    const a = db.rows<{ key: string; rule: string; severity: string; agent: string }>("SELECT key, rule, severity, agent FROM alerts")[0];
    expect(a).toMatchObject({ rule: "agent-stuck", severity: "critical", agent: "agent02" });
    expect(a?.key).toBe(`agent-stuck|hosta|proja|agent02|benched`);
  });

  test("relay-origin STATUS events mirror a task row per foreign agent; BLOCKED opens an alert, DONE closes it", async () => {
    const { call, db, hostToken } = await boot();
    const relay = (over: Partial<DashboardEvent>) =>
      event({ kind: "status", origin: ORIGIN_RELAY, severity: "info", scenario: undefined, agent: "OtherBot", sender: "@otherbot:srv", ...over });
    await call(request("/api/ingest/events", { body: batch([relay({ key: "r1", at: NOW - 3000, status: "IN_PROGRESS", etaMin: 20, text: "STATUS: IN PROGRESS building" })]), token: hostToken }));
    let row = db.rows<{ state: string; origin: string; eta_at: number; key: string }>("SELECT key, state, origin, eta_at FROM tasks")[0];
    expect(row).toMatchObject({ key: "relay|hosta|proja|@otherbot:srv", state: "running", origin: ORIGIN_RELAY, eta_at: NOW - 3000 + 20 * 60_000 });

    const res = await call(request("/api/ingest/events", { body: batch([relay({ key: "r2", at: NOW - 2000, status: "BLOCKED", text: "STATUS: BLOCKED need a key" })]), token: hostToken }));
    expect(await res.json()).toMatchObject({ alertsOpened: 1 });
    expect(db.rows("SELECT rule FROM alerts")).toEqual([{ rule: "blocked" }]);

    // an older replayed event must not regress the row
    await call(request("/api/ingest/events", { body: batch([relay({ key: "r1b", at: NOW - 9000, status: "IN_PROGRESS", text: "old" })]), token: hostToken }));
    row = db.rows<{ state: string; origin: string; eta_at: number; key: string }>("SELECT key, state, origin, eta_at FROM tasks")[0];
    expect(row?.state).toBe("blocked");

    const done = await call(request("/api/ingest/events", { body: batch([relay({ key: "r3", at: NOW - 1000, status: "DONE", text: "STATUS: DONE" })]), token: hostToken }));
    expect(await done.json()).toMatchObject({ ok: true });
    expect(db.rows<{ resolved: number | null }>("SELECT resolved FROM alerts")[0]?.resolved).toBe(NOW);
    expect(db.rows("SELECT state FROM tasks")).toEqual([{ state: "done" }]);
  });

  test("events from the host-agent origin do not create task rows (the snapshot owns those)", async () => {
    const { call, db, hostToken } = await boot();
    await call(request("/api/ingest/events", { body: batch([event({ kind: "status", status: "BLOCKED", severity: "warn", scenario: undefined })]), token: hostToken }));
    expect(db.rows("SELECT * FROM tasks")).toHaveLength(0);
  });
});

describe("heartbeat", () => {
  test("touches the host, records the version and resolves a host-offline alert", async () => {
    const { call, db, hostToken } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?)").run(NOW - 20 * 60_000);
    db.sqlite
      .query("INSERT INTO alerts (key, rule, severity, host, text, opened, push_count) VALUES ('host-offline|hosta', 'host-offline', 'critical', 'hosta', 'x', ?, 1)")
      .run(NOW - 10 * 60_000);
    const res = await call(request("/api/ingest/heartbeat", { body: { v: 1, host: "hosta", at: NOW, binaryVersion: "1.0.2" }, token: hostToken }));
    expect(res.status).toBe(200);
    expect(db.rows("SELECT last_seen, binary_version FROM hosts")).toEqual([{ last_seen: NOW, binary_version: "1.0.2" }]);
    expect(db.rows<{ resolved: number }>("SELECT resolved FROM alerts")[0]?.resolved).toBe(NOW);
  });

  test("requires a host", async () => {
    const { call, hostToken } = await boot();
    expect((await call(request("/api/ingest/heartbeat", { body: { v: 1, at: NOW }, token: hostToken }))).status).toBe(400);
  });
});

describe("ACCEPT_LAST_LINE", () => {
  const snap = () => ({ v: 1, host: "hosta", project: "proja", poller: { pid: 1, startedAt: NOW - 1000, binaryVersion: "1" }, agents: [], tasks: [task({ lastLine: "typed text of a reply" })] });
  test("sanitizeSnapshot drops lastLine when told to, keeps it otherwise", () => {
    const drop = sanitizeSnapshot(snap(), NOW, false);
    const keep = sanitizeSnapshot(snap(), NOW, true);
    expect(drop.ok && drop.value.tasks[0]?.lastLine).toBeUndefined();
    expect(keep.ok && keep.value.tasks[0]?.lastLine).toBe("typed text of a reply");
  });
  test("acceptsLastLine: only \"1\"", () => {
    expect(acceptsLastLine({})).toBe(false);
    expect(acceptsLastLine({ ACCEPT_LAST_LINE: "0" })).toBe(false);
    expect(acceptsLastLine({ ACCEPT_LAST_LINE: "1" })).toBe(true);
  });
});
