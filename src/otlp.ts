/**
 * @file Optional OTLP ingest: `POST /api/ingest/otlp` takes OTLP/HTTP **JSON** metrics (Claude Code's own OpenTelemetry export)
 * and adds the `claude_code.token.usage` and `claude_code.cost.usage` counters to `usage_hourly`. OFF unless `OTLP_INGEST=1`
 * (it answers 404 otherwise). Numbers and model ids only: no other attribute, resource or log is read or stored. No AI.
 * @module dashboard-worker/otlp
 *
 * Same rules as the usage collector's upload: a `host` token (the token's name is the host), a size cap (OTLP_MAX_BYTES), at
 * most OTLP_MAX_POINTS data points per request, hours inside the hourly retention and not in the future, the host's write
 * budget charged per row. Only DELTA sums are taken (aggregationTemporality 1); a cumulative series is counted and skipped
 * (point Claude Code at the dashboard with OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta). Rows land under project
 * `(other)`, agent `claude-cli`, source `claude` (OTel carries no project), keyed by the host's local hour (its usage time zone,
 * else the dashboard's zone, DASHBOARD_TZ), in usage_hourly AND usage_daily, and are ADDED to what is there: do not send the same usage both here and
 * through the collector. Retried exports are deduplicated per data point (`otlp_seen`, migration 0009, 2 days).
 * See docs/otel.md for the name mapping.
 */
import { dashboardTz } from "./tz";
import { authenticateBearer } from "./auth";
import { claimHostWrites } from "./budget";
import { first, stmt } from "./db";
import { MAX_PROJECTS_PER_HOST, USAGE_HOURLY_RETENTION_DAYS, hostWriteBudget, type Env } from "./env";
import { readJsonBody } from "./ingest";
import { usageModel } from "./usage";
import { errorJson, isObj, json } from "./util";
import { localTime } from "./wellbeing";

export const OTLP_MAX_BYTES = 256 * 1024;
export const OTLP_MAX_POINTS = 2000;
const TOKEN_METRIC = "claude_code.token.usage";
const COST_METRIC = "claude_code.cost.usage";
const TYPE_FIELD: Record<string, "input" | "output" | "cacheRead" | "cacheWrite"> = { input: "input", output: "output", cacheRead: "cacheRead", cacheCreation: "cacheWrite" };

export interface OtlpRow { hour: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; usd: number | null }

/** One accepted data point: its dedupe key material and what it adds. */
export interface OtlpPoint { key: string; hour: string; model: string; field: "input" | "output" | "cacheRead" | "cacheWrite" | "usd"; value: number }

/** Dedupe keys of retried exports live this long. */
export const OTLP_SEEN_TTL_MS = 2 * 86_400_000;
const NANOS_RE = /^\d{1,20}$/;

const attr = (attrs: unknown, key: string): string | undefined => {
  if (!Array.isArray(attrs)) return undefined;
  for (const a of attrs) if (isObj(a) && a.key === key && isObj(a.value) && typeof a.value.stringValue === "string") return a.value.stringValue;
  return undefined;
};
const num = (p: Record<string, unknown>): number | null => {
  const v = p.asDouble ?? p.asInt;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
};

/**
 * The OTLP JSON body -> the accepted data points (each with its dedupe key material) and the hourly rows they sum to. Pure.
 * Counts what it skipped: cumulative series, points outside the window (or with an unreadable time), other metrics, points over
 * the cap.
 */
