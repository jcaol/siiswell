import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { ALERT_DEFAULTS } from "../src/shared/schema";
import { purgeOld } from "../src/alerts";
import { route, runCron } from "../src/index";
import { b64urlEncode } from "../src/util";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";

const NOW = 1_800_000_000_000; // a UTC minute that is not a multiple of 15 unless adjusted below
const MIN = 60_000;
const DAY = 86_400_000;

async function boot() {
  const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", vapid.privateKey)) as JsonWebKey;
  const t = makeEnv({
    VAPID_PUBLIC_KEY: b64urlEncode(new Uint8Array([4, ...Uint8Array.from(atob((jwk.x as string).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), ...Uint8Array.from(atob((jwk.y as string).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))])),
    VAPID_PRIVATE_KEY: jwk.d as string,
    VAPID_SUBJECT: "mailto:ops@example.com",
  });
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  t.db.sqlite
    .query("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, 1)")
    .run("https://fcm.googleapis.com/fcm/send/dev", b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer)), b64urlEncode(crypto.getRandomValues(new Uint8Array(16))));
  const ctx = makeCtx();
  const pushes: string[] = [];
  const fetchImpl = async (url: string) => {
    pushes.push(url);
    return new Response(null, { status: 201 });
  };
  return { ...t, ctx, pushes, fetchImpl, hostToken: await addSource(t.db, "hosta", "host") };
}

