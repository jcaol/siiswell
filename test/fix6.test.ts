// fix round 6: (A) the alert caps must never become a way to HIDE an alert (critical ones, other projects), and
// (B) the push budget must not be multipliable by names the host invents (relay senders, agent names).
import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { RULE_PART_ALERTS, loadRuleInput } from "../src/alerts";
import {
  CRITICAL_AGENT_DEDUPE_MS,
  MAX_CRITICAL_PUSHES_PER_DAY,
  MAX_CRITICAL_PUSHES_PER_HOUR,
  MAX_OPEN_ALERTS_PER_PROJECT,
  MAX_PUSHES_PER_OWNER_PER_DAY,
  MAX_RELAY_PUSHES_PER_DAY,
  MAX_RELAY_PUSHES_PER_WINDOW,
  MAX_RELAY_SENDERS_PER_HOST,
} from "../src/env";
import { route, runCron } from "../src/index";
import { dispatchPushes, flushPushSummaries, pushPlan } from "../src/push";
import type { PushItem } from "../src/rules";
import { addSource, makeCtx, makeEnv, request, setupPush, snapshot, type D1Shim } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function bootHost(name = "evil") {
  const t = makeEnv();
  const push = await setupPush(t);
  const ctx = makeCtx();
  const token = await addSource(t.db, name, "host");
  const post = async (path: string, body: unknown, now = NOW) => {
    const res = await route(request(path, { token, body }), t.env, ctx, { now, fetch: push.fetch });
    await ctx.flush();
    return res;
  };
  const cron = async (now: number) => {
    await runCron(t.env, ctx, now, { fetch: push.fetch });
    await ctx.flush();
  };
  const halt = (project: string, agent: string, scenario = "cli-gone", at = NOW - 1000, key = `h-${project}-${agent}-${scenario}-${at}`) =>
    ({ v: 1, host: name, project, events: [{ kind: "halt", origin: ORIGIN_HOST, at, severity: "critical", key, scenario, agent, text: `${agent} ${scenario}` }] });
  const open = (like: string) => t.db.rows<{ key: string }>("SELECT key FROM alerts WHERE resolved IS NULL AND key LIKE ?", like).map((r) => r.key);
  return { ...t, ctx, push, token, post, cron, halt, open, name };
}
const blockedTasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, agent: `agent${i}`, title: "x", state: "blocked", dispatchedAt: NOW - 600_000, updatedAt: NOW - 1000 - i }));

// ── A ────────────────────────────────────────────────────────────────────────

