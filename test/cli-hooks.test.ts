/**
 * `siiswell hook ...` (the app hooks setup-client.sh installs): only the CLI's own MCP calls, never the hook input's free text,
 * always exit 0, return at once (the work runs detached in the background). Fixtures only: scratch HOME, in-process server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHookInput } from "../cli/src/hooks";
import { buildCli } from "../cli/build";
import { cli, scratchHome, startServer, type TestServer } from "./cli-helpers";

// The foreground hook starts DETACHED background runs (`hook <event> --wait`): none may outlive this file.
const built: string[] = [];
const build = async (out: string) => { built.push(out); await buildCli(out); };
/** pids of live processes running one of the bundles this file built */
const ownChildren = (): number[] => {
  const { existsSync, readdirSync, readFileSync: rf } = require("node:fs") as typeof import("node:fs");
  const pids: number[] = [];
  if (!existsSync("/proc")) {
    // macOS and other systems without /proc: ask ps for every process's arguments
    const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,args="]);
    for (const line of new TextDecoder().decode(ps.stdout).split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && Number(m[1]) !== process.pid && built.some((b) => m[2]!.includes(b))) pids.push(Number(m[1]));
    }
    return pids;
  }
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    let cmd = "";
    try { cmd = rf(`/proc/${d}/cmdline`, "utf8"); } catch { continue; }
    if (built.some((b) => cmd.split("\0").includes(b))) pids.push(Number(d));
  }
  return pids;
};
/** wait up to `ms` for the detached runs to finish, then kill whatever is left; returns how many had to be killed */
const reapChildren = async (ms: number): Promise<number> => {
  if (process.platform !== "linux") return 0;
  for (const end = Date.now() + ms; Date.now() < end && ownChildren().length; ) await new Promise((r) => setTimeout(r, 50));
  const left = ownChildren();
  for (const pid of left) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  return left.length;
};
afterAll(async () => { await reapChildren(0); });
// every test's detached hook runs (a runner may sit out a backoff for minutes) end with the test, not the file
afterEach(async () => { await reapChildren(0); });
// also when the run ends without afterAll (a bail, a timeout, Ctrl-C): a runner may otherwise sit out a backoff for up to an hour
const killOwn = () => { for (const pid of ownChildren()) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", killOwn);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { killOwn(); process.exit(130); });

const SENTINEL = "PRIVATE-HOOK-TEXT-91c2";

describe("parseHookInput keeps only a hashed session id, the cwd and the kind", () => {
  test("Claude Code Notification / Stop, Codex notify", () => {
    const n = parseHookInput("claude-notification", JSON.stringify({ session_id: "abc-123", cwd: "/w/p", hook_event_name: "Notification", message: `Claude needs your permission to use Bash ${SENTINEL}`, transcript_path: "/x.jsonl" }));
    expect(n).toEqual({ session: expect.stringMatching(/^[0-9a-f]{24}$/), cwd: "/w/p", permission: true });
    expect(JSON.stringify(n)).not.toContain(SENTINEL);
    expect(JSON.stringify(n)).not.toContain("abc-123");
    expect(parseHookInput("claude-notification", JSON.stringify({ session_id: "s", message: "Claude is waiting for your input" }))!.permission).toBeUndefined();
    expect(parseHookInput("claude-notification", JSON.stringify({ session_id: "s", message: "Claude is waiting for your input" }))!.idle).toBe(true);
    expect(parseHookInput("claude-notification", JSON.stringify({ session_id: "s", notification_type: "permission_prompt", message: "x" }))!.permission).toBe(true);
    const kind = (o: Record<string, unknown>) => { const i = parseHookInput("claude-notification", JSON.stringify({ session_id: "s", ...o }))!; return i.idle ? "idle" : i.permission ? "permission" : "blocked"; };
    expect(kind({ notification_type: "idle_prompt", message: "x" })).toBe("idle");
    expect(kind({ message: "Claude is waiting for your input" })).toBe("idle");
    expect(kind({ notification_type: "auth_success", message: "Signed in" })).toBe("idle");
    expect(kind({ notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })).toBe("permission");
    expect(kind({ notification_type: "elicitation_dialog", message: "An MCP server asks for input" })).toBe("blocked");
    expect(kind({ notification_type: "elicitation_dialog", message: "waiting for your input" })).toBe("blocked");
    expect(kind({ notification_type: "some_future_type", message: "Something new" })).toBe("blocked");
    expect(kind({ message: "Claude would like you to look at this" })).toBe("blocked"); // a reworded message
    expect(parseHookInput("claude-stop", JSON.stringify({ session_id: "s", cwd: "/w" }))!.session).toBe(parseHookInput("claude-notification", JSON.stringify({ session_id: "s" }))!.session);
    const c = parseHookInput("codex-notify", JSON.stringify({ type: "agent-turn-complete", "thread-id": "t1", cwd: "/w/q", "input-messages": [SENTINEL], "last-assistant-message": SENTINEL }));
    expect(c).toEqual({ session: expect.stringMatching(/^[0-9a-f]{24}$/), cwd: "/w/q" });
    for (const bad of ["", "nope", "[]", "null", JSON.stringify({ cwd: "/w" })]) expect(parseHookInput("claude-stop", bad)).toBeNull();
  });
});

describe("hooks against the server (foreground --wait runs)", () => {
  let s: TestServer;
  let home: string;
  let env: Record<string, string>;
  beforeAll(async () => {
    s = await startServer();
    home = scratchHome();
    mkdirSync(join(home, "projects", "blog"), { recursive: true });
    // projects come from configured roots and are shown by name (the default policy would hide them: see cli-defaults)
    writeFileSync(join(home, "cfg.json"), JSON.stringify({ usage: { roots: ["~/projects"], projectNames: "all" } }), { mode: 0o600 });
    env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client, SIISWELL_MACHINE: "laptop-1", SIISWELL_CONFIG: join(home, "cfg.json") };
  });
  afterAll(() => s.stop());

  const claude = (event: string, payload: Record<string, unknown>, extra: string[] = []) =>
    cli(["hook", event, "--wait", "--json", ...extra], env, { input: JSON.stringify({ session_id: "sess-1", cwd: join(home, "projects", "blog"), ...payload }) });
  const action = (r: { out: string }) => JSON.parse(r.out).action as string;
  const task = () => s.t.db.sqlite.query("SELECT project, title, state, agent, machine FROM tasks ORDER BY created DESC LIMIT 1").get() as Record<string, string>;

  test("Notification -> one BLOCKED task per session (fixed title, no message text); Stop -> DONE; another Stop -> nothing", async () => {
    const before = s.seen.length;
    const n1 = await claude("claude-notification", { message: `Claude needs your permission to use Bash: rm ${SENTINEL}` });
    expect([n1.code, action(n1)]).toEqual([0, "reported"]);
    expect(task()).toEqual({ project: "blog", title: "Waiting for your permission", state: "blocked", agent: "claude@laptop-client", machine: "laptop-1" });
    const n2 = await claude("claude-notification", { message: "Claude needs your permission to use Edit" });
    expect(action(n2)).toBe("updated");
    // the idle Notification at the end of a turn is not a block: no task change, no request, no alert
    const idleBefore = s.seen.length;
    expect(action(await claude("claude-notification", { message: "Claude is waiting for your input", notification_type: "idle_prompt" }))).toBe("nothing");
    expect(s.seen.length).toBe(idleBefore);
    // an elicitation (or any unknown type) waits for the user: BLOCKED, with the action-needed title for a new task
    const other = { session_id: "sess-elicit" };
    expect(action(await claude("claude-notification", { ...other, notification_type: "elicitation_dialog", message: "An MCP server asks for input" }))).toBe("reported");
    expect(task()).toMatchObject({ title: "Waiting for your input (action needed)", state: "blocked" });
    expect(action(await claude("claude-notification", { ...other, notification_type: "some_future_type", message: "x" }))).toBe("updated");
    expect(task().state).toBe("blocked");
    expect(action(await claude("claude-stop", other, ["--on-stop", "done"]))).toBe("closed");
    s.t.db.sqlite.query("DELETE FROM tasks WHERE title = 'Waiting for your input (action needed)'").run(); // the counts below are about sess-1
    expect((s.t.db.sqlite.query("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c).toBe(1);
    const st = await claude("claude-stop", {}, ["--on-stop", "done"]);
    expect(action(st)).toBe("closed");
    expect(task().state).toBe("done");
    const n = s.seen.length;
    expect(action(await claude("claude-stop", {}, ["--on-stop", "done"]))).toBe("nothing");
    expect(s.seen.length).toBe(n); // no task for the session: no request at all
    expect(s.seen.slice(before).map((x) => x.body).join("\n")).not.toContain(SENTINEL);
    expect(s.seen.slice(before).map((x) => x.body).join("\n")).not.toContain(home); // a folder name, never a path
    const sessions = join(home, ".local", "state", "siiswell", "hook-sessions.json");
    expect(statSync(sessions).mode & 0o077).toBe(0);
    expect(readFileSync(sessions, "utf8")).not.toContain("sess-1");
  });

  test("the default (heartbeat) keeps the task open as IN_PROGRESS; a closed task makes the next Notification report a new one", async () => {
    const e2 = { session_id: "sess-2", notification_type: "permission_prompt" };
    await claude("claude-notification", { ...e2, message: "Claude needs your permission" });
    expect(action(await claude("claude-stop", e2))).toBe("updated");
    expect(task().state).toBe("running");
    s.t.db.sqlite.run("UPDATE tasks SET state = 'done' WHERE state = 'running'");
    expect(action(await claude("claude-notification", { ...e2, message: "Claude needs your permission" }))).toBe("reported");
  });

  test("a granted permission unblocks: PostToolUse / UserPromptSubmit -> IN_PROGRESS, throttled, no request when not BLOCKED; SessionEnd -> DONE", async () => {
    const T0 = Date.parse("2027-01-15T10:00:00Z");
    const e = { session_id: "sess-unblock", notification_type: "permission_prompt" };
    const at = (ms: number) => ({ now: () => T0 + ms });
    const run = (event: string, ms: number, extra: string[] = []) =>
      cli(["hook", event, "--wait", "--json", ...extra], env, { input: JSON.stringify({ cwd: join(home, "projects", "blog"), ...e }), ...at(ms) });
    expect(action(await run("claude-notification", 0))).toBe("reported");
    expect(task().state).toBe("blocked");
    expect((s.t.db.sqlite.query("SELECT last_line FROM tasks ORDER BY created DESC LIMIT 1").get() as { last_line: string }).last_line).toBe("reported by the siiswell hook");
    expect(action(await run("claude-post-tool", 5_000))).toBe("updated");
    expect(task().state).toBe("running");
    // already IN_PROGRESS: decided from the state file, no request at all
    let n = s.seen.length;
    for (const ms of [6_000, 7_000, 60_000]) expect(action(await run("claude-post-tool", ms))).toBe("nothing");
    expect(action(await run("claude-prompt", 61_000))).toBe("nothing");
    expect(s.seen.length).toBe(n);
    // two permission prompts 10 s apart: each BLOCKED episode is unblocked (a new episode clears the throttle)
    expect(action(await run("claude-notification", 100_000))).toBe("updated");
    expect(action(await run("claude-post-tool", 101_000))).toBe("updated");
    expect(action(await run("claude-notification", 111_000))).toBe("updated");
    expect(task().state).toBe("blocked");
    expect(action(await run("claude-post-tool", 112_000))).toBe("updated");
    expect(task().state).toBe("running");
    // inside ONE episode the throttle holds: the unblock did not reach the server (it failed), a repeat 2 s later sends nothing
    expect(action(await run("claude-notification", 120_000))).toBe("updated");
    const failing = async () => new Response("down", { status: 503 });
    expect(action(await cli(["hook", "claude-post-tool", "--wait", "--json"], env, { input: JSON.stringify({ cwd: join(home, "projects", "blog"), ...e }), now: () => T0 + 121_000, fetch: failing }))).toBe("skipped");
    n = s.seen.length;
    expect(action(await run("claude-post-tool", 123_000))).toBe("nothing"); // throttled
    expect(s.seen.length).toBe(n);
    expect(action(await run("claude-prompt", 151_001))).toBe("updated"); // 30 s on
    expect(task().state).toBe("running");
    // the session ends (Ctrl-C, /exit): the task is closed
    expect(action(await run("claude-session-end", 160_000))).toBe("closed");
    expect(task().state).toBe("done");
    expect(action(await run("claude-session-end", 161_000))).toBe("nothing");
  });

  test("SessionEnd with --on-end heartbeat keeps the task open; the foreground PostToolUse starts nothing unless BLOCKED", async () => {
    const e = { session_id: "sess-end-hb", notification_type: "permission_prompt" };
    await claude("claude-notification", { ...e, message: "Claude needs your permission" });
    expect(action(await claude("claude-session-end", e, ["--on-end", "heartbeat"]))).toBe("updated");
    expect(task().state).toBe("running");
    const spawned: string[][] = [];
    const fg = (event: string, sid: string) => cli(["hook", event], env, { input: JSON.stringify({ session_id: sid, cwd: "/w", notification_type: "permission_prompt" }), spawnBackground: (args) => { spawned.push(args); } });
    await fg("claude-post-tool", "sess-end-hb"); // IN_PROGRESS: nothing started
    await fg("claude-post-tool", "never-seen");
    expect(spawned).toEqual([]);
    await claude("claude-notification", { ...e, message: "Claude needs your permission" });
    await fg("claude-post-tool", "sess-end-hb"); // BLOCKED: the background run starts
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.slice(0, 3)).toEqual(["hook", "claude-post-tool", "--wait"]);
  });

  test("race: a Notification fired while an unblock is in flight waits for the session lock, then ends BLOCKED on the server and locally; the next PostToolUse unblocks", async () => {
    const T0 = Date.parse("2027-02-01T10:00:00Z");
    const e = { session_id: "sess-race", cwd: join(home, "projects", "blog"), notification_type: "permission_prompt" };
    const run = (event: string, ms: number, fetch?: typeof globalThis.fetch) => cli(["hook", event, "--wait", "--json"], env, { input: JSON.stringify(e), now: () => T0 + ms, ...(fetch ? { fetch: fetch as never } : {}) });
    expect(action(await run("claude-notification", 0))).toBe("reported");
    // the unblock's request is held until a Notification (a new permission prompt) has run completely
    let fired: Promise<{ out: string }> | null = null;
    const slow = (async (url: string, init: RequestInit) => {
      if (!fired && String(init.body).includes('"IN_PROGRESS"')) fired = run("claude-notification", 2_000); // started, not awaited: it waits for the lock
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    expect(action(await run("claude-post-tool", 1_000, slow))).toBe("updated");
    expect(fired).not.toBeNull();
    expect(action(await fired!)).toBe("updated"); // ran after the unblock released the session: the newest event, BLOCKED
    expect(task().state).toBe("blocked"); // the server: restored to BLOCKED
    const local = JSON.parse(readFileSync(join(home, ".local", "state", "siiswell", "hook-sessions.json"), "utf8")).sessions;
    const mine = Object.values(local).find((x: any) => x.at === T0 + 2_000) as { st: string; up?: number };
    expect(mine.st).toBe("BLOCKED");
    expect(mine.up).toBeUndefined();
    expect(action(await run("claude-post-tool", 3_000))).toBe("updated"); // not throttled: a new episode
    expect(task().state).toBe("running");
  });

  test("a Notification is never lost: when its report fails it stays queued and the next run of the session reports it", async () => {
    const e = { session_id: "sess-queue", cwd: join(home, "projects", "blog"), notification_type: "permission_prompt" };
    const T0 = Date.parse("2027-04-01T10:00:00Z");
    const down = async () => new Response("down", { status: 503 });
    const stateDir0 = join(home, ".local", "state", "siiswell");
    const { readdirSync: rd } = await import("node:fs");
    const queued0 = () => { try { return rd(stateDir0).filter((n) => n.includes(".ev.")).length; } catch { return 0; } };
    const q0 = queued0();
    const r1 = await cli(["hook", "claude-notification", "--wait", "--json"], env, { input: JSON.stringify(e), now: () => T0, fetch: down as never });
    expect(action(r1)).toBe("skipped");
    const stateDir = join(home, ".local", "state", "siiswell");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(stateDir).filter((n) => n.includes(".ev.")).length).toBe(q0 + 1); // still queued
    // the next event of the session (here a Stop) drains the queue first: the prompt is reported, then the Stop applies
    const before = (s.t.db.sqlite.query("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
    const r2 = await cli(["hook", "claude-notification", "--wait", "--json"], env, { input: JSON.stringify(e), now: () => T0 + 5_000 });
    expect(action(r2)).toBe("reported");
    expect((s.t.db.sqlite.query("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c).toBe(before + 1);
    expect(readdirSync(stateDir).filter((n) => n.includes(".ev.")).length).toBe(q0);
  });

  test("Codex notify -> heartbeat with the project only", async () => {
    const before = s.seen.length;
    const r = await cli(["hook", "codex-notify", "--wait", "--json", JSON.stringify({ type: "agent-turn-complete", "thread-id": "t", cwd: join(home, "projects", "blog"), "last-assistant-message": SENTINEL })], env);
    expect([r.code, action(r)]).toEqual([0, "heartbeat"]);
    const body = s.seen.slice(before).map((x) => x.body).join("\n");
    expect(body).toContain('"name":"heartbeat"');
    expect(body).toContain('"project":"blog"');
    expect(body).not.toContain(SENTINEL);
  });

  test("never fails the app: unknown event, bad input, no config, unreachable dashboard all exit 0", async () => {
    expect((await cli(["hook", "nope"], env)).code).toBe(0);
    expect((await cli(["hook", "claude-stop", "--wait"], env, { input: "not json" })).code).toBe(0);
    expect((await cli(["hook", "claude-notification", "--wait"], { HOME: home }, { input: JSON.stringify({ session_id: "x" }) })).code).toBe(0);
    const r = await cli(["hook", "claude-notification", "--wait", "--json"], { ...env, SIISWELL_URL: "http://127.0.0.1:9" }, { input: JSON.stringify({ session_id: "y", cwd: "/w/p", notification_type: "permission_prompt" }) });
    expect([r.code, action(r)]).toEqual([0, "skipped"]);
    expect((await cli(["hook", "claude-stop", "--wait"], { ...env, SIISWELL_CONFIG: join(home, "missing.json"), SIISWELL_TOKEN: "bad" }, { input: JSON.stringify({ session_id: "z" }) })).code).toBe(0);
  });

  test("without --wait: parses, hands only the kept fields to a background run, returns at once without any request", async () => {
    const spawned: Array<{ args: string[]; input: string | undefined }> = [];
    const before = s.seen.length;
    const r = await cli(["hook", "claude-notification", "--config", "/cfg/claude-code.json"], env, {
      input: JSON.stringify({ session_id: "bg", cwd: "/w/p", notification_type: "permission_prompt", message: SENTINEL }),
      spawnBackground: (args, e) => { spawned.push({ args, input: e.SIISWELL_HOOK_INPUT }); },
    });
    expect(r.code).toBe(0);
    expect(s.seen.length).toBe(before);
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.args).toEqual(["hook", "claude-notification", "--wait", "--config", "/cfg/claude-code.json", "--on-stop", "heartbeat", "--on-end", "done"]);
    expect(spawned[0]!.input).not.toContain(SENTINEL);
    // the event's own time, and the foreground already queued it (one small file in the state dir)
    expect(JSON.parse(spawned[0]!.input!)).toEqual({ session: expect.any(String), at: expect.any(Number), permission: true, queued: true, runner: true }); // no cwd: the run gets only a project label (none here)
  });
});

describe("the built hook under Node returns in well under a second, even with the dashboard unreachable", () => {
  test("node siiswell.mjs hook claude-stop / claude-notification", async () => {
    const node = Bun.which("node");
    if (!node) return;
    const out = join(scratchHome(), "siiswell.mjs");
    await build(out);
    for (const ev of ["claude-notification", "claude-stop"]) {
      const t0 = Date.now();
      const p = Bun.spawn([node, out, "hook", ev], {
        env: { PATH: process.env.PATH ?? "", HOME: scratchHome(), SIISWELL_URL: "http://127.0.0.1:9", SIISWELL_TOKEN: `oct_${"a".repeat(43)}` },
        stdin: new Blob([JSON.stringify({ session_id: "s", cwd: "/w/p", message: "Claude needs your permission" })]), stdout: "pipe", stderr: "pipe",
      });
      expect(await p.exited).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
    // unreachable dashboard + a queued Notification: ONE runner stays to sit out the backoff and retry (the user waits at the
    // prompt); nothing else piles up. This test does not wait for it: it is killed here.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(ownChildren().length).toBeLessThanOrEqual(1);
    await reapChildren(0);
  }, 45_000);
});

describe("real concurrent background runs (node children): the newest event wins on the server", () => {
  test("20+ iterations of a Notification and a PostToolUse racing in separate processes", async () => {
    const node = Bun.which("node");
    if (!node) return;
    const { spawn } = await import("node:child_process");
    const { randomBytes } = await import("node:crypto");
    const s = await startServer();
    try {
      const out = join(scratchHome(), "siiswell.mjs");
      await build(out);
      const home = scratchHome();
      mkdirSync(join(home, "projects", "blog"), { recursive: true });
      const baseEnv = { PATH: process.env.PATH ?? "", HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client, NODE_ENV: "test" };
      const runChild = (event: string, input: Record<string, unknown>) => new Promise<number>((resolve) => {
        const p = spawn(node, [out, "hook", event, "--wait"], { env: { ...baseEnv, SIISWELL_HOOK_INPUT: JSON.stringify(input) }, stdio: "ignore" });
        p.on("exit", (code) => resolve(code ?? 0));
      });
      const stateOf = (taskSession: string) => {
        const sessions = JSON.parse(readFileSync(join(home, ".local", "state", "siiswell", "hook-sessions.json"), "utf8")).sessions;
        const e = sessions[taskSession];
        const row = s.t.db.sqlite.query("SELECT state FROM tasks WHERE task_id = ?").get(e.taskId) as { state: string };
        return { local: e.st as string, server: row.state };
      };
      const cwd = join(home, "projects", "blog");
      let checked = 0;
      for (let i = 0; i < 24; i++) {
        const session = randomBytes(12).toString("hex");
        const t0 = Date.parse("2027-03-01T10:00:00Z") + i * 3_600_000;
        await runChild("claude-notification", { session, cwd, at: t0, permission: true }); // the task, BLOCKED
        const notificationNewest = i % 2 === 0;
        const n = { session, cwd, permission: true, at: t0 + (notificationNewest ? 2_000 : 1_000) };
        const u = { session, cwd, at: t0 + (notificationNewest ? 1_000 : 2_000) };
        // start both at once, in a varying order
        const runs = i % 4 < 2 ? [runChild("claude-post-tool", u), runChild("claude-notification", n)] : [runChild("claude-notification", n), runChild("claude-post-tool", u)];
        expect(await Promise.all(runs)).toEqual([0, 0]);
        const st = stateOf(session);
        if (notificationNewest) expect([i, st]).toEqual([i, { local: "BLOCKED", server: "blocked" }]);
        else expect([i, st]).toEqual([i, { local: "IN_PROGRESS", server: "running" }]);
        checked++;
      }
      expect(checked).toBe(24);
    } finally {
      s.stop();
    }
  }, 120_000);
});

describe("tester5's loop: real foreground hooks (detached background runs), Notification then PostToolUse", () => {
  const scenario = async (gapMs: number, iterations: number) => {
    const node = Bun.which("node");
    if (!node) return null;
    const { spawn } = await import("node:child_process");
    const { readdirSync } = await import("node:fs");
    const s = await startServer();
    const out = join(scratchHome(), "siiswell.mjs");
    await build(out);
    const home = scratchHome();
    mkdirSync(join(home, "projects", "blog"), { recursive: true });
    const env = { PATH: process.env.PATH ?? "", HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client, NODE_ENV: "test" };
    const stateDir = join(home, ".local", "state", "siiswell");
    const fg = (event: string, sid: string) => new Promise<void>((resolve) => {
      const p = spawn(node, [out, "hook", event], { env, stdio: ["pipe", "ignore", "ignore"] });
      p.stdin.end(JSON.stringify({ session_id: sid, cwd: join(home, "projects", "blog"), message: "Claude needs your permission to use Bash" }));
      p.on("exit", () => resolve());
    });
    const settled = async () => {
      for (let i = 0; i < 400; i++) {
        let busy = false;
        try { busy = readdirSync(stateDir).some((n) => n.includes(".ev.") || n.endsWith(".lock")); } catch { busy = true; }
        if (!busy) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("background runs did not finish");
    };
    const blockedWrites = () => s.seen.filter((x) => x.path === "/mcp" && /"status":"BLOCKED"/.test(x.body)).length;
    const results: Array<{ notified: boolean; final: string }> = [];
    try {
      for (let i = 0; i < iterations; i++) {
        const sid = `loop-${gapMs}`; // ONE session, like a real terminal
        const before = blockedWrites();
        const n = fg("claude-notification", sid);
        await new Promise((r) => setTimeout(r, gapMs));
        const p = fg("claude-post-tool", sid);
        await Promise.all([n, p]);
        await settled();
        const task = s.t.db.sqlite.query("SELECT state FROM tasks ORDER BY updated DESC LIMIT 1").get() as { state: string } | null;
        results.push({ notified: blockedWrites() > before, final: task?.state ?? "none" });
      }
    } finally {
      s.stop();
    }
    return results;
  };
  test("50 ms apart, 20 times: every Notification reaches the server (report or BLOCKED update)", async () => {
    const r = await scenario(50, 20);
    if (!r) return;
    expect(r.filter((x) => !x.notified)).toEqual([]);
    expect(r.length).toBe(20);
  }, 180_000);
  test("250 ms apart (>= 200 ms: a defined order), 10 times: the PostToolUse is newest, so the task ends running", async () => {
    const r = await scenario(250, 10);
    if (!r) return;
    expect(r.filter((x) => !x.notified || x.final !== "running")).toEqual([]);
  }, 180_000);
});

import { HOOK_QUEUE_CAP, queueEvent, queuedEvents, sweepStateDir } from "../cli/src/hooks";
describe("offline: one runner per session, a backoff, a bounded queue", () => {
  test("50 rapid PostToolUse while offline start at most ONE background run; the Notification is delivered when the server is back", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      mkdirSync(join(home, "projects", "blog"), { recursive: true });
      const offline = { HOME: home, SIISWELL_URL: "http://127.0.0.1:9", SIISWELL_TOKEN: s.client };
      const online = { ...offline, SIISWELL_URL: s.url };
      const T0 = Date.parse("2027-05-01T10:00:00Z");
      const input = JSON.stringify({ session_id: "laptop-offline", cwd: join(home, "projects", "blog"), message: "Claude needs your permission" });
      const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const fg = (event: string, ms: number, env: Record<string, string>) => cli(["hook", event], env, { input, now: () => T0 + ms, spawnBackground: (args, e) => { spawned.push({ args, env: e }); } });
      const runBackground = (i: number, env: Record<string, string>, ms: number) => cli(spawned[i]!.args.concat(["--json"]), { ...env, SIISWELL_HOOK_INPUT: spawned[i]!.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + ms });
      await fg("claude-notification", 0, offline);
      for (let i = 0; i < 50; i++) await fg("claude-post-tool", 10 + i * 10, offline);
      expect(spawned.length).toBe(1); // ONE runner; the other events wait in the queue
      // the runner cannot reach the dashboard: the Notification stays queued, the session backs off, and the runner (the user waits
      // at the prompt: no other hook comes) sits out the backoff itself and sends again, with no further hook
      const stateDir = join(home, ".local", "state", "siiswell");
      const sid = JSON.parse(spawned[0]!.env.SIISWELL_HOOK_INPUT!).session;
      let reachable = false;
      let sends = 0;
      const net = (async (url: string, init: RequestInit) => {
        sends++;
        if (!reachable) throw new TypeError("fetch failed: ECONNREFUSED");
        return fetch(url, init);
      }) as typeof globalThis.fetch;
      const sleeps: number[] = [];
      const sleep = async (ms: number) => {
        sleeps.push(ms);
        if (sleeps.length > 1) return;
        // while the runner sleeps: 50 more PostToolUse start nothing (a live runner, a backoff), the Notification waits
        for (let i = 0; i < 50; i++) await fg("claude-post-tool", 3_000 + i * 10, offline);
        expect(spawned.length).toBe(1);
        expect(queuedEvents(stateDir, sid, T0 + 4_000).filter((e) => e.e === "claude-notification").length).toBe(1);
        reachable = true; // the network is back
      };
      const r = await cli(spawned[0]!.args.concat(["--json"]), { ...online, SIISWELL_HOOK_INPUT: spawned[0]!.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + 2_000, fetch: net as never, sleep });
      expect(sleeps).toEqual([20_000, 10_000]); // the first backoff step (30 s, the marker refreshed every 20 s), then the second pass
      expect(sends).toBe(4); // the failed report; then the report, the unblock (the PostToolUse events are newer) and the hourly human counts
      expect(JSON.parse(r.out).action).toBe("reported");
      expect(spawned.length).toBe(1);
      expect((s.t.db.sqlite.query("SELECT COUNT(*) AS c FROM tasks WHERE title = 'Waiting for your permission'").get() as { c: number }).c).toBe(1);
    } finally {
      s.stop();
    }
  });

  test("the sweep removes event files older than an hour in the whole state dir (any session); at most every 10 minutes unless forced", () => {
    const dir = join(scratchHome(), "st");
    const now = Date.parse("2027-05-01T12:00:00Z");
    const a = "a".repeat(24), b = "b".repeat(24);
    queueEvent(dir, a, { e: "claude-notification", at: now - 2 * 3_600_000 });
    queueEvent(dir, b, { e: "claude-post-tool", at: now - 90 * 60_000 });
    queueEvent(dir, b, { e: "claude-post-tool", at: now - 5 * 60_000 });
    expect(sweepStateDir(dir, now)).toBe(2);
    queueEvent(dir, a, { e: "claude-post-tool", at: now - 3 * 3_600_000 });
    expect(sweepStateDir(dir, now + 60_000)).toBe(0); // swept a minute ago
    expect(sweepStateDir(dir, now + 11 * 60_000)).toBe(1);
    expect(queuedEvents(dir, b, now).length).toBe(1);
  });

  test("a session's queue holds at most 200 events: the oldest non-Notification events go first", () => {
    const dir = join(scratchHome(), "st");
    const sid = "c".repeat(24);
    const now = Date.parse("2027-05-01T12:00:00Z");
    queueEvent(dir, sid, { e: "claude-notification", at: now - 50_000 }); // the oldest: kept
    for (let i = 0; i < 250; i++) queueEvent(dir, sid, { e: "claude-post-tool", at: now - 40_000 + i });
    const q = queuedEvents(dir, sid, now);
    expect(q.length).toBe(HOOK_QUEUE_CAP);
    expect(q[0]!.e).toBe("claude-notification");
    expect(q[1]!.at).toBe(now - 40_000 + 51); // the 51 oldest PostToolUse were dropped
  });
});

describe("report_task is idempotent with a client_ref: a run killed after the send makes no second task", () => {
  test("the report reaches the server, the run dies before saving the task id; the re-run gets the SAME task", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      mkdirSync(join(home, "projects", "blog"), { recursive: true });
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const T0 = Date.parse("2027-06-01T10:00:00Z");
      const input = JSON.stringify({ session_id: "sess-killed", cwd: join(home, "projects", "blog"), message: "Claude needs your permission" });
      const run = (ms: number, f?: typeof globalThis.fetch) => cli(["hook", "claude-notification", "--wait", "--json"], env, { input, now: () => T0 + ms, ...(f ? { fetch: f as never } : {}) });
      // the server stores the task, then the process is "killed" before it reads the reply (and so before any state write)
      const killed = (async (url: string, init: RequestInit) => {
        await fetch(url, init);
        throw new Error("SIGKILL");
      }) as typeof globalThis.fetch;
      expect(JSON.parse((await run(0, killed)).out).action).toBe("skipped");
      const count = () => (s.t.db.sqlite.query("SELECT COUNT(*) AS c FROM tasks WHERE origin = 'mcp'").get() as { c: number }).c;
      expect(count()).toBe(1);
      const sent = s.seen.filter((x) => x.path === "/mcp" && x.body.includes('"report_task"'));
      const ref = (JSON.parse(sent[0]!.body) as { params: { arguments: { client_ref: string } } }).params.arguments.client_ref;
      expect(ref).toMatch(/^[0-9a-f]{16}$/);
      // the retry (after the backoff) reuses the key: exactly one task, and the hook now knows its id
      expect(JSON.parse((await run(60_000)).out).action).toBe("reported");
      expect(count()).toBe(1);
      const again = s.seen.filter((x) => x.path === "/mcp" && x.body.includes('"report_task"'));
      expect(again.length).toBe(2);
      expect(again[1]!.body).toContain(ref);
      const local = JSON.parse(readFileSync(join(home, ".local", "state", "siiswell", "hook-sessions.json"), "utf8")).sessions;
      const row = s.t.db.sqlite.query("SELECT task_id FROM tasks WHERE origin = 'mcp'").get() as { task_id: string };
      expect((Object.values(local)[0] as { taskId: string }).taskId).toBe(row.task_id);
      // the key was used up: a later, separate BLOCKED episode (after DONE) is a NEW task
      expect(require("node:fs").readdirSync(join(home, ".local", "state", "siiswell")).some((n: string) => n.endsWith(".ref"))).toBe(false);
    } finally {
      s.stop();
    }
  });
});

describe("runner liveness: a dead runner is replaced at once, one live runner at most, a Notification is sent when the backoff ends", () => {
  /** In front of the test server: "hang" holds every request open (until stopped), "pass" forwards it. */
  /**
   * In front of the test server: "hang" holds every request open, "pass" forwards it. stop() settles every request still in
   * flight (held ones get a 503) BEFORE the server goes, so nothing can resolve or reject after the test has ended.
   */
  const proxy = (target: string) => {
    let mode: "hang" | "pass" = "hang";
    const held: Array<() => void> = [];
    const inflight = new Set<Promise<Response>>();
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const p = (async () => {
          if (mode === "hang") return new Promise<Response>((resolve) => held.push(() => resolve(new Response("stopped", { status: 503 }))));
          const u = new URL(req.url);
          try {
            return await fetch(target + u.pathname + u.search, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.arrayBuffer() });
          } catch {
            return new Response("upstream gone", { status: 502 });
          }
        })();
        inflight.add(p);
        void p.finally(() => inflight.delete(p));
        return p;
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      set: (m: "hang" | "pass") => { mode = m; },
      stop: async () => {
        for (const release of held.splice(0)) release();
        await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 2_000))]);
        server.stop(true);
      },
    };
  };
  const waitArgs = (out: string) => ownChildren().filter((pid) => {
    try { const c = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); return c.includes(out) && c.includes("--wait"); } catch { return false; }
  });

  test("the runner is killed mid-send; a hook 1 s later takes over at once and drains everything, SessionEnd included", async () => {
    const node = Bun.which("node");
    if (!node || process.platform !== "linux") return;
    const { spawn } = await import("node:child_process");
    const { readdirSync } = await import("node:fs");
    const s = await startServer();
    const px = proxy(s.url);
    try {
      const out = join(scratchHome(), "siiswell.mjs");
      await build(out);
      const home = scratchHome();
      const cwd = join(home, "projects", "blog");
      mkdirSync(cwd, { recursive: true });
      const env = { PATH: process.env.PATH ?? "", HOME: home, SIISWELL_URL: px.url, SIISWELL_TOKEN: s.client, NODE_ENV: "test" };
      const stateDir = join(home, ".local", "state", "siiswell");
      const fg = (event: string) => new Promise<void>((resolve) => {
        const p = spawn(node, [out, "hook", event], { env, stdio: ["pipe", "ignore", "ignore"] });
        p.stdin.end(JSON.stringify({ session_id: "killed-runner", cwd, message: "Claude needs your permission to use Bash" }));
        p.on("exit", () => resolve());
      });
      await fg("claude-notification"); // the runner starts and hangs in its report
      for (let i = 0; i < 50 && !waitArgs(out).length; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 300));
      const [runner] = waitArgs(out);
      expect(runner).toBeGreaterThan(0);
      const marker = JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir).find((n) => n.endsWith(".runner"))!), "utf8"));
      expect(marker.pid).toBe(runner); // the foreground handed the marker to its child
      process.kill(runner!, "SIGKILL");
      px.set("pass");
      await new Promise((r) => setTimeout(r, 1_000));
      await fg("claude-session-end"); // .lock and .runner of the dead run are still there: taken over at once
      for (let i = 0; i < 200; i++) {
        if (!readdirSync(stateDir).some((n) => n.includes(".ev.") || n.endsWith(".lock") || n.endsWith(".runner"))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(readdirSync(stateDir).filter((n) => n.includes(".ev.") || n.endsWith(".lock") || n.endsWith(".runner"))).toEqual([]);
      const rows = s.t.db.sqlite.query("SELECT state FROM tasks WHERE origin = 'mcp'").all() as Array<{ state: string }>;
      expect(rows).toEqual([{ state: "done" }]); // reported (BLOCKED) and closed by the SessionEnd, well before 45 s
    } finally {
      await px.stop();
      s.stop();
      await reapChildren(5_000);
    }
  }, 60_000);

  test("offline with a hanging dashboard: 1 Notification + 50 PostToolUse, sampled every 100 ms, never more than one background run", async () => {
    const node = Bun.which("node");
    if (!node || process.platform !== "linux") return;
    const { spawn } = await import("node:child_process");
    const s = await startServer();
    const px = proxy(s.url);
    try {
      const out = join(scratchHome(), "siiswell.mjs");
      await build(out);
      const home = scratchHome();
      const cwd = join(home, "projects", "blog");
      mkdirSync(cwd, { recursive: true });
      const env = { PATH: process.env.PATH ?? "", HOME: home, SIISWELL_URL: px.url, SIISWELL_TOKEN: s.client, NODE_ENV: "test" };
      const fg = (event: string) => new Promise<void>((resolve) => {
        const p = spawn(node, [out, "hook", event], { env, stdio: ["pipe", "ignore", "ignore"] });
        p.stdin.end(JSON.stringify({ session_id: "hanging", cwd, message: "Claude needs your permission to use Bash" }));
        p.on("exit", () => resolve());
      });
      let most = 0;
      let samples = 0;
      const sampler = setInterval(() => { most = Math.max(most, waitArgs(out).length); samples++; }, 100);
      try {
        await fg("claude-notification");
        for (let i = 0; i < 50; i++) await fg("claude-post-tool");
        // the runner gives up after the request timeout (8 s); keep sampling until then
        for (let i = 0; i < 120 && waitArgs(out).length; i++) await new Promise((r) => setTimeout(r, 100));
      } finally {
        clearInterval(sampler);
      }
      expect(samples).toBeGreaterThan(20);
      expect(most).toBe(1);
    } finally {
      await px.stop();
      s.stop();
      await reapChildren(5_000);
    }
  }, 60_000);

  test("a Notification during the backoff starts ONE runner that sleeps until the backoff ends and then sends it, with no further hook", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      mkdirSync(join(home, "projects", "blog"), { recursive: true });
      const offline = { HOME: home, SIISWELL_URL: "http://127.0.0.1:9", SIISWELL_TOKEN: s.client };
      const online = { ...offline, SIISWELL_URL: s.url };
      const T0 = Date.parse("2027-07-01T10:00:00Z");
      const input = (msg: string) => JSON.stringify({ session_id: "backoff-notify", cwd: join(home, "projects", "blog"), message: msg });
      const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const fg = (event: string, ms: number, env: Record<string, string>) => cli(["hook", event], env, { input: input("Claude needs your permission to use Bash"), now: () => T0 + ms, spawnBackground: (args, e) => { spawned.push({ args, env: e }); } });
      // a Notification starts a run that fails: the session backs off for 30 s
      await fg("claude-notification", 0, offline);
      // ... and that runner is killed while it sits out the backoff (its marker is then a dead process's: removed here)
      const first = await cli(spawned[0]!.args.concat(["--json"]), { ...offline, SIISWELL_HOOK_INPUT: spawned[0]!.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + 1_000, sleep: async () => { throw new Error("SIGKILL"); } });
      expect(JSON.parse(first.out).action).toBe("skipped");
      const dir = join(home, ".local", "state", "siiswell");
      for (const n of require("node:fs").readdirSync(dir) as string[]) if (n.endsWith(".runner") || n.endsWith(".lock")) require("node:fs").unlinkSync(join(dir, n));
      // 10 s into the backoff, a new Notification: ONE runner is started (a second one is not)
      await fg("claude-notification", 11_000, offline);
      await fg("claude-notification", 11_500, offline);
      expect(spawned.length).toBe(2);
      // the runner (now online) sleeps the rest of the backoff, then sends: no other hook is needed
      const sleeps: number[] = [];
      const r = await cli(spawned[1]!.args.concat(["--json"]), { ...online, SIISWELL_HOOK_INPUT: spawned[1]!.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + 11_000, sleep: async (ms) => { sleeps.push(ms); } });
      expect(sleeps.reduce((a, b) => a + b, 0)).toBe(20_000); // the backoff ended at T0 + 31 s
      expect(JSON.parse(r.out).action).toBe("reported");
      expect((s.t.db.sqlite.query("SELECT state FROM tasks WHERE origin = 'mcp'").all() as Array<{ state: string }>)).toEqual([{ state: "blocked" }]);
    } finally {
      s.stop();
    }
  });
});

