import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, defaultProject, describe as describeConfig, loadConfig, normalizeBaseUrl, readConfigFile } from "../cli/src/config";
import { parseArgs, termSafe, UsageError } from "../cli/src/main";
import { redactToolCall } from "../cli/src/mcp-stdio";
import { cli, scratchHome, startServer, type TestServer } from "./cli-helpers";

const TOK = (c: string) => `oct_${c.repeat(43)}`;
const SECRET = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // a GitHub-token-shaped value: the redaction must remove it

describe("argument parsing", () => {
  test("positional, --flag value, --flag=value, booleans and --", () => {
    const p = parseArgs(["report", "fix", "the", "build", "--eta-min", "30", "--project=web", "--json", "--", "--literal"]);
    expect(p.positional).toEqual(["report", "fix", "the", "build", "--literal"]);
    expect(p.flags).toEqual({ "eta-min": "30", project: "web", json: true });
  });
  test("unknown flags, missing values and values on booleans are usage errors", () => {
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["report", "--eta-min"])).toThrow("needs a value");
    expect(() => parseArgs(["--json=1"])).toThrow("takes no value");
  });
  test("a token is never accepted as a flag", () => {
    for (const a of ["--token", "--token=oct_x", "--host-token", "--TOKEN"]) expect(() => parseArgs([a, "x"])).toThrow("never accepted on the command line");
  });
  test("help / version / unknown command exit codes", async () => {
    const home = scratchHome();
    expect((await cli(["--version"], { HOME: home })).out.trim()).toMatch(/^0\.6\.0 \((dev|[0-9a-f]{7,12}, built \d{4}-\d{2}-\d{2})\)$/);
    expect((await cli(["--help"], { HOME: home })).code).toBe(0);
    expect((await cli([], { HOME: home })).code).toBe(2);
    const bad = await cli(["frobnicate"], { HOME: home });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown command");
    expect((await cli(["report", "x", "--status", "MAYBE"], { HOME: home, SIISWELL_URL: "https://d.example", SIISWELL_TOKEN: TOK("a") })).code).toBe(2);
  });
});

