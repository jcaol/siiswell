// Source isolation: a token can only ever write rows that belong to itself.
//  1. a host token is bound to ONE host label (its source name);
//  2. sender-chosen keys (events, tasks) cannot reach, shadow or suppress another source's rows;
//  3. an MCP client only touches rows owned by its own source.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { route } from "../src/index";
import { addSource, makeCtx, makeEnv, request, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const TABLES = ["sources", "snapshots", "hosts", "tasks", "events", "alerts", "push_subs"] as const;
/** Every row of every table, for before/after comparison ("nothing written"). */
function dump(db: D1Shim): string {
  // sources.last_seen is touched by authentication itself, which is not a data write
  return JSON.stringify(
    TABLES.map((t) => db.rows(`SELECT * FROM ${t} ORDER BY 1, 2`).map((r: any) => (t === "sources" ? { ...r, last_seen: 0 } : r))),
  );
}

async function boot() {
  const t = makeEnv();
  const ctx = makeCtx();
  const tokens = {
    hosta: await addSource(t.db, "hosta", "host"),
    evilhost: await addSource(t.db, "evilhost", "host"),
    codexA: await addSource(t.db, "codex-a", "client"),
    codexB: await addSource(t.db, "codex-b", "client"),
  };
  const call = (req: Request) => route(req, t.env, ctx, { now: NOW });
  const post = (path: string, token: string, body: unknown) => call(request(path, { token, body }));
  return { ...t, ctx, tokens, call, post };
}

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, agent: "Agent01", title: `task ${id}`, state: "running", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000, ...over,
});
const halt = (key: string, over: Record<string, unknown> = {}) => ({
  kind: "halt", origin: ORIGIN_HOST, at: NOW - 1000, severity: "critical", key, agent: "Agent02", scenario: "benched", text: "Agent02 benched", ...over,
});
const events = (host: string, evs: unknown[], project = "proja") => ({ v: 1, host, project, events: evs });

/** hosta has a snapshot with tasks and an approval, a stale host row with an open host-offline alert, and an event. */
async function seedHostA(b: Awaited<ReturnType<typeof boot>>) {
  const snap = snapshot({ host: "hosta", tasks: [task("t1"), task("t2")], approvals: [{ id: "ap1", summary: "x", requestedAt: NOW - 10 * MIN }] } as never, NOW);
  expect((await b.post("/api/ingest/snapshot", b.tokens.hosta, snap)).status).toBe(200);
  expect((await b.post("/api/ingest/events", b.tokens.hosta, events("hosta", [halt("hk-1")]))).status).toBe(200);
  // make the host look dead and give it an open host-offline alert
  b.db.sqlite.query("UPDATE hosts SET last_seen = ? WHERE host = 'hosta'").run(NOW - 20 * MIN);
  b.db.sqlite
    .query("INSERT INTO alerts (key, rule, severity, host, text, opened, push_count) VALUES ('host-offline|hosta', 'host-offline', 'critical', 'hosta', 'silent', ?, 1)")
    .run(NOW - 10 * MIN);
}

