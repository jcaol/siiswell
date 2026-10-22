// The hot queries must be index-backed: they run on every changed ingest, every cron minute and every
// /api/state poll, and D1's Free plan allows 5 M rows read per day. EXPLAIN QUERY PLAN against the real
// schema, filled with enough rows that the planner has something to choose between.
import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { RULE_ALERT_LIMIT, RULE_EVENT_LIMIT, RULE_PART_ALERTS, RULE_PART_ALERTS_RESOLVED, RULE_PART_EVENTS, RULE_PART_SNAPSHOTS, RULE_PART_TASKS, RULE_SNAPSHOT_LIMIT, RULE_TASK_LIMIT, SQL_META_GET, SQL_RULE_ALERTS, SQL_RULE_BUDGETS, SQL_RULE_EVENTS, SQL_RULE_HOSTS, SQL_RULE_SNAPSHOTS, SQL_RULE_TASKS } from "../src/alerts";
import { MAX_STATE_ALERTS, MAX_STATE_ALERTS_PER_HOST } from "../src/env";
import { SQL_DELETE_ABSENT_TASKS } from "../src/db";
import { INSERT_CAPPED_TASK } from "../src/mcp";
import { SQL_CHARGE_ALERT_OWNERS, SQL_CLAIM_CRITICAL_HALTS, SQL_CLAIM_HOST_WRITES, SQL_CLAIM_MUTATIONS, SQL_CLAIM_PUSH_SLOTS, SQL_ENSURE_PUSH_BUDGETS, SQL_REFUND_PUSH_SLOTS, SQL_MARK_BUDGET_EXHAUSTED, SQL_PUSH_BUDGETS, SQL_PUSH_SUMMARIES_DUE, SQL_REFUND_SUMMARY_SLOT, SQL_SUPPRESS_PUSH, SQL_TAKE_SUPPRESSED } from "../src/budget";
import { SQL_CLAIM_ALERTS, SQL_SUMMARISE_ALERTS } from "../src/push";
import { SQL_STATE_ALERTS, SQL_STATE_EVENTS, SQL_STATE_SNAPSHOTS, SQL_STATE_TASKS } from "../src/state";
import { makeEnv, type D1Shim } from "./d1-shim";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = 1_800_000_000_000;

function seeded(): D1Shim {
  const { db } = makeEnv();
  db.sqlite.exec("BEGIN");
  const task = db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, eta_at, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 't', ?, NULL, ?, ?)");
  const states = ["queued", "delivered", "acked", "running", "blocked", "done", "failed", "skipped"];
  for (let i = 0; i < 1500; i++) {
    task.run(`k${i}`, `src-${i % 7}`, i % 5 === 0 ? "mcp" : ORIGIN_HOST, `host${i % 3}`, `proj${i % 4}`, `agent${i % 6}`, `t${i}`, states[i % states.length], NOW - i * 60_000, NOW - i * 30_000);
  }
  const ev = db.sqlite.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'h', 'p', ?, '" + ORIGIN_HOST + "', 'info', 'x', ?, ?)");
  for (let i = 0; i < 1500; i++) ev.run(`e${i}`, i % 10 === 0 ? "halt" : "status", NOW - i * 60_000, NOW);
  db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('h', ?)").run(NOW);
  const al = db.sqlite.query("INSERT INTO alerts (key, rule, severity, host, text, opened, resolved) VALUES (?, 'blocked', 'warn', ?, 'x', ?, ?)");
  for (let i = 0; i < 800; i++) al.run(`a${i}`, `host${i % 3}`, NOW - i, i % 20 === 0 ? null : NOW - i * 1000);
  db.sqlite.exec("COMMIT");
  db.sqlite.exec("ANALYZE");
  return db;
}

