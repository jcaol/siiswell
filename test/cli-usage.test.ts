import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attribute, collectUsage, hourKey, openRegular, readBank } from "../cli/src/usage/collect";
import { buildUsageRows, dayBatches, foldToDayCap, isStricter, policyFingerprint, pushUsage, type Policy } from "../cli/src/usage/push";
import { sanitizeUsageBatch } from "../src/usage";
import { cli, scratchHome, startServer, type TestServer } from "./cli-helpers";

/** Text that only appears in message CONTENT: it must never show up in any state file, output or request. */
const CONTENT = "PRIVATE-CONTENT-7f3a";
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;

function claudeLine(o: { id: string; ago: number; cwd: string; model?: string; usage: Record<string, unknown> }): string {
  return JSON.stringify({
    type: "assistant", timestamp: iso(o.ago), cwd: o.cwd, sessionId: "s1", uuid: `u-${o.id}-${o.ago}`,
    message: { id: o.id, model: o.model ?? "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: `${CONTENT} "usage" in the text` }], usage: o.usage },
  });
}
function userLine(ago: number, cwd: string): string {
  return JSON.stringify({ type: "user", timestamp: iso(ago), cwd, message: { role: "user", content: `${CONTENT} please read my "usage" file` } });
}

interface Fixture { home: string; claudeMain: string; claudeSub: string; codex: string }

/** A fake ~/.claude and ~/.codex in a scratch HOME. */
function makeFixture(): Fixture {
  const home = scratchHome();
  const proj = join(home, "projects");
  const cdir = join(home, ".claude", "projects", "-home-u-projects-alpha");
  mkdirSync(join(cdir, "s1", "subagents"), { recursive: true });
  const claudeMain = join(cdir, "s1.jsonl");
  writeFileSync(claudeMain, [
    userLine(3 * H, `${proj}/alpha`),
    // one message repeated per content block with CUMULATIVE usage: counted once, as its growth
    claudeLine({ id: "msg_1", ago: 3 * H, cwd: `${proj}/alpha`, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 50 } } }),
    claudeLine({ id: "msg_1", ago: 3 * H, cwd: `${proj}/alpha`, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 50 } } }),
    claudeLine({ id: "msg_2", ago: 2 * H, cwd: `${proj}/alpha`, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    "{ this line is not json \"usage\"",
    "",
  ].join("\n"));
  const claudeSub = join(cdir, "s1", "subagents", "agent-a.jsonl");
  writeFileSync(claudeSub, `${claudeLine({ id: "msg_sub", ago: 2 * H, cwd: `${proj}/alpha/worktrees/alpha-dev`, model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 2 } })}\n`);

  const xdir = join(home, ".codex", "sessions", ...new Date(NOW).toISOString().slice(0, 10).split("-"));
  mkdirSync(xdir, { recursive: true });
  const codex = join(xdir, "rollout-2026-test.jsonl");
  const tc = (ago: number, total: number, input: number, cached: number, output: number) =>
    JSON.stringify({ timestamp: iso(ago), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
  writeFileSync(codex, [
    JSON.stringify({ timestamp: iso(4 * H), type: "session_meta", payload: { cwd: `${proj}/beta`, source: "cli", instructions: `${CONTENT}` } }),
    JSON.stringify({ timestamp: iso(4 * H), type: "turn_context", payload: { model: "gpt-5.5", cwd: `${proj}/beta` } }),
    JSON.stringify({ timestamp: iso(4 * H), type: "response_item", payload: { type: "message", content: [{ type: "input_text", text: `${CONTENT} "token_count"` }] } }),
    tc(4 * H, 1500, 1000, 400, 500),
    tc(4 * H, 1500, 1000, 400, 500), // repeated after a non-model event: not new spend
    tc(1 * H, 2000, 300, 100, 200),
    "",
  ].join("\n"));
  return { home, claudeMain, claudeSub, codex };
}

const totals = (bank: NonNullable<ReturnType<typeof readBank>>) => {
  const t = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, requests: 0 };
  for (const b of bank.daily) { t.input += b.input; t.output += b.output; t.cacheRead += b.cacheRead; t.cw5m += b.cacheWrite5m; t.cw1h += b.cacheWrite1h; t.requests += b.requests; }
  return t;
};

