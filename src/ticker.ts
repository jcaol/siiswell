/**
 * @file OrchTicker: a Durable Object whose ALARM is a clock that does not depend on the cron trigger.
 * @module dashboard-worker/ticker
 *
 * The Cloudflare cron trigger has never fired for this Worker (schedule registered, redeployed, zero scheduled
 * invocations in analytics), and the opportunistic maintenance (maintenance.ts) only runs when a request arrives: if
 * the only host dies and nobody has the page open, nothing runs and no host-offline push is sent. A Durable Object
 * alarm is a timer the platform keeps, request or no request, so:
 *
 *  - ONE global instance (`env.TICKER.idFromName("main")`), SQLite-backed (wrangler.toml `new_sqlite_classes`); no
 *    public route reaches it: only the Worker's own binding can call `fetch` on it;
 *  - `ensure()` (POST /ensure): when no alarm is set, arm one for now + 60 s. Called by the `scheduled` handler and by
 *    the opportunistic path at most once per isolate per 10 minutes (maintenance.ts `ensureTicker`);
 *  - `alarm()`: stamp meta `last_alarm`, run EXACTLY what the cron runs (`runCronBody`: stamp `last_cron`, the
 *    time-based rules and push summaries, the purge claim), await every push the rules handed to `waitUntil`, and
 *    ALWAYS re-arm for now + 60 s, also after an error (alarm auto-retry is never relied on). Because it stamps
 *    `last_cron`, the opportunistic path backs off exactly as it does for a working cron;
 *  - `TICKER_ENABLED=0`: `ensure()` arms nothing and a pending alarm stops without re-arming.
 *
 * Written as a plain class (constructor(state, env) + fetch + alarm, the classic Durable Object shape) rather than
 * `extends DurableObject`, so the module has no `cloudflare:workers` import and the unit tests load it in bun.
 */
import { configureDashboardTz } from "./tz";
import type { FetchLike } from "./auth";
import type { AppCtx, Env } from "./env";
import { META_LAST_ALARM, runCronBody, stampMeta } from "./maintenance";

/** The alarm period. */
export const TICK_ALARM_MS = 60_000;

/** Test seams (workerd constructs the class with `(state, env)` only). */
export interface TickerDeps {
  now?: () => number;
  fetch?: FetchLike;
}

/** Just the parts of DurableObjectState the ticker uses. */
export interface TickerState {
  storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;
}

export class OrchTicker {
  constructor(
    private readonly state: TickerState,
    private readonly env: Env,
    private readonly deps: TickerDeps = {},
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private disabled(): boolean {
    return this.env.TICKER_ENABLED === "0";
  }

  /** Only the Worker's own binding can reach this: there is one route, `POST /ensure`. */
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/ensure" && req.method === "POST") {
      try {
        return Response.json({ armed: await this.ensure() });
      } catch (err) {
        console.error("ticker ensure failed:", err instanceof Error ? err.message : String(err));
        return Response.json({ error: "ensure failed" }, { status: 500 });
      }
    }
    return new Response("not found", { status: 404 });
  }

  /** Arm the alarm for now + 60 s unless one is already set. True when this call armed it. */
  async ensure(): Promise<boolean> {
    if (this.disabled()) return false;
    if ((await this.state.storage.getAlarm()) !== null) return false;
    await this.state.storage.setAlarm(this.now() + TICK_ALARM_MS);
    return true;
  }

  async alarm(): Promise<void> {
    if (this.disabled()) return; // switched off: the chain ends here
    try {
      await runTick(this.env, this.now(), this.deps.fetch);
    } finally {
      try {
        await this.state.storage.setAlarm(this.now() + TICK_ALARM_MS);
      } catch (err) {
        console.error("ticker re-arm failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

/**
 * One tick of the clock: what the alarm does (also the self-hosted server's setInterval, src/server/bun.ts). Never
 * throws. Pushes the rules hand to waitUntil are awaited here (also after an error part-way through): there is no
 * request to outlive, so wait for them (the loop also picks up ones added while waiting). Each was wrapped in a catch.
 */
export async function runTick(env: Env, now: number, fetchImpl?: FetchLike): Promise<void> {
  configureDashboardTz(env);
  const pending: Promise<unknown>[] = [];
  const ctx: AppCtx = {
    waitUntil: (p) => {
      pending.push(p.catch(() => undefined));
    },
  };
  try {
    await stampMeta(env.DB, META_LAST_ALARM, now);
    await runCronBody(env, ctx, now, fetchImpl);
  } catch (err) {
    console.error("ticker alarm failed:", err instanceof Error ? err.message : String(err));
  } finally {
    for (let i = 0; i < pending.length; i++) await pending[i];
  }
}