describe("A. the alert caps never refuse a critical alert or another project's alert", () => {
  test("probe A2: 100 blocked alerts in project A, then a critical cli-gone in project B of the same host: it opens AND is pushed", async () => {
    const b = await bootHost();
    await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: "A", tasks: blockedTasks(100) } as never, NOW));
    expect(b.open("blocked|evil|A|%")).toHaveLength(MAX_OPEN_ALERTS_PER_PROJECT); // capped (the oldest evicted), with ONE warning
    expect(b.open("alerts-capped|evil|A")).toHaveLength(1);
    const before = b.push.pushes.length;
    await b.post("/api/ingest/events", b.halt("B", "claude"), NOW + 2000);
    expect(b.open("agent-stuck|evil|B|%")).toEqual(["agent-stuck|evil|B|claude|cli-gone"]);
    expect(b.push.pushes.length).toBeGreaterThanOrEqual(before + 1); // pushed at once (host-agent criticals are exempt from the ordinary budget)
    expect(b.db.rows("SELECT push_count FROM alerts WHERE key = 'agent-stuck|evil|B|claude|cli-gone'")).toEqual([{ push_count: 1 }]);
  });

  test("probe A1: 50 ancient approvals in project A (20 alerts) never hide project B's legitimate approval", async () => {
    const b = await bootHost();
    const flood = Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, summary: "x", requestedAt: 1 }));
    await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: "A", approvals: flood } as never, NOW));
    await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: "B", approvals: [{ id: "legit", summary: "rm -rf build", requestedAt: NOW - 10 * MIN }] } as never, NOW));
    await b.cron(NOW + MIN);
    expect(b.open("approval-waiting|evil|A|%")).toHaveLength(20);
    expect(b.open("approval-waiting|evil|B|%")).toEqual(["approval-waiting|evil|B|legit"]);
  });

  test("a host whose alert partition is cut off still gets its CRITICAL alerts (only its non-critical ones wait)", async () => {
    const b = await bootHost();
    b.db.sqlite.exec("BEGIN");
    const ins = b.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened, push_count) VALUES (?, 'agent-stuck', 'critical', '" + ORIGIN_HOST + "', 'evil', 'X', ?, 'x', ?, 1)");
    for (let i = 0; i < RULE_PART_ALERTS + 20; i++) ins.run(`agent-stuck|evil|X|a${i}|cli-gone`, `a${i}`, NOW - HOUR + i);
    b.db.sqlite.exec("COMMIT");
    expect((await loadRuleInput(b.env.DB, NOW)).truncatedParts.alerts).toEqual(["evil"]);
    const before = b.push.pushes.length;
    await b.post("/api/ingest/events", b.halt("B", "claude"), NOW + 1000);
    expect(b.open("agent-stuck|evil|B|claude|cli-gone")).toHaveLength(1); // not refused although the host's partition cannot be counted
    expect(b.push.pushes.length).toBe(before + 1);
  });

  test("usage-limit, host-offline and budget-exhausted are never refused either, whatever the caps hold", async () => {
    const b = await bootHost();
    await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: "A", tasks: blockedTasks(100), agents: [{ name: "claude", state: "usage-limit" }] } as never, NOW));
    expect(b.open("usage-limit|evil|A|claude")).toHaveLength(1);
    b.db.sqlite.query("UPDATE sources SET budget_until = ? WHERE name = 'evil'").run(NOW + DAY);
    b.db.sqlite.query("UPDATE hosts SET last_seen = ?").run(NOW - HOUR);
    await b.cron(NOW + 6 * MIN);
    expect(b.open("host-offline|evil")).toHaveLength(1);
    expect(b.open("budget-exhausted|evil")).toHaveLength(1);
  });

  test("over the cap the OLDEST non-critical alerts are evicted for the newest, ONE alerts-capped warning appears, and it goes when the flood ends", async () => {
    const b = await bootHost();
    // 60 blocked tasks of one project; T-0 is the oldest condition
    const tasks = Array.from({ length: MAX_OPEN_ALERTS_PER_PROJECT + 10 }, (_, i) => ({ id: `t${i}`, agent: `agent${i}`, title: "x", state: "blocked", dispatchedAt: NOW - HOUR, updatedAt: NOW - HOUR + i * 1000 }));
    await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: "A", tasks } as never, NOW));
    const kept = b.open("blocked|evil|A|%");
    expect(kept).toHaveLength(MAX_OPEN_ALERTS_PER_PROJECT);
    expect(kept).not.toContain("blocked|evil|A|t0"); // the oldest are the ones that are not shown
    expect(kept).toContain("blocked|evil|A|t59");
    expect(b.open("alerts-capped|evil|A")).toHaveLength(1);
    expect(b.db.rows<{ text: string }>("SELECT text FROM alerts WHERE rule = 'alerts-capped'")[0]?.text).toContain("10 alerts over the limit of 50");
    // nothing flaps: three more evaluations change nothing
    const snapshotOfAlerts = () => JSON.stringify(b.db.rows("SELECT key, opened, resolved FROM alerts ORDER BY key"));
    const before = snapshotOfAlerts();
    for (let m = 1; m <= 3; m++) await b.cron(NOW + m * MIN);
    expect(snapshotOfAlerts()).toBe(before);
    // the flood ends: the warning resolves with the next evaluation
    await b.post("/api/ingest/snapshot", snapshot({ host: "evil", project: "A", tasks: tasks.slice(0, 5).map((t) => ({ ...t, state: "done" })) } as never, NOW + 5 * MIN), NOW + 5 * MIN);
    await b.cron(NOW + 6 * MIN);
    expect(b.open("alerts-capped|evil|A")).toEqual([]);
  });
});

// ── B ────────────────────────────────────────────────────────────────────────

