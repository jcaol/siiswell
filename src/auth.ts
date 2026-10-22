/**
 * @file Authentication: bearer tokens for ingest + MCP, Cloudflare Access JWT for the browser API.
 * @module dashboard-worker/auth
 *
 * Bearer: `Authorization: Bearer oct_...` -> sha256 hex -> `sources` row (not revoked). The kind of
 * the row must match the route (host -> /api/ingest/*, client -> /mcp). Tokens are never logged.
 *
 * Access: `Cf-Access-Jwt-Assertion` is verified here as defence in depth (the edge already
 * enforces Access for the human-facing routes): RS256 against the team JWKS, `aud`, `iss`, `exp`.
 */
import type { Env } from "./env";
import { findSourceByHash, touchSource, type SourceRow } from "./db";
import { CLIENT_HEADER, CLIENT_HEADER_RE } from "./shared/semver";
import { HOST_RE, b64urlDecode, errorJson, isObj, sha256Hex, utf8 } from "./util";

// ── Bearer ───────────────────────────────────────────────────────────────────

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S{1,512})\s*$/i.exec(h);
  return m ? (m[1] ?? null) : null;
}

/**
 * The exact shape of a token minted by scripts/new-token.ts: `oct_` + base64url of 32 random bytes.
 * Anything else is refused BEFORE the D1 lookup, so a flood of junk costs no database read.
 */
export const TOKEN_RE = /^oct_[A-Za-z0-9_-]{43}$/;

/**
 * Skip the `last_seen` write when the stored value is this fresh (saves a D1 write per call). Host
 * tokens are polled every minute and their liveness lives in `hosts`, so they touch rarely; client
 * tokens (`/mcp`) show `last_seen` in the dashboard.
 */
const TOUCH_EVERY_MS = { host: 5 * 60_000, client: 30_000 } as const;

export type BearerResult = { ok: true; source: SourceRow } | { ok: false; response: Response };

const TOO_MANY = (): Response => errorJson(429, "rate limit exceeded for this token", { "Retry-After": "60" });

/** Spend `n` units of the source's request budget (the Workers Rate Limiting binding); false = over. */
async function spendRateLimit(env: Env, kind: "host" | "client", sourceId: string, n: number): Promise<boolean> {
  const limiter = kind === "host" ? env.RATE_LIMIT_HOST : env.RATE_LIMIT_CLIENT;
  if (!limiter || n < 1) return true; // absent binding (tests, local builds) = no limit
  try {
    const results = await Promise.all(Array.from({ length: n }, () => limiter.limit({ key: sourceId })));
    return results.every((r) => r.success);
  } catch {
    return true; // a failing limiter must not take the dashboard down: fail open
  }
}

/**
 * A JSON-RPC batch is `n` requests, not one: charge the other n-1 messages to the same budget before
 * any of them runs. Returns a 429 response when the budget cannot cover them.
 */
export async function chargeExtraRequests(env: Env, source: SourceRow, extra: number): Promise<Response | null> {
  return (await spendRateLimit(env, source.kind, source.id, extra)) ? null : TOO_MANY();
}

export async function authenticateBearer(
  req: Request,
  env: Env,
  kind: "host" | "client" | "any",
  now: number,
): Promise<BearerResult> {
  const token = bearerToken(req);
  if (!token) {
    return { ok: false, response: errorJson(401, "missing bearer token", { "WWW-Authenticate": "Bearer" }) };
  }
  if (!TOKEN_RE.test(token)) {
    return { ok: false, response: errorJson(401, "invalid or revoked token", { "WWW-Authenticate": "Bearer" }) };
  }
  const source = await findSourceByHash(env.DB, await sha256Hex(token));
  if (!source || source.revoked) {
    return { ok: false, response: errorJson(401, "invalid or revoked token", { "WWW-Authenticate": "Bearer" }) };
  }
  if (kind !== "any" && source.kind !== kind) {
    return { ok: false, response: errorJson(403, `a '${source.kind}' token cannot call this endpoint`) };
  }
  // The source name becomes the host label / MCP namespace in keys: refuse odd rows rather than rewrite them.
  if (!HOST_RE.test(source.name)) {
    return { ok: false, response: errorJson(403, "this token's name is not a valid identifier (letters, digits, '.', '_', '-', max 64)") };
  }
  // Per-token budget, keyed by source id (Workers Rate Limiting binding; absent = no limit, e.g. in tests).
  if (!(await spendRateLimit(env, source.kind, source.id, 1))) return { ok: false, response: TOO_MANY() };
  // The CLI version the caller reports (X-Siiswell-Client), kept per source for the dashboard's "update available" note.
  // One write only when it changed; best effort (a database without migration 0013 just keeps going).
  const reported = req.headers.get(CLIENT_HEADER)?.trim() ?? "";
  if (reported && CLIENT_HEADER_RE.test(reported) && reported !== (source.client_version ?? null)) {
    try {
      await env.DB.prepare("UPDATE sources SET client_version = ? WHERE id = ?").bind(reported, source.id).run();
      source.client_version = reported;
    } catch {
      /* optional */
    }
  }
  if (source.last_seen === null || now - source.last_seen >= TOUCH_EVERY_MS[source.kind]) {
    try {
      await touchSource(env.DB, source.id, now).run();
    } catch {
      /* last_seen is best effort */
    }
  }
  return { ok: true, source };
}

