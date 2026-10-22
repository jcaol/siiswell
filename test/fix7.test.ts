// Fix round 7 (reproduce first, then fix):
//  K. push-budget keys are typed and escaped: no host label / client name / sender / agent can spell another source's key;
//  C. alert caps per OWNER: one host cannot spread alerts over projects to defeat them, a relayed sender cannot evict a
//     host's own alerts, criticals are capped too (never dropped silently), and nothing of it reaches another source;
//  P. every table a source can write to is purged (never-claimed budget rows after 1 h, open alerts after the retention
//     period) and stays bounded by its owner's budgets in the meantime;
//  B. the host write budget charges what D1 bills (a snapshot is ONE row) and grows with the host's projects;
//  G. a scan that hits its GLOBAL limit freezes only the hosts it did not read, not every host;
//  T. ingest-triggered rule evaluations are throttled per source; the reads a poll or an evaluation costs are bounded.
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { RULE_ALERT_LIMIT, RULE_EVENT_LIMIT, RULE_PART_ALERTS, RULE_SNAPSHOT_LIMIT, RULE_TASK_LIMIT, PUSH_BUDGET_IDLE_MS, PUSH_BUDGET_UNCLAIMED_GRACE_MS, loadRuleInput, purgeOld, SQL_RULE_ALERTS } from "../src/alerts";
import { DAY_MS, PUSH_TOUCH_EVERY_MS, claimPushSlots, ensurePushBudgets } from "../src/budget";
import {
  EVAL_MIN_INTERVAL_MS,
  HOST_WRITES_BASE,
  HOST_WRITES_PER_PROJECT,
  MAX_HOST_WRITES_PER_DAY,
  MAX_OPEN_ALERTS_PER_HOST,
  MAX_OPEN_ALERTS_PER_PROJECT,
  MAX_OPEN_CRITICAL_ALERTS_PER_HOST,
  MAX_STATE_ALERTS_PER_HOST,
  WRITE_COST,
  evalMinIntervalMs,
  hostWriteBudget,
} from "../src/env";
import { route, runCron } from "../src/index";
import { budgetKey, decodeBudgetKey, escapeKeyPart, unescapeKeyPart, type BudgetKind } from "../src/keys";
import { flushPushSummaries, pushPlan } from "../src/push";
import { evaluateRules, type RuleAlert, type RuleInput, type RuleTask } from "../src/rules";
import { ALERT_DEFAULTS } from "../src/shared/schema";
import { addSource, makeCtx, makeEnv, request, setupPush, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown, id = 1) => rpc("tools/call", { name, arguments: args }, id);

/** An env with a host token, push configured, and posting helpers. `over` replaces env values (e.g. the evaluation throttle). */
async function bootHost(name = "evil", over: Parameters<typeof makeEnv>[0] = {}) {
  const t = makeEnv(over);
  const push = await setupPush(t);
  const ctx = makeCtx();
  const tokens: Record<string, string> = { [name]: await addSource(t.db, name, "host") };
  const as = (who: string) => async (path: string, body: unknown, now = NOW) => {
    const res = await route(request(path, { token: tokens[who], body }), t.env, ctx, { now, fetch: push.fetch });
    await ctx.flush();
    return res;
  };
  const post = as(name);
  const cron = async (now: number) => {
    await runCron(t.env, ctx, now, { fetch: push.fetch });
    await ctx.flush();
  };
  const addHost = async (who: string, kind: "host" | "client" = "host") => {
    tokens[who] = await addSource(t.db, who, kind);
    return as(who);
  };
  const open = (like: string) => t.db.rows<{ key: string }>("SELECT key FROM alerts WHERE resolved IS NULL AND key LIKE ?", like).map((r) => r.key);
  const count = (table: string, where = "1") => t.db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0]?.n ?? 0;
  const state = async (now = NOW) => (await (await route(new Request("http://localhost:8787/api/state"), t.env, makeCtx(), { now })).json()) as { inbox: Array<{ key: string; host: string }>; rulesTruncated: string[]; truncated: string[] };
  return { ...t, ctx, push, tokens, post, as, cron, addHost, open, count, state, name };
}

const halt = (host: string, project: string, agent: string, at: number, key = `h-${project}-${agent}-${at}`) => ({
  v: 1, host, project, events: [{ kind: "halt", origin: ORIGIN_HOST, at, severity: "critical", key, scenario: "cli-gone", agent, text: `${agent} gone` }],
});

// ── K. budget keys ───────────────────────────────────────────────────────────

