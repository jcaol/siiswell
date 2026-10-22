/**
 * @file Usage and API-equivalent cost: POST /api/ingest/usage (host token) and GET /api/usage (Cloudflare Access).
 * @module dashboard-worker/usage
 *
 * NUMBERS AND LABELS ONLY. A usage row carries a day, five label strings (project, agent, source, model; the host is the
 * token-bound label) and counters; there is no free text anywhere in it, so nothing goes through `clipText` / the text
 * redaction: every string is VALIDATED against a strict character set and the request is refused with 400 when one does
 * not match (never rewritten: that would make two names collide). Dollars are "API-equivalent": what the tokens would
 * cost at the vendors' public API prices (null = the model has no known price), NOT a bill.
 *
 * Ingest: the sender is never trusted.
 *  - the payload `host` must equal the token's host label (403), and every write uses the token-bound label, so a leaked
 *    token can only overwrite that host's own numbers (the key has the host in it);
 *  - at most MAX_USAGE_ROWS_PER_REQUEST rows and MAX_USAGE_BODY_BYTES bytes; days outside [retention window .. tomorrow] are
 *    dropped (counted), so nothing is stored that the purge would not also delete;
 *  - the host's own budget: MAX_USAGE_ROWS_PER_HOST_PER_DAY rows per fixed 24 h window (claimed BEFORE writing, one
 *    statement on `usage_hosts`) and MAX_USAGE_ROWS_PER_HOST_DAY distinct rows per host and day (invented labels cannot
 *    grow the table); the usual per-token request rate limit applies as for every ingest route;
 *  - the upsert is idempotent and writes only a row whose numbers CHANGED (a re-sent unchanged day costs no write).
 *
 * HOURLY rows (migration 0005) ride in the same request as an optional `hourly` block (additive: a sender that does not send it leaves
 * the hourly table alone, an older Worker ignores it): the same labels, caps and privacy rules, keyed by the local hour, kept
 * USAGE_HOURLY_RETENTION_DAYS. A day named in `completeDays` is authoritative for its hours too when the block is present.
 *
 * Read: `GET /api/usage?from&to&group=day|month`, `GET /api/usage?day=YYYY-MM-DD&group=hour` (one day's 24 hours) and
 * `GET /api/usage?group=insights` (the overview's compact aggregates), sit behind the same gate as /api/state (cross-site guard, Access JWT,
 * e-mail allow-list: see index.ts) and is NOT part of /api/state (the 60 s poll stays small). Every query is bounded.
 */
import { dashboardTz } from "./tz";
import { authenticateBearer } from "./auth";
import { claimHostWrites } from "./budget";
import { all, stmt } from "./db";
import {
  MAX_PROJECTS_PER_HOST,
  MAX_USAGE_BODY_BYTES,
  MAX_USAGE_BREAKDOWN,
  MAX_USAGE_HOURLY_ROWS_PER_HOST_DAY,
  MAX_USAGE_HOURLY_ROWS_PER_REQUEST,
  MAX_USAGE_PROJECTS,
  MAX_USAGE_RANGE_DAYS,
  MAX_USAGE_ROWS_PER_HOST_DAY,
  MAX_USAGE_ROWS_PER_HOST_PER_DAY,
  MAX_USAGE_ROWS_PER_REQUEST,
  USAGE_HOURLY_RETENTION_DAYS,
  WRITE_COST,
  hostWriteBudget,
  usageRetentionDaysOf,
  type Env,
} from "./env";
import { knownModelIds, normalizeModelId } from "./shared/pricing";
import { readJsonBody } from "./ingest";
import { BadRequest, errorJson, isObj, json } from "./util";

const DAY_MS = 86_400_000;

/** Labels: project, agent, source. `(other)` is the bucket of every folder that is not a named project. */
export const USAGE_LABEL_RE = /^[A-Za-z0-9._()@-]{1,64}$/;
/** Agent names: worktree names, `operator`, a CLI name; no `@`. `(other)` is what every agent of a folded project is called. */
export const USAGE_AGENT_RE = /^(?:[A-Za-z0-9._-]{1,64}|\(other\))$/;
/**
 * Model ids are NOT free text: only ids of the price table (src/shared/model-prices.json, normalised the way pricing.ts matches them) are
 * stored, everything else - a fine-tune named after a client, a Bedrock ARN with an account id, a custom provider URL - is `unknown`
 * (its tokens still count, unpriced). The sender already sends only table ids; this is the same rule on the Worker's side.
 */
const KNOWN_MODELS = new Set(knownModelIds());
export const UNKNOWN_MODEL = "unknown";
export function usageModel(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 200) return null;
  const id = normalizeModelId(v);
  return KNOWN_MODELS.has(id) ? id : UNKNOWN_MODEL;
}
const TZ_RE = /^[A-Za-z0-9_/+-]{1,40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3])$/;

/**
 * Counter bounds per row-day (a row above these is a bug or an attack, not a day of usage). They also keep every SUM far below
 * 2^63 (SQLite raises "integer overflow" past it): 1e11 x the at most 500 rows per host and day x 400 days x 50 hosts is ~1e18, and the
 * read side uses TOTAL() anyway, so rows written before the cap existed cannot break it either.
 */
export const MAX_USAGE_TOKENS = 1e11;
export const MAX_USAGE_REQUESTS = 1e7;
export const MAX_USAGE_USD = 1e7;
const MAX_TOKENS = MAX_USAGE_TOKENS;
const MAX_REQUESTS = MAX_USAGE_REQUESTS;
const MAX_USD = MAX_USAGE_USD;

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

const isDay = (s: unknown): s is string => {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function label(v: unknown, re: RegExp, field: string): string {
  if (typeof v !== "string" || !re.test(v)) throw new BadRequest(`${field} must match ${re.source}`);
  return v;
}
function counter(v: unknown, max: number, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) throw new BadRequest(`${field} must be a finite number between 0 and ${max}`);
  return Math.round(v);
}

/** Validate one row; throws BadRequest (with the row index) on anything that is not exactly the documented shape. */
export function sanitizeUsageRow(raw: unknown, i: number): UsageRow {
  const where = (f: string) => `rows[${i}].${f}`;
  if (!isObj(raw)) throw new BadRequest(`rows[${i}] must be an object`);
  if (!isDay(raw.day)) throw new BadRequest(`${where("day")} must be a calendar day YYYY-MM-DD`);
  let usd: number | null = null;
  if (raw.usd !== null && raw.usd !== undefined) {
    if (typeof raw.usd !== "number" || !Number.isFinite(raw.usd) || raw.usd < 0 || raw.usd > MAX_USD) throw new BadRequest(`${where("usd")} must be null or a number between 0 and ${MAX_USD}`);
    usd = Math.round(raw.usd * 1e6) / 1e6;
  }
  return {
    day: raw.day,
    project: label(raw.project, USAGE_LABEL_RE, where("project")),
    agent: label(raw.agent, USAGE_AGENT_RE, where("agent")),
    source: label(raw.source, USAGE_LABEL_RE, where("source")),
    model: usageModel(raw.model) ?? (() => { throw new BadRequest(`${where("model")} must be a string`); })(),
    input: counter(raw.input, MAX_TOKENS, where("input")),
    output: counter(raw.output, MAX_TOKENS, where("output")),
    cacheRead: counter(raw.cacheRead, MAX_TOKENS, where("cacheRead")),
    cacheWrite5m: counter(raw.cacheWrite5m, MAX_TOKENS, where("cacheWrite5m")),
    cacheWrite1h: counter(raw.cacheWrite1h, MAX_TOKENS, where("cacheWrite1h")),
    requests: counter(raw.requests, MAX_REQUESTS, where("requests")),
    usd,
  };
}

const rowKey = (r: Pick<UsageRow, "day" | "project" | "agent" | "source" | "model">): string => [r.day, r.project, r.agent, r.source, r.model].join("\t");