function plan(db: D1Shim, sql: string, ...params: Array<string | number>): string[] {
  return (db.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
}

/** A bare `SCAN <table>` (no index) is a full table scan. */
const fullScans = (details: string[]) => details.filter((d) => /^SCAN \w+\s*$/.test(d.trim()));

describe("hot queries are index-backed", () => {
  const db = seeded();
  const sql = (s: string) => s.replace(/\s+/g, " ");

  const TASK_ARGS = [NOW - 86_400_000, RULE_PART_TASKS + 1, RULE_TASK_LIMIT + 1] as const;
  const EVENT_ARGS = [NOW - 6 * 3600_000, RULE_PART_EVENTS + 1, RULE_EVENT_LIMIT + 1] as const;
  const ALERT_ARGS = [RULE_PART_ALERTS + 1, NOW - 1800_000, RULE_PART_ALERTS_RESOLVED, RULE_ALERT_LIMIT + 1] as const;
  const STATE_ALERT_ARGS = [MAX_STATE_ALERTS_PER_HOST + 1, MAX_STATE_ALERTS + 1] as const;

  test("rule evaluation: blocked/running tasks (partitioned by host and origin) use idx_tasks_state_updated, the newest-dispatch MAX() idx_tasks_agent", () => {
    const p = plan(db, SQL_RULE_TASKS, ...TASK_ARGS);
    // `SCAN t` is only the materialised, LIMITed sub-select, never a table
    expect(fullScans(p).filter((d) => d.trim() !== "SCAN t")).toEqual([]);
    expect(p.some((d) => d.includes("idx_tasks_state_updated"))).toBe(true);
    expect(p.some((d) => d.includes("idx_tasks_agent"))).toBe(true);
  });

  test("rule evaluation: halt events are read PER HOST by a bounded seek of the partial index idx_events_halt; alerts through one bounded seek of idx_alerts_host per host", () => {
    const events = plan(db, SQL_RULE_EVENTS, ...EVENT_ARGS).join("\n");
    expect(events).toContain("idx_events_halt"); // (host, at) WHERE kind = 'halt': the seek per host never walks another host's flood
    expect(events).not.toMatch(/SCAN events\s*$/m);
    // alerts: the owners are found by hopping over idx_alerts_host, then ONE bounded seek of it per owner and part
    // (open alerts; recently resolved ones). There is no window function over the table and no scan of `alerts`.
    const alerts = plan(db, SQL_RULE_ALERTS, ...ALERT_ARGS);
    expect(alerts.filter((d) => /\bSCAN alerts\b/.test(d))).toEqual([]);
    expect(alerts.filter((d) => /SEARCH \w+ USING (COVERING )?INDEX idx_alerts_host/.test(d)).length).toBeGreaterThanOrEqual(3); // the hop and the two seeks
    expect(alerts.join("\n")).toMatch(/idx_alerts_host \(host=\? AND resolved=\?\)/); // open alerts of one host
    expect(alerts.join("\n")).toMatch(/idx_alerts_host \(host=\? AND resolved>\?\)/); // its recently resolved ones
    expect(SQL_RULE_ALERTS).not.toMatch(/ROW_NUMBER|OVER \(/);
  });

  test("/api/state: open + recently closed tasks, open alerts and the last events never scan a whole table", () => {
    const tasks = plan(db, SQL_STATE_TASKS, NOW - 86_400_000);
    expect(fullScans(tasks.filter((d) => !d.includes("USE TEMP B-TREE")))).toEqual([]);
    expect(tasks.filter((d) => d.includes("idx_tasks_state_updated")).length).toBeGreaterThanOrEqual(3); // open, closed, stale (LIMITed)
    // the inbox: the newest `?1` open alerts of each host, a bounded walk of idx_alerts_host (backwards, in `opened` order)
    const inbox = plan(db, SQL_STATE_ALERTS, ...STATE_ALERT_ARGS);
    expect(inbox.filter((d) => /\bSCAN alerts\b/.test(d))).toEqual([]);
    expect(inbox.join("\n")).toMatch(/idx_alerts_host \(host=\? AND resolved=\?\)/);
    expect(inbox.filter((d) => /TEMP B-TREE/.test(d))).toHaveLength(1); // only the final merge of the (few) rows returned
    const events = plan(db, SQL_STATE_EVENTS);
    expect(events.join("\n")).toContain("idx_events_at");
    expect(fullScans(events)).toEqual([]);
  });

  test("ingest: replacing a host+project's tasks searches idx_tasks_agent by (origin, host, project)", () => {
    const p = plan(db, SQL_DELETE_ABSENT_TASKS, "host1", "proj2", "[]");
    expect(fullScans(p)).toEqual([]);
    expect(p.join("\n")).toMatch(/idx_tasks_agent \(origin=\? AND host=\? AND project=\?/);
  });

  test("the MCP open-task cap counts through idx_tasks_source, seeking the OPEN states only (never the closed history)", () => {
    const p = plan(db, INSERT_CAPPED_TASK, "k", "src-1", "h", "p", "a", "t", "title", "running", 0, "x", 1, 1, 50, 0);
    expect(p.join("\n")).toMatch(/USING (COVERING )?INDEX idx_tasks_source \(source_id=\? AND origin=\? AND state=\?\)/);
    expect(fullScans(p.filter((d) => /tasks/.test(d)))).toEqual([]);
  });

  test("the MCP mutation budget claim is a single primary-key lookup on `sources` (O(1) reads)", () => {
    expect(plan(db, SQL_CLAIM_MUTATIONS, "src-1", NOW, 86_400_000, 1000, 1)).toEqual(["SEARCH sources USING INDEX sqlite_autoindex_sources_1 (id=?)"]);
  });

  test("every budget claim is a point lookup of one `sources` row (primary key): O(1) reads, one row written", () => {
    expect(plan(db, SQL_CLAIM_HOST_WRITES, "src-1", NOW, 86_400_000, 25_000, 4, 30_000)).toEqual(["SEARCH sources USING INDEX sqlite_autoindex_sources_1 (id=?)"]); // the evaluation throttle rides on the same row
    // the unconditional per-owner alert charge looks sources up by the unique name (one seek per owner)
    expect(plan(db, SQL_CHARGE_ALERT_OWNERS, '[{"h":"hosta","n":6}]', NOW, 86_400_000).join("\n")).toMatch(/SEARCH sources USING INDEX sqlite_autoindex_sources_\d \(name=\?\)/);
  });

  test("every push budget statement seeks `push_budget` rows by their primary key (the multi-key claim: one seek per key)", () => {
    for (const [sqlText, args] of [
      [SQL_TAKE_SUPPRESSED, ["own|client1", 2]],
      [SQL_REFUND_SUMMARY_SLOT, ["own|client1", 0, NOW]],
    ] as Array<[string, Array<string | number>]>) {
      expect(plan(db, sqlText, ...args)).toEqual(["SEARCH push_budget USING INDEX sqlite_autoindex_push_budget_1 (k=?)"]);
    }
    const keys = '["own|client1","all|client1"]';
    for (const [sqlText, args] of [
      [SQL_PUSH_BUDGETS, [keys]],
      [SQL_CLAIM_PUSH_SLOTS, [keys, NOW, 86_400_000]],
      [SQL_REFUND_PUSH_SLOTS, [keys]],
    ] as Array<[string, Array<string | number>]>) {
      const p = plan(db, sqlText, ...args);
      expect(p.join("\n")).toMatch(/SEARCH push_budget USING (COVERING )?INDEX sqlite_autoindex_push_budget_1 \(k=\?\)/);
      expect(p.filter((d) => /SCAN push_budget/.test(d))).toEqual([]); // never a scan of the table
    }
    // the ensure / suppress upserts are keyed by the primary key as well
    for (const [sqlText, args] of [
      [SQL_ENSURE_PUSH_BUDGETS, ['[{"k":"own|a","o":"a","w":600000,"p":3,"d":30}]', NOW]],
      [SQL_SUPPRESS_PUSH, ["own|client1", 1, "client1", NOW]],
    ] as Array<[string, Array<string | number>]>) {
      expect(plan(db, sqlText, ...args).filter((d) => /SCAN push_budget/.test(d))).toEqual([]);
    }
  });

  test("the push claim of a batch of alerts seeks each key through the alerts primary key (never scans the table)", () => {
    for (const q of [SQL_CLAIM_ALERTS, SQL_SUMMARISE_ALERTS]) {
      const p = plan(db, q, NOW, 0, JSON.stringify(["a1", "a2"]), 0);
      expect(fullScans(p.filter((d) => /alerts/.test(d)))).toEqual([]);
      expect(p.join("\n")).toMatch(/SEARCH alerts USING INDEX sqlite_autoindex_alerts_1 \(key=\?\)/);
    }
  });

  test("budget-exhaustion bookkeeping: a partial index for the rules scan, point lookups for everything else", () => {
    const pk = ["SEARCH sources USING INDEX sqlite_autoindex_sources_1 (id=?)"];
    expect(plan(db, SQL_RULE_BUDGETS, NOW).join("\n")).toContain("idx_sources_budget");
    expect(plan(db, SQL_CLAIM_CRITICAL_HALTS, "src-1", NOW, 86_400_000, 200, 3)).toEqual(pk);
    expect(plan(db, SQL_MARK_BUDGET_EXHAUSTED, "src-1", NOW)).toEqual(pk);
    expect(plan(db, SQL_META_GET, "rules_truncated")).toEqual(["SEARCH meta USING INDEX sqlite_autoindex_meta_1 (k=?)"]);
  });

  test("the snapshot scan numbers rows per host and skips oversized rows; the task scan applies its limits before the correlated subquery", () => {
    expect(fullScans(plan(db, SQL_RULE_SNAPSHOTS, RULE_PART_SNAPSHOTS + 1, RULE_SNAPSHOT_LIMIT + 1)).length).toBeLessThanOrEqual(2); // a tiny table, capped at write time (30 per host)
    expect(SQL_RULE_SNAPSHOTS).toContain("length(json) <=");
    expect(SQL_STATE_SNAPSHOTS).toContain("length(json) <=");
    const tasks = plan(db, SQL_RULE_TASKS, ...TASK_ARGS).join("\n");
    expect(tasks).toMatch(/CO-ROUTINE|MATERIALIZE|SCAN t/); // the LIMITed sub-select is evaluated first
  });

  test("the cron's push-summary lookup uses the partial index and is empty on a normal minute", () => {
    expect(plan(db, SQL_PUSH_SUMMARIES_DUE, NOW).join("\n")).toContain("idx_push_budget_suppressed");
    expect(db.sqlite.query(SQL_PUSH_SUMMARIES_DUE).all(NOW)).toEqual([]);
  });

  test("every rule / state scan is bounded by a LIMIT, whatever the table holds", () => {
    for (const q of [SQL_RULE_SNAPSHOTS, SQL_RULE_HOSTS, SQL_RULE_TASKS, SQL_RULE_EVENTS, SQL_RULE_ALERTS, SQL_STATE_ALERTS, SQL_STATE_TASKS, SQL_STATE_EVENTS]) {
      expect(q).toMatch(/\bLIMIT\b/i);
    }
    expect(db.sqlite.query(SQL_RULE_TASKS).all(...TASK_ARGS).length).toBeLessThanOrEqual(RULE_TASK_LIMIT + 1); // one more than used: that extra row is the "truncated" signal
    expect(db.sqlite.query(SQL_RULE_ALERTS).all(...ALERT_ARGS).length).toBeLessThanOrEqual(RULE_ALERT_LIMIT + 1);
    expect(db.sqlite.query(SQL_STATE_ALERTS).all(...STATE_ALERT_ARGS).length).toBeLessThanOrEqual(MAX_STATE_ALERTS + 1);
  });

  test("there is no index (or query) left that exists only for the old events-based budget count", () => {
    const idx = db.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name).sort()).toEqual(["idx_events_at", "idx_events_halt", "idx_events_kind_at"]);
  });

  test("retention purge walks idx_tasks_updated / idx_events_at / idx_alerts_resolved (resolved AND open alerts)", () => {
    expect(plan(db, "DELETE FROM tasks WHERE updated < ?", NOW).join("\n")).toContain("idx_tasks_updated");
    expect(plan(db, "DELETE FROM events WHERE at < ?", NOW).join("\n")).toContain("idx_events_at");
    expect(plan(db, "DELETE FROM alerts WHERE resolved IS NOT NULL AND resolved < ?", NOW).join("\n")).toContain("idx_alerts_resolved");
    expect(plan(db, "DELETE FROM alerts WHERE resolved IS NULL AND opened < ?", NOW).join("\n")).toMatch(/idx_alerts_resolved \(resolved=\? AND opened<\?\)/);
  });

  test("the queries above are real SQL against this schema (they return rows, not errors)", () => {
    expect(db.sqlite.query(sql(SQL_RULE_TASKS)).all(...TASK_ARGS).length).toBeGreaterThan(0);
    expect(db.sqlite.query(SQL_RULE_EVENTS).all(...EVENT_ARGS).length).toBeGreaterThan(0);
    expect(db.sqlite.query(SQL_RULE_ALERTS).all(...ALERT_ARGS).length).toBeGreaterThan(0);
    expect(db.sqlite.query(SQL_STATE_ALERTS).all(...STATE_ALERT_ARGS).length).toBeGreaterThan(0);
    expect(db.sqlite.query(SQL_STATE_TASKS).all(NOW - 86_400_000).length).toBe(300);
    expect(db.sqlite.query(SQL_STATE_EVENTS).all().length).toBe(50);
    expect(db.sqlite.query(SQL_STATE_SNAPSHOTS).all()).toEqual([]);
  });
});

// The plans say "index seek", sqlite3's own counters say how much work it was: a flooded host must not lengthen the scans
// of the others, nor its own beyond what its caps allow. (Skipped where there is no `sqlite3` binary.)
const SQLITE3 = Bun.which("sqlite3");
describe.skipIf(!SQLITE3)("alert scans read the rows they return, not the table (sqlite3 counters)", () => {
  const sqlLit = (q: string, ...v: Array<number | string>): string => q.replace(/\?(\d)/g, (_, d: string) => String(v[Number(d) - 1]));
  /** Run `q` on a copy of `db` in sqlite3 and return its `.stats` counters. */
  function stats(db: D1Shim, q: string): { steps: number; fullscan: number; rows: number } {
    const dir = mkdtempSync(join(tmpdir(), "siiswell-q-"));
    try {
      writeFileSync(join(dir, "t.db"), db.sqlite.serialize());
      writeFileSync(join(dir, "q.sql"), `${q};\n`);
      const out = Bun.spawnSync([SQLITE3 as string, "-cmd", ".stats on", join(dir, "t.db"), `.read ${join(dir, "q.sql")}`]).stdout.toString();
      const num = (name: string): number => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? NaN);
      return { steps: num("Virtual Machine Steps"), fullscan: num("Fullscan Steps"), rows: out.split("\n").filter((l) => /^[\w.|:@-]+\|/.test(l)).length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const flooded = (open: number): D1Shim => {
    const { db } = makeEnv();
    db.sqlite.exec("BEGIN");
    const ins = db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, resolved) VALUES (?, 'approval-waiting', 'warn', '" + ORIGIN_HOST + "', ?, 'p', 'x', ?, ?)");
    for (let i = 0; i < open; i++) ins.run(`big${i}`, "big", NOW - i, i % 10 === 0 ? NOW - 1000 : null);
    ins.run("q1", "quiet", NOW, null);
    ins.run("q2", "quiet", NOW - 5, null);
    db.sqlite.exec("COMMIT");
    db.sqlite.exec("ANALYZE");
    return db;
  };

  test("the rule scan costs the same for a host with 3,000 open alerts as for one with 30,000: its own limit, not its size", () => {
    const q = sqlLit(SQL_RULE_ALERTS, RULE_PART_ALERTS + 1, NOW - 1_800_000, RULE_PART_ALERTS_RESOLVED, RULE_ALERT_LIMIT + 1);
    const small = stats(flooded(3_000), q);
    const large = stats(flooded(30_000), q);
    expect(large.fullscan).toBeLessThanOrEqual(small.fullscan + 2); // no scan of the table
    expect(large.steps).toBeLessThanOrEqual(small.steps * 1.2); // ten times the alerts, the same work
    expect(large.steps).toBeLessThan(60_000); // fix6: 2.5 M steps for 30,000 alerts
  });

  test("the inbox query is bounded per host in the same way", () => {
    const q = sqlLit(SQL_STATE_ALERTS, MAX_STATE_ALERTS_PER_HOST + 1, MAX_STATE_ALERTS + 1);
    const small = stats(flooded(3_000), q);
    const large = stats(flooded(30_000), q);
    expect(large.steps).toBeLessThanOrEqual(small.steps * 1.2);
    expect(large.rows).toBeGreaterThan(MAX_STATE_ALERTS_PER_HOST / 2); // (the counter sees the rows)
    expect(large.rows).toBeLessThanOrEqual(MAX_STATE_ALERTS_PER_HOST + 1 + 2); // the flooded host's newest, plus the quiet host's two
  });
});
