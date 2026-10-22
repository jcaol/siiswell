import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { route } from "../src/index";
import { applyMigrations } from "../src/server/d1-sqlite";
import { BRIEF_TITLE_MAX, TASK_KINDS, TASK_TEXT_MODES, applyTaskText, normalizeKind, stricterTaskText } from "../src/shared/tasktext";
import { HOOK_MARK, HOOK_TITLES } from "../src/shared/hook";
import { buildState } from "../src/state";
import { cleanTitle, taskTitle } from "../public/format.js";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";
import type { Env } from "../src/env";

const NOW = 1_800_000_000_000;

async function boot(over: Partial<Env> = {}, taskText?: string) {
  const t = makeEnv(over);
  const ctx = makeCtx();
  const token = await addSource(t.db, "client1", "client");
  if (taskText) t.db.sqlite.query("UPDATE sources SET task_text = ? WHERE name = 'client1'").run(taskText);
  const mcp = async (name: string, args: unknown) => {
    const r = await route(request("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token, headers: { Accept: "application/json, text/event-stream" } }), t.env, ctx, { now: NOW });
    return (await r.json()) as any;
  };
  return { ...t, mcp };
}
const row = (b: { db: any }) => b.db.sqlite.query("SELECT title, last_line, kind FROM tasks ORDER BY rowid DESC LIMIT 1").get() as { title: string; last_line: string | null; kind: string | null };
const LONG = "Fix the login redirect bug that sends people to the wrong page after sign in on mobile";

describe("modes ordering and the ceiling", () => {
  test("none < minimal < brief < full; default brief", () => {
    expect([...TASK_TEXT_MODES]).toEqual(["none", "minimal", "brief", "full"]);
    expect(stricterTaskText("full", "brief")).toBe("brief");
    expect(stricterTaskText("brief", "full")).toBe("brief");
    expect(stricterTaskText("brief", "none")).toBe("none");
    expect(stricterTaskText("minimal", undefined)).toBe("minimal");
  });
  test("brief keeps the title clipped to 60 characters, drops the summary, keeps the hook's mark", () => {
    const out = applyTaskText("report_task", { project: "p", title: LONG, status: "IN_PROGRESS", summary: "details", extra: 1 }, "brief");
    expect((out.title as string).length).toBeLessThanOrEqual(BRIEF_TITLE_MAX);
    expect((out.title as string).startsWith("Fix the login redirect bug")).toBe(true);
    expect("summary" in out).toBe(false);
    expect("extra" in out).toBe(false);
    expect(applyTaskText("report_task", { project: "p", title: HOOK_TITLES[0], status: "BLOCKED", summary: HOOK_MARK }, "brief")).toMatchObject({ title: HOOK_TITLES[0], summary: HOOK_MARK });
  });
  test("brief redacts before it clips (a secret cut at the limit does not survive)", () => {
    const secret = "sk-ant-api03-" + "A1b2C3d4".repeat(8);
    const out = applyTaskText("report_task", { project: "p", title: `Rotate key ${secret}`, status: "IN_PROGRESS" }, "brief");
    expect(String(out.title)).not.toContain("A1b2C3d4");
  });
  test("server ceiling = min(server, per-source): source brief under a full server", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "full" }, "brief");
    await b.mcp("report_task", { project: "web", title: LONG, status: "IN_PROGRESS", summary: "private detail" });
    const r = row(b);
    expect(r.title.length).toBeLessThanOrEqual(BRIEF_TITLE_MAX);
    expect(r.last_line).toBeNull();
  });
  test("a source can raise nothing above the server: source full under a minimal server stays minimal", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "minimal" }, "full");
    await b.mcp("report_task", { project: "web", title: LONG, status: "IN_PROGRESS" });
    expect(row(b).title).toBe("Task");
  });
  test("a source set to full under the default (brief) server is held at brief; with server full it keeps the whole title", async () => {
    const b1 = await boot({ ACCEPT_TASK_TEXT: undefined }, "full");
    await b1.mcp("report_task", { project: "web", title: LONG, status: "IN_PROGRESS", summary: "x" });
    expect(row(b1).title.length).toBeLessThanOrEqual(BRIEF_TITLE_MAX);
    const b2 = await boot({ ACCEPT_TASK_TEXT: "full" }, "full");
    await b2.mcp("report_task", { project: "web", title: LONG, status: "IN_PROGRESS", summary: "x" });
    expect(row(b2)).toMatchObject({ title: LONG, last_line: "x" });
  });
  test("no source value and no server setting: brief", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: undefined });
    await b.mcp("report_task", { project: "web", title: LONG, status: "IN_PROGRESS" });
    expect(row(b).title.length).toBeLessThanOrEqual(BRIEF_TITLE_MAX);
  });
});

