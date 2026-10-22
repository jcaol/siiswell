import { describe, expect, test } from "bun:test";
import { purgeOld } from "../src/alerts";
import { hostWriteBudget, MAX_USAGE_RANGE_DAYS, MAX_USAGE_ROWS_PER_HOST_DAY, MAX_USAGE_ROWS_PER_HOST_PER_DAY, MAX_USAGE_ROWS_PER_REQUEST } from "../src/env";
import { route } from "../src/index";
import { MAX_USAGE_COMPLETE_DAYS, MAX_USAGE_ERASE_ROWS, SQL_USAGE_INSERT, USAGE_DAY_CHARGE, dashDay, MAX_USAGE_REQUESTS, MAX_USAGE_TOKENS, MAX_USAGE_USD, sanitizeUsageBatch } from "../src/usage";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";

const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const DAY = 86_400_000;
const dayOf = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);
const TODAY = dayOf(0);

const row = (over: Record<string, unknown> = {}) => ({
  day: TODAY, project: "projg", agent: "agent01", source: "claude", model: "claude-opus-5-5",
  input: 1000, output: 500, cacheRead: 20000, cacheWrite5m: 300, cacheWrite1h: 100, requests: 12, usd: 1.5, ...over,
});
const body = (rows: unknown[], over: Record<string, unknown> = {}) => ({ v: 1, host: "hosta", tz: "Europe/London", generatedAt: NOW - 1000, mode: "recent", rows, ...over });

async function boot(envOver: Record<string, string | undefined> = {}) {
  const t = makeEnv(envOver);
  const ctx = makeCtx();
  const hostToken = await addSource(t.db, "hosta", "host");
  const otherToken = await addSource(t.db, "other-host", "host");
  const clientToken = await addSource(t.db, "client1", "client");
  const call = (path: string, init: Parameters<typeof request>[1] = {}, now = NOW) => route(request(path, init), t.env, ctx, { now });
  const post = (b: unknown, token = hostToken) => call("/api/ingest/usage", { body: b, token });
  const count = () => (t.db.rows<{ c: number }>("SELECT COUNT(*) AS c FROM usage_daily")[0] as { c: number }).c;
  return { ...t, ctx, hostToken, otherToken, clientToken, call, post, count };
}

describe("POST /api/ingest/usage: auth and validation", () => {
  test("no / bad / client token are refused; a host token for another label cannot write for hosta", async () => {
    const b = await boot();
    expect((await b.call("/api/ingest/usage", { body: body([row()]) })).status).toBe(401);
    expect((await b.call("/api/ingest/usage", { body: body([row()]), token: "oct_nope" })).status).toBe(401);
    expect((await b.post(body([row()]), b.clientToken)).status).toBe(403);
    expect((await b.post(body([row()]), b.otherToken)).status).toBe(403); // payload says hosta, token is other-host
    expect((await b.call("/api/ingest/usage", { method: "GET", token: b.hostToken })).status).toBe(405);
    expect(b.count()).toBe(0);
  });

  test("a leaked token only ever writes its own host's rows: the same key from two hosts stays two rows", async () => {
    const b = await boot();
    expect((await b.post(body([row({ usd: 1 })]))).status).toBe(200);
    expect((await b.post(body([row({ usd: 9 })], { host: "other-host" }), b.otherToken)).status).toBe(200);
    expect(b.db.rows("SELECT host, usd FROM usage_daily ORDER BY host")).toEqual([{ host: "hosta", usd: 1 }, { host: "other-host", usd: 9 }]);
  });

  test("every string is validated, never rewritten", async () => {
    const b = await boot();
    const bad: Array<Record<string, unknown>> = [
      { day: "2027-1-5" }, { day: "2027-02-30" }, { day: 20270115 },
      { project: "a|b" }, { project: "" }, { project: "x".repeat(65) }, { project: "client name" }, { project: "../etc" },
      { agent: "a b" }, { agent: "claude@acme" }, { source: "claude\n" }, { model: 5 }, { model: "x".repeat(201) },
      { input: -1 }, { output: "5" }, { requests: 1e12 }, { cacheRead: 1e14 }, { usd: -0.01 }, { usd: "1" }, { usd: 1e9 }, { input: null },
    ];
    for (const over of bad) {
      const res = await b.post(body([row(over)]));
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
    expect((await b.post({ ...body([row()]), v: 2 })).status).toBe(400);
    expect((await b.post({ ...body([row()]), rows: "x" })).status).toBe(400);
    expect((await b.post({ ...body([row()]), tz: "Europe London" })).status).toBe(400);
    expect((await b.post({ ...body([row()]), mode: "all" })).status).toBe(400);
    expect(b.count()).toBe(0);
    // the 400 never echoes a stored value; the accepted shapes include the documented odd ones
    const ok = [row({ project: "(other)", agent: "(other)", model: "claude-sonnet-5-5[1m]" }), row({ agent: "operator", model: "anthropic/claude-3-5-haiku", usd: null })];
    expect((await b.post(body(ok))).status).toBe(200);
    expect(b.count()).toBe(2);
    expect(b.db.rows("SELECT DISTINCT model FROM usage_daily ORDER BY model")).toEqual([{ model: "claude-haiku-3-5" }, { model: "claude-sonnet-5-5" }]); // normalised to the table's id
  });

  test("more than 2000 rows or an oversized body is refused", async () => {
    const b = await boot();
    const many = Array.from({ length: MAX_USAGE_ROWS_PER_REQUEST + 1 }, (_, i) => row({ agent: `a${i}` }));
    expect((await b.post(body(many))).status).toBe(400);
    const huge = Array.from({ length: 1500 }, (_, i) => row({ agent: `a${i}`, project: "p".repeat(64), model: "m".repeat(80) }));
    expect((await b.call("/api/ingest/usage", { token: b.hostToken, rawBody: JSON.stringify(body(huge)) + " ".repeat(1024 * 1024) })).status).toBe(413);
  });

  test("duplicate keys in one request: the later row wins; days outside the retention window are dropped and counted", async () => {
    const b = await boot();
    const res = await b.post(body([row({ usd: 1 }), row({ usd: 2 }), row({ day: dayOf(-900) }), row({ day: dayOf(5) })]));
    expect(await res.json()).toMatchObject({ ok: true, rows: 1, dropped: 2 });
    expect(b.db.rows("SELECT usd FROM usage_daily")).toEqual([{ usd: 2 }]);
    const small = await boot({ USAGE_RETENTION_DAYS: "40" });
    expect(await (await small.post(body([row({ day: dayOf(-39) }), row({ day: dayOf(-41), agent: "z" })]))).json()).toMatchObject({ rows: 1, dropped: 1 });
  });

  test("no free text is stored: the row has only labels and counters, and sanitizeUsageBatch builds fresh objects", () => {
    const r = sanitizeUsageBatch({ v: 1, host: "h", rows: [{ ...row(), note: "client secret", extra: { a: 1 } }] }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value.rows[0]!).sort()).toEqual(["agent", "cacheRead", "cacheWrite1h", "cacheWrite5m", "day", "input", "model", "output", "project", "requests", "source", "usd"]);
  });
});

