/**
 * Usage collector, phase 4: app labels (Claude Code `entrypoint`, Codex `originator`), the raw cwd kept per bucket (a change of
 * `usage.roots` re-attributes the history and re-sends it), hourly rows. Fixtures only: a scratch HOME per test.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectUsage, readBank, readUnrecognised, type Bucket } from "../cli/src/usage/collect";
import { cli } from "./cli-helpers";
import { claudeApp, codexApp, parseClaudeUsage } from "../cli/src/usage/parse";
import { buildHourlyRows, buildUsageRows, dayBatches, foldHourlyToDayCap, fullKeyOf, pushUsage, rowAgent, type HourlyRow } from "../cli/src/usage/push";
import { scratchHome } from "./cli-helpers";

const NOW = Date.parse("2026-10-16T12:30:00Z");
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function claudeLine(o: { id: string; ago: number; cwd: string; entrypoint?: string; out?: number }): string {
  return JSON.stringify({
    type: "assistant", timestamp: iso(o.ago), cwd: o.cwd, sessionId: "s", ...(o.entrypoint ? { entrypoint: o.entrypoint } : {}),
    message: { id: o.id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "x" }], usage: { input_tokens: 10, output_tokens: o.out ?? 5 } },
  });
}

function codexRollout(dir: string, name: string, meta: Record<string, unknown>, ago: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), [
    JSON.stringify({ timestamp: iso(ago), type: "session_meta", payload: meta }),
    JSON.stringify({ timestamp: iso(ago), type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ timestamp: iso(ago), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 60, cached_input_tokens: 0, output_tokens: 40 } } } }),
    "",
  ].join("\n"));
}

function fixture(): { home: string; proj: string; other: string } {
  const home = scratchHome();
  const proj = join(home, "projects");
  const other = join(home, "elsewhere");
  const cdir = join(home, ".claude", "projects", "p");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, "cli.jsonl"), `${claudeLine({ id: "m1", ago: 2 * H, cwd: `${proj}/web`, entrypoint: "cli" })}\n`);
  writeFileSync(join(cdir, "desk.jsonl"), `${claudeLine({ id: "m2", ago: 2 * H, cwd: `${other}/site`, entrypoint: "claude-desktop" })}\n`);
  writeFileSync(join(cdir, "wt.jsonl"), `${claudeLine({ id: "m3", ago: 3 * H, cwd: `${proj}/web/worktrees/web-dev`, entrypoint: "cli" })}\n`);
  const xdir = join(home, ".codex", "sessions", ...new Date(NOW).toISOString().slice(0, 10).split("-"));
  codexRollout(xdir, "rollout-a.jsonl", { cwd: `${proj}/api`, originator: "codex_cli_rs", source: "cli" }, H);
  codexRollout(xdir, "rollout-b.jsonl", { cwd: `${proj}/api`, originator: "Codex Desktop", source: "vscode" }, H);
  codexRollout(xdir, "rollout-c.jsonl", { cwd: `${proj}/api`, originator: "codex_exec", source: "exec" }, H);
  return { home, proj, other };
}

const label = (b: Bucket) => `${b.project}/${b.agent}/${b.app}`;

describe("app labels", () => {
  test("Claude Code entrypoint -> app", () => {
    expect(["cli", "claude-desktop", "sdk-ts", "sdk-py", "sdk-cli", "claude-vscode", "jetbrains", "mystery", "", undefined, 7, "x".repeat(100)].map(claudeApp)).toEqual(
      ["claude-cli", "claude-desktop", "claude-sdk", "claude-sdk", "claude-sdk", "claude-ide", "claude-ide", "unknown", "unknown", "unknown", "unknown", "unknown"],
    );
    // read from the line next to the usage (never from the content)
    const l = parseClaudeUsage(JSON.parse(claudeLine({ id: "m", ago: 0, cwd: "/x", entrypoint: "cli" })));
    expect(l?.app).toBe("claude-cli");
    expect(parseClaudeUsage(JSON.parse(claudeLine({ id: "m", ago: 0, cwd: "/x" })))?.app).toBeUndefined();
  });

  test("Codex originator (else source) -> app", () => {
    expect(codexApp("codex_cli_rs")).toBe("codex-cli");
    expect(codexApp("codex_exec")).toBe("codex-exec");
    expect(codexApp("codex_vscode")).toBe("codex-ide");
    expect(codexApp("Codex Desktop")).toBe("codex-desktop");
    expect(codexApp("codex_desktop", "vscode")).toBe("codex-desktop");
    expect(codexApp(undefined, "cli")).toBe("codex-cli");
    expect(codexApp(undefined, "exec")).toBe("codex-exec");
    expect(codexApp(undefined, "vscode")).toBe("codex-ide");
    expect(codexApp("something_else")).toBe("unknown");
    expect(codexApp(undefined, undefined)).toBe("unknown");
  });

  test("the collector banks the app and the raw cwd per bucket", () => {
    const fx = fixture();
    const { bank } = collectUsage({ home: fx.home, stateDir: join(fx.home, "st"), roots: [fx.proj], tz: "UTC", now: NOW });
    expect(new Set(bank.daily.map(label))).toEqual(new Set([
      "web/operator/claude-cli", "(other)/claude/claude-desktop", "web/dev/claude-cli",
      "api/operator/codex-cli", "api/operator/codex-desktop", "api/codex/codex-exec",
    ]));
    expect(bank.daily.every((b) => typeof b.cwd === "string" && b.cwd.startsWith(fx.home))).toBe(true);
    expect(bank.hourly.every((b) => typeof b.app === "string")).toBe(true);
  });

  test("rowAgent: the app, a worktree agent after a dot only where names may leave", () => {
    expect(rowAgent({ agent: "operator", app: "claude-cli" }, true)).toBe("claude-cli");
    expect(rowAgent({ agent: "dev", app: "claude-cli" }, true)).toBe("claude-cli.dev");
    expect(rowAgent({ agent: "dev", app: "claude-cli" }, false)).toBe("claude-cli");
    expect(rowAgent({ agent: "dev", app: undefined }, true)).toBe("unknown.dev");
    expect(rowAgent({ agent: "x".repeat(70), app: "codex-cli" }, true)).toBe("codex-cli");
    expect(rowAgent({ agent: "dev", app: "made-up-app" }, true)).toBe("unknown.dev"); // never a value outside the vocabulary
  });
});

describe("unrecognised app values are counted locally", () => {
  test("counts per session, shown by usage show, never in the rows", async () => {
    const fx = fixture();
    const cdir = join(fx.home, ".claude", "projects", "p");
    writeFileSync(join(cdir, "odd1.jsonl"), `${claudeLine({ id: "o1", ago: H, cwd: `${fx.proj}/web`, entrypoint: "mystery-app" })}\n`);
    writeFileSync(join(cdir, "odd2.jsonl"), `${claudeLine({ id: "o2", ago: H, cwd: `${fx.proj}/web`, entrypoint: "mystery-app" })}\n`);
    const xdir = join(fx.home, ".codex", "sessions", ...new Date(NOW).toISOString().slice(0, 10).split("-"));
    codexRollout(xdir, "rollout-odd.jsonl", { cwd: `${fx.proj}/api`, originator: "odd_thing" }, H);
    const st = join(fx.home, "st");
    const bank = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW }).bank;
    expect(readUnrecognised(st)).toEqual({ "claude:mystery-app": 2, "codex:odd_thing": 1 });
    collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW }); // incremental: not counted again
    expect(readUnrecognised(st)["claude:mystery-app"]).toBe(2);
    expect(JSON.stringify(buildUsageRows(bank.daily, { enabled: true, projectNames: "all", keep: [] }, (n) => n))).not.toContain("mystery");
    const r = await cli(["usage", "show", "--day", new Date(NOW).toISOString().slice(0, 10)], { HOME: fx.home, SIISWELL_STATE_DIR: st });
    expect(r.out).toContain("unrecognised app values");
    expect(r.out).toContain("claude:mystery-app  2");
  });
});

describe("raw cwd: a change of roots re-attributes the history", () => {
  test("the bank follows the roots on the next run, without deleting state", () => {
    const fx = fixture();
    const st = join(fx.home, "st");
    collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW });
    const again = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj, fx.other], tz: "UTC", now: NOW });
    expect(again.run.filesRead).toBe(0); // nothing re-read: only re-attributed
    expect(new Set(again.bank.daily.map(label))).toContain("site/operator/claude-desktop");
    expect(new Set(again.bank.hourly.map(label))).toContain("site/operator/claude-desktop");
    const back = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW });
    expect(new Set(back.bank.daily.map(label))).toContain("(other)/claude/claude-desktop");
    // the raw cwd stays local: the bank has it, the rows never do
    const rows = buildUsageRows(back.bank.daily, { enabled: true, projectNames: "all", keep: [] }, (n) => n);
    expect(JSON.stringify(rows)).not.toContain(fx.home);
    expect(JSON.stringify(buildHourlyRows(back.bank.hourly, { enabled: true, projectNames: "all", keep: [] }, (n) => n))).not.toContain(fx.home);
  });

  test("the full-history key changes with the roots and the attribution scheme", () => {
    const p = { enabled: true, projectNames: "other" as const, keep: [] };
    expect(fullKeyOf("UTC", p, ["/a"])).toBe(fullKeyOf("UTC", p, ["/a"]));
    expect(fullKeyOf("UTC", p, ["/a"])).not.toBe(fullKeyOf("UTC", p, ["/a", "/b"]));
    expect(fullKeyOf("UTC", p, ["/b", "/a"])).toBe(fullKeyOf("UTC", p, ["/a", "/b"]));
  });

  test("a push after a roots change re-sends the whole history (dry run)", async () => {
    const fx = fixture();
    const st = join(fx.home, "st");
    const policy = { enabled: true, projectNames: "all" as const, keep: [] };
    const bank = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW }).bank;
    // pretend the history was delivered under the old roots
    const fullKey = fullKeyOf("UTC", policy, [fx.proj]);
    writeFileSync(join(st, "usage-push-state.json"), JSON.stringify({ v: 1, targets: { "https://d.example|h": { version: NOW, fullKey, policyFp: "1|all|", fullAt: NOW } } }), { mode: 0o600 });
    const base = { base: "https://d.example", hostToken: "x", host: "h", stateDir: st, policy, tz: "UTC", daily: bank.daily, hourly: bank.hourly, version: NOW, now: NOW, log: () => undefined, dryRun: true };
    const same = await pushUsage({ ...base, roots: [fx.proj] });
    expect(same.bodies!.every((b) => b.mode === "recent")).toBe(true);
    const moved = await pushUsage({ ...base, roots: [fx.proj, fx.other] });
    expect(moved.bodies!.some((b) => b.mode === "full")).toBe(true);
  });

  test("a bank from an older collector (no cwd / app) keeps its labels and is not double counted on backfill", () => {
    const fx = fixture();
    const st = join(fx.home, "st");
    collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW });
    // rewrite the bank and state the way the previous collector stored them
    const bank = readBank(st)!;
    // the previous collector had one bucket per (key, project, agent, source, model, variant)
    const strip = (l: Bucket[]) => {
      const m = new Map<string, Bucket>();
      for (const { cwd: _c, app: _a, ...b } of l) {
        const k = [b.key, b.project, b.agent, b.source, b.model, b.variant].join("|");
        const cur = m.get(k);
        if (!cur) m.set(k, { ...b });
        else { cur.input += b.input; cur.output += b.output; cur.requests += b.requests; }
      }
      return [...m.values()];
    };
    writeFileSync(join(st, "usage.json"), JSON.stringify({ ...bank, scheme: undefined, daily: strip(bank.daily), hourly: strip(bank.hourly) }), { mode: 0o600 });
    const state = JSON.parse(readFileSync(join(st, "usage-state.json"), "utf8"));
    for (const f of Object.values(state.files) as Array<Record<string, unknown>>) { delete f.c; delete f.e; }
    writeFileSync(join(st, "usage-state.json"), JSON.stringify(state), { mode: 0o600 });
    const sum = (l: Bucket[]) => l.reduce((n, b) => n + b.input + b.output + b.requests, 0);
    const before = sum(bank.daily);
    // the first run of the new version re-reads the logs ONCE (automatic backfill) and labels the history by app
    const inc = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW });
    expect(inc.run.mode).toBe("backfill");
    expect(sum(inc.bank.daily)).toBe(before);
    expect(inc.bank.daily.every((b) => b.cwd !== undefined && b.app !== undefined)).toBe(true);
    expect(collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW }).run.mode).toBe("incremental"); // once
    const back = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW, backfill: true });
    expect(sum(back.bank.daily)).toBe(before);
    expect(sum(back.bank.hourly)).toBe(before);
    expect(back.bank.daily.every((b) => b.cwd !== undefined)).toBe(true); // fully covered by the re-read: the legacy buckets are gone
  });
});

describe("upgrade backfill is immune to a roots change and keeps what the logs no longer hold", () => {
  function legacyBank(st: string, fx: ReturnType<typeof fixture>) {
    collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW });
    const bank = readBank(st)!;
    const strip = (l: Bucket[]) => {
      const m = new Map<string, Bucket>();
      for (const { cwd: _c, app: _a, ...b } of l) {
        const k = [b.key, b.project, b.agent, b.source, b.model, b.variant].join("|");
        const cur = m.get(k);
        if (!cur) m.set(k, { ...b });
        else { cur.input += b.input; cur.output += b.output; cur.requests += b.requests; }
      }
      return [...m.values()];
    };
    writeFileSync(join(st, "usage.json"), JSON.stringify({ ...bank, scheme: undefined, daily: strip(bank.daily), hourly: strip(bank.hourly) }), { mode: 0o600 });
    return bank;
  }
  const sum = (l: Bucket[]) => l.reduce((n, b) => n + b.input + b.output + b.requests, 0);

  test("roots changed in the same run as the upgrade: no double counting, no legacy residue", () => {
    const fx = fixture();
    const st = join(fx.home, "st");
    const before = sum(legacyBank(st, fx).daily);
    const up = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj, fx.other], tz: "UTC", now: NOW });
    expect(up.run.mode).toBe("backfill");
    expect(sum(up.bank.daily)).toBe(before);
    expect(sum(up.bank.hourly)).toBe(before);
    expect(up.bank.daily.some((b) => b.cwd === undefined)).toBe(false);
  });

  test("a deleted log leaves exactly its legacy residual (still unknown), nothing more", () => {
    const fx = fixture();
    const st = join(fx.home, "st");
    const before = sum(legacyBank(st, fx).daily);
    const gone = join(fx.home, ".claude", "projects", "p", "desk.jsonl");
    const lost = 10 + 5 + 1; // that log's message: 10 in, 5 out, 1 request
    rmSync(gone);
    const up = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW });
    expect(sum(up.bank.daily)).toBe(before);
    const residual = up.bank.daily.filter((b) => b.cwd === undefined);
    expect(sum(residual)).toBe(lost);
  });
});

describe("hourly rows", () => {
  test("hourly rows follow the same policy as daily, and add up to them", () => {
    const fx = fixture();
    const bank = collectUsage({ home: fx.home, stateDir: join(fx.home, "st"), roots: [fx.proj], tz: "UTC", now: NOW }).bank;
    for (const policy of [{ enabled: true, projectNames: "other" as const, keep: [] }, { enabled: true, projectNames: "all" as const, keep: [] }]) {
      const d = buildUsageRows(bank.daily, policy, (n) => n);
      const h = buildHourlyRows(bank.hourly, policy, (n) => n);
      expect(h.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(r.hour))).toBe(true);
      const tot = (l: Array<{ input: number; output: number; requests: number }>) => l.reduce((n, r) => n + r.input + r.output + r.requests, 0);
      expect(tot(h)).toBe(tot(d));
      expect(new Set(h.map((r) => `${r.project}/${r.agent}`))).toEqual(new Set(d.map((r) => `${r.project}/${r.agent}`)));
    }
  });

  test("a day over the hourly cap folds per hour, nothing lost; batches keep a day's hourly rows with it", () => {
    const rows: HourlyRow[] = Array.from({ length: 1300 }, (_, i) => ({ hour: `2026-10-15T${String(i % 24).padStart(2, "0")}`, project: `p${i}`, agent: "a", source: "claude", model: "unknown", input: i + 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 1, usd: null }));
    const f = foldHourlyToDayCap(rows);
    expect(f.length).toBeLessThanOrEqual(1200);
    expect(f.reduce((n, r) => n + r.input, 0)).toBe(rows.reduce((n, r) => n + r.input, 0));
    const daily = [{ day: "2026-10-15", project: "x", agent: "a", source: "claude", model: "unknown", input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 1, usd: null }];
    const parts = dayBatches(["2026-10-14", "2026-10-15", "2026-10-16"], [...daily, { ...daily[0]!, day: "2026-10-16" }], 1000, 35, [...f, { ...f[0]!, hour: "2026-10-16T01" }]);
    expect(parts.map((p) => p.days)).toEqual([["2026-10-14"], ["2026-10-15"], ["2026-10-16"]]);
    expect(parts[1]!.hourly.length).toBe(f.length);
    expect(parts[2]!.hourly.length).toBe(1);
  });

  test("push bodies carry an hourly block only when hourly buckets are given", async () => {
    const fx = fixture();
    const st = join(fx.home, "st");
    const bank = collectUsage({ home: fx.home, stateDir: st, roots: [fx.proj], tz: "UTC", now: NOW }).bank;
    const base = { base: "https://d.example", hostToken: "x", host: "h", stateDir: st, policy: { enabled: true, projectNames: "other" as const, keep: [] }, tz: "UTC", daily: bank.daily, version: NOW, now: NOW, log: () => undefined, dryRun: true };
    const without = await pushUsage(base);
    expect(without.bodies!.every((b) => !("hourly" in b))).toBe(true);
    const withH = await pushUsage({ ...base, hourly: bank.hourly });
    expect(withH.bodies!.every((b) => Array.isArray(b.hourly))).toBe(true);
    for (const b of withH.bodies!) {
      const days = new Set(b.completeDays as string[]);
      expect((b.hourly as HourlyRow[]).every((r) => days.has(r.hour.slice(0, 10)))).toBe(true);
    }
    expect(withH.hourlySent).toBeGreaterThan(0);
  });
});
