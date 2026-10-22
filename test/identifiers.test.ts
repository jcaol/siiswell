// Identifiers (host, project, agent, ids, senders) are validated against strict character sets and
// rejected with 400, never rewritten; agent names are lower-cased so every comparison is case-insensitive.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { route } from "../src/index";
import { AGENT_RE, HOST_RE, ID_RE, SENDER_RE } from "../src/util";
import { addSource, makeCtx, makeEnv, request, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;

async function boot(hostName = "hosta") {
  const t = makeEnv();
  const ctx = makeCtx();
  const token = await addSource(t.db, hostName, "host");
  const post = (path: string, body: unknown, tok = token) => route(request(path, { token: tok, body }), t.env, ctx, { now: NOW });
  return { ...t, ctx, token, post };
}

const TABLES = ["snapshots", "hosts", "tasks", "events", "alerts"] as const;
const rowCount = (db: D1Shim) => TABLES.map((t) => (db.rows(`SELECT * FROM ${t}`) as unknown[]).length).reduce((a, b) => a + b, 0);

const halt = (over: Record<string, unknown> = {}) => ({
  kind: "halt", origin: ORIGIN_HOST, at: NOW - 1000, severity: "critical", key: "k1", agent: "Agent02", scenario: "benched", text: "x", ...over,
});
const ev = (host: string, events: unknown[]) => ({ v: 1, host, project: "proja", events });

describe("character sets", () => {
  test("host/project, agent, id and sender patterns", () => {
    expect(HOST_RE.source).toBe("^[A-Za-z0-9._-]{1,64}$");
    expect(AGENT_RE.source).toBe("^[A-Za-z0-9._@=/+-]{1,96}$");
    for (const ok of ["hosta", "sk-build-server", "A.b_c-1", "x".repeat(64)]) expect(HOST_RE.test(ok)).toBe(true);
    for (const bad of ["", "my host", "a|b", "x".repeat(65), "häst", "a/b", "a@b", "a\nb"]) expect(HOST_RE.test(bad)).toBe(false);
    for (const ok of ["claude", "claude@alice", "codex=1/x", "Agent01", "x".repeat(96)]) expect(AGENT_RE.test(ok)).toBe(true);
    for (const bad of ["", "Agent 01", "a|b", "x".repeat(97), "a:b"]) expect(AGENT_RE.test(bad)).toBe(false);
    expect(ID_RE.test("claude@alice-lk3j4h")).toBe(true);
    expect(ID_RE.test("a|b")).toBe(false);
    expect(SENDER_RE.test("@bot:srv.example:8448")).toBe(true);
    expect(SENDER_RE.test("@bad sender:srv")).toBe(false);
  });
});

describe("host labels are never redacted or collapsed", () => {
  test("a host named like a secret ('sk-...') binds, ingests and keeps its label verbatim", async () => {
    const b = await boot("sk-build-server");
    const res = await b.post("/api/ingest/snapshot", snapshot({ host: "sk-build-server" } as never, NOW));
    expect(res.status).toBe(200);
    expect(b.db.rows<any>("SELECT host FROM snapshots")).toEqual([{ host: "sk-build-server" }]);
    expect(b.db.rows<any>("SELECT host FROM hosts")).toEqual([{ host: "sk-build-server" }]);
    expect((await b.post("/api/ingest/heartbeat", { v: 1, host: "sk-build-server", at: NOW })).status).toBe(200);
  });

  test("two labels that the redactor would map to the same text stay two different hosts", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const a = await addSource(t.db, "sk-aaaaaaaaaa1", "host");
    const b = await addSource(t.db, "sk-aaaaaaaaaa2", "host");
    for (const [tok, host] of [[a, "sk-aaaaaaaaaa1"], [b, "sk-aaaaaaaaaa2"]] as const) {
      const res = await route(request("/api/ingest/snapshot", { token: tok, body: snapshot({ host } as never, NOW) }), t.env, ctx, { now: NOW });
      expect(res.status).toBe(200);
    }
    expect(t.db.rows<any>("SELECT host FROM hosts ORDER BY host")).toEqual([{ host: "sk-aaaaaaaaaa1" }, { host: "sk-aaaaaaaaaa2" }]);
    // and each token is still bound to its own label
    const cross = await route(request("/api/ingest/heartbeat", { token: a, body: { v: 1, host: "sk-aaaaaaaaaa2", at: NOW } }), t.env, ctx, { now: NOW });
    expect(cross.status).toBe(403);
  });

  test("free text keeps being clipped and redacted (only identifiers are exempt)", async () => {
    const b = await boot();
    await b.post("/api/ingest/snapshot", snapshot({ tasks: [{ id: "t1", agent: "a", title: "token=sk-live-abcdef0123456789", state: "running", dispatchedAt: NOW, updatedAt: NOW }] } as never, NOW));
    expect(b.db.rows<any>("SELECT title FROM tasks")).toEqual([{ title: "token=[redacted]" }]);
  });
});

