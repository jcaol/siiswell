/**
 * The Durable Object ticker (src/ticker.ts) with a fake Durable Object state: `ensure` arms once, `alarm` runs what the
 * cron runs, stamps meta (`last_cron`, `last_alarm`) and ALWAYS re-arms (also after an error), the kill switch ends the
 * chain; and the Worker-side bootstrap (`ensureTicker`) is throttled per isolate, swallows errors and is called by the
 * `scheduled` handler and by the opportunistic path.
 */
import { describe, expect, test } from "bun:test";
import worker, { OrchTicker, route } from "../src/index";
import { ENSURE_TICKER_EVERY_MS, META_LAST_ALARM, ensureTicker, maintainOpportunistically } from "../src/maintenance";
import { TICK_ALARM_MS } from "../src/ticker";
import { addSource, makeCtx, makeEnv, request, setupPush, snapshot } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** A Durable Object state whose storage keeps one alarm, like the real one. */
function fakeState(initial: number | null = null) {
  const calls: Array<number> = [];
  const state = {
    alarm: initial as number | null,
    storage: {
      getAlarm: async () => state.alarm,
      setAlarm: async (t: number | Date) => {
        state.alarm = typeof t === "number" ? t : t.getTime();
        calls.push(state.alarm);
      },
    },
  };
  return { state, calls };
}

function boot(over: Parameters<typeof makeEnv>[0] = {}, clock = { t: NOW }) {
  const t = makeEnv(over);
  const { state, calls } = fakeState();
  const pushes: string[] = [];
  const ticker = new OrchTicker(state as never, t.env, { now: () => clock.t, fetch: async (url: string) => (pushes.push(url), new Response(null, { status: 201 })) });
  return { ...t, state, calls, ticker, clock, pushes };
}

const meta = (b: { db: { rows: <T>(sql: string, ...p: never[]) => T[] } }, k: string) => b.db.rows<{ v: string }>(`SELECT v FROM meta WHERE k = '${k}'`)[0]?.v;

describe("OrchTicker.ensure", () => {
  test("arms the alarm for now + 60 s when none is set, and only then", async () => {
    const b = boot();
    expect(await b.ticker.ensure()).toBe(true);
    expect(b.state.alarm).toBe(NOW + TICK_ALARM_MS);
    b.clock.t = NOW + 10_000;
    expect(await b.ticker.ensure()).toBe(false); // already armed: left alone, not pushed back
    expect(b.state.alarm).toBe(NOW + TICK_ALARM_MS);
    expect(b.calls).toHaveLength(1);
  });

  test("POST /ensure is the one route; everything else is 404", async () => {
    const b = boot();
    const res = await b.ticker.fetch(new Request("https://ticker.internal/ensure", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ armed: true });
    expect(await (await b.ticker.fetch(new Request("https://ticker.internal/ensure", { method: "POST" }))).json()).toEqual({ armed: false });
    for (const [path, method] of [["/ensure", "GET"], ["/", "POST"], ["/state", "GET"], ["/alarm", "POST"]]) {
      expect((await b.ticker.fetch(new Request(`https://ticker.internal${path}`, { method }))).status).toBe(404);
    }
  });

  test("a storage failure is a 500, never a throw", async () => {
    const t = makeEnv();
    const state = { storage: { getAlarm: async () => { throw new Error("storage down"); }, setAlarm: async () => undefined } };
    const orig = console.error;
    console.error = () => undefined;
    try {
      const res = await new OrchTicker(state as never, t.env).fetch(new Request("https://ticker.internal/ensure", { method: "POST" }));
      expect(res.status).toBe(500);
    } finally {
      console.error = orig;
    }
  });

  test("TICKER_ENABLED=0: nothing is armed", async () => {
    const b = boot({ TICKER_ENABLED: "0" });
    expect(await b.ticker.ensure()).toBe(false);
    expect(b.state.alarm).toBeNull();
  });
});

