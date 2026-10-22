/**
 * @file GET /api/ingest/client/latest (manifest) and GET /api/ingest/client/siiswell.mjs (the CLI bundle) for `siiswell update`.
 * @module dashboard-worker/client-update
 *
 * Both need a valid, non-revoked bearer token of kind client OR host (the same checks and per-token rate limit as every other
 * token route). The bundle is not a static asset: it lives inside the Worker (src/client-dist.ts) and is never served without a token.
 */
import { authenticateBearer } from "./auth";
import type { Env } from "./env";
import type { ClientDist } from "./client-dist";
import { errorJson, json } from "./util";

export async function handleClientRoute(req: Request, env: Env, now: number, path: string, dist: ClientDist | null): Promise<Response> {
  if (req.method !== "GET") return errorJson(405, "GET only", { Allow: "GET" });
  const auth = await authenticateBearer(req, env, "any", now);
  if (!auth.ok) return auth.response;
  if (!dist) return errorJson(404, "this server does not publish a client build");
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (path === "/api/ingest/client/latest") return json(dist.manifest, 200, headers);
  return new Response(dist.source, { status: 200, headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
}