describe("invalid identifiers are rejected with a clear 400 and nothing is written", () => {
  const cases: Array<[string, string, (host: string) => unknown, RegExp]> = [
    ["snapshot", "host with a space", () => snapshot({ host: "my host" } as never, NOW), /^host must match \^\[A-Za-z0-9\._-\]\{1,64\}\$ \(got 'my host'\)$/],
    ["snapshot", "project with |", (h) => snapshot({ host: h, project: "a|b" } as never, NOW), /^project must match /],
    ["snapshot", "project too long", (h) => snapshot({ host: h, project: "p".repeat(65) } as never, NOW), /^project must match /],
    ["events", "host", () => ev("my host", [halt()]), /^host must match /],
    ["heartbeat", "host", () => ({ v: 1, host: "a|b", at: NOW }), /^host must match /],
    ["heartbeat", "project", (h) => ({ v: 1, host: h, project: "a b", at: NOW }), /^project must match /],
  ];
  for (const [route_, name, body, message] of cases) {
    test(`${route_}: ${name}`, async () => {
      const b = await boot();
      const res = await b.post(`/api/ingest/${route_}`, body("hosta"));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
      expect(rowCount(b.db)).toBe(0);
    });
  }

  // Snapshot items are validated ITEM BY ITEM too: one bad identifier (an agent, a discussion participant, an
  // approval's agent...) used to 400 the whole snapshot and freeze the project on the dashboard. Now the bad
  // item (or just the bad field/name) is dropped and counted, everything else is stored, and only
  // host / project / v stay batch-level.
  const perSnapshotItem: Array<[string, (host: string) => unknown, RegExp, (stored: any, taskIds: string[]) => void]> = [
    ["agent name", (h) => snapshot({ host: h, agents: [{ name: "Agent 01", state: "idle" }, { name: "ok", state: "idle" }] } as never, NOW), /^agents\[0\]: name must match /,
      (s) => expect(s.agents.map((a: any) => a.name)).toEqual(["ok"])],
    ["second agent name", (h) => snapshot({ host: h, agents: [{ name: "ok", state: "idle" }, { name: "a|b", state: "idle" }] } as never, NOW), /^agents\[1\]: name must match /,
      (s) => expect(s.agents.map((a: any) => a.name)).toEqual(["ok"])],
    ["baseCli (field dropped, agent kept)", (h) => snapshot({ host: h, agents: [{ name: "a", baseCli: "claude code", state: "idle" }] } as never, NOW), /^baseCli: baseCli must match /,
      (s) => expect(s.agents).toEqual([{ name: "a", state: "idle" }])],
    ["task agent (task dropped)", (h) => snapshot({ host: h, tasks: [{ id: "t1", agent: "x y", title: "t", state: "running", dispatchedAt: 1, updatedAt: 1 }, { id: "t2", agent: "x", title: "t", state: "running", dispatchedAt: 1, updatedAt: 1 }] } as never, NOW), /^tasks\[0\]: agent must match /,
      (_s, ids) => expect(ids).toEqual(["t2"])],
    ["task id (task dropped)", (h) => snapshot({ host: h, tasks: [{ id: "a|b", agent: "x", title: "t", state: "running", dispatchedAt: 1, updatedAt: 1 }] } as never, NOW), /^tasks\[0\]: id must match /,
      (_s, ids) => expect(ids).toEqual([])],
    ["discussion participant (name dropped, discussion kept)", (h) => snapshot({ host: h, discussions: [{ id: "d1", topic: "t", status: "active", round: 1, maxRounds: 2, messages: 1, maxMessages: 2, participants: ["a", "b c", "d"], benched: ["e f"], updatedAt: 1 }] } as never, NOW), /^participants\[1\]: participants must match /,
      (s) => expect(s.discussions[0]).toMatchObject({ participants: ["a", "d"], benched: [] })],
    ["discussion id (discussion dropped)", (h) => snapshot({ host: h, discussions: [{ id: "d|1", topic: "t", status: "active", round: 1, maxRounds: 2, messages: 1, maxMessages: 2, participants: [], benched: [], updatedAt: 1 }] } as never, NOW), /^discussions\[0\]: id must match /,
      (s) => expect(s.discussions).toEqual([])],
    ["approval agent (approval kept, agent dropped)", (h) => snapshot({ host: h, approvals: [{ id: "ap", summary: "s", requestedAt: 1, agent: "a b" }] } as never, NOW), /^agent: agent must match /,
      (s) => expect(s.approvals).toEqual([{ id: "ap", summary: "s", requestedAt: 1 }])],
    ["currentTaskId (field dropped)", (h) => snapshot({ host: h, agents: [{ name: "a", state: "idle", currentTaskId: "x|y" }] } as never, NOW), /^currentTaskId: currentTaskId must match /,
      (s) => expect(s.agents).toEqual([{ name: "a", state: "idle" }])],
  ];
  for (const [name, body, message, check] of perSnapshotItem) {
    test(`snapshot: ${name} → 200 with dropped + firstError, the rest of the snapshot is stored`, async () => {
      const b = await boot();
      const res = await b.post("/api/ingest/snapshot", body("hosta"));
      expect(res.status).toBe(200);
      const j = (await res.json()) as { ok: boolean; dropped: number; firstError?: string };
      expect(j.ok).toBe(true);
      expect(j.dropped).toBeGreaterThanOrEqual(1);
      expect(j.firstError).toMatch(message);
      const stored = JSON.parse(b.db.rows<any>("SELECT json FROM snapshots")[0].json);
      expect(stored).not.toHaveProperty("tasks"); // the stored snapshot has no tasks: they are rows of the tasks table
      check(stored, b.db.rows<{ task_id: string }>("SELECT task_id FROM tasks ORDER BY task_id").map((r) => r.task_id));
      expect(b.db.rows("SELECT host FROM hosts")).toHaveLength(1);
    });
  }

  test("a snapshot with no bad item reports dropped: 0 and no firstError; host/project errors stay batch-level 400s", async () => {
    const b = await boot();
    const j = (await (await b.post("/api/ingest/snapshot", snapshot({ host: "hosta" } as never, NOW))).json()) as Record<string, unknown>;
    expect(j.dropped).toBe(0);
    expect(j).not.toHaveProperty("firstError");
    expect((await b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: "p q" } as never, NOW))).status).toBe(400);
  });

  test("the offending value echoed in a 400 never carries CR/LF or other control characters", async () => {
    const b = await boot();
    const res = await b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: "evil\r\nSet-Cookie: x=1\u0000\u001b[31m " } as never, NOW));
    expect(res.status).toBe(400);
    const msg = ((await res.json()) as { error: string }).error;
    expect(msg).toMatch(/^project must match /);
    expect(new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]").test(msg)).toBe(false);
    expect(msg).toContain("evil??Set-Cookie");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  // Event-level identifiers are validated per event: the bad event is dropped and counted (with the first
  // reason), the rest of the batch still lands — a whole-batch 400 would make the sender drop valid events too.
  const perEvent: Array<[string, (host: string) => unknown, RegExp, number]> = [
    ["event agent", (h) => ev(h, [halt(), halt({ key: "k2", agent: "a b" })]), /^events\[1\]: agent must match /, 1],
    ["scenario", (h) => ev(h, [halt({ scenario: "benched; drop" })]), /^events\[0\]: scenario must match /, 0],
    ["sender", (h) => ev(h, [halt({ kind: "status", origin: ORIGIN_RELAY, status: "BLOCKED", sender: "bad sender" })]), /^events\[0\]: sender must match /, 0],
    ["taskId", (h) => ev(h, [halt({ taskId: "a|b" })]), /^events\[0\]: taskId must match /, 0],
  ];
  for (const [name, body, message, kept] of perEvent) {
    test(`events: ${name} → that event is dropped (200, dropped: 1, firstError), the others land`, async () => {
      const b = await boot();
      const res = await b.post("/api/ingest/events", body("hosta"));
      expect(res.status).toBe(200);
      const j = (await res.json()) as { accepted: number; dropped: number; firstError?: string };
      expect(j).toMatchObject({ accepted: kept, dropped: 1 });
      expect(j.firstError).toMatch(message);
      expect(b.db.rows("SELECT key FROM events")).toHaveLength(kept);
    });
  }

  test("a valid-looking but different host label is still the 403 (binding), not the 400", async () => {
    const b = await boot();
    expect((await b.post("/api/ingest/snapshot", snapshot({ host: "other-host" } as never, NOW))).status).toBe(403);
  });
});

