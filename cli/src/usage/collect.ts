// SPDX-License-Identifier: Apache-2.0
/**
 * @file `siiswell usage collect`: bank token usage from the local Claude Code transcripts and Codex rollouts, per HOUR and per DAY.
 * @module cli/usage/collect
 *
 * Ported from the original host agent's usage rollup (same dedupe, same attribution idea, same price variants):
 *   - Claude: ~/.claude/projects/** /*.jsonl, sub-agent transcripts (<session>/subagents/*.jsonl) included;
 *   - Codex : ~/.codex/sessions/Y/M/D/rollout-*.jsonl (TUI and `exec`).
 * Privacy: only numeric usage fields, model ids, timestamps, message ids, the cwd and the app are read out of a line; a line is only
 * parsed at all when it contains `"usage"` (Claude) or `"token_count"` / `"turn_context"` (Codex). Nothing else is stored.
 *
 * Reads are FIFO-safe and bounded: every file is opened O_NONBLOCK and must be a regular file (fstat on the descriptor), a
 * line longer than MAX_LINE is skipped, and the walk never follows symlinks. Incremental: per-file byte offsets (a file that
 * shrank is re-read from 0), message ids deduped across files (bounded set).
 *
 * State (dir 0700, files 0600) in the state dir (default ~/.local/state/siiswell):
 *   usage-state.json  offsets + attribution + the message-id set
 *   usage.json        buckets: `daily` (kept) and `hourly` (kept HOURLY_KEEP_DAYS), each with its RAW cwd (local only, never sent):
 *                     project / agent are re-derived from it on every run, so a change of `usage.roots` re-attributes history;
 *                     USD is recomputed on every write
 *   usage-status.json when the last run finished (the upload's `generatedAt`)
 *   usage.lock        O_EXCL lock (one collector at a time), stale after 10 min
 * A missing / corrupt usage-state.json next to a usage.json with buckets re-reads everything and merges by per-field MAX
 * (never adds twice); a missing usage.json with offsets present rebuilds from the logs still on disk.
 *
 * Privacy: the bank and the read state keep the raw working directory and transcript paths of each bucket, LOCALLY ONLY
 * (state dir, mode 0600): they label usage, give `siiswell usage show` the real folder names and re-attribute the history
 * when usage.roots change. They never leave the machine (an upload holds labels per the projectNames policy and numbers).
 * No prompt, message or tool content is ever read into them: only the token-count fields of the transcripts.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRICE_TABLE_RETRIEVED, costOf, isLongContextFor, type ModelPriceOverride } from "../../../src/shared/pricing";
import { claudeGrowth, cleanModelId, codexApp, codexDelta, codexHeadModel, parseClaudeUsage, type AppLabel } from "./parse";

/** The day / hour zone of a new usage bank: this system's time zone (UTC when it has none). A bank keeps the zone it was made in. */
export const DEFAULT_USAGE_TZ: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();
export const HOURLY_KEEP_DAYS = 92;
export const LOCK_STALE_MS = 10 * 60_000;
const STATE_VERSION = 1;
const MAX_SEEN = 20_000;
const CHUNK = 1 << 20;
export const MAX_LINE = 32 << 20;
const MAX_DEPTH = 12;

export type UsageSource = "claude" | "codex";
export type Variant = "" | "fast" | "long" | "fast+long";

/**
 * One (hour or day, working directory, app, source, model, variant) total. `usd` is null for a model with no known price.
 * `project` / `agent` are DERIVED from `cwd` with the configured roots on every run (reattribute), so a change of `usage.roots`
 * re-attributes the whole bank; a bucket banked before the raw cwd was kept (no `cwd`) keeps the attribution it was banked with.
 * The raw cwd never leaves the machine (usage/push.ts only sends the derived labels).
 */
export interface Bucket {
  /** `YYYY-MM-DD` (daily) or `YYYY-MM-DDTHH` (hourly), in the bank's time zone */
  key: string;
  project: string;
  agent: string;
  /** raw working directory ("" = unknown); absent on buckets banked by an older collector */
  cwd?: string;
  /** app label (parse.ts APP_LABELS); absent on buckets banked by an older collector */
  app?: string;
  source: UsageSource;
  model: string;
  variant: Variant;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  requests: number;
  usd: number | null;
}

interface FileEntry {
  o: number;
  s: UsageSource;
  p?: string;
  a?: string;
  m?: string;
  t?: number;
  /** raw cwd of the session */
  c?: string;
  /** app label of the session */
  e?: string;
  /** Codex: the file size when its head was last searched for a model and none was found (not searched again until the head grows) */
  hm?: number;
}
interface State {
  v: number;
  files: Record<string, FileEntry>;
  seen: Record<string, number[]>;
  codexFull?: boolean;
  /**
   * `entrypoint` / `originator` values the app regex did not recognise, with how many sessions had them (`claude:<v>` / `codex:<v>`).
   * Local diagnostics only (never uploaded), listed by `siiswell usage show`, so the label table can be extended.
   */
  unrecognised?: Record<string, number>;
}

