import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { HEARTBEAT_INTERVAL_MS, HOST_OFFLINE_AFTER_MS } from "../src/shared/schema";
import { HOST_WRITE_EVERY_MS, LIVENESS_WRITE_FLOOR_MS } from "../src/db";
import { route, runCron } from "../src/index";
import { addSource, makeCtx, makeEnv, request, snapshot } from "./d1-shim";

/**
 * Host liveness with the an older cadence: one heartbeat per project per 120 s (1.0.3 sent one per 60 s). The
 * host row is the only liveness source; it must follow EVERY heartbeat (throttle 90 s < 120 s), one lost heartbeat
 * must not look like an outage (offline limit 5 min), and a dead host must still be flagged within 5-7 minutes.
 */
const T0 = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

/** Small deterministic PRNG so the jitter tests are repeatable. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function boot() {
  const t = makeEnv();
  const ctx = makeCtx();
  const token = await addSource(t.db, "hosta", "host");
  const heartbeat = async (now: number) => {
    const res = await route(request("/api/ingest/heartbeat", { token, body: { v: 1, host: "hosta", at: now, binaryVersion: "1.0.4" } }), t.env, ctx, { now });
    expect(res.status).toBe(200);
  };
  const offline = async (now: number): Promise<boolean> => {
    const res = await route(request("/api/state"), t.env, ctx, { now });
    const s = (await res.json()) as { hosts: Array<{ host: string; offline: boolean }> };
    return s.hosts.find((h) => h.host === "hosta")?.offline ?? true;
  };
  const cron = async (now: number) => { await runCron(t.env, ctx, now, { fetch: async () => new Response(null, { status: 201 }) }); await ctx.flush(); };
  const hostOfflineAlerts = () => t.db.rows<{ key: string; resolved: number | null }>("SELECT key, resolved FROM alerts WHERE rule = 'host-offline'");
  const hostWrites = () => (t.db.rows<{ last_seen: number }>("SELECT last_seen FROM hosts")[0]?.last_seen ?? 0);
  return { ...t, ctx, token, heartbeat, offline, cron, hostOfflineAlerts, hostWrites };
}

describe("the constants fit together", () => {
  test("heartbeat 2 min, a floor far below any real sender, an offline limit of 6 min that leaves room for a lost heartbeat after a late one", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(120_000);
    expect(HOST_WRITE_EVERY_MS).toBe(90_000);                                              // refused requests only
    expect(LIVENESS_WRITE_FLOOR_MS).toBeLessThan(60_000);                                   // an old 60 s pusher is never skipped
    expect(HOST_OFFLINE_AFTER_MS).toBe(6 * MIN);
    // worst gap between two heartbeats: interval + one 5 s poll tick + 20 s jitter; one lost heartbeat doubles it
    const gap = HEARTBEAT_INTERVAL_MS + 5 * SEC + 20 * SEC;
    expect(2 * gap).toBeLessThan(HOST_OFFLINE_AFTER_MS - 60 * SEC);                          // >= 70 s of margin
    expect(HOST_OFFLINE_AFTER_MS).toBeLessThanOrEqual(6 * MIN);                              // flagged by the page at once, by the cron within 7 min
  });
});

describe("a 120 s heartbeat keeps the host online", () => {
  test("120 s heartbeats with +-20 s jitter (plus a 5 s tick) for 6 hours: never offline, no host-offline alert, last_seen follows every heartbeat", async () => {
    const b = await boot();
    const rand = rng(7);
    let nextBeat = T0;
    let lastBeat = -1;
    let samples = 0;
    for (let now = T0; now <= T0 + 6 * 3600 * SEC; now += 5 * SEC) {
      if (now >= nextBeat) {
        await b.heartbeat(now);
        lastBeat = now;
        expect(b.hostWrites()).toBe(now);                                                  // EVERY heartbeat refreshed the row (throttle 90 s < 120 s)
        nextBeat = Math.round(now + HEARTBEAT_INTERVAL_MS + (rand() * 40 - 20) * SEC + rand() * 5 * SEC);
        nextBeat = Math.max(nextBeat, now + 100 * SEC);
      }
      if ((now - T0) % (30 * SEC) === 0) {
        expect(await b.offline(now)).toBe(false);
        samples++;
      }
      if ((now - T0) % MIN === 0) await b.cron(now);
    }
    expect(lastBeat).toBeGreaterThan(T0 + 5 * 3600 * SEC);
    expect(samples).toBeGreaterThan(600);
    expect(b.hostOfflineAlerts()).toEqual([]);
  });

  test("one lost heartbeat, worst case (every gap at the maximum, every 5th beat never arrives): still online all the time", async () => {
    const b = await boot();
    const gap = HEARTBEAT_INTERVAL_MS + 20 * SEC + 5 * SEC;
    let longest = 0;
    let last = T0;
    await b.heartbeat(T0);
    for (let beat = 1; beat <= 60; beat++) {
      const at = T0 + beat * gap;
      // sample right before the next heartbeat would have arrived, and when it does not (lost): the silence is at its longest
      for (let now = last + 5 * SEC; now <= at; now += 5 * SEC) {
        if ((now - T0) % MIN === 0) await b.cron(now);
        if ((now - T0) % (15 * SEC) === 0) expect(await b.offline(now)).toBe(false);
      }
      longest = Math.max(longest, at - last);
      if (beat % 5 === 0) continue;                                                        // lost: last_seen stays
      await b.heartbeat(at);
      last = at;
    }
    expect(longest).toBeLessThan(HOST_OFFLINE_AFTER_MS);
    expect(await b.offline(last + 2 * gap)).toBe(false);
    expect(b.hostOfflineAlerts()).toEqual([]);
  });

  test("an old an older pusher (60 s heartbeat) against this Worker: online, and EVERY heartbeat refreshes the row", async () => {
    const b = await boot();
    let beats = 0;
    for (let now = T0; now <= T0 + 2 * 3600 * SEC; now += 62 * SEC) {
      await b.heartbeat(now);
      beats++;
      expect(b.hostWrites()).toBe(now);
      expect(await b.offline(now + 61 * SEC)).toBe(false);
    }
    expect(beats).toBeGreaterThan(100);
  });
});

describe("one project on the host: events, a late heartbeat and a lost one (the review's scenario)", () => {
  /** Sample "is the host offline?" every 15 s between two instants, and run the cron every wall-clock minute. */
  async function watch(b: Awaited<ReturnType<typeof boot>>, from: number, to: number) {
    for (let now = from; now <= to; now += 5 * SEC) {
      if ((now - T0) % MIN === 0) await b.cron(now);
      if ((now - T0) % (15 * SEC) === 0) expect({ at: now - from, offline: await b.offline(now) }).toEqual({ at: now - from, offline: false });
    }
  }
  const events = async (b: Awaited<ReturnType<typeof boot>>, at: number) => {
    const res = await route(request("/api/ingest/events", { token: b.token, body: { v: 1, host: "hosta", project: "proja", events: [{ kind: "status", origin: ORIGIN_HOST, at, severity: "info", key: `e${at}`, agent: "agent01", status: "DONE", text: "STATUS: DONE ok" }] } }), b.env, b.ctx, { now: at });
    expect(res.status).toBe(200);
  };

  test("write at W, events at W+89 s, the next heartbeat late (+145 s) and one more lost: never offline, no alert", async () => {
    const b = await boot();
    const W = T0;
    await b.heartbeat(W);
    await events(b, W + 89 * SEC);                                                         // resets the pusher's heartbeat timer
    await b.heartbeat(W + 89 * SEC + 145 * SEC);                                           // late: 145 s later
    // the following one is lost; the next arrives 290 s after the last write
    await watch(b, W, W + 89 * SEC + 145 * SEC + 290 * SEC - 5 * SEC);
    await b.heartbeat(W + 89 * SEC + 145 * SEC + 290 * SEC);
    expect(await b.offline(W + 89 * SEC + 145 * SEC + 290 * SEC + SEC)).toBe(false);
    expect(b.hostOfflineAlerts()).toEqual([]);
  });

  test("write at W, events at W+89 s, then the heartbeat that was due is LOST and the next arrives 145 s later (379 s after W): still never offline", async () => {
    const b = await boot();
    const W = T0;
    await b.heartbeat(W);
    await events(b, W + 89 * SEC);                                                         // 89 s after the write
    await watch(b, W, W + 89 * SEC + 290 * SEC - SEC);                                      // silence after the events batch: 290 s; after the first write: 379 s
    await b.heartbeat(W + 89 * SEC + 290 * SEC);
    expect(W + 89 * SEC + 290 * SEC - W).toBeGreaterThan(HOST_OFFLINE_AFTER_MS - 10 * SEC); // (379 s after the first write: it was the EVENTS write that carried the host)
    expect(b.hostOfflineAlerts()).toEqual([]);
  });

  test("snapshots refresh the row like heartbeats do", async () => {
    const b = await boot();
    const snap = async (at: number) => {
      const res = await route(request("/api/ingest/snapshot", { token: b.token, body: snapshot({ host: "hosta" } as never, at) }), b.env, b.ctx, { now: at });
      expect(res.status).toBe(200);
    };
    await snap(T0);
    await snap(T0 + 60 * SEC);
    expect(b.hostWrites()).toBe(T0 + 60 * SEC);
  });
});

