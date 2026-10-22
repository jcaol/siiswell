/**
 * @file Browser authentication of the self-hosted server, in place of Cloudflare Access (the Worker keeps Access).
 * @module server/auth
 *
 * AUTH_MODE=builtin (default): ONE admin, password checked against ADMIN_PASSWORD_HASH (argon2id, Bun.password).
 *   - Sessions live server-side in SQLite (`auth_sessions`, only the sha256 of the cookie value is stored); the cookie
 *     is HttpOnly, SameSite=Lax, Path=/, and Secure + `__Host-` prefixed when PUBLIC_URL is https.
 *   - A session ends after SESSION_IDLE_MS without a request or SESSION_MAX_MS after login, whichever comes first.
 *   - Failed logins are capped per client address (LOGIN_MAX_FAILURES per LOGIN_WINDOW_MS) and, looser, per public
 *     /24 (IPv4) or /64 (IPv6) (LOGIN_MAX_AGGREGATE_FAILURES); IPv4 written as IPv6 counts as that IPv4 (net.ts
 *     rateKeys). A browser with a valid known-device cookie is counted per device instead, so nobody sharing the
 *     admin's address or prefix can lock that browser out. Every slot (address, prefix, device, global) is reserved
 *     BEFORE the password check and given back on success, so parallel requests cannot slip under a cap.
 *   - Recovery: after a password change every known-device cookie is void; scripts/recovery-token.ts stores a one-time
 *     code (sha256 only, 24 h, LOGIN_MAX_FAILURES tries) whose login skips the address / prefix / global limits once.
 *   - A global budget of failed attempts (LOGIN_GLOBAL_FAILURES_PER_MINUTE) bounds a distributed guesser. When it is
 *     spent, only browsers WITHOUT a "known device" cookie are refused (429): a successful login sets that cookie
 *     (HMAC-signed with a per-database secret and bound to the password hash, KNOWN_DEVICE_MS, not a session: it opens
 *     nothing), so a browser that has signed in before keeps signing in whatever others do (a NEW browser can be held
 *     off for up to a minute, or LOGIN_WINDOW_MS behind a shared address: the recovery code below covers that).
 *   - Behind a reverse proxy, TRUSTED_PROXY_CIDRS MUST name the proxy: otherwise every client has the proxy's address
 *     and anyone could exhaust "its" cap. A login carrying X-Forwarded-For from a peer that is not a trusted proxy is
 *     therefore REFUSED (403, logged at most once a minute) unless ALLOW_UNTRUSTED_XFF=1.
 *   - The real defence is a long random password (scripts/hash-password.ts insists on 12+ characters).
 *   - Password hashing is deliberately slow, so at most LOGIN_MAX_CONCURRENT_VERIFIES argon2 checks run at once and a
 *     short queue waits (503 beyond it). The counters are in memory, right for the single replica this server is.
 *   - POST /auth/login and /auth/logout must be same-origin (Origin = PUBLIC_URL; an absent or "null" Origin only with
 *     Sec-Fetch-Site: same-origin). The pages use Referrer-Policy same-origin (no-referrer makes Chrome send Origin: null).
 * AUTH_MODE=proxy: a reverse proxy (oauth2-proxy, Tailscale serve, Cloudflare Access in front of Docker, ...) has
 *   authenticated the user and names them in AUTH_PROXY_HEADER. The header is believed ONLY when the TCP peer is in
 *   TRUSTED_PROXY_CIDRS (the server refuses to start without it); ALLOWED_EMAILS, when set, must list the identity.
 *   Behind Cloudflare Access (ACCESS_TEAM_DOMAIN + ACCESS_AUD set) the Access JWT in Cf-Access-Jwt-Assertion is
 *   verified as the Worker does (src/auth.ts verifyAccessJwt) and its identity must equal the header's.
 * Ingest and MCP keep their bearer tokens (src/auth.ts): this module never sees those routes.
 */
import { verifyAccessJwt, type FetchLike } from "../auth";
import { errorJson, sha256Hex } from "../util";
import type { ServerConfig } from "./config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ipInCidrs, rateKeys, type RateKeys } from "./net";
import type { SqliteD1 } from "./d1-sqlite";

