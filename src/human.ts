/**
 * @file The operator's own input (the "You" side of the well-being layer): `POST /api/ingest/human` (client token) stores
 * the hourly counts the siiswell hooks upload in batches, and humanSummary() reads them back for the stress line "You".
 * Numbers and hour starts only; no text reaches this file. Zero AI.
 * @module dashboard-worker/human
 */
import { authenticateBearer } from "./auth";
import { all, first, stmt } from "./db";
import type { Env } from "./env";
import { readJsonBody } from "./ingest";
import { errorJson, isObj, json } from "./util";

const HOUR = 3_600_000;
/** At most this many hours per upload (the client sends the last 26 h). */
export const MAX_HUMAN_HOURS = 48;
/** Hours older than this are refused (a late upload of a laptop that slept is fine; anything older is noise). */
export const HUMAN_MAX_AGE_MS = 7 * 24 * HOUR;
/** One accepted upload per source per this long: the hooks upload every 10 min; a leaked token cannot write faster. */
export const HUMAN_MIN_INTERVAL_MS = 4 * 60_000;
/** Kept this long (the retention trigger of migration 0011: 90 days = 7 776 000 000 ms). */
export const HUMAN_RETENTION_DAYS = 90;
const MAX_COUNT = 100_000;
const MAX_BODY = 16 * 1024;

export interface HumanHour { h: number; prompts: number; approvals: number; rapid: number; rapidMin: number; latN: number; latP50: number | null }

const count = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) throw new Error(`${field} must be a whole number 0..${MAX_COUNT}`);
  return v;
};

