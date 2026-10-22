/** Optional OTLP ingest: off by default, host token, delta sums of the two Claude Code counters into usage_hourly, caps. */
import { describe, expect, test } from "bun:test";
import { route } from "../src/index";
import { OTLP_MAX_POINTS, otlpRows } from "../src/otlp";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

const NOW = Date.parse("2027-01-15T10:30:00Z");
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const point = (v: number, t: number, attrs: Record<string, string>) => ({ asDouble: v, timeUnixNano: ns(t), attributes: Object.entries(attrs).map(([key, s]) => ({ key, value: { stringValue: s } })) });
const body = (metrics: unknown[]) => ({ resourceMetrics: [{ resource: { attributes: [{ key: "user.email", value: { stringValue: "secret@example.com" } }] }, scopeMetrics: [{ metrics }] }] });
const tokens = (points: unknown[], temporality: number = 1) => ({ name: "claude_code.token.usage", sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints: points } });
const cost = (points: unknown[]) => ({ name: "claude_code.cost.usage", sum: { aggregationTemporality: 1, dataPoints: points } });

describe("otlpRows (pure)", () => {
  test("sums per local hour and model; maps the token types; costs in USD; skips cumulative, other metrics, old / future points", () => {
    const b = body([
      tokens([
        point(100, NOW - 10 * 60_000, { type: "input", model: "claude-opus-5-5" }),
        point(50, NOW - 9 * 60_000, { type: "input", model: "claude-opus-5-5" }),
        point(20, NOW - 9 * 60_000, { type: "output", model: "claude-opus-5-5" }),
        point(900, NOW - 8 * 60_000, { type: "cacheRead", model: "claude-opus-5-5" }),
        point(30, NOW - 8 * 60_000, { type: "cacheCreation", model: "claude-opus-5-5" }),
        point(5, NOW - 100 * 86_400_000, { type: "input", model: "claude-opus-5-5" }), // beyond the hourly retention
        point(5, NOW + 3_600_000, { type: "input", model: "claude-opus-5-5" }), // future
        point(7, NOW - 60_000, { type: "input", model: "some-local-model" }),
      ]),
      cost([point(0.42, NOW - 9 * 60_000, { model: "claude-opus-5-5" })]),
      tokens([point(1, NOW, { type: "input", model: "x" })], 2), // cumulative
      { name: "claude_code.session.count", sum: { aggregationTemporality: 1, dataPoints: [] } },
    ]);
    const r = otlpRows(b, NOW, "Asia/Hong_Kong");
    expect(r.rows).toEqual([
      { hour: "2027-01-15T18", model: "claude-opus-5-5", input: 150, output: 20, cacheRead: 900, cacheWrite: 30, usd: 0.42 },
      { hour: "2027-01-15T18", model: "unknown", input: 7, output: 0, cacheRead: 0, cacheWrite: 0, usd: null },
    ]);
    expect(r.skipped).toEqual({ cumulative: 1, outside: 2, other: 1, capped: 0 });
    expect(JSON.stringify(r)).not.toContain("secret@example.com");
  });
  test("at most OTLP_MAX_POINTS data points", () => {
    const pts = Array.from({ length: OTLP_MAX_POINTS + 5 }, () => point(1, NOW - 60_000, { type: "input", model: "claude-opus-5-5" }));
    const r = otlpRows(body([tokens(pts)]), NOW, "UTC");
    expect(r.skipped.capped).toBe(5);
    expect(r.rows[0]?.input).toBe(OTLP_MAX_POINTS);
  });
});