describe("configuration", () => {
  const writeCfg = (home: string, obj: unknown, mode = 0o600): string => {
    const dir = join(home, ".config", "siiswell");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "config.json");
    writeFileSync(f, JSON.stringify(obj));
    chmodSync(f, mode);
    return f;
  };

  test("precedence: flag > SIISWELL_* > ORCH_TRACKER_* > config file", () => {
    const home = scratchHome();
    writeCfg(home, { url: "https://file.example", token: TOK("f"), host: "filehost", project: "fileproj" });
    let c = loadConfig({ HOME: home });
    expect([c.url, c.token, c.host, c.project]).toEqual(["https://file.example", TOK("f"), "filehost", "fileproj"]);
    c = loadConfig({ HOME: home, ORCH_TRACKER_URL: "https://tracker.example", ORCH_TRACKER_TOKEN: TOK("t") });
    expect([c.url, c.token, c.from.token]).toEqual(["https://tracker.example", TOK("t"), "ORCH_TRACKER_TOKEN"]);
    c = loadConfig({ HOME: home, ORCH_TRACKER_URL: "https://tracker.example", SIISWELL_URL: "https://dash.example/mcp", SIISWELL_TOKEN: TOK("d"), ORCH_TRACKER_TOKEN: TOK("t"), SIISWELL_HOST: "envhost" });
    expect([c.url, c.token, c.host]).toEqual(["https://dash.example", TOK("d"), "envhost"]);
    c = loadConfig({ HOME: home, SIISWELL_URL: "https://dash.example", SIISWELL_HOST: "envhost" }, { url: "https://flag.example", host: "flaghost", project: "flagproj" });
    expect([c.url, c.host, c.project, c.from.url]).toEqual(["https://flag.example", "flaghost", "flagproj", "--url"]);
  });

  test("SIISWELL_CONFIG and XDG_CONFIG_HOME pick the file", () => {
    const home = scratchHome();
    const f = join(home, "elsewhere.json");
    writeFileSync(f, JSON.stringify({ url: "https://x.example" }), { mode: 0o600 });
    expect(loadConfig({ HOME: home, SIISWELL_CONFIG: f }).url).toBe("https://x.example");
    mkdirSync(join(home, "xdg", "siiswell"), { recursive: true });
    writeFileSync(join(home, "xdg", "siiswell", "config.json"), JSON.stringify({ url: "https://xdg.example" }), { mode: 0o600 });
    expect(loadConfig({ HOME: home, XDG_CONFIG_HOME: join(home, "xdg") }).url).toBe("https://xdg.example");
  });

  test("a config file readable by group or others is refused (0600 enforced)", () => {
    const home = scratchHome();
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      writeCfg(home, { token: TOK("f") }, mode);
      expect(() => loadConfig({ HOME: home })).toThrow(/chmod 600/);
    }
    writeCfg(home, { token: TOK("f") }, 0o600);
    expect(loadConfig({ HOME: home }).token).toBe(TOK("f"));
    writeCfg(home, { token: TOK("f") }, 0o644);
    expect(loadConfig({ HOME: home }, {}, { platform: "win32" }).token).toBe(TOK("f")); // no POSIX modes there
  });

  test("a FIFO in place of the config file is refused without blocking", () => {
    const home = scratchHome();
    const dir = join(home, ".config", "siiswell");
    mkdirSync(dir, { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(dir, "config.json")]).exitCode).toBe(0);
    const t0 = Date.now();
    expect(() => readConfigFile(join(dir, "config.json"))).toThrow("not a regular file");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("bad values are refused, never silently used", () => {
    const home = scratchHome();
    expect(() => loadConfig({ HOME: home, SIISWELL_TOKEN: "sk-not-ours" })).toThrow(ConfigError);
    expect(() => loadConfig({ HOME: home, SIISWELL_HOST: "bad host" })).toThrow("host label");
    writeCfg(home, { usage: { projectNames: "everything" } });
    expect(() => loadConfig({ HOME: home })).toThrow("projectNames");
    writeCfg(home, ["not", "an", "object"]);
    expect(() => loadConfig({ HOME: home })).toThrow("JSON object");
  });

  test("report's default project: a configured root, else the git checkout, else the folder name", () => {
    const home = scratchHome();
    mkdirSync(join(home, "code", "repo", ".git"), { recursive: true });
    mkdirSync(join(home, "code", "repo", "src", "deep"), { recursive: true });
    mkdirSync(join(home, "projects", "web", "worktrees", "web-dev"), { recursive: true });
    expect(defaultProject(join(home, "code", "repo", "src", "deep"), [], home)).toBe("repo");
    expect(defaultProject(join(home, "projects", "web", "worktrees", "web-dev"), [join(home, "projects")], home)).toBe("web");
    expect(defaultProject(join(home, "work", "myproj"), [], home)).toBe("myproj"); // no .git up to HOME: the folder name
    expect(defaultProject("/", [], home)).toBeUndefined();
  });

  test("usage.pricingOverrides: same shape as the host agent's, validated", () => {
    const home = scratchHome();
    writeCfg(home, { usage: { pricingOverrides: { "my-model": { input: 2, output: 8 }, "claude-opus": { input: 1, output: 2, cacheRead: 0.1 } } } });
    expect(loadConfig({ HOME: home }).usage.pricingOverrides).toEqual({ "my-model": { input: 2, output: 8 }, "claude-opus": { input: 1, output: 2, cacheRead: 0.1 } });
    for (const bad of [[1], { m: { input: "2", output: 1 } }, { m: { input: 1 } }, { m: { input: -1, output: 1 } }]) {
      writeCfg(home, { usage: { pricingOverrides: bad } });
      expect(() => loadConfig({ HOME: home })).toThrow("pricingOverrides");
    }
  });

  test("URL rules: https, http only for localhost, no credentials / query, /mcp suffix removed", () => {
    expect(normalizeBaseUrl("https://dash.example.com/")).toBe("https://dash.example.com");
    expect(normalizeBaseUrl("https://dash.example.com/mcp")).toBe("https://dash.example.com");
    expect(normalizeBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeBaseUrl("http://localhost:8787/mcp/")).toBe("http://localhost:8787");
    expect(() => normalizeBaseUrl("http://dash.example.com")).toThrow("https");
    expect(() => normalizeBaseUrl("http://127.0.0.1.evil.example")).toThrow("https");
    expect(() => normalizeBaseUrl("https://user:pw@dash.example.com")).toThrow("user name");
    expect(() => normalizeBaseUrl("https://dash.example.com/?x=1")).toThrow("query");
    expect(() => normalizeBaseUrl("ftp://dash.example.com")).toThrow("https");
  });

  test("`config` and describe() never print a token", async () => {
    const home = scratchHome();
    const env = { HOME: home, SIISWELL_URL: "https://d.example", SIISWELL_TOKEN: TOK("q"), SIISWELL_HOST_TOKEN: TOK("w") };
    const r = await cli(["config"], env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("set (from SIISWELL_TOKEN)");
    expect(r.out).not.toContain("qqqq");
    expect(r.out).not.toContain("wwww");
    expect(JSON.stringify(describeConfig(loadConfig(env)))).not.toContain("oct_");
  });
});

