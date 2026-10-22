// SPDX-License-Identifier: Apache-2.0
/**
 * @file Resolved configuration of the siiswell CLI: flags > environment > config file > defaults.
 * @module cli/config
 *
 * Environment: SIISWELL_URL / SIISWELL_TOKEN (the older bridge names ORCH_TRACKER_URL / ORCH_TRACKER_TOKEN are accepted
 * too, and every SIISWELL_* also under its pre-rename name ORCH_DASH_*), SIISWELL_HOST_TOKEN, SIISWELL_HOST, SIISWELL_PROJECT, SIISWELL_CONFIG, SIISWELL_STATE_DIR, SIISWELL_USAGE_TZ.
 * Config file: $SIISWELL_CONFIG, else $XDG_CONFIG_HOME/siiswell/config.json, else ~/.config/siiswell/config.json. It may
 * hold tokens, so it must be a regular file owned by the current user and readable by nobody else (mode 0600): anything
 * else is refused, never silently used. Tokens are never printed: `describe()` only says where a token came from.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, renameSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ModelPriceOverride } from "../../src/shared/pricing";
import { DEFAULT_TASK_TEXT, parseTaskText, type TaskTextMode } from "./tasktext";

/** The exact shape the server accepts (`oct_` + base64url of 32 bytes): anything else is refused before it is sent. */
export const TOKEN_RE = /^oct_[A-Za-z0-9_-]{43}$/;
/** Project labels of /mcp report_task (the server's PROJECT_RE). */
export const PROJECT_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Host labels (the server's HOST_RE): the name of a `host` token. */
export const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CONFIG_BYTES = 64 * 1024;

export type ProjectNames = "other" | "hashed" | "all";

export interface UsageSettings {
  /** false = never upload (and erase what this host label already uploaded, see usage/push.ts) */
  enabled: boolean;
  /**
   * what a project folder name becomes on the dashboard: `(other)`, a salted hash (`h-…`, the salt stays on this machine), or
   * the name itself. Default: "hashed" for a new install with no roots / keep configured, else "other".
   */
  projectNames: ProjectNames;
  /** folder names that keep their name whatever `projectNames` says (opt-in per project) */
  keep: string[];
  /**
   * directories whose first-level folders are projects. Default: none, every working directory counts (its git checkout,
   * else its folder, names the project). An install that collected usage before this default changed (a usage bank in the
   * state dir) keeps the earlier default, LEGACY_DEFAULT_ROOTS, so its history is attributed as before.
   */
  roots: string[];
  /** the usage bank predates the privacy defaults: task project names are sent as before (see taskProject) */
  legacyBank: boolean;
  /** usage.projectNames was set in the config file (not a default) */
  projectNamesSet: boolean;
  /**
   * MCP / hooks: infer a project outside `roots` from the git checkout, else the folder name (default false: outside the roots
   * nothing is inferred, the same rule as the usage collector, so task projects and usage projects line up)
   */
  inferProjectOutsideRoots: boolean;
  /** IANA time zone of the day / hour buckets (default: this system's time zone; a usage bank keeps the zone it was made in) */
  tz?: string;
  /** `{ "<substring of a model id>": { input, output, cacheRead? } }` in USD per million tokens: wins over the price table */
  pricingOverrides: Record<string, ModelPriceOverride>;
}

export interface Config {
  url?: string;
  /** client token (/mcp) */
  token?: string;
  /** host token (/api/ingest/usage, /api/ingest/heartbeat) */
  hostToken?: string;
  /** host label = the NAME of the host token on the server */
  host: string;
  project?: string;
  /**
   * Machine label that `siiswell mcp` adds to report_task, so the dashboard groups the tasks of several apps on this machine
   * (`machine`, else an explicitly configured `host`; never the OS host name, which can be a person's name).
   */
  machine?: string;
  /** how much task title / summary text is uploaded (`taskText` in the config file, or SIISWELL_TASK_TEXT): full | brief | minimal | none; default brief */
  taskText: TaskTextMode;
  stateDir: string;
  usage: UsageSettings;
  /** where each value came from (for `config` / `doctor`), never the values of tokens */
  from: Record<string, string>;
  configFile: string;
  configFileFound: boolean;
}

export class ConfigError extends Error {}

export type Env = Record<string, string | undefined>;

export function homeOf(env: Env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Legacy prefix of every `SIISWELL_*` variable (the product's earlier name): read when the new one is not set. */
const LEGACY_PREFIX = "ORCH_DASH_";
const LEGACY_NAME = "orch-dash";

/** `SIISWELL_<suffix>`, else the legacy `ORCH_DASH_<suffix>`: the value and the name it came from. */
export function envVar(env: Env, suffix: string): [string | undefined, string] {
  const name = `SIISWELL_${suffix}`;
  if (str(env[name]) !== undefined) return [env[name], name];
  const legacy = `${LEGACY_PREFIX}${suffix}`;
  return [env[legacy], legacy];
}

/** $SIISWELL_CONFIG, else <config home>/siiswell/config.json, else (when only that exists) the pre-rename <config home>/orch-dash/config.json. */
export function configPath(env: Env, exists: (p: string) => boolean = existsSync): string {
  const [explicit] = envVar(env, "CONFIG");
  if (str(explicit)) return explicit!;
  const base = env.XDG_CONFIG_HOME || join(homeOf(env), ".config");
  const current = join(base, "siiswell", "config.json");
  const legacy = join(base, LEGACY_NAME, "config.json");
  return !exists(current) && exists(legacy) ? legacy : current;
}

/**
 * $SIISWELL_STATE_DIR, else <state home>/siiswell. A state dir from before the rename (<state home>/orch-dash) is moved
 * to the new name once (offsets, bank and upload state carry over); if it cannot be moved it keeps being used.
 */
export function defaultStateDir(env: Env): string {
  const [explicit] = envVar(env, "STATE_DIR");
  if (str(explicit)) return explicit!;
  const base = env.XDG_STATE_HOME || join(homeOf(env), ".local", "state");
  const current = join(base, "siiswell");
  const legacy = join(base, LEGACY_NAME);
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      return legacy;
    }
  }
  return current;
}

/**
 * Read the config file: null when it does not exist. FIFO-safe (O_NONBLOCK + fstat), bounded, and strict about who may read it.
 * Throws ConfigError when the file exists but cannot be used (wrong mode or owner, not a regular file, not a JSON object).
 */
export function readConfigFile(file: string, platform: string = process.platform): Record<string, unknown> | null {
  let fd = -1;
  try {
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw new ConfigError(`config file ${file} cannot be opened (${(err as { code?: string }).code ?? "error"})`);
    }
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ConfigError(`config file ${file} is not a regular file`);
    if (platform !== "win32") {
      if ((st.mode & 0o077) !== 0) throw new ConfigError(`config file ${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}): run chmod 600 ${file}`);
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (uid >= 0 && st.uid !== uid) throw new ConfigError(`config file ${file} is not owned by the current user`);
    }
    if (st.size > MAX_CONFIG_BYTES) throw new ConfigError(`config file ${file} is larger than ${MAX_CONFIG_BYTES} bytes`);
    const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
      if (n > MAX_CONFIG_BYTES) throw new ConfigError(`config file ${file} is larger than ${MAX_CONFIG_BYTES} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8", 0, n));
    } catch {
      throw new ConfigError(`config file ${file} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ConfigError(`config file ${file} must hold a JSON object`);
    return parsed as Record<string, unknown>;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * Normalise and check the dashboard base URL: https, or http only to this machine; no credentials, query or fragment;
 * a trailing `/mcp` (the URL a remote MCP client is given) is accepted and removed.
 */
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError("the dashboard URL is not a valid URL (example: https://dash.example.com)");
  }
  if (u.username || u.password) throw new ConfigError("the dashboard URL must not contain a user name or password");
  if (u.search || u.hash) throw new ConfigError("the dashboard URL must not contain a query or fragment");
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new ConfigError("the dashboard URL must use https:// (plain http is allowed for localhost only): the token would travel in clear text");
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** A host label from the machine name: the first DNS label, characters the server refuses replaced. */
export function defaultHostLabel(name = hostname()): string {
  const first = name.split(".")[0] || "host";
  const clean = first.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return HOST_RE.test(clean) ? clean : "host";
}

/** The roots of installs from before "no roots" became the default (they keep them, see UsageSettings.roots). */
export const LEGACY_DEFAULT_ROOTS: readonly string[] = ["~/projects", "/projects"];

/**
 * Does this install keep the earlier default roots? Yes when its usage bank predates "no roots" (the bank's first key,
 * `rootsDefault`, is missing). Reads at most 64 bytes; no bank = a new install = no.
 */
export function usesLegacyRoots(stateDir: string): boolean {
  let fd = -1;
  try {
    fd = openSync(join(stateDir, "usage.json"), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return false;
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    return !/^\s*\{\s*"rootsDefault"\s*:\s*"none"/.test(buf.subarray(0, n).toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * The project label `siiswell mcp` and the hooks fill into a report_task that has none: the first-level folder under one of
 * `roots` (the usage collector's rule). Elsewhere (outside configured roots, or with no roots at all) the git checkout, else
 * the folder name, is sent ONLY when `outsideRoots` opts in or that name is in `keep`: a folder name can be a client's name,
 * so by default nothing is sent. Characters the server refuses become '-'. Never a path (only one folder NAME), and nothing
 * at all for the file-system root or the home directory itself (its name is the user's name, not a project).
 */
export function mcpDefaultProject(cwd: string, roots: string[] = [], home?: string, outsideRoots = false, keep: readonly string[] = []): string | undefined {
  const c = cwd.replace(/\/+$/, "") || "/";
  if (c === "/" || (home && c === home.replace(/\/+$/, ""))) return undefined;
  const clean = (name: string | undefined) => {
    const v = (name ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    return v && PROJECT_RE.test(v) ? v : undefined;
  };
  for (const r of roots) {
    const root = r.replace(/\/+$/, "");
    if (root && c.startsWith(`${root}/`)) return clean(c.slice(root.length + 1).split("/")[0]);
  }
  // elsewhere: the git checkout / folder name, only when opted in (usage.inferProjectOutsideRoots) or kept by name
  const name = clean(basename(gitTop(c, home) ?? c));
  return name && (outsideRoots || keep.includes(name)) ? name : undefined;
}

/** The enclosing git checkout of `dir` (the first ancestor with a `.git`, at most 40 levels, never above `home`), or null. */
function gitTop(dir: string, home?: string): string | null {
  let d = dir;
  for (let i = 0; i < 40 && d && d !== "/" && d !== home; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/**
 * The default project label of `report`: the first-level folder under one of `roots`, else the folder of the enclosing git
 * checkout (walking up to the first `.git`, at most 40 levels, stopping at the home directory), else the current folder name.
 * Only a valid label is returned.
 */
export function defaultProject(cwd: string, roots: string[] = [], home?: string): string | undefined {
  const c = cwd.replace(/\/+$/, "");
  const ok = (v: string | undefined) => (v && PROJECT_RE.test(v) ? v : undefined);
  for (const r of roots) {
    const root = r.replace(/\/+$/, "");
    if (root && c.startsWith(`${root}/`)) return ok(c.slice(root.length + 1).split("/")[0]);
  }
  let d = c;
  for (let i = 0; i < 40 && d && d !== "/" && d !== home; i++) {
    if (existsSync(join(d, ".git"))) return ok(basename(d));
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return ok(basename(c));
}

function expandHome(p: string, env: Env): string {
  return p === "~" ? homeOf(env) : p.startsWith("~/") ? join(homeOf(env), p.slice(2)) : p;
}

export interface Flags {
  url?: string;
  host?: string;
  project?: string;
}

/** Resolve everything; throws ConfigError on a value that cannot be used (never on a missing one: commands check what they need). */
export function loadConfig(env: Env, flags: Flags = {}, opts: { platform?: string } = {}): Config {
  const file = configPath(env);
  const fileCfg = readConfigFile(file, opts.platform) ?? null;
  const f = fileCfg ?? {};
  const from: Record<string, string> = {};
  const pick = (name: string, cands: Array<[string | undefined, string]>): string | undefined => {
    for (const [v, where] of cands) {
      const s = str(v);
      if (s !== undefined) {
        from[name] = where;
        return s;
      }
    }
    return undefined;
  };

  const urlRaw = pick("url", [[flags.url, "--url"], envVar(env, "URL"), [env.ORCH_TRACKER_URL, "ORCH_TRACKER_URL"], [f.url as string, "config file"]]);
  const token = pick("token", [envVar(env, "TOKEN"), [env.ORCH_TRACKER_TOKEN, "ORCH_TRACKER_TOKEN"], [f.token as string, "config file"]]);
  const hostToken = pick("hostToken", [envVar(env, "HOST_TOKEN"), [f.hostToken as string, "config file"]]);
  let host = pick("host", [[flags.host, "--host"], envVar(env, "HOST"), [f.host as string, "config file"]]);
  const project = pick("project", [[flags.project, "--project"], envVar(env, "PROJECT"), [f.project as string, "config file"]]);
  const machine = pick("machine", [envVar(env, "MACHINE"), [f.machine as string, "config file"]]);
  const stateDir = str(envVar(env, "STATE_DIR")[0]) ? envVar(env, "STATE_DIR")[0]! : str(f.stateDir) ? expandHome(str(f.stateDir)!, env) : defaultStateDir(env);

  const ttEnv = envVar(env, "TASK_TEXT")[0];
  if (str(ttEnv) !== undefined && parseTaskText(ttEnv) === undefined) throw new ConfigError('SIISWELL_TASK_TEXT must be "full", "brief", "minimal" or "none"');
  if (f.taskText !== undefined && parseTaskText(f.taskText) === undefined) throw new ConfigError('taskText in the config file must be "full", "brief", "minimal" or "none"');
  const taskText = parseTaskText(ttEnv) ?? parseTaskText(f.taskText) ?? DEFAULT_TASK_TEXT;
  if (parseTaskText(ttEnv)) from.taskText = "SIISWELL_TASK_TEXT";
  else if (parseTaskText(f.taskText)) from.taskText = "config file";

  for (const [name, v] of [["token", token], ["hostToken", hostToken]] as const) {
    if (v !== undefined && !TOKEN_RE.test(v)) throw new ConfigError(`the ${name === "token" ? "client" : "host"} token (from ${from[name]}) does not look like an siiswell token (oct_ + 43 characters)`);
  }
  if (host === undefined) {
    host = defaultHostLabel();
    from.host = "machine name";
  } else if (!HOST_RE.test(host)) throw new ConfigError(`the host label (from ${from.host}) may only contain letters, digits, '.', '_' and '-' (max 64)`);
  if (project !== undefined && !PROJECT_RE.test(project)) throw new ConfigError(`the project label (from ${from.project}) may only contain letters, digits, '.', '_' and '-' (max 64)`);
  if (machine !== undefined && !HOST_RE.test(machine)) throw new ConfigError(`the machine label (from ${from.machine}) may only contain letters, digits, '.', '_' and '-' (max 64)`);

  const u = (typeof f.usage === "object" && f.usage !== null && !Array.isArray(f.usage) ? f.usage : {}) as Record<string, unknown>;
  if (u.enabled !== undefined && typeof u.enabled !== "boolean") throw new ConfigError("usage.enabled in the config file must be true or false");
  if (u.inferProjectOutsideRoots !== undefined && typeof u.inferProjectOutsideRoots !== "boolean") throw new ConfigError("usage.inferProjectOutsideRoots in the config file must be true or false");
  if (u.projectNames !== undefined && u.projectNames !== "other" && u.projectNames !== "hashed" && u.projectNames !== "all") {
    throw new ConfigError('usage.projectNames in the config file must be "other", "hashed" or "all"');
  }
  const list = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ConfigError(`usage.${name} in the config file must be a list of strings`);
    return v as string[];
  };
  const po = u.pricingOverrides;
  if (po !== undefined && (typeof po !== "object" || po === null || Array.isArray(po))) throw new ConfigError("usage.pricingOverrides in the config file must be an object");
  const pricingOverrides: Record<string, ModelPriceOverride> = {};
  for (const [k, v] of Object.entries((po ?? {}) as Record<string, unknown>)) {
    const o = v as Record<string, unknown> | null;
    const price = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x < 1e6;
    if (!k || typeof o !== "object" || o === null || !price(o.input) || !price(o.output) || (o.cacheRead !== undefined && !price(o.cacheRead))) {
      throw new ConfigError(`usage.pricingOverrides["${k.slice(0, 40)}"] must be { "input": n, "output": n, "cacheRead"?: n } in USD per million tokens`);
    }
    pricingOverrides[k] = { input: o.input as number, output: o.output as number, ...(o.cacheRead !== undefined ? { cacheRead: o.cacheRead as number } : {}) };
  }
  const usageEnv = envVar(env, "USAGE")[0];
  const envOff = usageEnv === "off" || usageEnv === "0";
  const keep = (list(u.keep, "keep") ?? []).filter((k) => /^[A-Za-z0-9._-]{1,64}$/.test(k));
  const rootsSet = list(u.roots, "roots") !== undefined;
  const legacyBank = usesLegacyRoots(stateDir);
  const usage: UsageSettings = {
    enabled: !envOff && u.enabled !== false,
    // a NEW install with nothing configured uploads salted hashes, never folder names (they can be client names); an install
    // that configured roots / keep, or whose bank predates this default, keeps "other" as before
    projectNames: (u.projectNames as ProjectNames | undefined) ?? (!legacyBank && !rootsSet && !keep.length ? "hashed" : "other"),
    keep,
    legacyBank,
    projectNamesSet: u.projectNames !== undefined,
    roots: (list(u.roots, "roots") ?? (legacyBank ? LEGACY_DEFAULT_ROOTS : [])).map((r) => expandHome(r, env)),
    inferProjectOutsideRoots: u.inferProjectOutsideRoots === true,
    tz: str(envVar(env, "USAGE_TZ")[0]) ?? str(u.tz),
    pricingOverrides,
  };

  return {
    url: urlRaw === undefined ? undefined : normalizeBaseUrl(urlRaw),
    token,
    hostToken,
    host,
    project,
    machine: machine ?? (from.host && from.host !== "machine name" ? host : undefined),
    taskText,
    stateDir,
    usage,
    from,
    configFile: file,
    configFileFound: fileCfg !== null,
  };
}

/** What `siiswell config` prints: every value except tokens, which only say where they came from. */
export function describe(cfg: Config): Record<string, unknown> {
  const tok = (name: "token" | "hostToken") => (cfg[name] ? `set (from ${cfg.from[name]})` : "not set");
  return {
    configFile: `${cfg.configFile}${cfg.configFileFound ? "" : " (not found)"}`,
    url: cfg.url ? `${cfg.url} (from ${cfg.from.url})` : "not set",
    clientToken: tok("token"),
    hostToken: tok("hostToken"),
    host: `${cfg.host} (from ${cfg.from.host})`,
    project: cfg.project ? `${cfg.project} (from ${cfg.from.project})` : "current folder name",
    machine: cfg.machine ? `${cfg.machine} (from ${cfg.from.machine ?? cfg.from.host})` : "not set (MCP tasks are grouped by the client token's name)",
    taskText: `${cfg.taskText} (${cfg.from.taskText ?? "default"})`,
    stateDir: cfg.stateDir,
    usage: cfg.usage,
  };
}
