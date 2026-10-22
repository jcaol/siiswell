import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_DEFAULT_ROOTS, loadConfig, mcpDefaultProject, usesLegacyRoots } from "../cli/src/config";
import { DEFAULT_USAGE_TZ, attribute } from "../cli/src/usage/collect";
import { taskProject } from "../cli/src/taskProject";
import { projectHasher } from "../cli/src/usage/push";
import { scratchHome } from "./cli-helpers";

describe("defaults: no usage roots, the system time zone", () => {
  test("without roots every directory counts: its git checkout, else its folder; the home directory is (other)", () => {
    const home = scratchHome();
    const repo = join(home, "code", "shop");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src", "api"), { recursive: true });
    expect(attribute(join(repo, "src", "api"), "claude", [], { home })).toEqual({ project: "shop", agent: "claude" });
    expect(attribute("/nowhere/notes", "codex", [], { home })).toEqual({ project: "notes", agent: "codex" });
    expect(attribute(home, "claude", [], { home })).toEqual({ project: "(other)", agent: "claude" });
    expect(attribute(undefined, "claude", [])).toEqual({ project: "(other)", agent: "claude" });
    expect(mcpDefaultProject(join(repo, "src"), [], home)).toBeUndefined(); // tasks: no folder name unless kept
    expect(mcpDefaultProject(join(repo, "src"), [], home, false, ["shop"])).toBe("shop");
    // configured roots behave as before
    expect(attribute("/srv/p/web/worktrees/web-dev", "claude", ["/srv/p"])).toEqual({ project: "web", agent: "dev" });
  });

  test("a new install has no roots; one whose usage bank predates the change keeps the earlier default", () => {
    const home = scratchHome();
    const st = join(home, "state");
    mkdirSync(st, { recursive: true });
    const roots = () => loadConfig({ HOME: home, SIISWELL_STATE_DIR: st }, {}).usage.roots;
    expect(usesLegacyRoots(st)).toBe(false);
    expect(roots()).toEqual([]);
    writeFileSync(join(st, "usage.json"), JSON.stringify({ v: 1, tz: "Europe/Paris", daily: [], hourly: [] }));
    expect(usesLegacyRoots(st)).toBe(true);
    expect(roots()).toEqual(LEGACY_DEFAULT_ROOTS.map((r) => r.replace("~", home)));
    writeFileSync(join(st, "usage.json"), JSON.stringify({ rootsDefault: "none", v: 1, tz: "Europe/Paris", daily: [], hourly: [] }));
    expect(roots()).toEqual([]);
  });

  test("project names: a new install with nothing configured uploads salted hashes; roots / keep / a legacy bank keep \"other\"; an explicit choice wins", () => {
    const home = scratchHome();
    const st = join(home, "state");
    mkdirSync(st, { recursive: true });
    const names = (file: Record<string, unknown> = {}) => {
      const cfg = join(home, "cfg.json");
      writeFileSync(cfg, JSON.stringify(file), { mode: 0o600 });
      return loadConfig({ HOME: home, SIISWELL_STATE_DIR: st, SIISWELL_CONFIG: cfg }, {}).usage.projectNames;
    };
    expect(names()).toBe("hashed");
    expect(names({ usage: { keep: ["web"] } })).toBe("other");
    expect(names({ usage: { roots: ["~/code"] } })).toBe("other");
    expect(names({ usage: { projectNames: "all" } })).toBe("all");
    writeFileSync(join(st, "usage.json"), JSON.stringify({ v: 1, tz: "Europe/Paris", daily: [], hourly: [] })); // a legacy bank
    expect(names()).toBe("other");
    writeFileSync(join(st, "usage.json"), JSON.stringify({ rootsDefault: "none", v: 1, tz: "UTC", daily: [], hourly: [] }));
    expect(names()).toBe("hashed");
  });

  test("a task's project inside configured roots follows the usage policy: kept / all by name, hashed as its hash, other as nothing; a legacy bank as before", () => {
    const home = scratchHome();
    const st = join(home, "state");
    mkdirSync(st, { recursive: true });
    const cwd = join(home, "projects", "acme-corp", "src");
    mkdirSync(cwd, { recursive: true });
    const project = (usage: Record<string, unknown>) => {
      const file = join(home, "cfg.json");
      writeFileSync(file, JSON.stringify({ usage: { roots: ["~/projects"], ...usage } }), { mode: 0o600 });
      return taskProject(cwd, loadConfig({ HOME: home, SIISWELL_STATE_DIR: st, SIISWELL_CONFIG: file }, {}), home);
    };
    expect(project({})).toBeUndefined(); // roots configured: "other" -> no name next to the task
    expect(project({ projectNames: "hashed" })).toBe(projectHasher(st)("acme-corp")); // the same label as the usage page
    expect(project({ projectNames: "hashed", keep: ["acme-corp"] })).toBe("acme-corp");
    expect(project({ projectNames: "all" })).toBe("acme-corp");
    writeFileSync(join(st, "usage.json"), JSON.stringify({ v: 1, tz: "UTC", daily: [], hourly: [] })); // a legacy bank
    expect(project({})).toBe("acme-corp");
  });

  test("the usage time zone defaults to this system's zone", () => {
    expect(DEFAULT_USAGE_TZ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});

describe("the project-name salt", () => {
  test("created once, atomically: concurrent first uses all get the same salt; an invalid salt file is replaced", async () => {
    const { projectHasher } = await import("../cli/src/usage/push");
    const { readFileSync, writeFileSync, readdirSync } = await import("node:fs");
    const st = join(scratchHome(), "state");
    // child processes racing for the first salt
    const code = `const { projectHasher } = await import(${JSON.stringify(join(import.meta.dir, "..", "cli", "src", "usage", "push.ts"))}); console.log(projectHasher(${JSON.stringify(st)})("acme"));`;
    const runs = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", code], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, stdout: "pipe" }));
    const outs = await Promise.all(runs.map(async (p) => (await new Response(p.stdout).text()).trim()));
    expect(new Set(outs).size).toBe(1);
    expect(outs[0]).toMatch(/^h-[0-9a-f]{12}$/);
    expect(projectHasher(st)("acme")).toBe(outs[0]!);
    expect(readdirSync(st).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    writeFileSync(join(st, "usage-salt"), "garbage");
    const h = projectHasher(st)("acme");
    expect(h).toMatch(/^h-[0-9a-f]{12}$/);
    expect(readFileSync(join(st, "usage-salt"), "utf8")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("doctor: installs from before 0.2.x", () => {
  test("a legacy bank with projectNames unset gets a one-line hint; setting projectNames hides the names and the hint", async () => {
    const { startServer, cli } = await import("./cli-helpers");
    const s = await startServer();
    try {
      const home = scratchHome();
      const st = join(home, "state");
      mkdirSync(st, { recursive: true });
      const cwd = join(home, "projects", "acme-corp");
      mkdirSync(cwd, { recursive: true });
      const cfg = join(home, "cfg.json");
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client, SIISWELL_STATE_DIR: st, SIISWELL_CONFIG: cfg };
      const hint = "task project names: sent as folder names";
      writeFileSync(cfg, JSON.stringify({}), { mode: 0o600 });
      expect((await cli(["doctor"], env)).out).not.toContain(hint); // a new install: names are hidden anyway
      writeFileSync(join(st, "usage.json"), JSON.stringify({ v: 1, tz: "UTC", daily: [], hourly: [] })); // a legacy bank
      const out = (await cli(["doctor"], env)).out;
      expect(out.split("\n").filter((l) => l.includes(hint))).toHaveLength(1);
      expect(taskProject(cwd, loadConfig(env, {}), home)).toBe("acme-corp");
      writeFileSync(cfg, JSON.stringify({ usage: { projectNames: "other" } }), { mode: 0o600 });
      expect((await cli(["doctor"], env)).out).not.toContain(hint);
      expect(taskProject(cwd, loadConfig(env, {}), home)).toBeUndefined();
    } finally {
      s.stop();
    }
  });
});