describe("K. push-budget keys: typed, escaped, owner in its own column", () => {
  // every name an attacker could pick for a host label, client, sender or agent, including ones that spell other keys
  const NAMES = ["all", "crit", "relay", "own", "rs", "rt", "ct", "ca", "grp", "grc", "all|x", "a|b", "%", "%7C", "%25", "x%7Cy", "@bot:srv", "victim", "evil", "a", "h|", "|h", "constructor", "__proto__"];
  const ARITY: Array<[BudgetKind, number]> = [["own", 1], ["rt", 1], ["ct", 1], ["all", 1], ["grp", 1], ["grc", 1], ["rs", 2], ["ca", 2]];

  test("two different (kind, parts) tuples never spell the same key, and a key reads back as it was built", () => {
    const seen = new Map<string, string>();
    let tuples = 0;
    for (const [kind, arity] of ARITY) {
      const parts = arity === 1 ? NAMES.map((n) => [n]) : NAMES.flatMap((a) => NAMES.map((b) => [a, b]));
      for (const p of parts) {
        tuples++;
        const key = budgetKey(kind, ...p);
        const was = seen.get(key);
        expect(was).toBeUndefined(); // no collision with any other tuple, of any kind
        seen.set(key, JSON.stringify([kind, ...p]));
        expect(decodeBudgetKey(key)).toEqual({ kind, parts: p });
        expect(key.split("|")).toHaveLength(1 + arity); // the separator is never inside a part
      }
    }
    expect(seen.size).toBe(tuples);
    expect(tuples).toBe(6 * NAMES.length + 2 * NAMES.length * NAMES.length);
  });

  test("the escape is a bijection; strings that are not our keys do not decode", () => {
    for (const n of NAMES) expect(unescapeKeyPart(escapeKeyPart(n))).toBe(n);
    for (const bad of ["", "all", "own|a|b", "rs|a", "ca|a|b|c", "unknown|x", "constructor|x", "__proto__|x", "toString|x"]) expect(decodeBudgetKey(bad)).toBeNull();
  });

  test("probe K1: host 'all' with relay sender 'victim' no longer spells the daily total of the client 'victim' (and 'crit' / 'relay' collide no more)", () => {
    const relay = pushPlan({ origin: ORIGIN_RELAY, severity: "warn", host: "all", sender: "victim", agent: null });
    const victim = pushPlan({ origin: "mcp", severity: "warn", host: "victim", sender: null, agent: null });
    expect(relay.keys.map((k) => k.key)).toEqual(["rs|all|victim", "rt|all", "all|all"]);
    expect(victim.keys.map((k) => k.key)).toEqual(["own|victim", "all|victim"]);
    expect(relay.keys.filter((k) => victim.keys.some((v) => v.key === k.key))).toEqual([]);
    // the other collision: host `crit` relaying for sender `relay` vs the critical budget of host `relay`
    const a = pushPlan({ origin: ORIGIN_RELAY, severity: "warn", host: "crit", sender: "relay", agent: null });
    const b = pushPlan({ origin: ORIGIN_HOST, severity: "critical", host: "relay", sender: null, agent: "x" });
    expect(a.keys.filter((k) => b.keys.some((v) => v.key === k.key))).toEqual([]);
  });

  test("across every plan: one key, one owner; plans of different owners share no key; the owner is the plan's owner", () => {
    const owners = new Map<string, string>();
    const plans: Array<ReturnType<typeof pushPlan>> = [];
    for (const host of NAMES) for (const sender of [null, ...NAMES.slice(0, 8)]) for (const agent of [null, "x", "a|b"]) {
      for (const [origin, severity] of [[ORIGIN_HOST, "critical"], [ORIGIN_HOST, "warn"], [ORIGIN_RELAY, "warn"], ["mcp", "warn"]] as const) {
        plans.push(pushPlan({ origin, severity, host, sender: origin === ORIGIN_RELAY ? sender : null, agent }));
      }
    }
    for (const p of plans) {
      for (const k of p.keys) {
        expect(k.owner).toBe(p.owner);
        expect(owners.get(k.key) ?? p.owner).toBe(p.owner); // a key is never claimed by two owners
        owners.set(k.key, p.owner);
      }
      expect(p.keys.at(-1)?.key).toBe(budgetKey("all", p.owner)); // every plan ends in the owner's own daily total
    }
  });

  test("end to end: host 'all' relaying for 'victim' spends its own budget, the client 'victim' keeps its whole one", async () => {
    const b = await bootHost("all");
    const client = await b.addHost("victim", "client");
    // host `all`: five relay BLOCKED alerts from the sender `victim` (5 projects)
    for (let p = 0; p < 5; p++) {
      const ev = { kind: "status", origin: ORIGIN_RELAY, at: NOW - 1000, key: `r${p}`, status: "BLOCKED", text: "STATUS: BLOCKED", sender: "victim", agent: "claude@victim" };
      await b.post("/api/ingest/events", { v: 1, host: "all", project: `p${p}`, events: [ev] }, NOW + p * SEC);
    }
    const before = b.push.pushes.length;
    expect(before).toBeGreaterThan(0);
    const rows = b.db.rows<{ k: string; owner: string; count: number }>("SELECT k, owner, count FROM push_budget ORDER BY k");
    expect(rows.map((r) => r.k)).toEqual(["all|all", "rs|all|victim", "rt|all"]);
    expect(rows.every((r) => r.owner === "all")).toBe(true);
    // the client `victim` now raises three alerts of its own: all three are pushed, from its own budget and its own total
    for (let i = 0; i < 3; i++) await client("/mcp", call("report_task", { project: "p", title: `t${i}`, status: "BLOCKED" }), NOW + 10 * SEC + i);
    expect(b.push.pushes.length).toBe(before + 3);
    expect(b.db.rows("SELECT k, owner, count FROM push_budget WHERE owner = 'victim' ORDER BY k")).toEqual([
      { k: "all|victim", owner: "victim", count: 3 },
      { k: "own|victim", owner: "victim", count: 3 },
    ]);
  });

  test("the OWNER COLUMN decides, never the key text: a summary is charged to the row's owner, and ensure does not re-assign it", async () => {
    const b = await bootHost();
    const ins = b.db.sqlite.query("INSERT INTO push_budget (k, owner, window_start, suppressed, touched) VALUES (?, ?, ?, ?, ?)");
    ins.run("own|victim", "evil", NOW - HOUR, 2, NOW - HOUR); // a row whose key spells `victim` but whose owner is `evil`
    await flushPushSummaries(b.env, NOW, b.push.fetch);
    expect(b.push.pushes).toHaveLength(1);
    expect(b.db.rows("SELECT k, count FROM push_budget WHERE k LIKE 'all|%'")).toEqual([{ k: "all|evil", count: 1 }]); // `all|victim` was never touched
    // ensure keeps the owner of an existing row
    b.db.sqlite.query("INSERT INTO push_budget (k, owner, touched) VALUES ('rs|a|b', 'a', ?)").run(NOW - HOUR);
    await ensurePushBudgets(b.env.DB, [{ key: "rs|a|b", owner: "zzz", limits: { windowMs: 600_000, perWindow: 3, dayMs: DAY, perDay: 30 } }], NOW);
    expect(b.db.rows("SELECT owner FROM push_budget WHERE k = 'rs|a|b'")).toEqual([{ owner: "a" }]);
    // and a row cannot exist without an owner at all
    expect(() => b.db.sqlite.query("INSERT INTO push_budget (k) VALUES ('own|nobody')").run()).toThrow(/NOT NULL/);
  });
});

// ── C. alert caps per owner ──────────────────────────────────────────────────

const rtask = (over: Partial<RuleTask> & { key: string }): RuleTask => ({
  origin: ORIGIN_HOST, host: "h", project: "p", agent: "a", task_id: "T", title: "t", state: "blocked", eta_at: null, last_line: null, created: NOW - 2 * HOUR, updated: NOW - HOUR, ...over,
});
const input = (over: Partial<RuleInput> = {}): RuleInput => ({ now: NOW, snapshots: [], hosts: [], tasks: [], events: [], alerts: [], ...over });
const openRow = (key: string, rule: string, over: Partial<RuleAlert> = {}): RuleAlert => ({ key, rule, last_pushed: NOW - HOUR, push_count: 1, opened: NOW - HOUR, resolved: null, host: "h", origin: ORIGIN_HOST, ...over });