const MAX_UNRECOGNISED = 50;
/** Count one session with an unrecognised app value (cleaned, clipped, bounded number of keys). */
function noteUnrecognised(state: State, source: UsageSource, raw: string | undefined): void {
  if (!raw) return;
  const v = raw.replace(/[^A-Za-z0-9._ -]/g, "?").slice(0, 64);
  const k = `${source}:${v}`;
  const u = (state.unrecognised ??= {});
  if (u[k] === undefined && Object.keys(u).length >= MAX_UNRECOGNISED) return;
  u[k] = (u[k] ?? 0) + 1;
}

/** The unrecognised app values of the state dir (see State.unrecognised). */
export function readUnrecognised(dir: string): Record<string, number> {
  const s = loadState(dir).state;
  return s.unrecognised ?? {};
}
export interface Bank {
  /**
   * FIRST key of the file (config.ts reads only the start): "none" = made when "no roots" was the default; a bank without it
   * predates that and its install keeps the earlier default roots (LEGACY_DEFAULT_ROOTS)
   */
  rootsDefault?: "none";
  v: 1;
  tz: string;
  priceTable: string;
  updatedAt: number;
  daily: Bucket[];
  hourly: Bucket[];
  /** the bucket scheme (BANK_SCHEME); a bank without it was written before buckets kept their cwd and app */
  scheme?: string;
}

/**
 * Buckets keep the raw cwd and the app. A bank of an older scheme with legacy buckets is rebuilt ONCE from the logs (backfill).
 * cwd-app-2: Codex models are also read from the rollout head (codexHeadModel), so a bank holding Codex `unknown` buckets is re-read once.
 */
export const BANK_SCHEME = "cwd-app-2";
const isCodexUnknown = (b: Pick<Bucket, "source" | "model" | "cwd">): boolean => b.source === "codex" && b.model === "unknown" && b.cwd !== undefined;

// ── files ────────────────────────────────────────────────────────────

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
}

/** Atomic write (tmp + rename), mode 0600. */
export function writePrivate(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

/** A small regular file of our own state (FIFO-safe, capped), or null. */
export function readSmall(file: string, max = 256 << 20): string | null {
  let fd = -1;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* closed */ }
  }
}

// ── time keys ────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
const hourCache = new Map<string, string>();

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local hour `YYYY-MM-DDTHH` (00-23) of an instant in an IANA time zone. DST: the repeated autumn hour is one bucket. */
export function hourKey(t: number, tz: string): string {
  // every real UTC offset is a multiple of 15 min: a 15-min cache key never straddles an hour boundary
  const ck = `${tz}|${Math.floor(t / 900_000)}`;
  const hit = hourCache.get(ck);
  if (hit) return hit;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    formatters.set(tz, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(t))) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const key = `${parts.year}-${parts.month}-${parts.day}T${hour}`;
  if (hourCache.size > 50_000) hourCache.clear();
  hourCache.set(ck, key);
  return key;
}

export const dayKey = (t: number, tz: string): string => hourKey(t, tz).slice(0, 10);

// ── attribution ──────────────────────────────────────────────────────

/**
 * cwd -> (project, agent). With `roots`: the project is the first-level folder under one of them (worktrees included);
 * anything else is `(other)`; agent: the worktree name `<project>-<agent>` (.../worktrees/<p>-<agent>), `operator` for the
 * project root itself, else the CLI name. Without roots every directory counts: the project is the folder of its git
 * checkout, else the folder itself, and the agent is the CLI name. A Codex `exec` run is always `codex`.
 */
/** Claude Code's own subagents run in `.claude/worktrees/agent-*`: their usage is the agents', never the operator's. */
export const SUBAGENT = "subagent";
const SUBAGENT_DIR = /\/\.claude\/worktrees\/agent-[^/]+(\/|$)/;

export function attribute(cwd: string | undefined, source: UsageSource, roots: string[], opts: { exec?: boolean; home?: string } = {}): { project: string; agent: string } {
  const c = cwd ? cwd.replace(/\/+$/, "") : "";
  const sub = opts.exec ? -1 : c.search(SUBAGENT_DIR);
  if (sub > 0) return { ...attribute(c.slice(0, sub), source, roots, opts), agent: SUBAGENT }; // the project of the checkout it forked
  if (!roots.length) {
    const project = c && c !== opts.home?.replace(/\/+$/, "") ? projectFolder(c) : "";
    return { project: project || "(other)", agent: opts.exec ? "codex" : source };
  }
  for (const r of roots) {
    const root = r.replace(/\/+$/, "");
    if (!root || !c.startsWith(`${root}/`)) continue;
    const segs = c.slice(root.length + 1).split("/").filter(Boolean);
    const project = segs[0];
    if (!project) continue;
    if (opts.exec) return { project, agent: "codex" };
    if (segs.length === 1) return { project, agent: "operator" };
    for (let i = 2; i < segs.length; i++) {
      const seg = segs[i]!;
      if (segs[i - 1] === "worktrees" && seg.length > project.length + 1 && seg.startsWith(`${project}-`)) return { project, agent: seg.slice(project.length + 1) };
    }
    return { project, agent: source };
  }
  return { project: "(other)", agent: source };
}

