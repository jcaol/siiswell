import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { HOST_OFFLINE_AFTER_MS, type TaskSnapshot } from "../src/shared/schema";
import { route } from "../src/index";
import { buildState } from "../src/state";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

async function boot() {
  const t = makeEnv();
  const ctx = makeCtx();
  const hostToken = await addSource(t.db, "hosta", "host");
  const send = (path: string, body: unknown) => route(request(path, { body, token: hostToken }), t.env, ctx, { now: NOW });
  const state = async () => {
    const res = await route(request("/api/state"), t.env, ctx, { now: NOW });
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };
  return { ...t, ctx, hostToken, send, state };
}

const task = (id: string, over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id, agent: "Agent01", title: `task ${id}`, state: "running", dispatchedAt: NOW - 3600_000, updatedAt: NOW - 1000, ...over,
});

describe("GET /api/state", () => {
  test("has the documented shape, populated from ingest", async () => {
    const { send, state, db, hostToken } = await boot();
    db.sqlite.query("INSERT INTO sources (id, name, kind, token_sha256, created, last_seen) VALUES ('c1', 'client1', 'client', 'h1', 1, ?)").run(NOW - 5000);
    db.sqlite.query("INSERT INTO sources (id, name, kind, token_sha256, created, revoked) VALUES ('c2', 'revoked-client', 'client', 'h2', 1, 1)").run();
    void hostToken;
    await send("/api/ingest/snapshot", snapshot({
      tasks: [task("t1")],
      discussions: [{ id: "d1", topic: "which db", status: "active", round: 2, maxRounds: 5, messages: 6, maxMessages: 20, participants: ["Agent01", "Agent02"], benched: [], lastSpeaker: "Agent02", updatedAt: NOW }],
      approvals: [{ id: "ap1", summary: "rm -rf build", requestedAt: NOW - 6 * 60_000, agent: "Agent01" }],
    }, NOW));
    await send("/api/ingest/events", { v: 1, host: "hosta", project: "proja", events: [{ kind: "halt", origin: ORIGIN_HOST, at: NOW, severity: "critical", key: "h1", agent: "Agent02", scenario: "benched", text: "benched" }] });

    const s = await state();
    expect(Object.keys(s).sort()).toEqual(["clients", "discussions", "events", "hosts", "inbox", "mcpProjects", "now", "projects", "rulesTruncated", "serverVersion", "tasks", "truncated"]);
    expect(s.now).toBe(NOW);

    expect(s.hosts).toEqual([{ host: "hosta", lastSeen: NOW, offline: false, binaryVersion: "1.0.1", projects: ["proja"], clientVersion: null }]);

    expect(s.projects).toHaveLength(1);
    expect(s.projects[0]).toMatchObject({ host: "hosta", project: "proja", receivedAt: NOW });
    expect(s.projects[0].poller).toMatchObject({ status: "running", binaryVersion: "1.0.1" });
    expect(s.projects[0].agents.map((a: any) => a.name)).toEqual(["agent01", "agent02"]);

    expect(s.tasks).toEqual([
      { key: "hosta|proja|t1", origin: ORIGIN_HOST, host: "hosta", project: "proja", agent: "agent01", taskId: "t1", title: "task t1", state: "running", etaAt: null, lastLine: null, startedAt: NOW - 3600_000, updated: NOW - 1000, machine: null, kind: null },
    ]);

    expect(s.discussions).toHaveLength(1);
    expect(s.discussions[0]).toMatchObject({ host: "hosta", project: "proja", id: "d1", topic: "which db", round: 2, lastSpeaker: "agent02" });

    expect(s.clients).toEqual([{ name: "client1", lastSeen: NOW - 5000, clientVersion: null }]); // host tokens and revoked clients are not listed

    expect(s.inbox.map((a: any) => a.rule).sort()).toEqual(["agent-stuck", "approval-waiting"]);
    expect(Object.keys(s.inbox[0]).sort()).toEqual(["agent", "host", "key", "opened", "origin", "project", "push_count", "rule", "severity", "summarized_at", "text"]);

    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ key: "h1", kind: "halt", scenario: "benched", at: NOW });
  });

  test("a host silent for more than 5 minutes is flagged offline", async () => {
    const { state, db } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen, binary_version) VALUES ('fresh', ?, '1'), ('edge', ?, '1'), ('stale', ?, NULL)").run(NOW - 1000, NOW - HOST_OFFLINE_AFTER_MS, NOW - HOST_OFFLINE_AFTER_MS - 1);
    const s = await state();
    expect(Object.fromEntries(s.hosts.map((h: any) => [h.host, h.offline]))).toEqual({ fresh: false, edge: false, stale: true });
    expect(s.hosts.find((h: any) => h.host === "stale")).toMatchObject({ binaryVersion: null, projects: [] });
  });

  test("tasks: open ones always, done/failed only inside 24 h, skipped never; newest first; capped at 300", async () => {
    const { db, state } = await boot();
    const ins = db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 's', '" + ORIGIN_HOST + "', 'h', 'p', 'A', ?, ?, ?, 1, ?)");
    ins.run("k1", "t-run", "run", "running", NOW - 100);
    ins.run("k2", "t-old-run", "old running", "running", NOW - 10 * DAY);
    ins.run("k3", "t-blocked", "blocked", "blocked", NOW - 50);
    ins.run("k4", "t-done", "done recently", "done", NOW - DAY + 1000);
    ins.run("k5", "t-done-old", "done long ago", "done", NOW - DAY - 1000);
    ins.run("k6", "t-failed", "failed recently", "failed", NOW - 200);
    ins.run("k7", "t-skipped", "skipped", "skipped", NOW - 10);
    ins.run("k8", "t-queued", "queued", "queued", NOW - 300);
    const s = await state();
    expect(s.tasks.map((t: any) => t.taskId)).toEqual(["t-blocked", "t-run", "t-failed", "t-queued", "t-done", "t-old-run"]);

    for (let i = 0; i < 350; i++) ins.run(`bulk${i}`, `b${i}`, "b", "running", NOW - 400 - i);
    expect((await state()).tasks).toHaveLength(300);
  });

  test("events: the last 50, newest first", async () => {
    const { db, state } = await boot();
    const ins = db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'h', 'p', 'halt', '" + ORIGIN_HOST + "', 'info', 'x', ?, ?)");
    for (let i = 0; i < 80; i++) ins.run(`e${i}`, NOW - i * 1000, NOW);
    const s = await state();
    expect(s.events).toHaveLength(50);
    expect(s.events[0].key).toBe("e0");
    expect(s.events[49].key).toBe("e49");
  });

  test("inbox lists only open alerts, newest first", async () => {
    const { db, state } = await boot();
    const ins = db.sqlite.query("INSERT INTO alerts (key, rule, severity, host, text, opened, resolved) VALUES (?, 'blocked', 'warn', 'h', ?, ?, ?)");
    ins.run("a", "old", NOW - 3000, null);
    ins.run("b", "new", NOW - 1000, null);
    ins.run("c", "closed", NOW - 500, NOW - 100);
    expect((await state()).inbox.map((a: any) => a.key)).toEqual(["b", "a"]);
  });

  test("an unparsable stored snapshot is skipped, not fatal", async () => {
    const { db } = await boot();
    db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'h', 'p', '{broken', 1)").run();
    const s = await buildState(db as unknown as D1Database, NOW);
    expect(s.projects).toEqual([]);
  });

  test("is read-only and Access-protected: POST is 405, no token needed in dev mode but a missing JWT is 403 once Access is configured", async () => {
    const { env } = makeEnv();
    const ctx = makeCtx();
    expect((await route(request("/api/state", { method: "POST", body: {} }), env, ctx, { now: NOW })).status).toBe(405);
    const locked = makeEnv({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "aud" });
    expect((await route(request("/api/state"), locked.env, ctx, { now: NOW })).status).toBe(403);
  });
});