/** An hourly row: a daily row keyed by the local hour `YYYY-MM-DDTHH` instead of the day. */
export interface HourlyUsageRow extends Omit<UsageRow, "day"> {
  hour: string;
}
const hourDay = (h: string): string => h.slice(0, 10);

/** Validate one hourly row (`hourly[i]`): the same rules as a daily row. */
export function sanitizeHourlyRow(raw: unknown, i: number): HourlyUsageRow {
  if (!isObj(raw)) throw new BadRequest(`hourly[${i}] must be an object`);
  const m = typeof raw.hour === "string" ? HOUR_RE.exec(raw.hour) : null;
  if (!m || !isDay(m[1])) throw new BadRequest(`hourly[${i}].hour must be a local hour YYYY-MM-DDTHH (00-23)`);
  const { day: _d, ...r } = sanitizeUsageRow({ ...raw, day: m[1] }, i);
  return { hour: raw.hour as string, ...r };
}

export interface UsageBatch {
  host: string;
  tz: string;
  generatedAt: number;
  full: boolean;
  complete: boolean;
  /**
   * AUTHORITATIVE days: the request carries ALL rows of this host for exactly these days (a day is never split across requests),
   * so the host's other rows for those days (a project that left the dashboard, a name that the privacy policy now folds into
   * `(other)`) are deleted in the same transaction (only days that have rows in the request can be named). null = the sender did not say: nothing is deleted.
   */
  completeDays: string[] | null;
  rows: UsageRow[];
  /** the optional hourly block; null = the sender sent none (the host's hourly rows are left alone) */
  hourly: HourlyUsageRow[] | null;
}

/**
 * Most DISTINCT days one request may carry or declare complete: the INSERT counts each day it touches (<= the per-day cap in rows), so this bounds the
 * rows one request makes the Worker read (35 x 300) before any of it happens. The pusher cuts its uploads into batches of at most 35 days.
 */
export const MAX_USAGE_COMPLETE_DAYS = 35;

/** Validate the whole body. Duplicate keys inside one request: the later row wins. */
export function sanitizeUsageBatch(body: unknown, now: number, defaultTz: string = dashboardTz()): { ok: true; value: UsageBatch } | { ok: false; error: string } {
  try {
    if (!isObj(body)) throw new BadRequest("body must be a JSON object");
    if (body.v !== 1) throw new BadRequest("v must be 1");
    const host = label(body.host, /^[A-Za-z0-9._-]{1,64}$/, "host");
    const tz = body.tz === undefined ? defaultTz : label(body.tz, TZ_RE, "tz");
    const g = body.generatedAt;
    const generatedAt = typeof g === "number" && Number.isFinite(g) ? Math.max(0, Math.min(g, now)) : now;
    if (body.mode !== undefined && body.mode !== "recent" && body.mode !== "full") throw new BadRequest("mode must be 'recent' or 'full'");
    if (!Array.isArray(body.rows)) throw new BadRequest("rows must be an array");
    if (body.rows.length > MAX_USAGE_ROWS_PER_REQUEST) throw new BadRequest(`at most ${MAX_USAGE_ROWS_PER_REQUEST} rows per request, got ${body.rows.length}`);
    let completeDays: string[] | null = null;
    if (body.completeDays !== undefined && body.completeDays !== null) {
      if (!Array.isArray(body.completeDays) || body.completeDays.length > MAX_USAGE_COMPLETE_DAYS) throw new BadRequest(`completeDays must be an array of at most ${MAX_USAGE_COMPLETE_DAYS} days`);
      if (!body.completeDays.every(isDay)) throw new BadRequest("completeDays must be calendar days YYYY-MM-DD");
      completeDays = [...new Set(body.completeDays as string[])].sort();
    }
    const byKey = new Map<string, UsageRow>();
    body.rows.forEach((r, i) => {
      const row = sanitizeUsageRow(r, i);
      if (completeDays && !completeDays.includes(row.day)) throw new BadRequest(`rows[${i}].day is not in completeDays`);
      byKey.set(rowKey(row), row);
    });
    // completeDays may only name days that HAVE rows in this request: a request cannot delete (or make the Worker scan) a day it sends nothing for.
    if (completeDays) {
      const have = new Set([...byKey.values()].map((r) => r.day));
      if (!completeDays.every((d) => have.has(d))) throw new BadRequest("completeDays may only name days that have rows in this request");
    }
    const days = new Set([...byKey.values()].map((r) => r.day));
    if (days.size > MAX_USAGE_COMPLETE_DAYS) throw new BadRequest(`a request may carry rows of at most ${MAX_USAGE_COMPLETE_DAYS} distinct days`);
    // The hourly block (optional): only hours of days this request carries daily rows for, so it adds no day to scan or replace.
    let hourly: HourlyUsageRow[] | null = null;
    if (body.hourly !== undefined && body.hourly !== null) {
      if (!Array.isArray(body.hourly)) throw new BadRequest("hourly must be an array");
      if (body.hourly.length > MAX_USAGE_HOURLY_ROWS_PER_REQUEST) throw new BadRequest(`at most ${MAX_USAGE_HOURLY_ROWS_PER_REQUEST} hourly rows per request, got ${body.hourly.length}`);
      const hk = new Map<string, HourlyUsageRow>();
      body.hourly.forEach((r, i) => {
        const row = sanitizeHourlyRow(r, i);
        if (!days.has(hourDay(row.hour))) throw new BadRequest(`hourly[${i}].hour is not on a day that this request carries rows for`);
        hk.set([row.hour, row.project, row.agent, row.source, row.model].join("\t"), row);
      });
      hourly = [...hk.values()];
    }
    return { ok: true, value: { host, tz, generatedAt, full: body.mode === "full", complete: body.complete === true, completeDays, rows: [...byKey.values()], hourly } };
  } catch (err) {
    if (err instanceof BadRequest) return { ok: false, error: err.message };
    throw err;
  }
}

/** Claim `?5` rows of the host's window (`?6` its length, `?7` the cap) and stamp its liveness: ONE statement; no row back = over budget. */
export const SQL_USAGE_CLAIM = `INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count)
  VALUES (?1, ?2, ?3, ?4, 0, ?2, ?5)
  ON CONFLICT(host) DO UPDATE SET
    pushed_at = ?2, generated_at = ?3, tz = ?4,
    win_start = CASE WHEN ?2 - usage_hosts.win_start >= ?6 THEN ?2 ELSE usage_hosts.win_start END,
    win_count = CASE WHEN ?2 - usage_hosts.win_start >= ?6 THEN ?5 ELSE usage_hosts.win_count + ?5 END
  WHERE ?2 - usage_hosts.win_start >= ?6 OR usage_hosts.win_count + ?5 <= ?7
  RETURNING has_full, win_start`;

/**
 * Write a chunk in TWO statements of the same batch (one transaction), `?1` JSON array of [day, project, agent, source, model, in, out,
 * cr, cw5, cw1, req, usd], `?2` host, `?3` now, `?4` the per-host-and-day row cap:
 *  - INSERT of the rows that do not exist yet, ONLY while the day has room: `rn` numbers the new rows of each day and the row goes in
 *    when `rn + (rows the host already holds that day) <= cap`; the holdings are counted ONCE per distinct day by one GROUP BY (`cnt`, a
 *    seek per day, at most the cap in rows each), never per row. The count is taken by the very statement that inserts (SQLite reads the
 *    source rows before it writes, and D1 runs one write statement at a time), so concurrent requests cannot both pass a stale count:
 *    the cap holds exactly, whatever the interleaving;
 *  - UPDATE of the existing rows whose numbers CHANGED (an unchanged re-send writes nothing).
 */