describe("POST /api/ingest/otlp", () => {
  const send = async (env: Record<string, string | undefined>, payload: unknown, kind: "host" | "client" = "host", ct = "application/json") => {
    const t = makeEnv(env);
    const tok = await addSource(t.db, "laptop", kind);
    const call = () => route(request("/api/ingest/otlp", { rawBody: JSON.stringify(payload), token: tok, headers: { "Content-Type": ct } }), t.env, makeCtx(), { now: NOW });
    return { t, call };
  };
  const ok = body([tokens([point(100, NOW - 60_000, { type: "input", model: "claude-opus-5-5" })]), cost([point(0.5, NOW - 60_000, { model: "claude-opus-5-5" })])]);

  test("off by default (404); on with OTLP_INGEST=1; a retried export adds nothing; the day gets it too", async () => {
    const off = await send({}, ok);
    expect((await off.call()).status).toBe(404);
    const on = await send({ OTLP_INGEST: "1" }, ok);
    const r1 = await on.call();
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, rows: 1 });
    const r2 = await on.call(); // the exporter retries the same export
    expect(await r2.json()).toMatchObject({ ok: true, rows: 0, skipped: { duplicate: 2 } });
    expect(on.t.db.rows("SELECT hour, host, project, agent, source, model, input, usd FROM usage_hourly")).toEqual([
      { hour: "2027-01-15T10", host: "laptop", project: "(other)", agent: "claude-cli", source: "claude", model: "claude-opus-5-5", input: 100, usd: 0.5 },
    ]);
    expect(on.t.db.rows("SELECT day, host, project, model, input, usd FROM usage_daily")).toEqual([
      { day: "2027-01-15", host: "laptop", project: "(other)", model: "claude-opus-5-5", input: 100, usd: 0.5 },
    ]);
  });
  test("a later export (new times) adds to the same hour and day; old dedupe keys expire after 2 days", async () => {
    const on = await send({ OTLP_INGEST: "1" }, ok);
    await on.call();
    const later = body([tokens([point(40, NOW - 30_000, { type: "input", model: "claude-opus-5-5" })])]);
    const tok = await addSource(on.t.db, "laptop2", "host");
    expect((await route(request("/api/ingest/otlp", { rawBody: JSON.stringify(later), token: tok, headers: { "Content-Type": "application/json" } }), on.t.env, makeCtx(), { now: NOW })).status).toBe(200);
    expect(on.t.db.rows<{ host: string; input: number }>("SELECT host, input FROM usage_hourly ORDER BY host")).toEqual([{ host: "laptop", input: 100 }, { host: "laptop2", input: 40 }]);
    on.t.db.sqlite.run("UPDATE otlp_seen SET at = 0");
    const again = await send({ OTLP_INGEST: "1" }, ok);
    again.t.db.sqlite.run("INSERT INTO otlp_seen (k, at) VALUES ('old', 0)");
    await again.call();
    expect(again.t.db.rows("SELECT k FROM otlp_seen WHERE k = 'old'")).toEqual([]);
  });
  test("a non-integer timeUnixNano is skipped as outside, never a 500", async () => {
    const weird = body([tokens([
      { asDouble: 5, timeUnixNano: "12.5e3", attributes: [{ key: "type", value: { stringValue: "input" } }] },
      { asDouble: 5, timeUnixNano: "not-a-number", attributes: [{ key: "type", value: { stringValue: "input" } }] },
      { asDouble: 5, timeUnixNano: { x: 1 }, attributes: [{ key: "type", value: { stringValue: "input" } }] },
    ])]);
    const on = await send({ OTLP_INGEST: "1" }, weird);
    const r = await on.call();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ rows: 0, skipped: { outside: 3 } });
  });
  test("a client token is refused (403); no token 401; protobuf 415; oversize 413", async () => {
    expect((await (await send({ OTLP_INGEST: "1" }, ok, "client")).call()).status).toBe(403);
    const t = makeEnv({ OTLP_INGEST: "1" });
    expect((await route(request("/api/ingest/otlp", { rawBody: "{}", headers: { "Content-Type": "application/json" } }), t.env, makeCtx(), { now: NOW })).status).toBe(401);
    expect((await (await send({ OTLP_INGEST: "1" }, ok, "host", "application/x-protobuf")).call()).status).toBe(415);
    const big = body([tokens(Array.from({ length: 4000 }, () => point(1, NOW, { type: "input", model: "x".repeat(60) })))]);
    expect((await (await send({ OTLP_INGEST: "1" }, big)).call()).status).toBe(413);
  });
});

test("the write budget is charged per accepted data point", async () => {
  const t = makeEnv({ OTLP_INGEST: "1" });
  const tok = await addSource(t.db, "laptop", "host");
  const pts = Array.from({ length: 30 }, (_, i) => point(1, NOW - 60_000 - i, { type: "input", model: "claude-opus-5-5" }));
  const before = (t.db.sqlite.query("SELECT wr_count AS c FROM sources WHERE name = 'laptop'").get() as { c: number | null } | null)?.c ?? 0;
  const res = await route(request("/api/ingest/otlp", { rawBody: JSON.stringify(body([tokens(pts)])), token: tok, headers: { "Content-Type": "application/json" } }), t.env, makeCtx(), { now: NOW });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ rows: 1 });
  const after = (t.db.sqlite.query("SELECT wr_count AS c FROM sources WHERE name = 'laptop'").get() as { c: number }).c;
  expect(after - before).toBe(30); // 30 points, not 2 rows
});
