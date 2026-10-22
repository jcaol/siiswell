import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCli } from "../cli/build";
import { scratchHome, startServer, type TestServer } from "./cli-helpers";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "setup-client.sh");

/** A fake HOME with existing app configs (other servers and keys that must survive), and a stub `claude` binary that logs its args. */
function fixture() {
  const home = scratchHome();
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${home}/claude-calls.log"\n`, { mode: 0o755 });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.siiswell]\ncommand = "old"\n\n[profiles.fast]\nmodel = "x"\n', { mode: 0o644 });
  mkdirSync(join(home, ".config", "Claude"), { recursive: true });
  writeFileSync(join(home, ".config", "Claude", "claude_desktop_config.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ selectedAuthType: "oauth", mcpServers: { keep: { httpUrl: "https://k.example" } } }));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "light", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] }], Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo mine" }] }] } }));
  return { home, bin };
}

async function runSetup(home: string, bin: string, answers: string[], args: string[] = [], extraEnv: Record<string, string> = {}) {
  const node = Bun.which("node")!;
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: ROOT,
    // the agent-workspace guard looks at <root>/*/.siiswell-agents: a root of the test's own (this host may have some)
    env: { HOME: home, PATH: `${bin}:${dirname(node)}:/usr/bin:/bin`, SIISWELL_SETUP_NO_ACTIVATE: "1", LANG: "C", SIISWELL_SETUP_OS: "Linux", SIISWELL_SETUP_PROJECTS_ROOT: join(home, "no-projects"), ...extraEnv },
    stdin: new Blob([answers.join("\n") + "\n"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

function allFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) allFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe("scripts/setup-client.sh (non-interactive, fake HOME)", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
    await buildCli(); // cli/dist/siiswell.mjs (untracked build output)
  });
  afterAll(() => s.stop());

  const answers = (codexReplace = "y", hooks = "y", keep = "") => [
    s.url, // dashboard URL
    "y", "y", "y", "y", "y", "y", // claude-code, codex, claude-desktop, agy, gemini, usage
    "laptop-1", // machine label
    keep, // project names shown by name (empty = none: hashed usage, no inferred task project)
    s.client, s.client, s.client, s.client, s.client, // client tokens in app order
    s.hostName, s.host, // usage: host label + host token
    codexReplace, // replace the existing [mcp_servers.siiswell]
    hooks, // Claude Code hooks
    hooks, // Codex notify hook
    "y", // reporting rule
    "y", // usage schedule
  ];
  /** A re-run: every app config already holds its token, so each "Keep the existing token? [Y/n]" is answered with Enter. */
  const rerun = (codexReplace = "y", hooks = "y") => answers(codexReplace, hooks).map((a) => (a === s.client || a === s.host ? "" : a));

  test("project names: none by default (nothing written: a new install hashes); listed names go into every config, kept on a re-run", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    expect((await runSetup(home, bin, answers("y", "y", "web-shop api"))).code).toBe(0);
    const cfgDir = join(home, ".config", "siiswell");
    const usage = { projectNames: "hashed", keep: ["web-shop", "api"] };
    expect(JSON.parse(readFileSync(join(cfgDir, "usage.json"), "utf8"))).toEqual({ url: s.url, hostToken: s.host, host: s.hostName, usage });
    expect(JSON.parse(readFileSync(join(cfgDir, "codex.json"), "utf8"))).toEqual({ url: s.url, token: s.client, machine: "laptop-1", usage });
    expect((await runSetup(home, bin, rerun())).code).toBe(0); // Enter keeps the listed names
    expect(JSON.parse(readFileSync(join(cfgDir, "codex.json"), "utf8")).usage).toEqual(usage);
  }, 30_000); // runs the setup twice: the default 5 s timeout was the old "1 error"

  test("configures every app, keeps the token out of app configs and output, and is idempotent", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    const r = await runSetup(home, bin, answers());
    expect(r.code).toBe(0);
    const output = r.out + r.err;
    expect(output).not.toContain(s.client);
    expect(output).not.toContain(s.host);
    for (const app of ["claude-code", "codex", "claude-desktop", "agy", "gemini", "usage"]) expect(r.out).toContain(`doctor ${app}: ok`);

    // private configs: dir 0700, files 0600, the only place a token is written
    const cfgDir = join(home, ".config", "siiswell");
    expect(statSync(cfgDir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(cfgDir)) expect(statSync(join(cfgDir, f)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(cfgDir, "usage.json"), "utf8"))).toEqual({ url: s.url, hostToken: s.host, host: s.hostName });
    expect(JSON.parse(readFileSync(join(cfgDir, "codex.json"), "utf8"))).toEqual({ url: s.url, token: s.client, machine: "laptop-1" });
    const mjs = join(home, ".local", "lib", "siiswell", "siiswell.mjs");
    expect(existsSync(mjs)).toBe(true);

    // merged JSON: our stdio entry added, everything else kept
    const desktop = JSON.parse(readFileSync(join(home, ".config", "Claude", "claude_desktop_config.json"), "utf8"));
    expect(desktop.theme).toBe("dark");
    expect(desktop.mcpServers.other).toEqual({ command: "x" });
    expect(desktop.mcpServers.siiswell).toEqual({ command: Bun.which("node"), args: [mjs, "mcp"], env: { SIISWELL_CONFIG: join(cfgDir, "claude-desktop.json") } });
    const gemini = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    expect(gemini.selectedAuthType).toBe("oauth");
    expect(Object.keys(gemini.mcpServers).sort()).toEqual(["keep", "siiswell"]);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "antigravity-cli", "mcp_config.json"), "utf8")).mcpServers.siiswell.env.SIISWELL_CONFIG).toBe(join(cfgDir, "agy.json"));

    // TOML: exactly one siiswell block (the old one replaced), other tables kept, mode kept
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml.match(/^\[mcp_servers\.siiswell\]$/gm)?.length).toBe(1);
    expect(toml).not.toContain('command = "old"');
    for (const keep of ['model = "gpt-5.5"', "[mcp_servers.other]", "[profiles.fast]"]) expect(toml).toContain(keep);
    expect(toml).toContain(`env = { SIISWELL_CONFIG = "${join(cfgDir, "codex.json")}" }`);
    expect(statSync(join(home, ".codex", "config.toml")).mode & 0o777).toBe(0o644);

    // Claude Code: remove + add, stdio, config by path
    const calls = readFileSync(join(home, "claude-calls.log"), "utf8");
    expect(calls).toContain("mcp remove --scope user siiswell");
    // the server name before -e (-e takes several values and would swallow it)
    expect(calls).toContain(`mcp add --scope user siiswell -e SIISWELL_CONFIG=${join(cfgDir, "claude-code.json")} -- ${Bun.which("node")} ${mjs} mcp`);

    // hooks: Claude Code Notification + Stop run only the CLI, other settings kept; Codex notify at the top level
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.theme).toBe("light");
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] }]);
    const cmdOf = (ev: string) => settings.hooks[ev].flatMap((m: { hooks: Array<{ command: string; timeout?: number }> }) => m.hooks).filter((h: { command: string }) => h.command.includes("siiswell"));
    expect(cmdOf("Notification")).toEqual([{ type: "command", command: `'${Bun.which("node")}' '${mjs}' hook claude-notification --config '${join(cfgDir, "claude-code.json")}'`, timeout: 5 }]);
    expect(cmdOf("Stop").length).toBe(1);
    // the unblock / end hooks: PostToolUse and UserPromptSubmit put a BLOCKED hook task back to IN_PROGRESS, SessionEnd closes it
    for (const [ev, sub] of [["PostToolUse", "claude-post-tool"], ["UserPromptSubmit", "claude-prompt"], ["SessionEnd", "claude-session-end"]]) {
      expect(cmdOf(ev)).toEqual([{ type: "command", command: `'${Bun.which("node")}' '${mjs}' hook ${sub} --config '${join(cfgDir, "claude-code.json")}'`, timeout: 5 }]);
    }
    expect(settings.hooks.Stop.some((m: { hooks: Array<{ command: string }> }) => m.hooks.some((h) => h.command === "echo mine"))).toBe(true);
    expect(toml.split("\n")[0]).toBe(`notify = ["${Bun.which("node")}", "${mjs}", "hook", "codex-notify", "--config", "${join(cfgDir, "codex.json")}"]`);

    // rules and schedule
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("siiswell MCP tools");
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).not.toContain("Ignore this rule inside agent workspaces"); // no agent workspaces here
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toContain("siiswell MCP tools");
    const unit = readFileSync(join(home, ".config", "systemd", "user", "siiswell-usage.service"), "utf8");
    expect(unit).toContain(`Environment=SIISWELL_CONFIG=${join(cfgDir, "usage.json")}`);
    expect(existsSync(join(home, ".config", "systemd", "user", "siiswell-usage.timer"))).toBe(true);

    // no token anywhere outside ~/.config/siiswell (app configs, rules, units, backups, logs)
    for (const f of allFiles(home)) {
      if (f.startsWith(cfgDir) || f.endsWith(".mjs")) continue;
      const text = readFileSync(f, "utf8");
      expect({ f, client: text.includes(s.client), host: text.includes(s.host) }).toEqual({ f, client: false, host: false });
    }

    // re-run: same result, still one TOML block, the rule appended once, backups made; the tokens are kept (not asked again)
    const again = await runSetup(home, bin, rerun());
    expect(again.code).toBe(0);
    expect(again.err).toContain("Keep the existing token? [Y/n]");
    expect(again.err).not.toContain("Client token for");
    expect(again.out + again.err).not.toContain(s.client);
    expect(JSON.parse(readFileSync(join(cfgDir, "codex.json"), "utf8"))).toEqual({ url: s.url, token: s.client, machine: "laptop-1" });
    expect(JSON.parse(readFileSync(join(cfgDir, "usage.json"), "utf8"))).toEqual({ url: s.url, hostToken: s.host, host: s.hostName });
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8").match(/^\[mcp_servers\.siiswell\]$/gm)?.length).toBe(1);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8").match(/^notify = /gm)?.length).toBe(1);
    const settings2 = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    for (const ev of ["Notification", "Stop", "PostToolUse", "UserPromptSubmit", "SessionEnd"]) expect(JSON.stringify(settings2.hooks[ev]).split("siiswell.mjs").length - 1).toBe(1);
    expect(readdirSync(join(home, ".claude")).some((f) => f.startsWith("settings.json.bak-siiswell-"))).toBe(true);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8").split("siiswell MCP tools").length).toBe(2);
    expect(readdirSync(join(home, ".codex")).some((f) => f.startsWith("config.toml.bak-siiswell-"))).toBe(true);

    // the rule block is replaced with the current text (marked block or the older unmarked paragraph), with a backup; idempotent
    const md = join(home, ".claude", "CLAUDE.md");
    const oldRule = "For any task that will take longer than about 10 minutes, use the `siiswell` MCP tools (siiswell MCP tools): call\n`report_task` when you start; old wording,\nsecrets, credentials, tokens or file contents in either.";
    writeFileSync(md, `# mine\nkeep above\n\n${oldRule}\n\nkeep below\n`);
    const before = readdirSync(join(home, ".claude")).filter((f) => f.startsWith("CLAUDE.md.bak-siiswell-")).length;
    const r1 = await runSetup(home, bin, rerun());
    expect(r1.code).toBe(0);
    const t1 = readFileSync(md, "utf8");
    expect(t1).toContain("keep above");
    expect(t1).toContain("keep below");
    expect(t1).not.toContain("old wording");
    expect(t1).toContain("before your final reply");
    expect(t1.split("siiswell MCP tools").length).toBe(2);
    expect(t1.split("siiswell rule: start").length).toBe(2);
    expect(readdirSync(join(home, ".claude")).filter((f) => f.startsWith("CLAUDE.md.bak-siiswell-")).length).toBeGreaterThanOrEqual(before);
    expect(readdirSync(join(home, ".claude")).some((f) => f.startsWith("CLAUDE.md.bak-siiswell-") && readFileSync(join(home, ".claude", f), "utf8").includes("old wording"))).toBe(true);
    // a marked block with stale text is replaced between its markers
    writeFileSync(md, t1.replace("before your final reply", "OUTDATED"));
    await runSetup(home, bin, rerun());
    expect(readFileSync(md, "utf8")).toBe(t1);
    // up to date: nothing written
    const r3 = await runSetup(home, bin, rerun());
    expect(r3.out + r3.err).toContain("rule up to date");
    expect(readFileSync(md, "utf8")).toBe(t1);

    // a start marker without its end marker: nothing is written (the rest of the file would be lost)
    const broken = `${t1.split("<!-- siiswell rule: end -->")[0]}user notes after the block\n`;
    writeFileSync(md, broken);
    const r4 = await runSetup(home, bin, rerun());
    expect(r4.out + r4.err).toContain("rule block has no end marker; left unchanged");
    expect(readFileSync(md, "utf8")).toBe(broken);
    // a user's own sentence naming "siiswell MCP tools" is not the old rule: kept, the rule is appended after it
    const mine = "# notes\nI like the siiswell MCP tools (siiswell MCP tools): call them often.\nsecond line of mine\n";
    writeFileSync(md, mine);
    await runSetup(home, bin, rerun());
    const t5 = readFileSync(md, "utf8");
    expect(t5.startsWith(mine)).toBe(true);
    expect(t5).toContain("siiswell rule: start");
    // awk failing while rewriting: the file stays as it is
    const old = t5.replace("before your final reply", "OUTDATED");
    writeFileSync(md, old);
    writeFileSync(join(bin, "awk"), '#!/bin/sh\n[ -n "$RS_BLOCK" ] && exit 2\nexec /usr/bin/awk "$@"\n', { mode: 0o755 });
    const r6 = await runSetup(home, bin, rerun());
    rmSync(join(bin, "awk"));
    expect(r6.out + r6.err).toContain("left unchanged");
    expect(readFileSync(md, "utf8")).toBe(old);

    // declining the Codex replacement keeps the file as it is
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.siiswell]\ncommand = \"mine\"\n");
    await runSetup(home, bin, rerun("n", "n"));
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe("[mcp_servers.siiswell]\ncommand = \"mine\"\n");
  }, 60_000);

  test("re-run: answering n to keep asks for a new token; a failing claude mcp add shows what claude said", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    expect((await runSetup(home, bin, answers())).code).toBe(0);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$*" in *"mcp add"*) echo "error: unknown option -e near siiswell" >&2; exit 1 ;; esac\n`, { mode: 0o755 });
    // codex: n (keep?) then a new token; every other app keeps its token
    const a = rerun();
    const codexAt = a.indexOf("laptop-1") + 3; // keep names, claude-code, codex, ...
    a.splice(codexAt, 1, "n", s.client);
    const r = await runSetup(home, bin, a);
    expect(r.code).toBe(0);
    expect(r.err).toContain("Client token for codex");
    expect(r.out + r.err).toContain("claude mcp add failed");
    expect(r.out + r.err).toContain("error: unknown option -e near siiswell");
    expect(r.out + r.err).not.toContain(s.client);
  }, 60_000);

  test("--dry-run changes nothing and prints no token", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    const before = allFiles(home).map((f) => [f, readFileSync(f, "utf8")] as const);
    const r = await runSetup(home, bin, answers(), ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[dry-run] would");
    expect(r.out + r.err).not.toContain(s.client);
    expect(allFiles(home).map((f) => [f, readFileSync(f, "utf8")] as const)).toEqual(before);
  }, 60_000);

  test("refuses plain http to a remote host and a malformed token", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    expect((await runSetup(home, bin, ["http://dash.example.com"])).code).toBe(1);
    const bad = await runSetup(home, bin, [s.url, "y", "n", "n", "n", "n", "n", "mac", "sk-not-a-token"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("not a siiswell token");
    expect(bad.out + bad.err).not.toContain("sk-not-a-token");
    expect(existsSync(join(home, ".config", "siiswell", "claude-code.json"))).toBe(false);
  }, 60_000);
});

