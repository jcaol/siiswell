// SPDX-License-Identifier: Apache-2.0
/**
 * @file `siiswell usage push`: upload the banked DAILY rows in the v1 format of POST /api/ingest/usage (host token).
 * @module cli/usage/push
 *
 * Same contract and the same privacy semantics as the original host agent's usage pusher:
 *  - numbers and labels only: `{ day, project, agent, source, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, requests, usd }`;
 *  - a project folder name leaves the machine only when allowed: `projectNames` "other" (default: every project is `(other)`,
 *    its agent `(other)` too), "hashed" (`h-` + 12 hex of a salted SHA-256; the salt never leaves the state dir), "all"; names in
 *    `keep` always keep their name. A label the server would refuse is folded, never sent;
 *  - model ids outside the price table are `unknown`; a day over 300 keys is folded into one `(other)` row (nothing lost);
 *  - every request declares its days COMPLETE (the server replaces the host's rows of exactly those days), a day is never split;
 *  - a policy that became STRICTER, or `usage.enabled: false`, ERASES what this host label uploaded (`mode: "erase"` until
 *    `remaining: 0`) before anything else; a 429 stops and resumes on the next run (progress is kept).
 * The host label must be the NAME of the host token (the server answers 403 otherwise).
 */
import { createHash, randomBytes } from "node:crypto";
import { linkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRICE_TABLE_RETRIEVED, knownModelIds, normalizeModelId } from "../../../src/shared/pricing";
import type { ProjectNames } from "../config";
import { errorDetail, send, type FetchLike, type HttpResult } from "../http";
import { SUBAGENT, dayKey, ensureDir, readSmall, writePrivate, type Bucket } from "./collect";
import { APP_LABELS } from "./parse";

export interface UsageRow {
  day: string;
  project: string;
  agent: string;
  source: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  requests: number;
  usd: number | null;
}

/** An hourly row: the same labels and counters as a daily row, keyed by the local hour `YYYY-MM-DDTHH`. */
export interface HourlyRow extends Omit<UsageRow, "day"> {
  hour: string;
}

/** Rows (daily + hourly together) per request: the server takes at most 2000 daily and 4000 hourly rows per request. */
export const USAGE_BATCH_ROWS = 2000;
/** Hourly rows per host and day the server keeps (the rest of a day is folded per hour into `(other)`, nothing lost). */
export const USAGE_MAX_HOURLY_ROWS_PER_DAY = 1200;
/**
 * The attribution scheme: part of the full-history key, so a client that labels rows differently (here: the `agent` label became
 * the app, see rowAgent) re-sends its whole history once, and every day on the server is replaced.
 */
export const ATTRIBUTION_SCHEME = "app2"; // app2: Codex models from the rollout head (re-sends the history once)
export const USAGE_BATCH_DAYS = 35;
export const USAGE_MAX_ROWS_PER_DAY = 300;
export const USAGE_RECENT_WINDOW_MS = 30 * 3_600_000;
const OTHER = "(other)";
const LABEL_RE = /^[A-Za-z0-9._()@-]{1,64}$/;
const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KNOWN_MODELS = new Set(knownModelIds());

export function publicModelId(model: string): string {
  const id = normalizeModelId(String(model ?? ""));
  return KNOWN_MODELS.has(id) ? id : "unknown";
}

export interface Policy {
  enabled: boolean;
  projectNames: ProjectNames;
  keep: string[];
}

/** Everything about a policy that decides what leaves the machine. */
export function policyFingerprint(p: Policy): string {
  return `${p.enabled ? 1 : 0}|${p.projectNames}|${[...p.keep].sort().join(",")}`;
}

const RANK: Record<ProjectNames, number> = { other: 0, hashed: 1, all: 2 };

/** Is `now` stricter than the policy the rows on the server were uploaded under? An unreadable old fingerprint counts as stricter (fail closed). */
export function isStricter(oldFp: string | undefined, now: Policy): boolean {
  const m = typeof oldFp === "string" ? /^([01])\|(other|hashed|all)\|(.*)$/.exec(oldFp) : null;
  if (!m) return true;
  if (RANK[now.projectNames] < RANK[m[2] as ProjectNames]) return true;
  const keep = new Set(now.keep);
  for (const n of m[3] === "" ? [] : m[3]!.split(",")) if (!keep.has(n) && now.projectNames !== "all") return true;
  return false;
}

