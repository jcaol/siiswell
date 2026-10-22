/**
 * The self-hosted server (src/server/*): config validation, the Bun server on 127.0.0.1 with a random port (pages,
 * assets + their headers, ingest, MCP), builtin login and trusted-proxy auth.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAuth, KNOWN_DEVICE_MS, LOGIN_GLOBAL_FAILURES_PER_MINUTE, LOGIN_MAX_AGGREGATE_FAILURES, LOGIN_MAX_FAILURES, LOGIN_RECOVERY_ATTEMPTS_PER_MINUTE, LOGIN_WINDOW_MS, MAX_FAILURE_KEYS, MAX_IP_KEYS_PER_NET, RECOVERY_RE, RECOVERY_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, passwordFingerprint } from "../src/server/auth";
import { parseHeadersFile, startServer, type RunningServer } from "../src/server/bun";
import { defaultDbPath, loadConfig, type ServerConfig } from "../src/server/config";
import { SqliteD1 } from "../src/server/d1-sqlite";
import { clientIp, ipInCidrs, parseCidrs, rateBucket, rateKeys } from "../src/server/net";
import { sha256Hex } from "../src/util";
import { addSource, snapshot, type D1Shim } from "./d1-shim";

const PASSWORD = "correct horse battery staple";
/** Cheap hash for speed (the server refuses it in configuration, see cfgFor) and a production-cost one for config tests. */
const HASH = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });
const STRONG_HASH = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
const dirs: string[] = [];
const servers: RunningServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function cfgFor(env: Record<string, string>): ServerConfig {
  const dir = mkdtempSync(join(tmpdir(), "siiswell-srv-"));
  dirs.push(dir);
  const r = loadConfig({ PUBLIC_URL: "http://localhost:8787", BIND: "127.0.0.1", PORT: "1", DATA_DIR: dir, ADMIN_PASSWORD_HASH: STRONG_HASH, TICKER_ENABLED: "0", ...env });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { ...r.config, port: 0, adminPasswordHash: HASH };
}

function boot(env: Record<string, string> = {}): RunningServer {
  const s = startServer(cfgFor(env), { RULES_MIN_INTERVAL_MS: "0", OPPORTUNISTIC_MAINTENANCE: "0" });
  servers.push(s);
  return s;
}