describe("C. alert caps per owner (host label / client name)", () => {
  test("probe A1: 30 projects x 20 old approvals no longer make 600 open alerts: the host keeps its newest MAX_OPEN_ALERTS_PER_HOST, one notice says so, the other host is untouched and visible", async () => {
    const b = await bootHost("evil");
    const good = await b.addHost("good");
    for (let p = 0; p < 30; p++) {
      const approvals = Array.from({ length: 20 }, (_, i) => ({ id: `a${p}-${i}`, summary: "x", requestedAt: NOW - 10 * MIN - p * SEC }));
      await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: `p${p}`, approvals } as never, NOW), NOW + p);
    }
    await good("/api/ingest/snapshot", snapshot({ host: "good", project: "g", approvals: [{ id: "legit", summary: "rm -rf build", requestedAt: NOW - 10 * MIN }] } as never, NOW), NOW + 40);
    await b.cron(NOW + 2 * MIN);
    expect(b.open("approval-waiting|evil|%")).toHaveLength(MAX_OPEN_ALERTS_PER_HOST); // not 600
    expect(b.db.rows("SELECT key, severity FROM alerts WHERE rule = 'alerts-capped' AND resolved IS NULL")).toEqual([{ key: "alerts-capped|evil|!all", severity: "warn" }]);
    expect(b.db.rows<{ text: string }>("SELECT text FROM alerts WHERE key = 'alerts-capped|evil|!all'")[0]?.text).toContain("400 alerts over the limit of 200");
    expect(b.open("approval-waiting|good|%")).toEqual(["approval-waiting|good|g|legit"]);
    const s = await b.state(NOW + 2 * MIN);
    expect(s.rulesTruncated).toEqual([]); // nothing is cut off any more
    expect(s.inbox.filter((a) => a.host === "good")).toHaveLength(1); // evil's flood does not push the other host out of the inbox
    // and the flood can be cleaned up: when evil's approvals go, they ALL resolve (nothing is frozen)
    for (let p = 0; p < 30; p++) await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: `p${p}`, approvals: [] } as never, NOW + 3 * MIN), NOW + 3 * MIN + p);
    await b.cron(NOW + 4 * MIN);
    expect(b.open("%|evil|%")).toEqual([]);
  });

  test("the worst case of ONE host token (30 projects x (20 approvals + 20 agents at the usage limit) + 200 blocked tasks) stays under the per-host scan limit", async () => {
    const b = await bootHost("evil");
    for (let p = 0; p < 30; p++) {
      const agents = Array.from({ length: 20 }, (_, i) => ({ name: `a${i}`, state: "usage-limit", stateSince: NOW - p * 1000 - i }));
      const approvals = Array.from({ length: 20 }, (_, i) => ({ id: `a${p}-${i}`, summary: "x", requestedAt: NOW - 10 * MIN }));
      const tasks = p < 20 ? Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, agent: `agent${i}`, title: "x", state: "blocked", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000 })) : [];
      await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: `p${p}`, agents, approvals, tasks } as never, NOW), NOW + p);
    }
    await b.cron(NOW + 2 * MIN);
    const openAll = b.count("alerts", "resolved IS NULL");
    const crit = b.count("alerts", "resolved IS NULL AND rule = 'usage-limit'");
    expect(crit).toBe(MAX_OPEN_CRITICAL_ALERTS_PER_HOST); // fix6: 600
    expect(b.count("alerts", "resolved IS NULL AND rule IN ('approval-waiting', 'blocked')")).toBeLessThanOrEqual(MAX_OPEN_ALERTS_PER_HOST);
    expect(openAll).toBeLessThan(RULE_PART_ALERTS - 50); // well inside the per-host scan limit (fix6: 1,030 open, scan limit 800)
    expect((await loadRuleInput(b.env.DB, NOW + 2 * MIN)).truncatedParts.alerts).toBeUndefined();
    expect((await b.state(NOW + 2 * MIN)).rulesTruncated).toEqual([]);
  });

  test("a relayed foreign agent can never push a host's OWN alerts out, however fresh its timestamps (own first, then newest)", () => {
    const own = (project: string, i: number) => rtask({ key: `h|${project}|T${i}`, project, task_id: `T${i}`, agent: `a${i}`, updated: NOW - 3 * HOUR + i });
    const foreign = (i: number) => rtask({ key: `relay|h|rp|@bot${i}:srv`, origin: ORIGIN_RELAY, project: "rp", task_id: `@bot${i}:srv`, agent: `claude@bot${i}`, updated: NOW - 1000 - i }); // far newer
    // the host's own 4 x 50 = 200 alerts fill the host cap; 40 fresher relayed ones must lose, not win
    const tasks = [...["p1", "p2", "p3", "p4"].flatMap((p) => Array.from({ length: 50 }, (_, i) => own(p, i))), ...Array.from({ length: 40 }, (_, i) => foreign(i))];
    const out = evaluateRules(input({ tasks }));
    expect(out.open.filter((a) => a.rule === "blocked" && a.origin === ORIGIN_HOST)).toHaveLength(200);
    expect(out.open.filter((a) => a.rule === "blocked" && a.origin === ORIGIN_RELAY)).toEqual([]);
    expect(out.open.find((a) => a.key === "alerts-capped|h|!all")?.text).toContain("40 alerts over the limit of 200");
    // inside ONE project the same rule holds: 50 own beat 10 fresher foreign ones
    const mixed = [...Array.from({ length: 50 }, (_, i) => own("p1", i)), ...Array.from({ length: 10 }, (_, i) => ({ ...foreign(i), project: "p1", key: `relay|h|p1|@bot${i}:srv` }))];
    const out2 = evaluateRules(input({ tasks: mixed }));
    expect(out2.open.filter((a) => a.rule === "blocked" && a.origin === ORIGIN_RELAY)).toEqual([]);
    expect(out2.open.filter((a) => a.rule === "blocked" && a.origin === ORIGIN_HOST)).toHaveLength(50);
  });

  test("criticals are capped per host too: the NEWEST MAX_OPEN_CRITICAL_ALERTS_PER_HOST stay, the rest are counted in one CRITICAL notice (never silently dropped, never pushed)", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({ key: `e${i}`, host: "h", project: "p", kind: "halt", agent: `a${i}`, scenario: "cli-gone", at: NOW - 2 * HOUR + i * 1000, text: "gone" }));
    const out = evaluateRules(input({ events, hosts: [{ host: "h", last_seen: NOW }] }));
    const kept = out.open.filter((a) => a.rule === "agent-stuck").map((a) => a.key);
    expect(kept).toHaveLength(MAX_OPEN_CRITICAL_ALERTS_PER_HOST);
    expect(kept).toContain("agent-stuck|h|p|a99|cli-gone"); // the newest
    expect(kept).not.toContain("agent-stuck|h|p|a0|cli-gone"); // the oldest is the one that is not shown
    const notice = out.open.find((a) => a.key === "alerts-capped|h|!critical");
    expect(notice).toMatchObject({ severity: "critical", rule: "alerts-capped" });
    expect(notice?.text).toContain("40 alerts older than the newest 60 critical alerts");
    expect(out.push.some((p) => p.rule === "alerts-capped")).toBe(false);
    // host-offline and budget-exhausted are never counted, whatever the cap holds
    const out2 = evaluateRules(input({ events, hosts: [{ host: "h", last_seen: NOW - HOUR }], budgets: [{ name: "h", kind: "host", budget_until: NOW + HOUR }] }));
    expect(out2.open.map((a) => a.key)).toContain("host-offline|h");
    expect(out2.open.map((a) => a.key)).toContain("budget-exhausted|h");
    // and it is STABLE: with the 60 kept ones open and the 40 evicted ones resolved a minute ago, nothing changes
    const state: RuleAlert[] = [
      ...out.open.filter((a) => a.rule === "agent-stuck").map((a) => openRow(a.key, "agent-stuck", { opened: NOW, since: events.find((e) => a.key.includes(`|${e.agent}|`))?.at })),
      ...events.slice(0, 40).map((e) => openRow(`agent-stuck|h|p|${e.agent}|cli-gone`, "agent-stuck", { opened: NOW - 2 * HOUR, resolved: NOW - MIN })),
      openRow("alerts-capped|h|!critical", "alerts-capped"),
    ];
    const again = evaluateRules(input({ events, hosts: [{ host: "h", last_seen: NOW }], alerts: state, now: NOW + MIN }));
    expect(again.open.filter((a) => a.rule === "agent-stuck")).toEqual([]);
    expect(again.resolve.filter((k) => k.startsWith("agent-stuck"))).toEqual([]);
  });

  test("an open alert whose inputs were cut off still holds its slot: a flood that outruns the halt-event scan cannot grow the table past the cap", () => {
    // 60 old criticals are open; the host has more than RULE_PART_EVENTS halt events, so agent-stuck cannot be resolved (blind) ...
    const old: RuleAlert[] = Array.from({ length: 60 }, (_, i) => openRow(`agent-stuck|h|p|old${i}|cli-gone`, "agent-stuck", { project: "p", opened: NOW - 3 * HOUR + i, since: NOW - 3 * HOUR + i }));
    // ... and 20 NEWER halts arrive
    const events = Array.from({ length: 20 }, (_, i) => ({ key: `n${i}`, host: "h", project: "p", kind: "halt", agent: `new${i}`, scenario: "cli-gone", at: NOW - 1000 + i, text: "gone" }));
    const out = evaluateRules(input({ events, alerts: old, hosts: [{ host: "h", last_seen: NOW }], truncatedParts: { events: ["h"] } }));
    expect(out.open.filter((a) => a.rule === "agent-stuck")).toHaveLength(20); // the 20 newer ones open ...
    expect(out.resolve.filter((k) => k.startsWith("agent-stuck|h|p|old"))).toHaveLength(20); // ... and the 20 OLDEST open ones make room
    expect(out.resolve).toContain("agent-stuck|h|p|old0|cli-gone");
    expect(out.resolve).not.toContain("agent-stuck|h|p|old59|cli-gone");
  });

  test("another source's alerts are out of reach: a host cannot post for another host label, an MCP client's alerts live under its own name", async () => {
    const b = await bootHost("evil");
    const client = await b.addHost("client1", "client");
    const res = await b.post("/api/ingest/events", halt("good", "p", "claude", NOW - 1000), NOW);
    expect(res.status).toBe(403); // the host label is bound to the token
    expect(b.count("alerts") + b.count("events")).toBe(0);
    await client("/mcp", call("report_task", { project: "p", title: "x", status: "BLOCKED" }), NOW);
    expect(b.db.rows("SELECT DISTINCT host, origin FROM alerts")).toEqual([{ host: "client1", origin: "mcp" }]);
    // a flood of the host's own cannot evict the client's alert (separate owners, separate caps)
    for (let p = 0; p < 30; p++) await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: `p${p}`, approvals: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, summary: "x", requestedAt: NOW - 10 * MIN })) } as never, NOW), NOW + p);
    await b.cron(NOW + 2 * MIN);
    expect(b.open("blocked|client1|%")).toHaveLength(1);
  });

  test("the inbox is read per host: a host with hundreds of open alerts shows its newest MAX_STATE_ALERTS_PER_HOST, the others are all there, and the cut is announced", async () => {
    const b = await bootHost("evil");
    b.db.sqlite.exec("BEGIN");
    const ins = b.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened) VALUES (?, 'blocked', 'warn', '" + ORIGIN_HOST + "', ?, 'p', 'x', ?)");
    for (let i = 0; i < 500; i++) ins.run(`blocked|evil|p|T-${i}`, "evil", NOW - i * 1000); // NEWER than good's
    for (let i = 0; i < 3; i++) ins.run(`blocked|good|p|T-${i}`, "good", NOW - HOUR - i * 1000);
    b.db.sqlite.exec("COMMIT");
    const s = await b.state();
    expect(s.inbox.filter((a) => a.host === "good")).toHaveLength(3); // a plain "newest 200 of all" would have shown none of them
    expect(s.inbox.filter((a) => a.host === "evil")).toHaveLength(MAX_STATE_ALERTS_PER_HOST);
    expect(s.truncated).toContain("inbox");
  });
});