describe("marker takeover and a failed spawn", () => {
  test("claimRunner: a live owner keeps the slot; a dead pid or a reused pid (other start time) is taken over at once, leaving no temp files", async () => {
    const { claimRunner, procStart } = await import("../cli/src/hooks");
    const { writeFileSync, readdirSync } = await import("node:fs");
    if (process.platform !== "linux") return;
    const dir = join(scratchHome(), "st");
    const sid = "d".repeat(24);
    const now = Date.now();
    const marker = join(dir, `hook-${sid}.runner`);
    expect(claimRunner(dir, sid, now)).toBe(true); // this (live) process
    expect(claimRunner(dir, sid, now + 1_000)).toBe(false);
    const dead = Bun.spawnSync(["true"]).pid; // exited and reaped
    writeFileSync(marker, JSON.stringify({ pid: dead, start: "1", at: now }));
    expect(claimRunner(dir, sid, now + 1_000)).toBe(true);
    writeFileSync(marker, JSON.stringify({ pid: process.pid, start: String(Number(procStart(process.pid)) + 1), at: now })); // reused pid
    expect(claimRunner(dir, sid, now + 1_000)).toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf8")).start).toBe(procStart(process.pid));
    expect(readdirSync(dir).filter((n) => /\.(tmp|gone)$/.test(n))).toEqual([]);
  });

  test("the background run cannot be started: the foreground frees the slot and drains once itself (bounded)", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      mkdirSync(join(home, "projects", "blog"), { recursive: true });
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const t0 = Date.now();
      await cli(["hook", "claude-notification"], env, { input: JSON.stringify({ session_id: "no-spawn", cwd: join(home, "projects", "blog"), message: "Claude needs your permission" }), spawnBackground: () => false });
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect((s.t.db.sqlite.query("SELECT state FROM tasks WHERE origin = 'mcp'").all() as Array<{ state: string }>)).toEqual([{ state: "blocked" }]);
      const left = require("node:fs").readdirSync(join(home, ".local", "state", "siiswell")) as string[];
      expect(left.filter((n) => n.includes(".ev.") || n.endsWith(".runner") || n.endsWith(".lock"))).toEqual([]);
    } finally {
      s.stop();
    }
  });
});