describe("valid special characters are accepted; agents are lower-cased, other identifiers kept raw", () => {
  test("relay/MCP style agents and chat senders", async () => {
    const b = await boot();
    const relay = halt({ kind: "status", origin: ORIGIN_RELAY, status: "BLOCKED", agent: "Claude@Alice", sender: "@Bot:Srv.Example:8448", taskId: "claude@alice-lk3j4h", scenario: undefined });
    const res = await b.post("/api/ingest/events", ev("hosta", [relay, halt({ key: "k3", agent: "Codex=1/X" })]));
    expect(res.status).toBe(200);
    expect(b.db.rows<any>("SELECT agent, sender FROM events ORDER BY key")).toEqual([
      { agent: "claude@alice", sender: "@Bot:Srv.Example:8448" },
      { agent: "codex=1/x", sender: null },
    ]);
    // the relay task row is keyed by the raw chat id
    expect(b.db.rows<any>("SELECT key, agent FROM tasks")).toEqual([{ key: "relay|hosta|proja|@Bot:Srv.Example:8448", agent: "claude@alice" }]);
  });
});

describe("agent names are case-insensitive end to end", () => {
  test("names are stored lower-case; a halt for 'Agent02' and a snapshot saying 'AGENT02' is idle agree", async () => {
    const b = await boot();
    const snap = (sentAt: number, state: string) => snapshot({ sentAt, agents: [{ name: "AGENT02", state }, { name: "Agent01", state: "working" }], tasks: [{ id: "T-1", agent: "AGENT01", title: "t", state: "running", dispatchedAt: NOW - 5000, updatedAt: NOW - 5000 }], discussions: [{ id: "d1", topic: "t", status: "active", round: 1, maxRounds: 2, messages: 1, maxMessages: 2, participants: ["Agent01", "AGENT02"], benched: ["Agent02"], lastSpeaker: "Agent01", updatedAt: NOW }] } as never, NOW);
    expect((await b.post("/api/ingest/snapshot", snap(NOW - 10_000, "benched"))).status).toBe(200);
    const stored = JSON.parse(b.db.rows<any>("SELECT json FROM snapshots")[0].json);
    expect(stored.agents.map((a: any) => a.name)).toEqual(["agent02", "agent01"]);
    expect(b.db.rows<any>("SELECT agent FROM tasks")[0].agent).toBe("agent01");
    expect(stored.discussions[0]).toMatchObject({ participants: ["agent01", "agent02"], benched: ["agent02"], lastSpeaker: "agent01" });
    expect(b.db.rows<any>("SELECT agent FROM tasks")).toEqual([{ agent: "agent01" }]);

    // halt for "Agent02" (mixed case) while the snapshot (older) shows it benched: stands
    const res = await b.post("/api/ingest/events", ev("hosta", [halt({ at: NOW - 1000, agent: "Agent02" })]));
    expect(await res.json()).toMatchObject({ alertsOpened: 1 });
    expect(b.db.rows<any>("SELECT key, agent FROM alerts")).toEqual([{ key: `agent-stuck|hosta|proja|agent02|benched`, agent: "agent02" }]);

    // a newer snapshot built after the halt shows AGENT02 idle: the alert resolves (case-insensitive match)
    const healthy = await b.post("/api/ingest/snapshot", snap(NOW - 500, "idle"));
    expect(await healthy.json()).toMatchObject({ alertsResolved: 1 });
    expect(b.db.rows<any>("SELECT resolved FROM alerts")[0].resolved).toBe(NOW);
  });
});