// ── P. purge and bounded tables ──────────────────────────────────────────────

const budgetRow = (db: D1Shim, k: string, owner: string, over: { touched?: number; day_start?: number; suppressed?: number; window_start?: number } = {}) =>
  db.sqlite.query("INSERT INTO push_budget (k, owner, touched, day_start, suppressed, window_start) VALUES (?, ?, ?, ?, ?, ?)").run(k, owner, over.touched ?? 0, over.day_start ?? 0, over.suppressed ?? 0, over.window_start ?? 0);

describe("P. purge: every table a source can write to is bounded", () => {
  test("probe P3: a budget row nobody claimed is purged after one hour; one claimed lately, or touched lately, is not; a held-back summary waits for the retention period", async () => {
    const { db } = makeEnv();
    budgetRow(db, "own|never-old", "a", { touched: NOW - 2 * HOUR }); // ensured long ago, never claimed
    budgetRow(db, "own|never-new", "a", { touched: NOW - 30 * MIN }); // a dispatch may be about to claim it
    budgetRow(db, "own|claimed-idle", "a", { touched: NOW - 3 * DAY, day_start: NOW - 3 * DAY });
    budgetRow(db, "own|claimed-lately", "a", { touched: NOW - DAY, day_start: NOW - DAY });
    budgetRow(db, "own|owed-summary", "a", { touched: NOW - 5 * DAY, day_start: NOW - 5 * DAY, suppressed: 3 });
    budgetRow(db, "own|owed-forever", "a", { touched: NOW - 40 * DAY, day_start: NOW - 40 * DAY, suppressed: 3 });
    const removed = await purgeOld(db as unknown as D1Database, NOW, ALERT_DEFAULTS.retentionDays);
    expect(removed.pushBudget).toBe(3);
    expect(db.rows<{ k: string }>("SELECT k FROM push_budget ORDER BY k").map((r) => r.k)).toEqual(["own|claimed-lately", "own|never-new", "own|owed-summary"]);
    expect(PUSH_BUDGET_UNCLAIMED_GRACE_MS).toBe(HOUR);
    expect(PUSH_BUDGET_IDLE_MS).toBe(2 * DAY);
  });

  test("the purge cannot take a row between its ensure and its claim: a row that is ensured is touched, and a stale never-claimed one is refreshed by the ensure", async () => {
    const b = await bootHost();
    const limits = { windowMs: 600_000, perWindow: 3, dayMs: DAY, perDay: 30 };
    // a brand-new row: ensure, then a purge at the same instant (and 50 minutes later), then the claim
    await ensurePushBudgets(b.env.DB, [{ key: "own|evil", owner: "evil", limits }, { key: "all|evil", owner: "evil", limits }], NOW);
    await purgeOld(b.env.DB, NOW + 50 * MIN, ALERT_DEFAULTS.retentionDays);
    expect(b.count("push_budget")).toBe(2);
    expect(await claimPushSlots(b.env.DB, ["own|evil", "all|evil"], NOW + 50 * MIN)).toBe(true);
    // an OLD never-claimed row (touched 2 h ago) that a dispatch ensures again is refreshed first, so the purge that follows keeps it
    budgetRow(b.db, "rs|evil|@x:y", "evil", { touched: NOW - 2 * HOUR });
    await ensurePushBudgets(b.env.DB, [{ key: "rs|evil|@x:y", owner: "evil", limits }], NOW);
    expect(b.db.rows("SELECT touched FROM push_budget WHERE k = 'rs|evil|@x:y'")).toEqual([{ touched: NOW }]);
    await purgeOld(b.env.DB, NOW, ALERT_DEFAULTS.retentionDays);
    expect(b.count("push_budget", "k = 'rs|evil|@x:y'")).toBe(1);
    // a row that is already fresh is not rewritten (no write on the hot path)
    const stamp = () => b.db.rows<{ touched: number }>("SELECT touched FROM push_budget WHERE k = 'own|evil'")[0]?.touched;
    const t0 = stamp();
    await ensurePushBudgets(b.env.DB, [{ key: "own|evil", owner: "evil", limits }], (t0 as number) + PUSH_TOUCH_EVERY_MS - 1);
    expect(stamp()).toBe(t0);
    await ensurePushBudgets(b.env.DB, [{ key: "own|evil", owner: "evil", limits }], (t0 as number) + PUSH_TOUCH_EVERY_MS);
    expect(stamp()).toBe((t0 as number) + PUSH_TOUCH_EVERY_MS);
  });

  test("open alerts older than the retention period go too (a partition the rules can no longer see would keep them for ever); younger ones stay", async () => {
    const { db } = makeEnv();
    const ins = db.sqlite.query("INSERT INTO alerts (key, rule, severity, host, text, opened, resolved) VALUES (?, 'blocked', 'warn', 'gone', 'x', ?, ?)");
    ins.run("open-old", NOW - 31 * DAY, null);
    ins.run("open-new", NOW - 29 * DAY, null);
    ins.run("resolved-old", NOW - 40 * DAY, NOW - 31 * DAY);
    ins.run("resolved-new", NOW - 40 * DAY, NOW - DAY);
    const removed = await purgeOld(db as unknown as D1Database, NOW, ALERT_DEFAULTS.retentionDays);
    expect(removed).toMatchObject({ alerts: 1, openAlerts: 1 });
    expect(db.rows<{ key: string }>("SELECT key FROM alerts ORDER BY key").map((r) => r.key)).toEqual(["open-new", "resolved-new"]);
  });

  test("a 24 h flood of one host token and one client token leaves bounded tables, and 31 days later the purge has emptied every one of them", async () => {
    const b = await bootHost("evil");
    const client = await b.addHost("client1", "client");
    let t = NOW;
    // the host: 30 projects with snapshots (approvals, usage-limit agents, blocked tasks), relay chatter, fabricated critical agents
    for (let p = 0; p < 30; p++) {
      const agents = Array.from({ length: 20 }, (_, i) => ({ name: `a${i}`, state: "usage-limit", stateSince: NOW - i }));
      const approvals = Array.from({ length: 20 }, (_, i) => ({ id: `a${p}-${i}`, summary: "x", requestedAt: NOW - 10 * MIN }));
      const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, agent: `agent${i}`, title: "x", state: "blocked", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000 }));
      await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: `p${p}`, agents, approvals, tasks } as never, NOW), t++);
    }
    const relay = Array.from({ length: 60 }, (_, i) => ({ kind: "status", origin: ORIGIN_RELAY, at: NOW - 1000 + i, key: `r${i}`, status: "BLOCKED", text: "STATUS: BLOCKED", sender: `@fake${i % 20}:other.org`, agent: `claude@fake${i % 20}` }));
    await b.post("/api/ingest/events", { v: 1, host: "evil", project: "p0", events: relay }, t++);
    // the client: a few hundred mutations
    for (let i = 0; i < 300; i++) await client("/mcp", call("report_task", { project: "p", title: `t${i}`, status: i % 2 ? "BLOCKED" : "IN_PROGRESS" }), NOW + 60 + i * 100);
    for (let h = 0; h < 24; h++) {
      const evs = Array.from({ length: 40 }, (_, i) => ({ kind: "halt", origin: ORIGIN_HOST, at: NOW + h * HOUR + i, key: `h${h}-${i}`, scenario: "cli-gone", agent: `fake${h}x${i}`, text: "x" }));
      await b.post("/api/ingest/events", { v: 1, host: "evil", project: "p1", events: evs }, NOW + h * HOUR + 1000);
      for (const m of [1, 15, 30, 45]) await b.cron(NOW + h * HOUR + m * MIN);
    }
    await b.cron(NOW + 24 * HOUR);

    // bounded by the caps, whatever was sent
    expect(b.count("snapshots")).toBe(30);
    expect(b.count("hosts")).toBe(1);
    expect(b.count("alerts", "resolved IS NULL AND host = 'evil'")).toBeLessThan(RULE_PART_ALERTS - 50);
    expect(b.count("alerts", "resolved IS NULL AND host = 'client1'")).toBeLessThanOrEqual(MAX_OPEN_ALERTS_PER_HOST);
    expect(b.count("tasks", "origin = '" + ORIGIN_RELAY + "'")).toBeLessThanOrEqual(200);
    expect(b.count("push_budget")).toBeLessThan(150); // per owner: a handful of keys + one per critical alert that was really pushed
    const budgeted = (b.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'evil'")[0] as { wr_count: number }).wr_count;
    expect(b.count("events")).toBeLessThan(budgeted / WRITE_COST.event + 1); // rows are what the budget paid for
    const before = {
      events: b.count("events"), tasks: b.count("tasks"), alerts: b.count("alerts"), snapshots: b.count("snapshots"), hosts: b.count("hosts"), push_budget: b.count("push_budget"),
    };
    expect(Object.values(before).every((n) => n > 0)).toBe(true);

    // 31 days later nobody has written anything: the purge (a bounded batch per table and run) empties every table a source can write to
    const tables = ["events", "tasks", "alerts", "snapshots", "hosts", "push_budget"];
    for (let run = 0; run < 50 && tables.some((t) => b.count(t) > 0); run++) await purgeOld(b.env.DB, NOW + 55 * DAY, ALERT_DEFAULTS.retentionDays);
    for (const table of tables) expect([table, b.count(table)]).toEqual([table, 0]);
    expect(b.count("sources")).toBe(2); // the tokens themselves are the operator's
  }, 120_000);
});