describe("a dead host is still reported", () => {
  test("after the last heartbeat: online up to 6 min, offline right after, a host-offline alert by the cron within 7 min", async () => {
    const b = await boot();
    const rand = rng(3);
    let now = T0;
    for (let i = 0; i < 20; i++) {                                                         // a healthy stretch first
      await b.heartbeat(now);
      now += Math.round(HEARTBEAT_INTERVAL_MS + (rand() * 40 - 20) * SEC);
    }
    const lastBeat = b.hostWrites();
    expect(lastBeat).toBeLessThanOrEqual(now);
    expect(await b.offline(lastBeat + HOST_OFFLINE_AFTER_MS)).toBe(false);                 // exactly 6 min: not yet
    expect(await b.offline(lastBeat + HOST_OFFLINE_AFTER_MS + SEC)).toBe(true);            // the page flags it at once

    let alertAt = 0;
    const firstMinute = T0 + Math.ceil((lastBeat - T0) / MIN) * MIN;                       // the cron runs on every wall-clock minute
    for (let t = firstMinute; t <= lastBeat + 10 * MIN && !alertAt; t += MIN) {
      await b.cron(t);
      if (b.hostOfflineAlerts().length) alertAt = t;
    }
    expect(alertAt).toBeGreaterThan(lastBeat + HOST_OFFLINE_AFTER_MS);
    expect(alertAt).toBeLessThanOrEqual(lastBeat + 7 * MIN);                                // 6 min of silence + at most one cron minute

    // it comes back: the heartbeat refreshes the row at once and resolves the alert
    const back = lastBeat + 12 * MIN;
    await b.heartbeat(back);
    expect(await b.offline(back + SEC)).toBe(false);
    expect(b.hostOfflineAlerts()[0]?.resolved).not.toBeNull();
  });
});
