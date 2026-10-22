import { beforeEach, describe, expect, test } from "bun:test";
import { TOKEN_RE, authenticateBearer, bearerToken, requireAccess, resetAccessCache, verifyAccessJwt } from "../src/auth";
import { route } from "../src/index";
import { b64urlEncode, utf8 } from "../src/util";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

const NOW = 1_800_000_000_000;
const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-tag-123";

interface Rsa {
  privateKey: CryptoKey;
  jwk: JsonWebKey;
}

async function rsaKey(): Promise<Rsa> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return { privateKey: pair.privateKey, jwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey };
}

async function makeJwt(
  key: Rsa,
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string } = {},
): Promise<string> {
  const h = b64urlEncode(utf8(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "kid-1", typ: "JWT" })));
  const p = b64urlEncode(utf8(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, utf8(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000) - 10,
  email: "alice@example.com",
  ...over,
});

function jwksFetch(keys: Array<{ kid: string; jwk: JsonWebKey }>) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ keys: keys.map((k) => ({ ...k.jwk, kid: k.kid, alg: "RS256", use: "sig" })) }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return { f, calls };
}

beforeEach(() => resetAccessCache());

describe("bearer tokens", () => {
  test("parses the Authorization header strictly", () => {
    const h = (v?: string) => new Request("http://x/", { headers: v ? { Authorization: v } : {} });
    expect(bearerToken(h("Bearer oct_abcdefghij"))).toBe("oct_abcdefghij");
    expect(bearerToken(h("bearer oct_abcdefghij"))).toBe("oct_abcdefghij");
    expect(bearerToken(h("Basic abc"))).toBeNull();
    expect(bearerToken(h("Bearer two words here"))).toBeNull();
    expect(bearerToken(h())).toBeNull();
  });

  test("only the exact shape new-token.ts mints (oct_ + 43 base64url chars) is looked up; junk costs no D1 read", async () => {
    const good = `oct_${"A".repeat(43)}`;
    expect(TOKEN_RE.test(good)).toBe(true);
    for (const bad of ["oct_short", `oct_${"A".repeat(42)}`, `oct_${"A".repeat(44)}`, `oct_${"A".repeat(42)}!`, `OCT_${"A".repeat(43)}`, `sk_${"A".repeat(43)}`, `oct_${"A".repeat(43)} `.trim() + "=", "x".repeat(500)]) {
      expect(TOKEN_RE.test(bad)).toBe(false);
    }
    const { env, db } = makeEnv();
    await addSource(db, "h", "host");
    db.statements.length = 0;
    for (const junk of ["oct_short", `oct_${"A".repeat(44)}`, "Bearer-ish", "x".repeat(500)]) {
      const r = await authenticateBearer(request("/x", { token: junk }), env, "host", NOW);
      expect(r.ok === false && r.response.status).toBe(401);
    }
    expect(db.statements).toEqual([]); // not a single statement was issued
    // a well-formed but unknown token does reach the database (one lookup) and is also a 401
    const unknown = await authenticateBearer(request("/x", { token: good }), env, "host", NOW);
    expect(unknown.ok === false && unknown.response.status).toBe(401);
    expect(db.statements).toHaveLength(1);
  });

  test("kind must match the route and revoked tokens are refused", async () => {
    const { env, db } = makeEnv();
    const host = await addSource(db, "h", "host");
    const client = await addSource(db, "c", "client");
    const dead = await addSource(db, "dead", "client", { revoked: true });
    const req = (token: string) => request("/x", { token });
    expect((await authenticateBearer(req(host), env, "host", NOW)).ok).toBe(true);
    const wrong = await authenticateBearer(req(host), env, "client", NOW);
    expect(wrong.ok === false && wrong.response.status).toBe(403);
    expect((await authenticateBearer(req(client), env, "client", NOW)).ok).toBe(true);
    const revoked = await authenticateBearer(req(dead), env, "client", NOW);
    expect(revoked.ok === false && revoked.response.status).toBe(401);
    expect(revoked.ok === false && revoked.response.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("last_seen is written at most every 30 s for client tokens and every 5 min for host tokens (their liveness lives in `hosts`)", async () => {
    const { env, db } = makeEnv();
    const seen = (name: string) => db.rows<{ last_seen: number }>("SELECT last_seen FROM sources WHERE name = ?", name)[0]?.last_seen;
    const client = await addSource(db, "c", "client");
    await authenticateBearer(request("/x", { token: client }), env, "client", NOW);
    expect(seen("c")).toBe(NOW);
    await authenticateBearer(request("/x", { token: client }), env, "client", NOW + 10_000);
    expect(seen("c")).toBe(NOW);
    await authenticateBearer(request("/x", { token: client }), env, "client", NOW + 31_000);
    expect(seen("c")).toBe(NOW + 31_000);

    const host = await addSource(db, "h", "host");
    await authenticateBearer(request("/x", { token: host }), env, "host", NOW);
    expect(seen("h")).toBe(NOW);
    await authenticateBearer(request("/x", { token: host }), env, "host", NOW + 4 * 60_000);
    expect(seen("h")).toBe(NOW);
    await authenticateBearer(request("/x", { token: host }), env, "host", NOW + 5 * 60_000);
    expect(seen("h")).toBe(NOW + 5 * 60_000);
  });

  test("a source whose name is not a plain identifier is refused (its name would end up in keys)", async () => {
    const { env, db } = makeEnv();
    const token = await addSource(db, "bad|name", "client");
    const r = await authenticateBearer(request("/x", { token }), env, "client", NOW);
    expect(r.ok === false && r.response.status).toBe(403);
  });

  describe("per-token rate limiting (Workers Rate Limiting binding, keyed by source id)", () => {
    const limiter = (allow: () => boolean | Promise<boolean>) => {
      const keys: string[] = [];
      return { keys, binding: { limit: async (o: { key: string }) => { keys.push(o.key); return { success: await allow() }; } } };
    };

    test("429 with Retry-After once the budget is spent; the key is the source id", async () => {
      const host = limiter(() => true);
      const client = limiter(() => false);
      const { env, db } = makeEnv({ RATE_LIMIT_HOST: host.binding, RATE_LIMIT_CLIENT: client.binding });
      const h = await addSource(db, "h", "host");
      const c = await addSource(db, "c", "client");
      expect((await authenticateBearer(request("/x", { token: h }), env, "host", NOW)).ok).toBe(true);
      const limited = await authenticateBearer(request("/x", { token: c }), env, "client", NOW);
      expect(limited.ok).toBe(false);
      if (limited.ok) return;
      expect(limited.response.status).toBe(429);
      expect(limited.response.headers.get("retry-after")).toBe("60");
      expect(host.keys).toEqual(["src-h"]);
      expect(client.keys).toEqual(["src-c"]);
    });

    test("hosts and clients use their own bindings; a failing limiter fails open; no binding = no limit", async () => {
      const only = limiter(() => false);
      const { env, db } = makeEnv({ RATE_LIMIT_CLIENT: only.binding });
      const h = await addSource(db, "h", "host");
      expect((await authenticateBearer(request("/x", { token: h }), env, "host", NOW)).ok).toBe(true); // host binding absent
      const broken = makeEnv({ RATE_LIMIT_HOST: { limit: async () => { throw new Error("limiter down"); } } });
      const h2 = await addSource(broken.db, "h", "host");
      expect((await authenticateBearer(request("/x", { token: h2 }), broken.env, "host", NOW)).ok).toBe(true);
    });

    test("end to end: ingest and /mcp answer 429 without touching the database", async () => {
      const t = makeEnv({ RATE_LIMIT_HOST: { limit: async () => ({ success: false }) }, RATE_LIMIT_CLIENT: { limit: async () => ({ success: false }) } });
      const h = await addSource(t.db, "hosta", "host");
      const c = await addSource(t.db, "codex", "client");
      const ctx = makeCtx();
      const ing = await route(request("/api/ingest/heartbeat", { token: h, body: { v: 1, host: "hosta", at: NOW } }), t.env, ctx, { now: NOW });
      expect(ing.status).toBe(429);
      const mcp = await route(request("/mcp", { token: c, body: { jsonrpc: "2.0", id: 1, method: "ping" } }), t.env, ctx, { now: NOW });
      expect(mcp.status).toBe(429);
      expect(t.db.rows("SELECT * FROM hosts")).toEqual([]);
    });
  });
});

describe("Cloudflare Access JWT", () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

  test("a valid token verifies and yields the identity", async () => {
    const key = await rsaKey();
    const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    const v = await verifyAccessJwt(await makeJwt(key, goodClaims()), env, NOW, f);
    expect(v).toEqual({ ok: true, identity: "alice@example.com" });
  });

  test("wrong audience, wrong issuer and expired tokens are refused", async () => {
    const key = await rsaKey();
    const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    const verdict = async (claims: Record<string, unknown>) => verifyAccessJwt(await makeJwt(key, claims), env, NOW, f);
    expect(await verdict(goodClaims({ aud: ["someone-else"] }))).toEqual({ ok: false, reason: "aud" });
    expect(await verdict(goodClaims({ aud: AUD }))).toMatchObject({ ok: true }); // string aud also accepted
    expect(await verdict(goodClaims({ iss: "https://evil.cloudflareaccess.com" }))).toEqual({ ok: false, reason: "iss" });
    expect(await verdict(goodClaims({ exp: Math.floor(NOW / 1000) - 3600 }))).toEqual({ ok: false, reason: "exp" });
    expect(await verdict(goodClaims({ exp: undefined }))).toEqual({ ok: false, reason: "exp" });
    expect(await verdict(goodClaims({ nbf: Math.floor(NOW / 1000) + 3600 }))).toEqual({ ok: false, reason: "nbf" });
  });

  test("a token signed by another key, an unknown kid and alg confusion are refused", async () => {
    const key = await rsaKey();
    const attacker = await rsaKey();
    const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    expect(await verifyAccessJwt(await makeJwt(attacker, goodClaims()), env, NOW, f)).toEqual({ ok: false, reason: "signature" });
    expect(await verifyAccessJwt(await makeJwt(key, goodClaims(), { kid: "nope" }), env, NOW, f)).toEqual({ ok: false, reason: "kid" });
    expect(await verifyAccessJwt(await makeJwt(key, goodClaims(), { alg: "none" }), env, NOW, f)).toEqual({ ok: false, reason: "alg" });
    expect(await verifyAccessJwt(await makeJwt(key, goodClaims(), { alg: "HS256" }), env, NOW, f)).toEqual({ ok: false, reason: "alg" });
    expect(await verifyAccessJwt("not.a.jwt", env, NOW, f)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAccessJwt("only-one-part", env, NOW, f)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAccessJwt(null, env, NOW, f)).toEqual({ ok: false, reason: "no-jwt" });
    // tampered payload keeps the old signature
    const jwt = await makeJwt(key, goodClaims());
    const [h, , s] = jwt.split(".") as [string, string, string];
    const forged = `${h}.${b64urlEncode(utf8(JSON.stringify(goodClaims({ email: "attacker@example.com" }))))}.${s}`;
    expect(await verifyAccessJwt(forged, env, NOW, f)).toEqual({ ok: false, reason: "signature" });
  });

  test("the JWKS is cached for an hour and refetched once for an unknown kid (key rotation)", async () => {
    const k1 = await rsaKey();
    const k2 = await rsaKey();
    let keys = [{ kid: "kid-1", jwk: k1.jwk }];
    const calls: number[] = [];
    const f = async () => {
      calls.push(1);
      return new Response(JSON.stringify({ keys: keys.map((k) => ({ ...k.jwk, kid: k.kid })) }));
    };
    const jwt1 = await makeJwt(k1, goodClaims());
    await verifyAccessJwt(jwt1, env, NOW, f);
    await verifyAccessJwt(jwt1, env, NOW + 5 * 60_000, f);
    expect(calls).toHaveLength(1);
    // rotation: kid-2 appears; unknown kid triggers a refetch (cache is older than the 60 s floor)
    keys = [{ kid: "kid-1", jwk: k1.jwk }, { kid: "kid-2", jwk: k2.jwk }];
    const jwt2 = await makeJwt(k2, goodClaims(), { kid: "kid-2" });
    expect(await verifyAccessJwt(jwt2, env, NOW + 5 * 60_000 + 61_000, f)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    // an hour later the cache expires on its own
    await verifyAccessJwt(jwt1, env, NOW + 2 * 3600_000, f);
    expect(calls).toHaveLength(3);
  });

  test("unknown kids cannot be used to hammer the certs endpoint", async () => {
    const key = await rsaKey();
    const { f, calls } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    await verifyAccessJwt(await makeJwt(key, goodClaims()), env, NOW, f);
    for (let i = 0; i < 5; i++) await verifyAccessJwt(await makeJwt(key, goodClaims(), { kid: `x${i}` }), env, NOW + i * 1000, f);
    expect(calls).toHaveLength(1);
  });

  test("a team domain given with scheme/trailing slash is normalised", async () => {
    const key = await rsaKey();
    const { f, calls } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    const v = await verifyAccessJwt(await makeJwt(key, goodClaims()), { ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD }, NOW, f);
    expect(v).toMatchObject({ ok: true });
    expect(calls[0]).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  test("missing ACCESS_AUD is a configuration error, not an open door", async () => {
    const key = await rsaKey();
    const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    expect(await verifyAccessJwt(await makeJwt(key, goodClaims()), { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "" }, NOW, f)).toEqual({ ok: false, reason: "config" });
  });

  describe("ACCESS_ALLOWED_EMAILS (optional allow-list on top of the Access policy)", () => {
    const withList = (list: string | undefined) => ({ ...env, ACCESS_ALLOWED_EMAILS: list });
    test("unset or blank = any identity Access let through (the default)", async () => {
      const key = await rsaKey();
      const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
      const jwt = await makeJwt(key, goodClaims({ email: "anyone@example.org" }));
      for (const list of [undefined, "", "  ", " , "]) expect(await verifyAccessJwt(jwt, withList(list), NOW, f)).toMatchObject({ ok: true });
    });

    test("a listed e-mail passes (comma list, spaces and case ignored); any other e-mail is refused", async () => {
      const key = await rsaKey();
      const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
      const verdict = async (email: string, list: string) => verifyAccessJwt(await makeJwt(key, goodClaims({ email })), withList(list), NOW, f);
      expect(await verdict("alice@example.com", "alice@example.com")).toEqual({ ok: true, identity: "alice@example.com" });
      expect(await verdict("Alice@Example.COM", " ops@example.com , ALICE@example.com ")).toMatchObject({ ok: true });
      expect(await verdict("mallory@example.com", "alice@example.com,ops@example.com")).toEqual({ ok: false, reason: "email" });
      expect(await verdict("alice@example.com.evil.io", "alice@example.com")).toEqual({ ok: false, reason: "email" }); // exact match only
      expect(await verdict("xalice@example.com", "alice@example.com")).toEqual({ ok: false, reason: "email" });
    });

    test("a token without an e-mail claim (a service token: only common_name) never matches a configured list", async () => {
      const key = await rsaKey();
      const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
      const jwt = await makeJwt(key, goodClaims({ email: undefined, common_name: "svc-token" }));
      expect(await verifyAccessJwt(jwt, withList("alice@example.com"), NOW, f)).toEqual({ ok: false, reason: "email" });
      expect(await verifyAccessJwt(jwt, withList(undefined), NOW, f)).toMatchObject({ ok: true }); // without a list it is the Access policy's call
    });

    test("end to end: requireAccess answers 403 'access denied' (no hint about who is allowed) for a valid JWT of someone else", async () => {
      const key = await rsaKey();
      const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
      const { env: e } = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ALLOWED_EMAILS: "ops@example.com" });
      const jwt = await makeJwt(key, goodClaims());
      const r = await requireAccess(request("/api/state", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), e, NOW, f);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.response.status).toBe(403);
      const text = JSON.stringify(await r.response.json());
      expect(text).toContain("access denied");
      expect(text).not.toContain("ops@example.com");
    });
  });
});

describe("requireAccess / DEV_NO_ACCESS", () => {
  test("team domain empty: DEV_NO_ACCESS=1 on localhost is allowed", async () => {
    const { env } = makeEnv({ ACCESS_TEAM_DOMAIN: "", DEV_NO_ACCESS: "1" });
    expect(await requireAccess(request("/api/state"), env, NOW)).toEqual({ ok: true, identity: "dev" });
    expect(await requireAccess(request("/api/state", { base: "http://127.0.0.1:8787" }), env, NOW)).toMatchObject({ ok: true });
  });

  test("team domain empty without DEV_NO_ACCESS: 403 with a hint", async () => {
    const { env } = makeEnv({ ACCESS_TEAM_DOMAIN: "", DEV_NO_ACCESS: undefined });
    const r = await requireAccess(request("/api/state"), env, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(403);
    expect(((await r.response.json()) as { error: string }).error).toContain("ACCESS_TEAM_DOMAIN");
  });

  test("DEV_NO_ACCESS=1 on a non-localhost host is still refused (guards a stray prod var)", async () => {
    const { env } = makeEnv({ ACCESS_TEAM_DOMAIN: "", DEV_NO_ACCESS: "1" });
    const r = await requireAccess(request("/api/state", { base: "https://dash.example.com" }), env, NOW);
    expect(r.ok).toBe(false);
  });

  test("with a team domain DEV_NO_ACCESS is ignored and a JWT is required", async () => {
    const key = await rsaKey();
    const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    const { env } = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEV_NO_ACCESS: "1" });
    const none = await requireAccess(request("/api/state"), env, NOW, f);
    expect(none.ok === false && none.response.status).toBe(403);
    const jwt = await makeJwt(key, goodClaims());
    const ok = await requireAccess(request("/api/state", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env, NOW, f);
    expect(ok).toEqual({ ok: true, identity: "alice@example.com" });
  });

  test("an unreachable certs endpoint is a 503, not a 403 or an open door", async () => {
    const key = await rsaKey();
    const { env } = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
    const jwt = await makeJwt(key, goodClaims());
    const r = await requireAccess(request("/api/state", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env, NOW, async () => new Response("nope", { status: 500 }));
    expect(r.ok === false && r.response.status).toBe(503);
  });
});

describe("router: which routes are behind which check", () => {
  test("/api/state and /api/push/* need Access; /api/ingest/* and /mcp need bearer tokens; /api/health is open", async () => {
    const { env } = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEV_NO_ACCESS: undefined });
    const ctx = makeCtx();
    const call = (path: string, init: Parameters<typeof request>[1] = {}) => route(request(path, init), env, ctx, { now: NOW, fetch: async () => new Response("{}", { status: 500 }) });
    expect((await call("/api/state")).status).toBe(403);
    expect((await call("/api/push/key")).status).toBe(403);
    expect((await call("/api/push/subscribe", { body: {} })).status).toBe(403);
    expect((await call("/api/ingest/snapshot", { body: {} })).status).toBe(401);
    expect((await call("/mcp", { body: {} })).status).toBe(401);
    expect((await call("/api/health")).status).toBe(200);
    expect((await call("/api/nope")).status).toBe(404);
    expect(await (await call("/index.html")).text()).toBe("asset"); // falls through to static assets
  });
});

describe("path traversal / normalisation tricks never reach /api/state without a valid Access JWT", () => {
  const PATHS = [
    "/api/ingest/%2e%2e/state",
    "/api/ingest/%2E%2E/state",
    "/api/ingest/.%2e/state",
    "/api/ingest/%2e./state",
    "/api/ingest/..%2fstate",
    "/api/ingest/%2e%2e%2fstate",
    "/api/ingest/%252e%252e/state",
    "/api/ingest/./../state",
    "/api/ingest/../state",
    "/api/ingest//../state",
    "/api/ingest/..;/state",
    "/api/ingest/..%5cstate",
    "/mcp/../api/state",
    "/mcp/%2e%2e/api/state",
    "/api/ingest/%2e%2e/push/key",
    "/api/push/%2e%2e/state",
    "/api/state%2f",
    "/api/state%00",
    "//api/state",
    "/api/state/.",
    "/api/./state",
    "/API/state",
  ];

  function setup() {
    const t = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEV_NO_ACCESS: undefined });
    t.db.sqlite.query("INSERT INTO hosts (host, last_seen) VALUES ('secret-host', ?)").run(NOW);
    return t;
  }

  /** What the Worker sees when the platform forwards the path verbatim (Request would pre-normalise it). */
  function rawRequest(path: string, headers: Record<string, string> = {}): Request {
    const req = new Request("http://localhost:8787/api/health", { headers });
    Object.defineProperty(req, "url", { value: `http://localhost:8787${path}` });
    return req;
  }

  test("verbatim paths: never state data, with no credentials and with a valid host bearer token", async () => {
    const { env, db } = setup();
    const host = await addSource(db, "hosta", "host");
    const ctx = makeCtx();
    for (const path of PATHS) {
      for (const headers of [{}, { Authorization: `Bearer ${host}` }, { Authorization: `Bearer ${host}`, Origin: "https://dash.test" }]) {
        const res = await route(rawRequest(path, headers), env, ctx, { now: NOW, fetch: async () => new Response("{}", { status: 500 }) });
        const body = await res.text();
        expect(body).not.toContain("secret-host");
        expect(body).not.toContain('"inbox"');
        expect([400, 401, 403, 404, 405, 200]).toContain(res.status);
        if (res.status === 200) expect(body).toBe("asset"); // only ever the static-asset fallback
      }
    }
  });

  test("the same paths through URL normalisation (what a plain Request does) are also refused or authenticated", async () => {
    const { env, db } = setup();
    const host = await addSource(db, "hosta", "host");
    const ctx = makeCtx();
    for (const path of PATHS) {
      for (const token of [undefined, host]) {
        const res = await route(new Request(`http://localhost:8787${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), env, ctx, { now: NOW, fetch: async () => new Response("{}", { status: 500 }) });
        const body = await res.text();
        expect(body).not.toContain("secret-host");
        expect(body).not.toContain('"inbox"');
        expect(res.status === 200 ? body : "asset").toBe("asset");
      }
    }
    // the plain path is behind Access: 403 without a JWT even though a bearer token is present
    const plain = await route(request("/api/state", { token: host }), env, ctx, { now: NOW });
    expect(plain.status).toBe(403);
  });

  test("ambiguous raw paths are a 400 before any routing; query strings and ordinary paths are untouched", async () => {
    const { env } = setup();
    const ctx = makeCtx();
    for (const path of ["/api/ingest/%2e%2e/state", "/a//b", "/x/%2F/y", "/%5c", "/api/./state"]) {
      expect((await route(rawRequest(path), env, ctx, { now: NOW })).status).toBe(400);
    }
    expect((await route(rawRequest("/api/health?next=/a//b%2e%2e"), env, ctx, { now: NOW })).status).toBe(200);
    expect((await route(rawRequest("/api/health#/a//b"), env, ctx, { now: NOW })).status).toBe(200);
    expect((await route(request("/mcp/"), env, ctx, { now: NOW })).status).not.toBe(400);
  });

  test("with a valid JWT the real state route still works (the guard does not break the happy path)", async () => {
    const key = await rsaKey();
    const { f } = jwksFetch([{ kid: "kid-1", jwk: key.jwk }]);
    const { env } = setup();
    const res = await route(request("/api/state", { headers: { "Cf-Access-Jwt-Assertion": await makeJwt(key, goodClaims()) } }), env, makeCtx(), { now: NOW, fetch: f });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("secret-host");
  });
});

describe("JWKS stale-while-error", () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  const H = 3600_000;

  function flaky(key: Rsa) {
    let up = true;
    let calls = 0;
    const f = async () => {
      calls++;
      if (!up) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ keys: [{ ...key.jwk, kid: "kid-1" }] }));
    };
    return { f, calls: () => calls, setUp: (v: boolean) => { up = v; } };
  }

  test("an expired cache whose refresh fails keeps verifying with the cached keys (up to 24 h)", async () => {
    const key = await rsaKey();
    const net = flaky(key);
    const jwt = await makeJwt(key, goodClaims({ exp: Math.floor((NOW + 30 * H) / 1000) }));
    expect((await verifyAccessJwt(jwt, env, NOW, net.f)).ok).toBe(true); // primes the cache
    net.setUp(false);
    expect((await verifyAccessJwt(jwt, env, NOW + 2 * H, net.f)).ok).toBe(true); // TTL (1 h) expired, refresh fails: stale keys used
    expect((await verifyAccessJwt(jwt, env, NOW + 23 * H, net.f)).ok).toBe(true);
    // ...but never beyond 24 h since the last good fetch
    const dead = await verifyAccessJwt(jwt, env, NOW + 25 * H, net.f);
    expect(dead).toEqual({ ok: false, reason: "certs-unavailable" });
    // and Access answers 503 (not 403) for that case
    const { env: e } = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
    const r = await requireAccess(request("/api/state", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), e, NOW + 26 * H, net.f);
    expect(r.ok === false && r.response.status).toBe(503);
  });

  test("while refreshes fail the certs endpoint is retried at most once a minute", async () => {
    const key = await rsaKey();
    const net = flaky(key);
    const jwt = await makeJwt(key, goodClaims({ exp: Math.floor((NOW + 30 * H) / 1000) }));
    await verifyAccessJwt(jwt, env, NOW, net.f);
    net.setUp(false);
    const base = net.calls();
    for (let i = 0; i < 20; i++) await verifyAccessJwt(jwt, env, NOW + 2 * H + i * 1000, net.f);
    expect(net.calls() - base).toBe(1);
    await verifyAccessJwt(jwt, env, NOW + 2 * H + 61_000, net.f);
    expect(net.calls() - base).toBe(2);
    // recovery: once the endpoint answers again the cache is replaced and the backoff is gone
    net.setUp(true);
    await verifyAccessJwt(jwt, env, NOW + 2 * H + 130_000, net.f);
    expect(net.calls() - base).toBe(3);
    await verifyAccessJwt(jwt, env, NOW + 2 * H + 131_000, net.f);
    expect(net.calls() - base).toBe(3);
  });

  test("an unknown kid during an outage is a plain 'kid' failure, not a lockout of known keys", async () => {
    const key = await rsaKey();
    const net = flaky(key);
    const good = await makeJwt(key, goodClaims({ exp: Math.floor((NOW + 30 * H) / 1000) }));
    await verifyAccessJwt(good, env, NOW, net.f);
    net.setUp(false);
    expect(await verifyAccessJwt(await makeJwt(key, goodClaims(), { kid: "rotated" }), env, NOW + 5 * 60_000, net.f)).toEqual({ ok: false, reason: "kid" });
    expect((await verifyAccessJwt(good, env, NOW + 5 * 60_000 + 1000, net.f)).ok).toBe(true);
  });

  test("with no cache at all a failing endpoint is certs-unavailable", async () => {
    const key = await rsaKey();
    const net = flaky(key);
    net.setUp(false);
    expect(await verifyAccessJwt(await makeJwt(key, goodClaims()), env, NOW, net.f)).toEqual({ ok: false, reason: "certs-unavailable" });
  });
});
