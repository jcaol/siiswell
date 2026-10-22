import { describe, expect, test } from "bun:test";
import { MAX_TEXT, MAX_TITLE } from "../src/shared/schema";
import { route } from "../src/index";
import { SQL_RULE_SNAPSHOTS } from "../src/alerts";
import { MAX_MCP_MUTATIONS_PER_DAY, MAX_OPEN_MCP_TASKS } from "../src/env";
import { FALLBACK_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS, MAX_BATCH_MESSAGES, SUPPORTED_PROTOCOL_VERSIONS, INSERT_CAPPED_TASK, insertCappedTaskSql } from "../src/mcp";
import { SQL_CLAIM_MUTATIONS } from "../src/budget";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

const NOW = 1_800_000_000_000;

async function boot() {
  const t = makeEnv();
  const ctx = makeCtx();
  const token = await addSource(t.db, "client1", "client");
  const other = await addSource(t.db, "gemini-mac", "client");
  const host = await addSource(t.db, "hosta", "host");
  const send = (body: unknown, opts: { token?: string; headers?: Record<string, string>; method?: string; rawBody?: string; now?: number } = {}) =>
    route(
      request("/mcp", { method: opts.method ?? "POST", body: opts.rawBody === undefined ? body : undefined, rawBody: opts.rawBody, token: opts.token ?? token, headers: { Accept: "application/json, text/event-stream", ...(opts.headers ?? {}) } }),
      t.env,
      ctx,
      { now: opts.now ?? NOW },
    );
  return { ...t, ctx, token, other, host, send };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown, id = 1) => rpc("tools/call", { name, arguments: args }, id);

async function result(res: Response): Promise<any> {
  expect(res.headers.get("content-type")).toContain("application/json");
  return res.json();
}
const toolText = (r: any): any => JSON.parse(r.result.content[0].text);