// ── B. host write budget ─────────────────────────────────────────────────────

describe("B. host write budget: rows really written, scaled by the host's projects", () => {
  test("hostWriteBudget: a base, a step per project, a ceiling (one leaked token stays under half of the Free plan's 100 k writes a day)", () => {
    expect(hostWriteBudget(0)).toBe(HOST_WRITES_BASE);
    expect(hostWriteBudget(1)).toBe(30_000);
    expect(hostWriteBudget(2)).toBe(35_000);
    expect(hostWriteBudget(5)).toBe(MAX_HOST_WRITES_PER_DAY);
    expect(hostWriteBudget(8)).toBe(MAX_HOST_WRITES_PER_DAY);
    expect(hostWriteBudget(30)).toBe(MAX_HOST_WRITES_PER_DAY);
    expect(hostWriteBudget(-3)).toBe(HOST_WRITES_BASE);
    expect(MAX_HOST_WRITES_PER_DAY).toBe(50_000);
    expect(HOST_WRITES_BASE + 5 * HOST_WRITES_PER_PROJECT).toBe(MAX_HOST_WRITES_PER_DAY);
    for (let n = 0; n < 40; n++) expect(hostWriteBudget(n + 1)).toBeGreaterThanOrEqual(hostWriteBudget(n));
  });

  test("a host with five projects may spend what a one-project host may not", async () => {
    const ev = { kind: "status", origin: ORIGIN_HOST, at: NOW - 1000, severity: "info", key: "e1", agent: "A", status: "IN_PROGRESS", text: "x" };
    const spend = (db: D1Shim, n: number) => db.sqlite.query("UPDATE sources SET wr_count = ?, wr_window_start = ? WHERE name = 'evil'").run(n, NOW - 1000);
    const nearOne = hostWriteBudget(1) - WRITE_COST.request - WRITE_COST.event + 1; // one row short for a ONE-project host
    const one = await bootHost("evil");
    await one.post("/api/ingest/snapshot", snapshot({ host: "evil", project: "p0" } as never, NOW));
    spend(one.db, nearOne);
    const res1 = await one.post("/api/ingest/events", { v: 1, host: "evil", project: "p0", events: [ev] });
    expect(res1.status).toBe(429);
    expect(((await res1.json()) as { error: string }).error).toContain(`at most ${hostWriteBudget(1)} estimated row writes`);
    const five = await bootHost("evil");
    for (let p = 0; p < 5; p++) await five.post("/api/ingest/snapshot", snapshot({ host: "evil", project: `p${p}` } as never, NOW), NOW + p);
    spend(five.db, nearOne);
    expect((await five.post("/api/ingest/events", { v: 1, host: "evil", project: "p0", events: [ev] })).status).toBe(200);
    // ... up to the ceiling, not beyond
    spend(five.db, MAX_HOST_WRITES_PER_DAY - WRITE_COST.request - WRITE_COST.event + 1);
    expect((await five.post("/api/ingest/events", { v: 1, host: "evil", project: "p0", events: [{ ...ev, key: "e2" }] })).status).toBe(429);
  });

  test("a snapshot's size does not matter: 14 agents cost the same as 2, and a busy 8-project host stays about half of its budget at the pusher's maximum cadence (simulation)", async () => {
    const run = async (agentsN: number) => {
      const b = await bootHost("hosta");
      const T0 = Date.UTC(2027, 0, 15, 0, 0, 0);
      const agents = (m: number) => Array.from({ length: agentsN }, (_, i) => ({ name: `agent${i}`, baseCli: "claude", state: "working", stateSince: T0, contextTokens: 50_000 + m * 97 + i, contextPercent: 30 + (m % 50), usage: [{ label: "5h", usedPercent: m % 100, resetsAt: T0 + 5 * HOUR }, { label: "weekly", usedPercent: 40, resetsAt: T0 + 7 * DAY }], currentTaskId: `agent${i}-abc`, lastReplyAt: T0 + m * MIN }));
      const MINUTES = 60; // one hour, extrapolated to the day: the pusher sends a changed snapshot per project per minute
      const wrNow = () => (b.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'hosta'")[0] as { wr_count: number }).wr_count;
      let first = 0; // what the first minute cost (new projects, their task rows): paid once, not every minute
      for (let m = 0; m < MINUTES; m++) {
        for (let p = 0; p < 8; p++) {
          const tasks = Array.from({ length: 8 }, (_, k) => ({ id: `claude-${k}`, agent: "agent0", title: "task", state: k === 0 && m % 30 < 15 ? "running" : "done", dispatchedAt: T0 + k, updatedAt: T0 + k + (k === 0 ? Math.floor(m / 15) * 15 * MIN : 0) }));
          const res = await b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: `proj${p}`, agents: agents(m), tasks } as never, T0 + m * MIN), T0 + m * MIN + p);
          expect(res.status).toBe(200);
        }
        if (m === 0) first = wrNow();
        if (m % 15 === 14) await b.cron(T0 + m * MIN + 30 * SEC);
      }
      const storedBytes = (b.db.rows<{ n: number }>("SELECT AVG(LENGTH(json)) AS n FROM snapshots")[0] as { n: number }).n;
      return { perDay: first + ((wrNow() - first) / (MINUTES - 1)) * (1440 - 1), storedBytes };
    };
    const small = await run(2);
    const fat = await run(14);
    expect(fat.storedBytes).toBeGreaterThan(2 * 2048); // 14 agents: over 4 KB stored (fix6 charged 3 rows for it, so 4 with the request)
    expect(fat.perDay).toBeCloseTo(small.perDay, -3); // within a few hundred rows: the size is not what is charged
    expect(fat.perDay).toBeLessThan(0.6 * hostWriteBudget(8)); // well inside the budget (measured ~27 k of 50 k)
    expect(fat.perDay).toBeGreaterThan(0.3 * hostWriteBudget(8)); // and the simulation really is the busy case
  }, 120_000);
});