/** Salted project-name hash: `h-` + 12 hex. The salt is created once per state dir (0600) and never sent. */
export function projectHasher(stateDir: string): (name: string) => string {
  const file = join(stateDir, "usage-salt");
  const valid = (v: string | undefined): v is string => !!v && /^[0-9a-f]{32,}$/.test(v);
  let salt = readSmall(file, 1024)?.trim();
  if (!valid(salt)) {
    ensureDir(stateDir);
    // created atomically WITH its content (a private temp file hard-linked into place: link() fails if it exists), then
    // read back: two first runs at once both end up with the winner's salt, never two different ones
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, randomBytes(16).toString("hex"), { mode: 0o600 });
    try {
      linkSync(tmp, file);
    } catch (err) {
      // EEXIST: someone else won (read theirs below); an unreadable / invalid salt there is replaced
      if ((err as { code?: string }).code !== "EEXIST" || !valid(readSmall(file, 1024)?.trim())) renameSync(tmp, file);
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or gone */ }
    }
    salt = readSmall(file, 1024)?.trim();
    if (!valid(salt)) throw new Error("the project-name salt could not be created");
  }
  return (name) => `h-${createHash("sha256").update(`${salt}:${name}`).digest("hex").slice(0, 12)}`;
}

const num = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
const APPS = new Set<string>(APP_LABELS);
const GENERIC_AGENTS = new Set(["operator", "claude", "codex"]);

/**
 * The `agent` label of a row: the APP that produced the requests (parse.ts APP_LABELS, a fixed vocabulary that names no project,
 * so it is sent under every policy). Where project names may leave the machine, a worktree agent keeps its name after a dot
 * (`claude-cli.dev`); the project root and plain sessions are just the app (`claude-cli`). A bucket banked before apps were
 * recorded is `unknown`.
 */
export function rowAgent(b: Pick<Bucket, "agent" | "app">, named: boolean): string {
  const app = b.app && APPS.has(b.app) ? b.app : "unknown";
  if (b.agent === SUBAGENT) return `${app}.${SUBAGENT}`; // never an operator app label (the activity proxy), named or not
  if (!named || GENERIC_AGENTS.has(b.agent) || b.agent === OTHER) return app;
  const both = `${app}.${b.agent}`;
  return AGENT_RE.test(both) ? both : app;
}

/** The label a project folder name is uploaded as under the policy: the name (kept / "all"), its salted hash, or `(other)`. */
export function projectLabel(name: string, policy: Pick<Policy, "projectNames" | "keep">, hash: (name: string) => string): string {
  if (!LABEL_RE.test(name) || name === OTHER) return OTHER;
  if (policy.keep.includes(name) || policy.projectNames === "all") return name;
  return policy.projectNames === "hashed" ? hash(name) : OTHER;
}

type Agg = Omit<UsageRow, "day"> & { k: string };

/** Buckets -> labelled totals keyed by the bucket key (day or hour) under the policy: variants summed, labels folded. */
function aggregate(buckets: Iterable<Bucket>, policy: Policy, hash: (name: string) => string, sinceDay?: string): Agg[] {
  const out = new Map<string, Agg>();
  for (const b of buckets) {
    if (sinceDay && b.key.slice(0, 10) < sinceDay) continue;
    const valid = LABEL_RE.test(b.project) && b.project !== OTHER;
    let project = OTHER;
    let agent = rowAgent(b, false);
    // a worktree name can carry the project name: only a project shown by name keeps its agent; hashing keeps the app
    project = projectLabel(b.project, policy, hash);
    if (valid && project === b.project) agent = rowAgent(b, true);
    const source = b.source === "codex" ? "codex" : "claude";
    const model = publicModelId(b.model);
    const key = [b.key, project, agent, source, model].join("\t");
    let r = out.get(key);
    if (!r) {
      r = { k: b.key, project, agent, source, model, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0, usd: 0 };
      out.set(key, r);
    }
    r.input += num(b.input); r.output += num(b.output); r.cacheRead += num(b.cacheRead);
    r.cacheWrite5m += num(b.cacheWrite5m); r.cacheWrite1h += num(b.cacheWrite1h); r.requests += num(b.requests);
    r.usd = r.usd === null || b.usd === null ? null : r.usd + b.usd;
  }
  return [...out.values()];
}

