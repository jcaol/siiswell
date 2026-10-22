/**
 * @file Worker entry: fetch router + cron.
 * @module dashboard-worker/index
 *
 * Routes (static assets are served by the platform for everything else; wrangler.toml makes the
 * Worker run first only for /api/* and /mcp):
 *   POST /api/ingest/{snapshot,events,heartbeat}   bearer `host` token   (Access bypass at the edge)
 *   POST /mcp                                      bearer `client` token (Access bypass at the edge)
 *   GET  /api/ingest/client/{latest,siiswell.mjs}         bearer `client` or `host` token (Access bypass at the edge): `siiswell update`
 *   POST /api/ingest/usage                         bearer `host` token   (Access bypass at the edge: the /api/ingest/* policy)
 *   GET  /api/state                                Cloudflare Access JWT
 *   GET  /api/usage                                Cloudflare Access JWT (same gate as /api/state; not part of it)
 *   GET  /api/push/key, POST /api/push/{subscribe,test}   Cloudflare Access JWT
 *   GET  /api/health                               unauthenticated liveness, no data
 *
 * Every response (the Worker's own and the static assets it passes through) carries Strict-Transport-Security.
 * /api/state, /api/usage and /api/push/* refuse cross-site browser requests (403) and never send CORS headers.
 * A successful host ingest or state read also hands the housekeeping that the cron trigger should do (retention
 * purge, time-based rules) to `ctx.waitUntil`: see maintenance.ts. The same calls (and `scheduled`) make sure the
 * Durable Object ticker's alarm is armed (ticker.ts): no route reaches the Durable Object.
 */
import { BUILD } from "./build-info";
import { configureDashboardTz } from "./tz";
import { handleHumanIngest } from "./human";
import { isCrossSiteRequest, requireAccess, type AccessResult, type FetchLike } from "./auth";
import type { AppCtx, Env } from "./env";
import { DASHBOARD_VERSION } from "./env";
import { acceptsLastLine, handleIngest, type IngestRoute } from "./ingest";
import { CLIENT_DIST, type ClientDist } from "./client-dist";
import { handleClientRoute } from "./client-update";
import { handleMcp } from "./mcp";
import { handleUsageIngest, handleUsageRead } from "./usage";
import { handleOtlpIngest } from "./otlp";
import { handleWellbeingRead, handleWellbeingWrite } from "./wellbeing";
import { ensureTicker, maintainOpportunistically, runCronBody } from "./maintenance";
import { handlePushRoute } from "./push";
import { buildState } from "./state";
import { HSTS, errorJson, json } from "./util";

export interface Deps {
  /** Clock (tests). */
  now?: number;
  /** Outbound fetch for Access JWKS and push services (tests). */
  fetch?: FetchLike;
  /**
   * Gate of the browser API (/api/state, /api/usage, /api/push/*) in place of Cloudflare Access: the self-hosted
   * server (src/server/bun.ts) passes its own login / trusted-proxy check. Unset = Cloudflare Access (requireAccess).
   */
  /** The CLI bundle behind /api/ingest/client/* (tests); default: the one embedded at deploy time (src/client-dist.ts). */
  clientDist?: ClientDist | null;
  browserAuth?: (req: Request, now: number) => Promise<AccessResult>;
}

const INGEST_ROUTES: Record<string, IngestRoute> = {
  "/api/ingest/snapshot": "snapshot",
  "/api/ingest/events": "events",
  "/api/ingest/heartbeat": "heartbeat",
};

/**
 * Dot segments, encoded dots/slashes/backslashes, NUL and empty segments in the path as received.
 * The edge (Access policies) and the Worker must never disagree about which route a path is, so
 * anything that only resolves to a route AFTER normalisation (`/api/ingest/%2e%2e/state`) is refused
 * outright instead of being normalised. The Worker's own Access check on /api/state is the second layer.
 */
const AMBIGUOUS_PATH = /%2e|%2f|%5c|%00|\\|(?:^|\/)\.{1,2}(?:\/|$)|\/\//i;

// (HSTS lives in util.ts: workerd refuses to start when the entry module exports anything but a function / class /
// handler, see test/entry-exports.test.ts.)

function withHsts(res: Response): Response {
  if (res.headers.has("Strict-Transport-Security")) return res;
  try {
    res.headers.set("Strict-Transport-Security", HSTS);
    return res;
  } catch {
    // a response from the assets binding has immutable headers: copy it
    const copy = new Response(res.body, res);
    copy.headers.set("Strict-Transport-Security", HSTS);
    return copy;
  }
}

