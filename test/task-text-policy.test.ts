import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "../src/index";
import { RELAY_LABEL, STUCK_LABEL, LIMIT_LABEL } from "../src/shared/labels";
import { buildState } from "../src/state";
import { applyTaskText } from "../src/shared/tasktext";
import { HOOK_MARK, HOOK_TITLES } from "../src/shared/hook";
import { ORIGIN_RELAY } from "../src/shared/wire";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";
import type { Env } from "../src/env";

const NOW = 1_800_000_000_000;
const TYPED = "typed reply about invoice 4411";

async function boot(over: Partial<Env> = {}) {
  const t = makeEnv(over);
  const ctx = makeCtx();
  const hostToken = await addSource(t.db, "hosta", "host");
  const clientToken = await addSource(t.db, "client1", "client");
  const post = (path: string, body: unknown, token: string) => route(request(path, { body, token }), t.env, ctx, { now: NOW });
  const mcp = async (name: string, args: unknown) => {
    const r = await route(request("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token: clientToken, headers: { Accept: "application/json, text/event-stream" } }), t.env, ctx, { now: NOW });
    return (await r.json()) as any;
  };
  return { ...t, hostToken, clientToken, post, mcp };
}
const relayBatch = () => ({
  v: 1, host: "hosta", project: "proja",
  events: [{ kind: "status", origin: ORIGIN_RELAY, at: NOW - 1000, severity: "info", key: "s1", agent: "Bot1", sender: "@bot1:srv", status: "IN_PROGRESS", text: TYPED }],
});
const dump = (db: any) => JSON.stringify([db.rows?.("SELECT title, last_line FROM tasks") ?? [], db.rows?.("SELECT text FROM events") ?? []]);

describe("H1: relay status events", () => {
  for (const [label, setting, kept] of [["off (default)", undefined, false], ["ACCEPT_LAST_LINE=1", "1", true]] as const) {
    test(`${label}: ${kept ? "text kept" : "fixed label only"}`, async () => {
      const b = await boot({ ACCEPT_LAST_LINE: setting });
      const res = await b.post("/api/ingest/events", relayBatch(), b.hostToken);
      expect(res.status).toBe(200);
      const task = b.db.sqlite.query("SELECT title, last_line FROM tasks WHERE origin = ?").get(ORIGIN_RELAY) as any;
      const ev = b.db.sqlite.query("SELECT text FROM events").get() as any;
      if (kept) {
        expect(task.last_line).toBe(TYPED);
        expect(ev.text).toBe(TYPED);
      } else {
        expect(task).toEqual({ title: RELAY_LABEL, last_line: null });
        expect(ev.text).toBe(RELAY_LABEL);
        expect(JSON.stringify([task, ev])).not.toContain("4411");
      }
    });
  }
});

describe("H2: stored last_line is never read without ACCEPT_LAST_LINE=1", () => {
  const seed = (db: any, line: string) =>
    db.sqlite.run("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated) VALUES ('k','s','host','hosta','proja','a','t','T','running',NULL,?,?,?)", [line, NOW - 5000, NOW - 1000]);
  test("buildState", async () => {
    const b = await boot();
    seed(b.db, TYPED);
    const off = await buildState(b.env.DB, NOW);
    expect(off.tasks[0]?.lastLine).toBeNull();
    expect(JSON.stringify(off)).not.toContain("4411");
    expect((await buildState(b.env.DB, NOW, true)).tasks[0]?.lastLine).toBe(TYPED);
  });
  test("migration 0012 clears typed text, keeps the fixed hook lines", () => {
    const sql = readFileSync(join(import.meta.dir, "..", "migrations", "0012_clear_last_line.sql"), "utf8");
    expect(sql).toContain(HOOK_MARK);
  });
  test("migration 0012 applied to an existing row", async () => {
    const b = await boot();
    seed(b.db, TYPED);
    b.db.sqlite.run("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, last_line, created, updated) VALUES ('k2','s','mcp','h','p','a','t2','T','blocked',?,1,1)", [HOOK_MARK]);
    b.db.sqlite.exec(readFileSync(join(import.meta.dir, "..", "migrations", "0012_clear_last_line.sql"), "utf8"));
    const rows = b.db.sqlite.query("SELECT key, last_line FROM tasks ORDER BY key").all() as any[];
    expect(rows).toEqual([{ key: "k", last_line: null }, { key: "k2", last_line: HOOK_MARK }]);
  });
});

describe("M1/M2: server ACCEPT_TASK_TEXT is the ceiling; unknown keys are dropped", () => {
  const report = { project: "proja", title: TYPED, status: "IN_PROGRESS", summary: TYPED };
  const stored = (b: any) => b.db.sqlite.query("SELECT title, last_line FROM tasks WHERE origin = 'mcp'").get() as any;
  test("default is brief: the title is kept (clipped), the summary is not; a client that sends full text cannot exceed it", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: undefined });
    const r = await b.mcp("report_task", report);
    expect(r.result.isError).toBeUndefined();
    expect(stored(b)).toEqual({ title: TYPED, last_line: null });
    const id = JSON.parse(r.result.content[0].text).task_id;
    await b.mcp("update_task", { task_id: id, status: "DONE", summary: TYPED });
    expect(JSON.stringify(b.db.sqlite.query("SELECT text FROM events").all())).not.toContain(` - ${TYPED}`);
    expect(stored(b).last_line).toBeNull();
  });
  test("minimal: a generic title and no summary", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "minimal" });
    await b.mcp("report_task", report);
    expect(stored(b)).toEqual({ title: "Task", last_line: null });
  });
  test("minimal keeps the hook's fixed titles and mark", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "minimal" });
    await b.mcp("report_task", { project: "proja", title: HOOK_TITLES[0], status: "BLOCKED", summary: HOOK_MARK });
    expect(stored(b)).toEqual({ title: HOOK_TITLES[0], last_line: HOOK_MARK });
  });
  test("none: neutral placeholder, no summary", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "none" });
    await b.mcp("report_task", { ...report, title: HOOK_TITLES[0], summary: HOOK_MARK });
    expect(stored(b)).toEqual({ title: "Task", last_line: null });
  });
  test("full: operator's choice, text kept", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "full" });
    await b.mcp("report_task", report);
    expect(stored(b)).toEqual({ title: TYPED, last_line: TYPED });
  });
  test("an invalid value falls back to brief", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "everything" });
    await b.mcp("report_task", report);
    expect(stored(b)).toEqual({ title: TYPED, last_line: null });
  });
  test("unknown argument keys are ignored (never stored), in every mode", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "full" });
    const r = await b.mcp("report_task", { ...report, prompt: "secret prompt 7788", extra: { a: 1 } });
    expect(r.result.isError).toBeUndefined();
    const all = JSON.stringify([b.db.sqlite.query("SELECT * FROM tasks").all(), b.db.sqlite.query("SELECT * FROM events").all()]);
    expect(all).not.toContain("7788");
  });
});

