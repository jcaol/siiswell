// SPDX-License-Identifier: Apache-2.0
/**
 * @file siiswell CLI: report long-running work, heartbeat, relay MCP over stdio, and collect / upload token usage.
 * @module cli/main
 *
 * Zero runtime dependencies; runs under Node >= 18 and Bun. Built into one file (cli/dist/siiswell.mjs) by cli/build.ts.
 * `run(argv, io)` is the whole program (tests call it in-process with their own env, fetch and streams).
 */
import { taskProject } from "./taskProject";
import { humanDiagnostics, humanUploadDue, recordHuman } from "./human";
import { agentByEnv, inAgentPane } from "./agentpane";
import { applyTaskText, normalizeKind } from "./tasktext";
import { SUGGEST_DAYS, suggestPermissions } from "./permissions";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { clipText } from "../../src/shared/redact";
import { MAX_TEXT, MAX_TITLE } from "../../src/shared/schema";
import { ConfigError, PROJECT_RE, configPath, defaultProject, describe, envVar, homeOf, loadConfig, type Config, type Env } from "./config";
import { dirname, join } from "node:path";
import { HttpError, errorDetail, isAccessRedirect, postMcp, send, type FetchLike } from "./http";
import { HOOK_EVENTS, adoptRunner, isIdleNotification, releaseRunner, backoffUntil, claimRunner, parseHookInput, queueEvent, runHook, sweepStateDir, unblockWorthQueuing, type HookEvent, type HookInput } from "./hooks";
import { selfUpdate } from "./selfupdate";
import { runMcpStdio } from "./mcp-stdio";
import { acquireLock, collectUsage, ensureDir, readBank, readStatus, readUnrecognised, reattribute, validTimeZone, DEFAULT_USAGE_TZ } from "./usage/collect";
import { projectHasher, projectLabel, pushUsage } from "./usage/push";

export { CLI_VERSION } from "./build-info";
import { CLI_VERSION, CLI_VERSION_LINE } from "./build-info";

/** The answer of a write tool in an agent workspace (`siiswell mcp`; see ./agentpane). */
export const AGENT_PANE_SKIP = "skipped: agent workspace (the host integration reports this)";

export interface Io {
  env: Env;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  fetch?: FetchLike;
  now?: () => number;
  platform?: string;
  /** start `siiswell <args>` detached in the background (the hooks); default: this same script under this same runtime */
  /** starts the background run; returns its pid when known (the runner marker then names it) */
  spawnBackground?: (args: string[], env: Record<string, string | undefined>) => number | false | void;
  /** waits (tests: instant, and the hook clock moves on) */
  sleep?: (ms: number) => Promise<void>;
  /** `siiswell update`: the installed script to replace (tests) and whether to smoke-run the download first (default true). */
  scriptPath?: string;
  smokeUpdate?: boolean;
}

const HELP = `siiswell ${CLI_VERSION}: report work and token usage to an siiswell dashboard

Usage:
  siiswell report <title> [--eta-min N] [--project P] [--status S] [--summary TEXT] [--kind KIND] [--agent A] [--json]
  siiswell update [--check] [--yes]  install the CLI version this dashboard publishes (--check only reports; also: siiswell self-update)
  siiswell update <task_id> --status DONE|BLOCKED|IN_PROGRESS [--summary TEXT] [--kind KIND] [--eta-min N] [--json]
                                    (--status DONE is also the manual close of a task the agent never finished)
  siiswell tasks [--json]           this client's open tasks, then those closed as stale (24 h without an update) in the last 7 days
  siiswell heartbeat [--project P]
  siiswell mcp                      stdio MCP server relaying to <url>/mcp (for Claude Desktop and other stdio clients)
  siiswell usage collect [--backfill] [--dry-run] [--json]
  siiswell usage push [--no-collect] [--dry-run] [--json]
  siiswell usage show [--day YYYY-MM-DD] [--json]
  siiswell hook claude-notification|claude-stop|claude-post-tool|claude-prompt|claude-session-end|codex-notify
                [--config FILE] [--on-stop heartbeat|done] [--on-end done|heartbeat]
                                    run by the app hooks setup-client.sh installs (returns at once, works in the background)
  siiswell permissions suggest [--top N] [--json]
                                    which tool calls asked for approval most in the last 7 days (local logs only, nothing is sent)
  siiswell config                   show the resolved configuration (tokens are never printed)
  siiswell doctor                   check URL, tokens and reachability
  siiswell --version | --help

Global flags: --config FILE (instead of SIISWELL_CONFIG), --url URL, --host LABEL (usage / host heartbeat), --project P.
Environment: SIISWELL_URL, SIISWELL_TOKEN (client token), SIISWELL_HOST_TOKEN (host token, usage upload),
SIISWELL_HOST, SIISWELL_PROJECT, SIISWELL_MACHINE, SIISWELL_CONFIG, SIISWELL_STATE_DIR, SIISWELL_USAGE_TZ, SIISWELL_USAGE=off,
SIISWELL_AGENT=1 (set by an agent orchestrator for its agents: hooks record nothing, MCP write tools are answered locally).
Tokens are never accepted as flags.
Config file: ~/.config/siiswell/config.json (must be mode 0600).
`;

export class UsageError extends Error {}

export interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["url", "host", "project", "eta-min", "status", "summary", "kind", "agent", "day", "config", "on-stop", "on-end", "top"]);
const BOOL_FLAGS = new Set(["json", "dry-run", "backfill", "no-collect", "help", "version", "wait", "check", "yes"]);