/** The upload body -> rows, or an error. Only the known numeric fields are read; anything else is ignored, never stored. */
export function sanitizeHuman(body: unknown, now: number): { ok: true; rows: HumanHour[] } | { ok: false; error: string } {
  try {
    if (!isObj(body) || body.v !== 1) throw new Error("body must be {v:1, hours:[...]}");
    if (!Array.isArray(body.hours) || body.hours.length > MAX_HUMAN_HOURS) throw new Error(`hours must be an array of at most ${MAX_HUMAN_HOURS}`);
    const seen = new Set<number>();
    const rows: HumanHour[] = [];
    for (const [i, r] of body.hours.entries()) {
      if (!isObj(r)) throw new Error(`hours[${i}] must be an object`);
      const h = r.h;
      if (typeof h !== "number" || !Number.isInteger(h) || h % HOUR !== 0 || h < now - HUMAN_MAX_AGE_MS || h > now + HOUR) throw new Error(`hours[${i}].h must be a whole UTC hour start (epoch ms) within the last 7 days`);
      if (seen.has(h)) throw new Error(`hours[${i}].h is repeated`);
      seen.add(h);
      const latP50 = r.latP50 === null || r.latP50 === undefined ? null : r.latP50;
      if (latP50 !== null && (typeof latP50 !== "number" || !Number.isFinite(latP50) || latP50 < 0 || latP50 > 24 * HOUR)) throw new Error(`hours[${i}].latP50 must be ms 0..86400000 or null`);
      rows.push({ h, prompts: count(r.prompts, "prompts"), approvals: count(r.approvals, "approvals"), rapid: count(r.rapid, "rapid"), rapidMin: r.rapidMin === undefined ? 0 : Math.min(60, count(r.rapidMin, "rapidMin")), latN: count(r.latN, "latN"), latP50: latP50 === null ? null : Math.round(latP50) });
    }
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const SQL_HUMAN_UPSERT = `INSERT INTO human_hourly (source_id, hour, prompts, approvals, rapid, rapid_min, lat_n, lat_p50_ms, updated)
  SELECT ?1, json_extract(value, '$.h'), json_extract(value, '$.prompts'), json_extract(value, '$.approvals'), json_extract(value, '$.rapid'),
         json_extract(value, '$.rapidMin'), json_extract(value, '$.latN'), json_extract(value, '$.latP50'), ?2 FROM json_each(?3) WHERE true
  ON CONFLICT(source_id, hour) DO UPDATE SET prompts = excluded.prompts, approvals = excluded.approvals, rapid = excluded.rapid, rapid_min = excluded.rapid_min,
    lat_n = excluded.lat_n, lat_p50_ms = excluded.lat_p50_ms, updated = excluded.updated`;

/** `POST /api/ingest/human`: a client token's hourly counts of the operator's own input (replaces the hours it sends). */
export async function handleHumanIngest(req: Request, env: Env, now: number): Promise<Response> {
  if (req.method !== "POST") return errorJson(405, "POST only", { Allow: "POST" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return errorJson(415, "Content-Type: application/json only");
  const auth = await authenticateBearer(req, env, "client", now);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(req, MAX_BODY);
  if (!body.ok) return body.response;
  const v = sanitizeHuman(body.value, now);
  if (!v.ok) return errorJson(400, v.error);
  try {
    const last = await first<{ t: number | null }>(env.DB, "SELECT MAX(updated) AS t FROM human_hourly WHERE source_id = ?1", auth.source.id);
    if (last?.t && now - last.t >= 0 && now - last.t < HUMAN_MIN_INTERVAL_MS) {
      const retry = Math.ceil((HUMAN_MIN_INTERVAL_MS - (now - last.t)) / 1000);
      return errorJson(429, `at most one upload every ${HUMAN_MIN_INTERVAL_MS / 60_000} minutes`, { "Retry-After": String(retry) });
    }
    if (v.rows.length) await stmt(env.DB, SQL_HUMAN_UPSERT, auth.source.id, now, JSON.stringify(v.rows)).run();
  } catch (err) {
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return errorJson(503, "human input storage is not set up (apply migration 0011)");
    throw err;
  }
  return json({ ok: true, hours: v.rows.length });
}

// ── read: the operator's hours, all sources summed ───────────────────────────

export interface HumanHourSum { h: number; prompts: number; approvals: number; rapid: number; rapidMin: number; latN: number; latP50: number | null }

/** Hours from `since` (epoch ms), every source summed; the median latency is the latN-weighted median of the sources' medians. */
export async function humanHours(db: D1Database, since: number): Promise<HumanHourSum[]> {
  try {
    const rows = await all<HumanRow>(
      db, "SELECT hour, prompts, approvals, rapid, rapid_min, lat_n, lat_p50_ms FROM human_hourly WHERE hour >= ?1 ORDER BY hour LIMIT 5000", since,
    );
    return sumHours(rows);
  } catch (err) {
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return [];
    throw err;
  }
}

/** Pure: per-source rows -> per-hour sums (oldest first). */
export interface HumanRow { hour: number; prompts: number; approvals: number; rapid: number; rapid_min?: number; lat_n: number; lat_p50_ms: number | null }
export function sumHours(rows: ReadonlyArray<HumanRow>): HumanHourSum[] {
  const by = new Map<number, { s: HumanHourSum; meds: Array<[number, number]> }>();
  for (const r of rows) {
    const a = by.get(r.hour) ?? { s: { h: r.hour, prompts: 0, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null }, meds: [] };
    a.s.prompts += r.prompts;
    a.s.approvals += r.approvals;
    a.s.rapid += r.rapid;
    a.s.rapidMin = Math.min(60, a.s.rapidMin + (r.rapid_min ?? 0)); // machines at once: an upper bound, capped at the hour
    a.s.latN += r.lat_n;
    if (r.lat_p50_ms !== null && r.lat_n > 0) a.meds.push([r.lat_p50_ms, r.lat_n]);
    by.set(r.hour, a);
  }
  return [...by.values()].sort((a, b) => a.s.h - b.s.h).map(({ s, meds }) => ({ ...s, latP50: weightedMedian(meds) }));
}

/** The weighted median of [value, weight] pairs; null without any. */
export function weightedMedian(pairs: ReadonlyArray<readonly [number, number]>): number | null {
  const xs = [...pairs].filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  const total = xs.reduce((n, [, w]) => n + w, 0);
  if (!total) return null;
  let acc = 0;
  for (const [v, w] of xs) {
    acc += w;
    if (acc * 2 >= total) return v;
  }
  return xs[xs.length - 1]![0];
}
