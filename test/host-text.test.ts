import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../src/index";
import { applyMigrations } from "../src/server/d1-sqlite";
import { hostTaskTitle, hostTextMode } from "../src/shared/hosttext";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";
import type { Env } from "../src/env";

const NOW = 1_800_000_000_000;
const PROMPT = "please rewrite the invoice export for the quarterly review";
const SUMMARY = "run the cleanup script on the shared drive";
const TOPIC = "should we change the pricing of the premium plan next quarter";
const EVTEXT = "operator typed this sentence about the release";

async function boot(over: Partial<Env> = {}, sourceText?: string) {
  const t = makeEnv({ ACCEPT_HOST_TEXT: undefined, ...over });
  const ctx = makeCtx();
  const token = await addSource(t.db, "hosta", "host");
  if (sourceText) t.db.sqlite.query("UPDATE sources SET task_text = ? WHERE name = 'hosta'").run(sourceText);
  const call = (req: Request) => route(req, t.env, ctx, { now: NOW });
  const push = async (state = "blocked") => {
    const snap = snapshot({
      tasks: [{ id: "T1", agent: "agent01", title: PROMPT, state: state as "blocked", dispatchedAt: NOW - 600_000, updatedAt: NOW - 60_000, lastLine: "typed reply line" }],
      approvals: [{ id: "A1", summary: SUMMARY, agent: "agent01" }],
      discussions: [{ id: "D1", topic: TOPIC, status: "active", round: 1, maxRounds: 3, messages: 1, maxMessages: 9, participants: ["agent01"], benched: [], updatedAt: NOW }],
    }, NOW);
    return call(request("/api/ingest/snapshot", { body: snap, token }));
  };
  const events = async () =>
    call(request("/api/ingest/events", { token, body: { v: 1, host: "hosta", project: "proja", events: [
      { kind: "approval", origin: "host", key: "e1", at: NOW, text: EVTEXT, agent: "agent01" },
      { kind: "lifecycle", origin: "host", key: "e2", at: NOW, text: EVTEXT, agent: "agent01" },
      { kind: "halt", origin: "host", key: "e3", at: NOW, text: EVTEXT, agent: "agent01", scenario: "stuck" },
    ] } }));
  const q = <T,>(sql: string) => t.db.sqlite.query(sql).all() as T[];
  const everything = () => JSON.stringify([q("SELECT * FROM tasks"), q("SELECT * FROM snapshots"), q("SELECT * FROM events"), q("SELECT * FROM alerts")]);
  return { ...t, call, token, push, events, q, everything };
}

describe("hostTextMode / hostTaskTitle", () => {
  test("default minimal; stricter of server and source wins", () => {
    expect(hostTextMode(undefined, undefined)).toBe("minimal");
    expect(hostTextMode("bogus", null)).toBe("minimal");
    expect(hostTextMode("full", undefined)).toBe("full");
    expect(hostTextMode("full", "brief")).toBe("brief");
    expect(hostTextMode("brief", "full")).toBe("brief");
    expect(hostTextMode("full", "none")).toBe("none");
  });
  test("titles", () => {
    expect(hostTaskTitle("x", "agent01", "minimal")).toBe("Task for agent01");
    expect(hostTaskTitle("x", undefined, "minimal")).toBe("Task");
    expect(hostTaskTitle("x", "agent01", "none")).toBe("Task");
    expect(hostTaskTitle("a".repeat(100), "agent01", "brief").length).toBeLessThanOrEqual(60);
  });
});

