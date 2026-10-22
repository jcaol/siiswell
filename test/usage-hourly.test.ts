/**
 * Hourly usage (migration 0005): the optional `hourly` block of POST /api/ingest/usage, its caps and privacy rules (the same as daily),
 * the 90-day retention, erase, and GET /api/usage?group=hour&day=... Old v1 bodies (no `hourly`) keep working unchanged.
 */
import { describe, expect, test } from "bun:test";
import { purgeOld } from "../src/alerts";
import { MAX_USAGE_HOURLY_ROWS_PER_HOST_DAY, MAX_USAGE_HOURLY_ROWS_PER_REQUEST, USAGE_HOURLY_RETENTION_DAYS } from "../src/env";
import { route } from "../src/index";
import { sanitizeUsageBatch } from "../src/usage";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const DAY = 86_400_000;
const dayOf = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);
const TODAY = dayOf(0);

const counters = { input: 1000, output: 500, cacheRead: 20000, cacheWrite5m: 300, cacheWrite1h: 100, requests: 12, usd: 1.5 };
const row = (over: Record<string, unknown> = {}) => ({ day: TODAY, project: "(other)", agent: "claude-cli", source: "claude", model: "claude-opus-5-5", ...counters, ...over });
const hrow = (h: string, over: Record<string, unknown> = {}) => ({ hour: `${TODAY}T${h}`, project: "(other)", agent: "claude-cli", source: "claude", model: "claude-opus-5-5", ...counters, ...over });
const body = (rows: unknown[], hourly?: unknown[], over: Record<string, unknown> = {}) => ({
  v: 1, host: "hosta", tz: "Europe/London", generatedAt: NOW - 1000, mode: "recent", complete: false,
  completeDays: [...new Set((rows as Array<{ day: string }>).map((r) => r.day))], rows, ...(hourly ? { hourly } : {}), ...over,
});