describe("POST /api/ingest/usage: upsert, history, budgets", () => {
  test("idempotent: re-sending the same numbers writes nothing, a changed number updates the row", async () => {
    const b = await boot();
    await b.post(body([row()]));
    const first = b.db.rows<{ updated: number }>("SELECT updated FROM usage_daily")[0]!.updated;
    const res = await route(request("/api/ingest/usage", { body: body([row()]), token: b.hostToken }), b.env, b.ctx, { now: NOW + 60_000 });
    expect(res.status).toBe(200);
    expect(b.db.rows<{ updated: number }>("SELECT updated FROM usage_daily")[0]!.updated).toBe(first);
    expect(b.count()).toBe(1);
    await route(request("/api/ingest/usage", { body: body([row({ output: 501 })]), token: b.hostToken }), b.env, b.ctx, { now: NOW + 120_000 });
    expect(b.db.rows("SELECT output, updated FROM usage_daily")).toEqual([{ output: 501, updated: NOW + 120_000 }]);
    expect(b.count()).toBe(1);
    // usd null <-> number counts as a change too
    await b.post(body([row({ usd: null, output: 501 })]));
    expect(b.db.rows("SELECT usd FROM usage_daily")).toEqual([{ usd: null }]);
  });

  test("needFull: true until a full upload completed; a recent push never completes it", async () => {
    const b = await boot();
    expect(await (await b.post(body([row()]))).json()).toMatchObject({ needFull: true });
    expect(await (await b.post(body([row()], { mode: "full" }))).json()).toMatchObject({ needFull: true }); // not complete yet
    expect(await (await b.post(body([row({ day: dayOf(-3) })], { mode: "full", complete: true }))).json()).toMatchObject({ needFull: false });
    expect(await (await b.post(body([row()]))).json()).toMatchObject({ needFull: false });
    expect(await (await b.post(body([row()], { host: "other-host" }), b.otherToken)).json()).toMatchObject({ needFull: true }); // per host
  });

  test("an upload that fails to write does not mark the history complete", async () => {
    const b = await boot();
    b.db.sqlite.query("CREATE TRIGGER boom BEFORE INSERT ON usage_daily BEGIN SELECT RAISE(ABORT, 'disk full'); END").run();
    const res = await b.post(body([row()], { mode: "full", complete: true }));
    expect(res.status).toBe(500);
    expect(b.db.rows("SELECT has_full FROM usage_hosts")).toEqual([{ has_full: 0 }]);
  });

  test("a full history of 5000 rows goes in as 3 requests and the budget window counts rows", async () => {
    const b = await boot();
    const mk = (i: number) => row({ day: dayOf(-(i % 30)), agent: `a${Math.floor(i / 30)}` });
    const rows = Array.from({ length: 5000 }, (_, i) => mk(i));
    for (let i = 0; i < 5000; i += 2000) expect((await b.post(body(rows.slice(i, i + 2000), { mode: "full", complete: i + 2000 >= 5000 }))).status).toBe(200);
    expect(b.count()).toBe(5000);
    expect(b.db.rows("SELECT win_count FROM usage_hosts")).toEqual([{ win_count: 5000 + 3 * 30 * USAGE_DAY_CHARGE }]); // rows + the per-day charge of each of the 3 requests (30 days each)
  });

  test("the daily row allowance is enforced BEFORE writing (429 + Retry-After) and resets with the window", async () => {
    const b = await boot();
    b.db.sqlite.query("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES ('hosta', ?, ?, 'Europe/London', 1, ?, ?)").run(NOW, NOW, NOW - 1000, MAX_USAGE_ROWS_PER_HOST_PER_DAY - (1 + USAGE_DAY_CHARGE));
    const res = await b.post(body([row(), row({ agent: "b" })]));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(b.count()).toBe(0);
    expect((await b.post(body([row()]))).status).toBe(200); // exactly the last allowed row
    const later = await route(request("/api/ingest/usage", { body: body([row({ agent: "c" })]), token: b.hostToken }), b.env, b.ctx, { now: NOW + DAY });
    expect(later.status).toBe(200);
  });

  test("one host cannot hold more than MAX_USAGE_ROWS_PER_HOST_DAY rows for one day (invented labels), known keys still update", async () => {
    const b = await boot();
    const first = Array.from({ length: MAX_USAGE_ROWS_PER_HOST_DAY }, (_, i) => row({ agent: `a${i}` }));
    for (let i = 0; i < first.length; i += 200) await b.post(body(first.slice(i, i + 200)));
    expect(b.count()).toBe(MAX_USAGE_ROWS_PER_HOST_DAY);
    const res = await b.post(body([row({ agent: "new-1" }), row({ agent: "a0", output: 7 }), row({ agent: "a1", day: dayOf(-1) })]));
    expect(res.status).toBe(200);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily WHERE agent = 'new-1'")).toEqual([{ c: 0 }]);
    expect(b.db.rows("SELECT output FROM usage_daily WHERE agent = 'a0'")).toEqual([{ output: 7 }]);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily WHERE host = 'hosta' AND day = ?", TODAY)).toEqual([{ c: MAX_USAGE_ROWS_PER_HOST_DAY }]);
    // the other host has a day of its own
    expect((await b.post(body([row({ agent: "x" })], { host: "other-host" }), b.otherToken)).status).toBe(200);
  });

  test("migration 0003 not applied yet: 503 with a hint, nothing else breaks", async () => {
    const b = await boot();
    b.db.sqlite.query("DROP TABLE usage_daily").run();
    b.db.sqlite.query("DROP TABLE usage_hosts").run();
    const res = await b.post(body([row()]));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("0003");
    expect((await b.call("/api/usage")).status).toBe(200); // the page degrades to "pending"
    expect(await (await b.call("/api/usage")).json()).toMatchObject({ pending: true, projects: [] });
  });

  test("a successful usage ingest starts the same housekeeping as the other ingest routes", async () => {
    const b = await boot({ OPPORTUNISTIC_MAINTENANCE: "1" });
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('gone', ?)").run(NOW - 40 * DAY);
    await b.post(body([row()]));
    await b.ctx.flush();
    expect(b.db.rows("SELECT host FROM hosts")).toEqual([]);
  });
});

describe("GET /api/usage", () => {
  async function seeded() {
    const b = await boot();
    const rows = [
      row({ day: TODAY, project: "projg", agent: "agent01", usd: 10, input: 100, output: 50, cacheRead: 1000, cacheWrite5m: 10, cacheWrite1h: 5, requests: 3 }),
      row({ day: TODAY, project: "projg", agent: "operator", source: "codex", model: "gpt-5.4", usd: 2.5, input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 1 }),
      row({ day: dayOf(-1), project: "proja", usd: 4, input: 40, output: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 2 }),
      row({ day: dayOf(-1), project: "(other)", model: "mystery-model", usd: null, input: 7, output: 3, cacheRead: 99, cacheWrite5m: 2, cacheWrite1h: 1, requests: 1 }),
      row({ day: "2026-12-20", project: "projg", usd: 100, input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1, requests: 1 }),
      row({ day: "2026-11-20", project: "projg", usd: 1000, input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1, requests: 1 }),
    ];
    expect((await b.post(body(rows))).status).toBe(200);
    return b;
  }
  type Usage = any;

  test("default (month): this month and last month, per project / agent / model, unpriced kept apart, one overall total", async () => {
    const b = await seeded();
    const res = await b.call("/api/usage");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const u = (await res.json()) as Usage;
    expect(u).toMatchObject({ group: "month", from: "2026-12-01", to: TODAY, basis: "API-equivalent (est.)" });
    expect(u.total).toMatchObject({ usd: 116.5, requests: 8, unpricedTokens: 13, input: 158, output: 79, cacheRead: 1100 });
    expect(u.projects.map((p: Usage) => [p.project, p.usd])).toEqual([["projg", 112.5], ["proja", 4], ["(other)", 0]]);
    expect(u.projects.find((p: Usage) => p.project === "(other)").unpricedTokens).toBe(13);
    expect(u.breakdown.filter((r: Usage) => r.project === "projg").map((r: Usage) => [r.agent, r.source, r.model])).toContainEqual(["operator", "codex", "gpt-5.4"]);
    expect(u.series.map((s: Usage) => [s.k, s.usd])).toEqual([["2026-12", 100], ["2027-01", 16.5]]);
    expect(u.bars.map((s: Usage) => s.day)).toEqual(["2026-12-20", dayOf(-1), TODAY]);
    expect(u.hosts).toEqual([{ host: "hosta", pushedAt: NOW, generatedAt: NOW - 1000, tz: "Europe/London", full: false }]);
  });

  test("group=day with an explicit range; the range is inclusive and bounded", async () => {
    const b = await seeded();
    const u = (await (await b.call(`/api/usage?group=day&from=${dayOf(-1)}&to=${dayOf(-1)}`)).json()) as Usage;
    expect(u.series).toHaveLength(1);
    expect(u.total.usd).toBe(4);
    const d = (await (await b.call("/api/usage?group=day")).json()) as Usage;
    expect(d.from).toBe(dayOf(-29));
    expect(d.series.map((s: Usage) => s.k)).toEqual(["2026-12-20", dayOf(-1), TODAY]); // 26 days back is inside the last 30
    for (const q of ["group=week", "from=2027-13-01", "from=abc", "to=2027-01-01&from=2027-02-01"]) {
      expect((await b.call(`/api/usage?${q}`)).status, q).toBe(400);
    }
  });

  test("empty database: zeros, no hosts, no error", async () => {
    const b = await boot();
    const u = (await (await b.call("/api/usage")).json()) as Usage;
    expect(u.total).toMatchObject({ usd: 0, requests: 0, unpricedTokens: 0 });
    expect(u.projects).toEqual([]);
    expect(u.hosts).toEqual([]);
  });

  test("a project name from two hosts is summed (usage is per project, not per host)", async () => {
    const b = await seeded();
    await b.post(body([row({ usd: 5, project: "projg", agent: "agent01" })], { host: "other-host" }), b.otherToken);
    const u = (await (await b.call("/api/usage")).json()) as Usage;
    expect(u.projects.find((p: Usage) => p.project === "projg").usd).toBe(117.5);
    expect(u.hosts.map((h: Usage) => h.host)).toEqual(["hosta", "other-host"]);
  });

  test("results are bounded: 600+ breakdown rows are cut and reported", async () => {
    const b = await boot();
    for (let k = 0; k < 4; k++) {
      await b.post(body(Array.from({ length: 200 }, (_, i) => row({ day: dayOf(-k), agent: `a${i}`, project: `p${k}`, usd: 1 }))));
    }
    const u = (await (await b.call("/api/usage")).json()) as Usage;
    expect(u.breakdown).toHaveLength(600);
    expect(u.truncated).toEqual(["breakdown", "hostBreakdown"]);
    expect(u.total.requests).toBe(800 * 12); // the total is NOT cut
  });

  test("dashDay: the day of an instant in the dashboard's zone (UTC by default; DST aware)", () => {
    expect(dashDay(Date.UTC(2026, 6, 1, 23, 30), "Europe/London")).toBe("2026-07-02"); // BST = UTC+1
    expect(dashDay(Date.UTC(2026, 11, 1, 23, 30), "Europe/London")).toBe("2026-12-01");
    expect(dashDay(Date.UTC(2026, 6, 1, 23, 30))).toBe("2026-07-01"); // the default zone, UTC
  });
});

