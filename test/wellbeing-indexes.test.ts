/** Migration 0008 and the plans of the well-being reads: the plan-limit read seeks idx_snapshots_received; the open-alert count seeks idx_alerts_resolved. */
import { describe, expect, test } from "bun:test";
import { INTERRUPT_RULES, SQL_RECORD_HOUR, SQL_STRESS_INPUTS, WAITING_RULES } from "../src/wellbeing-metrics";
import { makeEnv } from "./d1-shim";

const plan = (t: ReturnType<typeof makeEnv>, sql: string, ...args: unknown[]) =>
  t.db.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])).map((r: any) => String(r.detail));

describe("well-being query plans", () => {
  test("plan limit: the snapshots of the last 6 hours by idx_snapshots_received (migration 0008)", () => {
    const t = makeEnv();
    const p = plan(t, "SELECT MAX(CAST(json_extract(u.value, '$.usedPercent') AS REAL)) AS m FROM snapshots s, json_each(s.json, '$.agents') a, json_each(a.value, '$.usage') u WHERE s.received_at >= ?1", 5);
    expect(p.some((d) => d.includes("idx_snapshots_received"))).toBe(true);
    expect(p.some((d) => /SCAN s\b/.test(d))).toBe(false);
  });
  test("open waiting alerts: a seek of idx_alerts_resolved (resolved=NULL), never a scan of alerts", () => {
    const t = makeEnv();
    const list = WAITING_RULES.map((r) => `'${r}'`).join(", ");
    const p = plan(t, `SELECT COUNT(*) AS n FROM alerts WHERE resolved IS NULL AND rule IN (${list})`);
    expect(p).toEqual(["SEARCH alerts USING INDEX idx_alerts_resolved (resolved=?)"]);
    expect(INTERRUPT_RULES.length).toBeGreaterThan(0);
  });
  test("the tick's statements never scan alerts, snapshots or events", () => {
    const t = makeEnv();
    for (const [sql, n] of [[SQL_RECORD_HOUR, 5], [SQL_STRESS_INPUTS, 10]] as const) {
      const p = plan(t, sql, ...Array.from({ length: n }, (_, i) => i + 1));
      expect(p.filter((d) => /^SCAN (alerts|snapshots|events)\b/.test(d))).toEqual([]);
    }
  });
});