describe("cron", () => {
  test("opens host-offline for a silent host, pushes it once, resolves silently when the host returns", async () => {
    const { env, db, ctx, pushes, fetchImpl } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?)").run(NOW - 7 * MIN);

    await runCron(env, ctx, NOW, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT key, rule, push_count FROM alerts")).toEqual([{ key: "host-offline|hosta", rule: "host-offline", push_count: 1 }]);
    expect(pushes).toHaveLength(1);

    // next minutes: no repeat
    for (let i = 1; i <= 5; i++) {
      await runCron(env, ctx, NOW + i * MIN, { fetch: fetchImpl });
      await ctx.flush();
    }
    expect(pushes).toHaveLength(1);

    // host returns: resolves, nothing pushed
    db.sqlite.query("UPDATE hosts SET last_seen = ?").run(NOW + 6 * MIN);
    await runCron(env, ctx, NOW + 6 * MIN, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT resolved FROM alerts")[0].resolved).toBe(NOW + 6 * MIN);
    expect(pushes).toHaveLength(1);
  });

  test("overdue opens from the clock alone (no ingest involved): host-agent tasks", async () => {
    const { env, db, ctx, pushes, fetchImpl } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('h', ?)").run(NOW);
    db.sqlite
      .query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, created, updated) VALUES ('h|web|t-1', 's', 'host', 'h', 'web', 'w1', 't-1', 'long job', 'running', ?, ?, ?)")
      .run(NOW - 40 * MIN + 60 * MIN, NOW - 40 * MIN, NOW - 40 * MIN); // stated 60 min, 40 min ago
    await runCron(env, ctx, NOW, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows("SELECT * FROM alerts")).toHaveLength(0);
    await runCron(env, ctx, NOW + 51 * MIN, { fetch: fetchImpl }); // 91 min after the report (> 1.5 x 60)
    await ctx.flush();
    expect(db.rows<any>("SELECT rule, push_count FROM alerts WHERE rule = 'overdue'")).toEqual([{ rule: "overdue", push_count: 1 }]);
    // (the host we seeded also went silent over those 51 minutes, which is its own alert)
    expect(db.rows<any>("SELECT rule FROM alerts ORDER BY rule")).toEqual([{ rule: "host-offline" }, { rule: "overdue" }]);
  });

  test("an MCP task past its ETA is NOT overdue (no alert, no push); after 24 h silent it is closed as stale; blocked ones stay open", async () => {
    const { env, db, ctx, pushes, fetchImpl } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('c', ?)").run(NOW + 48 * 60 * MIN);
    const ins = db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, created, updated) VALUES (?, 's', 'mcp', 'c', 'web', 'c', ?, 'job', ?, ?, ?, ?)");
    ins.run("mcp|c|m-1", "m-1", "running", NOW - 40 * MIN + 60 * MIN, NOW - 40 * MIN, NOW - 40 * MIN);
    ins.run("mcp|c|m-2", "m-2", "blocked", null, NOW - 40 * MIN, NOW - 40 * MIN);
    ins.run("h|web|t-9", "t-9", "running", null, NOW - 40 * MIN, NOW - 40 * MIN); // a host-origin row with the mcp-looking source: untouched
    db.sqlite.query("UPDATE tasks SET origin = 'host' WHERE key = 'h|web|t-9'").run();
    await runCron(env, ctx, NOW + 51 * MIN, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT rule FROM alerts WHERE rule = 'overdue'")).toEqual([]);
    expect(pushes.filter((p: any) => JSON.stringify(p).includes("Overdue"))).toEqual([]);
    db.sqlite.query("DELETE FROM meta WHERE k = 'last_tick'").run();
    await runCron(env, ctx, NOW - 40 * MIN + 24 * 60 * MIN + 1, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT key, state FROM tasks ORDER BY key")).toEqual([
      { key: "h|web|t-9", state: "running" },
      { key: "mcp|c|m-1", state: "stale" },
      { key: "mcp|c|m-2", state: "blocked" },
    ]);
  });

  test("a hook's BLOCKED task is closed after 2 h without an update (labelled); manual / MCP BLOCKED tasks never", async () => {
    const { env, db, ctx, fetchImpl } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('c', ?)").run(NOW + 48 * 60 * MIN);
    const ins = db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, last_line, created, updated) VALUES (?, 's', 'mcp', 'c', 'web', 'claude@c', ?, ?, 'blocked', ?, ?, ?)");
    const old = NOW - 2 * 60 * MIN - MIN;
    ins.run("mcp|c|m-hook", "m-hook", "Waiting for your permission", "reported by the siiswell hook", old, old); // closed
    ins.run("mcp|c|m-hook2", "m-hook2", "Waiting for your input", "reported by the siiswell hook", NOW - 60 * MIN, NOW - 60 * MIN); // idle (an older CLI): closed at once
    ins.run("mcp|c|m-manual", "m-manual", "Needs a decision", "my own summary", old, old); // an agent's own BLOCKED: open
    ins.run("mcp|c|m-same-title", "m-same-title", "Waiting for your permission", null, old, old); // the title alone is not enough
    await runCron(env, ctx, NOW, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT task_id, state, last_line FROM tasks ORDER BY task_id")).toEqual([
      { task_id: "m-hook", state: "stale", last_line: "Closed — no activity after the permission prompt" },
      { task_id: "m-hook2", state: "stale", last_line: "Closed — the agent had finished; waiting for input is not a block" },
      { task_id: "m-manual", state: "blocked", last_line: "my own summary" },
      { task_id: "m-same-title", state: "blocked", last_line: null },
    ]);
  });

  test("an idle hook task (\"Waiting for your input\") never raises a blocked alert and is closed at the next tick; a permission one alerts", async () => {
    const { env, db, ctx, fetchImpl } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('c', ?)").run(NOW + 7 * 60 * MIN);
    const ins = db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, last_line, created, updated) VALUES (?, 's', 'mcp', 'c', 'web', 'claude@c', ?, ?, 'blocked', 'reported by the siiswell hook', ?, ?)");
    ins.run("mcp|c|m-idle", "m-idle", "Waiting for your input", NOW - MIN, NOW - MIN);
    ins.run("mcp|c|m-perm", "m-perm", "Waiting for your permission", NOW - MIN, NOW - MIN);
    await runCron(env, ctx, NOW, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT task_id, state FROM tasks ORDER BY task_id")).toEqual([{ task_id: "m-idle", state: "stale" }, { task_id: "m-perm", state: "blocked" }]);
    const alerts = db.rows<any>("SELECT rule, key FROM alerts WHERE rule = 'blocked'");
    expect(alerts.map((a: { key: string }) => a.key.split("|").pop())).toEqual(["m-perm"]);
  });

  test("a blocked MCP task alerts, then the 6 h cap resolves it silently and it is never re-opened", async () => {
    const { env, db, ctx, pushes, fetchImpl } = await boot();
    const blockedAt = NOW - MIN;
    db.sqlite
      .query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES ('mcp|c|m-1', 's', 'mcp', 'c', 'web', 'c', 'm-1', 'needs input', 'blocked', ?, ?)")
      .run(blockedAt, blockedAt);
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('c', ?)").run(NOW + 7 * 60 * MIN); // keep host-offline out of the picture
    await runCron(env, ctx, NOW, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT rule, push_count, resolved FROM alerts")).toEqual([{ rule: "blocked", push_count: 1, resolved: null }]);
    expect(pushes).toHaveLength(1);

    const justBefore = blockedAt + 6 * 60 * MIN - 1;
    await runCron(env, ctx, justBefore, { fetch: fetchImpl });
    // Two scheduled runs 1 ms apart only happen in this test: a real clock runs every 60 s, and the body claims
    // `last_tick` with a 50 s gap so the ticker and a firing cron never evaluate the same minute twice. Release it here.
    db.sqlite.query("DELETE FROM meta WHERE k = 'last_tick'").run();
    await ctx.flush();
    expect(db.rows<any>("SELECT resolved FROM alerts")[0].resolved).toBeNull();

    const atCap = blockedAt + 6 * 60 * MIN;
    await runCron(env, ctx, atCap, { fetch: fetchImpl });
    await ctx.flush();
    expect(db.rows<any>("SELECT resolved FROM alerts")[0].resolved).toBe(atCap);
    for (const m of [1, 2, 60]) {
      await runCron(env, ctx, atCap + m * MIN, { fetch: fetchImpl });
      await ctx.flush();
    }
    expect(db.rows<any>("SELECT rule, push_count, resolved FROM alerts")).toEqual([{ rule: "blocked", push_count: 1, resolved: atCap }]);
    expect(pushes).toHaveLength(1);
  });

  test("approval reminders back off: on open, +15, +45, +105, +225 min, then never again", async () => {
    const { env, db, ctx, pushes, fetchImpl, hostToken } = await boot();
    const sendSnapshot = async (now: number) => {
      const snap = snapshot({ approvals: [{ id: "ap1", summary: "rm -rf build", requestedAt: NOW - 6 * MIN }] }, now);
      await route(request("/api/ingest/snapshot", { body: snap, token: hostToken }), env, ctx, { now, fetch: fetchImpl });
      await ctx.flush();
    };
    const marks: number[] = [];
    for (let m = 0; m <= 300; m++) {
      const before = pushes.length;
      const now = NOW + m * MIN;
      if (m % 2 === 0) await sendSnapshot(now); // ingest path
      else {
        await runCron(env, ctx, now, { fetch: fetchImpl }); // cron path
        await ctx.flush();
      }
      if (pushes.length > before) marks.push(m);
    }
    expect(marks).toEqual([0, 15, 45, 105, 225]);
    expect(db.rows<any>("SELECT push_count FROM alerts")[0].push_count).toBe(ALERT_DEFAULTS.approvalMaxPushes);
  });

  test("a failed push (push service down) is retried on the next minute, then not repeated", async () => {
    const { env, db, ctx } = await boot();
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('hosta', ?)").run(NOW - 7 * MIN);
    let status = 503;
    let calls = 0;
    const f = async () => {
      calls++;
      return new Response(null, { status });
    };
    await runCron(env, ctx, NOW, { fetch: f });
    await ctx.flush();
    expect(calls).toBe(1);
    expect(db.rows<any>("SELECT push_count FROM alerts")[0].push_count).toBe(0);
    status = 201;
    await runCron(env, ctx, NOW + MIN, { fetch: f });
    await ctx.flush();
    expect(calls).toBe(2);
    expect(db.rows<any>("SELECT push_count FROM alerts")[0].push_count).toBe(1);
    await runCron(env, ctx, NOW + 2 * MIN, { fetch: f });
    await ctx.flush();
    expect(calls).toBe(2);
  });

  test("the ticker and a firing cron in the same minute evaluate the time-based rules once", async () => {
    const { env, db, ctx, fetchImpl } = await boot();
    let evaluations = 0;
    const counting = { ...env, DB: new Proxy(env.DB, { get(t, k) {
      const v = (t as any)[k];
      if (k === "prepare") return (sql: string) => { if (/FROM alerts|FROM tasks/.test(sql)) evaluations++; return v.call(t, sql); };
      return typeof v === "function" ? v.bind(t) : v;
    } }) } as typeof env;
    await runCron(counting, ctx, NOW, { fetch: fetchImpl });          // e.g. the cron at :00
    const first = evaluations;
    expect(first).toBeGreaterThan(0);
    await runCron(counting, ctx, NOW + 20_000, { fetch: fetchImpl }); // the alarm at :20, same minute: skipped
    expect(evaluations).toBe(first);
    await runCron(counting, ctx, NOW + 60_000, { fetch: fetchImpl }); // the next minute: evaluated again
    expect(evaluations).toBeGreaterThan(first);
    expect(db.sqlite.query("SELECT v FROM meta WHERE k = 'last_tick'").get()).toEqual({ v: String(NOW + 60_000) });
  });

  test("a rules failure never throws out of the cron or an ingest", async () => {
    const { env, ctx } = await boot();
    const broken = { ...env, DB: { prepare() { throw new Error("D1 is down"); }, batch() { throw new Error("D1 is down"); } } as unknown as D1Database };
    const origError = console.error;
    console.error = () => undefined;
    try {
      await expect(runCron(broken, ctx, NOW)).resolves.toBeUndefined();
    } finally {
      console.error = origError;
    }
  });
});