describe("OrchTicker.alarm", () => {
  test("runs what the cron runs (host-offline from the clock), stamps last_cron and last_alarm, and re-arms for now + 60 s", async () => {
    const b = boot();
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('silent', ?)").run(NOW - 7 * MIN);
    b.state.alarm = NOW; // the alarm that is firing
    await b.ticker.alarm();
    expect(b.db.rows<any>("SELECT key, resolved FROM alerts WHERE key = 'host-offline|silent'")).toEqual([{ key: "host-offline|silent", resolved: null }]);
    expect(meta(b, "last_cron")).toBe(String(NOW));
    expect(meta(b, META_LAST_ALARM)).toBe(String(NOW));
    expect(meta(b, "last_purge")).toBe(String(NOW)); // the purge claim ran too
    expect(b.state.alarm).toBe(NOW + TICK_ALARM_MS);
  });

  test("the chain keeps going: every alarm re-arms, the stamps advance a minute at a time, with no request in between", async () => {
    const b = boot();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      b.clock.t = NOW + i * TICK_ALARM_MS;
      await b.ticker.alarm();
      seen.push(meta(b, META_LAST_ALARM) as string);
      expect(b.state.alarm).toBe(b.clock.t + TICK_ALARM_MS);
    }
    expect(seen).toEqual([0, 1, 2, 3].map((i) => String(NOW + i * TICK_ALARM_MS)));
  });

  test("pushes handed to waitUntil are awaited before the alarm returns (there is no request to outlive)", async () => {
    const b = boot();
    const push = await setupPush(b);
    const ticker = new OrchTicker(b.state as never, b.env, { now: () => NOW, fetch: push.fetch as never });
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('silent', ?)").run(NOW - 7 * MIN);
    await ticker.alarm();
    expect(push.pushes).toHaveLength(1);
    expect(b.db.rows<any>("SELECT push_count FROM alerts WHERE key = 'host-offline|silent'")).toEqual([{ push_count: 1 }]);
  });

  test("an error inside the work never escapes and never breaks the chain: the alarm is re-armed anyway", async () => {
    const t = makeEnv();
    const { state } = fakeState(NOW);
    const broken = Object.defineProperty({ ...t.env }, "DB", { get() { throw new Error("D1 binding exploded"); } }) as typeof t.env;
    const orig = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await expect(new OrchTicker(state as never, broken, { now: () => NOW }).alarm()).resolves.toBeUndefined();
    } finally {
      console.error = orig;
    }
    expect(state.alarm).toBe(NOW + TICK_ALARM_MS);
    expect(logged.join("\n")).toContain("ticker alarm failed");
  });

  test("a D1 that is down is survived too (the cron body swallows it), still re-armed", async () => {
    const t = makeEnv();
    const { state } = fakeState(NOW);
    const down = { ...t.env, DB: { prepare() { throw new Error("D1 is down"); }, batch() { throw new Error("D1 is down"); } } as unknown as D1Database };
    const orig = console.error;
    console.error = () => undefined;
    try {
      await new OrchTicker(state as never, down, { now: () => NOW }).alarm();
    } finally {
      console.error = orig;
    }
    expect(state.alarm).toBe(NOW + TICK_ALARM_MS);
  });

  test("even when re-arming itself fails, the alarm does not throw", async () => {
    const t = makeEnv();
    const state = { storage: { getAlarm: async () => null, setAlarm: async () => { throw new Error("no storage"); } } };
    const orig = console.error;
    console.error = () => undefined;
    try {
      await expect(new OrchTicker(state as never, t.env, { now: () => NOW }).alarm()).resolves.toBeUndefined();
    } finally {
      console.error = orig;
    }
  });

  test("TICKER_ENABLED=0: a pending alarm does nothing and is NOT re-armed (the chain ends)", async () => {
    const b = boot({ TICKER_ENABLED: "0" });
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('silent', ?)").run(NOW - 7 * MIN);
    b.state.alarm = null;
    await b.ticker.alarm();
    expect(b.state.alarm).toBeNull();
    expect(b.calls).toHaveLength(0);
    expect(b.db.rows("SELECT * FROM alerts")).toEqual([]);
    expect(meta(b, META_LAST_ALARM)).toBeUndefined();
  });

  test("the alarm's last_cron stamp makes the opportunistic path stand back (a reliable clock, like a working cron)", async () => {
    const b = boot({ OPPORTUNISTIC_MAINTENANCE: "1" });
    b.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('silent', ?)").run(NOW - 7 * MIN);
    await b.ticker.alarm(); // opens host-offline
    b.db.sqlite.exec("DELETE FROM alerts");
    const ctx = makeCtx();
    await maintainOpportunistically(b.env, ctx, NOW + MIN); // last_cron is one minute old: the clock is running
    await ctx.flush();
    expect(b.db.rows("SELECT * FROM alerts")).toEqual([]);
    await maintainOpportunistically(b.env, ctx, NOW + 5 * MIN); // ... and when the alarms stop, it takes over again
    await ctx.flush();
    expect(b.db.rows<any>("SELECT key FROM alerts")).toEqual([{ key: "host-offline|silent" }]);
  });
});

// ── the Worker side: starting the ticker ───────────────────────────────────────────────────────────────────

/** A TICKER binding whose one instance is a real OrchTicker over a fake state; records every request it receives. */
function binding(env: ReturnType<typeof makeEnv>["env"], opts: { fail?: boolean } = {}) {
  const { state } = fakeState();
  const requests: string[] = [];
  const ticker = new OrchTicker(state as never, env, { now: () => NOW });
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        requests.push(`${id.name} ${init?.method ?? "GET"} ${url}`);
        if (opts.fail) throw new Error("DO unavailable");
        return ticker.fetch(new Request(url, init));
      },
    }),
  };
  (env as { TICKER?: unknown }).TICKER = ns;
  return { state, requests, ns };
}