const ORIGIN = { Origin: "http://localhost:8787" };
const get = (s: RunningServer, path: string, headers: Record<string, string> = {}) => fetch(`${s.url}${path}`, { headers, redirect: "manual" });
const login = (s: RunningServer, password = PASSWORD, headers: Record<string, string> = ORIGIN) =>
  fetch(`${s.url}/auth/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ password }).toString() });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

describe("database file name", () => {
  test("siiswell.sqlite, or the pre-rename orch-dash.sqlite while only that exists", () => {
    const has = (...files: string[]) => (p: string) => files.includes(p);
    expect(defaultDbPath("/data", has())).toBe("/data/siiswell.sqlite");
    expect(defaultDbPath("/data", has("/data/orch-dash.sqlite"))).toBe("/data/orch-dash.sqlite");
    expect(defaultDbPath("/data", has("/data/orch-dash.sqlite", "/data/siiswell.sqlite"))).toBe("/data/siiswell.sqlite");
  });
});

describe("config validation", () => {
  test("lists every missing / invalid setting at once", () => {
    const r = loadConfig({ PUBLIC_URL: "http://dash.internal/x", AUTH_MODE: "proxy", RETENTION_DAYS: "zero", PORT: "70000", VAPID_PUBLIC_KEY: "abc", TICKER_ENABLED: "yes" });
    expect(r.ok).toBe(false);
    const errs = (r as { errors: string[] }).errors.join("\n");
    for (const k of ["PUBLIC_URL", "PORT", "TRUSTED_PROXY_CIDRS", "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY", "RETENTION_DAYS", "TICKER_ENABLED"]) expect(errs).toContain(k);
  });
  test("builtin needs an argon2id ADMIN_PASSWORD_HASH; the placeholder PUBLIC_URL is refused", () => {
    expect((loadConfig({ PUBLIC_URL: "https://dash.example.com" }) as { errors: string[] }).errors.join()).toMatch(/placeholder.*needs an admin password: set ADMIN_PASSWORD .* or ADMIN_PASSWORD_HASH/s);
    expect((loadConfig({ PUBLIC_URL: "https://d.example.org", ADMIN_PASSWORD_HASH: "$2b$10$x" }) as { errors: string[] }).errors.join()).toContain("argon2id");
  });
  test("a valid https setup: Secure cookies, defaults", () => {
    const r = loadConfig({ PUBLIC_URL: "https://d.example.org/", ADMIN_PASSWORD_HASH: STRONG_HASH });
    expect(r.ok && r.config).toMatchObject({ publicUrl: "https://d.example.org", secure: true, authMode: "builtin", port: 8787, bind: "127.0.0.1", dbPath: "/data/siiswell.sqlite", tickerEnabled: true });
  });
  test("proxy mode: CIDRs and ALLOWED_EMAILS parsed", () => {
    const r = loadConfig({ PUBLIC_URL: "https://d.example.org", AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "172.28.0.10/32, ::1", ALLOWED_EMAILS: "A@x.org" });
    expect(r.ok && r.config.allowedEmails).toEqual(["a@x.org"]);
    expect(loadConfig({ PUBLIC_URL: "https://d.example.org", AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "10.0.0.0/33" }).ok).toBe(false);
  });
});

test("both modes refuse trusted CIDRs wider than /24 (v4) or /64 (v6) unless ALLOW_WIDE_PROXY_CIDR=1", () => {
  const base = { PUBLIC_URL: "https://d.example.org", AUTH_MODE: "proxy" };
  for (const wide of ["172.16.0.0/12", "10.0.0.0/23", "fd00::/48", "::ffff:0:0/96", "0.0.0.0/0"]) {
    const r = loadConfig({ ...base, TRUSTED_PROXY_CIDRS: `172.28.0.10/32, ${wide}` });
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors.join()).toContain(`trust far more than one proxy: ${wide}.`);
    expect(loadConfig({ ...base, TRUSTED_PROXY_CIDRS: wide, ALLOW_WIDE_PROXY_CIDR: "1" }).ok).toBe(true);
  }
  for (const narrow of ["172.28.0.0/24", "172.28.0.10", "fd00:1:2:3::/64", "::1"]) expect(loadConfig({ ...base, TRUSTED_PROXY_CIDRS: narrow }).ok).toBe(true);
  // builtin mode too: a spoofable X-Forwarded-For would bypass the per-client login cap
  const builtin = { PUBLIC_URL: "https://d.example.org", ADMIN_PASSWORD_HASH: STRONG_HASH };
  expect((loadConfig({ ...builtin, TRUSTED_PROXY_CIDRS: "10.0.0.0/8" }) as { errors: string[] }).errors.join()).toContain("trust far more than one proxy");
  expect(loadConfig({ ...builtin, TRUSTED_PROXY_CIDRS: "10.0.0.0/8", ALLOW_WIDE_PROXY_CIDR: "1" }).ok).toBe(true);
  expect(loadConfig({ ...builtin, TRUSTED_PROXY_CIDRS: "172.28.0.10/32" }).ok).toBe(true);
});

describe("net helpers", () => {
  test("CIDR matching for IPv4, IPv6 and IPv4-mapped IPv6", () => {
    const c = (parseCidrs("10.0.0.0/8,fd00::/8,127.0.0.1") as { cidrs: never[] }).cidrs;
    expect(ipInCidrs("10.1.2.3", c)).toBe(true);
    expect(ipInCidrs("::ffff:10.9.9.9", c)).toBe(true);
    expect(ipInCidrs("fd12::1", c)).toBe(true);
    expect(ipInCidrs("11.0.0.1", c)).toBe(false);
    expect(ipInCidrs("127.0.0.2", c)).toBe(false);
    expect(ipInCidrs("garbage", c)).toBe(false);
  });
  test("X-Forwarded-For is believed only from a trusted peer, right-most untrusted hop", () => {
    const c = (parseCidrs("10.0.0.0/8") as { cidrs: never[] }).cidrs;
    expect(clientIp("10.0.0.5", "6.6.6.6, 1.2.3.4, 10.0.0.9", c)).toBe("1.2.3.4");
    expect(clientIp("8.8.8.8", "1.2.3.4", c)).toBe("8.8.8.8");
  });
});

describe("Bun server (builtin auth)", () => {
  const s = boot();
  test("health is open; pages redirect to the login page; the browser API is 401 without a session", async () => {
    expect(await (await get(s, "/api/health")).json()).toMatchObject({ ok: true });
    const page = await get(s, "/");
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/auth/login");
    expect((await get(s, "/api/state")).status).toBe(401);
    const lp = await get(s, "/auth/login");
    expect(lp.status).toBe(200);
    expect(lp.headers.get("content-security-policy")).toContain("form-action 'self'");
  });

  test("Chrome's real login POST: Origin null + Sec-Fetch-Site same-origin is accepted; any cross-site form is refused", async () => {
    // the login / logout pages must not use no-referrer (Chrome would then send Origin: null)
    expect((await get(s, "/auth/login")).headers.get("referrer-policy")).toBe("same-origin");
    for (const [headers, want] of [
      [{ Origin: "null", "Sec-Fetch-Site": "same-origin" }, 303],
      [{ "Sec-Fetch-Site": "same-origin" }, 303],
      [{ Origin: "null", "Sec-Fetch-Site": "cross-site" }, 403],
      [{ Origin: "null", "Sec-Fetch-Site": "same-site" }, 403],
      [{ Origin: "null", "Sec-Fetch-Site": "none" }, 403],
      [{ Origin: "null" }, 403],
      [{}, 403],
      [{ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }, 403],
    ] as Array<[Record<string, string>, number]>) {
      expect([JSON.stringify(headers), (await login(s, PASSWORD, headers)).status]).toEqual([JSON.stringify(headers), want]);
    }
  });

  test("login: wrong password 401, cross-site 403, right password sets an HttpOnly SameSite=Lax cookie; logout ends it", async () => {
    expect((await login(s, "nope")).status).toBe(401);
    expect((await login(s, PASSWORD, { Origin: "https://evil.example" })).status).toBe(403);
    const ok = await login(s);
    expect(ok.status).toBe(303);
    const [sc = "", dc = ""] = ok.headers.getSetCookie();
    expect(dc).toMatch(/^siiswell_device=\d{13}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    expect(sc).toMatch(/^siiswell_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax$/); // http PUBLIC_URL: no Secure
    const cookie = cookieOf(ok);

    const page = await get(s, "/", { Cookie: cookie });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const js = await get(s, "/app.js", { Cookie: cookie });
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get(s, "/manifest.webmanifest", { Cookie: cookie })).headers.get("content-type")).toBe("application/manifest+json");
    expect((await get(s, "/_headers", { Cookie: cookie })).status).toBe(404);
    expect((await get(s, "/nope.js", { Cookie: cookie })).status).toBe(404);

    const state = await get(s, "/api/state", { Cookie: cookie });
    expect(state.status).toBe(200);
    expect(await state.json()).toHaveProperty("hosts");
    expect((await get(s, "/api/state", { Cookie: cookie, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);

    expect((await get(s, "/cdn-cgi/access/logout", { Cookie: cookie })).headers.get("location")).toBe("/auth/logout");
    // a session cookie issued before the rename (old name) is still accepted
    const legacy = cookie.replace(/^siiswell_session=/, "orch_session=");
    expect(legacy).not.toBe(cookie);
    expect((await get(s, "/api/state", { Cookie: legacy })).status).toBe(200);
    const out = await fetch(`${s.url}/auth/logout`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, ...ORIGIN } });
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(out.headers.getSetCookie().some((c) => c.startsWith("orch_session=;"))).toBe(true); // the old name is cleared too
    expect((await get(s, "/api/state", { Cookie: legacy })).status).toBe(401); // same session: ended
    expect((await get(s, "/api/state", { Cookie: cookie })).status).toBe(401);
  });

  test("ingest snapshot + usage and MCP report_task work with their bearer tokens (no session)", async () => {
    const host = await addSource(s.db as unknown as D1Shim, "hosta", "host");
    const client = await addSource(s.db as unknown as D1Shim, "client1", "client");
    const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
    const snap = await fetch(`${s.url}/api/ingest/snapshot`, { method: "POST", headers: auth(host), body: JSON.stringify(snapshot()) });
    expect(snap.status).toBe(200);
    const now = Date.now();
    const usage = await fetch(`${s.url}/api/ingest/usage`, {
      method: "POST",
      headers: auth(host),
      body: JSON.stringify({ v: 1, host: "hosta", tz: "Europe/London", generatedAt: now - 1000, mode: "recent", rows: [{ day: new Date(now).toISOString().slice(0, 10), project: "proja", agent: "agent01", source: "claude", model: "claude-opus-5-5", input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 1, usd: 0.1 }] }),
    });
    expect(usage.status).toBe(200);
    const mcp = await fetch(`${s.url}/mcp`, {
      method: "POST",
      headers: { ...auth(client), Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_task", arguments: { project: "web", title: "t", status: "IN_PROGRESS" } } }),
    });
    expect(mcp.status).toBe(200);
    expect(JSON.stringify(await mcp.json())).toContain("m-");
    expect(s.db.rows("SELECT host, project FROM snapshots")).toEqual([{ host: "hosta", project: "proja" }]);
    expect((await fetch(`${s.url}/api/ingest/snapshot`, { method: "POST", headers: auth(client), body: "{}" })).status).toBe(403);
    await s.tick(); // the ticker body runs against the SQLite db without throwing
    expect(s.db.rows("SELECT k FROM meta WHERE k = 'last_alarm'")).toHaveLength(1);
  });

  test(`per-IP login rate limit: ${LOGIN_MAX_FAILURES} failures, then 429 even for the right password`, async () => {
    const r = boot();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await login(r, "wrong")).status).toBe(401);
    const locked = await login(r);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("logout revokes every session the browser carries, under the new AND the legacy cookie name", async () => {
    const one = cookieOf(await login(s)).replace(/^siiswell_session=/, "orch_session="); // a session carried under the old name
    const two = cookieOf(await login(s));
    expect((await get(s, "/api/state", { Cookie: one })).status).toBe(200);
    expect((await get(s, "/api/state", { Cookie: two })).status).toBe(200);
    const out = await fetch(`${s.url}/auth/logout`, { method: "POST", redirect: "manual", headers: { Cookie: `${two}; ${one}`, ...ORIGIN } });
    expect(out.status).toBe(303);
    expect((await get(s, "/api/state", { Cookie: one })).status).toBe(401);
    expect((await get(s, "/api/state", { Cookie: two })).status).toBe(401);
    // only the legacy cookie: also revoked
    const legacyOnly = cookieOf(await login(s)).replace(/^siiswell_session=/, "orch_session=");
    await fetch(`${s.url}/auth/logout`, { method: "POST", redirect: "manual", headers: { Cookie: legacyOnly, ...ORIGIN } });
    expect((await get(s, "/api/state", { Cookie: legacyOnly })).status).toBe(401);
  });

  test("https PUBLIC_URL: __Host- cookie with Secure, HSTS on own responses", async () => {
    const r = boot({ PUBLIC_URL: "https://dash.test" });
    const ok = await login(r, PASSWORD, { Origin: "https://dash.test" });
    expect(ok.headers.getSetCookie()[0]).toMatch(/^__Host-siiswell_session=.*; HttpOnly; SameSite=Lax; Secure$/);
    expect(ok.headers.getSetCookie()[1]).toMatch(/^__Host-siiswell_device=.*; SameSite=Strict; Secure$/);
    expect(ok.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  test("stop() waits for background work and closes the database", async () => {
    const r = boot();
    await r.stop();
    expect(() => r.db.rows("SELECT 1")).toThrow();
  });
});

test("assets: malformed %-encoding is 400 (not 500); traversal, dotfiles and _headers are refused; _headers rules match the decoded path", async () => {
  const s = boot();
  const cookie = cookieOf(await login(s));
  const get2 = (p: string) => fetch(`${s.url}${p}`, { headers: { Cookie: cookie }, redirect: "manual" });
  expect((await get2("/%E0%A4%A")).status).toBe(400);
  expect((await get2("/app%zz.js")).status).toBe(400);
  for (const p of ["/_headers", "/%5Fheaders", "/.env", "/%2e%2e/package.json", "/..%2fpackage.json", "/../package.json", "/public/../package.json"]) {
    expect([400, 404]).toContain((await get2(p)).status);
  }
  const enc = await get2("/%61pp.js"); // "/app.js" spelled with an escape: the same file, the same headers
  expect(enc.status).toBe(200);
  expect(enc.headers.get("content-security-policy")).toContain("default-src 'none'");
});

test("ticker re-entrancy: a tick while one runs joins it instead of starting another", async () => {
  const s = boot();
  const first = s.tick();
  const second = s.tick();
  expect(second).toBe(first);
  await first;
  const third = s.tick();
  expect(third).not.toBe(first);
  await third;
});

test("one identity check per request; HSTS on token routes and errors of an https server", async () => {
  const s = boot({ PUBLIC_URL: "https://dash.test" });
  const calls: string[] = [];
  const orig = BrowserAuth.prototype.identify;
  BrowserAuth.prototype.identify = function (this: BrowserAuth, req: Request, peer: string) {
    calls.push(new URL(req.url).pathname);
    return orig.call(this, req, peer);
  };
  try {
    await get(s, "/");
    await get(s, "/api/state");
    await get(s, "/app.js");
    expect(calls).toEqual(["/", "/api/state", "/app.js"]);
  } finally {
    BrowserAuth.prototype.identify = orig;
  }
  for (const p of ["/api/health", "/api/ingest/snapshot", "/mcp", "/nope", "/api/state"]) {
    expect((await get(s, p)).headers.get("strict-transport-security")).toBe("max-age=31536000");
  }
});

test("an http PUBLIC_URL (localhost) never sends HSTS, whatever the route", async () => {
  const s = boot();
  const cookie = cookieOf(await login(s));
  for (const p of ["/", "/app.js", "/api/state", "/api/health", "/mcp", "/api/ingest/snapshot", "/auth/login", "/nope", "/%zz"]) {
    expect((await get(s, p, { Cookie: cookie })).headers.has("strict-transport-security")).toBe(false);
  }
});

describe("session expiry (fake clock)", () => {
  test(`idle ${SESSION_IDLE_MS / 3_600_000} h and absolute ${SESSION_MAX_MS / 86_400_000} d`, async () => {
    let now = 1_800_000_000_000;
    const db = new SqliteD1();
    const a = new BrowserAuth(cfgFor({}), db, () => now);
    const signIn = async () => {
      const res = await a.handle(new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: `password=${encodeURIComponent(PASSWORD)}` }), "/auth/login", "127.0.0.1");
      return new Request("http://localhost:8787/", { headers: { Cookie: cookieOf(res as Response) } });
    };
    let req = await signIn();
    now += SESSION_IDLE_MS - 1000;
    expect((await a.identify(req, "127.0.0.1")).ok).toBe(true); // touched
    now += SESSION_IDLE_MS - 1000;
    expect((await a.identify(req, "127.0.0.1")).ok).toBe(true);
    now += SESSION_IDLE_MS;
    expect(await a.identify(req, "127.0.0.1")).toMatchObject({ ok: false, status: 401 });

    req = await signIn();
    for (let t = 0; t < SESSION_MAX_MS - 60_000; t += SESSION_IDLE_MS / 2) {
      now += SESSION_IDLE_MS / 2;
      if (t + SESSION_IDLE_MS / 2 < SESSION_MAX_MS) expect((await a.identify(req, "127.0.0.1")).ok).toBe(true);
    }
    now += SESSION_IDLE_MS / 2;
    expect((await a.identify(req, "127.0.0.1")).ok).toBe(false);
    expect(db.rows("SELECT * FROM auth_sessions")).toHaveLength(0);
  });
});

describe("Bun server (proxy auth)", () => {
  test("identity header believed only from TRUSTED_PROXY_CIDRS; missing header 401; ALLOWED_EMAILS enforced", async () => {
    const trusted = boot({ AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "127.0.0.1", ALLOWED_EMAILS: "ops@example.com" });
    expect((await get(trusted, "/api/state", { "X-Forwarded-Email": "ops@example.com" })).status).toBe(200);
    expect((await get(trusted, "/", { "X-Forwarded-Email": "OPS@example.com" })).status).toBe(200);
    expect((await get(trusted, "/api/state")).status).toBe(401);
    expect((await get(trusted, "/")).status).toBe(401);
    expect((await get(trusted, "/api/state", { "X-Forwarded-Email": "eve@example.com" })).status).toBe(403);
    expect((await get(trusted, "/auth/login")).status).toBe(404);

    const untrusted = boot({ AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "10.0.0.1" });
    const res = await get(untrusted, "/api/state", { "X-Forwarded-Email": "ops@example.com" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("trusted proxy") });

    const custom = boot({ AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "127.0.0.1", AUTH_PROXY_HEADER: "Tailscale-User-Login" });
    expect((await get(custom, "/api/state", { "Tailscale-User-Login": "me@github" })).status).toBe(200);
    expect((await get(custom, "/api/state", { "X-Forwarded-Email": "me@github" })).status).toBe(401);
  });
});

test("_headers parser", () => {
  const r = parseHeadersFile("/*\n  X-A: 1\n  CSP: a; b\n/x.js\n  Y: 2\n");
  expect(r.map((x) => [x.re.test("/foo"), x.headers])).toEqual([[true, [["X-A", "1"], ["CSP", "a; b"]]], [false, [["Y", "2"]]]]);
});

test("Dockerfile: pinned base image, non-root, /data volume, health check, exec-form CMD", async () => {
  const df = await Bun.file(join(import.meta.dir, "..", "Dockerfile")).text();
  expect(df).toMatch(/^FROM oven\/bun:\d+\.\d+\.\d+(-slim)?$/m);
  expect(df).toMatch(/^USER bun$/m);
  expect(df).toContain('VOLUME ["/data"]');
  expect(df).toMatch(/^HEALTHCHECK [\s\S]*\/api\/health/m);
  expect(df).toContain('CMD ["bun", "src/server/bun.ts"]');
});

/** White-box: charge `n` distinct public /24 prefixes (one failure each) through the private reserve(). */
function fill(a: BrowserAuth, n: number, now: number): void {
  const priv = a as unknown as { reserve(c: { k: string; cap: number; net?: string }[], now: number): unknown };
  for (let i = 0; i < n; i++) priv.reserve([{ k: `net:${11 + (i >> 16)}.${i >> 8 & 255}.${i & 255}.0/24`, cap: 50 }], now);
}

describe("login hardening (security review)", () => {
  const signInReq = (pw = PASSWORD, ip = "127.0.0.1") => ({ req: new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: `password=${encodeURIComponent(pw)}` }), ip });

  test("parallel wrong attempts from one IP cannot exceed the per-IP cap (reserved before verify)", async () => {
    const a = new BrowserAuth(cfgFor({}), new SqliteD1());
    const res = await Promise.all(Array.from({ length: 12 }, () => { const { req, ip } = signInReq("wrong"); return a.handle(req, "/auth/login", ip); }));
    const codes = res.map((r) => (r as Response).status);
    expect(codes.filter((c) => c === 401)).toHaveLength(LOGIN_MAX_FAILURES);
    expect(codes.filter((c) => c === 429)).toHaveLength(12 - LOGIN_MAX_FAILURES);
  });

  test("distributed guessing: the global failure budget refuses unknown browsers, never the admin's known device", async () => {
    let now = 1_800_000_000_000;
    const a = new BrowserAuth(cfgFor({}), new SqliteD1(), () => now);
    // the admin signs in once from home: a known-device cookie (not a session) comes with the session
    const first = (await a.handle(signInReq(PASSWORD).req, "/auth/login", "198.51.100.7")) as Response;
    const device = (first.headers.getSetCookie()[1] ?? "").split(";")[0] as string;
    expect(device).toMatch(/^siiswell_device=/);
    // an attacker spreads LOGIN_GLOBAL_FAILURES_PER_MINUTE failures over as many /24s
    for (let i = 0; i < LOGIN_GLOBAL_FAILURES_PER_MINUTE; i++) {
      expect((await a.handle(signInReq("wrong").req, "/auth/login", `203.${i >> 8}.${i & 255}.9`))?.status).toBe(401);
    }
    // budget spent: a fresh browser (even with the right password) gets 429 + Retry-After ...
    const blocked = (await a.handle(signInReq(PASSWORD).req, "/auth/login", "192.0.2.1")) as Response;
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // ... the admin's known device still signs in, from anywhere ...
    const withDevice = (pw: string) => new Request("http://localhost:8787/auth/login", { method: "POST", headers: { ...ORIGIN, Cookie: device }, body: `password=${encodeURIComponent(pw)}` });
    expect((await a.handle(withDevice(PASSWORD), "/auth/login", "192.0.2.50"))?.status).toBe(303);
    // ... a forged / expired device cookie does not help, and the device cookie is no session
    const forged = new Request("http://localhost:8787/auth/login", { method: "POST", headers: { ...ORIGIN, Cookie: device.replace(/=(.{14})(.)/, (_m, head: string, c: string) => `=${head}${c === "A" ? "B" : "A"}`) } /* flip the FIRST MAC character: the last one of 43 base64url chars only carries 4 data bits, so flipping its low bits forged nothing */, body: `password=${PASSWORD}` });
    expect((await a.handle(forged, "/auth/login", "192.0.2.51"))?.status).toBe(429);
    expect((await a.identify(new Request("http://localhost:8787/", { headers: { Cookie: device } }), "192.0.2.50")).ok).toBe(false);
    // the budget is per minute
    now += 60_000;
    expect((await a.handle(signInReq(PASSWORD).req, "/auth/login", "192.0.2.1"))?.status).toBe(303);
    now += KNOWN_DEVICE_MS;
    for (let i = 0; i < LOGIN_GLOBAL_FAILURES_PER_MINUTE; i++) await a.handle(signInReq("wrong").req, "/auth/login", `203.1.${i}.9`);
    expect((await a.handle(withDevice(PASSWORD), "/auth/login", "192.0.2.50"))?.status).toBe(429); // expired after 30 days
  });

  test("a known-device cookie is bound to the password hash", async () => {
    const db = new SqliteD1();
    const cfg = cfgFor({});
    const a = new BrowserAuth(cfg, db);
    const device = (((await a.handle(signInReq().req, "/auth/login", "198.51.100.7")) as Response).headers.getSetCookie()[1] ?? "").split(";")[0] as string;
    const b = new BrowserAuth({ ...cfg, adminPasswordHash: await Bun.password.hash(PASSWORD + "!", { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 }) }, db);
    for (let i = 0; i < LOGIN_GLOBAL_FAILURES_PER_MINUTE; i++) await b.handle(signInReq("wrong").req, "/auth/login", `203.2.${i}.9`);
    const req = new Request("http://localhost:8787/auth/login", { method: "POST", headers: { ...ORIGIN, Cookie: device }, body: `password=${encodeURIComponent(PASSWORD + "!")}` });
    expect((await b.handle(req, "/auth/login", "192.0.2.50"))?.status).toBe(429);
  });

  test("rate keys: public IPv4 /24 and IPv6 /64 aggregates, private and loopback exact, IPv4 inside IPv6 counts as IPv4", () => {
    expect(rateKeys("203.0.113.5")).toEqual({ exact: "203.0.113.5", aggregate: "203.0.113.0/24" });
    expect(rateKeys("2001:db8:1:2:aaaa::1")).toEqual({ exact: "2001:db8:1:2:aaaa:0:0:1", aggregate: "2001:db8:1:2::/64" });
    for (const local of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.9", "100.64.0.1"]) expect(rateKeys(local)).toEqual({ exact: local, aggregate: local });
    expect(rateKeys("::1").aggregate).toBe("0:0:0:0:0:0:0:1");
    expect(rateKeys("fd00::5").aggregate).toBe("fd00:0:0:0:0:0:0:5");
    // one IPv4 host spelled five ways is ONE client
    for (const v6 of ["::ffff:203.0.113.77", "::ffff:cb00:714d", "::203.0.113.77", "64:ff9b::203.0.113.77", "64:ff9b::cb00:714d", "2002:cb00:714d::1", "2002:cb00:714d:ffff::9"]) {
      expect(rateKeys(v6)).toEqual({ exact: "203.0.113.77", aggregate: "203.0.113.0/24" });
    }
    expect(rateKeys("64:ff9b::10.0.0.1")).toEqual({ exact: "10.0.0.1", aggregate: "10.0.0.1" });
    expect(rateKeys("::").exact).toBe("0:0:0:0:0:0:0:0"); // unspecified / loopback are not IPv4-compatible
    expect(rateBucket("203.0.113.5")).toBe("203.0.113.0/24");
  });

  test("two tiers: a neighbour in the admin's /24 or /64 cannot lock the admin's address; the prefix has a looser cap", async () => {
    const a = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await a.handle(signInReq("x").req, "/auth/login", "203.0.113.66"))?.status).toBe(401);
    expect((await a.handle(signInReq().req, "/auth/login", "203.0.113.66"))?.status).toBe(429); // that address is capped
    expect((await a.handle(signInReq().req, "/auth/login", "::ffff:203.0.113.66"))?.status).toBe(429); // in any spelling
    expect((await a.handle(signInReq().req, "/auth/login", "2002:cb00:7142::1"))?.status).toBe(429);
    expect((await a.handle(signInReq().req, "/auth/login", "203.0.113.7"))?.status).toBe(303); // the admin next door is not
    // the /24 as a whole: LOGIN_MAX_AGGREGATE_FAILURES across rotating addresses, then the prefix waits
    const b = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let i = 0; i < LOGIN_MAX_AGGREGATE_FAILURES; i++) expect((await b.handle(signInReq("x").req, "/auth/login", `198.51.100.${i + 1}`))?.status).toBe(401);
    expect((await b.handle(signInReq().req, "/auth/login", "198.51.100.250"))?.status).toBe(429);
    expect((await b.handle(signInReq().req, "/auth/login", "198.51.101.1"))?.status).toBe(303); // (not the global budget)
    // (fresh instances below: the global budget of 100 failures a minute would otherwise be what refuses)
    const c = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let i = 0; i < LOGIN_MAX_AGGREGATE_FAILURES; i++) await c.handle(signInReq("x").req, "/auth/login", `2001:db8:9:9::${(i + 1).toString(16)}`);
    expect((await c.handle(signInReq().req, "/auth/login", "2001:db8:9:9:ffff::1"))?.status).toBe(429);
    expect((await c.handle(signInReq().req, "/auth/login", "2001:db8:9:a::1"))?.status).toBe(303);
    const d = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await d.handle(signInReq("x").req, "/auth/login", "10.0.0.1");
    expect((await d.handle(signInReq().req, "/auth/login", "10.0.0.2"))?.status).toBe(303); // private: exact only
  });

  test("a known device is counted per device, not per address or prefix, and has its own cap", async () => {
    const a = new BrowserAuth(cfgFor({}), new SqliteD1());
    const device = (((await a.handle(signInReq().req, "/auth/login", "203.0.113.7")) as Response).headers.getSetCookie()[1] ?? "").split(";")[0] as string;
    const withDevice = (pw: string) => new Request("http://localhost:8787/auth/login", { method: "POST", headers: { ...ORIGIN, Cookie: device }, body: `password=${encodeURIComponent(pw)}` });
    // a neighbour exhausts the admin's own address AND the /24
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await a.handle(signInReq("x").req, "/auth/login", "203.0.113.7");
    for (let i = 0; i < LOGIN_MAX_AGGREGATE_FAILURES; i++) await a.handle(signInReq("x").req, "/auth/login", `203.0.113.${100 + (i % 100)}`);
    expect((await a.handle(signInReq().req, "/auth/login", "203.0.113.7"))?.status).toBe(429);
    expect((await a.handle(withDevice(PASSWORD), "/auth/login", "203.0.113.7"))?.status).toBe(303); // the device still gets in
    // a stolen device cookie only buys LOGIN_MAX_FAILURES guesses per window, wherever it is used from
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await a.handle(withDevice("x"), "/auth/login", `192.0.2.${i + 1}`))?.status).toBe(401);
    expect((await a.handle(withDevice(PASSWORD), "/auth/login", "192.0.2.99"))?.status).toBe(429);
  });

  test("the global budget is reserved before the password check (no TOCTOU under concurrency)", async () => {
    const a = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let i = 0; i < LOGIN_GLOBAL_FAILURES_PER_MINUTE - 1; i++) await a.handle(signInReq("wrong").req, "/auth/login", `203.7.${i}.1`);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => a.handle(signInReq("wrong").req, "/auth/login", `203.8.${i}.1`)));
    const codes = res.map((r) => (r as Response).status).sort();
    expect(codes).toEqual([401, 429, 429, 429, 429, 429, 429, 429, 429, 429]);
    // and a success gives its global slot back: right password at 99 reserved -> 303, budget still 99 used
    const b = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let i = 0; i < LOGIN_GLOBAL_FAILURES_PER_MINUTE - 1; i++) await b.handle(signInReq("wrong").req, "/auth/login", `203.7.${i}.1`);
    expect((await b.handle(signInReq().req, "/auth/login", "203.9.0.1"))?.status).toBe(303);
    expect((await b.handle(signInReq("wrong").req, "/auth/login", "203.9.0.2"))?.status).toBe(401);
    expect((await b.handle(signInReq().req, "/auth/login", "203.9.0.3"))?.status).toBe(429);
  });

  test("recovery code (scripts/recovery-token.ts): one login past every throttle, needs the password, one-time, limited tries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siiswell-rec-"));
    dirs.push(dir);
    const db = new SqliteD1({ path: join(dir, "siiswell.sqlite") });
    const a = new BrowserAuth(cfgFor({}), db);
    const mint = async () => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "..", "scripts", "recovery-token.ts")], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", DATA_DIR: dir, NODE_ENV: "test" } });
      expect(await p.exited).toBe(0);
      return (await new Response(p.stdout).text()).split("\n")[0] as string;
    };
    const code = await mint();
    expect(code).toMatch(RECOVERY_RE);
    expect(db.rows<{ id_sha256: string }>("SELECT id_sha256 FROM auth_recovery")[0]?.id_sha256).not.toContain(code.slice(4)); // only the hash
    const withCode = (pw: string, c = code) => new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: pw, recovery: c }).toString() });
    // everything throttled: global budget spent and the admin's address capped
    for (let i = 0; i < LOGIN_GLOBAL_FAILURES_PER_MINUTE; i++) await a.handle(signInReq("wrong").req, "/auth/login", `203.4.${i}.1`);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await a.handle(signInReq("wrong").req, "/auth/login", "203.5.0.1");
    expect((await a.handle(signInReq().req, "/auth/login", "203.5.0.1"))?.status).toBe(429);
    expect((await a.handle(withCode("wrong"), "/auth/login", "203.5.0.1"))?.status).toBe(401); // the code is no password
    expect((await a.handle(withCode(PASSWORD), "/auth/login", "203.5.0.1"))?.status).toBe(303);
    expect((await a.handle(withCode(PASSWORD), "/auth/login", "203.5.0.1"))?.status).toBe(429); // used up (refused: the global budget is spent, so not even its own 403)
    expect((await a.handle(withCode(PASSWORD, "orr_" + "A".repeat(43)), "/auth/login", "203.5.0.1"))?.status).toBe(429); // unknown code: the global failure budget (spent above) refuses it first
    const second = await mint();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await a.handle(withCode("wrong", second), "/auth/login", "203.5.0.1"))?.status).toBe(401);
    expect((await a.handle(withCode(PASSWORD, second), "/auth/login", "203.5.0.1"))?.status).toBe(429); // tried too often (likewise refused)
    db.close();
  });

  test("config refuses a cheap argon2 hash (the password itself is checked by hash-password.ts)", () => {
    const r = loadConfig({ PUBLIC_URL: "https://d.example.org", ADMIN_PASSWORD_HASH: HASH });
    expect((r as { errors: string[] }).errors.join()).toContain("too cheap");
  });

  test("builtin: logins with X-Forwarded-For from an untrusted peer are refused (unless ALLOW_UNTRUSTED_XFF=1), warned once a minute", async () => {
    const warn = console.warn;
    const seen: string[] = [];
    console.warn = (m: string) => void seen.push(m);
    try {
      let now = 1_800_000_000_000;
      const fwd = (pw = PASSWORD) => new Request("http://localhost:8787/auth/login", { method: "POST", headers: { ...ORIGIN, "X-Forwarded-For": "198.51.100.9" }, body: `password=${encodeURIComponent(pw)}` });
      const a = new BrowserAuth(cfgFor({}), new SqliteD1(), () => now);
      expect((await a.handle(signInReq().req, "/auth/login", "172.17.0.1", "172.17.0.1"))?.status).toBe(303); // no XFF: fine
      const refused = (await a.handle(fwd(), "/auth/login", "172.17.0.1", "172.17.0.1")) as Response;
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("TRUSTED_PROXY_CIDRS");
      for (let i = 0; i < 20; i++) await a.handle(fwd("x"), "/auth/login", "172.17.0.1", "172.17.0.1"); // a burst ...
      expect(seen).toHaveLength(1); // ... logs once
      expect(seen[0]).toContain("you MUST set TRUSTED_PROXY_CIDRS");
      now += 60_000;
      expect(a.noteForwarded(fwd(), "172.17.0.1")).toBe(true);
      expect(seen).toHaveLength(2); // the next burst logs again
      // nothing was charged to the shared address by the refused attempts: the admin is not locked out
      expect((await a.handle(signInReq().req, "/auth/login", "172.17.0.1", "172.17.0.1"))?.status).toBe(303);

      const allowed = new BrowserAuth(cfgFor({ ALLOW_UNTRUSTED_XFF: "1" }), new SqliteD1());
      expect((await allowed.handle(fwd(), "/auth/login", "172.17.0.1", "172.17.0.1"))?.status).toBe(303);
      const trusted = new BrowserAuth(cfgFor({ TRUSTED_PROXY_CIDRS: "172.28.0.10" }), new SqliteD1());
      expect((await trusted.handle(fwd(), "/auth/login", "198.51.100.9", "172.28.0.10"))?.status).toBe(303);
      expect((await trusted.handle(fwd(), "/auth/login", "203.0.113.1", "203.0.113.1"))?.status).toBe(403); // forged XFF, direct
      const n = seen.length;
      expect(new BrowserAuth(cfgFor({ AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "127.0.0.1" }), new SqliteD1()).noteForwarded(fwd(), "10.9.9.9")).toBe(false);
      expect(seen).toHaveLength(n); // proxy mode never warns
    } finally {
      console.warn = warn;
    }
  });

  test("recovery code: concurrent attempts cannot overrun its tries or sign in twice; recovery attempts have their own global cap", async () => {
    const db = new SqliteD1();
    const a = new BrowserAuth(cfgFor({}), db);
    const mint = async () => {
      const code = `orr_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
      db.sqlite.query("INSERT INTO auth_recovery (id_sha256, created, expires) VALUES (?, ?, ?)").run(await sha256Hex(code), Date.now(), Date.now() + RECOVERY_TTL_MS);
      return code;
    };
    const attempt = (code: string, pw: string, i: number) =>
      a.handle(new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: pw, recovery: code }).toString() }), "/auth/login", `203.6.${i}.1`);
    // 8 concurrent wrong passwords on one code: exactly LOGIN_MAX_FAILURES get to the password check
    const wrong = await mint();
    const codes = (await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(wrong, "x", i)))).map((r) => (r as Response).status).sort();
    expect(codes).toEqual([401, 401, 401, 401, 401, 403, 403, 403]);
    expect(db.rows("SELECT fails FROM auth_recovery WHERE id_sha256 = ?", await sha256Hex(wrong))).toEqual([{ fails: LOGIN_MAX_FAILURES }]);
    // the global recovery cap is now spent (8 of 10 used + 2 below), so a fresh minute is needed: new instance
    const b = new BrowserAuth(cfgFor({}), db);
    const right = await mint();
    const both = await Promise.all([0, 1].map((i) => b.handle(new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: PASSWORD, recovery: right }).toString() }), "/auth/login", `203.6.9${i}.1`)));
    expect(both.map((r) => (r as Response).status).sort()).toEqual([303, 403]); // one sign-in per code
    // the shared cap counts tries of REAL codes only: LOGIN_RECOVERY_ATTEMPTS_PER_MINUTE a minute
    const c = new BrowserAuth(cfgFor({}), db);
    const rec = (code: string, pw: string, ip: string) =>
      c.handle(new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: pw, recovery: code }).toString() }), "/auth/login", ip);
    for (let i = 0; i < 2; i++) {
      const code = await mint();
      for (let j = 0; j < LOGIN_RECOVERY_ATTEMPTS_PER_MINUTE / 2; j++) expect((await rec(code, "x", `203.6.${100 + i * 10 + j}.1`))?.status).toBe(401);
    }
    expect((await rec(await mint(), PASSWORD, "203.6.200.1"))?.status).toBe(429);
  });

  test("unknown recovery codes cannot block the real one: they count against the caller's own address, not the shared budget", async () => {
    const db = new SqliteD1();
    const a = new BrowserAuth(cfgFor({}), db);
    const code = `orr_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    db.sqlite.query("INSERT INTO auth_recovery (id_sha256, created, expires) VALUES (?, ?, ?)").run(await sha256Hex(code), Date.now(), Date.now() + RECOVERY_TTL_MS);
    const rec = (c: string, pw: string, ip: string) =>
      a.handle(new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: pw, recovery: c }).toString() }), "/auth/login", ip);
    const bogus = () => `orr_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    for (let i = 0; i < 50; i++) expect((await rec(bogus(), "x", `198.18.${i}.1`))?.status).toBe(403);
    // one address spamming bogus codes is capped like any guesser
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await rec(bogus(), "x", "198.19.0.1");
    expect((await rec(bogus(), "x", "198.19.0.1"))?.status).toBe(429);
    // the real code + password still signs in (from an address of its own)
    expect((await rec(code, PASSWORD, "192.0.2.77"))?.status).toBe(303);
  });

  test("the failure-counter map stays bounded without evicting live lockouts; new keys beyond it fail closed", async () => {
    let now = 1_800_000_000_000;
    const a = new BrowserAuth(cfgFor({}), new SqliteD1(), () => now);
    // lock one address first
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await a.handle(signInReq("x").req, "/auth/login", "203.0.113.9");
    expect((await a.handle(signInReq().req, "/auth/login", "203.0.113.9"))?.status).toBe(429);
    // flood 20 000 distinct prefixes straight into the counters (every request path is throttled by the global budget
    // long before that, so reserve() is driven directly: this is about the map bound itself)
    fill(a, 20_000, now);
    expect(a.failureKeys).toBeLessThanOrEqual(MAX_FAILURE_KEYS);
    expect((await a.handle(signInReq().req, "/auth/login", "198.51.100.200"))?.status).toBe(429); // a brand-new address now
    // the lockout was not evicted
    expect((await a.handle(signInReq().req, "/auth/login", "203.0.113.9"))?.status).toBe(429);
    // once the windows end, everything is dropped and works again
    now += LOGIN_WINDOW_MS;
    expect((await a.handle(signInReq().req, "/auth/login", "198.51.100.200"))?.status).toBe(303);
    expect(a.failureKeys).toBeLessThan(10);
  });

  test("map full: a known-device admin still signs in (device counters never overflow); refused checks create no keys", async () => {
    let now = 1_800_000_000_000;
    const a = new BrowserAuth(cfgFor({}), new SqliteD1(), () => now);
    const first = (await a.handle(signInReq().req, "/auth/login", "192.0.2.10")) as Response;
    const device = (first.headers.getSetCookie()[1] ?? "").split(";")[0] as string;
    fill(a, 12_000, now);
    expect(a.failureKeys).toBeGreaterThanOrEqual(MAX_FAILURE_KEYS);
    expect((await a.handle(signInReq().req, "/auth/login", "198.51.100.201"))?.status).toBe(429); // full: new keys fail closed
    const withDevice = (pw: string) => new Request("http://localhost:8787/auth/login", { method: "POST", headers: { ...ORIGIN, Cookie: device }, body: `password=${encodeURIComponent(pw)}` });
    expect((await a.handle(withDevice("wrong"), "/auth/login", "198.51.100.202"))?.status).toBe(401); // its own counter
    expect((await a.handle(withDevice(PASSWORD), "/auth/login", "198.51.100.202"))?.status).toBe(303);
    // a request refused by a cap creates nothing
    const before = a.failureKeys;
    for (let i = 0; i < 50; i++) await a.handle(signInReq("x").req, "/auth/login", `198.51.${100 + i}.1`);
    expect(a.failureKeys).toBe(before);
  });

  test("one /64 (or /24) cannot fill the map: at most MAX_IP_KEYS_PER_NET addresses are tracked per prefix", async () => {
    const a = new BrowserAuth(cfgFor({}), new SqliteD1());
    // the prefix cap stops it long before anyway; look at the keys created by up to 50 failures from distinct addresses
    for (let i = 0; i < LOGIN_MAX_AGGREGATE_FAILURES; i++) await a.handle(signInReq("x").req, "/auth/login", `2001:db8:5:5::${(i + 1).toString(16)}`);
    expect(a.failureKeys).toBeLessThanOrEqual(1 + Math.min(LOGIN_MAX_AGGREGATE_FAILURES, MAX_IP_KEYS_PER_NET));
    // more addresses in the same /64: all refused by the prefix cap, no new keys
    for (let i = 0; i < 1000; i++) expect((await a.handle(signInReq("x").req, "/auth/login", `2001:db8:5:5:1::${(i + 1).toString(16)}`))?.status).toBe(429);
    expect(a.failureKeys).toBeLessThanOrEqual(1 + MAX_IP_KEYS_PER_NET);
    // and with a looser prefix cap than the per-prefix key limit, the key limit holds (white-box: bogus-code path, 200 addresses)
    const b = new BrowserAuth(cfgFor({}), new SqliteD1());
    const priv = b as unknown as { reserve(c: { k: string; cap: number; net?: string }[], now: number): unknown; failureKeys: number };
    for (let i = 0; i < 200; i++) priv.reserve([{ k: "net:2001:db8:6:6::/64", cap: 1e9 }, { k: `ip:2001:db8:6:6:0:0:0:${i.toString(16)}`, cap: 5, net: "net:2001:db8:6:6::/64" }], Date.now());
    expect(priv.failureKeys).toBe(1 + MAX_IP_KEYS_PER_NET);
  });

  test("fake recovery codes from 5000 /64s cannot fill the map: the global budget stops them first; device and real code still work", async () => {
    const db = new SqliteD1();
    const a = new BrowserAuth(cfgFor({}), db);
    const device = ((((await a.handle(signInReq().req, "/auth/login", "192.0.2.10")) as Response).headers.getSetCookie()[1]) ?? "").split(";")[0] as string;
    const code = `orr_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    db.sqlite.query("INSERT INTO auth_recovery (id_sha256, created, expires) VALUES (?, ?, ?)").run(await sha256Hex(code), Date.now(), Date.now() + RECOVERY_TTL_MS);
    const keysBefore = a.failureKeys;
    const statuses: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const r = await a.handle(new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: "x", recovery: `orr_${"F".repeat(43)}` }).toString() }), "/auth/login", `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1`);
      statuses.push((r as Response).status);
    }
    expect(statuses.filter((x) => x === 403)).toHaveLength(LOGIN_GLOBAL_FAILURES_PER_MINUTE);
    expect(statuses.filter((x) => x === 429)).toHaveLength(5000 - LOGIN_GLOBAL_FAILURES_PER_MINUTE);
    expect(a.failureKeys - keysBefore).toBeLessThanOrEqual(2 * LOGIN_GLOBAL_FAILURES_PER_MINUTE); // net + ip per charged attempt only
    const withDevice = new Request("http://localhost:8787/auth/login", { method: "POST", headers: { ...ORIGIN, Cookie: device }, body: `password=${encodeURIComponent(PASSWORD)}` });
    expect((await a.handle(withDevice, "/auth/login", "198.51.100.5"))?.status).toBe(303);
    const withCode = new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: PASSWORD, recovery: code }).toString() });
    expect((await a.handle(withCode, "/auth/login", "198.51.100.6"))?.status).toBe(303);
  });

  test("bogus recovery codes count toward the global failure budget", async () => {
    const a = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let i = 0; i < LOGIN_GLOBAL_FAILURES_PER_MINUTE; i++) {
      await a.handle(new Request("http://localhost:8787/auth/login", { method: "POST", headers: ORIGIN, body: new URLSearchParams({ password: "x", recovery: `orr_${"D".repeat(43)}` }).toString() }), "/auth/login", `203.20.${i}.1`);
    }
    expect((await a.handle(signInReq().req, "/auth/login", "192.0.2.123"))?.status).toBe(429);
  });

  test("a success clears the IP's reserved attempts", async () => {
    const a = new BrowserAuth(cfgFor({}), new SqliteD1());
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) expect((await a.handle(signInReq("x").req, "/auth/login", "9.9.9.9"))?.status).toBe(401);
      expect((await a.handle(signInReq().req, "/auth/login", "9.9.9.9"))?.status).toBe(303);
    }
  });

  test("rotating ADMIN_PASSWORD_HASH ends existing sessions (row fingerprint + startup sweep)", async () => {
    const db = new SqliteD1();
    const cfg = cfgFor({});
    const a = new BrowserAuth(cfg, db);
    const res = (await a.handle(signInReq().req, "/auth/login", "127.0.0.1")) as Response;
    const req = new Request("http://localhost:8787/", { headers: { Cookie: cookieOf(res) } });
    expect((await a.identify(req, "127.0.0.1")).ok).toBe(true);
    const newHash = await Bun.password.hash("another long password", { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });
    const b = new BrowserAuth({ ...cfg, adminPasswordHash: newHash }, db);
    expect(db.rows("SELECT * FROM auth_sessions")).toHaveLength(0);
    // and even a row that escaped the sweep is refused by its fingerprint
    db.sqlite.query("INSERT INTO auth_sessions (id_sha256, created, last_seen, ip, pw_fp) VALUES (?, ?, ?, '', ?)").run(
      await (await import("../src/util")).sha256Hex(cookieOf(res).split("=")[1] as string), Date.now(), Date.now(), passwordFingerprint(HASH));
    expect((await b.identify(req, "127.0.0.1")).ok).toBe(false);
  });
});

describe("proxy mode behind Cloudflare Access: the Access JWT is verified", () => {
  const TEAM = "acme.cloudflareaccess.com";
  const AUD = "aud-tag-123";
  const NOW = 1_800_000_000_000;

  async function setup(env: Record<string, string> = {}) {
    const { b64urlEncode, utf8 } = await import("../src/util");
    const { resetAccessCache } = await import("../src/auth");
    resetAccessCache();
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const fetchImpl = async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] }), { headers: { "Content-Type": "application/json" } });
    const jwt = async (claims: Record<string, unknown>) => {
      const h = b64urlEncode(utf8(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })));
      const p = b64urlEncode(utf8(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(NOW / 1000) + 3600, email: "ops@example.com", ...claims })));
      return `${h}.${p}.${b64urlEncode(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, utf8(`${h}.${p}`)))}`;
    };
    const cfg = cfgFor({ AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "10.0.0.1", AUTH_PROXY_HEADER: "Cf-Access-Authenticated-User-Email", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...env });
    const a = new BrowserAuth(cfg, new SqliteD1(), () => NOW, fetchImpl);
    const req = (h: Record<string, string>) => new Request("http://localhost:8787/api/state", { headers: h });
    return { a, jwt, req };
  }

  test("valid JWT matching the header passes; missing / forged / wrong-aud / mismatched identity are refused", async () => {
    const { a, jwt, req } = await setup();
    const H = "Cf-Access-Authenticated-User-Email";
    expect(await a.identify(req({ [H]: "ops@example.com", "Cf-Access-Jwt-Assertion": await jwt({}) }), "10.0.0.1")).toEqual({ ok: true, identity: "ops@example.com" });
    expect(await a.identify(req({ [H]: "ops@example.com" }), "10.0.0.1")).toMatchObject({ ok: false, status: 401 });
    expect(await a.identify(req({ [H]: "ops@example.com", "Cf-Access-Jwt-Assertion": await jwt({ aud: ["other"] }) }), "10.0.0.1")).toMatchObject({ ok: false, status: 403 });
    const forged = (await jwt({})).replace(/\.[^.]+$/, ".AAAA");
    expect(await a.identify(req({ [H]: "ops@example.com", "Cf-Access-Jwt-Assertion": forged }), "10.0.0.1")).toMatchObject({ ok: false, status: 403 });
    expect(await a.identify(req({ [H]: "ops@example.com", "Cf-Access-Jwt-Assertion": await jwt({ email: "eve@example.com" }) }), "10.0.0.1")).toMatchObject({ ok: false, reason: expect.stringContaining("does not match") });
    // the peer check still comes first
    expect(await a.identify(req({ [H]: "ops@example.com", "Cf-Access-Jwt-Assertion": await jwt({}) }), "10.0.0.2")).toMatchObject({ ok: false, status: 403 });
  });

  test("ALLOWED_EMAILS also applies to the JWT; config: both Access settings or none, proxy mode only; unverified cf-access header warns", async () => {
    const { a, jwt, req } = await setup({ ALLOWED_EMAILS: "boss@example.com" });
    expect((await a.identify(req({ "Cf-Access-Authenticated-User-Email": "ops@example.com", "Cf-Access-Jwt-Assertion": await jwt({}) }), "10.0.0.1")).ok).toBe(false);
    const base = { PUBLIC_URL: "https://d.example.org", AUTH_MODE: "proxy", TRUSTED_PROXY_CIDRS: "10.0.0.1" };
    expect((loadConfig({ ...base, ACCESS_AUD: AUD }) as { errors: string[] }).errors.join()).toContain("set together");
    expect((loadConfig({ PUBLIC_URL: "https://d.example.org", ADMIN_PASSWORD_HASH: STRONG_HASH, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM }) as { errors: string[] }).errors.join()).toContain("only used with AUTH_MODE=proxy");
    const unverified = loadConfig({ ...base, AUTH_PROXY_HEADER: "Cf-Access-Authenticated-User-Email" });
    expect(unverified.ok && unverified.config.warnings.join()).toContain("WITHOUT verifying");
    const verified = loadConfig({ ...base, AUTH_PROXY_HEADER: "Cf-Access-Authenticated-User-Email", ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM });
    expect(verified.ok && verified.config.warnings).toEqual([]);
  });
});

test("scripts/hash-password.ts refuses fewer than 12 characters; its hash passes config validation", async () => {
  const run = async (pw: string) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "..", "scripts", "hash-password.ts")], { stdin: new Blob([`${pw}\n`]), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } });
    return { code: await p.exited, out: (await new Response(p.stdout).text()).trim() };
  };
  expect((await run("short-pw-11")).code).toBe(1);
  const ok = await run("a-long-random-password");
  expect(ok.code).toBe(0);
  expect(loadConfig({ PUBLIC_URL: "https://d.example.org", ADMIN_PASSWORD_HASH: ok.out }).ok).toBe(true);
});

test("scripts/db-exec.ts before the server's first start: creates the database and applies the migrations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siiswell-dbexec-"));
  dirs.push(dir);
  const run = async (sql: string) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "..", "scripts", "db-exec.ts"), sql], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", DATA_DIR: dir, NODE_ENV: "test" } });
    return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
  };
  const ins = await run("INSERT INTO sources (id, name, kind, token_sha256, created) VALUES ('src-h', 'hosta', 'host', 'x', 1)");
  expect(ins.err).toBe("");
  expect(ins.code).toBe(0);
  const db = new SqliteD1({ path: join(dir, "siiswell.sqlite"), migrationsDir: join(import.meta.dir, "..", "migrations") });
  expect(db.rows("SELECT name FROM sources")).toEqual([{ name: "hosta" }]);
  expect(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM _migrations")[0]?.n).toBeGreaterThanOrEqual(3);
  db.close();
});

describe("self-hosted: the optional switches reach the Worker code", () => {
  test("OTLP_INGEST=1 turns /api/ingest/otlp on (404 without it); WELLBEING_PUSH_POLICY passes through", async () => {
    const { buildEnv } = await import("../src/server/bun");
    const { PASSTHROUGH_VARS } = await import("../src/server/config");
    expect(PASSTHROUGH_VARS).toContain("OTLP_INGEST");
    expect(PASSTHROUGH_VARS).toContain("WELLBEING_PUSH_POLICY");
    const db = new SqliteD1({ migrationsDir: join(import.meta.dir, "..", "migrations") });
    const env = buildEnv(cfgFor({}), db, { OTLP_INGEST: "1", WELLBEING_PUSH_POLICY: "0" });
    expect([env.OTLP_INGEST, env.WELLBEING_PUSH_POLICY]).toEqual(["1", "0"]);
    const off = startServer(cfgFor({}), { RULES_MIN_INTERVAL_MS: "0" });
    const on = startServer(cfgFor({}), { RULES_MIN_INTERVAL_MS: "0", OTLP_INGEST: "1" });
    servers.push(off, on);
    const post = (s: RunningServer) => fetch(`${s.url}/api/ingest/otlp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect((await post(off)).status).toBe(404);
    expect((await post(on)).status).toBe(401); // on: it asks for the host token
  });
});