describe("the background run's environment and a hanging inline drain", () => {
  test("the runner gets a minimal env: no API keys, but the siiswell, proxy and CA variables", async () => {
    const spawned: Array<Record<string, string | undefined>> = [];
    const home = scratchHome();
    const env = {
      HOME: home, PATH: "/usr/bin", SIISWELL_URL: "http://127.0.0.1:9", SIISWELL_TOKEN: `oct_${"a".repeat(43)}`, ORCH_DASH_PROJECT: "p",
      HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      ANTHROPIC_API_KEY: "sk-ant-SECRET", OPENAI_API_KEY: "sk-SECRET", AWS_SECRET_ACCESS_KEY: "SECRET", GITHUB_TOKEN: "SECRET",
    };
    await cli(["hook", "claude-notification"], env, { input: JSON.stringify({ session_id: "env-check", cwd: "/w", message: "Claude needs your permission" }), spawnBackground: (_a, e) => { spawned.push(e); } });
    expect(spawned.length).toBe(1);
    const e = spawned[0]!;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]) expect(e[k]).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(e).toMatchObject({ HOME: home, PATH: "/usr/bin", SIISWELL_URL: "http://127.0.0.1:9", ORCH_DASH_PROJECT: "p", HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/etc/ca.pem" });
    expect(typeof e.SIISWELL_HOOK_INPUT).toBe("string");
  });

  test("spawn failed and the dashboard hangs: the foreground still returns in under 3 s, aborting its request and freeing the lock", async () => {
    let aborted = 0;
    const held: Array<() => void> = [];
    const hang = Bun.serve({ port: 0, fetch: (req) => new Promise<Response>((resolve) => {
      req.signal.addEventListener("abort", () => aborted++);
      held.push(() => resolve(new Response("stopped", { status: 503 })));
    }) });
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: `http://127.0.0.1:${hang.port}`, SIISWELL_TOKEN: `oct_${"a".repeat(43)}` };
      const t0 = Date.now();
      await cli(["hook", "claude-notification"], env, { input: JSON.stringify({ session_id: "hang-inline", cwd: "/w", message: "Claude needs your permission" }), spawnBackground: () => false });
      expect(Date.now() - t0).toBeLessThan(3_000);
      await new Promise((r) => setTimeout(r, 100));
      expect(aborted).toBe(1);
      const left = require("node:fs").readdirSync(join(home, ".local", "state", "siiswell")) as string[];
      expect(left.filter((n) => n.endsWith(".lock") || n.endsWith(".runner"))).toEqual([]);
      expect(left.filter((n) => n.includes(".ev.")).length).toBe(1); // the Notification stays queued for the next run
    } finally {
      for (const release of held.splice(0)) release(); // settle before the server goes
      hang.stop(true);
    }
  });
});