// ── Cloudflare Access ────────────────────────────────────────────────────────

const JWKS_TTL_MS = 60 * 60_000;
const JWKS_REFETCH_MIN_MS = 60_000;
const CLOCK_SKEW_S = 30;

const JWKS_STALE_MAX_MS = 24 * 60 * 60_000;

interface KeyCache {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
  /** Set when the last refresh failed and the stale keys were kept. */
  lastFailureAt?: number;
}
const keyCaches = new Map<string, KeyCache>();

/** Tests only: forget cached JWKS. */
export function resetAccessCache(): void {
  keyCaches.clear();
}

export function normalizeTeamDomain(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function loadKeys(team: string, fetchImpl: FetchLike, now: number): Promise<KeyCache> {
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
  const body: unknown = await res.json();
  const keys = new Map<string, CryptoKey>();
  const list = isObj(body) && Array.isArray(body.keys) ? body.keys : [];
  for (const k of list) {
    if (!isObj(k) || typeof k.kid !== "string" || k.kty !== "RSA" || typeof k.n !== "string" || typeof k.e !== "string") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(k.kid, key);
    } catch {
      /* skip unusable key */
    }
  }
  const cache = { fetchedAt: now, keys };
  keyCaches.set(team, cache);
  return cache;
}

/**
 * Refresh the JWKS. Stale-while-error: if the refresh fails and keys were fetched less than 24 h
 * ago, keep verifying with them (Cloudflare's certs endpoint having a bad minute must not lock the
 * owner out of the dashboard); only with no usable cache does the failure surface (-> 503).
 */
async function refreshKeys(team: string, fetchImpl: FetchLike, now: number, current?: KeyCache): Promise<KeyCache> {
  try {
    return await loadKeys(team, fetchImpl, now);
  } catch (err) {
    if (current && now - current.fetchedAt < JWKS_STALE_MAX_MS) {
      current.lastFailureAt = now; // back off before the next attempt
      return current;
    }
    throw err;
  }
}