function stateFilesText(dir: string): string {
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

describe("usage collect", () => {
  test("token counts only: dedupe by message id, codex total growth, sub-agents included, no content anywhere", () => {
    const fx = makeFixture();
    const stateDir = join(fx.home, ".local", "state", "siiswell");
    const { run, bank } = collectUsage({ home: fx.home, stateDir, roots: [join(fx.home, "projects")], tz: "UTC" });
    expect(run.mode).toBe("first");
    expect([run.claudeFiles, run.codexFiles]).toEqual([2, 1]);
    const t = totals(bank);
    // claude: msg_1 (100 in, 40 out, 1000 cr, 150 cw5m + 50 cw1h) + msg_2 (5, 7) + sub (1, 2); codex: (1000-400, 500, 400) + (300-100, 200, 100)
    expect(t).toEqual({ input: 100 + 5 + 1 + 600 + 200, output: 40 + 7 + 2 + 500 + 200, cacheRead: 1000 + 400 + 100, cw5m: 150, cw1h: 50, requests: 3 + 2 });
    const projects = new Set(bank.daily.map((b) => `${b.project}/${b.agent}/${b.source}/${b.model}`));
    expect(projects).toEqual(new Set(["alpha/operator/claude/claude-opus-5-5", "alpha/dev/claude/claude-haiku-5-5", "beta/operator/codex/gpt-5.5"]));
    expect(bank.hourly.length).toBeGreaterThanOrEqual(3);
    expect(bank.hourly.every((b) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(b.key))).toBe(true);
    expect(bank.daily.every((b) => b.usd !== null && b.usd > 0)).toBe(true);
    // privacy: the content sentinel is nowhere in the state, and the dir / files are private
    expect(stateFilesText(stateDir)).not.toContain(CONTENT);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(stateDir)) expect(statSync(join(stateDir, f)).mode & 0o077).toBe(0);
  });

  test("hourly and daily agree; the hour key follows the time zone", () => {
    const fx = makeFixture();
    const { bank } = collectUsage({ home: fx.home, stateDir: join(fx.home, "st"), roots: [join(fx.home, "projects")], tz: "UTC" });
    const sum = (l: typeof bank.daily) => l.reduce((n, b) => n + b.input + b.output + b.requests, 0);
    expect(sum(bank.hourly)).toBe(sum(bank.daily));
    expect(hourKey(Date.parse("2026-07-01T23:30:00Z"), "UTC")).toBe("2026-07-01T23");
    expect(hourKey(Date.parse("2026-07-01T23:30:00Z"), "Europe/London")).toBe("2026-07-02T00");
    expect(hourKey(Date.parse("2026-07-01T23:30:00Z"), "Asia/Hong_Kong")).toBe("2026-07-02T07");
  });

  test("incremental: only appended lines are read; a shrunk file is re-read; a growing message adds only its growth", () => {
    const fx = makeFixture();
    const stateDir = join(fx.home, "st");
    const opts = { home: fx.home, stateDir, roots: [join(fx.home, "projects")], tz: "UTC" };
    const first = totals(collectUsage(opts).bank);
    const again = collectUsage(opts);
    expect(again.run.mode).toBe("incremental");
    expect(again.run.filesRead).toBe(0);
    expect(totals(again.bank)).toEqual(first);
    appendFileSync(fx.claudeMain, `${claudeLine({ id: "msg_1", ago: H, cwd: join(fx.home, "projects", "alpha"), usage: { input_tokens: 100, output_tokens: 90, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 50 } } })}\n`);
    appendFileSync(fx.claudeMain, `${claudeLine({ id: "msg_3", ago: H, cwd: join(fx.home, "projects", "alpha"), usage: { input_tokens: 11, output_tokens: 0 } })}\n`);
    appendFileSync(fx.claudeMain, '{"type":"assistant","partial line without newline');
    const third = collectUsage(opts);
    expect(third.run.filesRead).toBe(1);
    const t3 = totals(third.bank);
    expect(t3.output - first.output).toBe(50);
    expect(t3.input - first.input).toBe(11);
    expect(t3.requests - first.requests).toBe(1);
    // the partial line is not consumed: completing it later counts it
    appendFileSync(fx.claudeMain, '}\n');
    expect(totals(collectUsage(opts).bank)).toEqual(t3); // valid JSON but no usage: nothing new
  });

  test("lost offsets next to a bank re-read with the max merge (no double counting)", () => {
    const fx = makeFixture();
    const stateDir = join(fx.home, "st");
    const opts = { home: fx.home, stateDir, roots: [join(fx.home, "projects")], tz: "UTC" };
    const first = totals(collectUsage(opts).bank);
    writeFileSync(join(stateDir, "usage-state.json"), "corrupt");
    const r = collectUsage(opts);
    expect(r.run.mode).toBe("backfill");
    expect(totals(r.bank)).toEqual(first);
  });

  test("pricing overrides re-price the bank (and decide the long-context variant) on every run", () => {
    const fx = makeFixture();
    const opts = { home: fx.home, stateDir: join(fx.home, "st"), roots: [join(fx.home, "projects")], tz: "UTC" };
    const usd = (b: NonNullable<ReturnType<typeof readBank>>, m: string) => b.daily.filter((x) => x.model === m).reduce((n, x) => n + (x.usd ?? 0), 0);
    const base = collectUsage(opts).bank;
    // gpt-5.5 rows: 800 fresh input, 700 output, 500 cache read at $1 / $10 per million (cache read default = 0.1 x input)
    const over = collectUsage({ ...opts, pricingOverrides: { "gpt-5.5": { input: 1, output: 10 } } }).bank;
    expect(usd(over, "gpt-5.5")).toBeCloseTo((800 * 1 + 700 * 10 + 500 * 0.1) / 1e6, 9);
    expect(usd(over, "gpt-5.5")).not.toBeCloseTo(usd(base, "gpt-5.5"), 9);
    expect(usd(over, "claude-opus-5-5")).toBeCloseTo(usd(base, "claude-opus-5-5"), 9); // other models untouched
    const unknown = collectUsage({ ...opts, pricingOverrides: { "claude-haiku": { input: 0, output: 0 } } }).bank;
    expect(usd(unknown, "claude-haiku-5-5")).toBe(0);
  });

  test("a FIFO named like a transcript never blocks the scan", () => {
    const fx = makeFixture();
    const fifo = join(fx.home, ".claude", "projects", "-home-u-projects-alpha", "fifo.jsonl");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const codexFifo = join(fx.codex.replace(/rollout-2026-test\.jsonl$/, ""), "rollout-fifo.jsonl");
    expect(Bun.spawnSync(["mkfifo", codexFifo]).exitCode).toBe(0);
    const t0 = Date.now();
    expect(openRegular(fifo)).toBeNull();
    const { bank } = collectUsage({ home: fx.home, stateDir: join(fx.home, "st"), roots: [join(fx.home, "projects")], tz: "UTC" });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(bank.daily.length).toBeGreaterThan(0);
  });

  test("attribution: roots, worktrees, operator, exec runs, everything else (other)", () => {
    const roots = ["/home/u/projects", "/projects"];
    expect(attribute("/projects/web", "claude", roots)).toEqual({ project: "web", agent: "operator" });
    expect(attribute("/projects/web/worktrees/web-dev", "claude", roots)).toEqual({ project: "web", agent: "dev" });
    expect(attribute("/home/u/projects/web/src", "codex", roots)).toEqual({ project: "web", agent: "codex" });
    expect(attribute("/projects/web/worktrees/web-dev", "codex", roots, { exec: true })).toEqual({ project: "web", agent: "codex" });
    expect(attribute("/home/u/Documents/client-x", "claude", roots)).toEqual({ project: "(other)", agent: "claude" });
    expect(attribute(undefined, "claude", roots)).toEqual({ project: "(other)", agent: "claude" });
    expect(attribute("/projects", "claude", roots)).toEqual({ project: "(other)", agent: "claude" });
  });

  test("`usage collect` and `usage show` through the CLI", async () => {
    const fx = makeFixture();
    const env = { HOME: fx.home, SIISWELL_USAGE_TZ: "UTC" };
    const c = await cli(["usage", "collect"], env);
    expect(c.code).toBe(0);
    expect(c.out).toContain("collected (first, tz UTC)");
    const s = await cli(["usage", "show", "--json"], env);
    expect(s.code).toBe(0);
    expect(Object.keys(JSON.parse(s.out).hours).length).toBeGreaterThan(0);
    expect(c.out + s.out).not.toContain(CONTENT);
  });

  test("`usage show` lists each project by its LOCAL name next to the label it is uploaded as, with tokens and $; no network", async () => {
    const fx = makeFixture();
    const env = { HOME: fx.home, SIISWELL_USAGE_TZ: "UTC" };
    const offline = (() => { throw new Error("no network in usage show"); }) as never;
    expect((await cli(["usage", "collect"], env)).code).toBe(0);
    const day = new Date(NOW).toISOString().slice(0, 10);
    const j = JSON.parse((await cli(["usage", "show", "--day", day, "--json"], env, { fetch: offline })).out);
    expect(j.projectNames).toBe("hashed"); // a new install
    const names = j.projects.map((p: { project: string }) => p.project);
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta"]));
    for (const p of j.projects) {
      expect(p.label).toMatch(/^h-[0-9a-f]{12}$/);
      expect(p.tokens).toBeGreaterThan(0);
      expect(typeof p.usd).toBe("number");
    }
    // a kept name is uploaded as itself; the others stay hashed; the text view says both
    const cfg = join(fx.home, "cfg.json");
    writeFileSync(cfg, JSON.stringify({ usage: { projectNames: "hashed", keep: ["alpha"] } }), { mode: 0o600 });
    const k = JSON.parse((await cli(["usage", "show", "--day", day, "--json"], { ...env, SIISWELL_CONFIG: cfg }, { fetch: offline })).out);
    expect(k.projects.find((p: { project: string }) => p.project === "alpha").label).toBe("alpha");
    expect(k.projects.find((p: { project: string }) => p.project === "beta").label).toMatch(/^h-/);
    const t = await cli(["usage", "show", "--day", day], { ...env, SIISWELL_CONFIG: cfg }, { fetch: offline });
    expect(t.code).toBe(0);
    expect(t.out).toMatch(/alpha\s+uploaded as alpha\s/);
    expect(t.out).toMatch(/beta\s+uploaded as h-[0-9a-f]{12}/);
  });
});