describe("1. a host token is bound to its host label", () => {
  test("another host's token cannot overwrite, delete, take over or resolve anything of hosta; the request is 403 and nothing is written", async () => {
    const b = await boot();
    await seedHostA(b);
    const before = dump(b.db);
    const expected = { error: "host label 'hosta' does not match this token" };

    // overwrite the snapshot and delete its tasks (an empty task list would wipe hosta|proja tasks)
    let res = await b.post("/api/ingest/snapshot", b.tokens.evilhost, snapshot({ host: "hosta", tasks: [] } as never, NOW));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(expected);
    // inject events (and relay task rows) as hosta
    res = await b.post("/api/ingest/events", b.tokens.evilhost, events("hosta", [halt("evil-1"), { ...halt("evil-2"), kind: "status", origin: ORIGIN_RELAY, status: "BLOCKED", sender: "@x:y", scenario: undefined }]));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(expected);
    // take over the hosts row / resolve its host-offline alert with a fake heartbeat
    res = await b.post("/api/ingest/heartbeat", b.tokens.evilhost, { v: 1, host: "hosta", at: NOW, binaryVersion: "evil-9" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(expected);

    expect(dump(b.db)).toBe(before);
    expect(b.db.rows("SELECT resolved FROM alerts WHERE key = 'host-offline|hosta'")).toEqual([{ resolved: null }]);
    expect(b.db.rows("SELECT task_id FROM tasks WHERE host = 'hosta' ORDER BY task_id")).toEqual([{ task_id: "t1" }, { task_id: "t2" }]);
  });

  test("the label is compared case-sensitively and as a raw value, and an invalid or missing host is a 400", async () => {
    const b = await boot();
    const snapWith = (host: string) => snapshot({ host } as never, NOW);
    expect((await b.post("/api/ingest/snapshot", b.tokens.hosta, snapWith("HOSTA"))).status).toBe(403);
    expect((await b.post("/api/ingest/snapshot", b.tokens.hosta, snapWith("hosta|x"))).status).toBe(400); // not an identifier at all
    expect((await b.post("/api/ingest/snapshot", b.tokens.hosta, snapWith("hosta-2"))).status).toBe(403);
    expect((await b.post("/api/ingest/snapshot", b.tokens.hosta, snapWith("  hosta  "))).status).toBe(400); // compared raw: no trimming, no rewriting
    expect((await b.post("/api/ingest/snapshot", b.tokens.hosta, snapWith("hosta"))).status).toBe(200);
    expect((await b.post("/api/ingest/snapshot", b.tokens.hosta, { ...snapWith("hosta"), host: undefined })).status).toBe(400);
    expect(b.db.rows("SELECT host FROM snapshots")).toEqual([{ host: "hosta" }]);
    const res = await b.post("/api/ingest/heartbeat", b.tokens.hosta, { v: 1, host: "Hosta", at: NOW });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host label 'Hosta' does not match this token" });
  });

  test("a host token writing under its OWN label cannot disturb another host with the same project name", async () => {
    const b = await boot();
    await seedHostA(b);
    const hostaRows = () => JSON.stringify([b.db.rows("SELECT * FROM snapshots WHERE host = 'hosta'"), b.db.rows("SELECT * FROM tasks WHERE host = 'hosta'"), b.db.rows("SELECT * FROM hosts WHERE host = 'hosta'"), b.db.rows("SELECT * FROM alerts WHERE host = 'hosta'")]);
    const before = hostaRows();
    // same project name "proja", same task ids, empty list (would wipe hosta|proja tasks if scoping were by project only)
    expect((await b.post("/api/ingest/snapshot", b.tokens.evilhost, snapshot({ host: "evilhost", tasks: [task("t1")] } as never, NOW))).status).toBe(200);
    expect((await b.post("/api/ingest/snapshot", b.tokens.evilhost, snapshot({ host: "evilhost", tasks: [] } as never, NOW))).status).toBe(200);
    expect((await b.post("/api/ingest/events", b.tokens.evilhost, events("evilhost", [halt("hk-1")]))).status).toBe(200);
    expect((await b.post("/api/ingest/heartbeat", b.tokens.evilhost, { v: 1, host: "evilhost", at: NOW })).status).toBe(200);
    // hosta' rows are untouched except for rule evaluation (alerts of hosta may only be opened/resolved by hosta' own conditions)
    expect(JSON.parse(hostaRows())[0]).toEqual(JSON.parse(before)[0]); // snapshot
    expect(JSON.parse(hostaRows())[1]).toEqual(JSON.parse(before)[1]); // tasks
    expect(JSON.parse(hostaRows())[2]).toEqual(JSON.parse(before)[2]); // hosts
    expect(b.db.rows("SELECT resolved FROM alerts WHERE key = 'host-offline|hosta'")).toEqual([{ resolved: null }]);
    // evilhost's own rows carry its own label everywhere
    expect(b.db.rows("SELECT DISTINCT host FROM events WHERE source_id = 'src-evilhost'")).toEqual([{ host: "evilhost" }]);
    expect(b.db.rows<any>("SELECT host, source_id FROM hosts ORDER BY host")).toEqual([
      { host: "evilhost", source_id: "src-evilhost" },
      { host: "hosta", source_id: "src-hosta" },
    ]);
  });

  test("a heartbeat only resolves the host-offline alert of the token's own host", async () => {
    const b = await boot();
    await seedHostA(b);
    b.db.sqlite.query("INSERT INTO alerts (key, rule, severity, host, text, opened, push_count) VALUES ('host-offline|evilhost', 'host-offline', 'critical', 'evilhost', 'silent', ?, 1)").run(NOW - MIN);
    expect((await b.post("/api/ingest/heartbeat", b.tokens.evilhost, { v: 1, host: "evilhost", at: NOW })).status).toBe(200);
    const rows = b.db.rows<any>("SELECT key, resolved FROM alerts WHERE rule = 'host-offline' ORDER BY key");
    expect(rows).toEqual([{ key: "host-offline|evilhost", resolved: NOW }, { key: "host-offline|hosta", resolved: null }]);
  });

  test("client tokens still cannot use ingest at all", async () => {
    const b = await boot();
    const res = await b.post("/api/ingest/heartbeat", b.tokens.codexA, { v: 1, host: "codex-a", at: NOW });
    expect(res.status).toBe(403);
    expect(b.db.rows("SELECT * FROM hosts")).toEqual([]);
  });
});

describe("2. sender-chosen keys are scoped to their source", () => {
  test("two sources with the same event key both land, and a pre-inserted key cannot suppress the real event", async () => {
    const b = await boot();
    // evilhost guesses the key hosta will use for its real halt event and posts it first
    expect((await b.post("/api/ingest/events", b.tokens.evilhost, events("evilhost", [halt("$chat-event-id-123", { text: "decoy" })]))).status).toBe(200);
    const res = await b.post("/api/ingest/events", b.tokens.hosta, events("hosta", [halt("$chat-event-id-123", { text: "the real halt" })]));
    expect(await res.json()).toMatchObject({ accepted: 1, alertsOpened: 1 });
    const rows = b.db.rows<any>("SELECT source_id, key, host, text FROM events ORDER BY source_id");
    expect(rows).toEqual([
      { source_id: "src-evilhost", key: "$chat-event-id-123", host: "evilhost", text: "decoy" },
      { source_id: "src-hosta", key: "$chat-event-id-123", host: "hosta", text: "the real halt" },
    ]);
    // the real event still opens hosta' alert
    expect(b.db.rows<any>("SELECT key FROM alerts WHERE host = 'hosta'").map((a) => a.key)).toEqual([`agent-stuck|hosta|proja|agent02|benched`]);
    // a source's own replay is still deduplicated
    await b.post("/api/ingest/events", b.tokens.hosta, events("hosta", [halt("$chat-event-id-123", { text: "again" })]));
    expect(b.db.rows("SELECT * FROM events WHERE source_id = 'src-hosta'")).toHaveLength(1);
  });

  test("the events primary key is (source_id, key)", async () => {
    const { db } = await boot();
    const pk = db.rows<{ name: string; pk: number }>("SELECT name, pk FROM pragma_table_info('events') WHERE pk > 0 ORDER BY pk");
    expect(pk).toEqual([{ name: "source_id", pk: 1 }, { name: "key", pk: 2 }]);
  });

  test("a snapshot cannot overwrite another origin's task by choosing its key (host labelled like an origin prefix)", async () => {
    const b = await boot();
    const mcpToken = await addSource(b.db, "mcp", "host"); // a host whose label equals the MCP key prefix
    const reported = await b.call(request("/mcp", { token: b.tokens.codexA, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_task", arguments: { project: "web", title: "victim", status: "IN_PROGRESS" } } } }));
    const taskId = JSON.parse((await reported.json()).result.content[0].text).task_id as string;
    const victimKey = `mcp|codex-a|${taskId}`;
    const victimBefore = JSON.stringify(b.db.rows("SELECT * FROM tasks WHERE key = ?", victimKey));
    expect(JSON.parse(victimBefore)).toHaveLength(1);

    // host "mcp", project "codex-a", task id = the victim's id: its host agent key would be `mcp|codex-a|<id>`
    const res = await b.post("/api/ingest/snapshot", mcpToken, snapshot({ host: "mcp", project: "codex-a", tasks: [task(taskId, { title: "hijacked", state: "done" })] } as never, NOW));
    expect(res.status).toBe(200);
    expect(JSON.stringify(b.db.rows("SELECT * FROM tasks WHERE key = ?", victimKey))).toBe(victimBefore);
    // and an empty snapshot from that host does not delete the victim either
    await b.post("/api/ingest/snapshot", mcpToken, snapshot({ host: "mcp", project: "codex-a", tasks: [] } as never, NOW));
    expect(JSON.stringify(b.db.rows("SELECT * FROM tasks WHERE key = ?", victimKey))).toBe(victimBefore);
  });

  test("relay STATUS events land in a row of the sending host only, and never overwrite a row of another origin or host", async () => {
    const b = await boot();
    const relayEvent = { kind: "status", origin: ORIGIN_RELAY, at: NOW - 100, severity: "info", key: "r1", agent: "Bot", sender: "@bot:srv", status: "BLOCKED", text: "STATUS: BLOCKED" };
    // The same foreign agent seen by two hosts: one row per host, each owned by its own token.
    expect((await b.post("/api/ingest/events", b.tokens.hosta, events("hosta", [relayEvent]))).status).toBe(200);
    expect((await b.post("/api/ingest/events", b.tokens.evilhost, events("evilhost", [{ ...relayEvent, status: "DONE", at: NOW - 50 }]))).status).toBe(200);
    expect(b.db.rows<any>("SELECT key, source_id, state FROM tasks WHERE origin = '" + ORIGIN_RELAY + "' ORDER BY key")).toEqual([
      { key: "relay|evilhost|proja|@bot:srv", source_id: "src-evilhost", state: "done" },
      { key: "relay|hosta|proja|@bot:srv", source_id: "src-hosta", state: "blocked" },
    ]);
    // Defence in depth: a row with the same key but another origin is never overwritten by a relay upsert.
    b.db.sqlite
      .query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES ('relay|hosta|other|@bot:srv', 'src-codex-a', 'mcp', 'codex-a', 'x', 'A', 'm-1', 'victim', 'running', 1, 1)")
      .run();
    await b.post("/api/ingest/events", b.tokens.hosta, events("hosta", [{ ...relayEvent, key: "r2", status: "DONE" }], "other"));
    expect(b.db.rows<any>("SELECT title, state, origin FROM tasks WHERE key = 'relay|hosta|other|@bot:srv'")).toEqual([{ title: "victim", state: "running", origin: "mcp" }]);
  });
});


describe("3. an MCP client only touches rows owned by its own source", () => {
  const rpcCall = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  test("report_task keys and events are source-scoped, task ids are generated by the Worker, and extra key/task_id arguments are ignored", async () => {
    const b = await boot();
    const mcp = (token: string, body: unknown) => b.call(request("/mcp", { token, body })).then((r) => r.json() as Promise<any>);
    const a = JSON.parse((await mcp(b.tokens.codexA, rpcCall("report_task", { project: "web", title: "A's task", status: "IN_PROGRESS" }))).result.content[0].text);

    // B tries to overwrite A's task by supplying A's key / id when reporting
    const attempt = await mcp(b.tokens.codexB, rpcCall("report_task", { project: "web", title: "B hijack", status: "DONE", task_id: a.task_id, key: `mcp|codex-a|${a.task_id}`, source_id: "src-codex-a" }));
    const bId = JSON.parse(attempt.result.content[0].text).task_id as string;
    expect(bId).not.toBe(a.task_id);

    const rows = b.db.rows<any>("SELECT key, source_id, host, title, state FROM tasks ORDER BY key");
    expect(rows).toEqual([
      { key: `mcp|codex-a|${a.task_id}`, source_id: "src-codex-a", host: "codex-a", title: "A's task", state: "running" },
      { key: `mcp|codex-b|${bId}`, source_id: "src-codex-b", host: "codex-b", title: "B hijack", state: "done" },
    ]);

    // B cannot update, finish or even probe A's task
    const upd = await mcp(b.tokens.codexB, rpcCall("update_task", { task_id: a.task_id, status: "DONE", summary: "pwned" }));
    expect(upd.result.isError).toBe(true);
    expect(b.db.rows<any>("SELECT state, last_line FROM tasks WHERE task_id = ?", a.task_id)).toEqual([{ state: "running", last_line: null }]);

    // events are written under the calling source, with the token-bound host
    const ev = b.db.rows<any>("SELECT source_id, host FROM events ORDER BY source_id");
    expect(ev).toEqual([{ source_id: "src-codex-a", host: "codex-a" }, { source_id: "src-codex-b", host: "codex-b" }]);
  });

  test("the alert a client opens is keyed by the client's own name, so another client cannot resolve or shadow it", async () => {
    const b = await boot();
    const mcp = (token: string, body: unknown) => b.call(request("/mcp", { token, body })).then((r) => r.json() as Promise<any>);
    const a = JSON.parse((await mcp(b.tokens.codexA, rpcCall("report_task", { project: "web", title: "stuck", status: "BLOCKED" }))).result.content[0].text);
    const key = `blocked|codex-a|web|${a.task_id}`;
    expect(b.db.rows<any>("SELECT key, resolved FROM alerts")).toEqual([{ key, resolved: null }]);
    // B reports the same project with a blocked task and finishes its own: A's alert stays open
    const bt = JSON.parse((await mcp(b.tokens.codexB, rpcCall("report_task", { project: "web", title: "other", status: "BLOCKED" }))).result.content[0].text);
    await mcp(b.tokens.codexB, rpcCall("update_task", { task_id: bt.task_id, status: "DONE" }));
    await mcp(b.tokens.codexB, rpcCall("update_task", { task_id: a.task_id, status: "DONE" })); // rejected
    expect(b.db.rows<any>("SELECT key, resolved FROM alerts ORDER BY key").find((r) => r.key === key)?.resolved).toBeNull();
  });

  test("heartbeat only touches the caller's own source row", async () => {
    const b = await boot();
    const hb = await b.call(request("/mcp", { token: b.tokens.codexA, body: rpcCall("heartbeat", { project: "codex-b" }) }));
    expect(hb.status).toBe(200);
    const seen = b.db.rows<any>("SELECT name, last_seen FROM sources ORDER BY name");
    expect(seen.find((s) => s.name === "codex-a")?.last_seen).toBe(NOW);
    expect(seen.find((s) => s.name === "codex-b")?.last_seen).toBeNull();
  });
});