async function keyFor(team: string, kid: string, fetchImpl: FetchLike, now: number): Promise<CryptoKey | null> {
  const backedOff = (c: KeyCache) => c.lastFailureAt !== undefined && now - c.lastFailureAt < JWKS_REFETCH_MIN_MS;
  let cache = keyCaches.get(team);
  if (!cache || (now - cache.fetchedAt > JWKS_TTL_MS && !backedOff(cache))) cache = await refreshKeys(team, fetchImpl, now, cache);
  const hit = cache.keys.get(kid);
  if (hit) return hit;
  // Unknown kid: Cloudflare rotates signing keys, so refetch once (rate limited).
  if (now - cache.fetchedAt >= JWKS_REFETCH_MIN_MS && !backedOff(cache)) {
    cache = await refreshKeys(team, fetchImpl, now, cache);
    return cache.keys.get(kid) ?? null;
  }
  return null;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type AccessVerdict =
  | { ok: true; identity: string }
  | { ok: false; reason: "no-jwt" | "malformed" | "alg" | "kid" | "signature" | "aud" | "iss" | "exp" | "nbf" | "email" | "config" | "certs-unavailable" };

/** Verify a Cloudflare Access JWT. Pure apart from the (injectable, cached) JWKS fetch. */
export async function verifyAccessJwt(
  token: string | null,
  env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD"> & { ACCESS_ALLOWED_EMAILS?: string },
  now: number,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<AccessVerdict> {
  const team = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN ?? "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!team || !aud) return { ok: false, reason: "config" };
  if (!token) return { ok: false, reason: "no-jwt" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  let sig: Uint8Array;
  try {
    header = parseJson(b64urlDecode(h));
    payload = parseJson(b64urlDecode(p));
    sig = b64urlDecode(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isObj(header) || !isObj(payload)) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string") return { ok: false, reason: "kid" };

  let key: CryptoKey | null;
  try {
    key = await keyFor(team, header.kid, fetchImpl, now);
  } catch {
    return { ok: false, reason: "certs-unavailable" };
  }
  if (!key) return { ok: false, reason: "kid" };

  const okSig = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, utf8(`${h}.${p}`));
  if (!okSig) return { ok: false, reason: "signature" };

  const nowS = Math.floor(now / 1000);
  const audClaim = payload.aud;
  const audList = Array.isArray(audClaim) ? audClaim : typeof audClaim === "string" ? [audClaim] : [];
  if (!audList.includes(aud)) return { ok: false, reason: "aud" };
  if (payload.iss !== `https://${team}`) return { ok: false, reason: "iss" };
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S <= nowS) return { ok: false, reason: "exp" };
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowS) return { ok: false, reason: "nbf" };

  // Optional allow-list: any valid Access identity passes unless ACCESS_ALLOWED_EMAILS names who may.
  const allowed = (env.ACCESS_ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowed.length) {
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email || !allowed.includes(email)) return { ok: false, reason: "email" };
  }
  const identity =
    (typeof payload.email === "string" && payload.email) ||
    (typeof payload.common_name === "string" && payload.common_name) ||
    (typeof payload.sub === "string" && payload.sub) ||
    "access-user";
  return { ok: true, identity };
}

export function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/**
 * True for a browser request that did not come from this dashboard's own page: a `Sec-Fetch-Site` other than
 * `same-origin` / `none` (so `cross-site` AND `same-site`: a sibling subdomain is not the dashboard, and a hijacked
 * one must not read it), or an `Origin` header that is not this dashboard's (PUBLIC_URL's origin; on a localhost
 * request also its own origin, for `wrangler dev`). `none` is a user-typed / bookmarked navigation. Requests with
 * neither header (curl, the Access service tokens, same-origin GETs, which browsers send without Origin) pass.
 * The Access cookie rides along with a request a hostile page makes, so the Worker's own answer must refuse: the
 * browser API (`/api/state`, `/api/push/*`) never sends `Access-Control-Allow-*` headers either, so a cross-origin
 * page could not read it even when the request went out.
 */
export function isCrossSiteRequest(req: Request, env: Pick<Env, "PUBLIC_URL">): boolean {
  const site = (req.headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
  if (site !== "" && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  try {
    if (origin === new URL(env.PUBLIC_URL).origin) return false;
  } catch {
    /* PUBLIC_URL unset or unparsable: no origin matches it */
  }
  const own = new URL(req.url);
  return !(isLocalHostname(own.hostname) && origin === own.origin);
}

export type AccessResult = { ok: true; identity: string } | { ok: false; response: Response };

/**
 * Gate for the Access-protected routes (/api/state, /api/push/*).
 * - ACCESS_TEAM_DOMAIN empty: allowed only with DEV_NO_ACCESS=1 on a localhost request, else 403 + hint.
 * - Otherwise a valid `Cf-Access-Jwt-Assertion` is required.
 */
export async function requireAccess(
  req: Request,
  env: Env,
  now: number,
  fetchImpl?: FetchLike,
): Promise<AccessResult> {
  const team = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN ?? "");
  if (!team) {
    const local = isLocalHostname(new URL(req.url).hostname);
    if (env.DEV_NO_ACCESS === "1" && local) return { ok: true, identity: "dev" };
    return {
      ok: false,
      response: errorJson(
        403,
        "Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.toml " +
          "(or DEV_NO_ACCESS=1 in .dev.vars for localhost development)",
      ),
    };
  }
  const verdict = await verifyAccessJwt(req.headers.get("cf-access-jwt-assertion"), env, now, fetchImpl);
  if (verdict.ok) return { ok: true, identity: verdict.identity };
  if (verdict.reason === "certs-unavailable") return { ok: false, response: errorJson(503, "access certificates unavailable") };
  if (verdict.reason === "config") {
    return { ok: false, response: errorJson(403, "ACCESS_AUD is not configured") };
  }
  return { ok: false, response: errorJson(403, "access denied") };
}