describe("ACCEPT_HOST_TEXT on snapshots and events", () => {
  test("full: as sent", async () => {
    const b = await boot({ ACCEPT_HOST_TEXT: "full" });
    expect((await b.push()).status).toBe(200);
    expect(b.q<{ title: string }>("SELECT title FROM tasks")[0]?.title).toBe(PROMPT);
    expect(b.everything()).toContain(SUMMARY);
    expect(b.everything()).toContain(TOPIC);
  });
  test("brief: title clipped, summaries replaced, topic clipped", async () => {
    const b = await boot({ ACCEPT_HOST_TEXT: "brief" });
    await b.push();
    const title = b.q<{ title: string }>("SELECT title FROM tasks")[0]!.title;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.startsWith("please rewrite")).toBe(true);
    expect(b.everything()).not.toContain(SUMMARY);
    expect(b.everything()).toContain("Approval pending");
    expect(b.everything()).not.toContain(TOPIC);
  });
  test("minimal (the default) and none: labels only, nothing stored or alerted carries the text", async () => {
    for (const [mode, label] of [[undefined, "Task for agent01"], ["minimal", "Task for agent01"], ["none", "Task"]] as const) {
      const b = await boot(mode ? { ACCEPT_HOST_TEXT: mode } : {});
      expect((await b.push()).status).toBe(200);
      expect((await b.events()).status).toBe(200);
      expect(b.q<{ title: string }>("SELECT title FROM tasks")[0]?.title).toBe(label);
      const all = b.everything();
      for (const s of [PROMPT, SUMMARY, TOPIC, EVTEXT, "typed reply line"]) expect(all).not.toContain(s);
      expect(all).toContain("Approval pending");
      expect(b.q<{ text: string }>("SELECT text FROM events WHERE key = 'e2'")[0]?.text).toBe("Lifecycle update");
      expect(b.q<{ rule: string }>("SELECT rule FROM alerts").some((a) => a.rule === "blocked")).toBe(true);
      expect(b.q<{ id: string; state: string }>("SELECT task_id AS id, state FROM tasks")[0]).toEqual({ id: "T1", state: "blocked" });
    }
  });
  test("ceiling: a per-source value below the server's wins; one above does not", async () => {
    const low = await boot({ ACCEPT_HOST_TEXT: "full" }, "none");
    await low.push();
    expect(low.q<{ title: string }>("SELECT title FROM tasks")[0]?.title).toBe("Task");
    const high = await boot({ ACCEPT_HOST_TEXT: "minimal" }, "full");
    await high.push();
    expect(high.everything()).not.toContain(PROMPT);
  });
});

describe("migration 0015: scrub of stored host text", () => {
  test("host rows change, MCP rows untouched, open alerts resolved, idempotent", () => {
    const M = join(import.meta.dir, "..", "migrations");
    const old = mkdtempSync(join(tmpdir(), "siiswell-mig15-"));
    for (const f of readdirSync(M).filter((f) => f < "0015")) copyFileSync(join(M, f), join(old, f));
    const db = new Database(":memory:");
    applyMigrations(db, old);
    const ins = (key: string, origin: string, agent: string | null) =>
      db.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, last_line, created, updated) VALUES (?, 's', ?, 'h', 'p', ?, ?, ?, 'blocked', 'typed', 1, 1)").run(key, origin, agent, key, PROMPT);
    ins("k1", "host", "agent01");
    ins("k2", "host", null);
    ins("k3", "mcp", "client");
    db.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'h', 'p', ?, ?, 'info', ?, 1, 1)").run("e1", "approval", "host", EVTEXT);
    db.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'h', 'p', ?, ?, 'info', ?, 1, 1)").run("e2", "approval", "mcp", EVTEXT);
    db.query("INSERT INTO snapshots (source_id, host, project, json, received_at, fp) VALUES ('s', 'h', 'p', ?, 1, 'x')").run(JSON.stringify({ approvals: [{ id: "A", summary: SUMMARY }], discussions: [{ id: "D", topic: TOPIC, round: 1 }], agents: [] }));
    db.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', 'e3', 'h', 'p', 'status', 'host', 'info', ?, 1, 1)").run(EVTEXT);
    db.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', 'e4', 'h', 'p', 'status', 'relay', 'info', ?, 1, 1)").run(EVTEXT);
    db.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, scenario, at, received_at) VALUES ('s', 'e5', 'h', 'p', 'halt', 'host', 'info', ?, 'usage-limit', 1, 1)").run(EVTEXT);
    db.query("INSERT INTO alerts (key, rule, severity, origin, host, text, opened, resolved) VALUES ('a3', 'blocked', 'warn', 'host', 'h', ?, 1, 5)").run(`Blocked: ${PROMPT}`);
    db.query("INSERT INTO alerts (key, rule, severity, origin, host, text, opened) VALUES ('a4', 'blocked', 'warn', 'relay', 'h', ?, 1)").run(`Blocked: ${PROMPT}`);
    for (const [k, o] of [["a1", "host"], ["a2", "mcp"]] as const) db.query("INSERT INTO alerts (key, rule, severity, origin, host, text, opened) VALUES (?, 'blocked', 'warn', ?, 'h', ?, 1)").run(k, o, `Blocked: ${PROMPT}`);
    copyFileSync(join(M, "0015_scrub_host_text.sql"), join(old, "0015_scrub_host_text.sql"));
    for (let i = 0; i < 2; i++) {
      i === 0 ? applyMigrations(db, old) : db.exec(require("node:fs").readFileSync(join(M, "0015_scrub_host_text.sql"), "utf8"));
      const t = Object.fromEntries((db.query("SELECT key, title, last_line FROM tasks").all() as any[]).map((r) => [r.key, r]));
      expect(t.k1.title).toBe("Task for agent01");
      expect(t.k2.title).toBe("Task");
      expect(t.k1.last_line).toBeNull();
      expect(t.k3.title).toBe(PROMPT);
      expect(t.k3.last_line).toBe("typed");
      const ev = Object.fromEntries((db.query("SELECT key, text FROM events").all() as any[]).map((r) => [r.key, r.text]));
      expect(ev.e1).toBe("Approval pending");
      expect(ev.e2).toBe(EVTEXT);
      expect(ev.e3).toBe("Status update");
      expect(ev.e4).toBe(EVTEXT);
      expect(ev.e5).toBe("Usage limit reached");
      const at = Object.fromEntries((db.query("SELECT key, text FROM alerts").all() as any[]).map((r) => [r.key, r.text]));
      expect(at.a1).toBe("Blocked: task");
      expect(at.a3).toBe("Blocked: task");
      expect(at.a2).toContain(PROMPT);
      expect(at.a4).toContain(PROMPT);
      const js = JSON.parse((db.query("SELECT json FROM snapshots").get() as any).json);
      expect(js.approvals[0]).toEqual({ id: "A", summary: "Approval pending" });
      expect(js.discussions[0]).toEqual({ id: "D", topic: "", round: 1 });
      const al = Object.fromEntries((db.query("SELECT key, resolved FROM alerts").all() as any[]).map((r) => [r.key, r.resolved]));
      expect(al.a1).not.toBeNull();
      expect(al.a2).toBeNull();
    }
  });
});

