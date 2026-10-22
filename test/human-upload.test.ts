/** Human counts reach the dashboard without any permission prompt (bypass mode): prompts only, the 10-minute cadence, backoff. */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_UPLOAD_EVERY_MS } from "../cli/src/human";
import { cli, scratchHome, startServer } from "./cli-helpers";

const MIN = 60_000;

/** A session where the operator only types prompts (no Notification ever): foregrounds with a captured spawn. */
function bypass(env: Record<string, string>, T0: number) {
  const input = JSON.stringify({ session_id: "bypass", cwd: "/w/p" });
  const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  const fg = (ev: string, ms: number) => cli(["hook", ev], env, { input, now: () => T0 + ms, spawnBackground: (a, e) => { spawned.push({ args: a, env: e }); } });
  const run = (i: number, ms: number, e = env) => cli(spawned[i]!.args.concat(["--json"]), { ...e, SIISWELL_HOOK_INPUT: spawned[i]!.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + ms });
  return { fg, run, spawned };
}

describe("human counts are uploaded with prompts only (no Notification, no hook task)", () => {
  test("the first prompt starts a run that uploads; the next prompts start nothing until 10 minutes have passed", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const T0 = Date.now() - 30 * MIN;
      const b = bypass(env, T0);
      await b.fg("claude-prompt", 0); // logged, then due (never uploaded): ONE run
      expect(b.spawned.length).toBe(1);
      await b.fg("claude-prompt", 1000); // a live runner holds the slot: nothing more
      await b.fg("claude-post-tool", 2000);
      expect(b.spawned.length).toBe(1);
      expect(JSON.parse((await b.run(0, 3000)).out).action).toBe("nothing");
      expect(s.seen.filter((x) => x.path === "/api/ingest/human").length).toBe(1);
      expect((s.t.db.sqlite.query("SELECT SUM(prompts) AS p FROM human_hourly").get() as { p: number }).p).toBe(2);
      // uploaded just now: prompts during the next 10 minutes start no run at all
      for (let i = 0; i < 5; i++) await b.fg("claude-prompt", 4000 + i * MIN);
      expect(b.spawned.length).toBe(1);
      // 10 minutes later: due again
      await b.fg("claude-prompt", 3000 + HUMAN_UPLOAD_EVERY_MS + 1000);
      expect(b.spawned.length).toBe(2);
      // a Stop also triggers a due upload (here: not due, a run for the Stop itself as before)
      expect(HUMAN_UPLOAD_EVERY_MS).toBe(10 * MIN);
    } finally {
      s.stop();
    }
  });

  test("offline: the failed upload backs off on its OWN (no session backoff); the next run only after its wait", async () => {
    const home = scratchHome();
    const env = { HOME: home, SIISWELL_URL: "http://127.0.0.1:9", SIISWELL_TOKEN: `oct_${"a".repeat(43)}` };
    const T0 = Date.now() - 60 * MIN;
    const b = bypass(env, T0);
    await b.fg("claude-prompt", 0);
    expect(b.spawned.length).toBe(1);
    await b.run(0, 1000);
    const dir = join(home, ".local", "state", "siiswell");
    expect(readdirSync(dir).some((n) => n.endsWith(".backoff"))).toBe(false); // the task hooks are not held up
    await b.fg("claude-prompt", 1000 + 5 * MIN); // the human backoff (10 min after the 1st failure): nothing
    expect(b.spawned.length).toBe(1);
    await b.fg("claude-prompt", 1000 + 11 * MIN);
    expect(b.spawned.length).toBe(2);
  });

  test("a Stop with an upload due starts the run that uploads, even without a hook task", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const T0 = Date.now() - 30 * MIN;
      const b = bypass(env, T0);
      // a prompt recorded while a runner held the slot (simulated): no run from it
      await b.fg("claude-prompt", 0);
      b.spawned.length = 0;
      const { rmSync } = await import("node:fs");
      for (const n of readdirSync(join(home, ".local", "state", "siiswell"))) if (n.endsWith(".runner")) rmSync(join(home, ".local", "state", "siiswell", n));
      await b.fg("claude-stop", 5000);
      expect(b.spawned.length).toBe(1);
      expect(JSON.parse((await b.run(0, 6000)).out).action).toBe("nothing");
      expect(s.seen.filter((x) => x.path === "/api/ingest/human").length).toBe(1);
    } finally {
      s.stop();
    }
  });
});

import { HUMAN_BACKOFF_MS, humanUploadState, recordHuman, uploadHumanIfDue } from "../cli/src/human";
import { loadConfig } from "../cli/src/config";