describe("--config FILE works for every command", () => {
  test("config, doctor-style reads and usage take the file given on the command line (not only hook)", async () => {
    const home = scratchHome();
    const file = join(home, "alt.json");
    writeFileSync(file, JSON.stringify({ url: "https://alt.example", token: TOK("a"), machine: "box-2" }), { mode: 0o600 });
    const r = await cli(["config", "--config", file], { HOME: home });
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.configFile).toBe(file);
    expect(d.url).toBe("https://alt.example (from config file)");
    expect(d.machine).toContain("box-2");
    expect(r.out).not.toContain("aaaa");
    // a missing file is an error for every command (doctor too), never a silent fall-back to the environment / defaults
    const nope = join(home, "nope.json");
    for (const args of [["config"], ["doctor"], ["tasks"], ["heartbeat"], ["report", "x", "--project", "p"], ["usage", "show"]]) {
      const r = await cli([...args, "--config", nope], { HOME: home, SIISWELL_URL: "https://env.example", SIISWELL_TOKEN: TOK("e") });
      expect([args[0], r.code, r.err.includes(`config file not found or not a file: ${nope}`), r.out]).toEqual([args[0], 1, true, ""]);
    }
    // a directory is not a config file: the same error
    for (const args of [["config"], ["doctor"], ["usage", "show"]]) {
      const r = await cli([...args, "--config", home], { HOME: home, SIISWELL_URL: "https://env.example", SIISWELL_TOKEN: TOK("e") });
      expect([args[0], r.code, r.err.includes(`config file not found or not a file: ${home}`), r.out]).toEqual([args[0], 1, true, ""]);
    }
    // the file wins over SIISWELL_CONFIG
    const both = await cli(["config", "--config", file], { HOME: home, SIISWELL_CONFIG: join(home, "other.json") });
    expect(JSON.parse(both.out).configFile).toBe(file);
  });
});

describe("redaction before sending", () => {
  test("tools/call title and summary are scrubbed and clipped; other messages are untouched", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_task", arguments: { project: "p", title: `deploy with ${SECRET}`, summary: "x".repeat(500), status: "IN_PROGRESS" } } };
    expect(redactToolCall(msg)).toBe(true);
    expect(msg.params.arguments.title).not.toContain(SECRET);
    expect(msg.params.arguments.title).toContain("[redacted]");
    expect(msg.params.arguments.summary.length).toBeLessThanOrEqual(300);
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    expect(redactToolCall(list)).toBe(false);
  });
});