describe("DEV_NO_ACCESS is ignored by the self-hosted server", () => {
  test("not copied into the environment, and /api/state still needs a login even when the variable is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siiswell-srv-"));
    dirs.push(dir);
    const cfg = cfgFor({});
    const s = startServer(cfg, { DEV_NO_ACCESS: "1", ACCEPT_LAST_LINE: "1", RULES_MIN_INTERVAL_MS: "0", OPPORTUNISTIC_MAINTENANCE: "0" });
    servers.push(s);
    expect((s.env as { DEV_NO_ACCESS?: string }).DEV_NO_ACCESS).toBeUndefined();
    expect((s.env as { ACCEPT_LAST_LINE?: string }).ACCEPT_LAST_LINE).toBe("1");
    expect((await get(s, "/api/state")).status).toBe(401); // from a loopback address, with Host: localhost
    expect((await get(s, "/api/state", { Host: "localhost" })).status).toBe(401);
    expect((await get(s, "/")).status).toBe(303); // the page redirects to the login
  });
});

describe("ADMIN_PASSWORD: a plain password in .env for a simple first install", () => {
  test("config: accepted alone (12+ characters); too short is refused; with a hash the hash wins and a warning says so; neither is refused", () => {
    const base = { PUBLIC_URL: "https://d.example.org" };
    const ok = loadConfig({ ...base, ADMIN_PASSWORD: PASSWORD });
    expect(ok.ok && ok.config.adminPassword === PASSWORD && ok.config.adminPasswordHash === "").toBe(true);
    expect((loadConfig({ ...base, ADMIN_PASSWORD: "short" }) as { errors: string[] }).errors.join()).toContain("ADMIN_PASSWORD must be 12-1024 characters");
    const both = loadConfig({ ...base, ADMIN_PASSWORD: PASSWORD, ADMIN_PASSWORD_HASH: STRONG_HASH });
    expect(both.ok && both.config.adminPassword === "" && both.config.adminPasswordHash === STRONG_HASH).toBe(true);
    expect(both.ok && both.config.warnings.join()).toContain("ADMIN_PASSWORD is ignored");
    expect((loadConfig(base) as { errors: string[] }).errors.join()).toContain("set ADMIN_PASSWORD (12+ characters) or ADMIN_PASSWORD_HASH");
    // the password never appears in an error or a warning
    const bad = loadConfig({ ...base, ADMIN_PASSWORD: "x".repeat(1025) }) as { errors: string[] };
    expect(bad.errors.join()).not.toContain("xxxxxxxxxx");
  });

  test("resolveAdminPassword: only an argon2id hash is stored; the same password reuses it, a new one replaces it", async () => {
    const { resolveAdminPassword, ADMIN_PW_META_KEY } = await import("../src/server/auth");
    const db = new SqliteD1({ migrationsDir: join(import.meta.dir, "..", "migrations") });
    const first = resolveAdminPassword(db, PASSWORD);
    expect(first.startsWith("$argon2id$")).toBe(true);
    expect(resolveAdminPassword(db, PASSWORD)).toBe(first);
    const stored = (db.sqlite.query("SELECT v FROM meta WHERE k = ?").get(ADMIN_PW_META_KEY) as { v: string }).v;
    expect(stored).toBe(first);
    expect(JSON.stringify(db.rows("SELECT * FROM meta"))).not.toContain(PASSWORD);
    const next = resolveAdminPassword(db, "a different long password");
    expect(next).not.toBe(first);
    expect(await Bun.password.verify("a different long password", next)).toBe(true);
    expect(await Bun.password.verify(PASSWORD, next)).toBe(false);
    // a planted hash of the right password but an unreasonable cost is not reused: it is replaced
    const cheap = await Bun.password.hash("a different long password", { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });
    db.sqlite.query("UPDATE meta SET v = ? WHERE k = ?").run(cheap, ADMIN_PW_META_KEY);
    expect(resolveAdminPassword(db, "a different long password")).not.toBe(cheap);
  });
  test("config: a CRLF line end is not part of the password", () => {
    const r = loadConfig({ PUBLIC_URL: "https://d.example.org", ADMIN_PASSWORD: `${PASSWORD}\r` });
    expect(r.ok && r.config.adminPassword).toBe(PASSWORD);
  });

  test("end to end: sign in with the plain password; a restart with the same password keeps the session, a new password ends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siiswell-pw-"));
    dirs.push(dir);
    const make = (password: string) => {
      const r = loadConfig({ PUBLIC_URL: "http://localhost:8787", BIND: "127.0.0.1", PORT: "1", DATA_DIR: dir, ADMIN_PASSWORD: password, TICKER_ENABLED: "0" });
      if (!r.ok) throw new Error(r.errors.join("; "));
      return startServer({ ...r.config, port: 0 }, { RULES_MIN_INTERVAL_MS: "0", OPPORTUNISTIC_MAINTENANCE: "0" });
    };
    const a = make(PASSWORD);
    expect((await login(a, "wrong password here")).status).not.toBe(303);
    const res = await login(a);
    expect(res.status).toBe(303);
    const cookie = res.headers.getSetCookie().find((c) => /session=/.test(c))!.split(";")[0]!;
    expect((await get(a, "/api/state", { Cookie: cookie, ...ORIGIN })).status).toBe(200);
    await a.stop();
    const b = make(PASSWORD);
    expect((await get(b, "/api/state", { Cookie: cookie, ...ORIGIN })).status).toBe(200);
    await b.stop();
    const c = make("a brand new long password");
    servers.push(c);
    expect((await get(c, "/api/state", { Cookie: cookie, ...ORIGIN })).status).not.toBe(200);
  });
});