/** `--flag value`, `--flag=value`, boolean flags, `--` ends flags. Unknown flags and token flags are refused. */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") { flags.help = true; continue; }
    if (a === "-v") { flags.version = true; continue; }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (/token/i.test(name)) throw new UsageError("tokens are never accepted on the command line (they would show in the process list and shell history): use SIISWELL_TOKEN / SIISWELL_HOST_TOKEN or the config file");
    if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = v;
    } else throw new UsageError(`unknown flag --${name}`);
  }
  return { positional, flags };
}

const STATUSES = ["IN_PROGRESS", "BLOCKED", "DONE"] as const;

function etaOf(v: string | true | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isFinite(n) || n < 1 || n > 7 * 24 * 60) throw new UsageError("--eta-min must be a number of minutes between 1 and 10080");
  return Math.round(n);
}
function statusOf(v: string | true | undefined, fallback?: (typeof STATUSES)[number]): (typeof STATUSES)[number] {
  if (v === undefined && fallback) return fallback;
  const s = typeof v === "string" ? v.toUpperCase().replace(/-/g, "_") : "";
  if (!(STATUSES as readonly string[]).includes(s)) throw new UsageError("--status must be IN_PROGRESS, BLOCKED or DONE");
  return s as (typeof STATUSES)[number];
}

function needUrl(cfg: Config): string {
  if (!cfg.url) throw new ConfigError("no dashboard URL: set SIISWELL_URL (e.g. https://dash.example.com) or \"url\" in the config file");
  return cfg.url;
}
function needToken(cfg: Config): string {
  if (!cfg.token) throw new ConfigError("no client token: set SIISWELL_TOKEN (a `client` token from the dashboard operator) or \"token\" in the config file");
  return cfg.token;
}