describe("the human upload's own backoff and its atomic claim", () => {
  const setup = () => {
    const home = scratchHome();
    const cfg = loadConfig({ HOME: home, SIISWELL_URL: "https://dash.test", SIISWELL_TOKEN: `oct_${"a".repeat(43)}` }, {});
    return { home, cfg, dir: cfg.stateDir };
  };
  const answer = (status: number) => (async () => new Response("{}", { status })) as never;

  test("a 429 / 400 / 503 never backs the session off; a later PostToolUse still unblocks the permission prompt", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const T0 = Date.now() - 30 * MIN;
      const input = JSON.stringify({ session_id: "perm", cwd: "/w/p", message: "Claude needs your permission to use Bash" });
      const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const fg = (ev: string, ms: number) => cli(["hook", ev], env, { input, now: () => T0 + ms, spawnBackground: (a, e) => { spawned.push({ args: a, env: e }); } });
      // the human endpoint answers 429 / 400 / 503; everything else goes to the server
      for (const status of [429, 400, 503]) {
        const f = (async (url: string, init: RequestInit) => (String(url).endsWith("/api/ingest/human") ? new Response("{}", { status }) : fetch(url, init))) as typeof globalThis.fetch;
        const at = status === 429 ? 0 : status === 400 ? 20 * MIN : 40 * MIN;
        // make the upload due for each round
        const { rmSync } = await import("node:fs");
        rmSync(join(home, ".local", "state", "siiswell", "human-upload.json"), { force: true });
        await fg("claude-notification", at);
        const i = spawned.length - 1;
        await cli(spawned[i]!.args.concat(["--json"]), { ...env, SIISWELL_HOOK_INPUT: spawned[i]!.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + at + 1000, fetch: f as never });
        expect(readdirSync(join(home, ".local", "state", "siiswell")).some((n) => n.endsWith(".backoff"))).toBe(false);
        // the permission was granted: the PostToolUse unblocks at once
        await fg("claude-post-tool", at + 2000);
        const j = spawned.length - 1;
        expect(JSON.parse((await cli(spawned[j]!.args.concat(["--json"]), { ...env, SIISWELL_HOOK_INPUT: spawned[j]!.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + at + 3000, fetch: f as never })).out).action).toBe("updated");
      }
      expect((s.t.db.sqlite.query("SELECT state FROM tasks WHERE origin = 'mcp'").get() as { state: string }).state).toBe("running");
    } finally {
      s.stop();
    }
  });

  test("the backoff grows 10 -> 20 -> 40 -> 60 (capped) minutes and resets after a success", async () => {
    const { cfg, dir } = setup();
    const T = Date.now();
    recordHuman(dir, "a".repeat(24), "prompt", T - MIN);
    let now = T;
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await uploadHumanIfDue(cfg, now, answer(503))).toBe("failed");
      const st = humanUploadState(dir);
      waits.push(st.next - now);
      expect(await uploadHumanIfDue(cfg, st.next - 1, answer(200))).toBe("not-due"); // not before its time
      now = st.next;
    }
    expect(waits).toEqual([HUMAN_BACKOFF_MS[0], HUMAN_BACKOFF_MS[1], HUMAN_BACKOFF_MS[2], HUMAN_BACKOFF_MS[3], HUMAN_BACKOFF_MS[3]]);
    expect(waits.map((w) => w / MIN)).toEqual([10, 20, 40, 60, 60]);
    expect(await uploadHumanIfDue(cfg, now, answer(200))).toBe("sent");
    expect(humanUploadState(dir)).toEqual({ next: now + 10 * MIN, n: 0 }); // reset
  });

  test("the claim is atomic: two runs at the same moment, one upload", async () => {
    const { cfg, dir } = setup();
    const T = Date.now();
    recordHuman(dir, "b".repeat(24), "prompt", T - MIN);
    let sends = 0;
    const slow = (async () => { sends++; await new Promise((r) => setTimeout(r, 50)); return new Response("{}", { status: 200 }); }) as never;
    const r = await Promise.all([uploadHumanIfDue(cfg, T, slow), uploadHumanIfDue(cfg, T, slow), uploadHumanIfDue(cfg, T, slow)]);
    expect(sends).toBe(1);
    expect(r.filter((x) => x === "sent").length).toBe(1);
    expect(readdirSync(dir).filter((n) => n.endsWith(".claim"))).toEqual([]); // released once the outcome is recorded
  });
});

