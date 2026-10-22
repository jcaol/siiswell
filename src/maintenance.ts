/**
 * @file Housekeeping that must not depend on the Cloudflare cron trigger: retention purge and the time-based rules.
 * @module dashboard-worker/maintenance
 *
 * The cron trigger ("* * * * *") has never been seen to fire in production, and without it nothing was ever
 * purged (data on Cloudflare would live for ever) and the clock-driven rules (host offline, approval reminders,
 * overdue, push summary flushes) never ran. The Durable Object ticker (ticker.ts) is now the clock that is relied on:
 * its alarm runs the cron body every 60 s and stamps `last_cron`. As a second line, the same work also runs
 * OPPORTUNISTICALLY, after a successful host ingest or `/api/state` read, inside `ctx.waitUntil` (never on the
 * response path), and these paths re-arm the ticker (`ensureTicker`) if its chain ever broke:
 *  - purge: at most once per PURGE_EVERY_MS, claimed with a conditional write of meta key `last_purge`, so two
 *    concurrent requests (or the cron and a request) cannot both purge; bounded rows per table (`purgeOld`);
 *  - time-based rules + push summary flush: at most once per TICK_EVERY_MS (meta `last_tick`, same claim), and ONLY
 *    when the cron has not run for CRON_FRESH_MS (meta `last_cron`, stamped by every cron run), so a working cron is
 *    never doubled.
 * Each claim is `INSERT ... ON CONFLICT DO UPDATE ... WHERE <old stamp is old enough> RETURNING k`: it succeeded if
 * and only if a row came back (never `meta.changes`, see budget.ts). A losing request costs one D1 row read.
 * Nothing here calls an AI or the network except the push services the rules already use.
 */
import { ALERT_DEFAULTS } from "./shared/schema";
import { HOOK_BLOCKED_STALE_MS, HOOK_IDLE_LINE, HOOK_IDLE_TITLE, HOOK_MARK, HOOK_STALE_LINE, HOOK_TITLES } from "./shared/hook";
import { META_LAST_CRON, META_LAST_PURGE, META_LAST_TICK, applyRules, purgeOld } from "./alerts";
import type { FetchLike } from "./auth";
import { claimedRow } from "./budget";
import { stmt } from "./db";
import { retentionDaysOf, usageRetentionDaysOf, type AppCtx, type Env } from "./env";
import { flushPushSummaries, sendToAll, vapidConfigured } from "./push";
import { runWindDown } from "./wellbeing-winddown";
import { runWellbeingPushes } from "./wellbeing-push";
import { runIntensityIfDue } from "./wellbeing-intensity";
import { cachedSettings, loadWbState, recordStressIfDue, refreshCalendarIfDue, runDigest } from "./wellbeing";
import { recordHourMetrics } from "./wellbeing-metrics";

/** The purge runs at most this often, whoever starts it (the cron or a request). */
export const PURGE_EVERY_MS = 15 * 60_000;
/** The opportunistic time-based rules run at most this often ... */
export const TICK_EVERY_MS = 60_000;
/** ... and only when the cron has not run for this long. */
export const CRON_FRESH_MS = 2 * 60_000;

/**
 * Claim a maintenance slot: stamp meta key `k` with `now` unless it was stamped less than `everyMs` ago. True for
 * exactly one of any number of concurrent callers.
 */
export async function claimMeta(db: D1Database, k: string, now: number, everyMs: number): Promise<boolean> {
  return claimedRow(
    db,
    `INSERT INTO meta (k, v, updated) VALUES (?1, ?2, ?3)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated WHERE CAST(meta.v AS INTEGER) <= ?4
     RETURNING k`,
    k,
    String(now),
    now,
    now - everyMs,
  );
}

/** Retention period in days (`RETENTION_DAYS`, default ALERT_DEFAULTS.retentionDays). */
export const retentionDays = (env: Pick<Env, "RETENTION_DAYS">): number => retentionDaysOf(env, ALERT_DEFAULTS.retentionDays);