const SRC = `SELECT json_extract(value, '$[0]') AS day, json_extract(value, '$[1]') AS project, json_extract(value, '$[2]') AS agent,
        json_extract(value, '$[3]') AS source, json_extract(value, '$[4]') AS model, json_extract(value, '$[5]') AS input,
        json_extract(value, '$[6]') AS output, json_extract(value, '$[7]') AS cache_read, json_extract(value, '$[8]') AS cache_write_5m,
        json_extract(value, '$[9]') AS cache_write_1h, json_extract(value, '$[10]') AS requests, json_extract(value, '$[11]') AS usd
   FROM json_each(?1)`;
export const SQL_USAGE_INSERT = `WITH src AS (${SRC}),
  newr AS (SELECT src.*, ROW_NUMBER() OVER (PARTITION BY src.day ORDER BY src.project, src.agent, src.source, src.model) AS rn
             FROM src
            WHERE NOT EXISTS (SELECT 1 FROM usage_daily u WHERE u.day = src.day AND u.host = ?2 AND u.project = src.project AND u.agent = src.agent AND u.source = src.source AND u.model = src.model)),
  cnt AS (SELECT day, COUNT(*) AS c FROM usage_daily WHERE host = ?2 AND day IN (SELECT DISTINCT day FROM newr) GROUP BY day)
  INSERT OR IGNORE INTO usage_daily (day, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated)
  SELECT n.day, ?2, n.project, n.agent, n.source, n.model, n.input, n.output, n.cache_read, n.cache_write_5m, n.cache_write_1h, n.requests, n.usd, ?3
    FROM newr n LEFT JOIN cnt ON cnt.day = n.day
   WHERE n.rn + COALESCE(cnt.c, 0) <= ?4`;
export const SQL_USAGE_UPDATE = `UPDATE usage_daily SET input = src.input, output = src.output, cache_read = src.cache_read, cache_write_5m = src.cache_write_5m,
    cache_write_1h = src.cache_write_1h, requests = src.requests, usd = src.usd, updated = ?3
  FROM (${SRC}) src
 WHERE usage_daily.day = src.day AND usage_daily.host = ?2 AND usage_daily.project = src.project AND usage_daily.agent = src.agent
   AND usage_daily.source = src.source AND usage_daily.model = src.model
   AND (usage_daily.input IS NOT src.input OR usage_daily.output IS NOT src.output OR usage_daily.cache_read IS NOT src.cache_read
     OR usage_daily.cache_write_5m IS NOT src.cache_write_5m OR usage_daily.cache_write_1h IS NOT src.cache_write_1h
     OR usage_daily.requests IS NOT src.requests OR usage_daily.usd IS NOT src.usd)`;

/**
 * Remove the host's rows of the given days (`?1` JSON array of days, `?2` host) that are NOT among the keys in `?3` (JSON array of
 * [day, project, agent, source, model]). One statement per group of days (the keys of a day are never split), always BEFORE the
 * inserts of the same transaction so the removed rows free room under the per-day cap. Bounded by what the host holds for those days.
 */
export const SQL_USAGE_DELETE_STALE = `DELETE FROM usage_daily WHERE host = ?2 AND day IN (SELECT value FROM json_each(?1))
  AND (day, project, agent, source, model) NOT IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]') FROM json_each(?3))`;

/** How many of `?1` (JSON array of [day, project, agent, source, model]) are stored for host `?2`: one primary-key lookup per key. */
export const SQL_USAGE_PRESENT = `SELECT COUNT(*) AS c FROM json_each(?1) j JOIN usage_daily u
  ON u.day = json_extract(j.value, '$[0]') AND u.host = ?2 AND u.project = json_extract(j.value, '$[1]') AND u.agent = json_extract(j.value, '$[2]')
 AND u.source = json_extract(j.value, '$[3]') AND u.model = json_extract(j.value, '$[4]')`;

// ── hourly (migration 0005): the same statements over usage_hourly; a day is the range `D || 'T00' .. D || 'T23'` of the key ──
const HSRC = SRC.replace("AS day,", "AS hour,");
export const SQL_HOURLY_INSERT = `WITH src AS (${HSRC}),
  newr AS (SELECT src.*, ROW_NUMBER() OVER (PARTITION BY substr(src.hour, 1, 10) ORDER BY src.hour, src.project, src.agent, src.source, src.model) AS rn
             FROM src
            WHERE NOT EXISTS (SELECT 1 FROM usage_hourly u WHERE u.hour = src.hour AND u.host = ?2 AND u.project = src.project AND u.agent = src.agent AND u.source = src.source AND u.model = src.model)),
  d AS (SELECT DISTINCT substr(hour, 1, 10) AS day FROM newr),
  cnt AS (SELECT d.day, (SELECT COUNT(*) FROM usage_hourly u WHERE u.hour BETWEEN d.day || 'T00' AND d.day || 'T23' AND u.host = ?2) AS c FROM d)
  INSERT OR IGNORE INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated)
  SELECT n.hour, ?2, n.project, n.agent, n.source, n.model, n.input, n.output, n.cache_read, n.cache_write_5m, n.cache_write_1h, n.requests, n.usd, ?3
    FROM newr n LEFT JOIN cnt ON cnt.day = substr(n.hour, 1, 10)
   WHERE n.rn + COALESCE(cnt.c, 0) <= ?4`;
export const SQL_HOURLY_UPDATE = `UPDATE usage_hourly SET input = src.input, output = src.output, cache_read = src.cache_read, cache_write_5m = src.cache_write_5m,
    cache_write_1h = src.cache_write_1h, requests = src.requests, usd = src.usd, updated = ?3
  FROM (${HSRC}) src
 WHERE usage_hourly.hour = src.hour AND usage_hourly.host = ?2 AND usage_hourly.project = src.project AND usage_hourly.agent = src.agent
   AND usage_hourly.source = src.source AND usage_hourly.model = src.model
   AND (usage_hourly.input IS NOT src.input OR usage_hourly.output IS NOT src.output OR usage_hourly.cache_read IS NOT src.cache_read
     OR usage_hourly.cache_write_5m IS NOT src.cache_write_5m OR usage_hourly.cache_write_1h IS NOT src.cache_write_1h
     OR usage_hourly.requests IS NOT src.requests OR usage_hourly.usd IS NOT src.usd)`;
/** `?1` days (JSON), `?2` host, `?3` keys to keep [hour, project, agent, source, model], `?4` / `?5` the first / last hour of the group: a range seek. */
export const SQL_HOURLY_DELETE_STALE = `DELETE FROM usage_hourly WHERE host = ?2 AND hour BETWEEN ?4 AND ?5 AND substr(hour, 1, 10) IN (SELECT value FROM json_each(?1))
  AND (hour, project, agent, source, model) NOT IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]') FROM json_each(?3))`;
export const SQL_HOURLY_PRESENT = `SELECT COUNT(*) AS c FROM json_each(?1) j JOIN usage_hourly u
  ON u.hour = json_extract(j.value, '$[0]') AND u.host = ?2 AND u.project = json_extract(j.value, '$[1]') AND u.agent = json_extract(j.value, '$[2]')
 AND u.source = json_extract(j.value, '$[3]') AND u.model = json_extract(j.value, '$[4]')`;

/** Rows per upsert statement: its JSON parameter stays ~40 KB (D1 limits a statement and a bound value). */
const CHUNK = 200;
/** A whole-history upload may use this share of the daily row allowance: the rest is kept for recent pushes, which must never starve behind it. */
export const FULL_SHARE = 0.8;
/** The charge per distinct day a request touches, on top of its rows (see the handler). A legitimate recent push is 2-3 days. */
export const USAGE_DAY_CHARGE = 30;
/** A request with a day older than this many days back is "history" (it may use FULL_SHARE of the allowance only). */
export const USAGE_RECENT_DAYS = 40;
/** A request with no rows stamps the host's liveness at most this often. */
const STAMP_EVERY_MS = 60_000;
export const SQL_USAGE_STAMP = `INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count)
  VALUES (?1, ?2, ?3, ?4, 0, ?2, 0)
  ON CONFLICT(host) DO UPDATE SET pushed_at = ?2, generated_at = ?3, tz = ?4 WHERE ?2 - usage_hosts.pushed_at >= ?5`;