describe("setup-client.sh --reuse and the agent-workspace guard", () => {
  let s: TestServer;
  beforeAll(async () => { s = await startServer(); });
  afterAll(() => s.stop());
  const full = () => [s.url, "y", "y", "y", "y", "y", "y", "laptop-1", "", s.client, s.client, s.client, s.client, s.client, s.hostName, s.host, "y", "y", "y", "y", "y"];
  const PROMPT = /\[y\/N\]|\[Y\/n\]|token for|Dashboard URL|Machine label/;

  test("--reuse without a client setup: a clear message, exit 1, nothing asked", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    const r = await runSetup(home, bin, [], ["--reuse"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("this machine has no siiswell client setup yet — run setup-client.sh without --reuse");
    expect(r.err).not.toMatch(PROMPT);
  }, 30_000);

  test("--reuse: asks nothing, keeps the configs and tokens, re-installs MCP / hooks / rule for the configured apps, runs doctor", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    expect((await runSetup(home, bin, full())).code).toBe(0);
    const cfgDir = join(home, ".config", "siiswell");
    const before = readFileSync(join(cfgDir, "codex.json"), "utf8");
    // the hooks and the rule are gone (an app update, a hand edit): --reuse puts them back
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "light" }));
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# mine\n");
    const r = await runSetup(home, bin, [], ["--reuse"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(PROMPT);
    expect(readFileSync(join(cfgDir, "codex.json"), "utf8")).toBe(before);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.theme).toBe("light");
    expect(JSON.stringify(settings.hooks.Notification)).toContain("hook claude-notification");
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("siiswell rule: start");
    expect(readFileSync(join(home, "claude-calls.log"), "utf8")).toContain("mcp add");
    for (const app of ["claude-code", "codex", "usage"]) expect(r.out).toContain(`doctor ${app}: ok`);
    expect(r.out + r.err).not.toContain(s.client);
  }, 60_000);

  test("on macOS (SIISWELL_SETUP_OS=Darwin): Claude Desktop under ~/Library/Application Support, the usage schedule as a launchd agent", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    const lib = join(home, "Library", "Application Support", "Claude");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const r = await runSetup(home, bin, full(), [], { SIISWELL_SETUP_OS: "Darwin" });
    expect(r.code).toBe(0);
    const desk = JSON.parse(readFileSync(join(lib, "claude_desktop_config.json"), "utf8"));
    expect(desk.mcpServers.other).toEqual({ command: "x" });
    expect(desk.mcpServers.siiswell.args).toEqual([join(home, ".local", "lib", "siiswell", "siiswell.mjs"), "mcp"]);
    const plist = readFileSync(join(home, "Library", "LaunchAgents", "com.siiswell.usage.plist"), "utf8");
    expect(plist).toContain("<string>usage</string><string>push</string>");
    expect(plist).toContain(join(home, ".config", "siiswell", "usage.json"));
    expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
    expect(r.out + r.err).not.toContain(s.client);
  }, 60_000);

  test("the siiswell command: a link in ~/.local/bin to the installed CLI; a file of the user's own is left alone", async () => {
    if (!Bun.which("node")) return;
    const { readlinkSync, lstatSync } = await import("node:fs");
    const { home, bin } = fixture();
    expect((await runSetup(home, bin, full())).code).toBe(0);
    const link = join(home, ".local", "bin", "siiswell");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(home, ".local", "lib", "siiswell", "siiswell.mjs"));
    const { home: h2, bin: b2 } = fixture();
    mkdirSync(join(h2, ".local", "bin"), { recursive: true });
    writeFileSync(join(h2, ".local", "bin", "siiswell"), "#!/bin/sh\necho mine\n");
    const r = await runSetup(h2, b2, full());
    expect(r.out).toContain("exists and is not a link: left alone");
    expect(readFileSync(join(h2, ".local", "bin", "siiswell"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    // a link of the user's own (to another install) is left alone too
    const { symlinkSync } = await import("node:fs");
    const { home: h3, bin: b3 } = fixture();
    mkdirSync(join(h3, ".local", "bin"), { recursive: true });
    symlinkSync("/opt/elsewhere/siiswell", join(h3, ".local", "bin", "siiswell"));
    const r3 = await runSetup(h3, b3, full());
    expect(r3.out).toContain("points elsewhere");
    expect(readlinkSync(join(h3, ".local", "bin", "siiswell"))).toBe("/opt/elsewhere/siiswell");
  }, 120_000);

  test("--reuse never replaces a newer installed CLI (from siiswell update) with an older checkout build", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    expect((await runSetup(home, bin, full())).code).toBe(0);
    const mjs = join(home, ".local", "lib", "siiswell", "siiswell.mjs");
    const real = readFileSync(mjs, "utf8");
    // a "newer" install: reports 99.0.0, otherwise the real CLI (doctor still runs it)
    const newer = `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("99.0.0 (fffffff)"); process.exit(0); }\n${real.replace(/^#!.*\n/, "")}`;
    writeFileSync(mjs, newer);
    const r = await runSetup(home, bin, [], ["--reuse"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("keeping the installed CLI 99.0.0: this checkout's cli/dist is older");
    expect(readFileSync(mjs, "utf8")).toBe(newer);
  }, 60_000);

  test("interactive re-run: the earlier URL, machine label and apps are the defaults (Enter keeps them)", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    expect((await runSetup(home, bin, full())).code).toBe(0);
    // Enter for the URL, the six apps and the machine label; keep the tokens; then the usual answers
    const r = await runSetup(home, bin, ["", "", "", "", "", "", "", "", "", "", "", "", "", "", s.hostName, "", "y", "y", "y", "y", "y"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".config", "siiswell", "codex.json"), "utf8"))).toEqual({ url: s.url, token: s.client, machine: "laptop-1" });
    expect(r.err).toContain(`[${s.url}]`);
    expect(r.err).toContain("configured before");
  }, 60_000);

  test("with agent workspaces: a note that they are skipped by the hooks; install is the default; --reuse installs them", async () => {
    if (!Bun.which("node")) return;
    const { home, bin } = fixture();
    const root = join(home, "srv");
    mkdirSync(join(root, "proj"), { recursive: true });
    writeFileSync(join(root, "proj", ".siiswell-agents"), "");
    const env = { SIISWELL_SETUP_PROJECTS_ROOT: root };
    const answers = full();
    answers[answers.indexOf(s.host) + 2] = ""; // Enter at the Claude Code hooks question: Yes on this server
    const first = await runSetup(home, bin, answers, [], env);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Agent workspaces found (.siiswell-agents): the hooks skip them automatically");
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("Ignore this rule inside agent workspaces (<project>/worktrees/... of a project with a .siiswell-agents file, or where SIISWELL_AGENT=1)");
    expect(JSON.stringify(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks)).toContain("hook claude-prompt");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "light" }));
    const reuse = await runSetup(home, bin, [], ["--reuse"], env);
    expect(reuse.code).toBe(0);
    expect(JSON.stringify(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks)).toContain("hook claude-prompt");
    // a marker in the home folder is not a project: the hooks would not skip anything there, so setup says nothing
    const { home: h2, bin: b2 } = fixture();
    writeFileSync(join(h2, ".siiswell-agents"), "");
    const r2 = await runSetup(h2, b2, full());
    expect(r2.out).not.toContain("Agent workspaces found");
  }, 90_000);
});