export function otlpPoints(body: unknown, now: number, tz: string): { points: OtlpPoint[]; skipped: { cumulative: number; outside: number; other: number; capped: number } } {
  const skipped = { cumulative: 0, outside: 0, other: 0, capped: 0 };
  const points: OtlpPoint[] = [];
  const lowest = now - USAGE_HOURLY_RETENTION_DAYS * 86_400_000;
  let n = 0;
  const rms = isObj(body) && Array.isArray(body.resourceMetrics) ? body.resourceMetrics : [];
  for (const rm of rms) {
    for (const sm of isObj(rm) && Array.isArray(rm.scopeMetrics) ? rm.scopeMetrics : []) {
      for (const m of isObj(sm) && Array.isArray(sm.metrics) ? sm.metrics : []) {
        if (!isObj(m) || (m.name !== TOKEN_METRIC && m.name !== COST_METRIC)) { skipped.other++; continue; }
        const sum = isObj(m.sum) ? m.sum : null;
        if (!sum) { skipped.other++; continue; }
        if (sum.aggregationTemporality !== 1 && sum.aggregationTemporality !== "AGGREGATION_TEMPORALITY_DELTA") { skipped.cumulative++; continue; }
        for (const p of Array.isArray(sum.dataPoints) ? sum.dataPoints : []) {
          if (!isObj(p)) continue;
          if (++n > OTLP_MAX_POINTS) { skipped.capped++; continue; }
          const v = num(p);
          // a time that is not a plain integer of nanoseconds is "outside", never an error
          const tRaw = typeof p.timeUnixNano === "number" ? String(Math.trunc(p.timeUnixNano)) : p.timeUnixNano;
          const t = typeof tRaw === "string" && NANOS_RE.test(tRaw) ? Number(BigInt(tRaw) / 1_000_000n) : NaN;
          if (v === null || !Number.isFinite(t) || t < lowest || t > now + 5 * 60_000) { skipped.outside++; continue; }
          let field: OtlpPoint["field"];
          if (m.name === COST_METRIC) field = "usd";
          else {
            const f = TYPE_FIELD[attr(p.attributes, "type") ?? ""];
            if (!f) { skipped.other++; continue; }
            field = f;
          }
          const lt = localTime(t, tz);
          const model = usageModel(attr(p.attributes, "model") ?? "") ?? "unknown";
          const start = typeof p.startTimeUnixNano === "string" && NANOS_RE.test(p.startTimeUnixNano) ? p.startTimeUnixNano : "";
          const attrs = Array.isArray(p.attributes) ? p.attributes.filter(isObj).map((a) => `${String(a.key)}=${isObj(a.value) ? String(a.value.stringValue ?? a.value.intValue ?? "") : ""}`).sort().join("&") : "";
          points.push({ key: `${m.name}|${attrs}|${start}|${tRaw}`, hour: `${lt.day}T${String(lt.hour).padStart(2, "0")}`, model, field, value: field === "usd" ? v : Math.round(v) });
        }
      }
    }
  }
  return { points, skipped };
}

/** Sum points into hourly rows (per hour and model). Pure. */
export function sumPoints(points: readonly OtlpPoint[]): OtlpRow[] {
  const acc = new Map<string, OtlpRow>();
  for (const p of points) {
    const k = `${p.hour}\t${p.model}`;
    const row = acc.get(k) ?? { hour: p.hour, model: p.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: null };
    if (p.field === "usd") row.usd = (row.usd ?? 0) + p.value;
    else row[p.field] += p.value;
    acc.set(k, row);
  }
  return [...acc.values()].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : a.model < b.model ? -1 : 1));
}

/** The OTLP JSON body -> hourly rows (no dedupe). Pure; kept for callers that only need the sums. */
export function otlpRows(body: unknown, now: number, tz: string): { rows: OtlpRow[]; skipped: { cumulative: number; outside: number; other: number; capped: number } } {
  const { points, skipped } = otlpPoints(body, now, tz);
  return { rows: sumPoints(points), skipped };
}