/** The name of the git checkout holding `dir` (first ancestor with `.git`, at most 40 levels), else of `dir` itself; cached. */
const folderCache = new Map<string, string>();
function projectFolder(dir: string): string {
  const hit = folderCache.get(dir);
  if (hit !== undefined) return hit;
  let top = dir;
  for (let d = dir, i = 0; i < 40 && d && d !== "/"; i++) {
    if (existsSync(join(d, ".git"))) { top = d; break; }
    const up = d.slice(0, d.lastIndexOf("/")) || "/";
    if (up === d) break;
    d = up;
  }
  const name = (top.split("/").filter(Boolean).pop() ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (folderCache.size > 5000) folderCache.clear();
  folderCache.set(dir, name);
  return name;
}

// ── FIFO-safe streaming line reader ──────────────────────────────────

let sharedChunk: Buffer | undefined;

/**
 * Open a file for reading only if it is a regular file: O_NONBLOCK so a FIFO planted where a transcript should be can never
 * block, then fstat on the descriptor (no check-then-open race). Returns the fd and size, or null.
 */
export function openRegular(file: string): { fd: number; size: number } | null {
  let fd = -1;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return null;
    }
    return { fd, size: st.size };
  } catch {
    if (fd >= 0) try { closeSync(fd); } catch { /* closed */ }
    return null;
  }
}

/**
 * Stream complete lines from byte `from` up to `size` (the size seen at open: a file still being written is read up to there),
 * calling `onLine(buf, start, end)` (a view valid only during the call). A line over MAX_LINE is skipped. Returns the offset just
 * after the last complete line.
 */
export function readLines(fd: number, from: number, size: number, onLine: (buf: Buffer, start: number, end: number) => void, stats: { bytes: number }): number {
  const chunk = (sharedChunk ??= Buffer.allocUnsafe(CHUNK));
  let pos = from;
  let consumed = from;
  let parts: Buffer[] = [];
  let partLen = 0;
  let skipping = false;
  while (pos < size) {
    const n = readSync(fd, chunk, 0, Math.min(CHUNK, size - pos), pos);
    if (n <= 0) break;
    stats.bytes += n;
    const view = chunk.subarray(0, n);
    let s = 0;
    while (s < n) {
      const nl = view.indexOf(0x0a, s);
      if (nl < 0) {
        if (!skipping) {
          parts.push(Buffer.from(view.subarray(s)));
          partLen += n - s;
          if (partLen > MAX_LINE) {
            parts = [];
            partLen = 0;
            skipping = true;
          }
        }
        break;
      }
      if (skipping) skipping = false;
      else if (parts.length > 0) {
        parts.push(view.subarray(s, nl));
        const whole = Buffer.concat(parts);
        parts = [];
        partLen = 0;
        onLine(whole, 0, whole.length);
      } else onLine(view, s, nl);
      consumed = pos + nl + 1;
      s = nl + 1;
    }
    pos += n;
  }
  return consumed;
}

/** Every regular `*.jsonl` file under `dir` accepted by `accept`; symlinks are never followed, depth is bounded. */
function walk(dir: string, accept: (name: string) => boolean, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, accept, out, depth + 1);
    else if (e.isFile() && accept(e.name)) out.push(p);
  }
}

const isRollout = (n: string) => n.startsWith("rollout-") && n.endsWith(".jsonl");