describe("transport rules", () => {
  test("initialize negotiates the client's version when we support it, else falls back", async () => {
    const { send } = await boot();
    for (const v of LEGACY_PROTOCOL_VERSIONS) {
      const r = await result(await send(rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } })));
      expect(r.result.protocolVersion).toBe(v);
    }
    for (const v of ["1999-01-01", undefined, 7]) {
      const r = await result(await send(rpc("initialize", { protocolVersion: v })));
      expect(r.result.protocolVersion).toBe(FALLBACK_PROTOCOL_VERSION);
    }
    const r = await result(await send(rpc("initialize", { protocolVersion: "2025-11-25" }, "abc")));
    expect(r).toMatchObject({ jsonrpc: "2.0", id: "abc" });
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.serverInfo).toMatchObject({ name: "siiswell" });
    expect(r.result.instructions).toContain("10 minutes");
    expect(r.result.instructions).toContain("Never put the prompt text");
    expect(r.result).not.toHaveProperty("resultType"); // legacy era
  });

  test("the server is stateless: no session id is ever issued and tools work without initialize", async () => {
    const { send } = await boot();
    const init = await send(rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect((await send(rpc("tools/list"), { headers: { "Mcp-Session-Id": "bogus" } })).status).toBe(200);
  });

  test("notifications and client responses get 202 with an empty body", async () => {
    const { send } = await boot();
    for (const msg of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      { jsonrpc: "2.0", id: 5, result: {} },
    ]) {
      const res = await send(msg);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    }
  });

  test("GET and DELETE are 405 (no SSE stream, no sessions)", async () => {
    const { send } = await boot();
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await send(undefined, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  test("ping answers {}", async () => {
    const { send } = await boot();
    expect((await result(await send(rpc("ping")))).result).toEqual({});
  });

  test("a batch is answered with an array; notifications inside are skipped; an all-notification batch is 202", async () => {
    const { send } = await boot();
    const res = await send([rpc("initialize", { protocolVersion: "2025-03-26" }, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("tools/list", undefined, 2)]);
    const body = await result(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r: any) => r.id)).toEqual([1, 2]);
    expect(body[1].result.tools).toHaveLength(5);
    const quiet = await send([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(quiet.status).toBe(202);
    expect((await send([])).status).toBe(400);
  });

  test("parse errors, invalid requests, unknown methods", async () => {
    const { send } = await boot();
    const parse = await send(undefined, { rawBody: "{not json" });
    expect(parse.status).toBe(400);
    expect((await parse.json()).error.code).toBe(-32700);
    const invalid = await result(await send({ jsonrpc: "1.0", id: 1, method: "ping" }));
    expect(invalid.error.code).toBe(-32600);
    const unknown = await send(rpc("resources/list"));
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).error.code).toBe(-32601);
    expect((await send(7)).status).toBe(400);
  });

  test("oversize bodies are refused", async () => {
    const { send } = await boot();
    expect((await send(undefined, { rawBody: JSON.stringify(rpc("ping", { pad: "x".repeat(70_000) })) })).status).toBe(413);
  });

  test("Origin must be ours when present; unknown MCP-Protocol-Version is a 400", async () => {
    const { send } = await boot();
    expect((await send(rpc("ping"), { headers: { Origin: "https://evil.example.com" } })).status).toBe(403);
    expect((await send(rpc("ping"), { headers: { Origin: "http://localhost:8787" } })).status).toBe(200);
    expect((await send(rpc("ping"), { headers: { Origin: "https://dash.test" } })).status).toBe(200);
    for (const v of LEGACY_PROTOCOL_VERSIONS) {
      expect((await send(rpc("tools/list"), { headers: { "MCP-Protocol-Version": v } })).status).toBe(200);
    }
    const bad = await send(rpc("tools/list"), { headers: { "MCP-Protocol-Version": "1999-01-01" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.data.supported).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
  });

  test("tokens: none -> 401, host token -> 403, revoked -> 401", async () => {
    const { send, host, db } = await boot();
    const dead = await addSource(db, "dead", "client", { revoked: true });
    expect((await send(rpc("ping"), { token: "oct_nonexistent0000" })).status).toBe(401);
    expect((await send(rpc("ping"), { token: host })).status).toBe(403);
    expect((await send(rpc("ping"), { token: dead })).status).toBe(401);
    const noAuth = await route(request("/mcp", { body: rpc("ping") }), makeEnv().env, makeCtx(), { now: NOW });
    expect(noAuth.status).toBe(401);
  });
});

describe("tools/list", () => {
  test("four tools with JSON Schema input matching the contract", async () => {
    const { send } = await boot();
    const { result: r } = await result(await send(rpc("tools/list")));
    expect(r.tools.map((t: any) => t.name)).toEqual(["report_task", "update_task", "heartbeat", "list_tasks", "operator_status"]);
    const [report, update, heartbeat] = r.tools;
    expect(report.inputSchema.type).toBe("object");
    expect(report.inputSchema.required).toEqual(["project", "title", "kind", "status"]);
    expect(Object.keys(report.inputSchema.properties).sort()).toEqual(["agent", "client_ref", "eta_min", "kind", "machine", "project", "status", "summary", "title"]);
    expect(report.inputSchema.properties.status.enum).toEqual(["IN_PROGRESS", "BLOCKED", "DONE"]);
    expect(report.inputSchema.properties.title.maxLength).toBe(MAX_TITLE);
    expect(report.inputSchema.properties.summary.maxLength).toBe(MAX_TEXT);
    expect(update.inputSchema.required).toEqual(["task_id", "status"]);
    expect(Object.keys(update.inputSchema.properties).sort()).toEqual(["eta_min", "kind", "status", "summary", "task_id"]);
    expect(heartbeat.inputSchema.required).toBeUndefined();
    expect(Object.keys(heartbeat.inputSchema.properties)).toEqual(["project"]);
    for (const t of r.tools) {
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("report_task / update_task", () => {
  test("report_task creates a running task with an m- id, an ETA and an mcp event", async () => {
    const { send, db } = await boot();
    const r = await result(await send(call("report_task", { project: "web", title: "migrate the db", status: "IN_PROGRESS", eta_min: 30, summary: "starting" })));
    const out = toolText(r);
    expect(out.task_id).toMatch(/^m-[0-9a-z]{8}$/);
    expect(out.state).toBe("running");
    expect(r.result.isError).toBeUndefined();
    const t = db.rows<any>("SELECT * FROM tasks")[0];
    expect(t).toMatchObject({
      key: `mcp|client1|${out.task_id}`, origin: "mcp", host: "client1", project: "web", agent: "agent@client1",
      title: "migrate the db", state: "running", eta_at: NOW + 30 * 60_000, last_line: "starting", created: NOW, updated: NOW,
    });
    const e = db.rows<any>("SELECT * FROM events")[0];
    expect(e).toMatchObject({ kind: "status", origin: "mcp", host: "client1", project: "web", status: "IN_PROGRESS", at: NOW });
    expect(e.text).toContain("migrate the db");
  });

  test("client_ref makes report_task idempotent per client; calls without it are unaffected", async () => {
    const { send, db, other } = await boot();
    const args = { project: "web", title: "waiting", status: "BLOCKED", client_ref: "0123456789abcdef" };
    const a = toolText(await result(await send(call("report_task", args))));
    const b = toolText(await result(await send(call("report_task", args))));
    expect(b).toEqual({ task_id: a.task_id, state: "blocked", repeated: true });
    expect(db.rows<any>("SELECT task_id, client_ref FROM tasks")).toEqual([{ task_id: a.task_id, client_ref: "0123456789abcdef" }]);
    // another client with the same ref gets its own task; no ref -> a new task every time
    const c = toolText(await result(await send(call("report_task", args), { token: other })));
    expect(c.task_id).not.toBe(a.task_id);
    const { client_ref: _, ...plain } = args;
    const d = toolText(await result(await send(call("report_task", plain))));
    const e = toolText(await result(await send(call("report_task", plain))));
    expect(new Set([a.task_id, d.task_id, e.task_id]).size).toBe(3);
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM tasks")[0].n).toBe(4);
    const bad = await result(await send(call("report_task", { ...args, client_ref: "x" })));
    expect(bad.result.isError).toBe(true);
  });

  test("client_ref is stored by the task's own INSERT; concurrent repeats make one task; a database without 0010 still stores the task", async () => {
    const { send, db } = await boot();
    expect(insertCappedTaskSql(true, true)).toContain("updated, machine, client_ref)");
    expect(insertCappedTaskSql(false, true)).toContain("?11, ?12, ?16");
    expect(insertCappedTaskSql(false, false)).toBe(INSERT_CAPPED_TASK);
    // the builder edits INSERT_CAPPED_TASK by text: if that text ever changes, the ref must not silently drop out
    for (const m of [false, true]) {
      expect(insertCappedTaskSql(m, true)).toContain("?16");
      expect(insertCappedTaskSql(m, true)).toContain("client_ref)");
    }
    expect(insertCappedTaskSql(true, false)).toContain("?15");
    const args = { project: "web", title: "waiting", status: "BLOCKED", client_ref: "fedcba9876543210", machine: "mac" };
    const [a, b, c] = (await Promise.all([1, 2, 3].map(() => send(call("report_task", args))))).map(async (r) => toolText(await result(r)));
    const ids = new Set([(await a).task_id, (await b).task_id, (await c).task_id]);
    expect(ids.size).toBe(1);
    expect(db.rows<any>("SELECT client_ref, machine FROM tasks")).toEqual([{ client_ref: "fedcba9876543210", machine: "mac" }]);
    db.sqlite.run("DROP INDEX idx_tasks_client_ref");
    db.sqlite.run("ALTER TABLE tasks DROP COLUMN client_ref");
    const d = toolText(await result(await send(call("report_task", { ...args, client_ref: "0000111122223333" }))));
    expect(d.task_id).toMatch(/^m-/);
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM tasks")[0].n).toBe(2);
  });

  test("status mapping: BLOCKED -> blocked (and an alert), DONE -> done; agent override", async () => {
    const { send, db } = await boot();
    const blocked = toolText(await result(await send(call("report_task", { project: "web", title: "t1", status: "BLOCKED", agent: "Codex-Desktop" }))));
    expect(blocked.state).toBe("blocked");
    expect(db.rows<any>("SELECT agent FROM tasks WHERE task_id = ?", blocked.task_id)[0].agent).toBe("codex-desktop@client1");
    expect(db.rows<any>("SELECT key, rule FROM alerts")).toEqual([{ key: `blocked|client1|web|${blocked.task_id}`, rule: "blocked" }]);
    const done = toolText(await result(await send(call("report_task", { project: "web", title: "t2", status: "DONE" }))));
    expect(done.state).toBe("done");
    const lowercase = toolText(await result(await send(call("report_task", { project: "web", title: "t3", status: "in progress" }))));
    expect(lowercase.state).toBe("running");
  });

  test("update_task changes state, writes an event, resolves the blocked alert; IN_PROGRESS without eta_min clears the ETA", async () => {
    const { send, db } = await boot();
    const { task_id } = toolText(await result(await send(call("report_task", { project: "web", title: "t", status: "BLOCKED", eta_min: 5 }))));
    expect(db.rows("SELECT * FROM alerts WHERE resolved IS NULL")).toHaveLength(1);
    const up = await result(await send(call("update_task", { task_id, status: "IN_PROGRESS", eta_min: 45, summary: "unblocked" })));
    expect(toolText(up)).toEqual({ task_id, state: "running" });
    expect(db.rows<any>("SELECT state, eta_at, last_line FROM tasks")[0]).toEqual({ state: "running", eta_at: NOW + 45 * 60_000, last_line: "unblocked" });
    expect(db.rows("SELECT * FROM alerts WHERE resolved IS NULL")).toHaveLength(0);
    await send(call("update_task", { task_id, status: "IN_PROGRESS" }));
    expect(db.rows<any>("SELECT eta_at, last_line FROM tasks")[0]).toEqual({ eta_at: null, last_line: "unblocked" });
    await send(call("update_task", { task_id, status: "DONE", summary: "all good" }));
    expect(db.rows<any>("SELECT state, last_line FROM tasks")[0]).toEqual({ state: "done", last_line: "all good" });
    expect(db.rows("SELECT * FROM events WHERE origin = 'mcp'")).toHaveLength(4);
  });

  test("update of another source's task is rejected (and changes nothing)", async () => {
    const { send, db, other } = await boot();
    const { task_id } = toolText(await result(await send(call("report_task", { project: "web", title: "mine", status: "IN_PROGRESS" }))));
    const r = await result(await send(call("update_task", { task_id, status: "DONE" }), { token: other }));
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("unknown task_id");
    expect(db.rows<any>("SELECT state FROM tasks")[0].state).toBe("running");
    // an id that never existed gives the same answer
    const nope = await result(await send(call("update_task", { task_id: "m-zzzzzzzz", status: "DONE" })));
    expect(nope.result.isError).toBe(true);
    // a task_id that tries to smuggle a different source into the key
    const smuggle = await result(await send(call("update_task", { task_id: `${task_id}`, status: "DONE" }), { token: other }));
    expect(smuggle.result.isError).toBe(true);
  });

  test("summaries and titles are clipped and redacted before they are stored", async () => {
    const { send, db } = await boot();
    await send(call("report_task", { project: "p", title: `deploy Bearer abcdefghijklmnop ${"t".repeat(300)}`, status: "IN_PROGRESS", summary: `password=hunter2hunter2 ${"s".repeat(500)}` }));
    const t = db.rows<any>("SELECT title, last_line FROM tasks")[0];
    expect(t.title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(t.title).toContain("Bearer [redacted]");
    expect(t.last_line.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(t.last_line).toContain("password=[redacted]");
    expect(JSON.stringify(db.rows("SELECT text FROM events"))).not.toContain("hunter2");
  });

  test("bad input is a tool result with isError, not a JSON-RPC error", async () => {
    const { send, db } = await boot();
    const bad: unknown[] = [
      {},
      { project: "p", title: "t" },
      { project: "p", title: "t", status: "WORKING" },
      { project: "", title: "t", status: "DONE" },
      { project: "p", title: "   ", status: "DONE" },
      { project: "p", title: 12, status: "DONE" },
      { project: "p", title: "t", status: "DONE", eta_min: -3 },
      { project: "p", title: "t", status: "DONE", eta_min: "soon" },
      { project: "p", title: "t", status: "DONE", eta_min: 999999 },
      { project: "p", title: "t", status: "DONE", summary: { a: 1 } },
      { project: "p", title: "t", status: "DONE", agent: 5 },
    ];
    for (const args of bad) {
      const res = await send(call("report_task", args));
      expect(res.status).toBe(200);
      const r = await res.json();
      expect(r.error).toBeUndefined();
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].type).toBe("text");
    }
    for (const args of [{}, { task_id: "m-1" }, { task_id: "m-1", status: "NOPE" }, { status: "DONE" }, "string", null]) {
      const r = await result(await send(call("update_task", args)));
      expect(r.result.isError).toBe(true);
    }
    expect((await result(await send(call("report_task", "oops")))).result.isError).toBe(true);
    expect(db.rows("SELECT * FROM tasks")).toHaveLength(0);
  });

  test("unknown tool name is a JSON-RPC error (-32602)", async () => {
    const { send } = await boot();
    const r = await result(await send(call("delete_everything", {})));
    expect(r.error.code).toBe(-32602);
    const noName = await result(await send(rpc("tools/call", {})));
    expect(noName.error.code).toBe(-32602);
  });

  test("heartbeat touches last_seen and accepts no arguments", async () => {
    const { send, db } = await boot();
    const r = await result(await send(call("heartbeat", {})));
    expect(r.result.content[0].text).toBe("ok");
    expect(db.rows<any>("SELECT last_seen FROM sources WHERE name = 'client1'")[0].last_seen).toBe(NOW);
    expect((await result(await send(call("heartbeat", undefined)))).result.isError).toBeUndefined();
    expect((await result(await send(call("heartbeat", { project: 3 })))).result.isError).toBe(true);
  });
});

describe("protocol 2026-07-28 (stateless, no handshake)", () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
  const modernHeaders = (method: string, name?: string, version = "2026-07-28") => ({
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": name } : {}),
  });

  test("server/discover lists supported versions, instructions and serverInfo meta", async () => {
    const { send } = await boot();
    const r = await result(await send(rpc("server/discover", { _meta: meta }), { headers: modernHeaders("server/discover") }));
    expect(r.result.resultType).toBe("complete");
    expect(r.result.supportedVersions).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(r.result.supportedVersions).toContain("2026-07-28");
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("siiswell");
  });

  test("tools/list and tools/call work with per-request metadata and validated headers", async () => {
    const { send, db } = await boot();
    const list = await result(await send(rpc("tools/list", { _meta: meta }), { headers: modernHeaders("tools/list") }));
    expect(list.result.resultType).toBe("complete");
    expect(list.result.tools).toHaveLength(5);
    const res = await send(rpc("tools/call", { name: "report_task", arguments: { project: "p", title: "t", status: "IN_PROGRESS" }, _meta: meta }), {
      headers: modernHeaders("tools/call", "report_task"),
    });
    const r = await result(res);
    expect(r.result.resultType).toBe("complete");
    expect(toolText(r).state).toBe("running");
    expect(db.rows("SELECT * FROM tasks")).toHaveLength(1);
  });

  test("header / body mismatches are 400 with -32020", async () => {
    const { send } = await boot();
    const check = async (headers: Record<string, string>, body: unknown = rpc("tools/list", { _meta: meta })) => {
      const res = await send(body, { headers });
      expect(res.status).toBe(400);
      return (await res.json()).error.code;
    };
    expect(await check({ "Mcp-Method": "tools/list" })).toBe(-32020); // protocol version header missing
    expect(await check({ "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/list" })).toBe(-32020);
    expect(await check({ "MCP-Protocol-Version": "2026-07-28" })).toBe(-32020); // Mcp-Method missing
    expect(await check({ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" })).toBe(-32020);
    const callBody = rpc("tools/call", { name: "heartbeat", arguments: {}, _meta: meta });
    expect(await check(modernHeaders("tools/call"), callBody)).toBe(-32020); // Mcp-Name missing
    expect(await check(modernHeaders("tools/call", "report_task"), callBody)).toBe(-32020); // Mcp-Name mismatch
    const encoded = `=?base64?${btoa("heartbeat")}?=`;
    expect((await send(callBody, { headers: modernHeaders("tools/call", encoded) })).status).toBe(200);
  });

  test("missing per-request metadata is 400 -32602; an unsupported version is 400 -32022 with the supported list", async () => {
    const { send } = await boot();
    const noCaps = await send(rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }), { headers: modernHeaders("tools/list") });
    expect(noCaps.status).toBe(400);
    expect((await noCaps.json()).error.code).toBe(-32602);
    const future = await send(rpc("tools/list", { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2031-01-01" } }), { headers: modernHeaders("tools/list", undefined, "2031-01-01") });
    expect(future.status).toBe(400);
    const body = await future.json();
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toEqual({ supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: "2031-01-01" });
  });

  test("unknown methods are 404 -32601 and there is no initialize in the modern era", async () => {
    const { send } = await boot();
    const unknown = await send(rpc("resources/list", { _meta: meta }), { headers: modernHeaders("resources/list") });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe(-32601);
    const init = await send(rpc("initialize", { _meta: meta, protocolVersion: "2026-07-28" }), { headers: modernHeaders("initialize") });
    expect(init.status).toBe(404);
  });

  test("notifications are still 202", async () => {
    const { send } = await boot();
    const res = await send({ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: meta } }, { headers: { "MCP-Protocol-Version": "2026-07-28" } });
    expect(res.status).toBe(202);
  });
});

describe("identifiers are validated, never rewritten", () => {
  test("project and agent must match their character sets; an identifier that looks like a secret is kept verbatim", async () => {
    const { send, db } = await boot();
    for (const args of [
      { project: "my project", title: "t", status: "DONE" },
      { project: "a|b", title: "t", status: "DONE" },
      { project: "x".repeat(65), title: "t", status: "DONE" },
      { project: 7, title: "t", status: "DONE" },
      { project: "p", title: "t", status: "DONE", agent: "Codex Desktop" },
      { project: "p", title: "t", status: "DONE", agent: "a@b" }, // the Worker appends @<client> itself
      { project: "p", title: "t", status: "DONE", agent: "x".repeat(32) },
    ]) {
      const r = await result(await send(call("report_task", args)));
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/^(project|agent) must match /);
    }
    const bad = await result(await send(call("update_task", { task_id: "m|1", status: "DONE" })));
    expect(bad.result.content[0].text).toMatch(/^task_id must match /);
    expect((await result(await send(call("heartbeat", { project: "a b" })))).result.isError).toBe(true);
    expect(db.rows("SELECT * FROM tasks")).toEqual([]);

    // `sk-` / `ghp_` look like secrets to the redactor, but identifiers are not redacted or collapsed
    const ok = await result(await send(call("report_task", { project: "sk-build-server", title: "t", status: "IN_PROGRESS", agent: "ghp_AbCdEfGh1234" })));
    expect(ok.result.isError).toBeUndefined();
    expect(db.rows<any>("SELECT project, agent FROM tasks")).toEqual([{ project: "sk-build-server", agent: "ghp_abcdefgh1234@client1" }]);
  });
});

describe("a desktop client cannot pose as a host-agent agent", () => {
  test("agents are stored as <agent>@<client> (default agent 'agent') and alerts say 'via <client>'", async () => {
    const { send, db } = await boot();
    // a prompt-injected client tries to produce "proja: claude blocked"
    const r = await result(await send(call("report_task", { project: "proja", title: "needs you", status: "BLOCKED", agent: "Claude" })));
    const { task_id } = toolText(r);
    expect(db.rows<any>("SELECT project, agent FROM tasks")).toEqual([{ project: "proja", agent: "claude@client1" }]);
    const alert = db.rows<any>("SELECT key, origin, host, project, agent, text FROM alerts")[0];
    expect(alert).toEqual({
      key: `blocked|client1|proja|${task_id}`, origin: "mcp", host: "client1", project: "proja", agent: "claude@client1", text: "proja@client1: Blocked: needs you · via client1",
    });
    const dflt = toolText(await result(await send(call("report_task", { project: "proja", title: "x", status: "IN_PROGRESS" }))));
    expect(db.rows<any>("SELECT agent FROM tasks WHERE task_id = ?", dflt.task_id)).toEqual([{ agent: "agent@client1" }]);
    expect(db.rows<any>("SELECT agent FROM events WHERE origin = 'mcp'").every((e) => e.agent.endsWith("@client1"))).toBe(true);
  });

  test("the inbox exposes the origin so the UI can badge it", async () => {
    const t = await boot();
    await t.send(call("report_task", { project: "proja", title: "x", status: "BLOCKED" }));
    const res = await route(request("/api/state"), t.env, makeCtx(), { now: NOW });
    const inbox = ((await res.json()) as any).inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ origin: "mcp", host: "client1" });
    expect(inbox[0].text).toBe("proja@client1: Blocked: x · via client1");
  });
});

describe("per-client caps", () => {
  test(`at most ${MAX_OPEN_MCP_TASKS} open tasks per client; DONE reports and other clients are unaffected`, async () => {
    const { send, other } = await boot();
    for (let i = 0; i < MAX_OPEN_MCP_TASKS; i++) {
      const r = await result(await send(call("report_task", { project: "p", title: `t${i}`, status: "IN_PROGRESS" })));
      expect(r.result.isError).toBeUndefined();
    }
    const over = await result(await send(call("report_task", { project: "p", title: "one too many", status: "IN_PROGRESS" })));
    expect(over.result.isError).toBe(true);
    expect(over.result.content[0].text).toContain(`too many open tasks for this client (max ${MAX_OPEN_MCP_TASKS})`);
    // a DONE report is not an open task
    expect((await result(await send(call("report_task", { project: "p", title: "done already", status: "DONE" })))).result.isError).toBeUndefined();
    // another client has its own budget
    expect((await result(await send(call("report_task", { project: "p", title: "mine", status: "IN_PROGRESS" }), { token: other }))).result.isError).toBeUndefined();
  });

  test("finishing a task frees its slot", async () => {
    const { send, db } = await boot();
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_MCP_TASKS; i++) ids.push(toolText(await result(await send(call("report_task", { project: "p", title: `t${i}`, status: "IN_PROGRESS" })))).task_id);
    expect((await result(await send(call("report_task", { project: "p", title: "x", status: "IN_PROGRESS" })))).result.isError).toBe(true);
    await send(call("update_task", { task_id: ids[0], status: "DONE" }));
    expect((await result(await send(call("report_task", { project: "p", title: "x", status: "IN_PROGRESS" })))).result.isError).toBeUndefined();
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM tasks WHERE state = 'running'")[0].n).toBe(MAX_OPEN_MCP_TASKS);
  });
});

describe("batches", () => {
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

  test(`at most ${MAX_BATCH_MESSAGES} messages per batch`, async () => {
    const { send } = await boot();
    const msgs = (n: number) => Array.from({ length: n }, (_, i) => rpc("ping", undefined, i + 1));
    const ok = await send(msgs(MAX_BATCH_MESSAGES));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveLength(MAX_BATCH_MESSAGES);
    const big = await send(msgs(MAX_BATCH_MESSAGES + 1));
    expect(big.status).toBe(400);
    const body = (await big.json()) as any;
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain(`max ${MAX_BATCH_MESSAGES}`);
  });

  test("the alert rules run once per HTTP request, however many tools wrote (and not at all if none did)", async () => {
    const t = countingEnv();
    const ctx = makeCtx();
    const token = await addSource(t.db, "client1", "client");
    const post = (body: unknown) => route(request("/mcp", { token, body }), t.env, ctx, { now: NOW });
    await post(rpc("tools/list"));
    await post(call("heartbeat", {}));
    expect(t.evaluations()).toBe(0);
    await post(call("report_task", { project: "p", title: "one", status: "BLOCKED" }));
    expect(t.evaluations()).toBe(1);
    const batch = Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) => call("report_task", { project: "p", title: `b${i}`, status: "BLOCKED" }, i + 1));
    const res = await post(batch);
    expect(res.status).toBe(200);
    expect(t.evaluations()).toBe(2); // one more for the whole batch
    expect(t.db.rows("SELECT * FROM alerts WHERE resolved IS NULL")).toHaveLength(MAX_BATCH_MESSAGES + 1); // and every alert still opened
  });
});

describe("closed MCP tasks are immutable (the open-task cap cannot be bypassed)", () => {
  test("the exact bypass: fill the cap, report DONE, then move it back to IN_PROGRESS -> rejected", async () => {
    const { send, db } = await boot();
    for (let i = 0; i < MAX_OPEN_MCP_TASKS; i++) await send(call("report_task", { project: "p", title: `t${i}`, status: "IN_PROGRESS" }));
    expect((await result(await send(call("report_task", { project: "p", title: "over", status: "IN_PROGRESS" })))).result.isError).toBe(true); // cap holds
    const done = toolText(await result(await send(call("report_task", { project: "p", title: "closed", status: "DONE" })))); // a DONE report is allowed ...
    const events = db.rows<any>("SELECT COUNT(*) AS n FROM events")[0].n;
    for (const status of ["IN_PROGRESS", "BLOCKED"]) {
      const r = await result(await send(call("update_task", { task_id: done.task_id, status, eta_min: 30, summary: "reopen" }))); // ... re-opening it is not
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toBe("task is closed; report a new task");
    }
    expect(db.rows<any>("SELECT state, last_line FROM tasks WHERE task_id = ?", done.task_id)).toEqual([{ state: "done", last_line: null }]);
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('running', 'blocked')")[0].n).toBe(MAX_OPEN_MCP_TASKS); // still exactly the cap
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM events")[0].n).toBe(events); // rejected updates write nothing
  });

  test("a task finished with update_task is closed too; so is DONE -> DONE and every failed / skipped row", async () => {
    const { send, db } = await boot();
    const { task_id } = toolText(await result(await send(call("report_task", { project: "p", title: "t", status: "IN_PROGRESS" }))));
    expect((await result(await send(call("update_task", { task_id, status: "DONE", summary: "finished" })))).result.isError).toBeUndefined();
    for (const status of ["DONE", "BLOCKED", "IN_PROGRESS"]) {
      const r = await result(await send(call("update_task", { task_id, status })));
      expect(r.result.content[0].text).toBe("task is closed; report a new task");
    }
    for (const state of ["failed", "skipped"]) {
      db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 'src-client1', 'mcp', 'client1', 'p', 'a', ?, 't', ?, 1, 1)").run(`mcp|client1|m-${state}`, `m-${state}`, state);
      expect((await result(await send(call("update_task", { task_id: `m-${state}`, status: "IN_PROGRESS" })))).result.content[0].text).toBe("task is closed; report a new task");
    }
    expect(db.rows<any>("SELECT state, last_line FROM tasks WHERE task_id = ?", task_id)).toEqual([{ state: "done", last_line: "finished" }]);
  });

  test("open tasks still move freely between running and blocked", async () => {
    const { send } = await boot();
    const { task_id } = toolText(await result(await send(call("report_task", { project: "p", title: "t", status: "IN_PROGRESS" }))));
    expect((await result(await send(call("update_task", { task_id, status: "BLOCKED" }))) ).result.isError).toBeUndefined();
    expect((await result(await send(call("update_task", { task_id, status: "IN_PROGRESS", eta_min: 10 })))).result.isError).toBeUndefined();
  });
});

describe("an update that changes nothing writes nothing", () => {
  const writes = (db: { rows: <T>(sql: string) => T[] }) => ({
    tasks: db.rows<any>("SELECT updated, state, eta_at, last_line FROM tasks"),
    events: db.rows<any>("SELECT COUNT(*) AS n FROM events")[0].n,
  });

  test("same state, same ETA minute, no new summary -> current state back, no task write, no event, no rule run", async () => {
    const t = await boot();
    const { send, db } = t;
    const { task_id } = toolText(await result(await send(call("report_task", { project: "p", title: "t", status: "IN_PROGRESS", eta_min: 30, summary: "starting" }))));
    const before = writes(db);

    // exactly the same call, a few seconds later (the ETA moves by seconds: same minute bucket)
    for (const [dt, args] of [
      [5_000, { task_id, status: "IN_PROGRESS", eta_min: 30 }],
      [9_000, { task_id, status: "IN_PROGRESS", eta_min: 30, summary: "starting" }],
      [20_000, { task_id, status: "IN_PROGRESS", eta_min: 30 }],
    ] as const) {
      const r = await result(await send(call("update_task", args), { now: NOW + dt }));
      expect(r.result.isError).toBeUndefined();
      expect(toolText(r)).toEqual({ task_id, state: "running", unchanged: true });
    }
    expect(writes(db)).toEqual(before);
  });

  test("any real change writes: state, summary, ETA minute, clearing the ETA", async () => {
    const { send, db } = await boot();
    const { task_id } = toolText(await result(await send(call("report_task", { project: "p", title: "t", status: "IN_PROGRESS", eta_min: 30, summary: "s" }))));
    let events = writes(db).events;
    const changed = async (args: Record<string, unknown>, dt: number) => {
      const r = await result(await send(call("update_task", { task_id, ...args }), { now: NOW + dt }));
      expect(toolText(r).unchanged).toBeUndefined();
      expect(writes(db).events).toBe(++events);
    };
    await changed({ status: "IN_PROGRESS", eta_min: 30, summary: "new text" }, 5_000); // new summary
    await changed({ status: "IN_PROGRESS", eta_min: 45 }, 6_000); // a different ETA
    await changed({ status: "IN_PROGRESS" }, 7_000); // ETA cleared
    await changed({ status: "BLOCKED" }, 8_000); // state
    expect(db.rows<any>("SELECT state, last_line FROM tasks")).toEqual([{ state: "blocked", last_line: "new text" }]);
    // restating the same state afterwards is a no-op again
    const again = await result(await send(call("update_task", { task_id, status: "BLOCKED" }), { now: NOW + 9_000 }));
    expect(toolText(again)).toEqual({ task_id, state: "blocked", unchanged: true });
  });

  test("no-op updates are free: they do not count towards the budget either", async () => {
    const { send, db } = await boot();
    const { task_id } = toolText(await result(await send(call("report_task", { project: "p", title: "t", status: "IN_PROGRESS", eta_min: 30 }))));
    for (let i = 0; i < 200; i++) await send(call("update_task", { task_id, status: "IN_PROGRESS", eta_min: 30 }), { now: NOW + 1000 + i });
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM events")[0].n).toBe(1);
  });
});


describe(`per-client mutation budget: ${MAX_MCP_MUTATIONS_PER_DAY} per fixed 24 h window (an O(1) counter on the source row)`, () => {
  const DAY = 86_400_000;
  const counters = (db: any, name = "client1") => db.rows("SELECT mut_window_start AS w, mut_count AS n FROM sources WHERE name = ?", name)[0] as { w: number; n: number };
  const setCounters = (db: any, n: number, windowStart: number, name = "client1") =>
    db.sqlite.query("UPDATE sources SET mut_count = ?, mut_window_start = ? WHERE name = ?").run(n, windowStart, name);
  const report = (send: any, title = "x", status = "IN_PROGRESS", opts: any = {}) => send(call("report_task", { project: "p", title, status }), opts);

  test("each changing call claims one: the window starts at the first, the count follows; no-ops, tools/list and heartbeat claim nothing", async () => {
    const { send, db } = await boot();
    expect(counters(db)).toEqual({ w: 0, n: 0 });
    const { task_id } = toolText(await result(await report(send, "t", "IN_PROGRESS")));
    expect(counters(db)).toEqual({ w: NOW, n: 1 });
    await send(call("update_task", { task_id, status: "BLOCKED" }), { now: NOW + 5000 });
    expect(counters(db)).toEqual({ w: NOW, n: 2 }); // same window
    await send(call("update_task", { task_id, status: "BLOCKED" }), { now: NOW + 6000 }); // unchanged
    await send(call("heartbeat", {}), { now: NOW + 7000 });
    await send(rpc("tools/list"), { now: NOW + 8000 });
    expect(counters(db)).toEqual({ w: NOW, n: 2 });
    await report(send, "done already", "DONE"); // DONE reports claim too
    expect(counters(db)).toEqual({ w: NOW, n: 3 });
  });

  test("under the budget works; at the budget report_task and update_task are isError with a clear message and change nothing", async () => {
    const { send, db } = await boot();
    const { task_id } = toolText(await result(await report(send, "t")));
    setCounters(db, MAX_MCP_MUTATIONS_PER_DAY - 1, NOW);
    expect((await result(await send(call("update_task", { task_id, status: "BLOCKED" })))).result.isError).toBeUndefined(); // the 1000th
    expect(counters(db).n).toBe(MAX_MCP_MUTATIONS_PER_DAY);
    for (const r of [await result(await report(send, "one more")), await result(await send(call("update_task", { task_id, status: "IN_PROGRESS" })))]) {
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain(`at most ${MAX_MCP_MUTATIONS_PER_DAY}`);
      expect(r.result.content[0].text).toContain("24-hour window");
    }
    expect(counters(db).n).toBe(MAX_MCP_MUTATIONS_PER_DAY); // rejected calls do not even count
    expect(db.rows<any>("SELECT state FROM tasks")).toEqual([{ state: "blocked" }]);
    // heartbeat and an unchanged update still answer
    expect((await result(await send(call("heartbeat", {})))).result.isError).toBeUndefined();
    expect(toolText(await result(await send(call("update_task", { task_id, status: "BLOCKED" })))).unchanged).toBe(true);
  });

  test("an exhausted budget costs one primary-key lookup and writes nothing: no COUNT, no task or event insert, no rules", async () => {
    const { send, db } = await boot();
    setCounters(db, MAX_MCP_MUTATIONS_PER_DAY, NOW - 60_000);
    // The FIRST refusal of a window is recorded (budget_until) and shows up as a budget-exhausted inbox item.
    expect((await result(await report(send, "first refusal"))).result.isError).toBe(true);
    expect(db.rows<any>("SELECT key, rule, severity, origin FROM alerts")).toEqual([{ key: "budget-exhausted|client1", rule: "budget-exhausted", severity: "warn", origin: "mcp" }]);
    const dump = () => JSON.stringify(["tasks", "events", "alerts", "hosts"].map((t) => db.rows(`SELECT * FROM ${t}`)));
    const before = dump();
    for (const _ of [1, 2, 3]) {
      db.statements.length = 0;
      const r = await result(await report(send, "retry loop"));
      expect(r.result.isError).toBe(true);
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const issued = db.statements.map(norm);
      // the token lookup (auth), at most the throttled last_seen touch, the single claim and ONE read of the
      // window start (for the flag): nothing else, no write
      expect(issued.filter((s) => !/^SELECT \* FROM sources WHERE token_sha256/.test(s) && !/^UPDATE sources SET last_seen/.test(s))).toEqual([norm(SQL_CLAIM_MUTATIONS), "SELECT mut_window_start AS w FROM sources WHERE id = ?"]);
      expect(issued.some((s) => /COUNT\(\*\)|INSERT|FROM tasks|FROM events|FROM snapshots/i.test(s))).toBe(false);
    }
    expect(dump()).toBe(before);
    // and the claim is a primary-key search on `sources`, so it reads that one row (EXPLAIN QUERY PLAN)
    const plan = (db.sqlite.query(`EXPLAIN QUERY PLAN ${SQL_CLAIM_MUTATIONS}`).all("src-client1", NOW, DAY, MAX_MCP_MUTATIONS_PER_DAY, 1) as Array<{ detail: string }>).map((r) => r.detail);
    expect(plan).toEqual(["SEARCH sources USING INDEX sqlite_autoindex_sources_1 (id=?)"]);
  });

  test("the window is fixed: 24 h minus 1 ms is still blocked, at 24 h it restarts with the count at 1", async () => {
    const { send, db } = await boot();
    setCounters(db, MAX_MCP_MUTATIONS_PER_DAY, NOW);
    expect((await result(await report(send, "x", "IN_PROGRESS", { now: NOW + DAY - 1 }))).result.isError).toBe(true);
    expect(counters(db)).toEqual({ w: NOW, n: MAX_MCP_MUTATIONS_PER_DAY });
    const r = await result(await report(send, "x", "IN_PROGRESS", { now: NOW + DAY }));
    expect(r.result.isError).toBeUndefined();
    expect(counters(db)).toEqual({ w: NOW + DAY, n: 1 });
    // a late first call after a long idle period simply starts a new window at that call
    setCounters(db, 5, NOW + DAY);
    await report(send, "y", "IN_PROGRESS", { now: NOW + 10 * DAY });
    expect(counters(db)).toEqual({ w: NOW + 10 * DAY, n: 1 });
  });

  test("other clients are unaffected: every source row has its own counter", async () => {
    const { send, db, other } = await boot();
    setCounters(db, MAX_MCP_MUTATIONS_PER_DAY, NOW);
    expect((await result(await report(send))).result.isError).toBe(true);
    expect((await result(await report(send, "mine", "IN_PROGRESS", { token: other }))).result.isError).toBeUndefined();
    expect(counters(db, "gemini-mac")).toEqual({ w: NOW, n: 1 });
    expect(counters(db)).toEqual({ w: NOW, n: MAX_MCP_MUTATIONS_PER_DAY });
  });

  test("DONE reports count, so the budget cannot be dodged through them", async () => {
    const { send, db } = await boot();
    setCounters(db, MAX_MCP_MUTATIONS_PER_DAY - 1, NOW);
    expect((await result(await report(send, "closed one", "DONE"))).result.isError).toBeUndefined();
    const r = await result(await report(send, "closed two", "DONE"));
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("mutation budget exhausted");
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM tasks")[0].n).toBe(1);
  });

  test("two concurrent claims at count = cap - 1: exactly one wins (the check and the increment are one statement)", async () => {
    const { send, db } = await boot();
    setCounters(db, MAX_MCP_MUTATIONS_PER_DAY - 1, NOW);
    const results = await Promise.all([report(send, "a"), report(send, "b"), report(send, "c")].map((p) => p.then(result)));
    expect(results.filter((r: any) => !r.result.isError)).toHaveLength(1);
    expect(results.filter((r: any) => r.result.isError)).toHaveLength(2);
    expect(counters(db).n).toBe(MAX_MCP_MUTATIONS_PER_DAY);
    expect(db.rows<any>("SELECT COUNT(*) AS n FROM tasks")[0].n).toBe(1);
    // the same at the SQL level: N parallel claims against count = cap - 1 change exactly one row
    setCounters(db, MAX_MCP_MUTATIONS_PER_DAY - 1, NOW);
    const claims = await Promise.all(Array.from({ length: 8 }, () => (db as any).prepare(SQL_CLAIM_MUTATIONS).bind("src-client1", NOW + 1, DAY, MAX_MCP_MUTATIONS_PER_DAY, 1).run()));
    expect(claims.filter((c: any) => c.meta.changes === 1)).toHaveLength(1);
  });

  test("a write that fails after a successful claim still counts (open-task cap)", async () => {
    const { send, db } = await boot();
    for (let i = 0; i < MAX_OPEN_MCP_TASKS; i++) await report(send, `t${i}`);
    const before = counters(db).n;
    const r = await result(await report(send, "over the open cap"));
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("too many open tasks");
    expect(counters(db).n).toBe(before + 1);
  });
});