async function hashKey(host: string, key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${host}\n${key}`));
  return [...new Uint8Array(d).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `POST /api/ingest/otlp` (OTLP/HTTP JSON metrics). */
export async function handleOtlpIngest(req: Request, env: Env, now: number): Promise<Response> {
  if (env.OTLP_INGEST !== "1") return errorJson(404, "not found");
  if (req.method !== "POST") return errorJson(405, "POST only", { Allow: "POST" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return errorJson(415, "OTLP/HTTP JSON only (Content-Type: application/json)");
  const auth = await authenticateBearer(req, env, "host", now);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(req, OTLP_MAX_BYTES);
  if (!body.ok) return body.response;
  const db = env.DB;
  const host = auth.source.name;
  // the host's zone from its usage uploads (a bookkeeping row with pushed_at 0 is not one), else the dashboard's
  const tz = (await first<{ tz: string }>(db, "SELECT tz FROM usage_hosts WHERE host = ?1 AND pushed_at > 0", host).catch(() => null))?.tz ?? dashboardTz();
  let zone = dashboardTz();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); zone = tz; } catch { /* keep London */ }
  const parsed = otlpPoints(body.value, now, zone);
  const skipped = { ...parsed.skipped, duplicate: 0 };
  if (!parsed.points.length) return json({ partialSuccess: {}, ok: true, rows: 0, skipped });
  // at-least-once exporters retry: a point already added (same host, metric, attributes, start and time) adds nothing again
  const keyed = await Promise.all(parsed.points.map(async (p) => ({ p, k: await hashKey(host, p.key) })));
  let fresh: Set<string>;
  try {
    await stmt(db, "DELETE FROM otlp_seen WHERE k IN (SELECT k FROM otlp_seen WHERE at < ?1 ORDER BY at LIMIT 500)", now - OTLP_SEEN_TTL_MS).run();
    const ins = await stmt(db, "INSERT INTO otlp_seen (k, at) SELECT value, ?1 FROM json_each(?2) WHERE true ON CONFLICT(k) DO NOTHING RETURNING k", now, JSON.stringify([...new Set(keyed.map((x) => x.k))])).all<{ k: string }>();
    fresh = new Set((ins.results ?? []).map((r) => r.k));
  } catch (err) {
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return errorJson(503, "OTLP storage is not set up (apply migration 0009)");
    throw err;
  }
  const taken = new Set<string>();
  const points = keyed.filter(({ k }) => {
    if (!fresh.has(k) || taken.has(k)) { skipped.duplicate++; return false; }
    taken.add(k);
    return true;
  }).map(({ p }) => p);
  const rows = sumPoints(points);
  if (!rows.length) return json({ partialSuccess: {}, ok: true, rows: 0, skipped });
  // charged per accepted data point (each is an otlp_seen row) and per usage row written (hourly + daily), whichever is more
  const claim = await claimHostWrites(db, auth.source.id, now, hostWriteBudget(MAX_PROJECTS_PER_HOST), Math.max(points.length, rows.length * 2), 0);
  const forget = () => stmt(db, "DELETE FROM otlp_seen WHERE k IN (SELECT value FROM json_each(?1))", JSON.stringify([...taken])).run().catch(() => undefined);
  if (!claim.ok) {
    await forget(); // not added: a retry later must count
    return errorJson(429, "write budget exhausted for this host", { "Retry-After": "3600" });
  }
  const addCols = `input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
         cache_write_5m = cache_write_5m + excluded.cache_write_5m,
         usd = CASE WHEN excluded.usd IS NULL THEN usd ELSE COALESCE(usd, 0) + excluded.usd END, updated = excluded.updated`;
  const src = (keyExpr: string) => `SELECT ${keyExpr}, ?1, '(other)', 'claude-cli', 'claude', json_extract(j.value, '$.model'),
              json_extract(j.value, '$.input'), json_extract(j.value, '$.output'), json_extract(j.value, '$.cacheRead'), json_extract(j.value, '$.cacheWrite'), 0, 0,
              json_extract(j.value, '$.usd'), ?2
       FROM json_each(?3) j WHERE true`;
  try {
    // the hour AND its day (the month view, KPIs and insights read usage_daily), in one transaction
    await db.batch([
      stmt(db, `INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated)
       ${src("json_extract(j.value, '$.hour')")}
       ON CONFLICT(hour, host, project, agent, source, model) DO UPDATE SET ${addCols}`, host, now, JSON.stringify(rows)),
      stmt(db, `INSERT INTO usage_daily (day, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated)
       ${src("substr(json_extract(j.value, '$.hour'), 1, 10)")}
       ON CONFLICT(day, host, project, agent, source, model) DO UPDATE SET ${addCols}`, host, now, JSON.stringify(rows)),
    ]);
  } catch (err) {
    await forget();
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return errorJson(503, "hourly usage storage is not set up (apply migration 0005)");
    throw err;
  }
  // OTLP/HTTP clients expect an ExportMetricsServiceResponse; the extra fields are ours
  return json({ partialSuccess: {}, ok: true, rows: rows.length, skipped });
}