describe("usage rows (privacy policy)", () => {
  const bucket = (project: string, agent: string, extra: Partial<{ key: string; model: string; usd: number | null; input: number; app: string }> = {}) => ({
    key: extra.key ?? "2026-10-15", project, agent, app: extra.app ?? "claude-cli", source: "claude" as const, model: extra.model ?? "claude-opus-5-5", variant: "" as const,
    input: extra.input ?? 10, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 1, usd: extra.usd === undefined ? 0.5 : extra.usd,
  });
  const hash = (n: string) => `h-${n.length.toString(16).padStart(12, "0")}`;

  test("default 'other' folds every project and its agent; keep opts a project in", () => {
    const b = [bucket("alpha", "dev"), bucket("beta", "operator"), bucket("(other)", "claude")];
    const rows = buildUsageRows(b, { enabled: true, projectNames: "other", keep: [] }, hash);
    // the app label names no project: it is the agent under every policy
    expect(rows.map((r) => `${r.project}/${r.agent}`)).toEqual(["(other)/claude-cli"]);
    expect(rows[0]!.input).toBe(30);
    const kept = buildUsageRows(b, { enabled: true, projectNames: "other", keep: ["alpha"] }, hash);
    expect(kept.map((r) => `${r.project}/${r.agent}`)).toContain("alpha/claude-cli.dev");
  });

  test("'hashed' hides names and worktree agents; 'all' keeps them; unknown models and bad labels never leave", () => {
    const b = [bucket("alpha", "dev"), bucket("alpha", "operator"), bucket("bad label!", "x"), bucket("beta", "ok", { model: "ft:my-client-model" })];
    const hashed = buildUsageRows(b, { enabled: true, projectNames: "hashed", keep: [] }, hash);
    expect(hashed.some((r) => r.project.includes("alpha") || r.project.includes("beta"))).toBe(false);
    // worktree names never survive hashing (they can carry the project name): only the app
    expect(hashed.map((r) => r.agent).sort()).toEqual(["claude-cli", "claude-cli", "claude-cli"]);
    expect(hashed.reduce((n, r) => n + r.input, 0)).toBe(40);
    const all = buildUsageRows(b, { enabled: true, projectNames: "all", keep: [] }, hash);
    expect(all.map((r) => `${r.project}/${r.agent}/${r.model}`)).toEqual(["(other)/claude-cli/claude-opus-5-5", "alpha/claude-cli.dev/claude-opus-5-5", "alpha/claude-cli/claude-opus-5-5", "beta/claude-cli.ok/unknown"]);
    const unpriced = buildUsageRows([bucket("a", "b", { usd: null }), bucket("a", "b")], { enabled: true, projectNames: "all", keep: [] }, hash);
    expect(unpriced[0]!.usd).toBeNull();
  });

  test("a day over 300 keys is folded into one row (nothing lost); days are never split across requests", () => {
    const many = Array.from({ length: 310 }, (_, i) => ({ day: "2026-10-15", project: `p${i}`, agent: "a", source: "claude", model: "unknown", input: i + 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 1, usd: null }));
    const folded = foldToDayCap(many);
    expect(folded.length).toBe(300);
    expect(folded.reduce((n, r) => n + r.input, 0)).toBe(many.reduce((n, r) => n + r.input, 0));
    const rows = [...folded, ...folded.map((r) => ({ ...r, day: "2026-10-16" }))];
    const parts = dayBatches(["2026-10-15", "2026-10-16"], rows, 400);
    expect(parts.map((p) => p.days)).toEqual([["2026-10-15"], ["2026-10-16"]]);
  });

  test("stricter policies are detected (fail closed on an unreadable fingerprint)", () => {
    const p = (projectNames: Policy["projectNames"], keep: string[] = []): Policy => ({ enabled: true, projectNames, keep });
    expect(isStricter(policyFingerprint(p("all")), p("hashed"))).toBe(true);
    expect(isStricter(policyFingerprint(p("hashed")), p("other"))).toBe(true);
    expect(isStricter(policyFingerprint(p("other", ["a"])), p("other"))).toBe(true);
    expect(isStricter(policyFingerprint(p("other")), p("other", ["a"]))).toBe(false);
    expect(isStricter(policyFingerprint(p("other")), p("all"))).toBe(false);
    expect(isStricter(undefined, p("other"))).toBe(true);
    expect(isStricter("garbage", p("all"))).toBe(true);
  });
});