describe("GET /api/usage sits behind the same gate as /api/state and is not part of it", () => {
  const TEAM = "team.cloudflareaccess.com";
  test("without a valid Access identity: 403 (like /api/state); cross-site browser requests: 403; POST: 405", async () => {
    const b = await boot({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud", DEV_NO_ACCESS: undefined });
    expect((await b.call("/api/state")).status).toBe(403);
    expect((await b.call("/api/usage")).status).toBe(403);
    expect((await b.call("/api/usage", { headers: { "Cf-Access-Jwt-Assertion": "x.y.z" } })).status).toBeGreaterThanOrEqual(401);
    const dev = await boot();
    expect((await dev.call("/api/usage", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await dev.call("/api/usage", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await dev.call("/api/usage", { method: "POST", body: {} })).status).toBe(405);
    expect((await dev.call("/api/usage", { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  test("the e-mail allow-list applies: the route calls requireAccess (a service token / other e-mail is refused)", async () => {
    // requireAccess is covered in auth.test.ts; here only that /api/usage is wired to it (same 403 body as /api/state).
    const b = await boot({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud", ACCESS_ALLOWED_EMAILS: "ops@example.com", DEV_NO_ACCESS: undefined });
    const a = await b.call("/api/state");
    const u = await b.call("/api/usage");
    expect(u.status).toBe(a.status);
    expect(await u.json()).toEqual(await a.json());
  });

  test("/api/state carries no usage figures", async () => {
    const b = await boot();
    await b.post(body([row()]));
    const text = await (await b.call("/api/state")).text();
    expect(text).not.toContain("usage_daily");
    expect(Object.keys(JSON.parse(text))).not.toContain("usage");
    expect(text).not.toContain("cacheRead");
  });
});

describe("retention", () => {
  test("usage_daily is purged by its own retention (default 800 days), oldest days first, bounded per run", async () => {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', 'a', 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)");
    for (let i = 0; i < 12; i++) ins.run(dayOf(-801 - i));
    for (const d of [dayOf(-799), dayOf(-1)]) ins.run(d);
    expect(await purgeOld(b.env.DB, NOW, 30, 5)).toMatchObject({ usageDaily: 5 });
    expect(b.count()).toBe(9);
    expect(await purgeOld(b.env.DB, NOW, 30, 5)).toMatchObject({ usageDaily: 5 });
    expect(await purgeOld(b.env.DB, NOW, 30, 5)).toMatchObject({ usageDaily: 2 });
    expect(b.db.rows("SELECT day FROM usage_daily ORDER BY day")).toEqual([{ day: dayOf(-799) }, { day: dayOf(-1) }]);
    // a shorter retention for the usage table
    expect(await purgeOld(b.env.DB, NOW, 30, 500, 100)).toMatchObject({ usageDaily: 1 });
    expect(b.db.rows("SELECT day FROM usage_daily")).toEqual([{ day: dayOf(-1) }]);
  });

  test("the retention of the general tables does not touch usage rows (30 d vs 800 d), and a silent host's usage_hosts row goes with the general retention", async () => {
    const b = await boot();
    await b.post(body([row({ day: dayOf(-100) })]));
    b.db.sqlite.query("UPDATE usage_hosts SET pushed_at = ?, win_start = ?").run(NOW - 31 * DAY, NOW - 31 * DAY);
    expect(await purgeOld(b.env.DB, NOW, 30)).toMatchObject({ usageDaily: 0, usageHosts: 1 });
    expect(b.count()).toBe(1);
  });

  test("USAGE_RETENTION_DAYS: whole days >= 31, capped, invalid = 800; a missing table is tolerated; the error of another table still surfaces after usage ran", async () => {
    const { usageRetentionDaysOf } = await import("../src/env");
    expect([undefined, "", "abc", "10", "400", "99999"].map((v) => usageRetentionDaysOf({ USAGE_RETENTION_DAYS: v }))).toEqual([800, 800, 800, 800, 400, 3650]);
    const b = await boot();
    b.db.sqlite.query("DROP TABLE usage_daily").run();
    b.db.sqlite.query("DROP TABLE usage_hosts").run();
    expect(await purgeOld(b.env.DB, NOW, 30)).toMatchObject({ usageDaily: 0, usageHosts: 0 });
    const c = await boot();
    c.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', 'a', 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)").run(dayOf(-900));
    c.db.sqlite.query("DROP TABLE events").run();
    await expect(purgeOld(c.env.DB, NOW, 30)).rejects.toThrow(/events:/);
    expect(c.count()).toBe(0);
  });
});

describe("query plans: every usage query is a primary-key seek, never a scan of the table", () => {
  test("range reads, the per-day cap count and the purge walk the day-first primary key", async () => {
    const b = await boot();
    const plan = (sql: string, ...p: Array<string | number>) => b.db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...p).map((r) => r.detail).join(" | ");
    for (const sql of [
      "SELECT SUM(input) FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY project",
      "SELECT day, COUNT(*) FROM usage_daily WHERE host = ?1 AND day IN (SELECT value FROM json_each(?2)) GROUP BY day",
      "SELECT project FROM usage_daily WHERE host = ?1 AND day = ?2 LIMIT 10",
      "SELECT day FROM usage_daily WHERE day < ?1 ORDER BY day LIMIT ?2",
    ]) {
      const p = plan(sql, "a", "b");
      expect(p, sql).toMatch(/SEARCH usage_daily|SCAN usage_daily/);
      expect(p, sql).toContain("PRIMARY KEY");
    }
  });
});

describe("security hardening (review findings)", () => {
  test("1. counters are capped at ingest: the ceiling is accepted, one above is a 400", async () => {
    const b = await boot();
    const max = row({ input: MAX_USAGE_TOKENS, output: MAX_USAGE_TOKENS, cacheRead: MAX_USAGE_TOKENS, cacheWrite5m: MAX_USAGE_TOKENS, cacheWrite1h: MAX_USAGE_TOKENS, requests: MAX_USAGE_REQUESTS, usd: MAX_USAGE_USD });
    expect((await b.post(body([max]))).status).toBe(200);
    for (const over of [{ input: MAX_USAGE_TOKENS + 1e6 }, { cacheWrite1h: MAX_USAGE_TOKENS * 10 }, { requests: MAX_USAGE_REQUESTS + 1 }, { usd: MAX_USAGE_USD + 1 }, { output: 9.3e18 }]) {
      expect((await b.post(body([row({ agent: "z", ...over })]))).status, JSON.stringify(over)).toBe(400);
    }
  });

  test("1. the read cannot be broken by huge stored values (rows from before the cap): sums past 2^63 do not overflow", async () => {
    const b = await boot();
    const q = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', ?, 'claude', 'm', 9000000000000000000, 9000000000000000000, 9000000000000000000, 9000000000000000000, 9000000000000000000, 9000000000000000000, NULL, 1)");
    for (let i = 0; i < 5; i++) q.run(TODAY, `a${i}`);
    for (const url of ["/api/usage", "/api/usage?group=day"]) {
      const res = await b.call(url);
      expect(res.status, url).toBe(200);
      const u = (await res.json()) as any;
      expect(u.total.input).toBeGreaterThan(4e19);
      expect(u.total.unpricedTokens).toBeGreaterThan(1e20);
    }
    // the plain SUM would have thrown on the same rows
    expect(() => b.db.sqlite.query("SELECT SUM(input) FROM usage_daily").get()).toThrow(/overflow/i);
  });

  test("2. the per-host-and-day cap is enforced by the INSERT itself: concurrent batches with different labels cannot exceed it", async () => {
    const b = await boot();
    const mk = (tag: string) => Array.from({ length: 300 }, (_, i) => row({ agent: `${tag}${i}` }));
    const results = await Promise.all(["a", "b", "c", "d"].map((t) => b.post(body(mk(t)))));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily WHERE host = 'hosta' AND day = ?", TODAY)).toEqual([{ c: MAX_USAGE_ROWS_PER_HOST_DAY }]);
  });

  test("2. even a request whose pre-check saw room cannot overshoot (the cap is in the SQL): rows inserted behind its back are counted", async () => {
    const b = await boot();
    const { SQL_USAGE_INSERT } = await import("../src/usage");
    const fill = (tag: string, n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => [TODAY, "p", `${tag}${i}`, "claude", "m", 1, 1, 1, 1, 1, 1, 1]));
    await b.db.prepare(SQL_USAGE_INSERT).bind(fill("x", 450), "hosta", NOW, MAX_USAGE_ROWS_PER_HOST_DAY).run();
    await b.db.prepare(SQL_USAGE_INSERT).bind(fill("y", 450), "hosta", NOW, MAX_USAGE_ROWS_PER_HOST_DAY).run(); // both "saw" 0 rows beforehand
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily")).toEqual([{ c: MAX_USAGE_ROWS_PER_HOST_DAY }]);
    // existing keys are still updated at the cap
    await b.db.prepare(SQL_USAGE_INSERT).bind(fill("x", 3), "hosta", NOW, MAX_USAGE_ROWS_PER_HOST_DAY).run();
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily")).toEqual([{ c: MAX_USAGE_ROWS_PER_HOST_DAY }]);
  });

  test("2. usage writes are charged to the host's ordinary write budget too (a spent budget refuses usage with 429)", async () => {
    const b = await boot();
    b.db.sqlite.query("UPDATE sources SET wr_window_start = ?, wr_count = 1000000 WHERE name = 'hosta'").run(NOW - 1000);
    const res = await b.post(body([row()]));
    expect(res.status).toBe(429);
    expect(b.count()).toBe(0);
    const ok = await boot();
    await ok.post(body([row()]));
    expect(ok.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'hosta'")[0]!.wr_count).toBeGreaterThan(0);
  });

  test("3. a wrong, malformed or missing token does no D1 work beyond the one token lookup (none at all for a missing / malformed one)", async () => {
    const b = await boot();
    b.db.statements.length = 0;
    expect((await b.call("/api/ingest/usage", { body: body([row()]) })).status).toBe(401);
    expect((await b.call("/api/ingest/usage", { body: body([row()]), token: "oct_short" })).status).toBe(401);
    expect(b.db.statements).toEqual([]);
    const wrong = `oct_${"A".repeat(43)}`;
    expect((await b.call("/api/ingest/usage", { body: body([row()]), token: wrong })).status).toBe(401);
    expect(b.db.statements.length).toBe(1);
    expect(b.db.statements[0]).toMatch(/FROM sources/);
    expect((await b.call("/api/ingest/usage", { method: "GET", token: wrong })).status).toBe(405);
  });

  test("3. size bounds come before parsing: a declared or streamed oversize body is 413 without D1 work after auth, 2001 rows are refused before row validation", async () => {
    const b = await boot();
    b.db.statements.length = 0;
    const res = await b.call("/api/ingest/usage", { token: b.hostToken, rawBody: "x".repeat(1024 * 1024 + 1), headers: { "Content-Length": String(1024 * 1024 + 1) } });
    expect(res.status).toBe(413);
    expect(b.db.statements.every((s) => /FROM sources|UPDATE sources/.test(s))).toBe(true);
    b.db.statements.length = 0;
    // 2001 rows of which the FIRST is invalid: the count refusal wins (rows are not iterated)
    const rows = [row({ day: "nope" }), ...Array.from({ length: MAX_USAGE_ROWS_PER_REQUEST }, () => row())];
    const r2 = await b.post(body(rows));
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toContain("at most");
    expect(b.db.statements.some((s) => /usage_daily/.test(s))).toBe(false);
  });

  test("3. GET /api/usage: the range is clamped to 400 days before any query, the answer says so, and the response stays small in the worst case", async () => {
    const b = await boot();
    const wide = (await (await b.call("/api/usage?group=month&from=2020-01-01&to=2027-01-01")).json()) as any;
    expect(wide.clamped).toBe(true);
    expect((Date.parse(`${wide.to}T00:00:00Z`) - Date.parse(`${wide.from}T00:00:00Z`)) / DAY).toBe(MAX_USAGE_RANGE_DAYS - 1);
    expect(((await (await b.call("/api/usage")).json()) as any).clamped).toBeUndefined();
    // worst case: 100+ projects x many agents/models, 400 days
    for (let d = 0; d < 40; d++) {
      await b.post(body(Array.from({ length: 150 }, (_, i) => row({ day: dayOf(-d * 10), project: `p${i % 120}`, agent: `a${i}`, model: `m${i % 7}` }))));
    }
    const res = await b.call("/api/usage?group=day&from=2025-12-01&to=2027-01-15");
    const text = await res.text();
    const u = JSON.parse(text);
    expect(u.projects.length).toBeLessThanOrEqual(100);
    expect(u.breakdown.length).toBeLessThanOrEqual(600);
    expect(u.series.length).toBeLessThanOrEqual(MAX_USAGE_RANGE_DAYS);
    expect(text.length).toBeLessThan(400_000);
    // every SELECT of the read path has a LIMIT or is a single aggregate row
    b.db.statements.length = 0;
    await b.call("/api/usage");
    for (const sql of b.db.statements.filter((s) => /FROM usage_daily/.test(s))) expect(sql).toMatch(/LIMIT|^SELECT TOTAL\(input\)[^G]*$/);
  });
});

describe("authoritative days, the full-history share and charging what was written (reviewer2)", () => {
  const winCount = (b: Awaited<ReturnType<typeof boot>>) => b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts")[0]!.win_count;

  test("a batch with completeDays replaces the host's rows of those days: a project that left, or a name now folded into (other), is not counted twice", async () => {
    const b = await boot();
    await b.post(body([row({ project: "client-acme", agent: "a1" }), row({ project: "projg" }), row({ day: dayOf(-1), project: "client-acme" }), row({ day: dayOf(-5), project: "client-acme" })]));
    // the policy tightened: the same usage now arrives as (other); today and yesterday are complete in this request
    const res = await b.post(body([row({ project: "(other)", agent: "(other)" }), row({ project: "projg" }), row({ day: dayOf(-1), project: "(other)", agent: "(other)" })], { completeDays: [TODAY, dayOf(-1)] }));
    expect(res.status).toBe(200);
    expect(b.db.rows("SELECT day, project FROM usage_daily ORDER BY day, project")).toEqual([
      { day: dayOf(-5), project: "client-acme" }, // a day the request did not declare: untouched
      { day: dayOf(-1), project: "(other)" },
      { day: TODAY, project: "(other)" },
      { day: TODAY, project: "projg" },
    ]);
  });

  test("another host's rows are never deleted, and a request without completeDays deletes nothing (old senders)", async () => {
    const b = await boot();
    await b.post(body([row({ project: "x" })], { host: "other-host" }), b.otherToken);
    await b.post(body([row({ project: "old" })]));
    await b.post(body([row({ project: "new" })])); // no completeDays
    expect(b.count()).toBe(3);
    await b.post(body([row({ project: "new" })], { completeDays: [TODAY] }));
    expect(b.db.rows("SELECT host, project FROM usage_daily ORDER BY host, project")).toEqual([{ host: "hosta", project: "new" }, { host: "other-host", project: "x" }]);
  });

  test("a row whose day is not declared complete is a 400; completeDays may only name days that have rows; bad values are refused", async () => {
    const b = await boot();
    await b.post(body([row(), row({ day: dayOf(-1) })]));
    expect((await b.post(body([row({ day: dayOf(-1) })], { completeDays: [TODAY] }))).status).toBe(400);
    for (const bad of ["x", [1], ["2027-02-30"], Array.from({ length: 901 }, (_, i) => dayOf(-i))]) expect((await b.post(body([], { completeDays: bad }))).status).toBe(400);
    // a day the request sends NOTHING for cannot be named (it could be used to delete / scan days for free)
    expect((await b.post(body([], { completeDays: [dayOf(-1)] }))).status).toBe(400);
    expect((await b.post(body([row()], { completeDays: [TODAY, dayOf(-1)] }))).status).toBe(400);
    expect(b.db.rows("SELECT day FROM usage_daily ORDER BY day")).toEqual([{ day: dayOf(-1) }, { day: TODAY }]);
  });

  test("the stale rows are deleted first and free their room under the per-day cap", async () => {
    const b = await boot();
    const stale = Array.from({ length: MAX_USAGE_ROWS_PER_HOST_DAY }, (_, i) => row({ agent: `old${i}` }));
    for (let i = 0; i < stale.length; i += 200) await b.post(body(stale.slice(i, i + 200)));
    expect(b.count()).toBe(MAX_USAGE_ROWS_PER_HOST_DAY);
    const res = await b.post(body(Array.from({ length: 100 }, (_, i) => row({ agent: `new${i}` })), { completeDays: [TODAY] }));
    expect(await res.json()).toMatchObject({ rows: 100 });
    expect(b.db.rows("SELECT COUNT(*) AS c, MIN(agent) AS a FROM usage_daily WHERE agent LIKE 'new%'")).toEqual([{ c: 100, a: "new0" }]);
    expect(b.count()).toBe(100);
  });

  test("the delete is part of the same transaction: a failing write rolls the delete back", async () => {
    const b = await boot();
    await b.post(body([row({ project: "keep-me" })]));
    b.db.sqlite.query("CREATE TRIGGER boom BEFORE INSERT ON usage_daily BEGIN SELECT RAISE(ABORT, 'disk full'); END").run();
    expect((await b.post(body([row({ project: "new" })], { completeDays: [TODAY] }))).status).toBe(500);
    expect(b.db.rows("SELECT project FROM usage_daily")).toEqual([{ project: "keep-me" }]);
  });

  test("the allowance is charged for the rows SUBMITTED plus a fixed charge per day touched, whatever happens to them (kept, unchanged, or thrown away by the cap)", async () => {
    const b = await boot();
    const rows = Array.from({ length: 100 }, (_, i) => row({ agent: `a${i}` }));
    const unit = 100 + USAGE_DAY_CHARGE;
    await b.post(body(rows));
    expect(winCount(b)).toBe(unit);
    await b.post(body(rows)); // unchanged
    expect(winCount(b)).toBe(2 * unit);
    await b.post(body(rows, { completeDays: [TODAY] }));
    expect(winCount(b)).toBe(3 * unit);
    const crowd = Array.from({ length: MAX_USAGE_ROWS_PER_HOST_DAY }, (_, i) => row({ agent: `c${i}` }));
    for (let i = 0; i < crowd.length; i += 200) await b.post(body(crowd.slice(i, i + 200)));
    const before = winCount(b);
    const res = await b.post(body(Array.from({ length: 150 }, (_, i) => row({ agent: `capped${i}` }))));
    expect(res.status).toBe(200);
    expect(winCount(b)).toBe(before + 150 + USAGE_DAY_CHARGE); // all thrown away by the cap, all charged
  });

  test("deletes are never free: a request with 35 complete days of 300 stale rows each is charged at least what it deleted (to the usage allowance, never to the snapshots' write budget)", async () => {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'old', ?, 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)");
    b.db.sqlite.exec("BEGIN");
    for (let d = 0; d < MAX_USAGE_COMPLETE_DAYS; d++) for (let i = 0; i < MAX_USAGE_ROWS_PER_HOST_DAY; i++) ins.run(dayOf(-d), `s${i}`);
    b.db.sqlite.exec("COMMIT");
    const stale = MAX_USAGE_COMPLETE_DAYS * MAX_USAGE_ROWS_PER_HOST_DAY;
    const days = Array.from({ length: MAX_USAGE_COMPLETE_DAYS }, (_, d) => dayOf(-d));
    const res = await b.post(body(days.map((d) => row({ day: d, project: "new" })), { completeDays: days }));
    expect(res.status).toBe(200);
    expect(b.count()).toBe(MAX_USAGE_COMPLETE_DAYS); // every stale row went, one new row per day is left
    expect(winCount(b)).toBeGreaterThanOrEqual(stale);
    // ... to the USAGE allowance only: the host write budget (the snapshots') is not charged for them
    expect(b.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'hosta'")[0]!.wr_count).toBeLessThan(200);
  });

  test("a REFUSED request writes nothing: with both budgets spent, 100 empty and 100 non-empty requests change no row", async () => {
    const b = await boot();
    b.db.sqlite.query("UPDATE sources SET wr_window_start = ?, wr_count = 1000000 WHERE name = 'hosta'").run(NOW - 1000);
    b.db.sqlite.query("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES ('hosta', 1, 1, 'Europe/London', 1, ?, ?)").run(NOW - 1000, MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    const changes = () => (b.db.sqlite.query("SELECT total_changes() AS c").get() as { c: number }).c;
    expect((await b.post(body([]))).status).toBe(429); // (the token's own last_seen touch, which every route does at most every few minutes, happens here)
    const c0 = changes();
    for (let i = 0; i < 100; i++) {
      expect((await b.post(body([]))).status).toBe(429);
      expect((await b.post(body([row()]))).status).toBe(429);
    }
    expect(changes()).toBe(c0);
  });

  test("a request refused only by the usage allowance still PAID the host budget (no free loop), and a zero-row request stamps liveness at most once a minute", async () => {
    const b = await boot();
    b.db.sqlite.query("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES ('hosta', ?, ?, 'Europe/London', 1, ?, ?)").run(NOW, NOW, NOW - 1000, MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    const wr = () => b.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'hosta'")[0]!.wr_count;
    const w0 = wr();
    for (let i = 0; i < 5; i++) expect((await b.post(body([row()]))).status).toBe(429);
    expect(wr() - w0).toBeGreaterThanOrEqual(5 * 4); // request + 2 statements + the stamp, every time
    const c = await boot();
    for (let i = 0; i < 20; i++) expect((await c.post(body([]))).status).toBe(200);
    expect(c.db.rows("SELECT pushed_at FROM usage_hosts")).toEqual([{ pushed_at: NOW }]); // written once; the same minute never rewrites it
  });

  test("history may use only 80 % of the allowance, judged from the DATA: relabelling a batch 'recent' or 'full' changes nothing", async () => {
    const b = await boot();
    const full = Math.floor(MAX_USAGE_ROWS_PER_HOST_PER_DAY * 0.8);
    b.db.sqlite.query("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES ('hosta', ?, ?, 'Europe/London', 0, ?, ?)").run(NOW, NOW, NOW - 1000, full - 40);
    const old = (agent: string, mode: string) => body([row({ day: dayOf(-100), agent })], { mode });
    expect((await b.post(old("a", "full"))).status).toBe(200);    // 31 units of history: fits under 80 %
    expect((await b.post(old("b", "full"))).status).toBe(429);    // the next one does not
    expect((await b.post(old("c", "recent"))).status).toBe(429);  // an attacker calling history "recent" gets the same answer
    expect((await b.post(body([row({ agent: "r1" })], { mode: "full" }))).status).toBe(200);   // recent DATA labelled "full" may still use the rest: the reservation holds
    expect((await b.post(body([row({ agent: "r2" })], { mode: "recent" }))).status).toBe(200);
  });
});

describe("cost of a request is bounded before any read (sec-audit2 BLOCK)", () => {
  async function crowded() {
    const b = await boot();
    // every one of the last 400 days holds the maximum for the host
    const ins = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', ?, 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)");
    b.db.sqlite.exec("BEGIN");
    for (let d = 0; d < 400; d++) for (let i = 0; i < MAX_USAGE_ROWS_PER_HOST_DAY; i++) ins.run(dayOf(-d), `a${i}`);
    b.db.sqlite.exec("COMMIT");
    return b;
  }
  const spread = (n: number) => Array.from({ length: n }, (_, i) => row({ day: dayOf(-(i % MAX_USAGE_COMPLETE_DAYS)), agent: `new${i}` }));

  test("a spread of 2000 new keys over a fully crowded host: a bounded number of statements, nothing inserted, and the rows are CHARGED", async () => {
    const b = await crowded();
    const before = b.count();
    b.db.statements.length = 0;
    const res = await b.post(body(spread(2000)));
    expect(res.status).toBe(200);
    expect(b.count()).toBe(before);
    // sources lookup + usage claim + host claim + (10 chunks x insert + update + stored-count) in ONE batch: no per-day SELECTs, no COUNT before the claim
    expect(b.db.statements.length).toBeLessThanOrEqual(40); // + one stored-count SELECT per chunk (the `capped` answer)
    expect(b.db.statements.filter((s) => /SELECT[^;]*FROM usage_daily/i.test(s) && !/INSERT|UPDATE|DELETE/.test(s))).toEqual([]);
    expect(b.db.rows("SELECT win_count FROM usage_hosts")).toEqual([{ win_count: 2000 + MAX_USAGE_COMPLETE_DAYS * USAGE_DAY_CHARGE }]);
  });

  test("the rows one request can make the Worker read are bounded by (distinct days) x (the per-day cap): its INSERT counts each day once, by primary-key seek", async () => {
    const b = await crowded();
    const sql = SQL_USAGE_INSERT;
    const plan = b.db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, "[]", "hosta", 1, MAX_USAGE_ROWS_PER_HOST_DAY).map((r) => r.detail).join(" | ");
    expect(plan).not.toMatch(/SCAN usage_daily/);
    expect(plan).toMatch(/SEARCH \w+ USING (COVERING )?INDEX|SEARCH usage_daily USING PRIMARY KEY|SEARCH u USING PRIMARY KEY/);
    // worst case per request: 35 days x 300 rows counted + 2000 point lookups x 2
    const worstRowsRead = MAX_USAGE_COMPLETE_DAYS * MAX_USAGE_ROWS_PER_HOST_DAY + 2000 * 2;
    expect(worstRowsRead).toBeLessThan(15_000);
    expect(worstRowsRead * (MAX_USAGE_ROWS_PER_HOST_PER_DAY / MAX_USAGE_ROWS_PER_REQUEST)).toBeLessThan(1_000_000); // per leaked token and day, with the allowance as the limiter
  });

  test("once the allowance is spent a crowded-host request costs a token lookup and four single-row statements: no usage_daily read at all", async () => {
    const b = await crowded();
    b.db.sqlite.query("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES ('hosta', ?, ?, 'Europe/London', 1, ?, ?)").run(NOW, NOW, NOW - 1000, MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    b.db.statements.length = 0;
    const res = await b.post(body(spread(2000)));
    expect(res.status).toBe(429);
    expect(b.db.statements.length).toBeLessThanOrEqual(5); // token lookup, last_seen touch, host claim, usage claim, window lookup
    expect(b.db.statements.some((s) => /usage_daily/.test(s))).toBe(false);
  });

  test("wall time sanity: a fully crowded 2000-row request stays far below the old ~800k-row-read behaviour", async () => {
    const b = await crowded();
    const t0 = performance.now();
    await b.post(body(spread(2000)));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("model ids are table ids or unknown (sec-audit2 SHOULD 1)", () => {
  test("a fine-tune, an ARN, a URL-like id and a free-text id never reach the table: they are stored as `unknown`", async () => {
    const b = await boot();
    const leaks = ["ft:gpt-4o-mini-2024:acme-corp:client-x:AbC123", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/eu.anthropic.claude", "https://models.client.example/v1/x", "client-secret-model"];
    expect((await b.post(body(leaks.map((m, i) => row({ model: m, agent: `a${i}` }))))).status).toBe(200);
    expect(b.db.rows("SELECT DISTINCT model FROM usage_daily")).toEqual([{ model: "unknown" }]);
    expect(JSON.stringify(b.db.rows("SELECT * FROM usage_daily"))).not.toMatch(/acme|123456789012|client/);
    await b.post(body([row({ model: "Claude-Opus-5-5-20261001", agent: "z" })]));
    expect(b.db.rows("SELECT model FROM usage_daily WHERE agent = 'z'")).toEqual([{ model: "claude-opus-5-5" }]);
  });
});

describe("distinct days per request are bounded before any read (sec-audit2 BLOCK 3)", () => {
  test("more than 35 distinct days of rows, or more than 35 completeDays, is a 400 with zero usage_daily work", async () => {
    const b = await boot();
    b.db.statements.length = 0;
    const many = Array.from({ length: MAX_USAGE_COMPLETE_DAYS + 1 }, (_, i) => row({ day: dayOf(-i) }));
    const res = await b.post(body(many));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("distinct days");
    expect((await b.post(body([], { completeDays: Array.from({ length: MAX_USAGE_COMPLETE_DAYS + 1 }, (_, i) => dayOf(-i)) }))).status).toBe(400);
    expect(b.db.statements.some((s) => /usage_daily|usage_hosts/.test(s))).toBe(false);
    expect((await b.post(body(many.slice(0, MAX_USAGE_COMPLETE_DAYS)))).status).toBe(200); // exactly 35 is fine
  });
});

describe("ERASE: an opt-out withdraws what was already uploaded", () => {
  const erase = (b: Awaited<ReturnType<typeof boot>>, over: Record<string, unknown> = {}, token = b.hostToken) => b.post({ v: 1, host: "hosta", mode: "erase", ...over }, token);
  async function twoHosts() {
    const b = await boot();
    await b.post(body([row(), row({ day: dayOf(-3), project: "client-acme" })]));
    await b.post(body([row({ project: "theirs" })], { host: "other-host" }), b.otherToken);
    return b;
  }
  const rowsOf = (b: Awaited<ReturnType<typeof boot>>, host: string) => (b.db.rows<{ c: number }>("SELECT COUNT(*) AS c FROM usage_daily WHERE host = ?", host)[0] as { c: number }).c;

  test("auth and shape: no token 401, client token 403, another host's label 403, v != 1 / rows / bad host 400; nothing is deleted by a refused call", async () => {
    const b = await twoHosts();
    expect((await b.call("/api/ingest/usage", { body: { v: 1, host: "hosta", mode: "erase" } })).status).toBe(401);
    expect((await erase(b, {}, b.clientToken)).status).toBe(403);
    expect((await erase(b, { host: "other-host" })).status).toBe(403); // my token cannot erase another host
    expect((await erase(b, { host: "bad host" })).status).toBe(400);
    expect((await erase(b, { v: 2 })).status).toBe(400);
    expect((await erase(b, { rows: [row()] })).status).toBe(400);
    expect(rowsOf(b, "hosta")).toBe(2);
    expect(rowsOf(b, "other-host")).toBe(1);
  });

  test("it deletes the token-bound host's rows and ONLY those: another host's rows are untouched, and the answer says nothing is left", async () => {
    const b = await twoHosts();
    const res = await erase(b);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, erased: 2, remaining: 0 });
    expect(rowsOf(b, "hosta")).toBe(0);
    expect(b.db.rows("SELECT host, project FROM usage_daily")).toEqual([{ host: "other-host", project: "theirs" }]);
    expect(b.db.rows<{ has_full: number }>("SELECT has_full FROM usage_hosts WHERE host = 'other-host'")[0]!.has_full).toBe(0);
    // the other host can erase its own
    expect(await (await erase(b, { host: "other-host" }, b.otherToken)).json()).toMatchObject({ erased: 1, remaining: 0 });
  });

  test("it is bounded per request (35 days x 300 rows): more rows than that need repeated requests, `remaining` says so", async () => {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', ?, 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)");
    b.db.sqlite.exec("BEGIN");
    const total = MAX_USAGE_ERASE_ROWS + 1500;
    for (let i = 0; i < total; i++) ins.run(dayOf(-Math.floor(i / MAX_USAGE_ROWS_PER_HOST_DAY)), `a${i % MAX_USAGE_ROWS_PER_HOST_DAY}`);
    b.db.sqlite.exec("COMMIT");
    const first = (await (await erase(b)).json()) as any;
    expect(first).toEqual({ ok: true, erased: MAX_USAGE_ERASE_ROWS, remaining: 1 });
    expect(b.count()).toBe(1500);
    expect(await (await erase(b)).json()).toEqual({ ok: true, erased: 1500, remaining: 0 });
    expect(b.count()).toBe(0);
  });

  test("the rows really deleted are charged to the USAGE allowance, the host write budget only pays the fixed claim; an erase that finds nothing costs only that claim", async () => {
    const b = await twoHosts();
    const wr = () => b.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'hosta'")[0]!.wr_count;
    const win = () => b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]!.win_count;
    const w0 = wr();
    const a0 = win();
    await erase(b);
    expect(wr() - w0).toBe(20);       // USAGE_ERASE_COST, whatever was deleted
    expect(win() - a0).toBe(2);       // the two deleted rows
    const w1 = wr();
    b.db.statements.length = 0;
    await erase(b);
    expect(wr() - w1).toBe(20);
    expect(b.db.statements.length).toBeLessThanOrEqual(8);
  });

  test("a spent host budget: 429 and ZERO writes; the next window continues", async () => {
    const b2 = await twoHosts();
    b2.db.sqlite.query("UPDATE sources SET wr_window_start = ?, wr_count = 1000000 WHERE name = 'hosta'").run(NOW - 1000);
    expect((await erase(b2)).status).toBe(429); // (the token's own last_seen touch happens here, once)
    const changes = () => (b2.db.sqlite.query("SELECT total_changes() AS c").get() as { c: number }).c;
    const c0 = changes();
    for (let i = 0; i < 50; i++) expect((await erase(b2)).status).toBe(429);
    expect(changes()).toBe(c0);
    expect(rowsOf(b2, "hosta")).toBe(2);
    const later = await route(request("/api/ingest/usage", { body: { v: 1, host: "hosta", mode: "erase" }, token: b2.hostToken }), b2.env, b2.ctx, { now: NOW + DAY });
    expect(await later.json()).toMatchObject({ remaining: 0 });
    expect(rowsOf(b2, "hosta")).toBe(0);
  });

  test("erasing does not reset the allowance: the bookkeeping row (and its window counters) stays until the window is over, then goes", async () => {
    const b = await twoHosts();
    await erase(b);
    expect(b.db.rows("SELECT host FROM usage_hosts WHERE host = 'hosta'")).toEqual([{ host: "hosta" }]);
    const winCount = () => b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]!.win_count;
    expect(winCount()).toBeGreaterThan(0);
    const later = await route(request("/api/ingest/usage", { body: { v: 1, host: "hosta", mode: "erase" }, token: b.hostToken }), b.env, b.ctx, { now: NOW + 2 * DAY });
    expect(later.status).toBe(200);
    expect(b.db.rows("SELECT host FROM usage_hosts WHERE host = 'hosta'")).toEqual([]);
    expect(b.db.rows("SELECT host FROM usage_hosts WHERE host = 'other-host'")).toEqual([{ host: "other-host" }]);
  });

  test("no usage tables yet: nothing to erase, answered as done", async () => {
    const b = await boot();
    b.db.sqlite.query("DROP TABLE usage_daily").run();
    expect(await (await erase(b)).json()).toEqual({ ok: true, erased: 0, remaining: 0 });
  });
});

describe("rows refused by the per-day cap are reported (tester2)", () => {
  test("301 rows for one day: 300 are stored and the answer says `capped: 1` (not a silent 'rows: 301, dropped: 0')", async () => {
    const b = await boot();
    const res = await b.post(body(Array.from({ length: MAX_USAGE_ROWS_PER_HOST_DAY + 1 }, (_, i) => row({ agent: `a${i}` }))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, rows: MAX_USAGE_ROWS_PER_HOST_DAY + 1, capped: 1 });
    expect(b.count()).toBe(MAX_USAGE_ROWS_PER_HOST_DAY);
    // nothing capped: no `capped` key at all; an unchanged re-send of stored rows is not "capped" either
    const ok = await boot();
    const a = await (await ok.post(body([row(), row({ agent: "b" })]))).json();
    expect(a).not.toHaveProperty("capped");
    expect(await (await ok.post(body([row(), row({ agent: "b" })]))).json()).not.toHaveProperty("capped");
  });
});

describe("erase cannot starve the snapshots (sec-audit2: 48 k rows on a 1-project host)", () => {
  async function bigHost(rows: number, winCount = 0) {
    const b = await boot();
    expect((await b.call("/api/ingest/snapshot", { body: snapshot({}, NOW), token: b.hostToken })).status).toBe(200);
    const ins = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', ?, 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)");
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < rows; i++) ins.run(dayOf(-Math.floor(i / 60)), `a${i % 60}`);
    b.db.sqlite.exec("COMMIT");
    b.db.sqlite.query("INSERT OR REPLACE INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES ('hosta', ?, ?, 'Europe/London', 1, ?, ?)").run(NOW, NOW, NOW - 1000, winCount);
    return b;
  }
  const erase = (b: Awaited<ReturnType<typeof boot>>, now = NOW) => route(request("/api/ingest/usage", { body: { v: 1, host: "hosta", mode: "erase" }, token: b.hostToken }), b.env, b.ctx, { now });
  const snap = (b: Awaited<ReturnType<typeof boot>>, now = NOW) => route(request("/api/ingest/snapshot", { body: snapshot({}, now), token: b.hostToken }), b.env, b.ctx, { now });
  const wr = (b: Awaited<ReturnType<typeof boot>>) => b.db.rows<{ wr_count: number }>("SELECT wr_count FROM sources WHERE name = 'hosta'")[0]!.wr_count;

  test("48 000 rows, one project: the erase completes, every snapshot in between is accepted, the host write budget stays far below its cap and no budget-exhausted alert opens", async () => {
    const b = await bigHost(48_000);
    const cap = hostWriteBudget(1);
    let rounds = 0;
    for (;;) {
      const res = await erase(b);
      expect(res.status).toBe(200);
      rounds++;
      expect((await snap(b)).status).toBe(200);
      expect(wr(b)).toBeLessThan(cap / 2);
      if (((await res.json()) as { remaining: number }).remaining === 0) break;
      expect(rounds).toBeLessThan(10);
    }
    expect(rounds).toBe(Math.ceil(48_000 / MAX_USAGE_ERASE_ROWS));
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily")).toEqual([{ c: 0 }]);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM alerts WHERE rule = 'budget-exhausted'")).toEqual([{ c: 0 }]);
    expect(b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]!.win_count).toBe(48_000); // paid from the usage allowance
  });

  test("a usage allowance that runs out mid-erase: 429 (a refusal), the erase stops at the allowance, the next window carries on; snapshots are never refused", async () => {
    const b = await bigHost(20_000, MAX_USAGE_ROWS_PER_HOST_PER_DAY - 15_000);
    expect(await (await erase(b)).json()).toEqual({ ok: true, erased: MAX_USAGE_ERASE_ROWS, remaining: 1 });
    expect(await (await erase(b)).json()).toEqual({ ok: true, erased: 15_000 - MAX_USAGE_ERASE_ROWS, remaining: 1 }); // limited by what is left of the allowance
    expect(b.count()).toBe(5_000);
    expect((await erase(b)).status).toBe(429);
    expect((await snap(b)).status).toBe(200);
    const later = await erase(b, NOW + DAY + 1);
    expect(await later.json()).toEqual({ ok: true, erased: 5_000, remaining: 0 });
    expect(b.count()).toBe(0);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM alerts WHERE rule = 'budget-exhausted'")).toEqual([{ c: 0 }]);
  });

  test("erase cannot reset the allowance: after the erase a fresh upload is still charged against the same window", async () => {
    const b = await bigHost(100, MAX_USAGE_ROWS_PER_HOST_PER_DAY - 150);
    await erase(b);
    expect(b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]!.win_count).toBe(MAX_USAGE_ROWS_PER_HOST_PER_DAY - 50);
    expect((await b.post(body(Array.from({ length: 80 }, (_, i) => row({ agent: `n${i}` }))))).status).toBe(429); // 80 + 30 > 50 left
  });
});

describe("erase without a bookkeeping row (purged after 30 quiet days while the usage rows stay)", () => {
  async function orphan(rows: number) {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', ?, 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)");
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < rows; i++) ins.run(dayOf(-Math.floor(i / 200)), `a${i % 200}`);
    b.db.sqlite.exec("COMMIT");
    expect(b.db.rows("SELECT host FROM usage_hosts")).toEqual([]);
    return b;
  }
  const erase = (b: Awaited<ReturnType<typeof boot>>) => b.post({ v: 1, host: "hosta", mode: "erase" });

  test("the charge creates the row with a fresh window: 20 000 rows are erased as 10 500 / 9 500 and recorded", async () => {
    const b = await orphan(20_000);
    expect(await (await erase(b)).json()).toEqual({ ok: true, erased: MAX_USAGE_ERASE_ROWS, remaining: 1 });
    expect(b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]!.win_count).toBe(MAX_USAGE_ERASE_ROWS);
    expect(await (await erase(b)).json()).toEqual({ ok: true, erased: 20_000 - MAX_USAGE_ERASE_ROWS, remaining: 0 });
    expect(b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]!.win_count).toBe(20_000);
  });

  test("and it stays bounded: 70 000 orphaned rows are erased only up to the allowance (60 000) per window, then 429; the next window finishes", async () => {
    const b = await orphan(70_000);
    let erased = 0;
    for (let i = 0; i < 12; i++) {
      const res = await erase(b);
      if (res.status === 429) break;
      erased += ((await res.json()) as { erased: number }).erased;
    }
    expect(erased).toBe(MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    expect(b.count()).toBe(70_000 - MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    const later = await route(request("/api/ingest/usage", { body: { v: 1, host: "hosta", mode: "erase" }, token: b.hostToken }), b.env, b.ctx, { now: NOW + DAY + 1 });
    expect(await later.json()).toEqual({ ok: true, erased: 10_000, remaining: 0 });
  });
});

describe("the allowance row cannot be deleted or reset while its window runs (411fbf9 review)", () => {
  async function orphan(rows: number) {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO usage_daily VALUES (?, 'hosta', 'p', ?, 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)");
    b.db.sqlite.exec("BEGIN");
    for (let i = 0; i < rows; i++) ins.run(dayOf(-Math.floor(i / 200)), `a${i % 200}`);
    b.db.sqlite.exec("COMMIT");
    return b;
  }
  const erase = (b: Awaited<ReturnType<typeof boot>>, now = NOW) => route(request("/api/ingest/usage", { body: { v: 1, host: "hosta", mode: "erase" }, token: b.hostToken }), b.env, b.ctx, { now });

  test("erase 60 000 -> purge -> erase: the purge leaves the row (its window runs), so the second erase is a 429", async () => {
    const b = await orphan(70_000);
    let erased = 0;
    for (let i = 0; i < 12; i++) { const r = await erase(b); if (r.status === 429) break; erased += ((await r.json()) as any).erased; }
    expect(erased).toBe(MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    // pushed_at is 0 on a row the erase created: the old purge condition (pushed_at < cutoff) would have taken it
    expect(b.db.rows<{ pushed_at: number }>("SELECT pushed_at FROM usage_hosts")[0]!.pushed_at).toBe(0);
    const removed = await purgeOld(b.env.DB, NOW + 60_000, 30);
    expect(removed.usageHosts).toBe(0);
    expect(b.db.rows("SELECT host FROM usage_hosts")).toEqual([{ host: "hosta" }]);
    expect((await erase(b)).status).toBe(429);
    expect(b.count()).toBe(10_000);
  });

  test("a row whose window has expired can be purged, and the host then starts a fresh window", async () => {
    const b = await orphan(70_000);
    for (let i = 0; i < 12; i++) if ((await erase(b)).status === 429) break;
    const later = NOW + DAY + 60_000;
    expect((await purgeOld(b.env.DB, later, 30)).usageHosts).toBe(1);
    expect(b.db.rows("SELECT host FROM usage_hosts")).toEqual([]);
    expect(await (await erase(b, later)).json()).toEqual({ ok: true, erased: 10_000, remaining: 0 });
  });

  test("a missing row is never more permissive than an existing one: concurrent first erases share ONE window and cannot exceed the allowance together", async () => {
    const b = await orphan(70_000);
    const rs = await Promise.all(Array.from({ length: 12 }, () => erase(b)));
    const erased = (await Promise.all(rs.filter((r) => r.status === 200).map((r) => r.json()))).reduce((n: number, j: any) => n + j.erased, 0);
    expect(erased).toBeLessThanOrEqual(MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_hosts")).toEqual([{ c: 1 }]);
    expect(b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts")[0]!.win_count).toBeLessThanOrEqual(MAX_USAGE_ROWS_PER_HOST_PER_DAY);
    expect(b.count()).toBe(70_000 - erased);
  });

  test("concurrent FIRST uploads of a new host share one window: the counter is the sum of both charges", async () => {
    const b = await boot();
    const mk = (tag: string) => body(Array.from({ length: 50 }, (_, i) => row({ agent: `${tag}${i}` })));
    const rs = await Promise.all([b.post(mk("a")), b.post(mk("b")), b.post(mk("c"))]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_hosts")).toEqual([{ c: 1 }]);
    expect(b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts")[0]!.win_count).toBe(3 * (50 + USAGE_DAY_CHARGE));
  });

  test("an erase that finds nothing leaves no row behind in a fresh window (nothing was charged), and reserved-but-unused rows are given back", async () => {
    const b = await boot();
    expect(await (await erase(b)).json()).toEqual({ ok: true, erased: 0, remaining: 0 });
    expect(b.db.rows("SELECT host FROM usage_hosts")).toEqual([]);
    const c = await orphan(500);
    await erase(c);
    expect(c.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts")[0]!.win_count).toBe(500);
  });
});