describe("the claim across processes", () => {
  test("six processes racing for the same upload window: exactly one upload", async () => {
    let hits = 0;
    const srv = Bun.serve({ port: 0, fetch: async () => { hits++; await new Promise((r) => setTimeout(r, 100)); return new Response("{}", { status: 200 }); } });
    try {
      const home = scratchHome();
      const T = Date.now();
      const { loadConfig: lc } = await import("../cli/src/config");
      const { recordHuman: rh } = await import("../cli/src/human");
      const dir = lc({ HOME: home }, {}).stateDir;
      rh(dir, "c".repeat(24), "prompt", T - MIN);
      const code = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "..", "cli", "src", "config.ts"))});
        const { uploadHumanIfDue } = await import(${JSON.stringify(join(import.meta.dir, "..", "cli", "src", "human.ts"))});
        const cfg = loadConfig({ HOME: ${JSON.stringify(home)}, SIISWELL_URL: "http://127.0.0.1:${srv.port}", SIISWELL_TOKEN: "oct_${"a".repeat(43)}" }, {});
        console.log(await uploadHumanIfDue(cfg, ${T}));`;
      const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", code], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, stdout: "pipe" }));
      const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
      expect(hits).toBe(1);
      expect(outs.filter((o) => o === "sent").length).toBe(1);
    } finally {
      srv.stop(true);
    }
  }, 30_000);
});

import { inAgentPane } from "../cli/src/agentpane";

describe("A. agent workspaces are excluded", () => {
  test("a worktree of a project marked .siiswell-agents records and reports nothing; the operator's own sessions do", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const root = join(scratchHome(), "projects");
    mkdirSync(join(root, "general"), { recursive: true });
    writeFileSync(join(root, "general", ".siiswell-agents"), "");
    const agentCwd = join(root, "general", "worktrees", "general-claude", "src");
    const operatorCwd = join(root, "general");
    mkdirSync(agentCwd, { recursive: true });
    mkdirSync(join(root, "plain", "worktrees", "x"), { recursive: true });
    expect(inAgentPane(agentCwd)).toBe(true);
    expect([inAgentPane(operatorCwd), inAgentPane(join(root, "plain", "worktrees", "x")), inAgentPane(undefined)]).toEqual([false, false, false]);
    // SIISWELL_AGENT=1 (set by whatever starts the agent) marks any directory; other values do not
    expect([inAgentPane(operatorCwd, { SIISWELL_AGENT: "1" }), inAgentPane(undefined, { SIISWELL_AGENT: "true" }), inAgentPane(operatorCwd, { SIISWELL_AGENT: "0" }), inAgentPane(operatorCwd, { SIISWELL_AGENT: "" })]).toEqual([true, true, false, false]);
    const home = scratchHome();
    const env = { HOME: home, SIISWELL_URL: "https://dash.test", SIISWELL_TOKEN: `oct_${"a".repeat(43)}` };
    const spawned: string[][] = [];
    const fire = (cwd: string, ev: string, extra: Record<string, unknown> = {}) => cli(["hook", ev], env, { input: JSON.stringify({ session_id: `s-${cwd.length}`, cwd, ...extra }), spawnBackground: (a) => { spawned.push(a); } });
    await fire(agentCwd, "claude-notification", { message: "Claude needs your permission to use Bash" });
    await fire(agentCwd, "claude-prompt");
    const dir = join(home, ".local", "state", "siiswell");
    expect(spawned.length).toBe(0);
    expect(existsSync(join(dir, "human.log"))).toBe(false);
    await fire(operatorCwd, "claude-prompt");
    expect(existsSync(join(dir, "human.log"))).toBe(true);
  });
});

describe("E. doctor shows the human recording state", () => {
  test("hook installed or not, the log's events, the last upload, the human backoff", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      let out = (await cli(["doctor"], env)).out;
      expect(out).toContain("human recording: Claude Code prompt hook not installed");
      expect(out).toContain("human recording: 0 event(s) in the last 72 h");
      expect(out).toContain("human upload: never uploaded yet");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "node siiswell.mjs hook claude-prompt" }] }] } }));
      const dir = join(home, ".local", "state", "siiswell");
      recordHuman(dir, "d".repeat(24), "prompt", Date.now() - MIN);
      const cfg = loadConfig({ HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client }, {});
      await uploadHumanIfDue(cfg, Date.now(), (async () => new Response("{}", { status: 503 })) as never);
      out = (await cli(["doctor"], env)).out;
      expect(out).toContain("human recording: Claude Code prompt hook installed");
      expect(out).toContain("human recording: 1 event(s) in the last 72 h, last ");
      expect(out).toMatch(/human upload: the last 1 attempt\(s\) failed; next try after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    } finally {
      s.stop();
    }
  });
});