async function boot(opts: { dropHourly?: boolean; env?: Record<string, string> } = {}) {
  const t = makeEnv(opts.env ?? {});
  if (opts.dropHourly) t.db.sqlite.run("DROP TABLE usage_hourly");
  const ctx = makeCtx();
  const hostToken = await addSource(t.db, "hosta", "host");
  const call = (path: string, init: Parameters<typeof request>[1] = {}, now = NOW) => route(request(path, init), t.env, ctx, { now });
  const post = async (b: unknown) => {
    const res = await call("/api/ingest/usage", { body: b, token: hostToken });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const hours = () => t.db.rows<{ hour: string; agent: string; requests: number }>("SELECT hour, agent, requests FROM usage_hourly ORDER BY hour, agent");
  return { ...t, call, post, hours };
}

describe("POST /api/ingest/usage with an hourly block", () => {
  test("a v1 body without `hourly` works exactly as before and leaves hourly rows alone", async () => {
    const b = await boot();
    expect((await b.post(body([row()], [hrow("09")]))).status).toBe(200);
    const r = await b.post(body([row({ requests: 99 })]));
    expect(r.status).toBe(200);
    expect(r.json.hourly).toBeUndefined();
    expect(b.hours()).toEqual([{ hour: `${TODAY}T09`, agent: "claude-cli", requests: 12 }]);
  });

  test("hourly rows are stored, updated and replaced per complete day", async () => {
    const b = await boot();
    const r = await b.post(body([row()], [hrow("09"), hrow("10", { agent: "codex-cli", source: "codex", model: "gpt-5.5" })]));
    expect(r.json).toMatchObject({ ok: true, hourly: "ok", hourlyRows: 2 });
    expect(b.hours().map((h) => h.hour)).toEqual([`${TODAY}T09`, `${TODAY}T10`]);
    // the same day again, authoritative: 10:00 is gone, 09:00 updated, 11:00 added
    await b.post(body([row()], [hrow("09", { requests: 1 }), hrow("11")]));
    expect(b.hours()).toEqual([{ hour: `${TODAY}T09`, agent: "claude-cli", requests: 1 }, { hour: `${TODAY}T11`, agent: "claude-cli", requests: 12 }]);
    // another day's request never touches this day's hours
    await b.post(body([row({ day: dayOf(-1) })], [{ ...hrow("05"), hour: `${dayOf(-1)}T05` }]));
    expect(b.hours().length).toBe(3);
  });

  test("validation: the same label rules as daily; hours only on days the request carries; caps", () => {
    const bad: Array<Record<string, unknown>> = [
      { hour: `${TODAY}T24` }, { hour: `${TODAY} 09` }, { hour: TODAY }, { hour: "2027-02-30T01" },
      { agent: "a b" }, { project: "client name" }, { input: -1 }, { usd: "1" },
      { hour: `${dayOf(-3)}T01` }, // not a day of this request
    ];
    for (const over of bad) expect(sanitizeUsageBatch(body([row()], [hrow("09", over)]), NOW).ok, JSON.stringify(over)).toBe(false);
    expect(sanitizeUsageBatch(body([row()], "x" as unknown as unknown[]), NOW).ok).toBe(false);
    const many = Array.from({ length: MAX_USAGE_HOURLY_ROWS_PER_REQUEST + 1 }, (_, i) => hrow(String(i % 24).padStart(2, "0"), { agent: `a${i}` }));
    expect(sanitizeUsageBatch(body([row()], many), NOW).ok).toBe(false);
    const ok = sanitizeUsageBatch(body([row()], [hrow("09", { model: "ft:my-client-model" })]), NOW);
    expect(ok.ok && ok.value.hourly![0]!.model).toBe("unknown"); // models outside the price table are `unknown`, as daily
  });

  test("hours older than the hourly retention are dropped (counted); the per-host-and-day cap holds", async () => {
    const b = await boot();
    const old = dayOf(-(USAGE_HOURLY_RETENTION_DAYS + 2));
    const r = await b.post(body([row({ day: old })], [{ ...hrow("01"), hour: `${old}T01` }]));
    expect(r.json).toMatchObject({ hourlyDropped: 1, hourlyRows: 0 });
    expect(b.hours().length).toBe(0);
    const over = Array.from({ length: MAX_USAGE_HOURLY_ROWS_PER_HOST_DAY + 5 }, (_, i) => hrow(String(i % 24).padStart(2, "0"), { agent: `a${i}` }));
    const c = await b.post(body([row()], over));
    expect(c.json).toMatchObject({ hourlyCapped: 5 });
    expect(b.hours().length).toBe(MAX_USAGE_HOURLY_ROWS_PER_HOST_DAY);
  });

  test("security: hourly rows never ride without accepted daily rows (no unpaid hourly writes)", async () => {
    const b = await boot();
    const win = () => (b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]?.win_count ?? 0);
    // hourly-only: refused outright
    expect((await b.post({ ...body([], [hrow("09")]), completeDays: [] })).status).toBe(400);
    // a daily row outside the accepted window (dropped) cannot carry hours of its day
    const future = dayOf(3);
    const r = await b.post(body([row({ day: future })], [{ ...hrow("01"), hour: `${future}T01` }]));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ rows: 0, hourlyRows: 0, hourlyDropped: 1 });
    expect(b.hours()).toEqual([]);
    expect(win()).toBe(0);
    // with an accepted day the hours are charged, one unit each
    await b.post(body([row()], [hrow("01"), hrow("02")]));
    expect(win()).toBe(1 + 2 + 30);
  });

  test("USAGE_RETENTION_DAYS 31: hours never precede the daily window, are never unpaid, and erase removes them all", async () => {
    const b = await boot({ env: { USAGE_RETENTION_DAYS: "31" } });
    const win = () => (b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]?.win_count ?? 0);
    const old = dayOf(-60); // inside the 90-day hourly window, outside the 31-day daily one
    const r = await b.post(body([row({ day: old })], [{ ...hrow("01"), hour: `${old}T01` }]));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ rows: 0, hourlyRows: 0, hourlyDropped: 1 });
    expect(b.hours()).toEqual([]);
    expect(win()).toBe(0);
    // hourly rows already stored before the retention was lowered are erased too
    const ins = b.db.sqlite.query("INSERT INTO usage_hourly VALUES (?, 'hosta', 'p', 'a', 'claude', 'm', 1, 1, 1, 1, 1, 1, NULL, 1)");
    ins.run(`${dayOf(-80)}T05`);
    ins.run(`${dayOf(-1)}T05`);
    let e;
    do e = await b.post({ v: 1, host: "hosta", mode: "erase" });
    while (e.json.remaining !== 0);
    expect(b.hours()).toEqual([]);
  });

  test("hourly rows are charged to the usage allowance", async () => {
    const b = await boot();
    const win = () => (b.db.rows<{ win_count: number }>("SELECT win_count FROM usage_hosts WHERE host = 'hosta'")[0]?.win_count ?? 0);
    await b.post(body([row()]));
    const w0 = win();
    await b.post(body([row()], [hrow("01"), hrow("02"), hrow("03")]));
    expect(win() - w0).toBe(1 + 3 + 30);
  });

  test("without migration 0005 the daily rows still land and the answer says hourly: pending", async () => {
    const b = await boot({ dropHourly: true });
    const r = await b.post(body([row()], [hrow("09")]));
    expect(r.status).toBe(200);
    expect(r.json.hourly).toBe("pending");
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily")).toEqual([{ c: 1 }]);
    const g = (await (await b.call(`/api/usage?group=hour&day=${TODAY}`)).json()) as Record<string, unknown>;
    expect(g.pending).toBe(true);
  });

  test("erase removes the hourly rows too", async () => {
    const b = await boot();
    await b.post(body([row()], [hrow("09"), hrow("10")]));
    let r;
    do r = await b.post({ v: 1, host: "hosta", mode: "erase" });
    while (r.json.remaining !== 0);
    expect(b.hours()).toEqual([]);
    expect(b.db.rows("SELECT COUNT(*) AS c FROM usage_daily")).toEqual([{ c: 0 }]);
  });

  test("the purge keeps hourly rows USAGE_HOURLY_RETENTION_DAYS (daily rows far longer)", async () => {
    const b = await boot();
    const ins = b.db.sqlite.query("INSERT INTO usage_hourly VALUES (?, 'hosta', 'p', 'a', 'claude', 'm', 1, 1, 1, 1, 1, 1, NULL, 1)");
    ins.run(`${dayOf(-(USAGE_HOURLY_RETENTION_DAYS + 1))}T23`);
    ins.run(`${dayOf(-(USAGE_HOURLY_RETENTION_DAYS - 1))}T00`);
    const removed = await purgeOld(b.env.DB, NOW, 30);
    expect(removed.usageHourly).toBe(1);
    expect(b.hours().map((h) => h.hour)).toEqual([`${dayOf(-(USAGE_HOURLY_RETENTION_DAYS - 1))}T00`]);
  });

  test("query plans: a day of hours is a range seek of the hour-first primary key", async () => {
    const b = await boot();
    const plan = (sql: string) => b.db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, "a", "b").map((r) => r.detail).join(" | ");
    for (const sql of [
      "SELECT substr(hour, 12, 2) AS k, TOTAL(input) FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2 GROUP BY k",
      "SELECT COUNT(*) FROM usage_hourly u WHERE u.hour BETWEEN ?1 || 'T00' AND ?1 || 'T23' AND u.host = ?2",
      "SELECT hour FROM usage_hourly WHERE hour < ?1 ORDER BY hour LIMIT ?2",
    ]) {
      const p = plan(sql);
      expect(p, sql).toContain("PRIMARY KEY");
      expect(p, sql).toMatch(/SEARCH (usage_hourly|u) USING PRIMARY KEY \(hour/);
    }
  });
});