const roundUsd = <T extends { usd: number | null }>(r: T): T => (r.usd === null ? r : { ...r, usd: Math.round(r.usd * 1e6) / 1e6 });
const sortKey = (k: string, r: Omit<UsageRow, "day">) => k + r.project + r.agent + r.source + r.model;

/** Banked daily buckets -> rows under the policy (variants summed, labels folded), sorted, each day at most USAGE_MAX_ROWS_PER_DAY rows. */
export function buildUsageRows(buckets: Iterable<Bucket>, policy: Policy, hash: (name: string) => string, sinceDay?: string): UsageRow[] {
  const rows = aggregate(buckets, policy, hash, sinceDay).map(({ k, ...r }) => ({ day: k, ...r }));
  return foldToDayCap(rows)
    .map(roundUsd)
    .sort((a, b) => sortKey(a.day, a).localeCompare(sortKey(b.day, b)));
}

/** Banked HOURLY buckets -> hourly rows under the same policy, sorted, each day at most USAGE_MAX_HOURLY_ROWS_PER_DAY rows. */
export function buildHourlyRows(buckets: Iterable<Bucket>, policy: Policy, hash: (name: string) => string, sinceDay?: string): HourlyRow[] {
  const rows = aggregate(buckets, policy, hash, sinceDay).map(({ k, ...r }) => ({ hour: k, ...r }));
  return foldHourlyToDayCap(rows)
    .map(roundUsd)
    .sort((a, b) => sortKey(a.hour, a).localeCompare(sortKey(b.hour, b)));
}

/** A day over the hourly cap keeps its largest rows; the rest is folded into one `(other)` row PER HOUR (nothing lost). */
export function foldHourlyToDayCap(rows: HourlyRow[], cap = USAGE_MAX_HOURLY_ROWS_PER_DAY): HourlyRow[] {
  const byDay = new Map<string, HourlyRow[]>();
  for (const r of rows) (byDay.get(r.hour.slice(0, 10)) ?? byDay.set(r.hour.slice(0, 10), []).get(r.hour.slice(0, 10))!).push(r);
  const out: HourlyRow[] = [];
  for (const list of byDay.values()) {
    if (list.length <= cap) { out.push(...list); continue; }
    const size = (r: HourlyRow) => r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    const key = (r: HourlyRow) => [r.hour, r.project, r.agent, r.source, r.model].join("\t");
    const sorted = [...list].sort((a, b) => size(b) - size(a) || key(a).localeCompare(key(b)));
    out.push(...sorted.slice(0, cap - 24)); // room for one folded row per hour
    const folded = new Map<string, HourlyRow>();
    for (const r of sorted.slice(cap - 24)) {
      let f = folded.get(r.hour);
      if (!f) folded.set(r.hour, (f = { hour: r.hour, project: OTHER, agent: OTHER, source: "(mixed)", model: "unknown", input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0, usd: 0 }));
      f.input += r.input; f.output += r.output; f.cacheRead += r.cacheRead;
      f.cacheWrite5m += r.cacheWrite5m; f.cacheWrite1h += r.cacheWrite1h; f.requests += r.requests;
      f.usd = f.usd === null || r.usd === null ? null : f.usd + r.usd;
    }
    out.push(...folded.values());
  }
  return out;
}

export function foldToDayCap(rows: UsageRow[], cap = USAGE_MAX_ROWS_PER_DAY): UsageRow[] {
  const byDay = new Map<string, UsageRow[]>();
  for (const r of rows) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const out: UsageRow[] = [];
  for (const [day, list] of byDay) {
    if (list.length <= cap) { out.push(...list); continue; }
    const size = (r: UsageRow) => r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    const key = (r: UsageRow) => [r.project, r.agent, r.source, r.model].join("\t");
    const sorted = [...list].sort((a, b) => size(b) - size(a) || key(a).localeCompare(key(b)));
    out.push(...sorted.slice(0, cap - 1));
    const folded: UsageRow = { day, project: OTHER, agent: OTHER, source: "(mixed)", model: "unknown", input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0, usd: 0 };
    for (const r of sorted.slice(cap - 1)) {
      folded.input += r.input; folded.output += r.output; folded.cacheRead += r.cacheRead;
      folded.cacheWrite5m += r.cacheWrite5m; folded.cacheWrite1h += r.cacheWrite1h; folded.requests += r.requests;
      folded.usd = folded.usd === null || r.usd === null ? null : folded.usd + r.usd;
    }
    out.push(folded);
  }
  return out;
}

