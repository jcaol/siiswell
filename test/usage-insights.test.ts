/**
 * GET /api/usage?group=insights (the overview's compact aggregates) and the hourly-coverage fields of GET /api/usage?group=hour.
 * Rows are written straight into the tables (the ingest path is covered elsewhere).
 */
import { describe, expect, test } from "bun:test";
import { route } from "../src/index";
import { USAGE_WEEKHOUR_DAYS } from "../src/usage";
import { makeCtx, makeEnv, request } from "./d1-shim";

const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z, a Friday
const DAY = 86_400_000;
const dayOf = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);
const TODAY = dayOf(0);

function boot(opts: { dropHourly?: boolean; dropDaily?: boolean } = {}) {
  const t = makeEnv();
  if (opts.dropHourly) t.db.sqlite.run("DROP TABLE usage_hourly");
  const ctx = makeCtx();
  const daily = (day: string, host: string, agent: string, project: string, model: string, requests: number, usd: number | null) =>
    t.db.sqlite.run(
      "INSERT INTO usage_daily (day, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, ?, ?, ?, 'claude', ?, 100, 50, 1000, 10, 0, ?, ?, 0)",
      [day, host, project, agent, model, requests, usd],
    );
  const hourly = (hour: string, host: string, requests: number) =>
    t.db.sqlite.run(
      "INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated) VALUES (?, ?, '(other)', 'claude-cli', 'claude', 'claude-opus-5-5', 1, 1, 1, 0, 0, ?, 0.1, 0)",
      [hour, host, requests],
    );
  if (opts.dropDaily) t.db.sqlite.run("DROP TABLE usage_daily");
  const get = async (path: string) => {
    const res = await route(request(path), t.env, ctx, { now: NOW });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...t, daily, hourly, get };
}

describe("GET /api/usage?group=insights", () => {
  test("60 days of totals, 30 days per app (worktree folded) and per project, models, hosts", async () => {
    const b = boot();
    b.daily(TODAY, "laptop", "claude-cli.dev", "web", "claude-opus-5-5", 10, 2);
    b.daily(TODAY, "laptop", "claude-cli", "web", "claude-opus-5-5", 5, 1);
    b.daily(TODAY, "box", "codex-cli", "api", "unknown", 3, null);
    b.daily(dayOf(-40), "box", "codex-cli", "api", "gpt-5.5", 7, 3); // in `daily` only (older than 30 days)
    b.daily(dayOf(-70), "box", "codex-cli", "api", "gpt-5.5", 7, 3); // outside every window
    const { status, json } = await b.get("/api/usage?group=insights");
    expect(status).toBe(200);
    expect(json).toMatchObject({ group: "insights", today: TODAY, from: dayOf(-59), from30: dayOf(-29), weekHourDays: USAGE_WEEKHOUR_DAYS, truncated: [] });
    expect(json.daily.map((d: any) => [d.day, d.requests])).toEqual([[dayOf(-40), 7], [TODAY, 18]]);
    expect(json.byApp.map((r: any) => [r.day, r.k, r.requests])).toEqual([[TODAY, "claude-cli", 15], [TODAY, "codex-cli", 3]]);
    expect(json.byProject.map((r: any) => [r.k, r.requests])).toEqual([["api", 3], ["web", 15]]);
    expect(json.models.map((r: any) => [r.model, r.usd, r.unpricedTokens > 0, r.unpricedRequests])).toEqual([["claude-opus-5-5", 3, false, 0], ["unknown", 0, true, 3]]);
    expect(json.hosts.map((r: any) => r.host)).toEqual(["laptop", "box"]);
    expect(json.weekHour).toEqual([]);
  });

  test("weekday x hour from the last 28 days of hourly rows (0 = Sunday)", async () => {
    const b = boot();
    b.hourly(`${TODAY}T08`, "laptop", 4); // Friday, the current hour
    b.hourly(`${dayOf(-7)}T08`, "laptop", 6); // the Friday before: same cell
    b.hourly(`${dayOf(-5)}T22`, "laptop", 1); // Sunday
    b.hourly(`${dayOf(-USAGE_WEEKHOUR_DAYS)}T09`, "laptop", 100); // just outside the window
    b.hourly(`${dayOf(1)}T09`, "skewed", 50); // a host clock ahead: a future hour is not counted
    b.hourly(`${TODAY}T23`, "skewed", 50); // later today than now (08:00 London)
    const { json } = await b.get("/api/usage?group=insights");
    expect(json.weekHour.map((c: any) => [c.w, c.h, c.requests])).toEqual([[0, "22", 1], [5, "08", 10]]);
  });

  test("no hourly table: the grid is empty and says pending; no daily table: the whole answer is pending", async () => {
    const a = boot({ dropHourly: true });
    a.daily(TODAY, "laptop", "claude-cli", "web", "claude-opus-5-5", 1, 1);
    const r = await a.get("/api/usage?group=insights");
    expect(r.status).toBe(200);
    expect(r.json.hourlyPending).toBe(true);
    expect(r.json.daily.length).toBe(1);
    const c = boot({ dropDaily: true });
    const p = await c.get("/api/usage?group=insights");
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ pending: true, daily: [], weekHour: [] });
  });

  test("an unknown group is still refused", async () => {
    expect((await boot().get("/api/usage?group=week")).status).toBe(400);
  });
});

describe("today against yesterday at the same hour", () => {
  test("sameTime sums today's hours up to now and yesterday's up to the same hour", async () => {
    const b = boot();
    b.hourly(`${TODAY}T07`, "laptop", 3);
    b.hourly(`${TODAY}T08`, "laptop", 1);
    b.hourly(`${TODAY}T09`, "laptop", 99); // after now
    b.hourly(`${dayOf(-1)}T08`, "laptop", 2);
    b.hourly(`${dayOf(-1)}T15`, "laptop", 40); // later than the same hour yesterday
    const { json } = await b.get("/api/usage?group=insights");
    expect(json.sameTime.hour).toBe("08");
    expect([json.sameTime.today.requests, json.sameTime.yesterday.requests]).toEqual([4, 2]);
  });
  test("no hourly table: no sameTime", async () => {
    const b = boot({ dropHourly: true });
    expect((await b.get("/api/usage?group=insights")).json.sameTime).toBeUndefined();
  });
});

describe("GET /api/usage?group=hour: hourly coverage", () => {
  test("per host: the day's requests and the part in hourly rows; the oldest stored hour", async () => {
    const b = boot();
    b.daily(TODAY, "laptop", "claude-cli", "web", "claude-opus-5-5", 10, 1);
    b.daily(TODAY, "old-box", "claude-cli", "web", "claude-opus-5-5", 30, 1);
    b.hourly(`${TODAY}T09`, "laptop", 10);
    b.hourly(`${dayOf(-3)}T11`, "laptop", 2);
    const { json } = await b.get(`/api/usage?group=hour&day=${TODAY}`);
    expect(json.coverage).toEqual([{ host: "laptop", requests: 10, hourly: 10 }, { host: "old-box", requests: 30, hourly: 0 }]);
    expect(json.hourlySince).toBe(`${dayOf(-3)}T11`);
  });
  test("no hourly rows at all: hourlySince is null", async () => {
    const b = boot();
    b.daily(TODAY, "old-box", "claude-cli", "web", "claude-opus-5-5", 30, 1);
    const { json } = await b.get(`/api/usage?group=hour&day=${TODAY}`);
    expect(json.coverage).toEqual([{ host: "old-box", requests: 30, hourly: 0 }]);
    expect(json.hourlySince).toBeNull();
  });
});
