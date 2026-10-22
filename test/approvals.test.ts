/** Human load step 3: the approval inbox (opt-in batching) and local permission suggestions. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { covered, ruleKey, suggestPermissions } from "../cli/src/permissions";
import { WB_DEFAULTS, applyPushPolicy, approvalsPerDay, validateSettings } from "../src/wellbeing";
import { cli, scratchHome } from "./cli-helpers";

const MIN = 60_000;
const NOW = Date.UTC(2027, 6, 1, 12, 0);
const item = (rule: string, extra: Record<string, unknown> = {}) => ({ key: `k-${rule}`, rule, severity: "warn", host: "h", project: "p", agent: null, opened: NOW - 10 * MIN, pushCount: 1, lastPushed: NOW - 20 * MIN, summarizedAt: null, ...extra }) as never;

describe("approval inbox (settings approvalBatchMin)", () => {
  test("off (default): an approval is pushed at once; on: held for the batch, and one already held is not rewritten", () => {
    const base = { now: NOW, focusUntil: 0, quietLast: new Map() };
    expect(WB_DEFAULTS.approvalBatchMin).toBe(0);
    expect(applyPushPolicy([item("approval-waiting")], { ...base, settings: { ...WB_DEFAULTS, groupWaitSec: 0 } }).send.length).toBe(1);
    const on = { ...WB_DEFAULTS, groupWaitSec: 0, approvalBatchMin: 15 };
    const r = applyPushPolicy([item("approval-waiting"), item("blocked")], { ...base, settings: on });
    expect([r.hold.map((i: any) => i.rule), r.send.map((i: any) => i.rule)]).toEqual([["approval-waiting"], ["blocked"]]); // only approvals wait
    const held = applyPushPolicy([item("approval-waiting", { summarizedAt: NOW - 5 * MIN })], { ...base, settings: on });
    expect([held.hold.length, held.skip.length]).toEqual([0, 1]);
  });
  test("settings: 0, 15 or 30 minutes", () => {
    expect([0, 15, 30].map((n) => validateSettings({ approvalBatchMin: n }).ok)).toEqual([true, true, true]);
    expect(validateSettings({ approvalBatchMin: 5 }).ok).toBe(false);
  });
  test("approvals per day: the average over the days with input (London days)", () => {
    const s = { tz: "Europe/London" };
    const h = (iso: string, approvals: number, prompts = 1) => ({ h: Date.parse(iso), prompts, approvals, rapid: 0, rapidMin: 0, latN: 0, latP50: null });
    expect(approvalsPerDay([h("2027-07-01T09:00:00Z", 20), h("2027-07-01T10:00:00Z", 10), h("2027-07-02T09:00:00Z", 30), h("2027-07-03T09:00:00Z", 0, 0)], s)).toBe(30);
    expect(approvalsPerDay([], s)).toBe(0);
  });
});

describe("permissions suggest (local only)", () => {
  test("rule keys: a command's first word(s), a domain, a tool; never the rest of a command", () => {
    expect(ruleKey("Bash", { command: "git push origin feature/acme-secret" })).toBe("Bash(git push:*)");
    expect(ruleKey("Bash", { command: "FOO=1 npm test -- --watch" })).toBe("Bash(npm test:*)");
    expect(ruleKey("Bash", { command: "ls -la /home/x" })).toBe("Bash(ls:*)");
    expect(ruleKey("Bash", { command: "./deploy.sh prod" })).toBeNull(); // a path: not a rule key
    expect(ruleKey("WebFetch", { url: "https://docs.example.com/a?b=c" })).toBe("WebFetch(domain:docs.example.com)");
    expect(ruleKey("Read", { file_path: "/x" })).toBeNull();
    expect(ruleKey("mcp__github__create_issue", {})).toBe("mcp__github__create_issue");
  });
  test("covered: exact, the whole tool, a Bash prefix, an MCP server", () => {
    expect(covered("Bash(git push:*)", ["Bash(git:*)"])).toBe(true);
    expect(covered("Bash(git push:*)", ["Bash(git status:*)"])).toBe(false);
    expect(covered("Bash(npm test:*)", ["Bash"])).toBe(true);
    expect(covered("mcp__github__create_issue", ["mcp__github"])).toBe(true);
    expect(covered("Edit", ["Write"])).toBe(false);
  });
  test("counts the uncovered calls of the last 7 days from the transcripts; prints a snippet; sends nothing", async () => {
    const home = scratchHome();
    const dir = join(home, ".claude", "projects", "-w-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status:*)"] } }));
    const use = (name: string, input: unknown, ago: number) => JSON.stringify({ type: "assistant", timestamp: new Date(NOW - ago).toISOString(), message: { content: [{ type: "tool_use", id: "x", name, input }] } });
    const lines = [
      use("Bash", { command: "git status" }, MIN),
      use("Bash", { command: "npm test" }, MIN),
      use("Bash", { command: "npm test -- -t SECRET-TEST-NAME" }, MIN),
      use("Bash", { command: "npm test" }, 10 * 86_400_000), // older than 7 days
      use("WebFetch", { url: "https://api.example.com/x" }, MIN),
      "{ not json \"tool_use\"",
    ];
    const f = join(dir, "s1.jsonl");
    writeFileSync(f, lines.join("\n") + "\n");
    utimesSync(f, new Date(NOW), new Date(NOW));
    const r = suggestPermissions(home, NOW);
    expect(r.suggestions).toEqual([{ rule: "Bash(npm test:*)", count: 2 }, { rule: "WebFetch(domain:api.example.com)", count: 1 }]);
    expect([r.calls, r.allowed]).toEqual([4, 1]);
    const offline = (() => { throw new Error("no network for permissions suggest"); }) as never;
    const out = await cli(["permissions", "suggest"], { HOME: home }, { now: () => NOW, fetch: offline });
    expect(out.code).toBe(0);
    expect(out.out).toContain('"Bash(npm test:*)"');
    expect(out.out).toContain("nothing was sent");
    expect(out.out).not.toContain("SECRET-TEST-NAME");
    const j = JSON.parse((await cli(["permissions", "suggest", "--json", "--top", "1"], { HOME: home }, { now: () => NOW, fetch: offline })).out);
    expect(j.suggestions).toEqual([{ rule: "Bash(npm test:*)", count: 2 }]);
  });
});

describe("reviewer5 MED 2: the inbox shortens the digest interval only while held approvals wait", () => {
  test("no held approval: the Scheduled Summary keeps its interval; a held one: delivered after approvalBatchMin", async () => {
    const { runDigest, loadWbState } = await import("../src/wellbeing");
    const { makeEnv } = await import("./d1-shim");
    const t = makeEnv();
    t.db.sqlite.query("INSERT INTO wb_settings (k, v, updated) VALUES ('settings', ?, 0), ('rt:digest', ?, 0)").run(JSON.stringify({ tz: "UTC", digestMin: 60, approvalBatchMin: 15, quietStart: "00:00", quietEnd: "00:00", summaryTimes: [] }), String(NOW));
    // an overdue item (batch tier) is waiting, but no approval: nothing before the 60 min interval
    t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, push_count, summarized_at) VALUES ('o1', 'overdue', 'warn', 'host', 'h', 'p', 'x', ?, 0, ?)").run(NOW - MIN, NOW - MIN);
    const sent: unknown[] = [];
    const run = async (now: number) => runDigest(t.env.DB, (await loadWbState(t.env.DB, now))!, now, "https://d", async (m) => { sent.push(m); return true; });
    expect(await run(NOW + 20 * MIN)).toBe(0);
    // a held approval: the inbox interval (15 min) applies; the digest carries both
    t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, origin, host, project, text, opened, push_count, summarized_at) VALUES ('a1', 'approval-waiting', 'warn', 'host', 'h', 'p', 'x', ?, 0, ?)").run(NOW + 10 * MIN, NOW + 10 * MIN);
    expect(await run(NOW + 21 * MIN)).toBe(2);
    expect(sent.length).toBe(1);
  });
});