const isNoTable = (err: unknown): boolean => /no such table/i.test(err instanceof Error ? err.message : String(err));

export async function handleUsageIngest(req: Request, env: Env, now: number): Promise<Response> {
  if (req.method !== "POST") return errorJson(405, "POST only", { Allow: "POST" });
  const auth = await authenticateBearer(req, env, "host", now);
  if (!auth.ok) return auth.response;
  const source = auth.source;
  const body = await readJsonBody(req, MAX_USAGE_BODY_BYTES);
  if (!body.ok) return body.response;
  if (isObj(body.value) && body.value.mode === "erase") return handleUsageErase(body.value, source, env, now);
  const b = sanitizeUsageBatch(body.value, now);
  if (!b.ok) return errorJson(400, b.error);
  const host = source.name; // the token-bound label: the payload only has to agree with it
  if (b.value.host !== host) return errorJson(403, `host label '${b.value.host}' does not match this token`);

  const db = env.DB;
  // Days the purge would delete at once (or that are in the future) are dropped, not stored.
  const lowest = utcDay(now - usageRetentionDaysOf(env) * DAY_MS);
  const highest = utcDay(now + DAY_MS);
  let dropped = 0;
  let rows = b.value.rows.filter((r) => {
    const keep = r.day >= lowest && r.day <= highest;
    if (!keep) dropped++;
    return keep;
  });

  const authDays = (b.value.completeDays ?? []).filter((d) => d >= lowest && d <= highest);
  // Hourly rows are kept USAGE_HOURLY_RETENTION_DAYS: older hours are dropped (counted), never stored for the purge to delete.
  // never before the daily lower bound (a USAGE_RETENTION_DAYS under 90 would otherwise accept hours of days whose rows are dropped)
  const lowestHourDay = [utcDay(now - USAGE_HOURLY_RETENTION_DAYS * DAY_MS), lowest].sort()[1]!;
  // An hour is kept only on a day whose DAILY rows survived the window above: hourly rows can never ride without daily rows (which
  // carry the allowance claim and the per-day caps), so an hourly-only payload is impossible.
  let hourlyDropped = 0;
  const keptDays = new Set(rows.map((r) => r.day));
  const hourly = b.value.hourly?.filter((r) => {
    const d = hourDay(r.hour);
    const keep = keptDays.has(d) && d >= lowestHourDay && d <= highest;
    if (!keep) hourlyDropped++;
    return keep;
  }) ?? null;
  const hourlyAuthDays = hourly ? authDays.filter((d) => d >= lowestHourDay) : [];
  // Oldest day first: the INSERT's per-day count then touches each day once however the rows are chunked.
  rows = [...rows].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
  const stale = staleGroups(rows, authDays);

  // What this request costs, known before anything is read: its rows, plus a fixed charge per distinct day it touches (each day is a primary-key
  // seek that counts up to the per-day cap and, for a declared-complete day, scans it for stale rows: reads the row count alone does not show).
  const distinctDays = new Set(rows.map((r) => r.day)).size;
  const charge = rows.length + (hourly?.length ?? 0) + USAGE_DAY_CHARGE * distinctDays;
  // A request is "history" when it carries a day older than the recent window, judged from the DATA (the client's `mode` is only a label): such
  // requests may use FULL_SHARE of the allowance, so the rest is always left for recent pushes, whatever an attacker calls its batches.
  const recentFrom = utcDay(now - USAGE_RECENT_DAYS * DAY_MS);
  const isHistory = rows.some((r) => r.day < recentFrom);

  try {
    // EVERY bound comes before ANY read of usage_daily, and a REFUSED request writes nothing. Order: (1) the host's ordinary write budget (one
    // atomic claim: the request, its statements and the usage_hosts stamp); (2) the usage allowance (an atomic claim of `charge`; a request with no
    // rows needs none and only stamps liveness at most once a minute). Nothing is refunded: a request that is refused after the first claim has paid it.
    const hourlyStale = hourly ? staleHourGroups(hourly, hourlyAuthDays) : [];
    const cost = WRITE_COST.request + 2 * Math.ceil(rows.length / CHUNK) + stale.length + 1 + (hourly ? 2 * Math.ceil(hourly.length / CHUNK) + hourlyStale.length : 0);
    const hostClaim = await claimHostWrites(db, source.id, now, hostWriteBudget(MAX_PROJECTS_PER_HOST), cost, 0);
    if (!hostClaim.ok) {
      return json({ error: "write budget exhausted: this host token has used its estimated row writes for the 24-hour window; usage will be retried later" }, 429, { "Retry-After": "3600" });
    }
    let hasFull: number;
    if (rows.length === 0 && !(hourly && hourly.length > 0)) {
      await stmt(db, SQL_USAGE_STAMP, host, now, b.value.generatedAt, b.value.tz, STAMP_EVERY_MS).run();
      hasFull = (await stmt(db, "SELECT has_full FROM usage_hosts WHERE host = ?1", host).first<{ has_full: number }>())?.has_full ?? 0;
    } else {
      const cap = isHistory ? Math.floor(MAX_USAGE_ROWS_PER_HOST_PER_DAY * FULL_SHARE) : MAX_USAGE_ROWS_PER_HOST_PER_DAY;
      const claimed = await stmt(db, SQL_USAGE_CLAIM, host, now, b.value.generatedAt, b.value.tz, charge, DAY_MS, cap).all<{ has_full: number; win_start: number }>();
      const row = claimed.results?.[0];
      if (!row) {
        const until = ((await stmt(db, "SELECT win_start FROM usage_hosts WHERE host = ?1", host).first<{ win_start: number }>())?.win_start ?? now) + DAY_MS;
        const retryAfter = Math.max(60, Math.min(86_400, Math.ceil((until - now) / 1000)));
        return json({ error: `usage budget exhausted: at most ${MAX_USAGE_ROWS_PER_HOST_PER_DAY} units (a row, or ${USAGE_DAY_CHARGE} per day touched) per host and 24 h window; a request with history (days older than ${USAGE_RECENT_DAYS}) may use ${Math.round(FULL_SHARE * 100)} % of it, so recent pushes always have room; retry in ${retryAfter} s` }, 429, { "Retry-After": String(retryAfter) });
      }
      hasFull = row.has_full;
    }

    const stmts: D1PreparedStatement[] = [];
    for (const g of stale) stmts.push(stmt(db, SQL_USAGE_DELETE_STALE, JSON.stringify(g.days), host, JSON.stringify(g.keys)));
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => [r.day, r.project, r.agent, r.source, r.model, r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, r.requests, r.usd]);
      const json = JSON.stringify(chunk);
      stmts.push(stmt(db, SQL_USAGE_INSERT, json, host, now, MAX_USAGE_ROWS_PER_HOST_DAY), stmt(db, SQL_USAGE_UPDATE, json, host, now));
    }
    // How many submitted rows are NOT stored afterwards (refused by the per-day cap): counted by one point lookup per row, in the same transaction.
    const countFrom = stmts.length;
    for (let i = 0; i < rows.length; i += CHUNK) {
      stmts.push(stmt(db, SQL_USAGE_PRESENT, JSON.stringify(rows.slice(i, i + CHUNK).map((r) => [r.day, r.project, r.agent, r.source, r.model])), host));
    }
    const countTo = stmts.length;
    // The whole history has arrived when the sender says its last batch of a full upload is in: recorded in the SAME
    // transaction as the rows, so `needFull` never turns false for a history that did not land.
    const completes = b.value.full && b.value.complete;
    if (completes) stmts.push(stmt(db, "UPDATE usage_hosts SET has_full = 1 WHERE host = ?1", host));
    let capped = 0;
    if (stmts.length) {
      const results = await db.batch(stmts);
      let present = 0;
      for (let i = countFrom; i < countTo; i++) present += Number((results[i]?.results?.[0] as { c?: number } | undefined)?.c ?? 0);
      capped = Math.max(0, rows.length - present);
      // Deletes are never free: what the stale-row deletes REALLY removed (bounded by what this host wrote earlier, each of which was charged) is
      // charged on top, unconditionally, to the USAGE allowance (never to the host write budget, which is the snapshots').
      const deleted = results.slice(0, stale.length).reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
      if (deleted > 0) await chargeUsageAllowance(db, host, now, deleted);
    }
    // The hourly block in its own transaction AFTER the daily rows: a database without migration 0005 still takes the daily rows.
    let hourlyState: "ok" | "pending" | undefined;
    let hourlyCapped = 0;
    if (hourly) {
      try {
        const h = await writeHourly(db, host, now, hourly, hourlyStale);
        hourlyCapped = h.capped;
        if (h.deleted > 0) await chargeUsageAllowance(db, host, now, h.deleted);
        hourlyState = "ok";
      } catch (err) {
        if (!isNoTable(err)) throw err;
        hourlyState = "pending";
      }
    }
    return json({
      ok: true, rows: rows.length, dropped, ...(capped ? { capped } : {}),
      ...(hourly ? { hourly: hourlyState, hourlyRows: hourly.length, ...(hourlyDropped ? { hourlyDropped } : {}), ...(hourlyCapped ? { hourlyCapped } : {}) } : {}),
      needFull: !(hasFull === 1 || completes),
    });
  } catch (err) {
    if (isNoTable(err)) return errorJson(503, "usage tables are not there yet: apply migration 0003_usage_daily.sql", { "Retry-After": "600" });
    throw err;
  }
}