describe("against an in-process server (route() + SQLite)", () => {
  let s: TestServer;
  let home: string;
  let env: Record<string, string>;
  beforeAll(async () => {
    s = await startServer();
    home = scratchHome();
    env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client, SIISWELL_TASK_TEXT: "full" };
  });
  afterAll(() => s.stop());

  test("report -> update -> heartbeat; the secret in the title never leaves the machine", async () => {
    const before = s.seen.length;
    const r = await cli(["report", `migrate db ${SECRET}`, "--eta-min", "45", "--project", "web", "--summary", `token ${SECRET}`], env);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const taskId = r.out.trim();
    expect(taskId).toMatch(/^m-/);
    const sent = s.seen.slice(before).map((x) => x.body).join("\n");
    expect(sent).toContain("migrate db");
    expect(sent).not.toContain(SECRET);
    const row = s.t.db.sqlite.query("SELECT title, state, project, agent FROM tasks WHERE task_id = ?").get(taskId) as { title: string; state: string; project: string; agent: string };
    expect(row.state).toBe("running");
    expect(row.project).toBe("web");
    expect(row.title).not.toContain(SECRET);

    const u = await cli(["update", taskId, "--status", "done", "--summary", "all green", "--json"], env);
    expect(u.code).toBe(0);
    expect(JSON.parse(u.out)).toEqual({ task_id: taskId, state: "done" });
    const again = await cli(["update", taskId, "--status", "IN_PROGRESS"], env);
    expect(again.code).toBe(1);
    expect(again.err).toContain("task is closed");

    const hb = await cli(["heartbeat"], env);
    expect([hb.code, hb.out.trim()]).toEqual([0, "ok"]);
  });

  test("tasks lists this client's open tasks; update --status DONE closes one by hand, also after it went stale", async () => {
    const a = JSON.parse((await cli(["report", "forgotten job", "--project", "web", "--json"], env)).out).task_id;
    const b = JSON.parse((await cli(["report", "still going", "--project", "web", "--json"], env)).out).task_id;
    const l = await cli(["tasks"], env);
    expect(l.code).toBe(0);
    expect(l.out).toContain(a);
    expect(l.out).toContain("forgotten job");
    expect(l.out).toContain("running");
    expect(l.out).toContain("siiswell update <task_id> --status DONE");
    const j = JSON.parse((await cli(["tasks", "--json"], env)).out);
    expect(j.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(expect.arrayContaining([a, b]));
    // the server closed `a` for silence: only DONE is still accepted
    s.t.db.sqlite.query("UPDATE tasks SET state = 'stale' WHERE task_id = ?").run(a);
    const ls = (await cli(["tasks"], env)).out;
    expect(ls.indexOf("Open tasks:")).toBeLessThan(ls.indexOf("Closed as stale (no report) in the last 7 days:"));
    expect(ls.slice(ls.indexOf("Closed as stale"))).toContain(a);
    expect(ls.slice(0, ls.indexOf("Closed as stale"))).not.toContain(a);
    const refused = await cli(["update", a, "--status", "IN_PROGRESS"], env);
    expect([refused.code, refused.err.includes("24 h")]).toEqual([1, true]);
    const done = await cli(["update", a, "--status", "DONE", "--json"], env);
    expect(JSON.parse(done.out)).toEqual({ task_id: a, state: "done" });
    const after = JSON.parse((await cli(["tasks", "--json"], env)).out).tasks.map((t: { task_id: string }) => t.task_id);
    expect(after).not.toContain(a);
    expect(after).toContain(b);
    // titles reach the terminal without control characters or escape sequences
    s.t.db.sqlite.query("UPDATE tasks SET title = ? WHERE task_id = ?").run("evil\x1b[31mred\x1b[0m\x1b]0;pwned\x07 \x00bell\x07\x7f\r\nok\x9b", b);
    const shown = (await cli(["tasks"], env)).out;
    expect(shown).toContain("evilred bellok");
    expect(/[\x00-\x08\x0b-\x1f\x7f\x9b]/.test(shown)).toBe(false);
    expect(shown).not.toContain("pwned");
    await cli(["update", b, "--status", "DONE"], env);
    expect((await cli(["tasks"], env)).out.trim()).toBe("no open tasks");
    expect((await cli(["tasks", "extra"], env)).code).not.toBe(0);
  });

  test("report files its task like mcp / hooks: the name policy decides; --project wins; an install from before 0.2.x keeps the folder name", async () => {
    const projectOf = async (extra: Record<string, string>, cwd: string, args: string[] = []) => {
      const r = await cli(["report", "from cwd", "--json", ...args], { ...env, ...extra }, { cwd });
      expect(r.code).toBe(0);
      return (s.t.db.sqlite.query("SELECT project FROM tasks WHERE task_id = ?").get(JSON.parse(r.out).task_id) as { project: string }).project;
    };
    const h = scratchHome();
    const st = join(h, "state");
    const inside = join(h, "code", "acme-corp", "src");
    mkdirSync(inside, { recursive: true });
    const cfg = join(h, "cfg.json");
    const withCfg = (usage: Record<string, unknown>) => {
      writeFileSync(cfg, JSON.stringify({ usage }), { mode: 0o600 });
      return { HOME: h, SIISWELL_STATE_DIR: st, SIISWELL_CONFIG: cfg };
    };
    // no roots, no keep (a new install): no folder name leaves the machine
    expect(await projectOf(withCfg({}), join(h, "work", "myproj"))).toBe("other");
    // inside roots under "hashed": the same h- label as the usage page
    expect(await projectOf(withCfg({ roots: ["~/code"], projectNames: "hashed" }), inside)).toMatch(/^h-[0-9a-f]{12}$/);
    // outside the roots with no keep: nothing ("other")
    expect(await projectOf(withCfg({ roots: ["~/code"], projectNames: "hashed" }), join(h, "work", "myproj"))).toBe("other");
    expect(await projectOf(withCfg({ roots: ["~/code"], keep: ["acme-corp"] }), inside)).toBe("acme-corp");
    expect(await projectOf(withCfg({}), inside, ["--project", "etl"])).toBe("etl");
    // a legacy bank (projectNames unset): the folder name as before
    writeFileSync(join(st, "usage.json"), JSON.stringify({ v: 1, tz: "UTC", daily: [], hourly: [] }));
    expect(await projectOf(withCfg({}), join(h, "work", "myproj"))).toBe("myproj");
  });

  test("mcp: a report_task without project outside the roots is filed under \"other\" (no regex error for the agent)", async () => {
    const h = scratchHome();
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report_task", arguments: { title: "loose work", status: "IN_PROGRESS" } } },
    ];
    const r = await cli(["mcp"], { HOME: h, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client }, { cwd: join(h, "work", "myproj"), input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
    const res = r.out.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2);
    expect(res.result.isError).toBeUndefined();
    const id = JSON.parse(res.result.content[0].text).task_id;
    expect((s.t.db.sqlite.query("SELECT project FROM tasks WHERE task_id = ?").get(id) as { project: string }).project).toBe("other");
  });

  test("a read-only state dir (no salt): mcp and report still work, without a project name, and warn once", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode
    const h = scratchHome();
    const ro = join(h, "ro"); // a read-only parent: the state dir cannot be created, so neither can the salt
    const st = join(ro, "state");
    const inside = join(h, "code", "acme-corp");
    mkdirSync(inside, { recursive: true });
    mkdirSync(ro, { recursive: true });
    const cfg = join(h, "cfg.json");
    writeFileSync(cfg, JSON.stringify({ usage: { roots: ["~/code"], projectNames: "hashed" } }), { mode: 0o600 });
    const { chmodSync } = await import("node:fs");
    chmodSync(ro, 0o500);
    try {
      const e = { HOME: h, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client, SIISWELL_STATE_DIR: st, SIISWELL_CONFIG: cfg };
      const r = await cli(["report", "ro", "--json"], e, { cwd: inside });
      expect(r.code).toBe(0);
      expect(r.err).toContain("salt could not be created");
      expect((s.t.db.sqlite.query("SELECT project FROM tasks WHERE task_id = ?").get(JSON.parse(r.out).task_id) as { project: string }).project).toBe("other");
      const lines = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }];
      const m = await cli(["mcp"], e, { cwd: inside, input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
      expect(m.code).toBe(0);
      expect(m.out).toContain('"id":1');
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  test("a host token on /mcp is a clear error; a wrong token is a 401 message without the token", async () => {
    const r = await cli(["report", "x", "--project", "p"], { ...env, SIISWELL_TOKEN: s.host });
    expect(r.code).toBe(1);
    expect(r.err).toContain("client");
    const bad = TOK("z");
    const r2 = await cli(["report", "x", "--project", "p"], { ...env, SIISWELL_TOKEN: bad });
    expect(r2.err).toContain("401");
    expect(r2.err).not.toContain(bad);
  });

  test("heartbeat with only a host token uses /api/ingest/heartbeat with the host label", async () => {
    const r = await cli(["heartbeat"], { HOME: home, SIISWELL_URL: s.url, SIISWELL_HOST_TOKEN: s.host, SIISWELL_HOST: s.hostName });
    expect([r.code, r.out.trim()]).toEqual([0, "ok"]);
    expect(s.t.db.sqlite.query("SELECT host FROM hosts WHERE host = ?").get(s.hostName)).toBeTruthy();
    const wrong = await cli(["heartbeat"], { HOME: home, SIISWELL_URL: s.url, SIISWELL_HOST_TOKEN: s.host, SIISWELL_HOST: "otherhost" });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("403");
  });

  test("doctor reports reachability and the kind of each token", async () => {
    const ok = await cli(["doctor"], { ...env, SIISWELL_HOST_TOKEN: s.host, SIISWELL_HOST: s.hostName });
    expect(ok.out).toContain("[ok] reachable");
    expect(ok.out).toContain("kind 'client'");
    expect(ok.out).toContain("kind 'host'");
    expect(ok.code).toBe(0);
    const swapped = await cli(["doctor"], { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.host });
    expect(swapped.code).toBe(1);
    expect(swapped.out).toContain("this is a 'host' token");
    expect(swapped.out).not.toContain(s.host);
  });

  test("stdio MCP: initialize, tools/list, tools/call (redacted), notifications produce no output", async () => {
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_task", arguments: { project: "p", title: `stdio ${SECRET}`, status: "IN_PROGRESS", eta_min: 20 } } },
    ];
    const before = s.seen.length;
    const r = await cli(["mcp"], env, { input: lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n" });
    expect(r.code).toBe(0);
    const outs = r.out.trim().split("\n").map((l) => JSON.parse(l));
    const byId = new Map(outs.map((o) => [o.id, o]));
    expect(byId.get(1).result.protocolVersion).toBe("2025-06-18");
    expect(byId.get(2).result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["heartbeat", "list_tasks", "operator_status", "report_task", "update_task"]);
    expect(JSON.parse(byId.get(3).result.content[0].text).task_id).toMatch(/^m-/);
    expect(byId.get(null).error.code).toBe(-32700);
    expect(outs.length).toBe(4); // the notification got no reply
    expect(s.seen.slice(before).map((x) => x.body).join("\n")).not.toContain(SECRET);
  });
});

describe("redirects are refused, the token never follows one", () => {
  let target: ReturnType<typeof Bun.serve>;
  let redirector: ReturnType<typeof Bun.serve>;
  const hits: Array<{ auth: boolean }> = [];
  beforeAll(() => {
    target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => { hits.push({ auth: req.headers.has("authorization") }); return Response.json({ ok: true }); } });
    redirector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${target.port}/mcp` } }) });
  });
  afterAll(() => { target.stop(true); redirector.stop(true); });

  test("report, heartbeat, doctor and the stdio relay", async () => {
    const env = { HOME: scratchHome(), SIISWELL_URL: `http://127.0.0.1:${redirector.port}`, SIISWELL_TOKEN: TOK("r") };
    const r = await cli(["report", "x", "--project", "p"], env);
    expect(r.code).toBe(1);
    expect(r.err).toContain("redirect");
    expect((await cli(["heartbeat"], env)).err).toContain("redirect");
    expect((await cli(["doctor"], env)).out).toContain("redirect");
    const m = await cli(["mcp"], env, { input: `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n` });
    expect(JSON.parse(m.out.trim()).error.message).toBe("Dashboard unreachable");
    expect(m.err).toContain("redirect");
    expect(hits).toEqual([]);
  });
});

describe("the single-file build runs under Node", () => {
  test("node dist/siiswell.mjs speaks stdio MCP to the test server", async () => {
    const s = await startServer();
    try {
      const out = join(scratchHome(), "siiswell.mjs");
      const { buildCli } = await import("../cli/build");
      await buildCli(out);
      const src = await Bun.file(out).text();
      expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
      expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).every((m) => m!.startsWith("node:"))).toBe(true); // zero runtime dependencies
      const node = Bun.which("node");
      if (!node) return;
      const proc = Bun.spawn([node, out, "mcp"], { env: { PATH: process.env.PATH ?? "", HOME: scratchHome(), SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "n", version: "1" } } })}\n`);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "heartbeat", arguments: {} } })}\n`);
      proc.stdin.end();
      const text = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const replies = text.trim().split("\n").map((l) => JSON.parse(l));
      expect(replies[0].result.serverInfo).toBeTruthy();
      expect(replies[1].result.content[0].text).toBe("ok");
    } finally {
      s.stop();
    }
  }, 30_000);
});

test("termSafe strips CSI / OSC / other ESC sequences and every control character", () => {
  expect(termSafe("a\x1b[1;31mb\x1b[0mc")).toBe("abc");
  expect(termSafe("x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\y")).toBe("xlinky");
  expect(termSafe("t\x1bMab\x00\x01\x1f\x7f\u0085\x9bz\ttab")).toBe("tabztab");
  expect(termSafe(undefined)).toBe("");
  expect(termSafe("plain title — ok")).toBe("plain title — ok");
});
