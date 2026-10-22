/** Operator activity: each host's hours in its own zone, one stress-input read per tick, Claude subagents not the operator. */
import { describe, expect, test } from "bun:test";
import { attribute, SUBAGENT } from "../cli/src/usage/collect";
import { rowAgent } from "../cli/src/usage/push";
import { activityOf, localHourStart, readStressInputs } from "../src/wellbeing-metrics";
import { operatorActivity, WB_DEFAULTS } from "../src/wellbeing";
import { makeEnv } from "./d1-shim";

const H = 3_600_000;

describe("activity in the host's zone", () => {
  test("activityOf reads each label in the zone that wrote it; the dashboard's zone only as the fallback", () => {
    const m = activityOf({ activity: "2027-07-10T09=5=Asia/Hong_Kong,2027-07-10T09=3=,2027-07-10T09=2=Not/AZone" }, "UTC");
    expect(m.get(Date.UTC(2027, 6, 10, 1))).toBe(5); // 09:00 in Hong Kong = 01:00 UTC
    expect(m.get(Date.UTC(2027, 6, 10, 9))).toBe(5); // no / an unknown zone: read in UTC, summed
    expect(activityOf({ activity: "2027-07-10T09=4" }, "Europe/London").get(localHourStart("2027-07-10", 9, "Europe/London"))).toBe(4);
  });
  test("operatorActivity joins usage_hosts.tz", async () => {
    const t = makeEnv({ DASHBOARD_TZ: "UTC" });
    t.db.sqlite.query("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz) VALUES ('hk', 1, 1, 'Asia/Hong_Kong')").run();
    t.db.sqlite.query("INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES ('2027-07-10T09', 'hk', 'p', 'claude-cli', 'claude', 'm', 1, 1, 0, 0, 0, 7, 0, 1)").run();
    const m = await operatorActivity(t.env.DB, Date.UTC(2027, 6, 9), "UTC");
    expect([...m]).toEqual([[Date.UTC(2027, 6, 10, 1), 7]]);
  });
});

describe("one stress-input read per tick", () => {
  test("the same tick (same now, same zone) shares the read; another tick reads again", async () => {
    const t = makeEnv({ DASHBOARD_TZ: "UTC" });
    let reads = 0;
    const prep = t.env.DB.prepare.bind(t.env.DB);
    (t.env.DB as { prepare: unknown }).prepare = (q: string) => { if (q.includes("AS activity")) reads++; return prep(q); };
    const s = { ...WB_DEFAULTS, tz: "UTC" };
    const now = Date.UTC(2027, 6, 10, 15, 7);
    const a = await readStressInputs(t.env.DB, s, now);
    const b = await readStressInputs(t.env.DB, s, now);
    expect(b).toBe(a);
    expect(reads).toBe(1);
    await readStressInputs(t.env.DB, s, now + 15 * 60_000);
    expect(reads).toBe(2);
  });
});

describe("Claude subagents are not the operator", () => {
  test("`.claude/worktrees/agent-*` is attributed to the project, as a subagent, and never an operator app label", () => {
    expect(attribute("/home/u/code/app/.claude/worktrees/agent-a1b2/src", "claude", [], {})).toEqual({ project: "app", agent: SUBAGENT });
    expect(attribute("/projects/app/.claude/worktrees/agent-x", "claude", ["/projects"])).toEqual({ project: "app", agent: SUBAGENT });
    expect(attribute("/projects/app", "claude", ["/projects"]).agent).toBe("operator");
    expect(rowAgent({ agent: SUBAGENT, app: "claude-cli" }, false)).toBe("claude-cli.subagent");
    expect(rowAgent({ agent: SUBAGENT, app: "claude-cli" }, true)).toBe("claude-cli.subagent");
  });
});