export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60_000;
/** last_seen is rewritten at most this often (not on every request). */
const SESSION_TOUCH_MS = 60_000;
export const LOGIN_MAX_FAILURES = 5;
/** Failures per LOGIN_WINDOW_MS of a whole public /24 (IPv4) or /64 (IPv6), on top of the per-address cap. */
export const LOGIN_MAX_AGGREGATE_FAILURES = 50;
/** One-time recovery codes (scripts/recovery-token.ts): `orr_` + 43 base64url characters, valid this long. */
export const RECOVERY_RE = /^orr_[A-Za-z0-9_-]{43}$/;
export const RECOVERY_TTL_MS = 24 * 60 * 60_000;
/** Recovery-code login attempts per minute, all codes together (they skip the other limits). */
export const LOGIN_RECOVERY_ATTEMPTS_PER_MINUTE = 10;
/** Most failure counters (address / prefix / device keys) held in memory. */
export const MAX_FAILURE_KEYS = 10_000;
/** Distinct addresses tracked per public /24 | /64; further ones are limited by the prefix counter alone. */
export const MAX_IP_KEYS_PER_NET = 64;

/** One counter an attempt is charged to: its key, its cap and, for an address, the prefix it belongs to. */
interface Charge {
  k: string;
  cap: number;
  net?: string;
}

/** The address charges of a client: the exact address, and its /24 | /64 when that differs (public addresses). */
function addressCharges(keys: RateKeys): Charge[] {
  if (keys.aggregate === keys.exact) return [{ k: `ip:${keys.exact}`, cap: LOGIN_MAX_FAILURES }];
  const net = `net:${keys.aggregate}`;
  return [
    { k: net, cap: LOGIN_MAX_AGGREGATE_FAILURES },
    { k: `ip:${keys.exact}`, cap: LOGIN_MAX_FAILURES, net },
  ];
}
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Failed attempts per minute, all clients together, before clients without a known-device cookie are refused. */
export const LOGIN_GLOBAL_FAILURES_PER_MINUTE = 100;
/** Lifetime of the known-device cookie (not a session: it only exempts its browser from the shared limits). */
export const KNOWN_DEVICE_MS = 30 * 24 * 60 * 60_000;
/** argon2id verifies running at once, and how many may wait for a slot (beyond: 503 + Retry-After). */
export const LOGIN_MAX_CONCURRENT_VERIFIES = 2;
export const LOGIN_MAX_QUEUED_VERIFIES = 32;
const MAX_IDENTITY_LEN = 320;

export type Identify = { ok: true; identity: string } | { ok: false; status: 401 | 403; reason: string };

/** Recovery codes: only the sha256 is stored; used_at set by the login that used it; fails = tries made with it. */
export const RECOVERY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS auth_recovery (
    id_sha256 TEXT PRIMARY KEY,
    created   INTEGER NOT NULL,
    expires   INTEGER NOT NULL,
    used_at   INTEGER,
    fails     INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`;

export function ensureSessionTable(db: SqliteD1): void {
  db.sqlite.exec(RECOVERY_TABLE_SQL);
  db.sqlite.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
    id_sha256 TEXT PRIMARY KEY,
    created   INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ip        TEXT NOT NULL DEFAULT '',
    pw_fp     TEXT NOT NULL DEFAULT ''
  ) WITHOUT ROWID`);
  const cols = db.sqlite.query("PRAGMA table_info(auth_sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "pw_fp")) db.sqlite.exec("ALTER TABLE auth_sessions ADD COLUMN pw_fp TEXT NOT NULL DEFAULT ''");
}

/** meta key of the argon2id hash made from a plain ADMIN_PASSWORD (only a hash is ever stored). */
export const ADMIN_PW_META_KEY = "auth:admin_pw_hash";

/**
 * The argon2id hash for a plain ADMIN_PASSWORD. The hash made at an earlier start is reused while the password still
 * matches it, so sessions and known-device cookies (both bound to the hash) survive a restart; a changed password gets
 * a new hash, which ends every session as rotating ADMIN_PASSWORD_HASH does. The password itself is never stored.
 */