describe("kind", () => {
  test("validation: fixed list, case-insensitive, unknown -> other, non-string dropped", () => {
    for (const k of TASK_KINDS) expect(normalizeKind(k)).toBe(k);
    expect(normalizeKind(" Debugging ")).toBe("debugging");
    expect(normalizeKind("fix the invoice for Acme")).toBe("other");
    expect(normalizeKind(5)).toBeUndefined();
    expect(normalizeKind("")).toBeUndefined();
  });
  test("applyTaskText keeps a normalized kind in every mode, never free text", () => {
    for (const m of TASK_TEXT_MODES) {
      expect(applyTaskText("report_task", { project: "p", status: "DONE", kind: "Testing" }, m).kind).toBe("testing");
      expect(applyTaskText("report_task", { project: "p", status: "DONE", kind: "secret customer name" }, m).kind).toBe("other");
      expect(applyTaskText("update_task", { task_id: "m-1", status: "DONE", kind: "docs" }, m).kind).toBe("docs");
      expect("kind" in applyTaskText("report_task", { project: "p", status: "DONE", kind: { a: 1 } }, m)).toBe(false);
    }
  });
  test("stored on report, kept with taskText none, unknown becomes other; update can change it", async () => {
    const b = await boot({ ACCEPT_TASK_TEXT: "none" });
    const res = await b.mcp("report_task", { project: "web", title: LONG, status: "IN_PROGRESS", kind: "debugging" });
    expect(row(b)).toMatchObject({ title: "Task", kind: "debugging" });
    const id = JSON.parse(res.result.content[0].text).task_id;
    await b.mcp("update_task", { task_id: id, status: "IN_PROGRESS", kind: "bogus words", eta_min: 5 });
    expect(row(b).kind).toBe("other");
    await b.mcp("update_task", { task_id: id, status: "DONE", kind: "deploy" });
    expect(row(b).kind).toBe("deploy");
    await b.mcp("report_task", { project: "web", status: "IN_PROGRESS", kind: "Weird Thing" });
    expect(row(b).kind).toBe("other");
  });
  test("a task without kind stores NULL; the state carries kind", async () => {
    const b = await boot();
    await b.mcp("report_task", { project: "web", title: "Plain", status: "IN_PROGRESS" });
    expect(row(b).kind).toBeNull();
    await b.mcp("report_task", { project: "web", title: "Typed", status: "IN_PROGRESS", kind: "review" });
    const st = await buildState(b.env.DB, NOW + 1000);
    expect(st.tasks.map((t) => t.kind).sort()).toEqual([null, "review"]);
  });
  test("the tool schemas offer kind", async () => {
    const b = await boot();
    const r = await route(request("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, token: await addSource(b.db, "c2", "client"), headers: { Accept: "application/json, text/event-stream" } }), b.env, makeCtx(), { now: NOW });
    const tools = ((await r.json()) as any).result.tools as any[];
    for (const n of ["report_task", "update_task"]) expect(tools.find((t) => t.name === n).inputSchema.properties.kind.enum).toEqual([...TASK_KINDS]);
  });
});

describe("UI label", () => {
  test("generic title shows kind · project; a real title is untouched; no kind keeps Task", () => {
    expect(taskTitle({ title: "Task", kind: "debugging", project: "web" })).toBe("debugging · web");
    expect(taskTitle({ title: "Task", kind: "docs" })).toBe("docs");
    expect(taskTitle({ title: "Task", project: "web" })).toBe("Task");
    expect(taskTitle({ title: "Fix login redirect bug", kind: "coding", project: "web" })).toBe(cleanTitle("Fix login redirect bug"));
    expect(taskTitle({ title: "Task", kind: "not-a-kind", project: "web" })).toBe("Task");
  });
});

describe("migration 0014", () => {
  test("adds tasks.kind and sources.task_text, both nullable", () => {
    const db = new Database(":memory:");
    const dir = join(import.meta.dir, "..", "migrations");
    expect(applyMigrations(db, dir)).toContain("0014_task_kind.sql");
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().filter((f) => f <= "0014_task_kind.sql").pop()).toBe("0014_task_kind.sql");
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number }>);
    expect(cols("tasks").find((c) => c.name === "kind")).toMatchObject({ notnull: 0 });
    expect(cols("sources").find((c) => c.name === "task_text")).toMatchObject({ notnull: 0 });
  });
});

describe("clipText keeps surrogate pairs whole", () => {
  test("a cut that would split an emoji drops the whole pair", async () => {
    const { clipText } = await import("../src/shared/redact");
    const out = clipText(`abcd😀efgh`, 6); // max-1 = 5 would end on the high surrogate
    expect(out).toBe("abcd…");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});
