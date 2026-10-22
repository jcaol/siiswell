// Alert SUPPRESSION: what one noisy or hostile source can do to what the operator sees.
//  A. a truncated scan must never be read as "the condition ended" (resolution from partial inputs);
//  B. push slots are shared fairly: one source cannot fill an invocation, host-agent criticals come first;
//  C. a spent budget is never silent: critical halts still get through, and the exhaustion is an alert.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_HALT_SCENARIOS } from "../src/shared/schema";
import { RULE_EVENT_LIMIT, RULE_PART_ALERTS, RULE_PART_EVENTS, SQL_RULE_EVENTS, loadRuleInput } from "../src/alerts";
import { MAX_CRITICAL_HALTS_PER_DAY, MAX_HOST_WRITES_PER_DAY, MAX_MCP_MUTATIONS_PER_DAY, MAX_OPEN_ALERTS_PER_PROJECT, MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT, MAX_PUSHES_PER_INVOCATION, MAX_PUSHES_PER_SOURCE_PER_WINDOW } from "../src/env";
import { route, runCron } from "../src/index";
import { PUSH_RETRY_WINDOW_MS, evaluateRules, prioritizePushes, type RuleAlert, type RuleInput, type RuleScan } from "../src/rules";
import { pickFairly } from "../src/push";
import { addSource, makeCtx, makeEnv, request, setupPush, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── A. pure rules ────────────────────────────────────────────────────────────

const input = (over: Partial<RuleInput> = {}): RuleInput => ({ now: NOW, snapshots: [], hosts: [], tasks: [], events: [], alerts: [], ...over });
const openAlert = (key: string, rule: string, over: Partial<RuleAlert> = {}): RuleAlert => ({ key, rule, last_pushed: NOW - HOUR, push_count: 1, opened: NOW - HOUR, resolved: null, ...over });

describe("A. a truncated scan never resolves", () => {
  // one open alert per rule family, none of whose conditions holds in the (empty) input
  const alerts = [
    openAlert("approval-waiting|hosta|proja|ap1", "approval-waiting"),
    openAlert("blocked|hosta|proja|T-1", "blocked"),
    openAlert("overdue|hosta|proja|T-2|1", "overdue"),
    openAlert("agent-stuck|hosta|proja|a|benched", "agent-stuck"),
    openAlert("usage-limit|hosta|proja|a", "usage-limit"),
    openAlert("host-offline|hosta", "host-offline"),
    openAlert("budget-exhausted|hosta", "budget-exhausted"),
  ];

  test("with nothing truncated every ended alert resolves (the normal path still works)", () => {
    const out = evaluateRules(input({ alerts }));
    expect(out.resolve).toEqual(alerts.map((a) => a.key).sort());
    expect(out.truncated).toEqual([]);
  });

  test("each truncated scan freezes exactly the rule families that read it, and nothing else", () => {
    const resolved = (truncated: RuleScan[]) => evaluateRules(input({ alerts, truncated })).resolve.map((k) => k.split("|")[0]).sort();
    expect(resolved(["tasks"])).toEqual(["agent-stuck", "approval-waiting", "budget-exhausted", "host-offline", "usage-limit"]);
    expect(resolved(["events"])).toEqual(["approval-waiting", "blocked", "budget-exhausted", "host-offline", "overdue"]);
    expect(resolved(["snapshots"])).toEqual(["agent-stuck", "blocked", "budget-exhausted", "host-offline", "overdue"]);
    expect(resolved(["hosts"])).toEqual(["agent-stuck", "approval-waiting", "blocked", "budget-exhausted", "overdue", "usage-limit"]);
    expect(resolved(["budgets"])).toEqual(["agent-stuck", "approval-waiting", "blocked", "host-offline", "overdue", "usage-limit"]);
  });

  test("a truncated open-alert scan resolves NOTHING at all", () => {
    expect(evaluateRules(input({ alerts, truncated: ["alerts"] })).resolve).toEqual([]);
    expect(evaluateRules(input({ alerts, truncated: ["alerts", "tasks"] })).resolve).toEqual([]);
  });

  test("an alert of a rule this code does not know is frozen by ANY truncation", () => {
    const odd = [openAlert("mystery|x", "mystery")];
    expect(evaluateRules(input({ alerts: odd })).resolve).toEqual(["mystery|x"]);
    for (const s of ["snapshots", "hosts", "tasks", "events", "budgets"] as RuleScan[]) expect(evaluateRules(input({ alerts: odd, truncated: [s] })).resolve).toEqual([]);
  });

  test("a truncated scan may still OPEN alerts, and the result says which scans were cut", () => {
    const task = { key: "k", origin: ORIGIN_HOST, host: "hosta", project: "proja", agent: "a", task_id: "T-9", title: "t", state: "blocked", eta_at: null, last_line: null, created: NOW - 10 * MIN, updated: NOW - 5 * MIN };
    const out = evaluateRules(input({ tasks: [task], truncated: ["tasks", "events"] }));
    expect(out.open.map((a) => a.key)).toEqual(["blocked|hosta|proja|T-9"]);
    expect(out.truncated.sort()).toEqual(["events", "tasks"]);
  });
});

// ── A. through the loader, the cron and /api/state ───────────────────────────

function addTask(db: D1Shim, key: string, over: Record<string, string | number | null> = {}): void {
  const r = { source_id: "s", origin: "mcp", host: "client1", project: "p", agent: "agent", task_id: key, title: `task ${key}`, state: "blocked", eta_at: null, created: NOW - 30 * MIN, updated: NOW - 20 * MIN, ...over };
  db.sqlite
    .query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, last_line, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STATUS: BLOCKED', ?, ?)")
    .run(key, r.source_id as string, r.origin as string, r.host as string, r.project as string, r.agent as string, r.task_id as string, r.title as string, r.state as string, r.eta_at as number | null, r.created as number, r.updated as number);
}
function addAlert(db: D1Shim, key: string, rule: string, over: Record<string, string | number | null> = {}): void {
  const r = { severity: "warn", origin: ORIGIN_HOST, host: "hosta", project: "proja", agent: "a", text: "x", opened: NOW - HOUR, push_count: 1, resolved: null, ...over };
  db.sqlite
    .query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened, push_count, last_pushed, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(key, rule, r.severity as string, r.origin as string, r.host as string, r.project as string, r.agent as string, r.text as string, r.opened as number, r.push_count as number, (r.opened as number) + 1, r.resolved as number | null);
}
const openKeys = (db: D1Shim, rule?: string) => db.rows<{ key: string }>(`SELECT key FROM alerts WHERE resolved IS NULL ${rule ? `AND rule = '${rule}'` : ""} ORDER BY key`).map((r) => r.key);

async function bootRules() {
  const t = makeEnv();
  const ctx = makeCtx();
  const cron = async (now: number) => {
    await runCron(t.env, ctx, now, {});
    await ctx.flush();
  };
  const state = async (now = NOW) => ((await (await route(request("/api/state"), t.env, ctx, { now })).json()) as any);
  return { ...t, ctx, cron, state };
}

describe("A. one flooding source cannot blind another source's alerts (per-partition scans)", () => {
  /** A task row that is blocked, owned by `host` (a client name, a host label), of the given origin. */
  const flood = (b: Awaited<ReturnType<typeof bootRules>>, n: number, host: string, origin: string, state = "blocked") => {
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < n; i++) addTask(b.db, `${origin}|${host}|${i}`, { origin, host, task_id: `f${i}`, state, updated: NOW - 10 * MIN + i, project: `p${i % 3}` });
    b.db.sqlite.exec("COMMIT");
  };

  test("client open tasks: a client with 600 blocked tasks fills ITS partition only; another client's alert still resolves normally", async () => {
    const b = await bootRules();
    addTask(b.db, "mcp|gemini|m-legit", { host: "gemini", task_id: "m-legit", state: "blocked", updated: NOW - 30 * MIN, created: NOW - 40 * MIN });
    addAlert(b.db, "blocked|gemini|p|m-legit", "blocked", { host: "gemini", origin: "mcp", project: "p" });
    // a second legit alert whose task is DONE: it must resolve in the same evaluation the flood is in
    addAlert(b.db, "blocked|gemini|p|m-done", "blocked", { host: "gemini", origin: "mcp", project: "p" });
    addTask(b.db, "hosta|proja|T-own", { origin: ORIGIN_HOST, host: "hosta", project: "proja", agent: "agent01", task_id: "T-own", updated: NOW - 25 * MIN });
    addAlert(b.db, "blocked|hosta|proja|T-own", "blocked");
    // the flooder's own old alert: its partition is cut, so THAT one is frozen
    addAlert(b.db, "blocked|evil|p|gone", "blocked", { host: "evil", origin: "mcp", project: "p" });
    flood(b, 600, "evil", "mcp");
    const loaded = await loadRuleInput(b.env.DB, NOW);
    expect(loaded.truncated).toEqual([]); // nothing global ...
    expect(loaded.truncatedParts.tasks).toEqual(["evil|mcp"]); // ... only the flooder's partition
    expect(loaded.tasks.map((t) => t.key)).toContain("mcp|gemini|m-legit"); // the other client is not crowded out
    expect(loaded.tasks.map((t) => t.key)).toContain("hosta|proja|T-own");

    await b.cron(NOW);
    const open = openKeys(b.db, "blocked");
    expect(open).toContain("blocked|gemini|p|m-legit");
    expect(open).toContain("blocked|hosta|proja|T-own");
    expect(open).not.toContain("blocked|gemini|p|m-done"); // normal resolution keeps working for everybody else
    expect(open).toContain("blocked|evil|p|gone"); // the flooder's own alert is frozen, not resolved
    expect((await b.state()).rulesTruncated).toEqual(["tasks"]);
  });

  test("relay rows: a host's 600 relayed tasks fill (host, relay origin) only; the same host's host-agent tasks and everyone else are fine", async () => {
    const b = await bootRules();
    addTask(b.db, "evil|proja|T-own", { origin: ORIGIN_HOST, host: "evil", project: "proja", agent: "agent01", task_id: "T-own", updated: NOW - 25 * MIN });
    addTask(b.db, "mcp|gemini|m-legit", { host: "gemini", task_id: "m-legit", updated: NOW - 30 * MIN });
    addAlert(b.db, "blocked|gemini|p|m-legit", "blocked", { host: "gemini", origin: "mcp", project: "p" });
    addAlert(b.db, "blocked|gemini|p|m-done", "blocked", { host: "gemini", origin: "mcp", project: "p" });
    flood(b, 600, "evil", ORIGIN_RELAY);
    const loaded = await loadRuleInput(b.env.DB, NOW);
    expect(loaded.truncatedParts.tasks).toEqual([`evil|${ORIGIN_RELAY}`]);
    expect(loaded.tasks.map((t) => t.key)).toContain("evil|proja|T-own"); // host agent rows of the same host: another partition
    await b.cron(NOW);
    expect(openKeys(b.db, "blocked")).toContain("blocked|gemini|p|m-legit");
    expect(openKeys(b.db, "blocked")).not.toContain("blocked|gemini|p|m-done");
  });

  test("host halt events: 600 halts of one host cut ITS event partition only; another host's real halt is still read and its alert stays", async () => {
    const b = await bootRules();
    const hostToken = await addSource(b.db, "evil", "host");
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?), ('evil', ?)").run(NOW + HOUR, NOW + HOUR);
    b.db.sqlite
      .query("INSERT INTO events (source_id, key, host, project, kind, origin, agent, scenario, severity, text, at, received_at) VALUES ('s-real', 'real', 'hosta', 'proja', 'halt', '" + ORIGIN_HOST + "', 'agent02', 'benched', 'critical', 'Agent02 benched', ?, ?)")
      .run(NOW - 3 * HOUR, NOW - 3 * HOUR);
    addAlert(b.db, "agent-stuck|hosta|proja|agent02|benched", "agent-stuck", { severity: "critical", agent: "agent02", opened: NOW - 3 * HOUR });
    // the flood goes in through the real ingest route (6 x 100 halts for three agents: few alerts, many events)
    const post = (n: number) =>
      route(request("/api/ingest/events", { token: hostToken, body: { v: 1, host: "evil", project: "x", events: Array.from({ length: 100 }, (_, j) => ({ kind: "halt", origin: ORIGIN_HOST, at: NOW - 2 * HOUR + n * 1000 + j, severity: "critical", key: `f${n}-${j}`, agent: `Bot${j % 3}`, scenario: "benched", text: "benched" })) } }), b.env, b.ctx, { now: NOW - HOUR });
    for (let n = 0; n < 6; n++) expect((await post(n)).status).toBe(200);
    // the flooder's own older alert, whose event is no longer in its (cut) partition: frozen, not resolved
    addAlert(b.db, "agent-stuck|evil|x|bot9|benched", "agent-stuck", { severity: "critical", host: "evil", project: "x", agent: "bot9", opened: NOW - 2 * HOUR });
    const loaded = await loadRuleInput(b.env.DB, NOW);
    expect(loaded.truncatedParts.events).toEqual(["evil"]);
    expect(loaded.events.some((e) => e.host === "hosta")).toBe(true); // the real halt is read, however many halts the flooder stored
    await b.cron(NOW);
    expect(openKeys(b.db, "agent-stuck")).toContain("agent-stuck|hosta|proja|agent02|benched");
    expect(openKeys(b.db, "agent-stuck")).toContain("agent-stuck|evil|x|bot9|benched"); // frozen: its partition was cut
    expect((await b.state()).rulesTruncated).toContain("events");
  });

  test("the events scan is bounded per host WITHOUT reading the flood: a bounded seek of idx_events_halt per host", async () => {
    const b = await bootRules();
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('evil', ?), ('hosta', ?)").run(NOW, NOW);
    b.db.sqlite.exec("BEGIN");
    const ins = b.db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, agent, scenario, severity, text, at, received_at) VALUES ('s', ?, ?, 'p', 'halt', '" + ORIGIN_HOST + "', 'a', 'benched', 'critical', 'x', ?, ?)");
    for (let i = 0; i < 5000; i++) ins.run(`e${i}`, "evil", NOW - 60_000 - i, NOW);
    ins.run("real", "hosta", NOW - 3 * HOUR, NOW);
    b.db.sqlite.exec("COMMIT");
    // rows the engine visits: count through the plan's index use, and the result itself
    const plan = b.db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${SQL_RULE_EVENTS}`).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_events_halt");
    const rows = b.db.sqlite.query(SQL_RULE_EVENTS).all(NOW - 6 * HOUR, RULE_PART_EVENTS + 1, RULE_EVENT_LIMIT + 1) as Array<{ host: string }>;
    expect(rows.filter((r) => r.host === "evil")).toHaveLength(RULE_PART_EVENTS + 1);
    expect(rows.filter((r) => r.host === "hosta")).toHaveLength(1);
  });

  test("snapshots: 201 snapshots of one host (hand-inserted, the ingest cap would stop it) cannot hide another host's approval", async () => {
    const b = await bootRules();
    b.db.sqlite.exec("BEGIN");
    const ins = b.db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', ?, ?, ?, ?)");
    const snapJson = (host: string, project: string, approvals: unknown[] = []) => JSON.stringify({ v: 1, host, project, sentAt: NOW, poller: { status: "running" }, agents: [], discussions: [], approvals });
    for (let p = 0; p < 201; p++) ins.run("aaa-lab", `p${String(p).padStart(3, "0")}`, snapJson("aaa-lab", `p${p}`), NOW);
    ins.run("hosta", "proja", snapJson("hosta", "proja", [{ id: "k7q2", summary: "rm -rf build", requestedAt: NOW - 10 * MIN }]), NOW);
    b.db.sqlite.exec("COMMIT");
    const loaded = await loadRuleInput(b.env.DB, NOW);
    expect(loaded.truncatedParts.snapshots).toEqual(["aaa-lab"]);
    expect(loaded.snapshots.filter((s) => s.host === "hosta")).toHaveLength(1);
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?), ('aaa-lab', ?)").run(NOW, NOW);
    await b.cron(NOW);
    expect(openKeys(b.db, "approval-waiting")).toContain("approval-waiting|hosta|proja|k7q2");
  });

  test("more than RULE_PART_ALERTS OPEN alerts of one host: only that host's alerts freeze; the others resolve, and the flag clears when it fits again", async () => {
    const b = await bootRules();
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < RULE_PART_ALERTS + 50; i++) addAlert(b.db, `blocked|flood|p|T-${i}`, "blocked", { host: "flood", opened: NOW - 2 * HOUR + i });
    b.db.sqlite.exec("COMMIT");
    addAlert(b.db, "host-offline|ghost", "host-offline", { host: "ghost", project: null, severity: "critical" }); // its condition does not hold (no such host)
    addAlert(b.db, "blocked|flood|p|extra", "blocked", { host: "flood" });
    const loaded = await loadRuleInput(b.env.DB, NOW);
    expect(loaded.truncated).toEqual([]);
    expect(loaded.truncatedParts.alerts).toEqual(["flood"]);
    await b.cron(NOW);
    // the unrelated host's alert resolved normally; not one of the flood host's was resolved
    expect(b.db.rows<{ key: string }>("SELECT key FROM alerts WHERE resolved IS NOT NULL").map((r) => r.key)).toEqual(["host-offline|ghost"]);
    expect((await b.state()).rulesTruncated).toContain("alerts");
    // the operator purges the flooder: its alerts go, the partition fits, and its own alerts resolve again
    b.db.sqlite.exec("DELETE FROM alerts WHERE host = 'flood' AND key <> 'blocked|flood|p|extra'");
    await b.cron(NOW + MIN);
    expect(b.db.rows<{ key: string }>("SELECT key FROM alerts WHERE resolved IS NOT NULL ORDER BY key").map((r) => r.key)).toEqual(["blocked|flood|p|extra", "host-offline|ghost"]);
    expect((await b.state(NOW + MIN)).rulesTruncated).toEqual([]);
  });

  test("a long tail of RECENTLY RESOLVED alerts is not a truncation: the open ones are listed first", async () => {
    const b = await bootRules();
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < RULE_PART_ALERTS + 50; i++) addAlert(b.db, `blocked|old|p|T-${i}`, "blocked", { host: "old", resolved: NOW - 5 * MIN, opened: NOW - HOUR });
    b.db.sqlite.exec("COMMIT");
    addAlert(b.db, "blocked|old|p|open", "blocked", { host: "old" });
    const loaded = await loadRuleInput(b.env.DB, NOW);
    expect(loaded.truncated).toEqual([]);
    expect(loaded.truncatedParts.alerts).toBeUndefined();
    expect(loaded.alerts[0]?.key).toBe("blocked|old|p|open"); // open first
    await b.cron(NOW);
    expect(b.db.rows<{ resolved: number | null }>("SELECT resolved FROM alerts WHERE key = 'blocked|old|p|open'")).toEqual([{ resolved: NOW }]);
  });

  test("a project keeps at most MAX_OPEN_ALERTS_PER_PROJECT non-critical alerts: the OLDEST are evicted for the newest, one alerts-capped warning says so", () => {
    const task = (i: number) => ({ key: `k${i}`, origin: ORIGIN_HOST, host: "hosta", project: "proja", agent: `a${i}`, task_id: `T-${i}`, title: "t", state: "blocked", eta_at: null, last_line: null, created: NOW - 2 * HOUR, updated: NOW - HOUR + i * 1000 });
    const openAlerts = Array.from({ length: MAX_OPEN_ALERTS_PER_PROJECT }, (_, i) => openAlert(`blocked|hosta|proja|T-${i}`, "blocked", { host: "hosta", origin: ORIGIN_HOST, opened: NOW - HOUR + i * 1000 }));
    // five NEW ones arrive on top of the 50 that are open
    const out = evaluateRules(input({ tasks: Array.from({ length: 55 }, (_, i) => task(i)), alerts: openAlerts, hosts: [{ host: "hosta", last_seen: NOW - HOUR }] }));
    expect(out.open.filter((a) => a.rule === "blocked").map((a) => a.key).sort()).toEqual(["blocked|hosta|proja|T-50", "blocked|hosta|proja|T-51", "blocked|hosta|proja|T-52", "blocked|hosta|proja|T-53", "blocked|hosta|proja|T-54"]);
    expect(out.resolve.sort()).toEqual(["blocked|hosta|proja|T-0", "blocked|hosta|proja|T-1", "blocked|hosta|proja|T-2", "blocked|hosta|proja|T-3", "blocked|hosta|proja|T-4"]); // the 5 oldest open ones
    expect(out.open.filter((a) => a.rule === "alerts-capped")).toHaveLength(1);
    expect(out.open.find((a) => a.rule === "alerts-capped")?.text).toContain("5 alerts over the limit of 50");
    expect(out.open.some((a) => a.rule === "host-offline")).toBe(true); // exempt singleton
    // the warning and the evicted ones are not pushed, the newcomers are
    expect(out.push.filter((p) => p.rule === "blocked")).toHaveLength(5);
    expect(out.push.some((p) => p.rule === "alerts-capped")).toBe(false);
  });

  test("evicting is STABLE: the next evaluation does not re-open what was evicted, and nothing flaps", () => {
    const task = (i: number) => ({ key: `k${i}`, origin: ORIGIN_HOST, host: "hosta", project: "proja", agent: `a${i}`, task_id: `T-${i}`, title: "t", state: "blocked", eta_at: null, last_line: null, created: NOW - 2 * HOUR, updated: NOW - HOUR + i * 1000 });
    const tasks = Array.from({ length: 55 }, (_, i) => task(i));
    // the state after the evaluation above: T-5..T-54 open, T-0..T-4 resolved a minute ago (still inside the grace)
    const alerts = [
      ...Array.from({ length: 50 }, (_, i) => openAlert(`blocked|hosta|proja|T-${i + 5}`, "blocked", { host: "hosta", origin: ORIGIN_HOST, opened: NOW - HOUR + (i + 5) * 1000 })),
      ...Array.from({ length: 5 }, (_, i) => openAlert(`blocked|hosta|proja|T-${i}`, "blocked", { host: "hosta", origin: ORIGIN_HOST, opened: NOW - HOUR + i * 1000, resolved: NOW - MIN })),
      openAlert("alerts-capped|hosta|proja", "alerts-capped", { host: "hosta", origin: ORIGIN_HOST }),
    ];
    const out = evaluateRules(input({ tasks, alerts, now: NOW + MIN }));
    expect(out.open.filter((a) => a.rule === "blocked")).toEqual([]);
    expect(out.resolve.filter((k) => k.startsWith("blocked"))).toEqual([]);
    expect(out.push).toEqual([]);
  });

  test("CRITICAL alerts are never refused by a full cap, and another project's alerts are untouched by a flood in this one", () => {
    const blocked = (i: number) => ({ key: `k${i}`, origin: ORIGIN_HOST, host: "hosta", project: "A", agent: `a${i}`, task_id: `T-${i}`, title: "t", state: "blocked", eta_at: null, last_line: null, created: NOW - 10 * MIN, updated: NOW - 5 * MIN });
    const ownerB = { key: "kb", origin: ORIGIN_HOST, host: "hosta", project: "B", agent: "b0", task_id: "T-B", title: "t", state: "blocked", eta_at: null, last_line: null, created: NOW - 10 * MIN, updated: NOW - 5 * MIN };
    const halt = { key: "e1", host: "hosta", project: "B", kind: "halt", agent: "Claude", scenario: "cli-gone", at: NOW - 1000, text: "claude CLI is gone" };
    const alerts = Array.from({ length: MAX_OPEN_ALERTS_PER_PROJECT }, (_, i) => openAlert(`blocked|hosta|A|T-${i}`, "blocked", { host: "hosta", origin: ORIGIN_HOST, opened: NOW - HOUR + i }));
    // a 100-alert flood in project A, plus a PARTITION-TRUNCATED alert scan for the host (the worst case for "cannot count")
    const out = evaluateRules(input({ tasks: [...Array.from({ length: 100 }, (_, i) => blocked(i)), ownerB], events: [halt as never], alerts, truncatedParts: { alerts: ["hosta"] } }));
    expect(out.open.map((a) => a.key)).toContain("agent-stuck|hosta|B|claude|cli-gone"); // critical: opened
    expect(out.push.map((p) => p.key)).toContain("agent-stuck|hosta|B|claude|cli-gone"); // and pushed
    // with the host's alert partition cut off nothing non-critical is opened (it cannot be counted), A's or B's
    expect(out.open.filter((a) => a.rule === "blocked")).toEqual([]);
    // ... and without the truncation project B's own blocked alert opens whatever project A holds
    const ok = evaluateRules(input({ tasks: [...Array.from({ length: 100 }, (_, i) => blocked(i)), ownerB], events: [halt as never], alerts }));
    expect(ok.open.map((a) => a.key)).toContain("blocked|hosta|B|T-B");
    expect(ok.open.map((a) => a.key)).toContain("agent-stuck|hosta|B|claude|cli-gone");
  });

  test("approvals are capped per PROJECT (20, oldest first): a flood in project A never hides project B's approval; the overflow is counted", () => {
    const flood = Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, summary: "x", requestedAt: 1 + i })); // ancient requests: the oldest of all
    const legit = [{ id: "legit", summary: "rm -rf build", requestedAt: NOW - 10 * MIN }];
    const a = snapshot({ project: "A", approvals: flood } as never, NOW);
    const b = snapshot({ project: "B", approvals: legit } as never, NOW);
    const out = evaluateRules(input({ snapshots: [a, b].map((s) => ({ host: s.host, project: s.project, receivedAt: NOW, snap: s })) }));
    const keys = out.desired.filter((d) => d.rule === "approval-waiting").map((d) => d.key);
    expect(keys.filter((k) => k.startsWith("approval-waiting|hosta|A|"))).toHaveLength(MAX_OPEN_APPROVAL_ALERTS_PER_PROJECT);
    expect(keys).toContain("approval-waiting|hosta|B|legit"); // project B is not crowded out
    expect(keys).toContain("approval-waiting|hosta|A|a0"); // the OLDEST of A
    expect(keys).not.toContain("approval-waiting|hosta|A|a49");
    const cap = out.open.find((d) => d.key === "alerts-capped|hosta|A");
    expect(cap?.text).toContain("30 alerts over the limit"); // 50 approvals - 20
    expect(out.open.some((d) => d.key === "alerts-capped|hosta|B")).toBe(false);
  });

  test("the truncation flag is written only when it changes (one write to flag, one to clear, none in between)", async () => {
    const b = await bootRules();
    b.db.sqlite.exec("CREATE TABLE _m (op TEXT); CREATE TRIGGER m_i AFTER INSERT ON meta WHEN NEW.k = 'rules_truncated' BEGIN INSERT INTO _m VALUES ('I'); END; CREATE TRIGGER m_u AFTER UPDATE ON meta WHEN NEW.k = 'rules_truncated' BEGIN INSERT INTO _m VALUES ('U'); END; CREATE TRIGGER m_d AFTER DELETE ON meta WHEN OLD.k = 'rules_truncated' BEGIN INSERT INTO _m VALUES ('D'); END;");
    flood(b, 600, "evil", "mcp");
    for (let i = 0; i < 4; i++) await b.cron(NOW + i * MIN);
    expect(b.db.rows<{ op: string }>("SELECT op FROM _m").map((r) => r.op)).toEqual(["I"]);
    b.db.sqlite.exec("DELETE FROM tasks");
    for (let i = 4; i < 8; i++) await b.cron(NOW + i * MIN);
    expect(b.db.rows<{ op: string }>("SELECT op FROM _m").map((r) => r.op)).toEqual(["I", "D"]);
    expect(b.db.rows("SELECT * FROM meta WHERE k = 'rules_truncated'")).toEqual([]); // (the cron's own stamps, last_cron / last_purge, live in meta too)
  });
});

// ── B. push fairness ─────────────────────────────────────────────────────────

const pushItem = (key: string, host: string, over: Record<string, unknown> = {}) => ({
  key, rule: "blocked" as const, severity: "warn" as const, opened: NOW, origin: "mcp", host, project: "p", agent: "a", pushCount: 0, lastPushed: null, reminder: false, ...over,
});

describe("B. push slots are shared fairly", () => {
  test("priority: host agent before the rest, critical before warn, then the oldest alert first", () => {
    const items = [
      pushItem("c-new", "client", { opened: NOW }),
      pushItem("c-old", "client", { opened: NOW - HOUR }),
      pushItem("t-warn", "hosta", { origin: ORIGIN_HOST, opened: NOW - 5 * MIN }),
      pushItem("c-crit", "client", { severity: "critical", opened: NOW }),
      pushItem("t-crit-new", "hosta", { origin: ORIGIN_HOST, severity: "critical", opened: NOW - MIN }),
      pushItem("t-crit-old", "hosta", { origin: ORIGIN_HOST, severity: "critical", opened: NOW - 30 * MIN }),
    ];
    expect(prioritizePushes(items).map((i) => i.key)).toEqual(["t-crit-old", "t-crit-new", "t-warn", "c-crit", "c-old", "c-new"]);
  });

  test("round-robin: a source with a thousand alerts gets at most 2 of the slots; the others are not starved", () => {
    const flood = Array.from({ length: 1000 }, (_, i) => pushItem(`flood-${i}`, "flood", { opened: NOW - HOUR + i }));
    const items = prioritizePushes([...flood, pushItem("b1", "b", { origin: ORIGIN_HOST, severity: "critical" }), pushItem("c1", "c"), pushItem("c2", "c", { opened: NOW + 1 })]);
    const picked = pickFairly(items, MAX_PUSHES_PER_INVOCATION, 2).map((i) => i.key);
    expect(picked).toEqual(["b1", "flood-0", "c1", "flood-1", "c2"]);
    expect(pickFairly(items, 5, 2).filter((i) => i.host === "flood")).toHaveLength(2);
    expect(pickFairly(items, 3, 2).map((i) => i.key)).toEqual(["b1", "flood-0", "c1"]); // never more than the total
  });

  async function bootPush(devices = 1) {
    const t = makeEnv();
    const push = await setupPush(t);
    for (let i = 1; i < devices; i++) t.db.sqlite.query("INSERT INTO push_subs (endpoint, p256dh, auth, created) SELECT endpoint || ?, p256dh, auth, created FROM push_subs ORDER BY endpoint LIMIT 1").run(`-${i}`);
    const ctx = makeCtx();
    const cron = async (now: number) => {
      await runCron(t.env, ctx, now, { fetch: push.fetch });
      await ctx.flush();
    };
    return { ...t, ctx, push, pushes: push.pushes, cron };
  }
  const pushedKeys = (db: D1Shim) => db.rows<{ key: string }>("SELECT key FROM alerts WHERE push_count > 0 ORDER BY key").map((r) => r.key);

  test("a client flooding alerts cannot delay a host-agent critical push: it goes out in the very first invocation", async () => {
    const b = await bootPush();
    await addSource(b.db, "client1", "client");
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?)").run(NOW - 10 * MIN); // host-offline: critical, host agent
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < 30; i++) addTask(b.db, `mcp|client1|m-${i}`, { host: "client1", task_id: `m-${i}`, updated: NOW - i * 1000 });
    b.db.sqlite.exec("COMMIT");
    await b.cron(NOW);
    expect(pushedKeys(b.db)).toContain("host-offline|hosta");
    expect(b.db.rows("SELECT key FROM alerts WHERE key LIKE 'blocked|client1%' AND push_count > 0")).toHaveLength(2); // the flooder: its 2 slots
    expect(b.pushes).toHaveLength(3);
  });

  test("a source that is over its push budget does not occupy the slots: its alerts are settled into the summary count, the rest are pushed", async () => {
    const b = await bootPush();
    await addSource(b.db, "client1", "client");
    b.db.sqlite.query("INSERT INTO push_budget (k, owner, count, window_start, day_start, day_count, touched) VALUES ('own|client1', 'client1', ?, ?, ?, ?, ?)").run(MAX_PUSHES_PER_SOURCE_PER_WINDOW, NOW - MIN, NOW - MIN, MAX_PUSHES_PER_SOURCE_PER_WINDOW, NOW);
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < 12; i++) addTask(b.db, `mcp|client1|m-${i}`, { host: "client1", task_id: `m-${i}`, updated: NOW - 100_000 - i * 1000 }); // OLDER than the alerts below
    b.db.sqlite.exec("COMMIT");
    for (let i = 0; i < 5; i++) b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES (?, ?)").run(`h${i}`, NOW - 10 * MIN);
    await b.cron(NOW);
    expect(b.pushes).toHaveLength(MAX_PUSHES_PER_INVOCATION); // every slot went to the five hosts
    expect(pushedKeys(b.db).filter((k) => k.startsWith("host-offline"))).toHaveLength(5);
    expect(b.db.rows<{ push_suppressed: number; push_count: number }>("SELECT suppressed AS push_suppressed, count AS push_count FROM push_budget WHERE k = 'own|client1'")[0]).toEqual({ push_suppressed: 12, push_count: MAX_PUSHES_PER_SOURCE_PER_WINDOW });
    // the settled alerts are told apart from pushed ones: summarized_at, and push_count stays 0 (no individual push)
    expect(b.db.rows("SELECT key FROM alerts WHERE key LIKE 'blocked|client1%' AND summarized_at IS NOT NULL AND push_count = 0")).toHaveLength(12);
    // ... and they are not pushed or counted again on the next minutes
    await b.cron(NOW + MIN);
    await b.cron(NOW + 2 * MIN);
    expect(b.pushes).toHaveLength(MAX_PUSHES_PER_INVOCATION);
    expect(b.db.rows<{ push_suppressed: number }>("SELECT suppressed AS push_suppressed FROM push_budget WHERE k = 'own|client1'")[0]?.push_suppressed).toBe(12);
  });

  test("nothing ages out of the 60-minute retry window because of another source: every alert gets its turn within a few cron minutes", async () => {
    const b = await bootPush();
    await addSource(b.db, "client1", "client");
    await addSource(b.db, "gemini-mac", "client");
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < 200; i++) addTask(b.db, `mcp|client1|m-${i}`, { host: "client1", task_id: `m-${i}`, updated: NOW - i * 1000 });
    for (let i = 0; i < 3; i++) addTask(b.db, `mcp|gemini-mac|g-${i}`, { host: "gemini-mac", task_id: `g-${i}`, updated: NOW - 600_000 - i * 1000 });
    b.db.sqlite.exec("COMMIT");
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?)").run(NOW - 10 * MIN);
    for (let m = 0; m < 6; m++) await b.cron(NOW + m * MIN);
    // all of them were decided (pushed, or settled into a summary) long before PUSH_RETRY_WINDOW_MS ran out
    expect(b.db.rows("SELECT key FROM alerts WHERE push_count = 0 AND summarized_at IS NULL AND resolved IS NULL AND rule <> 'alerts-capped'")).toEqual([]);
    expect(PUSH_RETRY_WINDOW_MS).toBeGreaterThan(6 * MIN);
    expect(pushedKeys(b.db)).toContain("host-offline|hosta");
    expect(pushedKeys(b.db).filter((k) => k.startsWith("blocked|gemini-mac"))).toHaveLength(3); // the other client's three are not crowded out
    // and the flooder paid for its own noise: at most its budget of pushes, the rest in ONE summary
    expect(b.db.rows<{ push_count: number }>("SELECT count AS push_count FROM push_budget WHERE k = 'own|client1'")[0]?.push_count).toBeLessThanOrEqual(MAX_PUSHES_PER_SOURCE_PER_WINDOW);
    expect(b.db.rows<{ push_suppressed: number }>("SELECT suppressed AS push_suppressed FROM push_budget WHERE k = 'own|client1'")[0]?.push_suppressed).toBe(MAX_OPEN_ALERTS_PER_PROJECT - MAX_PUSHES_PER_SOURCE_PER_WINDOW); // only 50 of its 200 alerts were kept (per-project cap), 3 were pushed, the rest summarised
  });
});

// ── C. a spent budget is never silent ────────────────────────────────────────

describe("C. write-budget exhaustion is visible, and critical halts still get through", () => {
  async function bootHost() {
    const t = makeEnv();
    const push = await setupPush(t);
    const ctx = makeCtx();
    const token = await addSource(t.db, "hosta", "host");
    const post = async (path: string, body: unknown, now = NOW) => {
      const res = await route(request(path, { token, body }), t.env, ctx, { now, fetch: push.fetch });
      await ctx.flush();
      return res;
    };
    const events = (list: unknown[]) => ({ v: 1, host: "hosta", project: "proja", events: list });
    const status = (i: number) => ({ kind: "status", origin: ORIGIN_HOST, at: NOW - 1000, severity: "info", key: `s${i}`, agent: "Agent01", status: "IN_PROGRESS", text: "working" });
    const halt = (i: number, scenario = "benched") => ({ kind: "halt", origin: ORIGIN_HOST, at: NOW - 1000, severity: "critical", key: `h${i}`, agent: `Agent0${i}`, scenario, text: `Agent0${i} ${scenario}` });
    const spend = (n = MAX_HOST_WRITES_PER_DAY, w = NOW - 1000) => t.db.sqlite.query("UPDATE sources SET wr_count = ?, wr_window_start = ? WHERE name = 'hosta'").run(n, w);
    const cron = async (now: number) => {
      await runCron(t.env, ctx, now, { fetch: push.fetch });
      await ctx.flush();
    };
    const alerts = () => t.db.rows<any>("SELECT key, rule, severity, origin, push_count, resolved FROM alerts ORDER BY key");
    return { ...t, ctx, push, token, post, events, status, halt, spend, cron, alerts };
  }

  test("the first refusal of a window opens a critical budget-exhausted alert for the host, pushed once; the heartbeat says so", async () => {
    const b = await bootHost();
    b.spend();
    const res = await b.post("/api/ingest/events", b.events([b.status(1)]));
    expect(res.status).toBe(429);
    expect(b.alerts()).toEqual([{ key: "budget-exhausted|hosta", rule: "budget-exhausted", severity: "critical", origin: ORIGIN_HOST, push_count: 1, resolved: null }]);
    expect(b.push.pushes).toHaveLength(1);
    const text = b.db.rows<{ text: string }>("SELECT text FROM alerts")[0]?.text ?? "";
    expect(text).toContain("Write budget exhausted for host hosta");
    expect(text).toContain("critical halts are still accepted");
    // retries: no second alert, no second push, and not even a write
    b.db.statements.length = 0;
    for (let i = 0; i < 5; i++) expect((await b.post("/api/ingest/events", b.events([b.status(i + 2)]))).status).toBe(429);
    expect(b.push.pushes).toHaveLength(1);
    expect(b.db.statements.some((s) => /^\s*(INSERT INTO (?!hosts)|UPDATE sources SET budget_until|DELETE)/i.test(s))).toBe(false); // (the hosts upsert is the throttled liveness touch)
    // the host is "online" through its heartbeat, which now carries the flag
    const hb = (await (await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: NOW })).json()) as any;
    expect(hb).toMatchObject({ ok: true, budgetExhausted: true });
    expect(hb.budgetUntil).toBe(NOW - 1000 + DAY);
    // /api/state shows it in the inbox
    const s = (await (await route(request("/api/state"), b.env, b.ctx, { now: NOW })).json()) as any;
    expect(s.inbox.map((a: any) => a.key)).toContain("budget-exhausted|hosta");
  });

  test("a refused snapshot is flagged the same way", async () => {
    const b = await bootHost();
    b.spend();
    const snap = { v: 1, host: "hosta", project: "proja", sentAt: NOW, poller: { status: "running", lastPoll: NOW, startedAt: NOW - 1000 }, agents: [{ name: "Agent01", state: "idle" }], tasks: [], discussions: [], approvals: [] };
    expect((await b.post("/api/ingest/snapshot", snap)).status).toBe(429);
    expect(b.alerts().map((a: any) => a.key)).toEqual(["budget-exhausted|hosta"]);
  });

  test("it resolves when the window resets (cron, no request needed) and the heartbeat flag goes away", async () => {
    const b = await bootHost();
    b.spend();
    await b.post("/api/ingest/events", b.events([b.status(1)]));
    const until = NOW - 1000 + DAY;
    await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: until - MIN }, until - MIN); // keeps the host itself out of host-offline
    await b.cron(until - MIN);
    expect(b.alerts().find((a: any) => a.key === "budget-exhausted|hosta")?.resolved).toBeNull();
    await b.cron(until + MIN);
    expect(b.alerts().find((a: any) => a.key === "budget-exhausted|hosta")?.resolved).toBe(until + MIN);
    const hb = (await (await b.post("/api/ingest/heartbeat", { v: 1, host: "hosta", at: until + MIN }, until + MIN)).json()) as any;
    expect(hb).toEqual({ ok: true });
    // and writes are accepted again in the new window
    expect((await b.post("/api/ingest/events", b.events([b.status(9)]), until + 2 * MIN)).status).toBe(200);
  });

  test("critical halts are accepted over budget (and only they), under their own cap, and they raise their alerts", async () => {
    const b = await bootHost();
    b.spend();
    const res = await b.post("/api/ingest/events", b.events([b.status(1), b.halt(2), b.status(3), b.halt(4, "cli-gone"), b.halt(5, "usage-limit"), b.status(6)]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 3, budgetExhausted: true, budgetDropped: 3 });
    expect(b.db.rows<{ key: string }>("SELECT key FROM events ORDER BY key").map((r) => r.key)).toEqual(["h2", "h4", "h5"]);
    expect(b.alerts().map((a: any) => a.key)).toEqual([
      "agent-stuck|hosta|proja|agent02|benched",
      "agent-stuck|hosta|proja|agent04|cli-gone",
      "budget-exhausted|hosta",
      "usage-limit|hosta|proja|agent05",
    ]);
    // the allowance is a separate counter, charged per halt
    expect(b.db.rows<{ hl_count: number }>("SELECT hl_count FROM sources")[0]?.hl_count).toBe(3);
    // nothing but halts: no relay rows, no non-critical events
    expect(b.db.rows("SELECT * FROM tasks")).toEqual([]);
  });

  test("the critical-halt allowance is MAX_CRITICAL_HALTS_PER_DAY a window: a batch is cut to what is left, then 429", async () => {
    const b = await bootHost();
    b.spend();
    b.db.sqlite.query("UPDATE sources SET hl_count = ?, hl_window_start = ? WHERE name = 'hosta'").run(MAX_CRITICAL_HALTS_PER_DAY - 2, NOW - 1000);
    const res = await b.post("/api/ingest/events", b.events([b.halt(1), b.halt(2), b.halt(3)]));
    expect(await res.json()).toMatchObject({ accepted: 2, budgetDropped: 1 });
    expect(b.db.rows<{ hl_count: number }>("SELECT hl_count FROM sources")[0]?.hl_count).toBe(MAX_CRITICAL_HALTS_PER_DAY);
    expect((await b.post("/api/ingest/events", b.events([b.halt(4)]))).status).toBe(429);
    // a new 24 h window restores the allowance (and the write budget)
    expect((await b.post("/api/ingest/events", b.events([b.halt(5)]), NOW - 1000 + DAY)).status).toBe(200);
    expect(b.db.rows<{ hl_count: number }>("SELECT hl_count FROM sources")[0]?.hl_count).toBe(MAX_CRITICAL_HALTS_PER_DAY); // the normal path again: the allowance row is left alone (its stale window is ignored next time)
  });

  test("with the budget NOT spent a halt takes the normal path and does not touch the allowance", async () => {
    const b = await bootHost();
    expect((await b.post("/api/ingest/events", b.events([b.halt(1)]))).status).toBe(200);
    expect(b.db.rows<{ hl_count: number; budget_until: number }>("SELECT hl_count, budget_until FROM sources")[0]).toEqual({ hl_count: 0, budget_until: 0 });
    expect(b.alerts().map((a: any) => a.key)).toEqual(["agent-stuck|hosta|proja|agent01|benched"]);
  });

  test("only the scenarios the pusher announces count as critical halts", async () => {
    const b = await bootHost();
    b.spend();
    const odd = { ...b.halt(1, "turn-skipped") }; // a halt the rules never alert on is not a reason to bypass the budget
    expect(PUSH_HALT_SCENARIOS).not.toContain("turn-skipped");
    expect((await b.post("/api/ingest/events", b.events([odd]))).status).toBe(429);
  });

  test("a client's spent MCP budget is an inbox item (warn, via <client>), never a push, and resolves with the window", async () => {
    const t = makeEnv();
    const push = await setupPush(t);
    const ctx = makeCtx();
    const token = await addSource(t.db, "client1", "client");
    t.db.sqlite.query("UPDATE sources SET mut_count = ?, mut_window_start = ? WHERE name = 'client1'").run(MAX_MCP_MUTATIONS_PER_DAY, NOW - 1000);
    const call = (now: number) =>
      route(request("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_task", arguments: { project: "p", title: "x", status: "IN_PROGRESS" } } } }), t.env, ctx, { now, fetch: push.fetch });
    const r = (await (await call(NOW)).json()) as any;
    expect(r.result.isError).toBe(true);
    await ctx.flush();
    expect(t.db.rows<any>("SELECT key, rule, severity, origin, push_count FROM alerts")).toEqual([{ key: "budget-exhausted|client1", rule: "budget-exhausted", severity: "warn", origin: "mcp", push_count: 0 }]);
    expect(t.db.rows<{ text: string }>("SELECT text FROM alerts")[0]?.text).toMatch(/^MCP budget exhausted for client client1: .* · via client1$/);
    await runCron(t.env, ctx, NOW + 5 * MIN, { fetch: push.fetch });
    await ctx.flush();
    expect(push.pushes).toHaveLength(0); // no push, ever
    const until = NOW - 1000 + DAY;
    await runCron(t.env, ctx, until + MIN, { fetch: push.fetch });
    await ctx.flush();
    expect(t.db.rows<{ resolved: number | null }>("SELECT resolved FROM alerts")).toEqual([{ resolved: until + MIN }]);
    expect(push.pushes).toHaveLength(0);
  });
});

describe("the UI shows what the server could not read completely", () => {
  const pub = (f: string) => readFileSync(join(import.meta.dir, "..", "public", f), "utf8");
  test("a warning banner is wired to rulesTruncated (markup, rendering, style) and the new rule has a label", () => {
    expect(pub("index.html")).toContain('id="rules-warning"');
    const js = pub("app.js");
    expect(js).toContain("s.rulesTruncated");
    expect(js).toContain('$("rules-warning")');
    expect(js).toContain('"budget-exhausted": "Budget exhausted"');
    expect(pub("style.css")).toContain(".banner.warn");
  });

  test("/api/state reports an empty rulesTruncated on a healthy system", async () => {
    const b = await bootRules();
    expect((await b.state()).rulesTruncated).toEqual([]);
  });
});