/** Stale deletes, upserts and the stored-count check of the hourly rows: one transaction. Returns the rows refused by the per-day cap and the rows deleted. */
async function writeHourly(db: D1Database, host: string, now: number, rows: HourlyUsageRow[], stale: Array<{ days: string[]; keys: string[][] }>): Promise<{ capped: number; deleted: number }> {
  const sorted = [...rows].sort((x, y) => (x.hour < y.hour ? -1 : x.hour > y.hour ? 1 : 0));
  const stmts: D1PreparedStatement[] = [];
  for (const g of stale) stmts.push(stmt(db, SQL_HOURLY_DELETE_STALE, JSON.stringify(g.days), host, JSON.stringify(g.keys), `${g.days[0]}T00`, `${g.days[g.days.length - 1]}T23`));
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const chunk = JSON.stringify(sorted.slice(i, i + CHUNK).map((r) => [r.hour, r.project, r.agent, r.source, r.model, r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, r.requests, r.usd]));
    stmts.push(stmt(db, SQL_HOURLY_INSERT, chunk, host, now, MAX_USAGE_HOURLY_ROWS_PER_HOST_DAY), stmt(db, SQL_HOURLY_UPDATE, chunk, host, now));
  }
  const countFrom = stmts.length;
  for (let i = 0; i < sorted.length; i += CHUNK) {
    stmts.push(stmt(db, SQL_HOURLY_PRESENT, JSON.stringify(sorted.slice(i, i + CHUNK).map((r) => [r.hour, r.project, r.agent, r.source, r.model])), host));
  }
  if (!stmts.length) return { capped: 0, deleted: 0 };
  const results = await db.batch(stmts);
  let present = 0;
  for (let i = countFrom; i < stmts.length; i++) present += Number((results[i]?.results?.[0] as { c?: number } | undefined)?.c ?? 0);
  return { capped: Math.max(0, sorted.length - present), deleted: results.slice(0, stale.length).reduce((n, r) => n + (r.meta?.changes ?? 0), 0) };
}

/** Groups of authoritative days for the hourly stale-row delete (consecutive in the key, ~300 keys per statement). */
function staleHourGroups(rows: HourlyUsageRow[], authDays: string[]): Array<{ days: string[]; keys: string[][] }> {
  const byDay = new Map<string, string[][]>();
  for (const r of rows) {
    const d = hourDay(r.hour);
    let k = byDay.get(d);
    if (!k) byDay.set(d, (k = []));
    k.push([r.hour, r.project, r.agent, r.source, r.model]);
  }
  const groups: Array<{ days: string[]; keys: string[][] }> = [];
  let cur: { days: string[]; keys: string[][] } = { days: [], keys: [] };
  for (const d of [...authDays].sort()) {
    const k = byDay.get(d) ?? [];
    if (cur.keys.length && cur.keys.length + k.length > 300) {
      groups.push(cur);
      cur = { days: [], keys: [] };
    }
    cur.days.push(d);
    cur.keys.push(...k);
  }
  if (cur.days.length) groups.push(cur);
  return groups;
}

/** Charge `n` rows already written / deleted to the host's USAGE allowance (unconditional: it may pass the cap, the next claim is then refused). Starts a new window when the old one is over. */
async function chargeUsageAllowance(db: D1Database, host: string, now: number, n: number): Promise<void> {
  // An UPSERT: a host whose bookkeeping row is gone (purged after 30 quiet days while its usage rows stay 800) gets one with a fresh window, so the charge is
  // never lost and the next erase is bounded by what is left. (pushed_at 0: this row is not a sign of life, the purge may take it again once the window is over.)
  await stmt(
    db,
    `INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES (?1, 0, 0, 'UTC', 0, ?2, ?3)
     ON CONFLICT(host) DO UPDATE SET win_start = CASE WHEN ?2 - usage_hosts.win_start >= ?4 THEN ?2 ELSE usage_hosts.win_start END,
       win_count = CASE WHEN ?2 - usage_hosts.win_start >= ?4 THEN ?3 ELSE usage_hosts.win_count + ?3 END`,
    host, now, n, DAY_MS,
  ).run().catch(() => undefined);
}

/** Reserve `n` rows of the host's usage allowance for an erase: one conditional UPSERT, no stamps (an erase is not a sign of life). null = it does not fit. */
async function claimErase(db: D1Database, host: string, now: number, n: number): Promise<{ n: number; winStart: number } | null> {
  const r = await stmt(
    db,
    `INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES (?1, 0, 0, 'UTC', 0, ?2, ?3)
     ON CONFLICT(host) DO UPDATE SET
       win_start = CASE WHEN ?2 - usage_hosts.win_start >= ?4 THEN ?2 ELSE usage_hosts.win_start END,
       win_count = CASE WHEN ?2 - usage_hosts.win_start >= ?4 THEN ?3 ELSE usage_hosts.win_count + ?3 END
     WHERE ?2 - usage_hosts.win_start >= ?4 OR usage_hosts.win_count + ?3 <= ?5
     RETURNING win_start`,
    host, now, n, DAY_MS, MAX_USAGE_ROWS_PER_HOST_PER_DAY,
  ).all<{ win_start: number }>();
  const row = r.results?.[0];
  return row ? { n, winStart: row.win_start } : null;
}

/** Rows one erase request deletes at most (35 days x 300 rows: the same bound as a request that replaces 35 full days). */
export const MAX_USAGE_ERASE_ROWS = 35 * MAX_USAGE_ROWS_PER_HOST_DAY;
/** Host-budget units an erase request is charged up front (it probes every day of the retention window); the rows it deletes are charged on top afterwards. */
export const USAGE_ERASE_COST = 20;