/** Purge when the last purge is old enough (claimed); returns the rows removed per table, or null when it was not due. */
export async function purgeIfDue(env: Env, now: number): Promise<Record<string, number> | null> {
  try {
    if (!(await claimMeta(env.DB, META_LAST_PURGE, now, PURGE_EVERY_MS))) return null;
    return await purgeOld(env.DB, now, retentionDays(env), undefined, usageRetentionDaysOf(env));
  } catch (err) {
    console.error("purge failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** The clock-driven part of the cron: time-based rules and the due push summaries. */
export async function runTimeRules(env: Env, ctx: AppCtx, now: number, fetchImpl?: FetchLike): Promise<void> {
  await closeStaleMcpTasks(env.DB, now);
  await applyRules(env, ctx, now, fetchImpl);
  await runWellbeingTick(env, now, fetchImpl);
  // Sources whose push budget held alerts back get ONE "N more items" summary once their window ended.
  await flushPushSummaries(env, now, fetchImpl).catch(() => undefined);
}

/**
 * (1) any open, not blocked MCP task silent for 24 h; (2) a HOOK's BLOCKED task (fixed title + the hook's summary) silent for 2 h:
 * the permission was answered, then the session ended without any further hook. Other BLOCKED tasks are never closed.
 * (3) a hook's idle "Waiting for your input" BLOCKED task at once (older CLIs reported it; it is not a block).
 * ?1 now, ?2 the 24 h cutoff, ?3 batch, ?4 the 2 h cutoff, ?5 the hook summary, ?6 the closing line, ?7 the hook titles (JSON),
 * ?8 the idle title, ?9 its closing line.
 */
export const SQL_CLOSE_STALE_MCP = `UPDATE tasks SET state = 'stale', updated = ?1,
         last_line = CASE WHEN state = 'blocked' AND title = ?8 THEN ?9 WHEN state = 'blocked' THEN ?6 ELSE last_line END
       WHERE key IN (SELECT key FROM (
           -- two range seeks of idx_tasks_state_updated (state, updated); "+origin" keeps the planner off idx_tasks_agent
           SELECT key FROM tasks WHERE state IN ('queued', 'delivered', 'acked', 'running') AND updated < ?2 AND +origin = 'mcp'
           UNION ALL
           SELECT key FROM tasks WHERE state = 'blocked' AND updated < ?4 AND +origin = 'mcp' AND last_line = ?5 AND title IN (SELECT value FROM json_each(?7))
           UNION ALL
           -- (3) a hook's idle "Waiting for your input" (older CLIs): never a block, closed at once
           SELECT key FROM tasks WHERE state = 'blocked' AND +origin = 'mcp' AND last_line = ?5 AND title = ?8
         ) LIMIT ?3)
       RETURNING key`;

/** An MCP task with no update for this long is closed as `stale` (never a host-agent one; a blocked one only when a hook made it, see HOOK_BLOCKED_STALE_MS). */
export const MCP_STALE_CLOSE_MS = 24 * 60 * 60_000;
/** At most this many tasks are closed per tick (the next tick takes the rest). */
export const MCP_STALE_CLOSE_BATCH = 200;

/**
 * Close MCP tasks nobody updated for MCP_STALE_CLOSE_MS: a desktop client without hooks often finishes without update_task DONE.
 * They move to `stale` (shown under Recent results, labelled), which frees the client's open-task slots. BLOCKED tasks are
 * waiting on the operator and stay open; host-agent and relayed tasks are their host's business. Never throws. Returns the count.
 */
export async function closeStaleMcpTasks(db: D1Database, now: number): Promise<number> {
  try {
    const res = await stmt(
      db,
      // (1) any open, not blocked MCP task silent for 24 h; (2) a HOOK's BLOCKED task (fixed title + the hook's summary) silent for
      // 2 h: the permission was answered, then the session ended without any further hook. Other BLOCKED tasks are never closed.
      SQL_CLOSE_STALE_MCP,
      now,
      now - MCP_STALE_CLOSE_MS,
      MCP_STALE_CLOSE_BATCH,
      now - HOOK_BLOCKED_STALE_MS,
      HOOK_MARK,
      HOOK_STALE_LINE,
      JSON.stringify(HOOK_TITLES),
      HOOK_IDLE_TITLE,
      HOOK_IDLE_LINE,
    ).all();
    return res.results?.length ?? 0;
  } catch (err) {
    console.error("stale close failed:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/**
 * The well-being part of a scheduled minute: this hour's metrics (wellbeing-metrics.ts), then the digest push when one is
 * due (wellbeing.ts). Never throws. D1 per minute: 1 statement (one upsert of the hour's metrics; the settings are read at most
 * once a minute per isolate); with VAPID keys, 1 read of the policy state, and the digest 1 read + 1-3 writes once per interval.
 */
export async function runWellbeingTick(env: Env, now: number, fetchImpl?: FetchLike): Promise<void> {
  try {
    const settings = await cachedSettings(env.DB, now);
    if (!settings) return;
    await recordHourMetrics(env.DB, settings, now);
    if (env.WELLBEING_PUSH_POLICY === "0" || !vapidConfigured(env)) return;
    const st = await loadWbState(env.DB, now);
    if (!st) return;
    await runDigest(env.DB, st, now, env.PUBLIC_URL, async (m) => {
      const r = await sendToAll(env, m, { fetch: fetchImpl, now });
      return r.ok > 0;
    });
    // the wind-down summary (safe to leave) and the morning summary, once per night each
    await runWindDown(env.DB, st.settings, st.windSent, now, env.PUBLIC_URL, async (m) => {
      const r = await sendToAll(env, m, { fetch: fetchImpl, now });
      return r.ok > 0;
    });
    // the well-being reminders as push (micro-break, pace, after-hours, session, usage): capped, never in Focus / a block
    await runWellbeingPushes(env.DB, st, now, env.PUBLIC_URL, async (m) => {
      const r = await sendToAll(env, m, { fetch: fetchImpl, now });
      return r.ok > 0;
    });
    // three long / late days in a row: one "plan a rest day" suggestion at 18:00 on the third
    await runIntensityIfDue(env.DB, st.settings, st.intenseSent, now, env.PUBLIC_URL, async (m) => {
      const r = await sendToAll(env, m, { fetch: fetchImpl, now });
      return r.ok > 0;
    });
  } catch (err) {
    console.error("well-being tick failed:", err instanceof Error ? err.message : String(err));
  }
}

/** The ticker's own stamp: the last time its alarm fired (epoch ms as text). */
export const META_LAST_ALARM = "last_alarm";

/** Unconditional `meta` stamp (never throws). */
export async function stampMeta(db: D1Database, k: string, now: number): Promise<void> {
  try {
    await stmt(
      db,
      "INSERT INTO meta (k, v, updated) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated",
      k,
      String(now),
      now,
    ).run();
  } catch (err) {
    console.error(`${k} stamp failed:`, err instanceof Error ? err.message : String(err));
  }
}

/** Every cron run (and every ticker alarm) says so, so the opportunistic path knows to stay out of its way. */
export const stampCron = (db: D1Database, now: number): Promise<void> => stampMeta(db, META_LAST_CRON, now);

/**
 * What one scheduled minute does, whoever runs it (the cron trigger's `scheduled` handler or the ticker's alarm):
 * stamp `last_cron`, the time-based rules and due push summaries, then the purge claim.
 */
export async function runCronBody(env: Env, ctx: AppCtx, now: number, fetchImpl?: FetchLike): Promise<void> {
  await stampCron(env.DB, now);
  // Two clocks may run this body (the ticker's alarm and, should it ever start firing, the cron trigger), each about
  // once a minute with an arbitrary phase between them. Claiming `last_tick` with a gap a little under a minute lets
  // exactly one of them evaluate the time-based rules per minute (no doubled reminder pushes), while a clock running
  // alone (every 60 s) always wins its claim. The purge has its own 15-minute claim.
  let claimed = false;
  try {
    claimed = await claimMeta(env.DB, META_LAST_TICK, now, CRON_TICK_MIN_GAP_MS);
  } catch (err) {
    console.error("tick claim failed:", err instanceof Error ? err.message : String(err)); // D1 down: the rules would fail too
  }
  if (claimed) await runTimeRules(env, ctx, now, fetchImpl);
  const purged = await purgeIfDue(env, now);
  // the 15-minute stress sample never shares an invocation with the purge (it catches up a minute later)
  if (claimed && purged === null) await recordStressIfDue(env.DB, now);
  // Calendar Focus: one fetch a quarter hour (minute 11; minute 12 when 11 ran the purge), counted in this invocation's subrequests
  if (claimed && purged === null) await refreshCalendarIfDue(env.DB, now, fetchImpl ?? ((u, i) => fetch(u, i)));
}

/** Minimum gap between two scheduled rule evaluations (ticker alarm and/or cron): just under their 60 s period. */
export const CRON_TICK_MIN_GAP_MS = 50_000;

/** One isolate bootstraps the ticker at most this often. */
export const ENSURE_TICKER_EVERY_MS = 10 * 60_000;
const lastEnsured = new WeakMap<object, number>();

/**
 * Make sure the ticker's alarm is armed (it re-arms itself every minute, so this only matters at the first request
 * after a deploy, after the alarm chain was ever broken, or when the Worker has just been switched on): one request
 * to the single Durable Object instance, at most once per isolate per ENSURE_TICKER_EVERY_MS (a failed attempt is
 * retried after a minute). Never throws; callers hand it to `ctx.waitUntil`. No-op without the `TICKER` binding or
 * with `TICKER_ENABLED=0`.
 */
export async function ensureTicker(env: Env, now: number): Promise<void> {
  const ns = env.TICKER;
  if (!ns || env.TICKER_ENABLED === "0") return;
  const before = lastEnsured.get(ns as object);
  if (before !== undefined && now >= before && now - before < ENSURE_TICKER_EVERY_MS) return;
  lastEnsured.set(ns as object, now);
  try {
    const res = await ns.get(ns.idFromName("main")).fetch("https://ticker.internal/ensure", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    lastEnsured.set(ns as object, now - ENSURE_TICKER_EVERY_MS + 60_000); // try again in a minute, not in ten
    console.error("ticker ensure failed:", err instanceof Error ? err.message : String(err));
  }
}

/** One isolate asks D1 at most once per TICK_EVERY_MS (per database binding), so a busy stream of requests costs nothing extra. */
const lastAsked = new WeakMap<object, number>();

/**
 * Opportunistic maintenance (see the file header). Never throws; callers hand it to `ctx.waitUntil` after a
 * request that was authenticated and succeeded (an anonymous or failing request must never buy D1 work).
 */
export async function maintainOpportunistically(env: Env, ctx: AppCtx, now: number, fetchImpl?: FetchLike): Promise<void> {
  await ensureTicker(env, now); // the cron-independent clock: independent of the switch below, which is about THIS path
  if (env.OPPORTUNISTIC_MAINTENANCE === "0") return;
  try {
    const before = lastAsked.get(env.DB as object);
    if (before !== undefined && now >= before && now - before < TICK_EVERY_MS) return;
    lastAsked.set(env.DB as object, now);

    const purged = await purgeIfDue(env, now);

    const stamp = ((await stmt(env.DB, "SELECT v FROM meta WHERE k = ?", META_LAST_CRON).all<{ v: string }>()).results ?? [])[0]?.v;
    const lastCron = stamp === undefined ? 0 : Number(stamp) || 0;
    if (now - lastCron < CRON_FRESH_MS) return; // the cron is doing it
    if (!(await claimMeta(env.DB, META_LAST_TICK, now, TICK_EVERY_MS))) return;
    await runTimeRules(env, ctx, now, fetchImpl);
    if (purged === null) await recordStressIfDue(env.DB, now);
  } catch (err) {
    console.error("maintenance failed:", err instanceof Error ? err.message : String(err));
  }
}