/** Call one MCP tool over HTTP and return its parsed text (a JSON object, or the plain text). Throws on a tool error. */
async function callTool(cfg: Config, io: Io, name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  const args = applyTaskText(name, rawArgs, cfg.taskText); // what `taskText` withholds never leaves this process
  const r = await postMcp(needUrl(cfg), needToken(cfg), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { fetch: io.fetch });
  const j = r.json as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } } | null;
  if (r.status === 401) throw new ConfigError(`the dashboard refused the client token (401${errorDetail(r) ? `: ${errorDetail(r)}` : ""})`);
  if (r.status === 403) throw new ConfigError(`the dashboard refused the request (403${errorDetail(r) ? `: ${errorDetail(r)}` : ""}); a \`host\` token cannot call /mcp, use a \`client\` token`);
  if (r.status === 429) throw new ConfigError(`rate limited (429${errorDetail(r) ? `: ${errorDetail(r)}` : ""}); retry in ${r.headers.get("retry-after") ?? "60"} s`);
  if (!j || (r.status !== 200 && !j.error)) throw new ConfigError(`unexpected answer from the dashboard (HTTP ${r.status})`);
  if (j.error) throw new ConfigError(`MCP error: ${String(j.error.message ?? "unknown").slice(0, 200)}`);
  const text = j.result?.content?.[0]?.text ?? "";
  if (j.result?.isError) throw new ConfigError(`the dashboard refused the call: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const out = (io: Io, s: string) => io.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
const err = (io: Io, s: string) => io.stderr.write(`siiswell: ${s}\n`);

/** --kind: a word of the fixed list; any other word is sent as "other" (with a note, so a typo is visible). */
const kindFlag = (v: string, io: Io): string => {
  const k = normalizeKind(v);
  if (k && (k !== "other" || v.trim().toLowerCase() === "other")) return k;
  err(io, `--kind "${v.slice(0, 40)}" is not one of the listed kinds; sending "other"`);
  return "other";
};

async function cmdReport(p: Parsed, cfg: Config, io: Io): Promise<number> {
  const title = p.positional.slice(1).join(" ").trim();
  if (!title) throw new UsageError("report needs a title: siiswell report \"what I am doing\" --eta-min 30");
  // --project / config wins; an install from before 0.2.x (projectNames unset) keeps the folder name as before; otherwise the
  // same rule as `siiswell mcp` and the hooks (the usage name policy), and "other" when no name may be sent
  const legacy = cfg.usage.legacyBank && !cfg.usage.projectNamesSet;
  const project = cfg.project ?? (legacy ? defaultProject(io.cwd, cfg.usage.roots, homeOf(io.env)) : taskProject(io.cwd, cfg, homeOf(io.env), (m) => err(io, m)) ?? "other");
  if (!project) throw new UsageError("the current folder name is not a valid project label: pass --project NAME (letters, digits, '.', '_', '-')");
  if (!PROJECT_RE.test(project)) throw new UsageError("--project may only contain letters, digits, '.', '_' and '-' (max 64)");
  const status = statusOf(p.flags.status, "IN_PROGRESS");
  const args: Record<string, unknown> = { project, title: clipText(title, MAX_TITLE), status };
  const eta = etaOf(p.flags["eta-min"]);
  if (eta !== undefined) args.eta_min = eta;
  if (typeof p.flags.summary === "string") args.summary = clipText(p.flags.summary, MAX_TEXT);
  if (typeof p.flags.kind === "string") args.kind = kindFlag(p.flags.kind, io);
  if (typeof p.flags.agent === "string") args.agent = p.flags.agent;
  if (cfg.machine) args.machine = cfg.machine; // the same grouping as `siiswell mcp` and the hooks
  const res = (await callTool(cfg, io, "report_task", args)) as { task_id?: string; state?: string };
  if (p.flags.json) out(io, JSON.stringify(res));
  else out(io, String(res?.task_id ?? res));
  return 0;
}

async function cmdUpdate(p: Parsed, cfg: Config, io: Io): Promise<number> {
  const taskId = p.positional[1];
  if (!taskId || p.positional.length > 2) throw new UsageError("update needs exactly one task_id: siiswell update m-0a1b2c3d --status DONE");
  const args: Record<string, unknown> = { task_id: taskId, status: statusOf(p.flags.status) };
  const eta = etaOf(p.flags["eta-min"]);
  if (eta !== undefined) args.eta_min = eta;
  if (typeof p.flags.summary === "string") args.summary = clipText(p.flags.summary, MAX_TEXT);
  if (typeof p.flags.kind === "string") args.kind = kindFlag(p.flags.kind, io);
  const res = (await callTool(cfg, io, "update_task", args)) as { task_id?: string; state?: string };
  out(io, p.flags.json ? JSON.stringify(res) : `${res?.task_id ?? taskId}: ${res?.state ?? "updated"}`);
  return 0;
}

/** Text from the server, safe for a terminal: ANSI / ESC sequences and every other control character removed. */
export function termSafe(s: unknown): string {
  return String(s ?? "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g, "")
    .replace(/[\x00-\x1f\x7f\x80-\x9f]/g, "");
}

/** Per-app config files setup-client.sh writes, in the order a command run by hand tries them when there is no config.json. */
const APP_CONFIGS = ["claude-code.json", "codex.json", "claude-desktop.json", "agy.json", "gemini.json", "usage.json"];

/**
 * A command typed by hand (`siiswell tasks`, `report`, `usage push`, `update` ...): with no SIISWELL_CONFIG and no
 * config.json, use the first per-app config that setup-client.sh wrote and that has what the command needs: a client
 * token for task commands, a host token for `usage`, just a URL for `update` / `doctor` / `config`. One CLI file serves
 * every app, so any matching file will do.
 */
function withAppConfig(io: Io, needs: "url" | "token" | "hostToken" = "url"): Io {
  if (envVar(io.env, "CONFIG")[0] || envVar(io.env, "URL")[0]) return io;
  const main = configPath(io.env);
  if (existsSync(main)) return io;
  for (const name of APP_CONFIGS) {
    const f = join(dirname(main), name);
    try {
      if (!existsSync(f)) continue;
      const env = { ...io.env, SIISWELL_CONFIG: f };
      const c = loadConfig(env, {}, { platform: io.platform });
      if (c.url && (needs === "url" || c[needs])) return { ...io, env };
    } catch { /* an unreadable file: try the next one */ }
  }
  return io;
}

async function cmdSelfUpdate(p: Parsed, cfg: Config, io: Io): Promise<number> {
  return await selfUpdate(
    cfg,
    {
      out: (s) => out(io, s),
      err: (s) => err(io, s),
      fetch: io.fetch,
      scriptPath: io.scriptPath,
      smoke: io.smokeUpdate,
      confirm: (q) => new Promise<boolean>((resolve) => {
        if (!(io.stdin as { isTTY?: boolean }).isTTY) return resolve(false);
        io.stdout.write(`${q} [y/N] `);
        io.stdin.once("data", (d) => { io.stdin.pause?.(); resolve(/^\s*y/i.test(String(d))); });
      }),
    },
    { check: p.flags.check === true, yes: p.flags.yes === true },
  );
}

async function cmdTasks(p: Parsed, cfg: Config, io: Io): Promise<number> {
  if (p.positional.length > 1) throw new UsageError("tasks takes no arguments: siiswell tasks [--json]");
  const res = (await callTool(cfg, io, "list_tasks", {})) as { now?: number; tasks?: Array<{ task_id: string; title: string; state: string; created: number; updated: number }> };
  const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
  if (p.flags.json) {
    out(io, JSON.stringify(res));
    return 0;
  }
  const open = tasks.filter((t) => t.state !== "stale");
  const stale = tasks.filter((t) => t.state === "stale");
  const now = typeof res.now === "number" ? res.now : (io.now?.() ?? Date.now());
  const age = (t: number) => {
    const m = Math.max(0, Math.round((now - t) / 60_000));
    return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  };
  const line = (t: (typeof tasks)[number]) => out(io, `${termSafe(t.task_id)}\t${termSafe(t.state)}\t${age(t.created)} old, updated ${age(t.updated)} ago\t${termSafe(t.title)}`);
  if (open.length) {
    out(io, "Open tasks:");
    open.forEach(line);
  } else {
    out(io, "no open tasks");
  }
  if (stale.length) {
    out(io, "Closed as stale (no report) in the last 7 days:");
    stale.forEach(line);
  }
  if (tasks.length) out(io, "close one with: siiswell update <task_id> --status DONE");
  return 0;
}

async function cmdHeartbeat(p: Parsed, cfg: Config, io: Io): Promise<number> {
  const project = cfg.project;
  if (cfg.token) {
    await callTool(cfg, io, "heartbeat", project ? { project } : {});
    out(io, "ok");
    return 0;
  }
  if (cfg.hostToken) {
    const r = await send(needUrl(cfg), "/api/ingest/heartbeat", {
      token: cfg.hostToken, fetch: io.fetch,
      body: JSON.stringify({ v: 1, host: cfg.host, ...(project ? { project } : {}), at: io.now?.() ?? Date.now(), binaryVersion: `siiswell-cli ${CLI_VERSION}` }),
    });
    if (r.status !== 200) throw new ConfigError(`host heartbeat refused: HTTP ${r.status}${errorDetail(r) ? ` (${errorDetail(r)})` : ""}`);
    out(io, "ok");
    return 0;
  }
  needToken(cfg);
  return 1;
}

function policyOf(cfg: Config) {
  return { enabled: cfg.usage.enabled, projectNames: cfg.usage.projectNames, keep: cfg.usage.keep };
}

function runCollect(cfg: Config, io: Io, flags: Parsed["flags"]) {
  if (!flags["dry-run"]) ensureDir(cfg.stateDir);
  const release = flags["dry-run"] ? () => undefined : acquireLock(cfg.stateDir, io.now?.());
  if (!release) throw new ConfigError("another `siiswell usage collect` is running (lock in the state dir); try again later");
  try {
    const tz = cfg.usage.tz;
    if (tz && !validTimeZone(tz)) throw new ConfigError(`unknown time zone ${tz}`);
    return collectUsage({ home: homeOf(io.env), stateDir: cfg.stateDir, roots: cfg.usage.roots, tz, now: io.now?.(), dryRun: !!flags["dry-run"], backfill: !!flags.backfill, pricingOverrides: cfg.usage.pricingOverrides });
  } finally {
    release();
  }
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

async function cmdUsage(p: Parsed, cfg: Config, io: Io): Promise<number> {
  const sub = p.positional[1];
  if (sub === "collect") {
    const { run, bank } = runCollect(cfg, io, p.flags);
    if (p.flags.json) out(io, JSON.stringify({ run, days: bank.daily.length, hours: bank.hourly.length }));
    else {
      if (run.note) err(io, run.note);
      out(io, `collected (${run.mode}, tz ${run.tz}): ${run.claudeFiles} Claude + ${run.codexFiles} Codex files, ${run.filesRead} read, ${fmt(run.bytesRead)}B, ${run.requests} new request(s)${run.skipped ? `, ${run.skipped} skipped (not regular files / unreadable)` : ""}${p.flags["dry-run"] ? " [dry run: nothing saved]" : ""}`);
    }
    return 0;
  }
  if (sub === "push") {
    const url = needUrl(cfg);
    if (!cfg.hostToken && cfg.usage.enabled) throw new ConfigError("no host token: usage upload needs a `host` token whose name is the host label; set SIISWELL_HOST_TOKEN and SIISWELL_HOST");
    const bank = p.flags["no-collect"] ? readBank(cfg.stateDir) : runCollect(cfg, io, {}).bank;
    if (!bank) throw new ConfigError("nothing collected yet: run `siiswell usage collect` first");
    if (p.flags["no-collect"]) {
      reattribute(bank.daily, cfg.usage.roots, homeOf(io.env));
      reattribute(bank.hourly, cfg.usage.roots, homeOf(io.env));
    }
    const status = readStatus(cfg.stateDir);
    if (!cfg.hostToken) {
      out(io, "usage upload is disabled (and no host token is configured, so nothing can be erased)");
      return 0;
    }
    const r = await pushUsage({
      base: url, hostToken: cfg.hostToken, host: cfg.host, stateDir: cfg.stateDir, policy: policyOf(cfg), tz: bank.tz,
      daily: bank.daily, hourly: bank.hourly, roots: cfg.usage.roots, version: status?.finishedAt ?? bank.updatedAt, now: io.now?.(), fetch: io.fetch, log: (m) => err(io, m), dryRun: !!p.flags["dry-run"],
    });
    if (p.flags.json) out(io, JSON.stringify(r));
    else out(io, r.summary);
    return r.ok ? 0 : r.retryAfterS !== undefined ? 75 : 1;
  }
  if (sub === "show") {
    const bank = readBank(cfg.stateDir);
    if (!bank) throw new ConfigError("nothing collected yet: run `siiswell usage collect` first");
    const day = typeof p.flags.day === "string" ? p.flags.day : bank.daily.length ? bank.daily.map((b) => b.key).sort().at(-1)! : "";
    const hours = new Map<string, { tokens: number; usd: number; requests: number }>();
    for (const b of bank.hourly) {
      if (!b.key.startsWith(`${day}T`)) continue;
      const h = hours.get(b.key.slice(11)) ?? { tokens: 0, usd: 0, requests: 0 };
      h.tokens += b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
      h.usd += b.usd ?? 0;
      h.requests += b.requests;
      hours.set(b.key.slice(11), h);
    }
    const rows = [...hours.entries()].sort(([a], [b]) => a.localeCompare(b));
    // per project (this machine only, never sent): the real folder name next to the label the dashboard gets for it
    reattribute(bank.daily, cfg.usage.roots, homeOf(io.env));
    const hash = projectHasher(cfg.stateDir);
    const policy = policyOf(cfg);
    const perProject = new Map<string, { project: string; label: string; tokens: number; usd: number; requests: number; unpriced: boolean }>();
    for (const b of bank.daily) {
      if (b.key !== day) continue;
      const r = perProject.get(b.project) ?? { project: b.project, label: policy.enabled ? projectLabel(b.project, policy, hash) : "(not uploaded)", tokens: 0, usd: 0, requests: 0, unpriced: false };
      r.tokens += b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
      r.usd += b.usd ?? 0;
      r.unpriced ||= b.usd === null;
      r.requests += b.requests;
      perProject.set(b.project, r);
    }
    const projects = [...perProject.values()].sort((a, b) => b.tokens - a.tokens || a.project.localeCompare(b.project)).map((r) => ({ ...r, usd: Math.round(r.usd * 1e4) / 1e4 }));
    const unrecognised = readUnrecognised(cfg.stateDir);
    if (p.flags.json) out(io, JSON.stringify({ day, tz: bank.tz, projectNames: cfg.usage.projectNames, projects, hours: Object.fromEntries(rows), unrecognisedApps: unrecognised }));
    else {
      out(io, `${day} (${bank.tz}), per project (local names; "uploaded as" is what the dashboard sees, projectNames: ${cfg.usage.projectNames}):`);
      for (const r of projects) out(io, `  ${r.project.padEnd(24)}  uploaded as ${r.label.padEnd(16)}  ${fmt(r.tokens).padStart(7)} tokens  $${r.usd.toFixed(2)}${r.unpriced ? "+" : ""}`);
      if (!projects.length) out(io, "  (no usage in the daily bank for this day)");
      out(io, `${day} (${bank.tz}), per hour: tokens / requests / API-equivalent USD`);
      for (const [h, v] of rows) out(io, `  ${h}:00  ${fmt(v.tokens).padStart(7)}  ${String(v.requests).padStart(5)}  $${v.usd.toFixed(2)}`);
      if (!rows.length) out(io, "  (no usage in the hourly bank for this day)");
      const un = Object.entries(unrecognised).sort(([, a], [, b]) => b - a);
      if (un.length) {
        out(io, "unrecognised app values (counted as `unknown`; sessions):");
        for (const [k, n] of un) out(io, `  ${k}  ${n}`);
      }
    }
    return 0;
  }
  throw new UsageError("usage needs a subcommand: collect, push or show");
}

/** `siiswell permissions suggest`: local only (reads ~/.claude), prints allowlist ideas; nothing is sent. */
function cmdPermissions(p: Parsed, io: Io): number {
  if (p.positional[1] !== "suggest") throw new UsageError("permissions needs a subcommand: suggest");
  const top = Math.max(1, Math.min(50, Number(p.flags.top) || 10));
  const r = suggestPermissions(homeOf(io.env), io.now?.() ?? Date.now());
  const pick = r.suggestions.slice(0, top);
  if (p.flags.json) {
    out(io, JSON.stringify({ days: SUGGEST_DAYS, files: r.files, toolCalls: r.calls, alreadyAllowed: r.allowed, suggestions: pick }));
    return 0;
  }
  out(io, `Tool calls in the last ${SUGGEST_DAYS} days (${r.files} transcript${r.files === 1 ? "" : "s"}): ${r.calls}, already allowed: ${r.allowed}.`);
  if (!pick.length) {
    out(io, "Nothing to suggest: every tool call was already allowed (or there were none).");
    return 0;
  }
  out(io, "Asked for approval most often (not covered by permissions.allow):");
  for (const x of pick) out(io, `  ${String(x.count).padStart(5)}x  ${x.rule}`);
  out(io, "");
  out(io, "To allow them, review each one (an allow rule lets the agent run it without asking), then add to ~/.claude/settings.json:");
  out(io, JSON.stringify({ permissions: { allow: pick.map((x) => x.rule) } }, null, 2));
  out(io, "(Computed on this machine from your local logs; nothing was sent.)");
  return 0;
}

async function cmdDoctor(cfg: Config, io: Io): Promise<number> {
  let bad = 0;
  const line = (ok: boolean | null, s: string) => {
    if (ok === false) bad++;
    out(io, `${ok === null ? "[--]" : ok ? "[ok]" : "[!!]"} ${s}`);
  };
  line(true, `config file: ${cfg.configFile}${cfg.configFileFound ? " (mode 0600)" : " (not found, environment only)"}`);
  if (!cfg.url) {
    line(false, "dashboard URL: not set (SIISWELL_URL)");
    return 1;
  }
  line(true, `dashboard URL: ${cfg.url}`);
  // The health probe carries no token. Behind an access proxy (Cloudflare Access, oauth2-proxy, ...) the page and /api/health answer
  // with a redirect to its login: that is the expected setup, not a failure. The token probes below are what proves reachability then
  // (the proxy must let /mcp and /api/ingest/* through to the dashboard's own bearer-token check).
  let healthOk = false;
  try {
    const h = await send(cfg.url, "/api/health", { fetch: io.fetch, timeoutMs: 15_000, returnRedirect: true });
    const v = (h.json as { version?: unknown } | null)?.version;
    if (h.status >= 300 && h.status < 400) {
      line(null, isAccessRedirect(h)
        ? `reachable: GET /api/health -> HTTP ${h.status} to a login page: protected by an access proxy (fine); checking the token routes instead`
        : `reachable: GET /api/health -> HTTP ${h.status} redirect (not followed): an access proxy or a wrong URL; checking the token routes instead`);
    } else {
      healthOk = h.status === 200;
      line(healthOk, `reachable: GET /api/health -> HTTP ${h.status}${typeof v === "string" ? `, server version ${v.slice(0, 40)}` : ""}`);
    }
  } catch (e) {
    line(false, `reachable: ${e instanceof HttpError ? e.message : "error"}`);
  }
  // Token kind: tools/list on /mcp writes nothing (no task, no heartbeat, no budget). 200 = client, 403 = host, 401 = unknown / revoked.
  let tokenReached = false;
  const probe = async (label: string, token: string | undefined, want: "client" | "host") => {
    if (!token) {
      line(null, `${label}: not set`);
      return;
    }
    try {
      const r = await postMcp(cfg.url!, token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { fetch: io.fetch });
      const kind = r.status === 200 ? "client" : r.status === 403 && /'host' token/.test(errorDetail(r)) ? "host" : null;
      if (kind) tokenReached = true;
      if (kind === want) line(true, `${label}: accepted, kind '${kind}' (POST /mcp tools/list)`);
      else if (kind) line(false, `${label}: this is a '${kind}' token, a '${want}' token is needed here`);
      else line(false, `${label}: refused (HTTP ${r.status}${errorDetail(r) ? `: ${errorDetail(r)}` : ""})`);
    } catch (e) {
      const redirected = e instanceof HttpError && e.kind === "redirect";
      line(false, `${label}: ${e instanceof HttpError ? e.message : "error"}${redirected ? " (an access proxy must let /mcp and /api/ingest/* through to the dashboard: bypass them for token requests)" : ""}`);
    }
  };
  await probe("client token (SIISWELL_TOKEN)", cfg.token, "client");
  await probe("host token (SIISWELL_HOST_TOKEN)", cfg.hostToken, "host");
  if (!healthOk && tokenReached) line(true, "reachable: the dashboard answered on its token routes");
  if (cfg.hostToken) line(null, `host label: "${cfg.host}" (from ${cfg.from.host}); it must equal the host token's name, which only an upload can confirm (403 otherwise)`);
  if (cfg.usage.legacyBank && !cfg.usage.projectNamesSet) {
    line(null, 'task project names: sent as folder names (an install from before 0.2.x); set usage.projectNames to "hashed" or "other" to hide them');
  }
  // the human recording (the "You" line): is the hook there, did it record anything, when does it upload
  {
    const now = io.now?.() ?? Date.now();
    const hd = humanDiagnostics(cfg.stateDir, homeOf(io.env), now);
    const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    if (agentByEnv(io.env)) line(null, "agent workspace: SIISWELL_AGENT is set here, so the hooks record nothing and the MCP write tools are answered locally");
    line(hd.hookInstalled ? true : null, `human recording: Claude Code prompt hook ${hd.hookInstalled ? "installed" : "not installed (scripts/setup-client.sh installs it)"}`);
    line(null, `human recording: ${hd.logLines} event(s) in the last 72 h${hd.lastLine ? `, last ${when(hd.lastLine)}` : ""}${hd.logLines === 0 && hd.hookInstalled ? " (none yet: a prompt in a Claude Code session outside an agent workspace records one)" : ""}`);
    line(null, hd.nextUpload === 0
      ? "human upload: never uploaded yet (a hook uploads when one is due)"
      : hd.failures
        ? `human upload: the last ${hd.failures} attempt(s) failed; next try after ${when(hd.nextUpload)}`
        : `human upload: last one ${when(hd.nextUpload - 10 * 60_000)}, next due after ${when(hd.nextUpload)}`);
  }
  line(null, `usage upload: ${cfg.usage.enabled ? `on, project names: ${cfg.usage.projectNames}${cfg.usage.keep.length ? ` (+ kept: ${cfg.usage.keep.join(", ")})` : ""}, tz ${cfg.usage.tz ?? DEFAULT_USAGE_TZ}` : "off"}`);
  const st = readStatus(cfg.stateDir);
  line(null, `last usage collect: ${st ? new Date(st.finishedAt).toISOString() : "never"} (state dir ${cfg.stateDir})`);
  return bad ? 1 : 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    err(io, (e as Error).message);
    return 2;
  }
  if (p.flags.version) {
    out(io, CLI_VERSION_LINE);
    return 0;
  }
  const cmd = p.positional[0];
  if (p.flags.help || !cmd || cmd === "help") {
    io.stdout.write(HELP);
    return cmd || p.flags.help ? 0 : 2;
  }
  if (cmd === "hook") return await cmdHook(p, io);
  // --config FILE works for every command: it is SIISWELL_CONFIG for this run (the config file's own checks still apply)
  if (typeof p.flags.config === "string") {
    // a file named on the command line must exist: never fall back to the environment or the defaults silently
    let isFile = false;
    try { isFile = existsSync(p.flags.config) && statSync(p.flags.config).isFile(); } catch { isFile = false; }
    if (!isFile) {
      err(io, `config file not found or not a file: ${p.flags.config.slice(0, 300)}`);
      return 1;
    }
    io = { ...io, env: { ...io.env, SIISWELL_CONFIG: p.flags.config } };
  }
  else if (p.flags.config !== undefined) {
    err(io, "--config needs a file path");
    return 2;
  }
  try {
    const selfUpdating = cmd === "self-update" || (cmd === "update" && p.positional.length <= 1 && p.flags.status === undefined);
    // hooks get --config from their registration and `mcp` gets SIISWELL_CONFIG: only commands typed by hand look around
    if (p.flags.url === undefined && cmd !== "hook" && cmd !== "mcp" && cmd !== "permissions") {
      io = withAppConfig(io, selfUpdating || cmd === "doctor" || cmd === "config" ? "url" : cmd === "usage" ? "hostToken" : "token");
    }
    const cfg = loadConfig(io.env, { url: p.flags.url as string | undefined, host: p.flags.host as string | undefined, project: p.flags.project as string | undefined }, { platform: io.platform });
    switch (cmd) {
      case "report": return await cmdReport(p, cfg, io);
      case "update":
        if (p.positional.length <= 1 && p.flags.status === undefined && ["summary", "eta-min", "json", "title"].some((f) => p.flags[f] !== undefined)) {
          throw new UsageError("these flags update a task: give its id (siiswell update <task_id> --status DONE); `siiswell update` alone installs the new CLI");
        }
        if (p.positional.length > 1 || p.flags.status !== undefined) return await cmdUpdate(p, cfg, io);
        return await cmdSelfUpdate(p, cfg, io);
      case "self-update": return await cmdSelfUpdate(p, cfg, io);
      case "tasks": return await cmdTasks(p, cfg, io);
      case "heartbeat": return await cmdHeartbeat(p, cfg, io);
      case "mcp":
        await runMcpStdio({
          base: needUrl(cfg), token: needToken(cfg), input: io.stdin, output: io.stdout, log: (m) => err(io, m), fetch: io.fetch,
          // no project may be inferred here: the agent may still name one; one it leaves out is filed under "other"
          defaults: { taskText: cfg.taskText, project: cfg.project ?? taskProject(io.cwd, cfg, homeOf(io.env), (m) => err(io, m)) ?? "other", machine: cfg.machine },
          // an agent workspace: its tasks are reported by the host integration; only the read tools go through
          ...(inAgentPane(io.cwd, io.env) ? { skipWrites: AGENT_PANE_SKIP } : {}),
        });
        return 0;
      case "usage": return await cmdUsage(p, cfg, io);
      case "config":
        out(io, JSON.stringify(describe(cfg), null, 2));
        return 0;
      case "doctor": return await cmdDoctor(cfg, io);
      case "permissions": return cmdPermissions(p, io);
      default:
        throw new UsageError(`unknown command "${cmd.slice(0, 40)}" (see siiswell --help)`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(io, e.message);
      return 2;
    }
    if (e instanceof ConfigError || e instanceof HttpError) {
      err(io, e.message);
      return 1;
    }
    err(io, `unexpected error: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
    return 1;
  }
}

// ── hooks ─────────────────────────────────────────────────────────────────────

/** Read stdin to the end (bounded in size and time: a hook never waits for an app that keeps it open). */
function readStdin(stdin: Readable, max = 1 << 20, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      clearTimeout(timer);
      stdin.removeAllListeners("data");
      resolve(buf.length > max ? "" : buf);
    };
    const timer = setTimeout(done, timeoutMs);
    stdin.on("data", (d) => {
      buf += String(d);
      if (buf.length > max) done();
    });
    stdin.once("end", done);
    stdin.once("error", done);
  });
}

/** The background run's pid, or false when it could not be started. */
function defaultSpawn(args: string[], env: Record<string, string | undefined>): number | false {
  const script = process.argv[1];
  if (!script) return false;
  try {
    const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: "ignore", env: env as NodeJS.ProcessEnv });
    child.on("error", () => undefined);
    child.unref();
    return typeof child.pid === "number" ? child.pid : false;
  } catch {
    return false;
  }
}

/**
 * The environment a background run gets: only what the CLI and its network stack need. A runner may sleep for minutes (a
 * backoff), so it must not carry the app's secrets (API keys, cloud credentials) in /proc/<pid>/environ.
 */
const RUNNER_ENV_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "NODE_EXTRA_CA_CERTS", "NODE_ENV"]);
const RUNNER_ENV_PREFIXES = ["SIISWELL_", "ORCH_DASH_", "ORCH_TRACKER_"];
const PROXY_ENV = /^(https?_proxy|all_proxy|no_proxy)$/i;
export function runnerEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (RUNNER_ENV_NAMES.has(k.toUpperCase()) || RUNNER_ENV_PREFIXES.some((p) => k.startsWith(p)) || PROXY_ENV.test(k)) out[k] = v;
  }
  return out;
}

/** The foreground's own short drain when no background run could be started (bounded: the app is waiting for the hook). */
export const INLINE_DRAIN_MS = 2_000;

/**
 * `siiswell hook <event>`: ALWAYS exits 0, whatever happens (a hook must never block or fail the app). Without `--wait` it only parses
 * its input and starts itself again in the background with the parsed fields (SIISWELL_HOOK_INPUT); `--wait` does the work.
 */
async function cmdHook(p: Parsed, io: Io): Promise<number> {
  // the event's time, taken first (before stdin is read) with sub-millisecond precision: it orders the session's events
  const firedAt = io.now?.() ?? performance.timeOrigin + performance.now();
  try {
    const event = p.positional[1] as HookEvent;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      err(io, `hook needs one of: ${HOOK_EVENTS.join(", ")}`);
      return 0;
    }
    const env = typeof p.flags.config === "string" ? { ...io.env, SIISWELL_CONFIG: p.flags.config } : io.env;
    const onStop = p.flags["on-stop"] === "done" ? "done" : "heartbeat";
    const onEnd = p.flags["on-end"] === "heartbeat" ? "heartbeat" : "done";
    let input: HookInput | null = null;
    let queued = false;
    let runnerRun = false;
    const passed = io.env.SIISWELL_HOOK_INPUT;
    if (p.flags.wait && passed) {
      try {
        const o = JSON.parse(passed) as HookInput & { queued?: unknown; runner?: unknown };
        if (typeof o.session === "string" && /^[0-9a-f]{24}$/.test(o.session)) input = { session: o.session, ...(typeof o.p === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(o.p) ? { p: o.p } : {}), ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}), ...(o.permission === true ? { permission: true } : {}), ...(o.idle === true ? { idle: true } : {}), ...(typeof o.at === "number" && Number.isFinite(o.at) ? { at: o.at } : {}) };
        queued = o.queued === true;
        runnerRun = o.runner === true;
      } catch { /* unusable */ }
    } else {
      const raw = event === "codex-notify" ? (p.positional[p.positional.length - 1] ?? "") : await readStdin(io.stdin);
      input = parseHookInput(event, event === "codex-notify" && p.positional.length < 3 ? "" : raw);
      if (input) input.at = firedAt;
    }
    if (!input) return 0;
    // an agent workspace (<project>/worktrees/... of a project with .siiswell-agents, or SIISWELL_AGENT=1): not the operator;
    // nothing recorded or reported
    if (inAgentPane(input.cwd, env)) return 0;
    if (!p.flags.wait) {
      // the foreground only QUEUES the event (one small file) and starts the background run; nothing is lost if that run waits
      let runner = false;
      let stateDir = "";
      if (event !== "codex-notify") {
        const cfg0 = loadConfig(env, {}, { platform: io.platform });
        const dir = cfg0.stateDir;
        sweepStateDir(dir, firedAt); // at most every 10 minutes
        // the operator's own input (times and kinds only, never text): a prompt, an approval, a response time
        if (event === "claude-notification" || event === "claude-prompt" || event === "claude-post-tool") {
          recordHuman(dir, input.session, event === "claude-notification" ? "notification" : event === "claude-prompt" ? "prompt" : "tool", firedAt, !!input.permission);
        }
        // the hourly human counts must reach the dashboard even when nothing else goes there (no permission prompts, e.g.
        // bypass mode): an operator event (or a Stop) with an upload due starts the session's ONE background run for it
        const uploadDue = (event === "claude-prompt" || event === "claude-post-tool" || event === "claude-notification" || event === "claude-stop") && humanUploadDue(dir, firedAt);
        const startUploadRun = (): boolean => uploadDue && claimRunner(dir, input.session, firedAt);
        const done = event === "claude-session-end" ? onEnd === "done" : event === "claude-stop" ? onStop === "done" : false;
        // the queued event holds the project LABEL only (never the working directory: no path or name reaches the disk)
        const label = input.cwd && (event === "claude-notification" || event === "claude-stop" || event === "claude-session-end") ? taskProject(input.cwd, cfg0, homeOf(env), () => undefined) : undefined;
        const ev = { e: event, at: firedAt, ...(input.permission ? { permission: true } : {}), ...(label ? { p: label } : {}), ...(done ? { done: true } : {}) };
        if (isIdleNotification(event, input)) {
          // idle at the end of a turn: no task change; at most the human counts' upload run
          if (!startUploadRun()) return 0;
          queued = true;
          runner = true;
        } else if (firedAt < backoffUntil(dir, input.session)) {
          // the dashboard could not be reached a moment ago: PostToolUse / UserPromptSubmit go; Stop / SessionEnd wait in the queue
          // for the next run; a Notification also starts ONE runner (unless one lives) that waits for the backoff to end and then
          // sends it, so the dashboard shows BLOCKED while the user waits
          if (event === "claude-post-tool" || event === "claude-prompt") return 0;
          queued = queueEvent(dir, input.session, ev);
          if (!queued || event !== "claude-notification" || !claimRunner(dir, input.session, firedAt)) return 0;
          runner = true;
        } else {
          // PostToolUse / UserPromptSubmit fire constantly: nothing at all unless the task is (or is about to be) BLOCKED, or the
          // human counts are due (then a run with nothing to drain: it only uploads them)
          if ((event === "claude-post-tool" || event === "claude-prompt") && !unblockWorthQueuing(input, dir, firedAt)) {
            if (!startUploadRun()) return 0;
            queued = true; // nothing queued for this event: the run drains what there is and uploads
            runner = true;
            stateDir = dir;
          }
          if (!runner) queued = queueEvent(dir, input.session, ev);
          // ONE background run per session: a live runner drains the whole queue, this event included
          if (!runner) {
            if (queued && !claimRunner(dir, input.session, firedAt)) return 0;
            runner = queued;
          }
        }
        stateDir = dir;
      }
      const args = ["hook", event, "--wait", ...(typeof p.flags.config === "string" ? ["--config", p.flags.config] : []), "--on-stop", onStop, "--on-end", onEnd];
      // the background run (it may sleep for minutes) gets the project LABEL, never the working directory: its environment
      // (/proc/<pid>/environ) holds no path or folder name
      const { cwd: _cwd, ...rest } = input;
      const p0 = input.cwd ? taskProject(input.cwd, loadConfig(env, {}, { platform: io.platform }), homeOf(env), () => undefined) : undefined;
      const childInput = { ...rest, ...(p0 ? { p: p0 } : {}), at: firedAt, ...(queued ? { queued: true } : {}), ...(runner ? { runner: true } : {}) };
      const pid = (io.spawnBackground ?? defaultSpawn)(args, { ...runnerEnv(env), SIISWELL_HOOK_INPUT: JSON.stringify(childInput) });
      // the marker now names the child: a hook after this one sees a live runner, or (child killed) takes over at once
      if (runner && typeof pid === "number" && pid > 0) adoptRunner(stateDir, input.session, pid, firedAt);
      else if (runner && pid === false) {
        // no background run (spawn failed): free the slot and drain once here, for at most ~2 s; what is left stays queued
        releaseRunner(stateDir, input.session);
        const cfg = loadConfig(env, {}, { platform: io.platform });
        // every request of this drain is aborted when the time is up, so nothing keeps the hook (and the app) waiting
        const ac = new AbortController();
        const base = io.fetch ?? globalThis.fetch;
        const fetchAbortable = ((url: string, init: RequestInit = {}) =>
          base(url, { ...init, signal: init.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, ac.signal]) : ac.signal })) as typeof globalThis.fetch; // Node 18: no any()
        const run = runHook(event, input, cfg, env, { now: io.now?.(), fetch: fetchAbortable as never, onStop, onEnd, queued: true, lockWaitMs: 500 });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([run, new Promise((res) => { timer = setTimeout(res, INLINE_DRAIN_MS); })]);
        clearTimeout(timer);
        ac.abort();
        await Promise.race([run, new Promise((res) => setTimeout(res, 200))]); // let it release the lock
        // the real CLI: exit now, whatever is still pending (tests run in-process and pass their own spawn)
        if (!io.spawnBackground) process.exit(0);
      }
      return 0;
    }
    const cfg = loadConfig(env, {}, { platform: io.platform });
    const r = await runHook(event, input, cfg, env, { now: io.now?.(), fetch: io.fetch, onStop, onEnd, queued, runner: runnerRun, ...(io.sleep ? { sleep: io.sleep } : {}) });
    if (p.flags.json) out(io, JSON.stringify(r));
    return 0;
  } catch {
    return 0;
  }
}
