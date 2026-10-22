/**
 * The hard privacy rule: siiswell records only THAT the user interacted (event type, time, counts, latency), never what was
 * typed or what the agent did. A unique marker in the prompt, the tool input, the tool output and the notification text goes
 * through every hook event, the background runs and the human upload: it must appear in no file of the state dir and in no
 * request body.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cli, scratchHome, startServer } from "./cli-helpers";

const MARK = `PRIVACY-MARKER-${Math.random().toString(36).slice(2)}`;

function filesUnder(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}

describe("no prompt content, tool arguments or command text is ever stored or sent", () => {
  test("every hook event + background runs + the human upload: the marker is in no state file and no request", async () => {
    const s = await startServer();
    try {
      const home = scratchHome();
      const env = { HOME: home, SIISWELL_URL: s.url, SIISWELL_TOKEN: s.client };
      const bodies: string[] = [];
      const spy = (async (url: string, init: RequestInit) => { bodies.push(String(init.body ?? "")); return fetch(url, init); }) as typeof globalThis.fetch;
      const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const T0 = Date.now() - 20 * 60_000;
      let t = 0;
      const base = { session_id: `sess-${MARK}`, cwd: `/w/${MARK}/p`, transcript_path: `/x/${MARK}.jsonl` };
      const fire = (event: string, extra: Record<string, unknown>) =>
        cli(["hook", event], env, { input: JSON.stringify({ ...base, ...extra }), now: () => T0 + (t += 1000), spawnBackground: (a, e) => { spawned.push({ args: a, env: e }); } });
      await fire("claude-prompt", { prompt: `please delete ${MARK}`, hook_event_name: "UserPromptSubmit" });
      await fire("claude-notification", { message: `Claude needs your permission to use Bash: rm -rf ${MARK}`, hook_event_name: "Notification" });
      await fire("claude-post-tool", { tool_name: "Bash", tool_input: { command: `rm -rf /${MARK}` }, tool_response: { stdout: `${MARK} removed` } });
      await fire("claude-prompt", { prompt: `and now ${MARK} again` });
      await fire("claude-stop", { last_assistant_message: `done with ${MARK}` });
      await fire("claude-session-end", { reason: `exit ${MARK}` });
      await cli(["hook", "codex-notify", JSON.stringify({ type: "agent-turn-complete", "thread-id": MARK, cwd: `/w/${MARK}`, "last-assistant-message": MARK, "input-messages": [MARK] })], env, { spawnBackground: (a, e) => { spawned.push({ args: a, env: e }); } });
      await cli(["hook", "codex-notify", JSON.stringify({ type: "agent-turn-complete", "thread-id": MARK, cwd: `/w/${MARK}`, "last-assistant-message": MARK, "input-messages": [MARK] })], env, { fetch: spy as never });
      // the environment each background run got (it may sleep for minutes): no path, no text
      for (const x of spawned) expect(JSON.stringify(x.env).includes(MARK)).toBe(false);
      // the queue files, the session state and the human log as the foregrounds left them (before any run drains them)
      const queued = filesUnder(join(home, ".local", "state", "siiswell"));
      expect(queued.some((f) => f.includes(".ev."))).toBe(true);
      for (const f of queued) expect([f, readFileSync(f, "utf8").includes(MARK)]).toEqual([f, false]);
      // the background runs the foregrounds started (they send the task updates and the human upload)
      for (const x of spawned) await cli(x.args.concat(["--json"]), { ...env, SIISWELL_HOOK_INPUT: x.env.SIISWELL_HOOK_INPUT }, { now: () => T0 + (t += 1000), fetch: spy as never });
      expect(spawned.length).toBeGreaterThan(0);
      expect(s.seen.some((x) => x.path === "/api/ingest/human")).toBe(true); // the upload really ran
      // no request body and nothing the server received
      for (const b of bodies) expect(b.includes(MARK)).toBe(false);
      for (const x of s.seen) expect([x.path, x.body.includes(MARK)]).toEqual([x.path, false]);
      // no file under the state dir (or the config dir)
      const files = [...filesUnder(join(home, ".local", "state", "siiswell")), ...filesUnder(join(home, ".config", "siiswell"))];
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect([f, readFileSync(f, "utf8").includes(MARK)]).toEqual([f, false]);
      // and nothing stored in the dashboard's database
      const dump = JSON.stringify(s.t.db.sqlite.query("SELECT * FROM tasks").all()) + JSON.stringify(s.t.db.sqlite.query("SELECT * FROM events").all()) + JSON.stringify(s.t.db.sqlite.query("SELECT * FROM human_hourly").all());
      expect(dump.includes(MARK)).toBe(false);
    } finally {
      s.stop();
    }
  });

  test("permissions suggest only READS transcripts: it writes no file and sends nothing", async () => {
    const home = scratchHome();
    const dir = join(home, ".claude", "projects", "-w");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", name: "Bash", input: { command: `npm test ${MARK}` } }] } }) + "\n");
    const before = filesUnder(home).sort();
    let sent = 0;
    const r = await cli(["permissions", "suggest", "--json"], { HOME: home }, { fetch: (async () => { sent++; return new Response("{}"); }) as never });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(MARK);
    expect(sent).toBe(0);
    expect(filesUnder(home).sort()).toEqual(before); // nothing written, nothing cached
  });
});