function codexFiles(root: string, full: boolean, now: number, days = 10): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  if (full) {
    walk(root, isRollout, out);
    return out;
  }
  const dirs = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i <= days; i++) {
    const d = new Date(now - i * 86_400_000);
    dirs.add(join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    dirs.add(join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
  }
  for (const d of dirs) walk(d, isRollout, out);
  return out;
}

/** The model named in a Codex rollout's first 256 KB (see codexHeadModel). */
const CODEX_HEAD_BYTES = 256 * 1024;
function codexModelFromHead(fd: number): string | null {
  try {
    const buf = Buffer.allocUnsafe(CODEX_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return codexHeadModel(buf.toString("utf8", 0, Math.max(0, n)));
  } catch {
    return null;
  }
}

/** cwd, run kind and app of a Codex rollout, from the head (16 KB) of its first line only. */
function codexSessionMeta(fd: number): { cwd?: string; exec: boolean; app: AppLabel; raw?: string } {
  let head = "";
  try {
    const buf = Buffer.allocUnsafe(16 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    head = buf.toString("utf8", 0, Math.max(0, n));
  } catch {
    return { exec: false, app: "unknown" };
  }
  const nl = head.indexOf("\n");
  const line = nl < 0 ? head : head.slice(0, nl);
  const cwdRaw = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
  let cwd: string | undefined;
  if (cwdRaw !== undefined) {
    try { cwd = JSON.parse(`"${cwdRaw}"`) as string; } catch { cwd = cwdRaw; }
  }
  const originator = line.match(/"originator":"([^"\\]{1,64})"/)?.[1];
  const source = line.match(/"source":"([^"\\]{1,64})"/)?.[1];
  const app = codexApp(originator, source);
  return { cwd, exec: app === "codex-exec", app, ...(app === "unknown" ? { raw: originator ?? source } : {}) };
}

// ── state + bank ─────────────────────────────────────────────────────

export const paths = (dir: string) => ({
  state: join(dir, "usage-state.json"),
  bank: join(dir, "usage.json"),
  status: join(dir, "usage-status.json"),
  lock: join(dir, "usage.lock"),
});

function loadState(dir: string): { state: State; problem?: string } {
  const raw = readSmall(paths(dir).state);
  if (raw === null) return { state: { v: STATE_VERSION, files: {}, seen: {} }, problem: "missing" };
  try {
    const s = JSON.parse(raw) as State;
    if (s?.v === STATE_VERSION && s.files && s.seen) return { state: s };
  } catch { /* corrupt */ }
  return { state: { v: STATE_VERSION, files: {}, seen: {} }, problem: "corrupt" };
}

export function readBank(dir: string): Bank | null {
  const raw = readSmall(paths(dir).bank);
  if (raw === null) return null;
  try {
    const b = JSON.parse(raw) as Bank;
    if (b?.v === 1 && Array.isArray(b.daily) && Array.isArray(b.hourly) && typeof b.tz === "string") return b;
  } catch { /* corrupt */ }
  return null;
}

export interface Status {
  startedAt: number;
  finishedAt: number;
  ok: boolean;
}
export function readStatus(dir: string): Status | null {
  const raw = readSmall(paths(dir).status, 64 * 1024);
  try {
    const s = raw ? (JSON.parse(raw) as Status) : null;
    return s && typeof s.finishedAt === "number" ? s : null;
  } catch {
    return null;
  }
}

/** A bucket is identified by its raw cwd and app; a legacy bucket (no cwd) by the attribution it was banked with. */
const bucketKey = (b: Pick<Bucket, "key" | "project" | "agent" | "cwd" | "app" | "source" | "model" | "variant">): string =>
  [b.key, b.cwd === undefined ? `p:${b.project}\t${b.agent}` : `c:${b.cwd}`, b.app ?? "", b.source, b.model, b.variant].join("\t");

/** (Re-)derive project / agent of every bucket that has its raw cwd, with the roots in effect now. In place. */
export function reattribute(buckets: Iterable<Bucket>, roots: string[], home?: string): void {
  for (const b of buckets) {
    if (b.cwd === undefined) continue;
    const at = attribute(b.cwd || undefined, b.source, roots, { exec: b.app === "codex-exec", home });
    b.project = at.project;
    b.agent = at.agent;
  }
}

export function priceBuckets(buckets: Iterable<Bucket>, overrides: Record<string, ModelPriceOverride> = {}): void {
  for (const b of buckets) {
    b.usd = costOf({
      model: b.model, input: b.input, output: b.output, cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite5m + b.cacheWrite1h, cacheWrite1h: b.cacheWrite1h,
      fast: b.variant === "fast" || b.variant === "fast+long",
      long: b.variant === "long" || b.variant === "fast+long",
    }, overrides);
  }
}

/** O_EXCL lock; a lock older than LOCK_STALE_MS is broken. Returns a release function, or null when another collector holds it. */
export function acquireLock(dir: string, now = Date.now()): (() => void) | null {
  const p = paths(dir).lock;
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, t: now, token })); } finally { closeSync(fd); }
      return () => {
        try {
          if (JSON.parse(readFileSync(p, "utf8")).token === token) unlinkSync(p);
        } catch { /* gone */ }
      };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return null;
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (now - st.mtimeMs <= LOCK_STALE_MS) return null;
      try { unlinkSync(p); } catch { /* raced */ }
    }
  }
  return null;
}

// ── the run ──────────────────────────────────────────────────────────