export interface DayBatch { days: string[]; rows: UsageRow[]; hourly: HourlyRow[] }

/**
 * Cut ascending `days` into requests of at most `size` rows (daily and hourly together) and `maxDays` days, never splitting a day
 * (neither its daily nor its hourly rows). Always at least one batch.
 */
export function dayBatches(days: string[], rows: UsageRow[], size = USAGE_BATCH_ROWS, maxDays = USAGE_BATCH_DAYS, hourly: HourlyRow[] = []): DayBatch[] {
  const byDay = new Map<string, UsageRow[]>();
  for (const r of rows) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const hByDay = new Map<string, HourlyRow[]>();
  for (const r of hourly) (hByDay.get(r.hour.slice(0, 10)) ?? hByDay.set(r.hour.slice(0, 10), []).get(r.hour.slice(0, 10))!).push(r);
  const out: DayBatch[] = [];
  let cur: DayBatch = { days: [], rows: [], hourly: [] };
  for (const d of days) {
    const rs = byDay.get(d) ?? [];
    const hs = hByDay.get(d) ?? [];
    if (cur.days.length && (cur.rows.length + cur.hourly.length + rs.length + hs.length > size || cur.days.length >= maxDays)) {
      out.push(cur);
      cur = { days: [], rows: [], hourly: [] };
    }
    cur.days.push(d);
    cur.rows.push(...rs);
    cur.hourly.push(...hs);
  }
  out.push(cur);
  return out;
}

export function calendarDays(from: string, to: string, max = 60): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); Number.isFinite(t) && t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out.slice(-max);
}

/**
 * The full-history key: a new price table, time zone, policy, attribution scheme or set of roots re-sends the whole history (the
 * roots decide the project of every banked cwd, so changing them re-attributes the history on the dashboard too).
 */
export function fullKeyOf(tz: string, policy: Policy, roots: string[] = []): string {
  const p = createHash("sha1").update(`${policy.projectNames}|${[...policy.keep].sort().join(",")}|${ATTRIBUTION_SCHEME}|${[...roots].sort().join("\n")}`).digest("hex").slice(0, 12);
  return `${PRICE_TABLE_RETRIEVED}|${tz}|${p}`;
}

/**
 * The v1 body of one upload request (the host agent's pusher sends the same without `hourly`). `hourly` is optional and additive: a
 * server that does not know it ignores it; one that does replaces the host's hourly rows of exactly the `completeDays`.
 */
export function uploadBody(host: string, tz: string, generatedAt: number, mode: "recent" | "full", complete: boolean, rows: UsageRow[], hourly?: HourlyRow[]): Record<string, unknown> {
  return { v: 1, host, tz, generatedAt, mode, complete, completeDays: [...new Set(rows.map((r) => r.day))], rows, ...(hourly ? { hourly } : {}) };
}

// ── push state (per target `<origin>|<host>`) ──────────────────────────

export interface PushedState {
  version: number;
  fullKey: string;
  policyFp?: string;
  progress?: { fullKey: string; through: string };
  erase?: "pending" | "done";
  fullAt?: number;
}
type StateFile = { v: 1; targets: Record<string, PushedState> };
const pushStatePath = (dir: string) => join(dir, "usage-push-state.json");

export function readPushedState(target: string, dir: string): PushedState | null {
  try {
    const f = JSON.parse(readSmall(pushStatePath(dir), 1 << 20) ?? "null") as StateFile | null;
    const t = f?.v === 1 ? f.targets?.[target] : undefined;
    return t && typeof t.version === "number" && typeof t.fullKey === "string" ? t : null;
  } catch {
    return null;
  }
}