describe("B. the push budget cannot be multiplied by names the host invents", () => {
  const relay = (i: number, project: string, sender: string, at = NOW - 1000) => ({
    v: 1, host: "evil", project, events: [{ kind: "status", origin: ORIGIN_RELAY, at, key: `r${i}-${project}-${sender}`, status: "BLOCKED", text: "STATUS: BLOCKED need input", sender, agent: `claude@${sender}` }],
  });

  test("fabricated relay senders: at most MAX_RELAY_SENDERS_PER_HOST are mirrored, and ALL of them together get 10 pushes per 10 min and 30 a day", async () => {
    const b = await bootHost();
    // 60 invented senders in one batch, each BLOCKED
    const events = Array.from({ length: 60 }, (_, i) => ({ kind: "status", origin: ORIGIN_RELAY, at: NOW - 1000 + i, key: `r${i}`, status: "BLOCKED", text: "STATUS: BLOCKED", sender: `@fake${i}:other.org`, agent: `claude@fake${i}` }));
    const res = await b.post("/api/ingest/events", { v: 1, host: "evil", project: "proja", events }, NOW + 1000);
    expect(await res.json()).toMatchObject({ accepted: 60, relayDropped: 60 - MAX_RELAY_SENDERS_PER_HOST });
    // the 10 mirrored senders in 20 projects each: 200 relay alerts (the per-host row cap), way more than any budget
    for (let p = 0; p < 20; p++) {
      const evs = Array.from({ length: MAX_RELAY_SENDERS_PER_HOST }, (_, i) => ({ kind: "status", origin: ORIGIN_RELAY, at: NOW - 500 + p, key: `p${p}-${i}`, status: "BLOCKED", text: "STATUS: BLOCKED", sender: `@fake${i}:other.org`, agent: `claude@fake${i}` }));
      await b.post("/api/ingest/events", { v: 1, host: "evil", project: `proj${p}`, events: evs }, NOW + 2000 + p);
    }
    let firstWindow = 0;
    for (let m = 1; m <= 24 * 60; m++) {
      await b.cron(NOW + m * MIN);
      if (m === 10) firstWindow = b.push.pushes.length;
    }
    expect(firstWindow).toBeLessThanOrEqual(MAX_RELAY_PUSHES_PER_WINDOW + 2); // the first 10 minutes (+ ingest-time pushes of the first batches)
    // 24 hours, summaries included: the relay aggregate's daily cap, nothing like 60 senders x 3 x 6 per hour
    expect(b.push.pushes.length).toBeLessThanOrEqual(MAX_RELAY_PUSHES_PER_DAY);
    expect(b.db.rows("SELECT k FROM push_budget WHERE k = 'rt|evil'")).toHaveLength(1);
  });

  test("fabricated critical agents: 24 hours of 40 NEW invented agents an hour buy at most MAX_CRITICAL_PUSHES_PER_DAY pushes (summaries included)", async () => {
    const b = await bootHost();
    let firstHour = 0;
    for (let h = 0; h < 24; h++) {
      const evs = Array.from({ length: 40 }, (_, i) => ({ kind: "halt", origin: ORIGIN_HOST, at: NOW + h * HOUR + i, key: `h${h}-${i}`, scenario: "cli-gone", agent: `fake${h}x${i}`, text: "x" }));
      await b.post("/api/ingest/events", { v: 1, host: "evil", project: "proja", events: evs }, NOW + h * HOUR + 1000);
      for (let m = 1; m <= (h === 23 ? 59 : 60); m++) { // (the last cron stays inside the 24 h day of the first push)
        await b.cron(NOW + h * HOUR + 1000 + m * MIN);
        if (h === 0 && m === 59) firstHour = b.push.pushes.length; // (minute 60 starts the NEXT window, which may carry a summary)
      }
    }
    expect(firstHour).toBeLessThanOrEqual(MAX_CRITICAL_PUSHES_PER_HOUR);
    expect(b.push.pushes.length).toBeLessThanOrEqual(MAX_CRITICAL_PUSHES_PER_DAY);
    expect(b.push.pushes.length).toBeGreaterThan(20); // and the real ones did go out
  }, 120_000);

  test("one critical push per host+agent per 30 minutes: the other scenarios of the same agent are summarised, the next window pushes again", async () => {
    const b = await bootHost();
    for (const [i, scenario] of ["cli-gone", "restart-failed", "benched", "usage-limit"].entries()) await b.post("/api/ingest/events", b.halt("proja", "claude", scenario, NOW - 500 + i, `s${i}`), NOW + i * 1000);
    expect(b.push.pushes).toHaveLength(1);
    expect(b.db.rows("SELECT COUNT(*) AS n FROM alerts WHERE summarized_at IS NOT NULL AND push_count = 0")).toEqual([{ n: 3 }]);
    expect(b.db.rows("SELECT suppressed FROM push_budget WHERE k = 'ct|evil'")).toEqual([{ suppressed: 3 }]);
    await b.post("/api/ingest/events", b.halt("proja", "claude", "cli-gone", NOW + CRITICAL_AGENT_DEDUPE_MS + 5000, "later"), NOW + CRITICAL_AGENT_DEDUPE_MS + 6000);
    expect(b.push.pushes.length).toBe(2); // a new window for that agent (the alert key is the same incident, so use another agent below)
    await b.post("/api/ingest/events", b.halt("proja", "gemini", "cli-gone", NOW + 100, "other"), NOW + 7000);
    expect(b.push.pushes.length).toBe(3); // another AGENT is not held back by claude's window
  });

  test("a push cannot be bought with an invented key: every plan ends in the owner's daily total, relay senders share rt|host, criticals share ct|host", () => {
    const base = { host: "evil", agent: "a", sender: null as string | null };
    const crit = pushPlan({ ...base, origin: ORIGIN_HOST, severity: "critical", agent: "fake1" });
    expect(crit.keys.map((k) => k.key)).toEqual(["ct|evil", "ca|evil|fake1", "all|evil"]);
    expect(crit.group).toBe("grc|evil");
    const rel = pushPlan({ ...base, origin: ORIGIN_RELAY, severity: "warn", sender: "@x:y" });
    expect(rel.keys.map((k) => k.key)).toEqual(["rs|evil|@x:y", "rt|evil", "all|evil"]);
    expect(rel.holdKey).toBe("rt|evil");
    expect(rel.group).toBe("grp|evil"); // the invited sender does not make a group of its own
    expect(pushPlan({ ...base, origin: ORIGIN_HOST, severity: "warn" }).keys.map((k) => k.key)).toEqual(["own|evil", "all|evil"]);
    expect(pushPlan({ ...base, host: "client1", origin: "mcp", severity: "warn" }).keys.map((k) => k.key)).toEqual(["own|client1", "all|client1"]);
  });

  test("fairness: ten invented relay senders do not take more than 2 of the slots of an invocation; another host's alert goes out in it", async () => {
    const t = makeEnv();
    const push = await setupPush(t);
    const mk = (host: string, sender: string | null, i: number): PushItem => ({
      key: `blocked|${host}|p|${sender ?? "T" + i}`, rule: "blocked", severity: "warn", opened: NOW + i, origin: sender ? ORIGIN_RELAY : ORIGIN_HOST, host, project: "p", agent: "a", pushCount: 0, lastPushed: null, reminder: false, sender,
    });
    const items = [...Array.from({ length: 10 }, (_, i) => mk("evil", `@fake${i}:srv`, i)), mk("good", null, 99)];
    for (const it of items) t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened) VALUES (?, 'blocked', 'warn', ?, ?, 'p', 'a', 'x', ?)").run(it.key, it.origin, it.host, NOW);
    await dispatchPushes(t.env, items, NOW, push.fetch);
    const sent = t.db.rows<{ key: string }>("SELECT key FROM alerts WHERE push_count > 0 ORDER BY key").map((r) => r.key);
    expect(sent).toContain("blocked|good|p|T99");
    expect(sent.filter((k) => k.startsWith("blocked|evil"))).toHaveLength(2);
    expect(push.pushes).toHaveLength(3);
  });

  test("summary pushes count towards the owner's daily total, and a spent total holds everything back (criticals included)", async () => {
    const t = makeEnv();
    const push = await setupPush(t);
    const ins = t.db.sqlite.query("INSERT INTO push_budget (k, owner, window_start, window_ms, per_window, day_start, day_count, day_cap, suppressed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // the owner has one push left in its day; two keys are owed a summary
    ins.run("all|evil", "evil", NOW - 2 * HOUR, DAY, MAX_PUSHES_PER_OWNER_PER_DAY, NOW - 2 * HOUR, MAX_PUSHES_PER_OWNER_PER_DAY - 1, MAX_PUSHES_PER_OWNER_PER_DAY, 0);
    ins.run("rt|evil", "evil", NOW - 20 * MIN, 10 * MIN, 10, NOW - 2 * HOUR, 3, 30, 5);
    ins.run("ct|evil", "evil", NOW - 2 * HOUR, HOUR, 30, NOW - 2 * HOUR, 3, 60, 4);
    await flushPushSummaries(t.env, NOW, push.fetch);
    expect(push.pushes).toHaveLength(1); // ONE summary took the last slot of the day ...
    expect(t.db.rows("SELECT k, suppressed FROM push_budget WHERE suppressed > 0")).toHaveLength(1); // ... the other key stays owed
    expect(t.db.rows("SELECT day_count FROM push_budget WHERE k = 'all|evil'")).toEqual([{ day_count: MAX_PUSHES_PER_OWNER_PER_DAY }]);
    await flushPushSummaries(t.env, NOW + MIN, push.fetch);
    expect(push.pushes).toHaveLength(1); // the owner's day is spent: no more summaries today
    // and an individual critical push of that owner is held back as well (it is summarised for tomorrow)
    t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened) VALUES ('agent-stuck|evil|p|a|cli-gone', 'agent-stuck', 'critical', '" + ORIGIN_HOST + "', 'evil', 'p', 'a', 'x', ?)").run(NOW);
    const item: PushItem = { key: "agent-stuck|evil|p|a|cli-gone", rule: "agent-stuck", severity: "critical", opened: NOW, origin: ORIGIN_HOST, host: "evil", project: "p", agent: "a", pushCount: 0, lastPushed: null, reminder: false };
    await dispatchPushes(t.env, [item], NOW + 2 * MIN, push.fetch);
    expect(push.pushes).toHaveLength(1);
    expect(t.db.rows("SELECT push_count, summarized_at FROM alerts")).toEqual([{ push_count: 0, summarized_at: NOW + 2 * MIN }]);
  });
});

// keep the unused-import guard honest: the helper types are used by the shim only
void (null as unknown as D1Shim);