export interface CollectOptions {
  /** where ~/.claude and ~/.codex live */
  home: string;
  stateDir: string;
  roots: string[];
  tz?: string;
  now?: number;
  dryRun?: boolean;
  /** re-read every file from byte 0 and merge by per-field max */
  backfill?: boolean;
  /** operator prices (substring of the model id -> USD per million tokens), as the host agent's `pricingOverrides`; USD is recomputed on every run */
  pricingOverrides?: Record<string, ModelPriceOverride>;
}

export interface CollectRun {
  mode: "first" | "incremental" | "backfill";
  tz: string;
  note?: string;
  claudeFiles: number;
  codexFiles: number;
  filesRead: number;
  skipped: number;
  bytesRead: number;
  usageLines: number;
  requests: number;
  ms: number;
}

interface Ev {
  t: number; project: string; agent: string; cwd: string; app: string; source: UsageSource; model: string;
  input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; prompt: number; fast: boolean; requests: number;
}

const USAGE_NEEDLE = Buffer.from('"usage"');
const TOKEN_COUNT_NEEDLE = Buffer.from('"token_count"');
const TURN_CONTEXT_NEEDLE = Buffer.from('"turn_context"');

export function collectUsage(opts: CollectOptions): { run: CollectRun; bank: Bank } {
  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const dir = opts.stateDir;
  const dryRun = !!opts.dryRun;
  const overrides = opts.pricingOverrides ?? {};
  if (!dryRun) ensureDir(dir);
  const stored = readBank(dir);
  let tz = opts.tz && validTimeZone(opts.tz) ? opts.tz : DEFAULT_USAGE_TZ;
  let note: string | undefined;
  if (stored && stored.tz !== tz) {
    if (opts.tz) note = `configured time zone ${tz} differs from the banked ${stored.tz}; keeping ${stored.tz} (remove usage.json and usage-state.json to change it)`;
    tz = stored.tz;
  }

  let backfill = !!opts.backfill;
  const loaded = loadState(dir);
  let prior = loaded.state;
  const storedCount = stored ? stored.daily.length : 0;
  if (!backfill && loaded.problem && storedCount > 0) {
    backfill = true;
    note = `usage-state.json ${loaded.problem} but usage.json holds buckets: re-reading every transcript with the per-field-max merge (no double counting)`;
  } else if (!backfill && !loaded.problem && !stored && Object.keys(prior.files).length > 0) {
    prior = { v: STATE_VERSION, files: {}, seen: {} };
    note = "usage.json missing or corrupt but usage-state.json holds offsets: rebuilding from every transcript still on disk";
  }
  // Upgrade: a bank of an older scheme still holding legacy buckets (no cwd / app) is rebuilt once from every log still on disk, so
  // its history gets app labels; what the logs no longer hold stays as a legacy residual (see merge). Runs once: the scheme is stamped.
  if (!backfill && stored && stored.scheme !== BANK_SCHEME && [...stored.daily, ...stored.hourly].some((b) => b.cwd === undefined)) {
    backfill = true;
    note = "usage bank from an older version: re-reading every transcript once to label its history by app (no double counting)";
  }
  if (!backfill && stored && stored.scheme !== BANK_SCHEME && [...stored.daily, ...stored.hourly].some(isCodexUnknown)) {
    backfill = true;
    note = "usage bank from an older version: re-reading every transcript once to find the model of Codex rows banked as unknown (no double counting)";
  }
  const first = Object.keys(prior.files).length === 0 && !prior.codexFull;
  const state: State = backfill ? { v: STATE_VERSION, files: {}, seen: {} } : prior;
  const daily = new Map<string, Bucket>();
  const hourly = new Map<string, Bucket>();
  if (stored) {
    // the roots may have changed since these were banked: every bucket with its raw cwd is attributed anew
    reattribute(stored.daily, opts.roots, opts.home);
    reattribute(stored.hourly, opts.roots, opts.home);
  }
  if (stored && !backfill) {
    for (const b of stored.daily) daily.set(bucketKey(b), b);
    for (const b of stored.hourly) hourly.set(bucketKey(b), b);
  }

  const stats = { claudeFiles: 0, codexFiles: 0, filesRead: 0, skipped: 0, usageLines: 0, requests: 0 };
  const io = { bytes: 0 };

  const add = (map: Map<string, Bucket>, key: string, ev: Ev, variant: Variant): void => {
    const k = bucketKey({ key, project: ev.project, agent: ev.agent, cwd: ev.cwd, app: ev.app, source: ev.source, model: ev.model, variant });
    let b = map.get(k);
    if (!b) {
      b = { key, project: ev.project, agent: ev.agent, cwd: ev.cwd, app: ev.app, source: ev.source, model: ev.model, variant, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0, usd: null };
      map.set(k, b);
    }
    b.input += ev.input; b.output += ev.output; b.cacheRead += ev.cacheRead;
    b.cacheWrite5m += ev.cw5m; b.cacheWrite1h += ev.cw1h; b.requests += ev.requests;
  };
  const addEvent = (ev: Ev): void => {
    stats.requests += ev.requests;
    const long = isLongContextFor(ev.model, ev.prompt, overrides);
    const variant: Variant = ev.fast && long ? "fast+long" : ev.fast ? "fast" : long ? "long" : "";
    const hk = hourKey(ev.t, tz);
    add(hourly, hk, ev, variant);
    add(daily, hk.slice(0, 10), ev, variant);
  };

  // ── Claude ──
  const claudeList: string[] = [];
  walk(join(opts.home, ".claude", "projects"), (n) => n.endsWith(".jsonl"), claudeList);
  for (const file of claudeList) {
    stats.claudeFiles++;
    const h = openRegular(file);
    if (!h) { stats.skipped++; continue; }
    try {
      let ent = state.files[file];
      if (!ent || ent.s !== "claude") { ent = { o: 0, s: "claude" }; state.files[file] = ent; }
      if (h.size < ent.o) { ent.o = 0; ent.p = undefined; ent.a = undefined; ent.c = undefined; ent.e = undefined; }
      if (h.size === ent.o) continue;
      stats.filesRead++;
      const e = ent;
      ent.o = readLines(h.fd, ent.o, h.size, (b, s, end) => {
        const view = b.subarray(s, end);
        if (!view.includes(USAGE_NEEDLE)) return;
        let o: unknown;
        try { o = JSON.parse(view.toString("utf8")); } catch { return; }
        const l = parseClaudeUsage(o);
        o = undefined;
        if (!l) return;
        stats.usageLines++;
        if (e.c === undefined && l.cwd !== undefined) e.c = l.cwd;
        if (e.e === undefined && l.app !== undefined) {
          e.e = l.app;
          if (l.app === "unknown") noteUnrecognised(state, "claude", l.rawEntry);
        }
        if (!e.p || e.c !== undefined) {
          const at = attribute(e.c, "claude", opts.roots, { home: opts.home });
          e.p = at.project;
          e.a = at.agent;
        }
        const g = claudeGrowth(state.seen, l);
        if (!g) return;
        addEvent({
          t: l.t, project: e.p, agent: e.a!, cwd: e.c ?? "", app: l.app ?? e.e ?? "unknown", source: "claude", model: l.model,
          input: g.delta[0], output: g.delta[1], cacheRead: g.delta[2], cw5m: Math.max(0, g.delta[3] - g.delta[4]), cw1h: g.delta[4],
          prompt: g.prompt, fast: l.fast, requests: g.first ? 1 : 0,
        });
      }, io);
    } catch {
      stats.skipped++;
    } finally {
      try { closeSync(h.fd); } catch { /* closed */ }
    }
  }

  // ── Codex ──
  const full = backfill || !prior.codexFull;
  const codexSet = new Set<string>(codexFiles(join(opts.home, ".codex", "sessions"), full, now));
  if (!backfill) for (const [f, ent] of Object.entries(prior.files)) if (ent.s === "codex") codexSet.add(f);
  for (const file of codexSet) {
    stats.codexFiles++;
    // a known file is re-checked here (it was not found by the walk): never follow a symlink that replaced it
    try { if (lstatSync(file).isSymbolicLink()) { stats.skipped++; continue; } } catch { continue; }
    const h = openRegular(file);
    if (!h) { stats.skipped++; continue; }
    try {
      let ent = state.files[file];
      if (!ent || ent.s !== "codex" || ent.e === undefined) {
        // new file, or one banked by an older collector (no raw cwd / app yet): read its session_meta (the first line) again
        const meta = codexSessionMeta(h.fd);
        const at = attribute(meta.cwd, "codex", opts.roots, { exec: meta.exec, home: opts.home });
        const fresh = { s: "codex" as const, p: at.project, a: at.agent, c: meta.cwd ?? "", e: meta.app };
        if (meta.app === "unknown") noteUnrecognised(state, "codex", meta.raw);
        ent = ent && ent.s === "codex" ? Object.assign(ent, fresh) : { o: 0, ...fresh };
        state.files[file] = ent;
      } else {
        const at = attribute(ent.c || undefined, "codex", opts.roots, { exec: ent.e === "codex-exec", home: opts.home });
        ent.p = at.project;
        ent.a = at.agent;
      }
      if (h.size < ent.o) { ent.o = 0; ent.t = undefined; ent.m = undefined; ent.hm = undefined; }
      if (h.size === ent.o) continue;
      stats.filesRead++;
      // no model known yet for new spend (a read that starts mid-file, or turns without a model): look at the rollout's head
      // a head searched without a result is searched again only once it has grown (it stops changing past CODEX_HEAD_BYTES)
      if (ent.m === undefined && (ent.hm === undefined || (ent.hm < CODEX_HEAD_BYTES && h.size > ent.hm))) {
        ent.m = codexModelFromHead(h.fd) ?? undefined;
        ent.hm = ent.m === undefined ? h.size : undefined;
      }
      const e = ent;
      const st: { lastTotal?: number } = { lastTotal: ent.t };
      ent.o = readLines(h.fd, ent.o, h.size, (b, s, end) => {
        const view = b.subarray(s, end);
        const isCtx = view.includes(TURN_CONTEXT_NEEDLE);
        if (!isCtx && !view.includes(TOKEN_COUNT_NEEDLE)) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let o: any;
        try { o = JSON.parse(view.toString("utf8")); } catch { return; }
        if (o?.type === "turn_context") {
          const m = cleanModelId(o.payload?.model);
          if (m) e.m = m;
          return;
        }
        if (o?.type !== "event_msg" || o.payload?.type !== "token_count" || !o.payload.info) return;
        const t = Date.parse(o.timestamp);
        if (!Number.isFinite(t)) return;
        stats.usageLines++;
        const d = codexDelta(o.payload.info, st);
        if (!d) return;
        addEvent({
          t, project: e.p!, agent: e.a!, cwd: e.c ?? "", app: e.e ?? "unknown", source: "codex", model: e.m ?? "unknown",
          input: d.input, output: d.output, cacheRead: d.cacheRead, cw5m: d.cacheWrite, cw1h: 0, prompt: d.prompt, fast: false, requests: 1,
        });
      }, io);
      ent.t = st.lastTotal;
    } catch {
      stats.skipped++;
    } finally {
      try { closeSync(h.fd); } catch { /* closed */ }
    }
  }
  if (full) state.codexFull = true;

  for (const f of Object.keys(state.files)) if (!existsSync(f)) delete state.files[f];
  const ids = Object.keys(state.seen);
  if (ids.length > MAX_SEEN) for (const id of ids.slice(0, ids.length - MAX_SEEN)) delete state.seen[id];

  const merge = (old: Bucket[] | undefined, fresh: Map<string, Bucket>): Map<string, Bucket> => {
    if (!backfill || !old) return fresh;
    const out = new Map(old.filter((b) => b.cwd !== undefined && !isCodexUnknown(b)).map((b) => [bucketKey(b), b] as const));
    // Codex `unknown` buckets: a re-read may now name their model, so they cannot be matched key for key either. Per (hour or day,
    // cwd, app, variant), only what the old Codex buckets held BEYOND the re-read logs (any model) stays, as one `unknown` residual.
    const cg = (b: Bucket) => [b.key, b.cwd, b.app ?? "", b.variant].join("\t");
    const cFresh = new Map<string, number[]>();
    for (const b of fresh.values()) {
      if (b.source !== "codex" || b.cwd === undefined) continue;
      const v = cFresh.get(cg(b)) ?? [0, 0, 0, 0, 0, 0];
      [b.input, b.output, b.cacheRead, b.cacheWrite5m, b.cacheWrite1h, b.requests].forEach((x, i) => (v[i]! += x));
      cFresh.set(cg(b), v);
    }
    const cOld = new Map<string, { sum: number[]; unknown?: Bucket }>();
    for (const b of old) {
      if (b.source !== "codex" || b.cwd === undefined) continue;
      const e = cOld.get(cg(b)) ?? { sum: [0, 0, 0, 0, 0, 0] };
      [b.input, b.output, b.cacheRead, b.cacheWrite5m, b.cacheWrite1h, b.requests].forEach((x, i) => (e.sum[i]! += x));
      if (isCodexUnknown(b)) e.unknown = b;
      cOld.set(cg(b), e);
    }
    // every old Codex bucket of such a group is replaced by the re-read + the residual (a kept one would count twice)
    for (const b of old) if (b.source === "codex" && b.cwd !== undefined && cOld.get(cg(b))?.unknown) out.delete(bucketKey(b));
    for (const [g, e] of cOld) {
      if (!e.unknown) continue;
      const f = cFresh.get(g) ?? [0, 0, 0, 0, 0, 0];
      const rest = e.sum.map((x, i) => Math.max(0, x - f[i]!));
      if (rest.every((x) => x === 0)) continue;
      const r: Bucket = { ...e.unknown };
      [r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, r.requests] = rest as [number, number, number, number, number, number];
      const k = bucketKey(r);
      const cur = fresh.get(k);
      // the fresh unknown bucket of the same key (logs that still name no model) takes the residual on top
      if (cur) { cur.input += rest[0]!; cur.output += rest[1]!; cur.cacheRead += rest[2]!; cur.cacheWrite5m += rest[3]!; cur.cacheWrite1h += rest[4]!; cur.requests += rest[5]!; continue; }
      out.set(k, r);
    }
    // Legacy buckets (banked without cwd / app) cannot be matched key for key. They are matched per (hour or day, source, model, variant)
    // - NOT by project, so a change of roots in the same run cannot make them look unmatched - against the SUM of the fresh buckets of
    // that group: only what the legacy group holds beyond the re-read logs (logs deleted since) is kept, as ONE residual bucket of the
    // group's largest legacy attribution. The per-field max, as for every other bucket: never counted twice.
    const fields = (b: Bucket) => [b.input, b.output, b.cacheRead, b.cacheWrite5m, b.cacheWrite1h, b.requests];
    const group = (b: Bucket) => [b.key, b.source, b.model, b.variant].join("\t");
    const freshSum = new Map<string, number[]>();
    for (const b of fresh.values()) {
      const v = freshSum.get(group(b)) ?? [0, 0, 0, 0, 0, 0];
      fields(b).forEach((x, i) => (v[i]! += x));
      freshSum.set(group(b), v);
    }
    const legacy = new Map<string, Bucket[]>();
    for (const b of old) if (b.cwd === undefined) (legacy.get(group(b)) ?? legacy.set(group(b), []).get(group(b))!).push(b);
    for (const [g, list] of legacy) {
      const total = [0, 0, 0, 0, 0, 0];
      for (const b of list) fields(b).forEach((x, i) => (total[i]! += x));
      const f = freshSum.get(g) ?? [0, 0, 0, 0, 0, 0];
      const rest = total.map((x, i) => Math.max(0, x - f[i]!));
      if (rest.every((x) => x === 0)) continue;
      const biggest = [...list].sort((a, b) => fields(b).reduce((n, x) => n + x, 0) - fields(a).reduce((n, x) => n + x, 0))[0]!;
      const r: Bucket = { ...biggest };
      [r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, r.requests] = rest as [number, number, number, number, number, number];
      out.set(bucketKey(r), r);
    }
    for (const [k, b] of fresh) {
      const cur = out.get(k);
      if (!cur) { out.set(k, b); continue; }
      cur.input = Math.max(cur.input, b.input); cur.output = Math.max(cur.output, b.output); cur.cacheRead = Math.max(cur.cacheRead, b.cacheRead);
      cur.cacheWrite5m = Math.max(cur.cacheWrite5m, b.cacheWrite5m); cur.cacheWrite1h = Math.max(cur.cacheWrite1h, b.cacheWrite1h); cur.requests = Math.max(cur.requests, b.requests);
    }
    return out;
  };
  const dailyOut = merge(stored?.daily, daily);
  const hourFloor = hourKey(now - HOURLY_KEEP_DAYS * 86_400_000, tz);
  const hourlyOut = [...merge(stored?.hourly, hourly).values()].filter((b) => b.key >= hourFloor);
  priceBuckets(dailyOut.values(), overrides);
  priceBuckets(hourlyOut, overrides);
  const sort = (l: Bucket[]) => l.sort((a, b) => bucketKey(a).localeCompare(bucketKey(b)));
  // a new bank (or one already marked) is "none"; an older bank keeps meaning "legacy default roots"
  const bank: Bank = { ...(!stored || stored.rootsDefault === "none" ? { rootsDefault: "none" as const } : {}), v: 1, tz, priceTable: PRICE_TABLE_RETRIEVED, scheme: BANK_SCHEME, updatedAt: now, daily: sort([...dailyOut.values()]), hourly: sort(hourlyOut) };

  if (!dryRun) {
    // both written completely first, then renamed back to back: the buckets can never get ahead of the offsets
    const p = paths(dir);
    const bankTmp = `${p.bank}.${process.pid}.tmp`;
    const stateTmp = `${p.state}.${process.pid}.tmp`;
    writeFileSync(bankTmp, JSON.stringify(bank), { mode: 0o600 });
    writeFileSync(stateTmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(stateTmp, p.state);
    renameSync(bankTmp, p.bank);
    writePrivate(p.status, JSON.stringify({ startedAt: t0, finishedAt: now, ok: true } satisfies Status));
  }

  return {
    run: {
      mode: backfill ? "backfill" : first ? "first" : "incremental", tz, ...(note ? { note } : {}),
      claudeFiles: stats.claudeFiles, codexFiles: stats.codexFiles, filesRead: stats.filesRead, skipped: stats.skipped,
      bytesRead: io.bytes, usageLines: stats.usageLines, requests: stats.requests, ms: Date.now() - t0,
    },
    bank,
  };
}

/** Stat helper for tests / doctor: does the state dir have the right mode? */
export function stateDirMode(dir: string): number | null {
  try { return statSync(dir).mode & 0o777; } catch { return null; }
}