describe("retention purge", () => {
  test("removes rows older than retentionDays and keeps newer ones", async () => {
    const { db } = await boot();
    const old = NOW - (ALERT_DEFAULTS.retentionDays + 1) * DAY;
    const recent = NOW - DAY;
    const ev = db.sqlite.query("INSERT INTO events (source_id, key, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'halt', '" + ORIGIN_HOST + "', 'info', 'x', ?, ?)");
    ev.run("old", old, old);
    ev.run("new", recent, recent);
    const tk = db.sqlite.query("INSERT INTO tasks (key, source_id, origin, task_id, title, state, created, updated) VALUES (?, 's', 'mcp', ?, 't', ?, 1, ?)");
    tk.run("t-old-done", "a", "done", old);
    tk.run("t-old-open", "b", "running", old);
    tk.run("t-new-done", "c", "done", recent);
    const al = db.sqlite.query("INSERT INTO alerts (key, rule, severity, text, opened, resolved) VALUES (?, 'blocked', 'warn', 'x', ?, ?)");
    al.run("a-old-resolved", old, old + 1000);
    al.run("a-new-resolved", recent, recent + 1000);
    al.run("a-old-open", old, null);
    db.sqlite.query("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES ('s', 'h1', 'p', '{}', ?), ('s', 'h2', 'p', '{}', ?)").run(old, recent);
    db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('gone', ?), ('here', ?)").run(old, recent);
    db.sqlite.query("INSERT INTO project_seen (host, project, last_seen) VALUES ('gone', 'p', ?), ('here', 'p', ?)").run(old, recent);

    const removed = await purgeOld(db as unknown as D1Database, NOW, ALERT_DEFAULTS.retentionDays);
    expect(removed).toEqual({ events: 1, tasks: 2, alerts: 1, openAlerts: 1, snapshots: 1, hosts: 1, projectSeen: 1, usageDaily: 0, usageHourly: 0, usageHosts: 0, pushBudget: 0 });
    expect(db.rows<any>("SELECT host FROM project_seen")).toEqual([{ host: "here" }]);
    expect(db.rows<any>("SELECT key FROM events")).toEqual([{ key: "new" }]);
    expect(db.rows<any>("SELECT key FROM tasks")).toEqual([{ key: "t-new-done" }]);
    expect(db.rows<any>("SELECT key FROM alerts ORDER BY key")).toEqual([{ key: "a-new-resolved" }]); // (an alert still open after the whole retention period goes too: see test/fix7.test.ts)
    expect(db.rows<any>("SELECT host FROM hosts")).toEqual([{ host: "here" }]);
  });

  test("the cron purges when the last purge is 15 minutes old (the same claim the opportunistic purge uses), not every minute", async () => {
    const { env, db, ctx } = await boot();
    const old = NOW - (ALERT_DEFAULTS.retentionDays + 5) * DAY;
    const addOld = (key: string) => db.sqlite.query("INSERT INTO events (source_id, key, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'halt', '" + ORIGIN_HOST + "', 'info', 'x', ?, ?)").run(key, old, old);
    addOld("old1");
    await runCron(env, ctx, NOW); // no purge on record: due now
    expect(db.rows("SELECT * FROM events")).toHaveLength(0);
    addOld("old2");
    for (let m = 1; m < 15; m++) await runCron(env, ctx, NOW + m * MIN); // 1..14 minutes after the purge: not due
    expect(db.rows("SELECT * FROM events")).toHaveLength(1);
    await runCron(env, ctx, NOW + 15 * MIN);
    expect(db.rows("SELECT * FROM events")).toHaveLength(0);
  });

  test("every cron run stamps last_cron", async () => {
    const { env, db, ctx } = await boot();
    await runCron(env, ctx, NOW);
    expect(db.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'last_cron'")).toEqual([{ v: String(NOW) }]);
    await runCron(env, ctx, NOW + MIN);
    expect(db.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'last_cron'")).toEqual([{ v: String(NOW + MIN) }]);
  });
});

import { SQL_CLOSE_STALE_MCP } from "../src/maintenance";
describe("the stale closer's plan", () => {
  test("the 24 h and 2 h branches seek idx_tasks_state_updated; no scan of tasks", () => {
    const { db } = makeEnv();
    const plan = db.sqlite.query(`EXPLAIN QUERY PLAN ${SQL_CLOSE_STALE_MCP}`).all(1, 2, 3, 4, "m", "l", "[]", "t", "c").map((r: any) => String(r.detail));
    expect(plan.filter((d) => d.includes("idx_tasks_state_updated (state=? AND updated<?)")).length).toBe(2);
    expect(plan.filter((d) => /^SCAN tasks\b/.test(d) || d.includes("idx_tasks_agent"))).toEqual([]);
  });
});
