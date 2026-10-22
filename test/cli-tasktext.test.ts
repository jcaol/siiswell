/** `taskText` (full | minimal | none): what task text leaves the client process. Nothing the user typed may leave in minimal / none. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ConfigError, loadConfig } from "../cli/src/config";
import { runMcpStdio } from "../cli/src/mcp-stdio";
import { applyTaskText, MINIMAL_TITLE } from "../cli/src/tasktext";
import { HOOK_MARK, HOOK_TITLES } from "../src/shared/hook";
import { cli, scratchHome, startServer, type TestServer } from "./cli-helpers";

const TOK = `oct_${"a".repeat(43)}`;
const TYPED_TITLE = "refactor the billing module for Acme";
const TYPED_SUMMARY = "asked to look at invoice 4411 and the customer thread";

describe("applyTaskText", () => {
  const args = { project: "p", title: TYPED_TITLE, status: "IN_PROGRESS", summary: TYPED_SUMMARY };
  test("full: unchanged", () => expect(applyTaskText("report_task", args, "full")).toEqual(args));
  test("minimal: generic title, no summary", () => {
    const r = applyTaskText("report_task", args, "minimal");
    expect(r).toEqual({ project: "p", title: MINIMAL_TITLE, status: "IN_PROGRESS" });
    expect(JSON.stringify(r)).not.toContain("billing");
    expect(JSON.stringify(r)).not.toContain("4411");
  });
  test("minimal: the hook's fixed titles and mark pass; an update has no title added", () => {
    expect(applyTaskText("report_task", { title: HOOK_TITLES[0], summary: HOOK_MARK }, "minimal")).toEqual({ title: HOOK_TITLES[0], summary: HOOK_MARK });
    expect(applyTaskText("update_task", { task_id: "m-1", status: "DONE", summary: TYPED_SUMMARY }, "minimal")).toEqual({ task_id: "m-1", status: "DONE" });
  });
  test("none: no title, no summary", () => {
    expect(applyTaskText("report_task", args, "none")).toEqual({ project: "p", status: "IN_PROGRESS" });
    expect(applyTaskText("report_task", { title: HOOK_TITLES[0], summary: HOOK_MARK }, "none")).toEqual({});
  });
  test("other tools are untouched", () => expect(applyTaskText("heartbeat", { project: "p", title: "x" }, "none")).toEqual({ project: "p", title: "x" }));
});

describe("config", () => {
  const env = (extra: Record<string, string | undefined> = {}) => ({ HOME: scratchHome(), ...extra });
  test("default brief; file and env set it; invalid values are refused", () => {
    expect(loadConfig(env()).taskText).toBe("brief");
    const e = env();
    const f = join(e.HOME, "c.json");
    writeFileSync(f, JSON.stringify({ taskText: "none" }), { mode: 0o600 });
    expect(loadConfig({ ...e, SIISWELL_CONFIG: f }).taskText).toBe("none");
    expect(loadConfig({ ...e, SIISWELL_CONFIG: f, SIISWELL_TASK_TEXT: "full" }).taskText).toBe("full");
    expect(() => loadConfig({ ...e, SIISWELL_TASK_TEXT: "lots" })).toThrow(ConfigError);
    writeFileSync(f, JSON.stringify({ taskText: 3 }), { mode: 0o600 });
    expect(() => loadConfig({ ...e, SIISWELL_CONFIG: f })).toThrow(ConfigError);
  });
});

describe("what leaves the process", () => {
  let srv: TestServer;
  beforeAll(async () => (srv = await startServer()));
  afterAll(() => srv.stop());
  const envFor = (mode?: string) => ({ HOME: scratchHome(), SIISWELL_URL: srv.url, SIISWELL_TOKEN: srv.client, ...(mode ? { SIISWELL_TASK_TEXT: mode } : {}) });
  const bodies = () => srv.seen.map((s) => s.body).join("\n");

  test("CLI report / update: minimal and none send none of the typed text", async () => {
    for (const mode of ["minimal", "none"]) {
      srv.seen.length = 0;
      const r = await cli(["report", TYPED_TITLE, "--project", "web", "--summary", TYPED_SUMMARY, "--json"], envFor(mode));
      expect(r.code).toBe(0);
      const id = JSON.parse(r.out).task_id;
      expect((await cli(["update", id, "--status", "DONE", "--summary", TYPED_SUMMARY], envFor(mode))).code).toBe(0);
      expect(bodies()).not.toContain("billing");
      expect(bodies()).not.toContain("4411");
    }
  });
  test("the default (brief) sends the title but never the summary", async () => {
    srv.seen.length = 0;
    const r = await cli(["report", TYPED_TITLE, "--project", "web", "--summary", TYPED_SUMMARY, "--kind", "coding", "--json"], envFor());
    expect(r.code).toBe(0);
    expect(bodies()).toContain("billing");
    expect(bodies()).not.toContain("4411");
    expect(JSON.parse(srv.seen[0]!.body).params.arguments.kind).toBe("coding");
  });
  test("CLI report with full sends the (redacted) text", async () => {
    srv.seen.length = 0;
    await cli(["report", TYPED_TITLE, "--project", "web", "--summary", TYPED_SUMMARY], envFor("full"));
    expect(bodies()).toContain("billing");
    expect(bodies()).toContain("4411");
  });

  async function relay(mode: "full" | "minimal" | "none" | undefined, msgs: unknown[]) {
    srv.seen.length = 0;
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runMcpStdio({ base: srv.url, token: srv.client, input, output, log: () => {}, defaults: { project: "web", ...(mode ? { taskText: mode } : {}) } });
    for (const m of msgs) input.write(`${JSON.stringify(m)}\n`);
    input.end();
    await done;
  }
  const report = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_task", arguments: { project: "web", title: TYPED_TITLE, status: "IN_PROGRESS", summary: TYPED_SUMMARY } } };

  test("stdio relay: minimal and none never send the typed text, singly or in a batch", async () => {
    for (const mode of ["minimal", "none"] as const) {
      await relay(mode, [report, [report, { ...report, id: 2 }]]);
      expect(srv.seen.length).toBe(2);
      expect(bodies()).not.toContain("billing");
      expect(bodies()).not.toContain("4411");
    }
  });
  test("stdio relay: none sends no title field; the server stores a neutral placeholder", async () => {
    await relay("none", [report]);
    const sent = JSON.parse(srv.seen[0]!.body);
    expect(sent.params.arguments.title).toBeUndefined();
    expect(sent.params.arguments.summary).toBeUndefined();
    const row = await srv.t.db.prepare("SELECT title, last_line FROM tasks ORDER BY rowid DESC").first<{ title: string; last_line: string | null }>();
    expect(row?.title).toBe("Task");
    expect(row?.last_line).toBeNull();
  });
  test("stdio relay: full sends the text", async () => {
    await relay("full", [report]);
    expect(bodies()).toContain("billing");
  });
});

describe("allowlist, case and batches (M2, M3, L3, L4)", () => {
  test("minimal and none drop unknown keys; full leaves them", () => {
    const a = { project: "p", status: "DONE", prompt: "typed prompt", cwd: "/x", client_ref: "0000111122223333" };
    for (const m of ["minimal", "none"] as const) expect(applyTaskText("report_task", a, m)).toEqual({ project: "p", status: "DONE", client_ref: "0000111122223333" });
    expect(applyTaskText("update_task", { task_id: "m-1", status: "DONE", prompt: "x" }, "minimal")).toEqual({ task_id: "m-1", status: "DONE" });
    expect(applyTaskText("report_task", a, "full")).toEqual(a);
  });
  test("update_task never carries a title in minimal", () => {
    expect(applyTaskText("update_task", { task_id: "m-1", status: "DONE", title: TYPED_TITLE }, "minimal")).toEqual({ task_id: "m-1", status: "DONE" });
  });
  test("case variants of the tool name are limited too", () => {
    expect(applyTaskText("REPORT_TASK", { project: "p", status: "DONE", title: TYPED_TITLE }, "minimal").title).toBe(MINIMAL_TITLE);
  });
  test("a batched tools/call array: every message is limited, a case variant included", () => {
    const mk = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project: "p", status: "DONE", title: TYPED_TITLE, summary: TYPED_SUMMARY } } });
    const batch = [mk("report_task"), mk("Report_Task"), { jsonrpc: "2.0", id: 2, method: "tools/list" }];
    const { limitToolCallText } = require("../cli/src/mcp-stdio") as typeof import("../cli/src/mcp-stdio");
    for (const m of batch) limitToolCallText(m, "minimal");
    expect(JSON.stringify(batch)).not.toContain("billing");
    expect(JSON.stringify(batch)).not.toContain("4411");
  });
});