describe("usage push against the server's own ingest", () => {
  let s: TestServer;
  beforeAll(async () => { s = await startServer(); });
  afterAll(() => s.stop());

  const usageRows = () => s.t.db.sqlite.query("SELECT day, project, agent, source, model, input, output, requests, usd FROM usage_daily WHERE host = ? ORDER BY day, project, agent, model").all(s.hostName) as Array<Record<string, unknown>>;

  test("dry run bodies are exactly the v1 format the server accepts", async () => {
    const fx = makeFixture();
    const { bank } = collectUsage({ home: fx.home, stateDir: join(fx.home, "st"), roots: [join(fx.home, "projects")], tz: "UTC" });
    const r = await pushUsage({ base: s.url, hostToken: s.host, host: s.hostName, stateDir: join(fx.home, "st"), policy: { enabled: true, projectNames: "all", keep: [] }, tz: "UTC", daily: bank.daily, version: NOW, log: () => undefined, dryRun: true });
    expect(r.bodies!.length).toBeGreaterThan(0);
    for (const body of r.bodies!) {
      expect(Object.keys(body).sort()).toEqual(["complete", "completeDays", "generatedAt", "host", "mode", "rows", "tz", "v"]);
      const ok = sanitizeUsageBatch(body, NOW);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.value.rows.length).toBe((body.rows as unknown[]).length); // nothing was rewritten by the server's validator
    }
    expect(s.seen.filter((x) => x.path === "/api/ingest/usage").length).toBe(0);
  });

  test("first push uploads recent days and the whole history; the server stores exactly the policy's labels; no content is sent", async () => {
    const fx = makeFixture();
    const env = { HOME: fx.home, SIISWELL_URL: s.url, SIISWELL_HOST_TOKEN: s.host, SIISWELL_HOST: s.hostName, SIISWELL_USAGE_TZ: "UTC" };
    const before = s.seen.length;
    const r = await cli(["usage", "push", "--json"], env);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const res = JSON.parse(r.out);
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("whole history");
    const rows = usageRows();
    expect(rows.length).toBeGreaterThan(0);
    // a new install's default policy: salted hashes, never the folder names
    expect(rows.every((x) => /^h-[0-9a-f]{12}$/.test(String(x.project)))).toBe(true);
    expect(rows.reduce((n, x) => n + Number(x.requests), 0)).toBe(5);
    expect((s.t.db.sqlite.query("SELECT has_full FROM usage_hosts WHERE host = ?").get(s.hostName) as { has_full: number }).has_full).toBe(1);
    const sent = s.seen.slice(before);
    expect(sent.every((x) => x.auth)).toBe(true);
    expect(sent.map((x) => x.body).join("\n")).not.toContain(CONTENT);
    expect(sent.map((x) => x.body).join("\n")).not.toContain("alpha");

    // second run: nothing new, only the recent days again (idempotent); then opt a project in (looser: no erase)
    const again = await cli(["usage", "push", "--json"], env);
    expect(JSON.parse(again.out).summary).not.toContain("whole history");
    writeFileSync(join(fx.home, "cfg.json"), JSON.stringify({ usage: { projectNames: "all", roots: ["~/projects"] } }), { mode: 0o600 });
    const looser = await cli(["usage", "push", "--json"], { ...env, SIISWELL_CONFIG: join(fx.home, "cfg.json") });
    expect(JSON.parse(looser.out).erased).toBeUndefined();
    expect(new Set(usageRows().map((x) => x.project))).toEqual(new Set(["alpha", "beta"]));

    // back to the default: stricter -> the names are erased first, then re-uploaded as hashes
    const stricter = await cli(["usage", "push", "--json"], env);
    expect(JSON.parse(stricter.out).erased).toBe(true);
    expect(usageRows().every((x) => /^h-[0-9a-f]{12}$/.test(String(x.project)))).toBe(true);

    // opt-out erases what this host label uploaded, and then sends nothing more
    const off = await cli(["usage", "push"], { ...env, SIISWELL_USAGE: "off" });
    expect(off.code).toBe(0);
    expect(off.out).toContain("erased");
    expect(usageRows().length).toBe(0);
    const n = s.seen.length;
    expect((await cli(["usage", "push"], { ...env, SIISWELL_USAGE: "off" })).out).toContain("nothing was uploaded");
    expect(s.seen.length).toBe(n);
  });

  test("end to end: Claude + Codex fixtures -> usage push -> GET /api/usage shows both sources", async () => {
    const t = await startServer();
    try {
      const fx = makeFixture();
      writeFileSync(join(fx.home, "cfg.json"), JSON.stringify({ usage: { projectNames: "all" } }), { mode: 0o600 });
      const env = { HOME: fx.home, SIISWELL_URL: t.url, SIISWELL_HOST_TOKEN: t.host, SIISWELL_HOST: t.hostName, SIISWELL_USAGE_TZ: "UTC", SIISWELL_CONFIG: join(fx.home, "cfg.json") };
      const r = await cli(["usage", "push"], env);
      expect([r.code, r.err]).toEqual([0, ""]);
      const res = await fetch(`${t.url}/api/usage?group=day`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { breakdown: Array<{ project: string; agent: string; source: string; model: string; requests: number }> };
      const codex = body.breakdown.filter((b) => b.source === "codex");
      expect(codex.map((b) => `${b.project}/${b.agent}/${b.model}/${b.requests}`)).toEqual(["beta/codex-cli/gpt-5.5/2"]);
      expect(body.breakdown.filter((b) => b.source === "claude").reduce((n, b) => n + b.requests, 0)).toBe(3);
      expect(JSON.stringify(body)).not.toContain(CONTENT);
    } finally {
      t.stop();
    }
  });

  test("a host label that is not the token's name is a 403 with a hint; a client token is refused", async () => {
    const fx = makeFixture();
    const r = await cli(["usage", "push"], { HOME: fx.home, SIISWELL_URL: s.url, SIISWELL_HOST_TOKEN: s.host, SIISWELL_HOST: "not-the-name", SIISWELL_USAGE_TZ: "UTC" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("403");
    expect(r.out).toContain("must be the name of this host token");
    const c = await cli(["usage", "push"], { HOME: fx.home, SIISWELL_URL: s.url, SIISWELL_HOST_TOKEN: s.client, SIISWELL_HOST: "laptop-client", SIISWELL_USAGE_TZ: "UTC" });
    expect(c.code).toBe(1);
    expect(c.out).toContain("403");
    expect(existsSync(join(fx.home, ".local", "state", "siiswell", "usage.json"))).toBe(true);
  });
});