// ── G. global scan limits ────────────────────────────────────────────────────

const hostName = (i: number) => `h${String(i).padStart(2, "0")}`;

describe("G. a scan that hits its GLOBAL limit freezes only the hosts it did not read", () => {
  const addAlerts = (db: D1Shim, hosts: number, perHost: number, rule = "blocked") => {
    db.sqlite.exec("BEGIN");
    const ins = db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened) VALUES (?, ?, 'warn', '" + ORIGIN_HOST + "', ?, 'p', 'a', 'x', ?)");
    for (let h = 0; h < hosts; h++) for (let i = 0; i < perHost; i++) ins.run(`${rule}|${hostName(h)}|p|T-${i}`, rule, hostName(h), NOW - 3 * HOUR + i);
    db.sqlite.exec("COMMIT");
  };
  const addHosts = (db: D1Shim, n: number) => {
    for (let h = 0; h < n; h++) db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES (?, ?)").run(hostName(h), NOW);
  };

  test("probe G5: 8 full hosts (300 open alerts each) are all read, all evaluate, and a 9th host's approval still opens", async () => {
    const { env, db } = makeEnv();
    addAlerts(db, 8, 300);
    addHosts(db, 9);
    const s = snapshot({ host: hostName(8), project: "z", approvals: [{ id: "legit", summary: "rm -rf build", requestedAt: NOW - 10 * MIN }] } as never, NOW);
    db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', ?, 'z', ?, ?)").run(hostName(8), JSON.stringify({ ...s, tasks: undefined }), NOW);
    const loaded = await loadRuleInput(env.DB, NOW);
    expect(loaded.alerts).toHaveLength(2400);
    expect(loaded.readFrom).toEqual({});
    expect(loaded.truncated).toEqual([]);
    const out = evaluateRules(loaded);
    expect(out.resolve).toHaveLength(2400); // fix6: nothing resolved once 1,001 alerts were loaded
    expect(out.open.map((a) => a.key)).toContain(`approval-waiting|${hostName(8)}|z|legit`);
  });

  test("beyond RULE_ALERT_LIMIT only the hosts after the cut-off freeze: those before it resolve, the criticals of the unread hosts still open", async () => {
    const { env, db } = makeEnv();
    addAlerts(db, 12, 350); // 4,200 open alerts of 12 hosts > RULE_ALERT_LIMIT
    addHosts(db, 12);
    expect(12 * 350).toBeGreaterThan(RULE_ALERT_LIMIT);
    // a critical event of the LAST host (beyond the cut-off): the halt must open although its host was not read
    db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, agent, scenario, severity, text, at, received_at) VALUES ('s', 'e1', ?, 'p', 'halt', '" + ORIGIN_HOST + "', 'claude', 'cli-gone', 'critical', 'gone', ?, ?)").run(hostName(11), NOW - 1000, NOW);
    const loaded = await loadRuleInput(env.DB, NOW);
    expect(loaded.truncated).toEqual([]); // no scan is globally truncated ...
    expect(loaded.readFrom.alerts).toBe(hostName(11)); // ... it is the 12th host that was not read completely
    const out = evaluateRules(loaded);
    const resolvedHosts = new Set(out.resolve.map((k) => k.split("|")[1]));
    expect([...resolvedHosts].sort()).toEqual(Array.from({ length: 11 }, (_, i) => hostName(i))); // 11 hosts read completely: every ended alert resolves
    expect(out.resolve.filter((k) => k.includes(`|${hostName(11)}|`))).toEqual([]); // the unread one: nothing is resolved
    expect(out.open.map((a) => a.key)).toContain(`agent-stuck|${hostName(11)}|p|claude|cli-gone`); // criticals never wait
    // a NEW non-critical alert of an unread host waits (it cannot be counted), one of a read host opens
    const tasks = [rtask({ key: "k1", host: hostName(2), project: "q", task_id: "N1", agent: "n1" }), rtask({ key: "k2", host: hostName(11), project: "q", task_id: "N2", agent: "n2" })];
    const out2 = evaluateRules({ ...loaded, tasks });
    expect(out2.open.map((a) => a.key)).toContain(`blocked|${hostName(2)}|q|N1`);
    expect(out2.open.map((a) => a.key)).not.toContain(`blocked|${hostName(11)}|q|N2`);
    expect(JSON.stringify(out2.readFrom)).toContain(hostName(11));
  });

  test("tasks: 12 hosts with 400 open tasks each are cut at a host boundary: the hosts before it keep resolving, the rest freeze", async () => {
    const { env, db } = makeEnv();
    db.sqlite.exec("BEGIN");
    const ins = db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 's', ?, ?, 'p', ?, ?, 't', 'running', ?, ?)");
    for (let h = 0; h < 12; h++) for (let i = 0; i < 200; i++) {
      ins.run(`${hostName(h)}|p|T-${i}`, ORIGIN_HOST, hostName(h), `a${i}`, `T-${i}`, NOW - 2 * HOUR, NOW - HOUR + i);
      ins.run(`relay|${hostName(h)}|p|@s${i}:x`, ORIGIN_RELAY, hostName(h), `claude@s${i}`, `@s${i}:x`, NOW - 2 * HOUR, NOW - HOUR + i);
    }
    db.sqlite.exec("COMMIT");
    addHosts(db, 12);
    expect(12 * 400).toBeGreaterThan(RULE_TASK_LIMIT);
    // an open `blocked` alert of an early host and one of a late host, both without a task row in the blocked state
    db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened) VALUES (?, 'blocked', 'warn', '" + ORIGIN_HOST + "', ?, 'p', 'x', ?)").run(`blocked|${hostName(2)}|p|gone`, hostName(2), NOW - 3 * HOUR);
    db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened) VALUES (?, 'blocked', 'warn', '" + ORIGIN_HOST + "', ?, 'p', 'x', ?)").run(`blocked|${hostName(11)}|p|gone`, hostName(11), NOW - 3 * HOUR);
    const loaded = await loadRuleInput(env.DB, NOW);
    expect(loaded.tasks).toHaveLength(RULE_TASK_LIMIT);
    expect(loaded.readFrom.tasks).toBe(hostName(10)); // 10 hosts x 400 rows = the limit exactly
    const out = evaluateRules(loaded);
    expect(out.resolve).toContain(`blocked|${hostName(2)}|p|gone`); // before the cut-off: resolves
    expect(out.resolve).not.toContain(`blocked|${hostName(11)}|p|gone`); // after it: frozen
  });

  test("snapshots and halt events are cut the same way (host by host), and the summary names every scan that was cut", async () => {
    const { env, db } = makeEnv();
    db.sqlite.exec("BEGIN");
    const snap = db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', ?, ?, ?, ?)");
    const ev = db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, agent, scenario, severity, text, at, received_at) VALUES ('s', ?, ?, 'p', 'halt', '" + ORIGIN_HOST + "', 'a', 'cli-gone', 'critical', 'x', ?, ?)");
    for (let h = 0; h < 22; h++) {
      for (let p = 0; p < 30; p++) snap.run(hostName(h), `p${p}`, JSON.stringify({ v: 1, host: hostName(h), project: `p${p}`, sentAt: NOW, poller: { status: "running" }, agents: [], discussions: [], approvals: [] }), NOW);
      for (let i = 0; i < 100; i++) ev.run(`e${h}-${i}`, hostName(h), NOW - HOUR - i, NOW);
    }
    db.sqlite.exec("COMMIT");
    addHosts(db, 22);
    expect(22 * 30).toBeGreaterThan(RULE_SNAPSHOT_LIMIT);
    expect(22 * 100).toBeGreaterThan(RULE_EVENT_LIMIT);
    const loaded = await loadRuleInput(env.DB, NOW);
    expect(loaded.snapshots).toHaveLength(RULE_SNAPSHOT_LIMIT);
    expect(loaded.readFrom.snapshots).toBe(hostName(20)); // 20 hosts x 30 snapshots
    expect(loaded.events).toHaveLength(RULE_EVENT_LIMIT);
    expect(loaded.readFrom.events).toBe(hostName(20));
    // approvals of an unread host are not resolved, those of a read host are
    const alerts = [openRow(`approval-waiting|${hostName(3)}|p0|x`, "approval-waiting", { host: hostName(3) }), openRow(`approval-waiting|${hostName(21)}|p0|x`, "approval-waiting", { host: hostName(21) })];
    const out = evaluateRules({ ...loaded, alerts });
    expect(out.resolve).toEqual([`approval-waiting|${hostName(3)}|p0|x`]);
    const { truncationSummary } = await import("../src/alerts");
    expect(truncationSummary(out)).toEqual(["events", "snapshots"]);
  });
});