describe("fixed event text and label literals", () => {
  test("minimal: a host status event stores the label only; unknown kind too", async () => {
    for (const mode of ["minimal", "none"] as const) {
      const b = await boot({ ACCEPT_HOST_TEXT: mode });
      const r = await b.call(request("/api/ingest/events", { token: b.token, body: { v: 1, host: "hosta", project: "proja", events: [
        { kind: "status", origin: "host", key: "s1", at: NOW, text: EVTEXT, agent: "agent01" },
      ] } }));
      expect(r.status).toBe(200);
      expect(b.q<{ text: string }>("SELECT text FROM events WHERE key = 's1'")[0]?.text).toBe("Status update");
      expect(b.everything()).not.toContain(EVTEXT);
    }
  });
  test("minimal: long agent name is clipped in the title; free-text snapshot strings dropped", async () => {
    expect(hostTaskTitle("x", "a".repeat(60), "minimal")).toBe(`Task for ${"a".repeat(32)}`);
    const { applyHostText } = await import("../src/ingest");
    const snap: any = snapshot({ agents: [{ name: "agent01", state: "idle", usage: [{ label: "my secret plan words", usedPercent: 3 }, { label: "5h", usedPercent: 4 }] }] as any,
      discussions: [{ id: "D1", topic: "t", status: "free text status here", round: 1, maxRounds: 3, messages: 1, maxMessages: 9, participants: [], benched: [], updatedAt: NOW }] }, NOW);
    snap.poller = { status: "some free text", binaryVersion: "not a version!" };
    const out: any = applyHostText(snap, "minimal");
    expect(out.agents[0].usage.map((u: any) => u.label)).toEqual(["window", "5h"]);
    expect(out.discussions[0].status).toBe("");
    expect(out.poller.status).toBe("");
    expect(out.poller.binaryVersion).toBe("");
  });
  test("migration 0015 last_line literals equal the code constants", () => {
    const sql = require("node:fs").readFileSync(join(import.meta.dir, "..", "migrations", "0015_scrub_host_text.sql"), "utf8");
    const { HOOK_MARK, HOOK_STALE_LINE, HOOK_IDLE_LINE } = require("../src/shared/hook");
    const { RELAY_LABEL, STUCK_LABEL, LIMIT_LABEL, APPROVAL_LABEL, LIFECYCLE_LABEL } = require("../src/shared/labels");
    for (const l of [HOOK_MARK, HOOK_STALE_LINE, HOOK_IDLE_LINE, RELAY_LABEL, STUCK_LABEL, LIMIT_LABEL, APPROVAL_LABEL, LIFECYCLE_LABEL]) expect(sql).toContain(`'${l}'`);
  });
});