export function writePushedState(target: string, st: PushedState, dir: string): void {
  let f: StateFile = { v: 1, targets: {} };
  try {
    const old = JSON.parse(readSmall(pushStatePath(dir), 1 << 20) ?? "null") as StateFile | null;
    if (old?.v === 1 && old.targets) f = old;
  } catch { /* none */ }
  f.targets[target] = st;
  ensureDir(dir);
  writePrivate(pushStatePath(dir), JSON.stringify(f));
}

// ── the push ──────────────────────────────────────────────────────────

export interface PushOptions {
  base: string;
  hostToken: string;
  host: string;
  stateDir: string;
  policy: Policy;
  tz: string;
  daily: Bucket[];
  /** hourly buckets: uploaded with the days they belong to (absent = no hourly block is sent) */
  hourly?: Bucket[];
  /** the configured roots (part of the full-history key: a change re-sends the history under the new attribution) */
  roots?: string[];
  /** the collect run the rows come from (`generatedAt`) */
  version: number;
  now?: number;
  fetch?: FetchLike;
  log: (msg: string) => void;
  dryRun?: boolean;
}

export interface PushResult {
  ok: boolean;
  /** what happened, for the CLI's output */
  summary: string;
  requests: number;
  rowsSent: number;
  /** hourly rows sent (or, in a dry run, that would be) */
  hourlySent?: number;
  /** a 429: the run stopped and resumes later */
  retryAfterS?: number;
  status?: number;
  erased?: boolean;
  /** dry run: the request bodies that WOULD be sent */
  bodies?: Record<string, unknown>[];
}

const RETRY = (r: HttpResult): number => Number(r.headers.get("retry-after") ?? NaN);