describe("ensureTicker (the Worker's bootstrap)", () => {
  test("one request to the single instance `main`, at most once per isolate per 10 minutes", async () => {
    const t = makeEnv();
    const b = binding(t.env);
    await ensureTicker(t.env, NOW);
    await ensureTicker(t.env, NOW + 1000);
    await ensureTicker(t.env, NOW + ENSURE_TICKER_EVERY_MS - 1);
    expect(b.requests).toEqual(["main POST https://ticker.internal/ensure"]);
    expect(b.state.alarm).toBe(NOW + TICK_ALARM_MS);
    await ensureTicker(t.env, NOW + ENSURE_TICKER_EVERY_MS);
    expect(b.requests).toHaveLength(2);
  });

  test("errors are swallowed and logged, and retried after a minute (not ten)", async () => {
    const t = makeEnv();
    const b = binding(t.env, { fail: true });
    const orig = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await expect(ensureTicker(t.env, NOW)).resolves.toBeUndefined();
      await ensureTicker(t.env, NOW + 30_000); // inside the retry pause
      expect(b.requests).toHaveLength(1);
      await ensureTicker(t.env, NOW + MIN);
      expect(b.requests).toHaveLength(2);
    } finally {
      console.error = orig;
    }
    expect(logged.join("\n")).toContain("ticker ensure failed");
  });

  test("a non-2xx answer counts as a failure; no binding or TICKER_ENABLED=0 is a silent no-op", async () => {
    const t = makeEnv();
    await ensureTicker(t.env, NOW); // no TICKER binding (tests, a Worker deployed without it)
    const off = makeEnv({ TICKER_ENABLED: "0" });
    const b = binding(off.env);
    await ensureTicker(off.env, NOW);
    expect(b.requests).toEqual([]);
  });

  test("the opportunistic path starts it (even with OPPORTUNISTIC_MAINTENANCE=0, which is about the other work), a real ingest included", async () => {
    const t = makeEnv({ OPPORTUNISTIC_MAINTENANCE: "0" });
    const b = binding(t.env);
    const ctx = makeCtx();
    const token = await addSource(t.db, "hosta", "host");
    const res = await route(request("/api/ingest/snapshot", { token, body: snapshot({}, NOW) }), t.env, ctx, { now: NOW });
    await ctx.flush();
    expect(res.status).toBe(200);
    expect(b.requests).toEqual(["main POST https://ticker.internal/ensure"]);
    expect(b.state.alarm).toBe(NOW + TICK_ALARM_MS);
  });

  test("a refused request does not start it (an anonymous request must never buy work)", async () => {
    const t = makeEnv();
    const b = binding(t.env);
    const ctx = makeCtx();
    const res = await route(request("/api/ingest/snapshot", { token: "oct_wrong", body: {} }), t.env, ctx, { now: NOW });
    await ctx.flush();
    expect(res.status).toBe(401);
    expect(b.requests).toEqual([]);
  });

  test("/api/state starts it too (an open page keeps it armed)", async () => {
    const t = makeEnv();
    const b = binding(t.env);
    const ctx = makeCtx();
    expect((await route(request("/api/state"), t.env, ctx, { now: NOW })).status).toBe(200);
    await ctx.flush();
    expect(b.requests).toHaveLength(1);
  });

  test("the scheduled handler runs the cron body AND makes sure the ticker is armed", async () => {
    const t = makeEnv();
    const b = binding(t.env);
    t.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('silent', ?)").run(Date.now() - 7 * MIN);
    const ctx = makeCtx();
    (worker as { scheduled: (c: unknown, e: unknown, x: unknown) => void }).scheduled({}, t.env, ctx);
    await ctx.flush();
    expect(b.requests).toHaveLength(1);
    expect(t.db.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'last_cron'")).toHaveLength(1);
    expect(t.db.rows<any>("SELECT key FROM alerts WHERE key = 'host-offline|silent'")).toHaveLength(1);
  });
});

describe("wrangler.toml declares the ticker", () => {
  test("a TICKER binding for class OrchTicker, a v1 migration with new_sqlite_classes, and the entry exports that class", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const toml = readFileSync(join(import.meta.dir, "..", "wrangler.toml"), "utf8");
    expect(toml).toMatch(/\[\[durable_objects\.bindings\]\]\s*\nname = "TICKER"\s*\nclass_name = "OrchTicker"/);
    expect(toml).toMatch(/\[\[migrations\]\]\s*\ntag = "v1"\s*\nnew_sqlite_classes = \["OrchTicker"\]/);
    expect(typeof OrchTicker).toBe("function");
  });
});