export function resolveAdminPassword(db: SqliteD1, password: string, now = Date.now()): string {
  const row = db.sqlite.query("SELECT v FROM meta WHERE k = ?").get(ADMIN_PW_META_KEY) as { v: string } | null;
  // reuse only a hash of sane cost (the same floor as ADMIN_PASSWORD_HASH, and a ceiling against a planted, costly one)
  const cost = row ? /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=\d+\$/.exec(row.v) : null;
  const sane = cost && Number(cost[1]) >= 19_456 && Number(cost[1]) <= 262_144 && Number(cost[2]) >= 2 && Number(cost[2]) <= 10;
  if (row && sane && Bun.password.verifySync(password, row.v)) return row.v;
  const hash = Bun.password.hashSync(password, { algorithm: "argon2id" });
  db.sqlite.query("INSERT INTO meta (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated").run(ADMIN_PW_META_KEY, hash, now);
  return hash;
}

/** Fingerprint of ADMIN_PASSWORD_HASH stored with each session: rotating the password ends every session. */
export function passwordFingerprint(hash: string): string {
  return new Bun.CryptoHasher("sha256").update(hash).digest("hex");
}

const LOGIN_CSS = `:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1b1f24;--card:#fff;--line:#d0d7de;--accent:#2563eb;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--fg:#e6e8eb;--card:#171a1f;--line:#2d333b;--accent:#5b8def;--bad:#f97066}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px}
h1{font-size:1.2rem;margin:0}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button{background:var(--accent);color:#fff;border:0;cursor:pointer}.err{color:var(--bad);margin:0}
.tag{margin:-6px 0 4px;font-size:.85rem;opacity:.7;font-style:italic}`;

const PAGE_CSP = "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function page(title: string, body: string, status = 200, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><title>${title}</title><link rel="stylesheet" href="/auth/login.css"></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PAGE_CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // same-origin, NOT no-referrer: under no-referrer Chrome submits the login form with `Origin: null`, which the cross-site
      // check refuses. same-origin still sends nothing to another site.
      "Referrer-Policy": "same-origin",
      ...extra,
    },
  });
}

const loginPage = (error = "", status = 200, extra: Record<string, string> = {}) =>
  page(
    "Sign in",
    `<form method="post" action="/auth/login"><h1>siiswell</h1><p class="tag">SI is well, I am well, all is well.</p>${error ? `<p class="err" role="alert">${error}</p>` : ""}` +
      `<label for="pw">Admin password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>` +
      `<details><summary>Recovery code</summary><input name="recovery" autocomplete="off" spellcheck="false" placeholder="orr_..." aria-label="Recovery code"></details>` +
      `<button type="submit">Sign in</button></form>`,
    status,
    extra,
  );

const logoutPage = () =>
  page("Sign out", `<form method="post" action="/auth/logout"><h1>Sign out?</h1><button type="submit">Sign out</button></form>`);

function redirect(to: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store", ...extra } });
}

/** A fixed-window counter: `n` events since `start`; the window restarts on the first event after it ended. */
export class WindowCounter {
  private start = 0;
  private n = 0;
  constructor(private readonly windowMs: number) {}

  private roll(now: number): void {
    if (now - this.start >= this.windowMs) {
      this.start = now;
      this.n = 0;
    }
  }
  /** At least `cap` events in the current window? */
  full(cap: number, now: number): boolean {
    this.roll(now);
    return this.n >= cap;
  }
  /** Count one event (a reserved slot); returns the window it was taken in, for giveBack. */
  take(now: number): number {
    this.roll(now);
    this.n++;
    return this.start;
  }
  /** Return a slot taken by take() (a success); no-op once that window has ended. */
  giveBack(window: number): void {
    if (window === this.start) this.n = Math.max(0, this.n - 1);
  }
  /** Seconds until the window ends (>= 1). */
  retryAfter(now: number): number {
    return Math.max(1, Math.ceil((this.start + this.windowMs - now) / 1000));
  }
  expired(now: number): boolean {
    return now - this.start >= this.windowMs;
  }
}