export async function pushUsage(o: PushOptions): Promise<PushResult> {
  const now = o.now ?? Date.now();
  const target = `${o.base}|${o.host}`;
  const res: PushResult = { ok: true, summary: "", requests: 0, rowsSent: 0 };
  const bodies: Record<string, unknown>[] = [];
  const post = async (body: Record<string, unknown>): Promise<HttpResult | null> => {
    if (o.dryRun) {
      bodies.push(body);
      return null;
    }
    res.requests++;
    return send(o.base, "/api/ingest/usage", { token: o.hostToken, body: JSON.stringify(body), fetch: o.fetch, timeoutMs: 60_000 });
  };
  const fail = (r: HttpResult, what: string): PushResult => {
    const detail = errorDetail(r);
    const retry = RETRY(r);
    return {
      ...res, ok: false, status: r.status, ...(r.status === 429 && Number.isFinite(retry) ? { retryAfterS: retry } : {}),
      summary: `${what}: HTTP ${r.status}${detail ? ` (${detail})` : ""}${r.status === 403 ? ` - the host label "${o.host}" must be the name of this host token` : ""}${r.status === 429 ? " - will continue on a later run" : ""}`,
    };
  };

  const erase = async (fp: string | undefined): Promise<PushResult | null> => {
    const cur = readPushedState(target, o.stateDir);
    if (!o.dryRun) writePushedState(target, { version: cur?.version ?? 0, fullKey: cur?.fullKey ?? "", ...(cur?.policyFp ? { policyFp: cur.policyFp } : {}), erase: "pending" }, o.stateDir);
    for (let i = 0; i < 20; i++) {
      const r = await post({ v: 1, host: o.host, mode: "erase" });
      if (!r) return null;
      if (r.status < 200 || r.status >= 300) return fail(r, "erase");
      if ((r.json as { remaining?: number } | null)?.remaining === 0) {
        writePushedState(target, { version: 0, fullKey: "", erase: "done", ...(fp ? { policyFp: fp } : {}) }, o.stateDir);
        res.erased = true;
        return null;
      }
    }
    return { ...res, ok: false, summary: "erase: more rows remain, continuing on the next run" };
  };

  const st0 = readPushedState(target, o.stateDir);
  if (!o.policy.enabled) {
    if (!st0 || st0.erase === "done") return { ...res, summary: "usage upload is disabled; nothing was uploaded from this host label" };
    const e = await erase(undefined);
    if (e) return e;
    return { ...res, ...(o.dryRun ? { bodies } : {}), summary: o.dryRun ? "usage upload is disabled: would erase this host's rows on the dashboard" : "usage upload is disabled: this host's usage rows were erased on the dashboard" };
  }

  const fp = policyFingerprint(o.policy);
  const fullKey = fullKeyOf(o.tz, o.policy, o.roots);
  if (st0 && st0.erase !== "done" && (st0.erase === "pending" || (st0.policyFp !== fp && isStricter(st0.policyFp, o.policy)))) {
    const e = await erase(fp);
    if (e) return e;
  }

  const hash = projectHasher(o.stateDir);
  const all = buildUsageRows(o.daily, o.policy, hash);
  const allHourly = o.hourly ? buildHourlyRows(o.hourly, o.policy, hash) : undefined;
  const hourlyFor = (b: DayBatch) => (allHourly ? b.hourly : undefined);
  const stored = o.dryRun ? st0 : readPushedState(target, o.stateDir);

  // recent: from 30 h before the older of now and the last delivered version (at most 35 days back) to today; every day declared complete
  const base = stored && stored.version > 0 ? Math.min(now, stored.version) : now;
  const since = dayKey(Math.max(base, now - 35 * 86_400_000) - USAGE_RECENT_WINDOW_MS, o.tz);
  let needFull = false;
  for (const b of dayBatches(calendarDays(since, dayKey(now, o.tz)), all.filter((r) => r.day >= since), USAGE_BATCH_ROWS, USAGE_BATCH_DAYS, (allHourly ?? []).filter((r) => r.hour >= since))) {
    const r = await post(uploadBody(o.host, o.tz, o.version, "recent", false, b.rows, hourlyFor(b)));
    res.rowsSent += b.rows.length;
    res.hourlySent = (res.hourlySent ?? 0) + (allHourly ? b.hourly.length : 0);
    if (!r) continue;
    if (r.status < 200 || r.status >= 300) return fail(r, "upload (recent days)");
    if ((r.json as { needFull?: boolean } | null)?.needFull === true) needFull = true;
  }

  const resuming = stored?.progress?.fullKey === fullKey;
  const stateWantsFull = !stored || stored.fullKey !== fullKey || resuming;
  // the server saying it lacks the history is honoured at most once a day (it may keep saying so when the history is empty)
  const wantFull = stateWantsFull || (needFull && (!stored?.fullAt || now - stored.fullAt >= 86_400_000));
  let fullSent = false;
  if (wantFull) {
    const through = resuming ? stored!.progress!.through : "";
    const days = [...new Set(all.map((r) => r.day))].sort().filter((d) => d > through);
    const parts = dayBatches(days, all.filter((r) => r.day > through), USAGE_BATCH_ROWS, USAGE_BATCH_DAYS, (allHourly ?? []).filter((r) => r.hour.slice(0, 10) > through));
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const r = await post(uploadBody(o.host, o.tz, o.version, "full", last, parts[i]!.rows, hourlyFor(parts[i]!)));
      res.rowsSent += parts[i]!.rows.length;
      res.hourlySent = (res.hourlySent ?? 0) + (allHourly ? parts[i]!.hourly.length : 0);
      if (!r) continue;
      if (r.status < 200 || r.status >= 300) return fail(r, "upload (history)");
      const reached = parts[i]!.days[parts[i]!.days.length - 1];
      if (!last && reached) writePushedState(target, { ...(readPushedState(target, o.stateDir) ?? { version: 0, fullKey: "" }), policyFp: fp, progress: { fullKey, through: reached } }, o.stateDir);
    }
    fullSent = true;
  }
  if (o.dryRun) return { ...res, bodies, summary: `dry run: ${bodies.length} request(s), ${res.rowsSent} row(s) would be sent` };
  writePushedState(target, { version: o.version, fullKey, policyFp: fp, ...(fullSent ? { fullAt: now } : stored?.fullAt !== undefined && stored.fullKey === fullKey ? { fullAt: stored.fullAt } : {}) }, o.stateDir);
  return { ...res, summary: `uploaded ${res.rowsSent} row(s) in ${res.requests} request(s)${fullSent ? " (including the whole history)" : ""}${res.erased ? " after erasing the rows of an older, looser policy" : ""}` };
}
