// Relay tasks nobody has updated for 24 h are STALE (their agent most likely finished without saying so):
// out of the rules, out of /api/state; and every scan the rules / state do is bounded.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { RULE_PART_ALERTS, RULE_PART_TASKS, loadRuleInput } from "../src/alerts";
import { MAX_STATE_ALERTS_PER_HOST, RELAY_STALE_AFTER_MS } from "../src/env";
import { route, runCron } from "../src/index";
import { evaluateRules } from "../src/rules";
import { buildState } from "../src/state";
import { makeCtx, makeEnv, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function addTask(db: D1Shim, key: string, over: Record<string, string | number | null> = {}): void {
  const row = { origin: ORIGIN_RELAY, host: "hosta", project: "proja", agent: "bot", task_id: key, title: `task ${key}`, state: "blocked", eta_at: null, created: NOW - 30 * HOUR, updated: NOW - 25 * HOUR, ...over };
  db.sqlite
    .query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated) VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, ?, 'STATUS: BLOCKED', ?, ?)")
    .run(key, row.origin as string, row.host as string, row.project as string, row.agent as string, row.task_id as string, row.title as string, row.state as string, row.eta_at as number | null, row.created as number, row.updated as number);
}

describe("stale relay tasks", () => {
  test("the rules ignore a relayed task still open after 24 h without an update, but not a fresh one, nor an MCP / host-agent task of the same age", async () => {
    const { db } = makeEnv();
    addTask(db, "relay|hosta|proja|@old:srv", { updated: NOW - RELAY_STALE_AFTER_MS - 1 }); // stale
    addTask(db, "relay|hosta|proja|@edge:srv", { updated: NOW - RELAY_STALE_AFTER_MS }); // exactly 24 h: still counts
    addTask(db, "relay|hosta|proja|@new:srv", { updated: NOW - HOUR });
    addTask(db, "relay|hosta|proja|@oldrun:srv", { state: "running", eta_at: NOW - 26 * HOUR, updated: NOW - 25 * HOUR }); // would be 'overdue'
    addTask(db, "mcp|codex|m-1", { origin: "mcp", host: "codex", updated: NOW - 25 * HOUR });
    addTask(db, "hosta|proja|T-1", { origin: ORIGIN_HOST, updated: NOW - 25 * HOUR });
    const input = await loadRuleInput(db as unknown as D1Database, NOW);
    expect(input.tasks.map((t) => t.key).sort()).toEqual(["hosta|proja|T-1", "mcp|codex|m-1", "relay|hosta|proja|@edge:srv", "relay|hosta|proja|@new:srv"]);
    const out = evaluateRules(input);
    expect(out.desired.some((d) => d.key.includes("@old:srv") || d.key.includes("@oldrun:srv"))).toBe(false);
    expect(out.desired.some((d) => d.key.includes("@new:srv"))).toBe(true);
  });

  test("the cron no longer pushes (or keeps open) an alert for a relayed task that went stale", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    // "running, ETA 60 min" reported 23.5 h ago and never followed up: overdue (nothing else ever clears it)
    const updated = NOW - 23 * HOUR - 30 * MIN;
    addTask(t.db, "relay|hosta|proja|@bot:srv", { state: "running", updated, created: updated, eta_at: updated + HOUR });
    t.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?)").run(NOW + 2 * HOUR); // keep the host itself out of the picture
    await runCron(t.env, ctx, NOW, {});
    expect(t.db.rows<{ resolved: number | null }>("SELECT resolved FROM alerts WHERE rule = 'overdue'")).toEqual([{ resolved: null }]);
    await runCron(t.env, ctx, NOW + HOUR, {}); // the task is now 24.5 h without an update: stale
    expect(t.db.rows<{ resolved: number | null }>("SELECT resolved FROM alerts WHERE rule = 'overdue'")).toEqual([{ resolved: NOW + HOUR }]);
  });

  test("/api/state does not list a stale relayed task as open; fresh ones, MCP tasks and recent closed ones stay", async () => {
    const { db } = makeEnv();
    addTask(db, "relay|hosta|proja|@old:srv", { updated: NOW - 25 * HOUR });
    addTask(db, "relay|hosta|proja|@oldrun:srv", { state: "running", updated: NOW - 30 * HOUR });
    addTask(db, "relay|hosta|proja|@new:srv", { updated: NOW - HOUR });
    addTask(db, "relay|hosta|proja|@done:srv", { state: "done", updated: NOW - 2 * HOUR });
    addTask(db, "mcp|codex|m-1", { origin: "mcp", host: "codex", state: "running", updated: NOW - 25 * HOUR });
    const s = await buildState(db as unknown as D1Database, NOW);
    expect(s.tasks.map((x) => x.key).sort()).toEqual(["mcp|codex|m-1", "relay|hosta|proja|@done:srv", "relay|hosta|proja|@new:srv"]);
  });
});

describe("scans are bounded", () => {
  test("600 blocked tasks of ONE host: the rules read its newest RULE_PART_TASKS and flag only that partition", async () => {
    const { db } = makeEnv();
    db.sqlite.exec("BEGIN");
    for (let i = 0; i < 600; i++) addTask(db, `hosta|proja|T-${i}`, { origin: ORIGIN_HOST, agent: `a${i % 9}`, updated: NOW - 10 * MIN, created: NOW - 20 * MIN });
    db.sqlite.exec("COMMIT");
    const input = await loadRuleInput(db as unknown as D1Database, NOW);
    expect(input.tasks).toHaveLength(RULE_PART_TASKS);
    expect(input.truncated).toEqual([]);
    expect(input.truncatedParts).toEqual({ tasks: [`hosta|${ORIGIN_HOST}`] });
    expect(evaluateRules(input).desired.length).toBeGreaterThan(0);
  });

  test("700 open alerts of one host: /api/state returns the newest MAX_STATE_ALERTS_PER_HOST of them and says it cut the inbox, the rules read at most RULE_PART_ALERTS", async () => {
    const t = makeEnv();
    t.db.sqlite.exec("BEGIN");
    const ins = t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, host, project, agent, text, opened) VALUES (?, 'blocked', 'warn', 'hosta', 'proja', 'a', 'x', ?)");
    for (let i = 0; i < 700; i++) ins.run(`blocked|hosta|proja|T-${i}`, NOW - i * 1000);
    t.db.sqlite.exec("COMMIT");
    const res = await route(new Request("http://localhost:8787/api/state"), t.env, makeCtx(), { now: NOW });
    const s = (await res.json()) as { inbox: Array<{ key: string; opened?: number }>; truncated: string[] };
    expect(s.inbox).toHaveLength(MAX_STATE_ALERTS_PER_HOST);
    expect(s.truncated).toContain("inbox");
    expect(s.inbox[0]?.key).toBe("blocked|hosta|proja|T-0"); // the newest
    const input = await loadRuleInput(t.db as unknown as D1Database, NOW);
    expect(input.alerts.length).toBeLessThanOrEqual(RULE_PART_ALERTS);
  });
});