export class BrowserAuth {
  /** Failure counters per `ip:` / `net:` / `dev:` key, LOGIN_WINDOW_MS each. */
  private readonly failures = new Map<string, WindowCounter>();
  private verifying = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly pwFp: string;
  private lastForwardedWarning = -Infinity;
  private readonly globalFailures = new WindowCounter(60_000);
  private readonly recoveryAttempts = new WindowCounter(60_000);
  /** Known-device failure counters, apart from the address map: never in the overflow, bounded by expiry. */
  private readonly devFailures = new Map<string, WindowCounter>();
  /** `ip:` key -> its `net:` prefix key, and how many `ip:` keys each prefix holds (MAX_IP_KEYS_PER_NET). */
  private readonly ipNet = new Map<string, string>();
  private readonly ipKeysPerNet = new Map<string, number>();
  /** Shared by every new address / prefix key while the failure map is full (see reserve()). */
  private readonly overflow = new WindowCounter(LOGIN_WINDOW_MS);
  private readonly deviceKey: Buffer = Buffer.alloc(0);
  readonly cookieName: string;
  readonly deviceCookieName: string;
  private readonly legacyCookieName: string;
  private readonly legacyDeviceCookieName: string;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly db: SqliteD1,
    private readonly clock: () => number = Date.now,
    private readonly fetchImpl?: FetchLike,
  ) {
    const prefix = cfg.secure ? "__Host-" : "";
    this.cookieName = `${prefix}siiswell_session`;
    this.deviceCookieName = `${prefix}siiswell_device`;
    // cookies issued before the rename are still accepted (read only; the next sign-in sets the new names)
    this.legacyCookieName = `${prefix}orch_session`;
    this.legacyDeviceCookieName = `${prefix}orch_device`;
    this.pwFp = passwordFingerprint(cfg.adminPasswordHash);
    if (cfg.authMode === "builtin") {
      ensureSessionTable(db);
      const gone = db.sqlite.query("DELETE FROM auth_sessions WHERE pw_fp != ?").run(this.pwFp).changes;
      if (gone) console.log(`siiswell: ADMIN_PASSWORD_HASH changed, ended ${gone} session(s)`);
      db.sqlite.exec("CREATE TABLE IF NOT EXISTS auth_secret (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
      db.sqlite.query("INSERT OR IGNORE INTO auth_secret (k, v) VALUES ('device', ?)").run(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"));
      this.deviceKey = Buffer.from((db.sqlite.query("SELECT v FROM auth_secret WHERE k = 'device'").get() as { v: string }).v, "base64url");
    }
  }

  /** Who is making this request (`peer` = the TCP peer address: proxy mode believes the header only from a trusted one). */
  async identify(req: Request, peer: string): Promise<Identify> {
    if (this.cfg.authMode === "proxy") return this.identifyProxy(req, peer);
    const sid = this.cookie(req);
    if (!sid) return { ok: false, status: 401, reason: "not signed in" };
    const now = this.clock();
    const id = await sha256Hex(sid);
    const row = this.db.sqlite.query("SELECT created, last_seen, pw_fp FROM auth_sessions WHERE id_sha256 = ?").get(id) as
      | { created: number; last_seen: number; pw_fp: string }
      | null;
    if (!row || row.pw_fp !== this.pwFp) return { ok: false, status: 401, reason: "session expired" };
    if (now - row.created >= SESSION_MAX_MS || now - row.last_seen >= SESSION_IDLE_MS) {
      this.db.sqlite.query("DELETE FROM auth_sessions WHERE id_sha256 = ?").run(id);
      return { ok: false, status: 401, reason: "session expired" };
    }
    if (now - row.last_seen >= SESSION_TOUCH_MS) this.db.sqlite.query("UPDATE auth_sessions SET last_seen = ? WHERE id_sha256 = ?").run(now, id);
    return { ok: true, identity: "admin" };
  }

  private async identifyProxy(req: Request, peer: string): Promise<Identify> {
    if (!ipInCidrs(peer, this.cfg.trustedProxies)) return { ok: false, status: 403, reason: "request did not come through the trusted proxy" };
    const raw = (req.headers.get(this.cfg.proxyHeader) ?? "").trim();
    // eslint-disable-next-line no-control-regex
    if (!raw || raw.length > MAX_IDENTITY_LEN || /[\x00-\x1f\x7f,]/.test(raw)) return { ok: false, status: 401, reason: "no identity from the proxy" };
    const identity = raw.toLowerCase();
    if (this.cfg.allowedEmails.length && !this.cfg.allowedEmails.includes(identity)) return { ok: false, status: 403, reason: "identity not allowed" };
    if (this.cfg.accessTeamDomain && this.cfg.accessAud) {
      const v = await verifyAccessJwt(
        req.headers.get("cf-access-jwt-assertion"),
        { ACCESS_TEAM_DOMAIN: this.cfg.accessTeamDomain, ACCESS_AUD: this.cfg.accessAud, ACCESS_ALLOWED_EMAILS: this.cfg.allowedEmails.join(",") },
        this.clock(),
        this.fetchImpl,
      );
      if (!v.ok) return { ok: false, status: v.reason === "no-jwt" ? 401 : 403, reason: v.reason === "certs-unavailable" ? "access certificates unavailable" : "access denied" };
      if (v.identity.trim().toLowerCase() !== identity) return { ok: false, status: 403, reason: "identity header does not match the Access token" };
    }
    return { ok: true, identity };
  }

  /** /auth/* (and the Access logout path the page links to). null = not an auth route. */
  async handle(req: Request, path: string, ip: string, peer: string = ip): Promise<Response | null> {
    if (path === "/auth/login.css") {
      return new Response(LOGIN_CSS, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    }
    if (path === "/cdn-cgi/access/logout") {
      // public/index.html links "Sign out" to Cloudflare Access's logout path; send it to this server's equivalent.
      if (this.cfg.authMode === "builtin") return redirect("/auth/logout");
      return this.cfg.proxyLogoutUrl ? redirect(this.cfg.proxyLogoutUrl) : errorJson(404, "sign out at your proxy");
    }
    if (!path.startsWith("/auth/")) return null;
    if (this.cfg.authMode !== "builtin") return errorJson(404, "not found");
    if (path === "/auth/login") {
      if (req.method === "GET") return loginPage();
      if (req.method !== "POST") return errorJson(405, "GET or POST", { Allow: "GET, POST" });
      if (!this.sameOrigin(req)) return errorJson(403, "cross-site request refused");
      if (this.noteForwarded(req, peer) && !this.cfg.allowUntrustedXff) {
        return loginPage("Sign-in is disabled: this server is behind a proxy that is not in TRUSTED_PROXY_CIDRS. Ask the operator to set it.", 403);
      }
      return this.login(req, ip);
    }
    if (path === "/auth/logout") {
      if (req.method === "GET") return logoutPage();
      if (req.method !== "POST") return errorJson(405, "GET or POST", { Allow: "GET, POST" });
      if (!this.sameOrigin(req)) return errorJson(403, "cross-site request refused");
      // every session the browser carries, under the current AND the pre-rename cookie name: none may survive
      for (const sid of this.sessionCookies(req)) this.db.sqlite.query("DELETE FROM auth_sessions WHERE id_sha256 = ?").run(await sha256Hex(sid));
      const res = redirect("/auth/login", { "Set-Cookie": this.setCookie("", 0) });
      res.headers.append("Set-Cookie", `${this.legacyCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${this.cfg.secure ? "; Secure" : ""}`);
      return res;
    }
    return errorJson(404, "not found");
  }

  private async login(req: Request, ip: string): Promise<Response> {
    let password = "";
    let recovery = "";
    try {
      const text = await req.text();
      if (text.length <= 4096) {
        const form = new URLSearchParams(text);
        password = form.get("password") ?? "";
        recovery = (form.get("recovery") ?? "").trim();
      }
    } catch {
      /* unreadable body = wrong password */
    }
    const now = this.clock();
    const keys = rateKeys(ip);
    const device = this.knownDevice(req, now);
    // The code's row id; whether it is usable is decided by the atomic reservation below, never by an earlier read.
    const recoveryId = recovery ? (RECOVERY_RE.test(recovery) ? await sha256Hex(recovery) : "") : null;
    const badRecovery = () => loginPage("That recovery code is not valid (unknown, used, expired or tried too often).", 403);
    if (recoveryId === "") return badRecovery(); // malformed: costs nothing anyone else depends on

    // Which counters this attempt is charged to, and their caps. A recovery code skips them all (it has its own
    // tries, below); a known device has its own counter instead of the address ones, so nobody sharing the admin's
    // address or prefix can lock that browser out.
    // The checks only READ counters (a request that is refused or never reserves creates nothing).
    const counters: Charge[] = recoveryId ? [] : device ? [{ k: `dev:${device}`, cap: LOGIN_MAX_FAILURES }] : addressCharges(keys);
    const refused = this.checkCaps(counters, now);
    if (refused) return refused;
    const global = !recoveryId && !device;
    if (global && this.globalFailures.full(LOGIN_GLOBAL_FAILURES_PER_MINUTE, now)) {
      const retry = this.globalFailures.retryAfter(now);
      return loginPage("Too many failed sign-ins right now. Try again shortly, or use a recovery code.", 429, { "Retry-After": String(retry) });
    }
    if (this.verifying >= LOGIN_MAX_CONCURRENT_VERIFIES && this.waiters.length >= LOGIN_MAX_QUEUED_VERIFIES) {
      return loginPage("Busy. Try again in a moment.", 503, { "Retry-After": "5" });
    }

    if (recoveryId) {
      // Recovery attempts have their own small global cap, then the code's try is reserved ATOMICALLY: the UPDATE
      // only matches an unused, unexpired code with tries left, so concurrent attempts cannot overrun its tries.
      if (this.recoveryAttempts.full(LOGIN_RECOVERY_ATTEMPTS_PER_MINUTE, now)) {
        return loginPage("Too many recovery attempts. Try again shortly.", 429, { "Retry-After": String(this.recoveryAttempts.retryAfter(now)) });
      }
      const reserved = this.db.sqlite
        .query("UPDATE auth_recovery SET fails = fails + 1 WHERE id_sha256 = ? AND used_at IS NULL AND expires > ? AND fails < ?")
        .run(recoveryId, now, LOGIN_MAX_FAILURES).changes;
      if (reserved !== 1) {
        // An unknown / used / expired code: charged to the caller's own address and prefix like a wrong password, NOT
        // to the shared recovery budget (codes are 256-bit random, so guessing them is pointless, and a flood of bogus
        // codes must not block the real one). Its tries are bounded per code (fails < LOGIN_MAX_FAILURES).
        // Like any wrong attempt: refused once the global failure budget is spent, BEFORE any counter is created (no
        // argon2 is spent here, so without this a flood of fake codes from many prefixes would fill the map cheaply).
        if (this.globalFailures.full(LOGIN_GLOBAL_FAILURES_PER_MINUTE, now)) {
          return loginPage("Too many failed sign-ins right now. Try again shortly.", 429, { "Retry-After": String(this.globalFailures.retryAfter(now)) });
        }
        const own = addressCharges(keys);
        const capped = this.checkCaps(own, now);
        if (capped) return capped;
        this.reserve(own, now);
        this.globalFailures.take(now); // and the global failure budget, like any wrong attempt
        return badRecovery();
      }
      this.recoveryAttempts.take(now); // only a real code's try counts against the shared recovery budget
    }
    // Reserve EVERYTHING before the first await: concurrent attempts each take their slot of every cap (address,
    // prefix, device, global, recovery code), and a success gives its slots back.
    const taken = this.reserve(counters, now);
    const globalWindow = global ? this.globalFailures.take(now) : null;

    let ok = false;
    if (password.length > 0 && password.length <= 1024) {
      await this.acquireVerify();
      try {
        ok = await Bun.password.verify(password, this.cfg.adminPasswordHash);
      } catch {
        ok = false;
      } finally {
        this.releaseVerify();
      }
    }
    if (!ok) return loginPage("Wrong password.", 401);

    for (const [c, w] of taken) c.giveBack(w);
    // A success also forgets the earlier failures of this address / device (not of the shared prefix).
    if (device) this.devFailures.delete(`dev:${device}`);
    else this.dropKey(`ip:${keys.exact}`);
    if (globalWindow !== null) this.globalFailures.giveBack(globalWindow);
    // Consume atomically: of two concurrent right-password attempts with one code, only one may sign in.
    if (recoveryId && this.db.sqlite.query("UPDATE auth_recovery SET used_at = ? WHERE id_sha256 = ? AND used_at IS NULL").run(now, recoveryId).changes !== 1) {
      return badRecovery();
    }
    this.db.sqlite.query("DELETE FROM auth_sessions WHERE created <= ? OR last_seen <= ?").run(now - SESSION_MAX_MS, now - SESSION_IDLE_MS);
    const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.db.sqlite.query("INSERT INTO auth_sessions (id_sha256, created, last_seen, ip, pw_fp) VALUES (?, ?, ?, ?, ?)").run(await sha256Hex(sid), now, now, ip.slice(0, 64), this.pwFp);
    const res = redirect("/");
    res.headers.append("Set-Cookie", this.setCookie(sid, Math.floor(SESSION_MAX_MS / 1000)));
    res.headers.append("Set-Cookie", this.deviceCookie(now));
    return res;
  }

  private deviceMac(exp: number): Buffer {
    return createHmac("sha256", this.deviceKey).update(`known-device|${exp}|${this.pwFp}`).digest();
  }

  private deviceCookie(now: number): string {
    const exp = now + KNOWN_DEVICE_MS;
    const v = `${exp}.${Buffer.from(this.deviceMac(exp)).toString("base64url")}`;
    return `${this.deviceCookieName}=${v}; Path=/; Max-Age=${Math.floor(KNOWN_DEVICE_MS / 1000)}; HttpOnly; SameSite=Strict${this.cfg.secure ? "; Secure" : ""}`;
  }

  /**
   * A valid, unexpired known-device cookie signed by this database's secret for the current password hash: its id
   * (the MAC, which names one device's sign-in) for the per-device counter, else null.
   */
  private knownDevice(req: Request, now: number): string | null {
    const v = this.readCookie(req, this.deviceCookieName) ?? this.readCookie(req, this.legacyDeviceCookieName);
    const m = v ? /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(v) : null;
    if (!m) return null;
    const exp = Number(m[1]);
    if (!(exp > now)) return null;
    const got = Buffer.from(m[2] as string, "base64url");
    const want = this.deviceMac(exp);
    return got.length === want.length && timingSafeEqual(got, want) ? (m[2] as string) : null;
  }

  private acquireVerify(): Promise<void> {
    if (this.verifying < LOGIN_MAX_CONCURRENT_VERIFIES) {
      this.verifying++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve)); // the slot is handed over by releaseVerify
  }

  private releaseVerify(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.verifying--;
  }

  /**
   * Builtin mode: does this request carry X-Forwarded-For from a peer that is NOT a trusted proxy? Then the server sits
   * behind a proxy it was not told about (every client would share the proxy's address and its login cap) or somebody
   * forges the header. Logged loudly, at most once a minute (every burst, not only the first). True = untrusted XFF.
   */
  noteForwarded(req: Request, peer: string): boolean {
    if (this.cfg.authMode !== "builtin" || !req.headers.has("x-forwarded-for") || ipInCidrs(peer, this.cfg.trustedProxies)) return false;
    const now = this.clock();
    if (now - this.lastForwardedWarning >= 60_000) {
      this.lastForwardedWarning = now;
      console.warn(
        `siiswell: WARNING: X-Forwarded-For from ${peer || "?"}, which is not in TRUSTED_PROXY_CIDRS. Behind a reverse proxy you MUST set ` +
          `TRUSTED_PROXY_CIDRS=<proxy address>/32; until then logins with this header are refused${this.cfg.allowUntrustedXff ? " (ALLOW_UNTRUSTED_XFF=1: allowed, all clients share one rate-limit address)" : ""}.`,
      );
    }
    return true;
  }

  /**
   * The counter a check reads (never creates): a device key from the device map; an address / prefix key from the
   * failure map, or, when that key is absent and the map is full, the shared overflow counter (fail closed for keys
   * that could not be created).
   */
  private peek(k: string, now: number): WindowCounter | null {
    if (k.startsWith("dev:")) return this.devFailures.get(k) ?? null;
    const c = this.failures.get(k);
    if (c) return c;
    if (this.failures.size >= MAX_FAILURE_KEYS) {
      this.pruneFailures(now);
      if (this.failures.size >= MAX_FAILURE_KEYS) return this.overflow;
    }
    return null;
  }

  private checkCaps(charges: readonly Charge[], now: number): Response | null {
    for (const { k, cap } of charges) {
      const c = this.peek(k, now);
      if (c?.full(cap, now)) return loginPage("Too many attempts. Try again later.", 429, { "Retry-After": String(c.retryAfter(now)) });
    }
    return null;
  }

  /**
   * Take one slot of each charge, creating counters only here. Order matters: the prefix (`net:`) first, then the
   * address (`ip:`), which is tracked only while its prefix holds fewer than MAX_IP_KEYS_PER_NET addresses (beyond
   * that the prefix counter alone limits them, so one /64 cannot fill the map). Device keys (HMAC-verified cookies)
   * live in their own map and never fall into the overflow. Returns what to give back on success.
   */
  private reserve(charges: readonly Charge[], now: number): [WindowCounter, number][] {
    const taken: [WindowCounter, number][] = [];
    const ordered = [...charges].sort((a, b) => (a.k.startsWith("net:") ? 0 : 1) - (b.k.startsWith("net:") ? 0 : 1));
    for (const { k, net } of ordered) {
      let c: WindowCounter | null;
      if (k.startsWith("dev:")) {
        c = this.devFailures.get(k) ?? null;
        if (!c) {
          if (this.devFailures.size >= MAX_FAILURE_KEYS) for (const [dk, dv] of this.devFailures) if (dv.expired(now)) this.devFailures.delete(dk);
          this.devFailures.set(k, (c = new WindowCounter(LOGIN_WINDOW_MS)));
        }
      } else {
        c = this.failures.get(k) ?? null;
        if (!c) {
          if (net && (this.ipKeysPerNet.get(net) ?? 0) >= MAX_IP_KEYS_PER_NET) continue; // the prefix counter covers it
          if (this.failures.size >= MAX_FAILURE_KEYS) this.pruneFailures(now);
          if (this.failures.size >= MAX_FAILURE_KEYS) c = this.overflow;
          else {
            this.failures.set(k, (c = new WindowCounter(LOGIN_WINDOW_MS)));
            if (net) {
              this.ipNet.set(k, net);
              this.ipKeysPerNet.set(net, (this.ipKeysPerNet.get(net) ?? 0) + 1);
            }
          }
        }
      }
      taken.push([c, c.take(now)]);
    }
    return taken;
  }

  /** Forget a failure-map key (and its per-prefix bookkeeping). */
  private dropKey(k: string): void {
    if (!this.failures.delete(k)) return;
    const net = this.ipNet.get(k);
    if (net === undefined) return;
    this.ipNet.delete(k);
    const n = (this.ipKeysPerNet.get(net) ?? 1) - 1;
    if (n > 0) this.ipKeysPerNet.set(net, n);
    else this.ipKeysPerNet.delete(net);
  }

  /** Drop ended windows only: a counter still in force (a lockout) is never evicted. */
  private pruneFailures(now: number): void {
    for (const [k, v] of this.failures) if (v.expired(now)) this.dropKey(k);
  }

  /** Tests: how many failure counters are held. */
  get failureKeys(): number {
    return this.failures.size + this.devFailures.size;
  }

  private sameOrigin(req: Request): boolean {
    // A real Origin must be ours. An absent or opaque one ("null": a form posted under a no-referrer policy, a sandboxed frame) is
    // accepted only with the browser's own `Sec-Fetch-Site: same-origin`; cross-site, same-site, none or missing are refused.
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== "null") return origin === this.cfg.publicUrl;
    return (req.headers.get("sec-fetch-site") ?? "").toLowerCase() === "same-origin";
  }

  private cookie(req: Request): string | null {
    const ok = (v: string | null) => (v && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null);
    return ok(this.readCookie(req, this.cookieName)) ?? ok(this.readCookie(req, this.legacyCookieName));
  }

  /** Every well-formed session id the request carries (current and legacy cookie names, deduplicated). */
  private sessionCookies(req: Request): string[] {
    const ids = [this.readCookie(req, this.cookieName), this.readCookie(req, this.legacyCookieName)].filter((v): v is string => !!v && /^[A-Za-z0-9_-]{43}$/.test(v));
    return [...new Set(ids)];
  }

  private readCookie(req: Request, name: string): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
  }

  private setCookie(value: string, maxAge: number): string {
    return `${this.cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${this.cfg.secure ? "; Secure" : ""}`;
  }
}