describe("M3: tool-name case variants", () => {
  test("server rejects a case variant as an unknown tool and stores nothing", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "full" });
    const r = await b.mcp("Report_Task", { project: "proja", title: TYPED, status: "IN_PROGRESS" });
    expect(r.error).toBeDefined();
    expect(b.db.sqlite.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  });
  test("the client policy matches case-insensitively", () => {
    expect(applyTaskText("Report_Task", { project: "p", status: "DONE", title: TYPED }, "minimal")).toEqual({ project: "p", status: "DONE", title: "Task" });
    expect(applyTaskText("UPDATE_TASK", { task_id: "m-1", status: "DONE", summary: TYPED }, "none")).toEqual({ task_id: "m-1", status: "DONE" });
  });
});

describe("H3: host halt events and migration 0012", () => {
  const halt = (key: string, scenario: string) => ({ kind: "halt", origin: "host", at: NOW - 1000, severity: "warn", key, agent: "Bot1", scenario, text: TYPED });
  const batch = { v: 1, host: "hosta", project: "proja", events: [halt("h1", "wedged"), halt("h2", "usage-limit")] };
  for (const [label, setting] of [["off (default)", undefined], ["ACCEPT_LAST_LINE=1", "1"]] as const) {
    test(`${label}`, async () => {
      const b = await boot({ ACCEPT_LAST_LINE: setting });
      expect((await b.post("/api/ingest/events", batch, b.hostToken)).status).toBe(200);
      const ev = Object.fromEntries((b.db.sqlite.query("SELECT key, text FROM events").all() as any[]).map((r) => [r.key, r.text]));
      const al = (b.db.sqlite.query("SELECT text FROM alerts").all() as any[]).map((r) => r.text).join("|");
      if (setting) {
        expect(ev).toEqual({ h1: TYPED, h2: TYPED });
      } else {
        expect(ev).toEqual({ h1: STUCK_LABEL, h2: LIMIT_LABEL });
        expect(al).not.toContain("4411");
        expect(al).toContain(LIMIT_LABEL);
      }
    });
  }

  test("migration 0012 relabels events and resolves open text-derived alerts, keeps fixed hook lines", async () => {
    const b = await boot();
    const q = b.db.sqlite;
    const ev = (k: string, kind: string, origin: string, scen: string | null) =>
      q.run("INSERT INTO events (source_id, key, host, project, kind, origin, scenario, severity, text, at, received_at) VALUES ('s',?,'h','p',?,?,?,'info',?,1,1)", [k, kind, origin, scen, TYPED]);
    ev("e1", "status", "relay", null); ev("e2", "halt", "host", "usage-limit"); ev("e3", "halt", "host", "wedged"); ev("e4", "lifecycle", "host", null);
    const al = (k: string, rule: string) => q.run("INSERT INTO alerts (key, rule, severity, origin, text, opened) VALUES (?,?,'warn','host',?,1)", [k, rule, TYPED]);
    al("a1", "blocked"); al("a2", "agent-stuck"); al("a3", "usage-limit"); al("a4", "overdue");
    q.run("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, last_line, created, updated) VALUES ('t1','s','host','h','p','a','t','T','running','reported by the siiswell hook',1,1)");
    q.exec(readFileSync(join(import.meta.dir, "..", "migrations", "0012_clear_last_line.sql"), "utf8"));
    const texts = Object.fromEntries((q.query("SELECT key, text FROM events").all() as any[]).map((r) => [r.key, r.text]));
    expect(texts).toEqual({ e1: RELAY_LABEL, e2: LIMIT_LABEL, e3: STUCK_LABEL, e4: TYPED });
    const res = Object.fromEntries((q.query("SELECT key, resolved IS NOT NULL AS r FROM alerts").all() as any[]).map((r) => [r.key, r.r]));
    expect(res).toEqual({ a1: 1, a2: 1, a3: 1, a4: 0 });
    expect((q.query("SELECT last_line FROM tasks").get() as any).last_line).toBe(HOOK_MARK);
  });
});