// ── T. throttled evaluations and bounded reads ───────────────────────────────

const evaluations = (db: D1Shim): number => db.statements.filter((s) => s.includes("WITH RECURSIVE h(host)") && s.includes("resolved >=")).length;
const blockedTasks = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, agent: `agent${from + i}`, title: "x", state: "blocked", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000 }));

describe("T. ingest-triggered rule evaluations are throttled per source; the cron covers the rest", () => {
  test("the default is one minute, an env value overrides it, garbage falls back to the default", () => {
    expect(EVAL_MIN_INTERVAL_MS).toBe(60_000);
    expect(evalMinIntervalMs({})).toBe(60_000);
    expect(evalMinIntervalMs({ RULES_MIN_INTERVAL_MS: "0" })).toBe(0);
    expect(evalMinIntervalMs({ RULES_MIN_INTERVAL_MS: "5000" })).toBe(5000);
    for (const bad of ["", "abc", "-1", "NaN"]) expect(evalMinIntervalMs({ RULES_MIN_INTERVAL_MS: bad })).toBe(60_000);
  });

  test("changed snapshots within a minute run the rules once, the cron picks the rest up, and the next one after a minute evaluates again", async () => {
    const b = await bootHost("hosta", { RULES_MIN_INTERVAL_MS: undefined });
    const snap = (tasks: unknown[], at: number) => b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: "proja", tasks, sentAt: at } as never, at), at);
    b.db.statements.length = 0;
    const first = (await (await snap(blockedTasks(1), NOW)).json()) as { alertsOpened: number };
    expect(first.alertsOpened).toBe(1); // the first change after a quiet period evaluates at once
    expect(evaluations(b.db)).toBe(1);
    const second = (await (await snap(blockedTasks(2), NOW + 10 * SEC)).json()) as { alertsOpened: number; unchanged: boolean };
    expect(second).toMatchObject({ unchanged: false, alertsOpened: 0 }); // 10 s later: stored, not evaluated
    expect(b.open("blocked|hosta|%")).toHaveLength(1);
    for (let i = 3; i < 10; i++) await snap(blockedTasks(i), NOW + 10 * SEC + i); // a burst
    expect(evaluations(b.db)).toBe(1);
    await b.cron(NOW + 50 * SEC); // the cron evaluates whatever the throttle held back, within its minute
    expect(evaluations(b.db)).toBe(2);
    expect(b.open("blocked|hosta|%")).toHaveLength(9);
    const third = (await (await snap(blockedTasks(10), NOW + 61 * SEC)).json()) as { alertsOpened: number };
    expect(third.alertsOpened).toBe(1); // 61 s after the first stamp
    expect(b.db.rows("SELECT eval_at FROM sources WHERE name = 'hosta'")).toEqual([{ eval_at: NOW + 61 * SEC }]);
  });

  test("an UNCHANGED snapshot neither evaluates nor takes the throttle slot of a later change", async () => {
    const b = await bootHost("hosta", { RULES_MIN_INTERVAL_MS: undefined });
    const snap = (tasks: unknown[], at: number) => b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: "proja", tasks, agents: [], sentAt: at } as never, at), at);
    await snap(blockedTasks(1), NOW);
    b.db.statements.length = 0;
    await snap(blockedTasks(1), NOW + 40 * SEC); // identical content: unchanged
    expect(evaluations(b.db)).toBe(0);
    expect(b.db.rows("SELECT eval_at FROM sources WHERE name = 'hosta'")).toEqual([{ eval_at: NOW }]); // not re-stamped
    const changed = (await (await snap(blockedTasks(2), NOW + 61 * SEC)).json()) as { alertsOpened: number };
    expect(changed.alertsOpened).toBe(1);
  });

  test("events batches are throttled the same way, per SOURCE (another host is not held back), and over-budget critical halts always evaluate", async () => {
    const b = await bootHost("hosta", { RULES_MIN_INTERVAL_MS: undefined });
    const other = await b.addHost("proja");
    const ev = (n: number) => ({ v: 1, host: "hosta", project: "proja", events: [{ kind: "halt", origin: ORIGIN_HOST, at: NOW - 1000 + n, key: `h${n}`, scenario: "cli-gone", agent: `agent${n}`, severity: "critical", text: "gone" }] });
    expect(((await (await b.post("/api/ingest/events", ev(1), NOW)).json()) as { alertsOpened: number }).alertsOpened).toBe(1);
    expect(((await (await b.post("/api/ingest/events", ev(2), NOW + 5 * SEC)).json()) as { alertsOpened: number }).alertsOpened).toBe(0); // held back for the cron
    expect(b.open("agent-stuck|hosta|%")).toHaveLength(1);
    // another host has its own stamp
    const mine = { v: 1, host: "proja", project: "p", events: [{ kind: "halt", origin: ORIGIN_HOST, at: NOW - 500, key: "x", scenario: "cli-gone", agent: "claude", severity: "critical", text: "gone" }] };
    expect(((await (await other("/api/ingest/events", mine, NOW + 6 * SEC)).json()) as { alertsOpened: number }).alertsOpened).toBeGreaterThanOrEqual(1); // (an evaluation is global: it opens the held-back alert of hosta as well)
    expect(b.open("agent-stuck|proja|p|claude|cli-gone")).toHaveLength(1);
    // a spent write budget accepts critical halts anyway (their own allowance), and they open their alert at once
    b.db.sqlite.query("UPDATE sources SET wr_count = ?, wr_window_start = ? WHERE name = 'hosta'").run(hostWriteBudget(1), NOW);
    const over = (await (await b.post("/api/ingest/events", ev(3), NOW + 7 * SEC)).json()) as { budgetExhausted?: boolean; alertsOpened: number };
    expect(over.budgetExhausted).toBe(true);
    expect(over.alertsOpened).toBeGreaterThanOrEqual(1);
    expect(b.open("agent-stuck|hosta|proja|agent3|cli-gone")).toHaveLength(1);
  });

  test("with the throttle off (env 0) every changed ingest evaluates, as in the other tests", async () => {
    const b = await bootHost("hosta", { RULES_MIN_INTERVAL_MS: "0" });
    b.db.statements.length = 0;
    for (let i = 0; i < 3; i++) await b.post("/api/ingest/snapshot", snapshot({ host: "hosta", project: "proja", tasks: blockedTasks(i + 1) } as never, NOW + i), NOW + i);
    expect(evaluations(b.db)).toBe(3);
  });
});