describe("GET /api/usage?group=hour", () => {
  test("24 hours of a day, the day's total (hourly and daily), the host / app / project / model breakdown", async () => {
    const b = await boot();
    await b.post(body([row(), row({ agent: "codex-cli", source: "codex", model: "gpt-5.5" })], [hrow("09"), hrow("09", { agent: "codex-cli", source: "codex", model: "gpt-5.5" }), hrow("17")]));
    const u = (await (await b.call(`/api/usage?group=hour&day=${TODAY}`)).json()) as {
      day: string; retained: boolean; hours: Array<{ h: string; requests: number }>; total: { requests: number }; dayTotal: { requests: number };
      hostBreakdown: Array<{ host: string; agent: string; project: string; model: string; requests: number }>;
    };
    expect(u.day).toBe(TODAY);
    expect(u.retained).toBe(true);
    expect(u.hours.length).toBe(24);
    expect(u.hours.map((h) => h.h)[0]).toBe("00");
    expect(u.hours.find((h) => h.h === "09")!.requests).toBe(24);
    expect(u.hours.find((h) => h.h === "17")!.requests).toBe(12);
    expect(u.hours.find((h) => h.h === "03")!.requests).toBe(0);
    expect(u.total.requests).toBe(36);
    expect(u.dayTotal.requests).toBe(24);
    expect(u.hostBreakdown.map((r) => `${r.host}/${r.agent}/${r.project}/${r.model}/${r.requests}`).sort()).toEqual(["hosta/claude-cli/(other)/claude-opus-5-5/24", "hosta/codex-cli/(other)/gpt-5.5/12"]);
  });

  test("bad day is a 400; an old day says retained: false", async () => {
    const b = await boot();
    expect((await b.call("/api/usage?group=hour&day=2027-02-30")).status).toBe(400);
    expect((await b.call("/api/usage?group=hours")).status).toBe(400);
    const u = (await (await b.call(`/api/usage?group=hour&day=${dayOf(-200)}`)).json()) as { retained: boolean; hours: unknown[] };
    expect(u.retained).toBe(false);
  });

  test("the month / day answers now carry the per-host breakdown too", async () => {
    const b = await boot();
    await b.post(body([row(), row({ agent: "claude-desktop" })]));
    const u = (await (await b.call("/api/usage?group=day")).json()) as { hostBreakdown: Array<{ host: string; agent: string }> };
    expect(u.hostBreakdown.map((r) => `${r.host}/${r.agent}`).sort()).toEqual(["hosta/claude-cli", "hosta/claude-desktop"]);
  });
});
