/**
 * MCP tasks on the Projects list (migration 0006 `tasks.machine`): report_task's optional `machine`, the `siiswell mcp` defaults
 * (project from the MCP process's folder, machine from the config), and /api/state `mcpProjects` grouping several apps of one
 * machine under "machine / project". Old clients (no machine) and databases without 0006 keep working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adjustToolsList, fillToolCall } from "../cli/src/mcp-stdio";
import { loadConfig, mcpDefaultProject } from "../cli/src/config";
import { INSERT_CAPPED_TASK, INSERT_CAPPED_TASK_MACHINE, isNoMachineColumn } from "../src/mcp";
import { route } from "../src/index";
import { groupMcpProjects, type StateResponse } from "../src/state";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";
import { cli, scratchHome, startServer, type TestServer } from "./cli-helpers";

const NOW = 1_800_000_000_000;

async function boot(opts: { noMachineColumn?: boolean } = {}) {
  const t = makeEnv();
  if (opts.noMachineColumn) t.db.sqlite.run("ALTER TABLE tasks DROP COLUMN machine");
  const ctx = makeCtx();
  const cc = await addSource(t.db, "cc-laptop", "client");
  const codex = await addSource(t.db, "codex-laptop", "client");
  const desk = await addSource(t.db, "desktop-laptop", "client");
  const call = (path: string, init: Parameters<typeof request>[1] = {}) => route(request(path, init), t.env, ctx, { now: NOW });
  const report = async (token: string, args: Record<string, unknown>) => {
    const res = await call("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_task", arguments: { title: "t", status: "IN_PROGRESS", ...args } } }, headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" } });
    const j = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return j.result;
  };
  const state = async () => (await (await call("/api/state")).json()) as StateResponse;
  return { ...t, cc, codex, desk, report, state };
}

describe("report_task machine (migration 0006)", () => {
  test("stored when sent, validated like a label; absent for old clients", async () => {
    const b = await boot();
    expect((await b.report(b.cc, { project: "blog", machine: "laptop-1" })).isError).toBeUndefined();
    expect((await b.report(b.cc, { project: "blog" })).isError).toBeUndefined();
    expect((await b.report(b.cc, { project: "blog", machine: "a b" })).isError).toBe(true);
    expect((await b.report(b.cc, { project: "blog", machine: "/home/u" })).isError).toBe(true);
    expect(b.db.rows("SELECT machine FROM tasks ORDER BY created, machine")).toEqual([{ machine: null }, { machine: "laptop-1" }]);
  });

  test("a database without the column still takes the task (without the machine)", async () => {
    const b = await boot({ noMachineColumn: true });
    const r = await b.report(b.cc, { project: "blog", machine: "laptop-1" });
    expect(r.isError).toBeUndefined();
    expect(b.db.rows("SELECT project FROM tasks")).toEqual([{ project: "blog" }]);
    const s = await b.state();
    expect(s.tasks[0]!.machine).toBeNull();
    expect(s.mcpProjects.map((p) => `${p.group}/${p.project}`)).toEqual(["cc-laptop/blog"]);
  });

  test("the machine statement is the capped insert plus one column", () => {
    expect(INSERT_CAPPED_TASK_MACHINE).toContain("updated, machine)");
    expect(INSERT_CAPPED_TASK_MACHINE).toContain("?12, ?15");
    expect(INSERT_CAPPED_TASK_MACHINE.replace("updated, machine)", "updated)").replace("?12, ?15", "?12")).toBe(INSERT_CAPPED_TASK);
    expect(isNoMachineColumn(new Error("table tasks has no column named machine"))).toBe(true);
    expect(isNoMachineColumn(new Error("no such column: machine"))).toBe(true);
    expect(isNoMachineColumn(new Error("D1 went away"))).toBe(false);
  });
});

describe("/api/state mcpProjects", () => {
  test("apps of one machine are grouped by machine + project; clients without a machine by their own name", async () => {
    const b = await boot();
    await b.report(b.cc, { project: "web", machine: "laptop-1", agent: "claude" });
    await b.report(b.codex, { project: "web", machine: "laptop-1", agent: "codex", status: "BLOCKED" });
    await b.report(b.codex, { project: "api", machine: "laptop-1" });
    await b.report(b.desk, { project: "notes" });
    const s = await b.state();
    const g = s.mcpProjects.map((p) => ({ k: `${p.group}/${p.project}`, by: p.byMachine, clients: p.clients, agents: p.agents, open: p.open, blocked: p.blocked, n: p.taskKeys.length }));
    expect(g[0]).toEqual({ k: "laptop-1/web", by: true, clients: ["cc-laptop", "codex-laptop"], agents: ["claude@cc-laptop", "codex@codex-laptop"], open: 2, blocked: 1, n: 2 });
    expect(g.map((x) => x.k).sort()).toEqual(["desktop-laptop/notes", "laptop-1/api", "laptop-1/web"]);
    expect(g.find((x) => x.k === "desktop-laptop/notes")!.by).toBe(false);
    expect(s.tasks.filter((t) => t.origin === "mcp").every((t) => t.machine === null || t.machine === "laptop-1")).toBe(true);
  });

  test("groupMcpProjects ignores host-integration tasks and tasks without a project", () => {
    const base = { origin: "mcp", host: "c1", project: "p", agent: "a@c1", taskId: "m-1", title: "t", state: "running", etaAt: null, lastLine: null, startedAt: 1, updated: 2, machine: null };
    const tasks = [
      { ...base, key: "mcp|c1|m-1" },
      { ...base, key: "mcp|c1|m-2", project: null },
      { ...base, key: "h|p|1", origin: "host", host: "box" },
      { ...base, key: "mcp|c1|m-3", state: "done", updated: 9 },
    ] as StateResponse["tasks"];
    const g = groupMcpProjects(tasks);
    expect(g.length).toBe(1);
    expect(g[0]!.taskKeys).toEqual(["mcp|c1|m-1", "mcp|c1|m-3"]); // open first
    expect([g[0]!.open, g[0]!.lastUpdate]).toEqual([1, 9]);
  });
});

describe("siiswell mcp: project and machine defaults", () => {
  test("mcpDefaultProject: under configured roots their first-level folder (the collector's rule); elsewhere (also with no roots, the default) the git checkout / folder ONLY when opted in or kept by name; never home or /", () => {
    const home = scratchHome();
    const repo = join(home, "code", "My Repo!");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(mcpDefaultProject(join(home, "projects", "web", "src"), [join(home, "projects")], home)).toBe("web");
    // configured roots: nothing outside them unless opted in
    expect(mcpDefaultProject(join(repo, "src", "deep"), [join(home, "projects")], home)).toBeUndefined();
    expect(mcpDefaultProject(join(home, "loose dir"), [join(home, "projects")], home)).toBeUndefined();
    // no roots and no keep (a new install's default): nothing is sent, as before
    expect(mcpDefaultProject(join(repo, "src", "deep"), [], home)).toBeUndefined();
    expect(mcpDefaultProject(join(home, "loose dir"), [], home)).toBeUndefined();
    // a name in keep is sent; others are not
    expect(mcpDefaultProject(join(repo, "src", "deep"), [], home, false, ["My-Repo"])).toBe("My-Repo");
    expect(mcpDefaultProject(join(home, "loose dir"), [], home, false, ["My-Repo"])).toBeUndefined();
    expect(mcpDefaultProject(home, [], home, false, ["cc"])).toBeUndefined();
    expect(mcpDefaultProject(join(repo, "src", "deep"), [], home, true)).toBe("My-Repo");
    expect(mcpDefaultProject(join(home, "loose dir"), [], home, true)).toBe("loose-dir");
    expect(mcpDefaultProject(home, [], home, true)).toBeUndefined();
    expect(mcpDefaultProject("/", [], home, true)).toBeUndefined();
    expect(mcpDefaultProject(join(home, "😀"), [], home, true)).toBeUndefined();
    expect(loadConfig({ HOME: home }).usage.inferProjectOutsideRoots).toBe(false);
  });

  test("fillToolCall fills a missing project and adds the machine; never overrides the agent's values; other tools untouched", () => {
    const call = (args?: Record<string, unknown>, name = "report_task") => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, ...(args ? { arguments: args } : {}) } });
    const a = call({ title: "x", status: "DONE" });
    expect(fillToolCall(a, { project: "blog", machine: "mac" })).toBe(true);
    expect(a.params.arguments).toEqual({ title: "x", status: "DONE", project: "blog", machine: "mac" });
    const b = call({ title: "x", status: "DONE", project: "mine", machine: "theirs" });
    expect(fillToolCall(b, { project: "blog", machine: "mac" })).toBe(false);
    expect(b.params.arguments).toMatchObject({ project: "mine", machine: "theirs" });
    const c = call({ task_id: "m-1", status: "DONE" }, "update_task");
    expect(fillToolCall(c, { project: "blog", machine: "mac" })).toBe(false);
    const d = call(undefined);
    expect(fillToolCall(d, { project: "blog" })).toBe(true);
    expect((d.params as Record<string, unknown>).arguments).toEqual({ project: "blog" });
    expect(fillToolCall(call({ title: "x" }), {})).toBe(false);
  });

  test("adjustToolsList: project optional when the bridge fills it; machine is never offered", () => {
    const reply = () => ({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "report_task", inputSchema: { properties: { project: { description: "P." }, machine: {} }, required: ["project", "title", "status"] } }, { name: "update_task", inputSchema: { required: ["task_id"] } }] } });
    const r = reply();
    adjustToolsList(r, { project: "blog" });
    expect(r.result.tools[0]!.inputSchema.required).toEqual(["title", "status"]);
    expect(r.result.tools[0]!.inputSchema.properties).not.toHaveProperty("machine");
    expect(String(r.result.tools[0]!.inputSchema.properties!.project.description)).toContain("blog");
    const r2 = reply();
    adjustToolsList(r2, {});
    expect(r2.result.tools[0]!.inputSchema.required).toContain("project");
  });

  test("config: machine from SIISWELL_MACHINE / config, else an explicit host label, never the OS host name", () => {
    const home = scratchHome();
    expect(loadConfig({ HOME: home }).machine).toBeUndefined();
    expect(loadConfig({ HOME: home, SIISWELL_HOST: "laptop-1" }).machine).toBe("laptop-1");
    expect(loadConfig({ HOME: home, SIISWELL_HOST: "laptop-1", SIISWELL_MACHINE: "studio" }).machine).toBe("studio");
    expect(() => loadConfig({ HOME: home, SIISWELL_MACHINE: "a b" })).toThrow();
  });
});

describe("end to end: siiswell mcp over stdio against the server", () => {
  test("siiswell report sends the configured machine too", async () => {
    const t = await startServer();
    try {
      const r = await cli(["report", "nightly import", "--project", "etl", "--json"], { HOME: scratchHome(), SIISWELL_URL: t.url, SIISWELL_TOKEN: t.client, SIISWELL_MACHINE: "laptop-1" });
      expect(r.code).toBe(0);
      expect(t.t.db.sqlite.query("SELECT project, machine FROM tasks").get()).toEqual({ project: "etl", machine: "laptop-1" });
    } finally {
      t.stop();
    }
  });

  let s: TestServer;
  beforeAll(async () => { s = await startServer(); });
  afterAll(() => s.stop());

  test("an agent that omits project gets the folder name; the machine groups it; no absolute path is sent", async () => {
    const home = scratchHome();
    const cwd = join(home, "projects", "myproj", "src");
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_task", arguments: { title: "write post", status: "IN_PROGRESS" } } },
    ];
    const before = s.seen.length;
    mkdirSync(join(home, "projects", "myproj", ".git"), { recursive: true }); // the git checkout names the project
    const cfg = join(home, "cfg.json"); // no roots; the name is kept (shown) on purpose
    writeFileSync(cfg, JSON.stringify({ usage: { keep: ["myproj"] } }), { mode: 0o600 });
    const r = await cli(["mcp"], { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client, SIISWELL_MACHINE: "laptop-1", SIISWELL_CONFIG: cfg }, { cwd, input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
    expect(r.code).toBe(0);
    const out = r.out.trim().split("\n").map((l) => JSON.parse(l));
    const list = out.find((m) => m.id === 2);
    expect(list.result.tools.find((t: { name: string }) => t.name === "report_task").inputSchema.required).not.toContain("project");
    const res = out.find((m) => m.id === 3);
    expect(res.result.isError).toBeUndefined();
    const row = s.t.db.sqlite.query("SELECT project, machine FROM tasks ORDER BY created DESC LIMIT 1").get() as { project: string; machine: string };
    expect(row).toEqual({ project: "myproj", machine: "laptop-1" });
    expect(s.seen.slice(before).map((x) => x.body).join("\n")).not.toContain(home);
  });
  test("in an agent workspace the write tools are answered locally and never sent; the read tools and an operator cwd go through", async () => {
    const home = scratchHome();
    const proj = join(home, "projects", "agentp");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, ".siiswell-agents"), "");
    const pane = join(proj, "worktrees", "agentp-claude");
    mkdirSync(pane, { recursive: true });
    const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      call(2, "report_task", { project: "agentp", title: "agent pane task", status: "IN_PROGRESS" }),
      call(3, "update_task", { task_id: "m-x", status: "DONE" }),
      call(4, "heartbeat", {}),
      call(5, "list_tasks", {}),
      [call(6, "report_task", { project: "agentp", title: "batched", status: "IN_PROGRESS" })],
    ];
    const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
    const input = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const before = s.seen.length;
    const r = await cli(["mcp"], env, { cwd: pane, input });
    expect(r.code).toBe(0);
    const out = r.out.trim().split("\n").map((l) => JSON.parse(l));
    const flat = out.flatMap((m) => (Array.isArray(m) ? m : [m]));
    for (const id of [2, 3, 4, 6]) expect(flat.find((m) => m.id === id).result.content[0].text).toBe("skipped: agent workspace (the host integration reports this)");
    expect(flat.find((m) => m.id === 5).result).toBeDefined(); // list_tasks reached the dashboard
    const sent = s.seen.slice(before).map((x) => x.body).join("\n");
    expect(sent).toContain("list_tasks");
    expect(sent).not.toMatch(/report_task|update_task|"heartbeat"/);
    expect(s.t.db.sqlite.query("SELECT COUNT(*) AS n FROM tasks WHERE title IN ('agent pane task', 'batched')").get()).toEqual({ n: 0 });
    // the operator's own session in the same project (not a worktree) reports as usual
    const r2 = await cli(["mcp"], env, { cwd: proj, input: JSON.stringify(lines[0]) + "\n" + JSON.stringify(call(7, "report_task", { project: "agentp", title: "operator task", status: "IN_PROGRESS" })) + "\n" });
    expect(r2.code).toBe(0);
    expect(s.t.db.sqlite.query("SELECT COUNT(*) AS n FROM tasks WHERE project = 'agentp' AND title = 'operator task'").get()).toEqual({ n: 1 });
    // SIISWELL_AGENT=1 (set by whatever starts the agent) is an agent workspace in any directory
    const r3 = await cli(["mcp"], { ...env, SIISWELL_AGENT: "1" }, { cwd: proj, input: JSON.stringify(lines[0]) + "\n" + JSON.stringify(call(8, "report_task", { project: "agentp", title: "env agent task", status: "IN_PROGRESS" })) + "\n" });
    expect(r3.code).toBe(0);
    expect(r3.out).toContain("skipped: agent workspace");
    expect(s.t.db.sqlite.query("SELECT COUNT(*) AS n FROM tasks WHERE title = 'env agent task'").get()).toEqual({ n: 0 });
  });
});