describe("T. what a poll and an evaluation read is bounded by the caps, not by what a flooder stored", () => {
  test("the alert scan returns at most RULE_PART_ALERTS open alerts of a host (+ its recently resolved ones), whatever the table holds", async () => {
    const { env, db } = makeEnv();
    db.sqlite.exec("BEGIN");
    const ins = db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, resolved) VALUES (?, 'blocked', 'warn', '" + ORIGIN_HOST + "', ?, 'p', 'x', ?, ?)");
    for (let i = 0; i < 5000; i++) ins.run(`big${i}`, "big", NOW - i, i % 10 === 0 ? NOW - 1000 : null);
    ins.run("q1", "quiet", NOW, null);
    db.sqlite.exec("COMMIT");
    const rows = db.sqlite.query(SQL_RULE_ALERTS).all(RULE_PART_ALERTS + 1, NOW - 30 * MIN, 100, RULE_ALERT_LIMIT + 1) as Array<{ host: string; part: number }>;
    expect(rows.filter((r) => r.host === "big" && r.part === 0)).toHaveLength(RULE_PART_ALERTS + 1);
    expect(rows.filter((r) => r.host === "big" && r.part === 1)).toHaveLength(100);
    expect(rows.filter((r) => r.host === "quiet")).toHaveLength(1);
    const loaded = await loadRuleInput(env.DB, NOW);
    expect(loaded.truncatedParts.alerts).toEqual(["big"]); // the flooder's own partition is flagged, the other host is not
  });
});

void DAY_MS;