export async function route(req: Request, env: Env, ctx: AppCtx, deps: Deps = {}): Promise<Response> {
  configureDashboardTz(env);
  return withHsts(await dispatch(req, env, ctx, deps));
}

async function dispatch(req: Request, env: Env, ctx: AppCtx, deps: Deps): Promise<Response> {
  const now = deps.now ?? Date.now();
  const rawPath = (req.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").split(/[?#]/)[0] ?? "");
  if (AMBIGUOUS_PATH.test(rawPath)) return errorJson(400, "ambiguous path");
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

  try {
    const ingest = INGEST_ROUTES[path];
    if (ingest) {
      const res = await handleIngest(req, env, ctx, ingest, now, deps.fetch);
      // Only an authenticated, accepted request may start housekeeping (see maintenance.ts).
      if (res.status >= 200 && res.status < 300) ctx.waitUntil(maintainOpportunistically(env, ctx, now, deps.fetch));
      return res;
    }

    if (path === "/api/ingest/usage") {
      const res = await handleUsageIngest(req, env, now);
      if (res.status >= 200 && res.status < 300) ctx.waitUntil(maintainOpportunistically(env, ctx, now, deps.fetch));
      return res;
    }

    if (path === "/api/ingest/otlp") return await handleOtlpIngest(req, env, now);

    if (path === "/api/ingest/human") return await handleHumanIngest(req, env, now);

    if (path === "/api/ingest/client/latest" || path === "/api/ingest/client/siiswell.mjs") {
      return await handleClientRoute(req, env, now, path, deps.clientDist === undefined ? CLIENT_DIST : deps.clientDist);
    }

    if (path === "/mcp") return await handleMcp(req, env, ctx, now, deps.fetch);

    if (path === "/api/health") return json({ ok: true, version: DASHBOARD_VERSION, sha: BUILD.sha, built: BUILD.built });

    if (path === "/api/state" || path === "/api/usage" || path.startsWith("/api/push/") || path === "/api/wellbeing" || path.startsWith("/api/wellbeing/")) {
      // The browser API is for the dashboard page itself: a request another site makes with the viewer's Access
      // cookie is refused before anything is read (and no CORS header is ever sent, so it could not be read anyway).
      if (isCrossSiteRequest(req, env)) return errorJson(403, "cross-site request refused");
      const access = deps.browserAuth ? await deps.browserAuth(req, now) : await requireAccess(req, env, now, deps.fetch);
      if (!access.ok) return access.response;
      if (path === "/api/state") {
        if (req.method !== "GET") return errorJson(405, "GET only", { Allow: "GET" });
        const state = await buildState(env.DB, now, acceptsLastLine(env));
        ctx.waitUntil(maintainOpportunistically(env, ctx, now, deps.fetch));
        return json(state);
      }
      if (path === "/api/usage") return await handleUsageRead(req, env, now);
      if (path === "/api/wellbeing") return await handleWellbeingRead(req, env.DB, now);
      if (path.startsWith("/api/wellbeing/")) return await handleWellbeingWrite(req, env.DB, path, now);
      return await handlePushRoute(req, env, ctx, path, now, deps.fetch);
    }

    if (path.startsWith("/api/") || path.startsWith("/mcp/")) return errorJson(404, "not found");
    // Anything else is a static asset (reached only if the platform did not already serve it).
    return env.ASSETS ? await env.ASSETS.fetch(req) : errorJson(404, "not found");
  } catch (err) {
    // Never echo internals (they could contain request data); log the message only.
    console.error("unhandled error:", err instanceof Error ? err.message : String(err));
    return errorJson(500, "internal error");
  }
}

/**
 * One cron minute: time-based rules, due pushes, retention purge (every 15 minutes, claimed like the opportunistic
 * one, so a purge that a request already did is not repeated). The cron trigger has never been seen to fire in
 * production; it stamps `last_cron` so the opportunistic path (maintenance.ts) stays out of its way while it works.
 * The Durable Object ticker (ticker.ts) runs exactly this body from its alarm, which is the clock that does fire.
 */
export async function runCron(env: Env, ctx: AppCtx, now: number, deps: Deps = {}): Promise<void> {
  await runCronBody(env, ctx, now, deps.fetch);
}

// The ticker's Durable Object class: workerd finds it by this export (a class is a valid entry export, a constant is not).
export { OrchTicker } from "./ticker";

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(req, env, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const now = Date.now();
    ctx.waitUntil(Promise.all([runCron(env, ctx, now), ensureTicker(env, now)]));
  },
} satisfies ExportedHandler<Env>;