/**
 * ERASE: `POST /api/ingest/usage {v: 1, host, mode: "erase"}` deletes the token-bound host's OWN usage rows (the key of every row has the host in it:
 * nothing of another host can be touched), at most MAX_USAGE_ERASE_ROWS per request, and says `remaining: 1` while there may be more (the caller
 * repeats) or `0` when nothing is left. It is how an opt-out (`dashboard.usage.enabled: false`) or a tightened privacy policy withdraws what was
 * already sent. Order of work: the host's write budget is claimed first (a refusal is a 429 that writes nothing), the day-keyed rows are found by a
 * seek per day of the retention window (the primary key leads with `day`: no scan of other hosts' rows), and the rows really deleted are charged to
 * the usage allowance afterwards. The window counters of `usage_hosts` are kept until their window is over (erasing must not reset the allowance).
 */
async function handleUsageErase(raw: Record<string, unknown>, source: { id: string; name: string }, env: Env, now: number): Promise<Response> {
  if (raw.v !== 1) return errorJson(400, "v must be 1");
  if (typeof raw.host !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(raw.host)) return errorJson(400, "host must be a host label");
  if (raw.rows !== undefined && !(Array.isArray(raw.rows) && raw.rows.length === 0)) return errorJson(400, "an erase request carries no rows");
  const host = source.name;
  if (raw.host !== host) return errorJson(403, `host label '${raw.host}' does not match this token`);
  const db = env.DB;
  try {
    // (1) the small FIXED host claim (a spent host budget refuses with zero writes); the rows deleted are NEVER charged to the host write budget
    // (that is the snapshots' budget: erasing 48 k rows must not starve them) but to the USAGE allowance below.
    const claim = await claimHostWrites(db, source.id, now, hostWriteBudget(MAX_PROJECTS_PER_HOST), USAGE_ERASE_COST, 0);
    if (!claim.ok) return json({ error: "write budget exhausted: this host token has used its estimated row writes for the 24-hour window; the erase continues later" }, 429, { "Retry-After": "3600" });
    // (2) RESERVE rows from the usage allowance with ONE atomic statement (the same conditional UPSERT as an upload's claim, creating the row with a fresh
    // window when there is none, so concurrent first requests share a single window and a missing row is never more permissive than an existing one). The
    // whole erase size is asked for first; when that does not fit, what is left is asked for; nothing left = 429 (the pusher resumes in the next window).
    let reserved = await claimErase(db, host, now, MAX_USAGE_ERASE_ROWS);
    if (!reserved) {
      const cur = await stmt(db, "SELECT win_start, win_count FROM usage_hosts WHERE host = ?1", host).first<{ win_start: number; win_count: number }>();
      const room = cur && now - cur.win_start < DAY_MS ? MAX_USAGE_ROWS_PER_HOST_PER_DAY - cur.win_count : 0;
      if (room > 0) reserved = await claimErase(db, host, now, Math.min(room, MAX_USAGE_ERASE_ROWS));
      if (!reserved) {
        const retryAfter = Math.max(60, Math.min(86_400, Math.ceil(((cur?.win_start ?? now) + DAY_MS - now) / 1000)));
        return json({ error: `usage allowance spent: the erase continues in the next 24 h window; retry in ${retryAfter} s` }, 429, { "Retry-After": String(retryAfter) });
      }
    }
    const limit = reserved.n;
    const days: string[] = [];
    const first = Date.parse(`${utcDay(now - (usageRetentionDaysOf(env) + 30) * DAY_MS)}T00:00:00Z`);
    for (let t = first; t <= now + DAY_MS; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
    // Hourly rows first (migration 0005; a missing table has none): the same reservation covers both tables.
    let hourlyDeleted = 0;
    try {
      const hr = await stmt(
        db,
        "DELETE FROM usage_hourly WHERE (hour, host, project, agent, source, model) IN (SELECT hour, host, project, agent, source, model FROM usage_hourly WHERE host = ?1 AND hour >= ?2 ORDER BY hour LIMIT ?3)",
        // from the older of the two windows (daily retention + 30 d, hourly retention + 30 d): no hourly row can survive an erase
        host, `${[days[0]!, utcDay(now - (USAGE_HOURLY_RETENTION_DAYS + 30) * DAY_MS)].sort()[0]}T00`, limit,
      ).run();
      hourlyDeleted = hr.meta?.changes ?? 0;
    } catch (err) {
      if (!isNoTable(err)) throw err;
    }
    const res = hourlyDeleted >= limit ? null : await stmt(
      db,
      "DELETE FROM usage_daily WHERE (day, host, project, agent, source, model) IN (SELECT day, host, project, agent, source, model FROM usage_daily WHERE host = ?1 AND day IN (SELECT value FROM json_each(?2)) ORDER BY day LIMIT ?3)",
      host, JSON.stringify(days), limit - hourlyDeleted,
    ).run();
    const deleted = hourlyDeleted + (res?.meta?.changes ?? 0);
    // what was reserved but not deleted goes back (only into the same window)
    if (deleted < limit) await stmt(db, "UPDATE usage_hosts SET win_count = MAX(0, win_count - ?2) WHERE host = ?1 AND win_start = ?3", host, limit - deleted, reserved.winStart).run().catch(() => undefined);
    const more = deleted >= limit;
    if (!more) {
      // Nothing is left: the host's bookkeeping row goes too, but only once its allowance window is over or nothing was charged in it (deleting it earlier would reset the allowance).
      await stmt(db, "DELETE FROM usage_hosts WHERE host = ?1 AND (?2 - win_start >= ?3 OR win_count = 0)", host, now, DAY_MS).run(); // a window with nothing charged carries no information
      await stmt(db, "UPDATE usage_hosts SET has_full = 0 WHERE host = ?1 AND has_full = 1", host).run();
    }
    return json({ ok: true, erased: deleted, remaining: more ? 1 : 0 });
  } catch (err) {
    if (isNoTable(err)) return json({ ok: true, erased: 0, remaining: 0 }); // no usage tables: nothing to erase
    throw err;
  }
}

/** Groups of authoritative days for the stale-row delete: a day's keys are never split, ~300 keys per statement; empty days ride in the last group. */
function staleGroups(rows: UsageRow[], authDays: string[]): Array<{ days: string[]; keys: string[][] }> {
  const byDay = new Map<string, string[][]>();
  for (const r of rows) {
    let k = byDay.get(r.day);
    if (!k) byDay.set(r.day, (k = []));
    k.push([r.day, r.project, r.agent, r.source, r.model]);
  }
  const groups: Array<{ days: string[]; keys: string[][] }> = [];
  let cur: { days: string[]; keys: string[][] } = { days: [], keys: [] };
  for (const d of authDays) {
    const k = byDay.get(d) ?? [];
    if (cur.keys.length && cur.keys.length + k.length > 300) {
      groups.push(cur);
      cur = { days: [], keys: [] };
    }
    cur.days.push(d);
    cur.keys.push(...k);
  }
  if (cur.days.length) groups.push(cur);
  return groups;
}

// ── read ─────────────────────────────────────────────────────────────────────

/** TOTAL() is a float sum that never raises "integer overflow" (SUM() does past 2^63), so no stored value can break the read. */
const AGG = `TOTAL(input) AS input, TOTAL(output) AS output, TOTAL(cache_read) AS cache_read, TOTAL(CAST(cache_write_5m AS REAL) + cache_write_1h) AS cache_write,
  TOTAL(requests) AS requests, TOTAL(usd) AS usd,
  TOTAL(CASE WHEN usd IS NULL THEN CAST(input AS REAL) + output + cache_write_5m + cache_write_1h ELSE 0 END) AS unpriced,
  TOTAL(CASE WHEN usd IS NULL THEN requests ELSE 0 END) AS unpriced_req`;

interface AggRow { input: number; output: number; cache_read: number; cache_write: number; requests: number; usd: number; unpriced: number; unpriced_req?: number }
const agg = (r: AggRow | undefined | null) => ({
  input: r?.input ?? 0,
  output: r?.output ?? 0,
  cacheRead: r?.cache_read ?? 0,
  cacheWrite: r?.cache_write ?? 0,
  requests: r?.requests ?? 0,
  usd: Math.round((r?.usd ?? 0) * 1e6) / 1e6,
  unpricedTokens: r?.unpriced ?? 0,
  /** requests of models without a public price (additive) */
  unpricedRequests: r?.unpriced_req ?? 0,
});

/** `YYYY-MM-DD` of an instant in the dashboard's zone (DASHBOARD_TZ): the page's "today" and "this month". */
export function dashDay(ms: number, tz: string = dashboardTz()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
/** `YYYY-MM-DDTHH` of an instant in the dashboard's zone. */
export function dashHour(ms: number, tz: string = dashboardTz()): string {
  const hh = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return `${dashDay(ms, tz)}T${hh.padStart(2, "0")}`;
}
const addDays = (day: string, n: number): string => utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** `GET /api/usage` (the router has already done the cross-site, Access and e-mail checks). */
export async function handleUsageRead(req: Request, env: Env, now: number): Promise<Response> {
  if (req.method !== "GET") return errorJson(405, "GET only", { Allow: "GET" });
  const q = new URL(req.url).searchParams;
  const group = q.get("group") ?? "month";
  if (group === "hour") return await handleUsageHours(q, env, now);
  if (group === "insights") return await handleUsageInsights(env, now);
  if (group !== "day" && group !== "month") return errorJson(400, "group must be 'day', 'month', 'hour' or 'insights'");
  const today = dashDay(now);
  const fromQ = q.get("from");
  const toQ = q.get("to");
  if ((fromQ !== null && !isDay(fromQ)) || (toQ !== null && !isDay(toQ))) return errorJson(400, "from and to must be calendar days YYYY-MM-DD");
  const to = toQ ?? today;
  let from = fromQ ?? (group === "day" ? addDays(to, -29) : `${addDays(`${to.slice(0, 7)}-01`, -1).slice(0, 7)}-01`);
  if (from > to) return errorJson(400, "from must not be after to");
  // The range is clamped BEFORE any query runs: at most MAX_USAGE_RANGE_DAYS days (the oldest part is cut, and the answer says so).
  const oldest = addDays(to, -(MAX_USAGE_RANGE_DAYS - 1));
  const clamped = from < oldest;
  if (clamped) from = oldest;
  const barsFrom = addDays(today, -29);

  const db = env.DB;
  try {
    const [totalR, projectsR, breakdownR, seriesR, barsR, hostsR, hostBreakdownR] = await Promise.all([
      stmt(db, `SELECT ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2`, from, to).first<AggRow>(),
      all<AggRow & { project: string }>(db, `SELECT project, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY project ORDER BY usd DESC, project LIMIT ?3`, from, to, MAX_USAGE_PROJECTS + 1),
      all<AggRow & { project: string; agent: string; source: string; model: string }>(
        db, `SELECT project, agent, source, model, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY project, agent, source, model ORDER BY project, usd DESC, agent, model LIMIT ?3`, from, to, MAX_USAGE_BREAKDOWN + 1,
      ),
      all<AggRow & { k: string }>(db, `SELECT ${group === "day" ? "day" : "substr(day, 1, 7)"} AS k, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY k ORDER BY k LIMIT ?3`, from, to, MAX_USAGE_RANGE_DAYS + 1),
      all<AggRow & { k: string }>(db, `SELECT day AS k, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY day ORDER BY day LIMIT 31`, barsFrom, today),
      all<{ host: string; pushed_at: number; generated_at: number; tz: string; has_full: number }>(db, "SELECT host, pushed_at, generated_at, tz, has_full FROM usage_hosts ORDER BY host LIMIT 50"),
      all<HostBreakdownRow>(db, `SELECT ${HOST_BREAKDOWN_COLS}, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY host, agent, project, source, model ORDER BY host, usd DESC, agent, project, model LIMIT ?3`, from, to, MAX_USAGE_BREAKDOWN + 1),
    ]);
    const truncated: string[] = [];
    if (projectsR.length > MAX_USAGE_PROJECTS) truncated.push("projects");
    if (breakdownR.length > MAX_USAGE_BREAKDOWN) truncated.push("breakdown");
    if (hostBreakdownR.length > MAX_USAGE_BREAKDOWN) truncated.push("hostBreakdown");
    const cut = <T,>(a: T[], n: number): T[] => a.slice(0, n);
    return json({
      now,
      from,
      to,
      group,
      today,
      tz: dashboardTz(),
      basis: "API-equivalent (est.)",
      truncated,
      ...(clamped ? { clamped: true } : {}),
      total: agg(totalR),
      projects: cut(projectsR, MAX_USAGE_PROJECTS).map((r) => ({ project: r.project, ...agg(r) })),
      breakdown: cut(breakdownR, MAX_USAGE_BREAKDOWN).map((r) => ({ project: r.project, agent: r.agent, source: r.source, model: r.model, ...agg(r) })),
      series: cut(seriesR, MAX_USAGE_RANGE_DAYS).map((r) => ({ k: r.k, ...agg(r) })),
      bars: barsR.map((r) => ({ day: r.k, ...agg(r) })),
      hosts: hostsR.map((h) => ({ host: h.host, pushedAt: h.pushed_at, generatedAt: h.generated_at, tz: h.tz, full: h.has_full === 1 })),
      hostBreakdown: cut(hostBreakdownR, MAX_USAGE_BREAKDOWN).map(hostBreakdownOut),
    });
  } catch (err) {
    if (isNoTable(err)) return json({ now, from, to, group, today, tz: dashboardTz(), basis: "API-equivalent (est.)", truncated: [], total: agg(null), projects: [], breakdown: [], series: [], bars: [], hosts: [], hostBreakdown: [], pending: true });
    throw err;
  }
}


// ── per host / app (the `agent` label) / project / model, and one day's hours ──────────────────────────────

const HOST_BREAKDOWN_COLS = "host, agent, project, source, model";
type HostBreakdownRow = AggRow & { host: string; agent: string; project: string; source: string; model: string };
const hostBreakdownOut = (r: HostBreakdownRow) => ({ host: r.host, agent: r.agent, project: r.project, source: r.source, model: r.model, ...agg(r) });

/**
 * `GET /api/usage?group=hour&day=YYYY-MM-DD` (default: today in the dashboard's zone): the day's 24 local hours from usage_hourly (each host's
 * hours are in that host's own time zone, see usage_hosts.tz), the day's total, and the per host / app / project / model breakdown.
 * Bounded: one day is a range seek of the primary key (at most MAX_USAGE_HOURLY_ROWS_PER_HOST_DAY rows per host). A day older than the
 * hourly retention has no hours (`retained: false`): the page then shows the day's total only.
 */
async function handleUsageHours(q: URLSearchParams, env: Env, now: number): Promise<Response> {
  const today = dashDay(now);
  const day = q.get("day") ?? today;
  if (!isDay(day)) return errorJson(400, "day must be a calendar day YYYY-MM-DD");
  const retained = day >= utcDay(now - USAGE_HOURLY_RETENTION_DAYS * DAY_MS);
  const lo = `${day}T00`;
  const hi = `${day}T23`;
  const db = env.DB;
  const base = { now, group: "hour", day, today, tz: dashboardTz(), basis: "API-equivalent (est.)", retained, retentionDays: USAGE_HOURLY_RETENTION_DAYS };
  try {
    const [hoursR, totalR, hostBreakdownR, dailyTotalR, dayHostsR, hourHostsR, firstHourR] = await Promise.all([
      all<AggRow & { k: string }>(db, `SELECT substr(hour, 12, 2) AS k, ${AGG} FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2 GROUP BY k ORDER BY k LIMIT 24`, lo, hi),
      stmt(db, `SELECT ${AGG} FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2`, lo, hi).first<AggRow>(),
      all<HostBreakdownRow>(db, `SELECT ${HOST_BREAKDOWN_COLS}, ${AGG} FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2 GROUP BY host, agent, project, source, model ORDER BY host, usd DESC, agent, project, model LIMIT ?3`, lo, hi, MAX_USAGE_BREAKDOWN + 1),
      stmt(db, `SELECT ${AGG} FROM usage_daily WHERE day = ?1`, day).first<AggRow>(),
      all<{ host: string; requests: number }>(db, "SELECT host, TOTAL(requests) AS requests FROM usage_daily WHERE day = ?1 GROUP BY host ORDER BY host LIMIT 50", day),
      all<{ host: string; requests: number }>(db, "SELECT host, TOTAL(requests) AS requests FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2 GROUP BY host ORDER BY host LIMIT 50", lo, hi),
      // the oldest hour stored (one seek: `hour` leads the primary key): "hourly data exists from ..."
      stmt(db, "SELECT hour FROM usage_hourly ORDER BY hour LIMIT 1").first<{ hour: string }>(),
    ]);
    const byHour = new Map(hoursR.map((r) => [r.k, r]));
    return json({
      ...base,
      truncated: hostBreakdownR.length > MAX_USAGE_BREAKDOWN ? ["hostBreakdown"] : [],
      hours: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => ({ h, ...agg(byHour.get(h)) })),
      total: agg(totalR),
      /** the day's DAILY total: hosts that send no hourly rows (older clients) are only in here */
      dayTotal: agg(dailyTotalR),
      hostBreakdown: hostBreakdownR.slice(0, MAX_USAGE_BREAKDOWN).map(hostBreakdownOut),
      /** which hosts sent hourly rows for this day, against the hosts in the day's daily total (requests each) */
      coverage: dayHostsR.map((r) => ({ host: r.host, requests: r.requests, hourly: hourHostsR.find((x) => x.host === r.host)?.requests ?? 0 })),
      hourlySince: firstHourR?.hour ?? null,
    });
  } catch (err) {
    if (isNoTable(err)) return json({ ...base, truncated: [], hours: [], total: agg(null), dayTotal: agg(null), hostBreakdown: [], coverage: [], hourlySince: null, pending: true });
    throw err;
  }
}

// ── the overview's compact aggregates ──────────────────────────────────────────────────────────────────────

/** Rows of the per-day app / project series of the insights answer (30 days x labels); past it the answer says `truncated`. */
export const MAX_USAGE_INSIGHT_SERIES = 2000;
/** The weekday x hour grid looks at this many recent days of hourly rows. */
export const USAGE_WEEKHOUR_DAYS = 28;
/** `claude-cli.dev` -> `claude-cli` in SQL (the worktree after the dot is not needed for the per-app series). */
const APP_SQL = "CASE WHEN instr(agent, '.') > 0 THEN substr(agent, 1, instr(agent, '.') - 1) ELSE agent END";

/**
 * `GET /api/usage?group=insights`: what the overview's KPI tiles and small charts need, in one bounded answer (London days, today
 * included): `daily` (60 days of totals: today / 7 d / 30 d and the period before each), `byApp` / `byProject` (30 days, per day),
 * `models` and `hosts` (30-day totals), and `weekHour` (weekday 0 = Sunday x local hour, from the last USAGE_WEEKHOUR_DAYS days of
 * hourly rows; empty while no host sends hours). Numbers and the stored labels only, like every other usage answer.
 */
async function handleUsageInsights(env: Env, now: number): Promise<Response> {
  const today = dashDay(now);
  const from60 = addDays(today, -59);
  const from30 = addDays(today, -29);
  const whFrom = `${addDays(today, -(USAGE_WEEKHOUR_DAYS - 1))}T00`;
  /** the current London hour: no hour after it is counted (a skewed host clock cannot add future hours) */
  const nowHour = dashHour(now);
  const db = env.DB;
  const base = { now, group: "insights", today, tz: dashboardTz(), from: from60, from30, basis: "API-equivalent (est.)", weekHourDays: USAGE_WEEKHOUR_DAYS };
  try {
    const [dailyR, appR, projR, modelR, hostR] = await Promise.all([
      all<AggRow & { k: string }>(db, `SELECT day AS k, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY day ORDER BY day LIMIT 61`, from60, today),
      all<AggRow & { day: string; k: string }>(db, `SELECT day, ${APP_SQL} AS k, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY day, k ORDER BY day, k LIMIT ?3`, from30, today, MAX_USAGE_INSIGHT_SERIES + 1),
      all<AggRow & { day: string; k: string }>(db, `SELECT day, project AS k, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY day, project ORDER BY day, project LIMIT ?3`, from30, today, MAX_USAGE_INSIGHT_SERIES + 1),
      all<AggRow & { source: string; model: string }>(db, `SELECT source, model, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY source, model ORDER BY usd DESC, model LIMIT 51`, from30, today),
      all<AggRow & { host: string }>(db, `SELECT host, ${AGG} FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY host ORDER BY usd DESC, host LIMIT 51`, from30, today),
    ]);
    // the hourly table may be missing (migration 0005 not applied) while the daily one exists: the grid is then just empty
    const weekHourR = await all<AggRow & { w: number; h: string }>(
      db, `SELECT CAST(strftime('%w', substr(hour, 1, 10)) AS INTEGER) AS w, substr(hour, 12, 2) AS h, ${AGG} FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2 GROUP BY w, h ORDER BY w, h LIMIT 168`, whFrom, nowHour,
    ).catch((err) => { if (isNoTable(err)) return null; throw err; });
    // today so far against yesterday up to the same hour (hourly rows only: hosts without hours are in neither side)
    const sameTimeR = weekHourR === null ? null : await Promise.all([
      stmt(db, `SELECT ${AGG} FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2`, `${today}T00`, nowHour).first<AggRow>(),
      stmt(db, `SELECT ${AGG} FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2`, `${addDays(today, -1)}T00`, `${addDays(today, -1)}T${nowHour.slice(11)}`).first<AggRow>(),
    ]);
    const truncated: string[] = [];
    if (appR.length > MAX_USAGE_INSIGHT_SERIES) truncated.push("byApp");
    if (projR.length > MAX_USAGE_INSIGHT_SERIES) truncated.push("byProject");
    if (modelR.length > 50) truncated.push("models");
    if (hostR.length > 50) truncated.push("hosts");
    return json({
      ...base,
      truncated,
      daily: dailyR.map((r) => ({ day: r.k, ...agg(r) })),
      byApp: appR.slice(0, MAX_USAGE_INSIGHT_SERIES).map((r) => ({ day: r.day, k: r.k, ...agg(r) })),
      byProject: projR.slice(0, MAX_USAGE_INSIGHT_SERIES).map((r) => ({ day: r.day, k: r.k, ...agg(r) })),
      models: modelR.slice(0, 50).map((r) => ({ source: r.source, model: r.model, ...agg(r) })),
      hosts: hostR.slice(0, 50).map((r) => ({ host: r.host, ...agg(r) })),
      weekHour: (weekHourR ?? []).map((r) => ({ w: r.w, h: r.h, ...agg(r) })),
      ...(sameTimeR ? { sameTime: { hour: nowHour.slice(11), today: agg(sameTimeR[0]), yesterday: agg(sameTimeR[1]) } } : {}),
      ...(weekHourR === null ? { hourlyPending: true } : {}),
    });
  } catch (err) {
    if (isNoTable(err)) return json({ ...base, truncated: [], daily: [], byApp: [], byProject: [], models: [], hosts: [], weekHour: [], pending: true });
    throw err;
  }
}
