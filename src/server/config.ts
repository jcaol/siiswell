/**
 * @file Configuration of the self-hosted (Bun / Docker) server, read from the process environment and validated at
 * startup: `loadConfig` lists EVERY missing or invalid setting at once, and the server exits instead of starting
 * half-configured. The Worker settings keep their names (PUBLIC_URL, VAPID_*, RETENTION_DAYS, ...).
 * @module server/config
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCidrs, type Cidr } from "./net";

export type AuthMode = "builtin" | "proxy";

export interface ServerConfig {
  publicUrl: string;
  /** PUBLIC_URL is https: cookies get `Secure` and the `__Host-` prefix. */
  secure: boolean;
  bind: string;
  port: number;
  dbPath: string;
  publicDir: string;
  migrationsDir: string;
  authMode: AuthMode;
  /** builtin: argon2id hash of the admin password (Bun.password). Empty when only ADMIN_PASSWORD is given: startServer
   * then fills it in (resolveAdminPassword), so the rest of the server only ever sees a hash. */
  adminPasswordHash: string;
  /** builtin: the plain ADMIN_PASSWORD, used once at startup to make or reuse the stored hash, then cleared. */
  adminPassword: string;
  /** proxy: the identity header (lower case). */
  proxyHeader: string;
  /** Peers whose X-Forwarded-For / identity header are believed (required in proxy mode, optional in builtin). */
  trustedProxies: Cidr[];
  /** proxy: allowed identities, lower case; empty = anyone the proxy lets through. */
  allowedEmails: string[];
  /** proxy: where the "Sign out" link goes (the proxy's own logout), empty = none. */
  proxyLogoutUrl: string;
  tickerEnabled: boolean;
  /** builtin: accept logins with X-Forwarded-For from an untrusted peer (all clients then share one limiter address). */
  allowUntrustedXff: boolean;
  /** proxy: verify the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) when both are set. */
  accessTeamDomain: string;
  accessAud: string;
  /** Non-fatal notes printed at startup. */
  warnings: string[];
}

export type ConfigResult = { ok: true; config: ServerConfig } | { ok: false; errors: string[] };

/** IPv4 (stored IPv4-mapped) shorter than /24, IPv6 shorter than /64. */
function isWide(c: Cidr): boolean {
  const mapped = c.addr.subarray(0, 10).every((b) => b === 0) && c.addr[10] === 0xff && c.addr[11] === 0xff && c.bits >= 96;
  return mapped ? c.bits - 96 < 24 : c.bits < 64;
}

const ROOT = join(import.meta.dir, "..", "..");
const B64U = /^[A-Za-z0-9_-]+$/;

/** Read and validate the environment. Pure: tests pass a plain object. */
/** `<dataDir>/siiswell.sqlite`; a database created before the rename (`orch-dash.sqlite`) keeps being used while no new one exists. */
export function defaultDbPath(dataDir: string, exists: (p: string) => boolean = existsSync): string {
  const current = join(dataDir, "siiswell.sqlite");
  const legacy = join(dataDir, "orch-dash.sqlite");
  return !exists(current) && exists(legacy) ? legacy : current;
}

export function loadConfig(env: Record<string, string | undefined>): ConfigResult {
  const errors: string[] = [];
  const get = (k: string): string => (env[k] ?? "").trim();

  const rawUrl = get("PUBLIC_URL");
  let publicUrl = "";
  let secure = false;
  if (!rawUrl) errors.push("PUBLIC_URL is required: the origin the dashboard is opened on, e.g. https://dash.example.com");
  else {
    try {
      const u = new URL(rawUrl);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
        errors.push(`PUBLIC_URL must be https:// (http:// only for localhost): ${rawUrl}`);
      } else if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
        errors.push(`PUBLIC_URL must be an origin (scheme + host[:port]) without path, query or credentials: ${rawUrl}`);
      } else if (u.hostname === "dash.example.com") {
        errors.push("PUBLIC_URL is still the placeholder dash.example.com");
      } else {
        publicUrl = u.origin;
        secure = u.protocol === "https:";
      }
    } catch {
      errors.push(`PUBLIC_URL is not a URL: ${rawUrl}`);
    }
  }

  const bind = get("BIND") || "127.0.0.1";
  const portRaw = get("PORT") || "8787";
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) errors.push(`PORT must be 1-65535: ${portRaw}`);

  const dataDir = get("DATA_DIR") || "/data";
  const dbPath = get("DB_PATH") || defaultDbPath(dataDir);

  const modeRaw = (get("AUTH_MODE") || "builtin").toLowerCase();
  let authMode: AuthMode = "builtin";
  if (modeRaw === "builtin" || modeRaw === "proxy") authMode = modeRaw;
  else errors.push(`AUTH_MODE must be "builtin" or "proxy": ${modeRaw}`);

  let trustedProxies: Cidr[] = [];
  const cidrRaw = get("TRUSTED_PROXY_CIDRS");
  if (cidrRaw) {
    const parsed = parseCidrs(cidrRaw);
    if (!parsed.ok) errors.push(`TRUSTED_PROXY_CIDRS has invalid entries: ${parsed.bad.join(", ")}`);
    else {
      trustedProxies = parsed.cidrs;
      const entries = cidrRaw.split(",").map((p) => p.trim()).filter(Boolean);
      const wide = entries.filter((_, i) => isWide(parsed.cidrs[i] as Cidr));
      // Both modes: proxy mode believes the identity header from these peers, builtin mode their X-Forwarded-For
      // (the login limiter's client address), so a wide range would let anyone spoof either.
      if (wide.length && get("ALLOW_WIDE_PROXY_CIDR") !== "1") {
        errors.push(
          `TRUSTED_PROXY_CIDRS entries wider than /24 (IPv4) or /64 (IPv6) trust far more than one proxy: ${wide.join(", ")}. ` +
            "Give the proxy a fixed address on a dedicated network and list it as /32 (docs/deploy.md \"Deploy with Docker\"), or set ALLOW_WIDE_PROXY_CIDR=1 if you really mean it",
        );
      }
    }
  }

  const warnings: string[] = [];
  const adminPasswordHash = get("ADMIN_PASSWORD_HASH");
  // the simple way for a first install: a plain password in .env, hashed at startup (never logged, never stored as text)
  const adminPasswordRaw = (env.ADMIN_PASSWORD ?? "").replace(/\r$/, ""); // a .env saved with CRLF line ends
  let adminPassword = "";
  const proxyHeader = (get("AUTH_PROXY_HEADER") || "x-forwarded-email").toLowerCase();
  const allowedEmails = get("ALLOWED_EMAILS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (authMode === "builtin") {
    if (!adminPasswordHash && adminPasswordRaw) {
      if (adminPasswordRaw.length < 12 || adminPasswordRaw.length > 1024) errors.push("ADMIN_PASSWORD must be 12-1024 characters (a long random one is best)");
      else adminPassword = adminPasswordRaw;
    } else if (!adminPasswordHash) errors.push("AUTH_MODE=builtin needs an admin password: set ADMIN_PASSWORD (12+ characters) or ADMIN_PASSWORD_HASH (bun scripts/hash-password.ts) in .env");
    else if (!adminPasswordHash.startsWith("$argon2id$")) errors.push("ADMIN_PASSWORD_HASH must be an argon2id hash ($argon2id$...) from bun scripts/hash-password.ts");
    else {
      // The password itself cannot be checked from its hash (hash-password.ts insists on 12+ characters); the cost can.
      const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=\d+\$/.exec(adminPasswordHash);
      if (!m || Number(m[1]) < 19_456 || Number(m[2]) < 2) {
        errors.push("ADMIN_PASSWORD_HASH is too cheap to compute (needs argon2id m >= 19456 KiB, t >= 2): make it with bun scripts/hash-password.ts");
      }
    }
    if (adminPasswordHash && adminPasswordRaw) warnings.push("ADMIN_PASSWORD is ignored because ADMIN_PASSWORD_HASH is set; remove one of them");
  } else if (authMode === "proxy") {
    if (!cidrRaw) errors.push("TRUSTED_PROXY_CIDRS is required with AUTH_MODE=proxy (the address(es) of the reverse proxy that sets the identity header)");
    if (!/^[a-z0-9-]{1,64}$/.test(proxyHeader)) errors.push(`AUTH_PROXY_HEADER is not a header name: ${proxyHeader}`);
    const badEmail = allowedEmails.filter((e) => !/^[^\s@,]+@[^\s@,]+$/.test(e));
    if (badEmail.length) errors.push(`ALLOWED_EMAILS has invalid entries: ${badEmail.join(", ")}`);
  }

  const accessTeamDomain = get("ACCESS_TEAM_DOMAIN");
  const accessAud = get("ACCESS_AUD");
  if (Boolean(accessTeamDomain) !== Boolean(accessAud)) errors.push("ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set together (proxy mode behind Cloudflare Access) or not at all");
  if (accessTeamDomain && authMode !== "proxy") errors.push("ACCESS_TEAM_DOMAIN / ACCESS_AUD are only used with AUTH_MODE=proxy");
  if (authMode === "proxy" && proxyHeader.startsWith("cf-access-") && !(accessTeamDomain && accessAud)) {
    warnings.push(`${proxyHeader} is trusted WITHOUT verifying the Access JWT: set ACCESS_TEAM_DOMAIN and ACCESS_AUD to verify it`);
  }

  const vapid = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"].map(get);
  if (vapid.some(Boolean)) {
    const [pub, priv, subj] = vapid as [string, string, string];
    if (!vapid.every(Boolean)) errors.push("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together (or none: no phone pushes)");
    if (pub && !(B64U.test(pub) && Buffer.from(pub, "base64url").length === 65)) errors.push("VAPID_PUBLIC_KEY must be base64url of a 65-byte P-256 point (bun scripts/vapid.ts)");
    if (priv && !(B64U.test(priv) && Buffer.from(priv, "base64url").length === 32)) errors.push("VAPID_PRIVATE_KEY must be base64url of 32 bytes (bun scripts/vapid.ts)");
    if (subj && !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subj)) errors.push("VAPID_SUBJECT must be mailto:you@example.com or an https URL");
  }

  for (const [k, min] of [["RETENTION_DAYS", 1], ["USAGE_RETENTION_DAYS", 31], ["RULES_MIN_INTERVAL_MS", 0]] as const) {
    const v = get(k);
    if (v && !(/^\d+$/.test(v) && Number(v) >= min)) errors.push(`${k} must be a whole number >= ${min}: ${v}`);
  }
  for (const k of ["TICKER_ENABLED", "OPPORTUNISTIC_MAINTENANCE", "ALLOW_WIDE_PROXY_CIDR", "ALLOW_UNTRUSTED_XFF"]) {
    const v = get(k);
    if (v && v !== "0" && v !== "1") errors.push(`${k} must be "0" or "1": ${v}`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      publicUrl,
      secure,
      bind,
      port,
      dbPath,
      publicDir: get("PUBLIC_DIR") || join(ROOT, "public"),
      migrationsDir: join(ROOT, "migrations"),
      authMode,
      adminPasswordHash,
      adminPassword,
      proxyHeader,
      trustedProxies,
      allowedEmails,
      proxyLogoutUrl: get("AUTH_PROXY_LOGOUT_URL"),
      tickerEnabled: get("TICKER_ENABLED") !== "0",
      allowUntrustedXff: get("ALLOW_UNTRUSTED_XFF") === "1",
      accessTeamDomain,
      accessAud,
      warnings,
    },
  };
}

/** The Worker variables the app reads, passed through by name (validated above where it matters). */
export const PASSTHROUGH_VARS = [
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "PUSH_ALLOWED_HOSTS",
  "MCP_ALLOWED_ORIGINS",
  "RULES_MIN_INTERVAL_MS",
  "RETENTION_DAYS",
  "USAGE_RETENTION_DAYS",
  "OPPORTUNISTIC_MAINTENANCE",
  "TICKER_ENABLED",
  "WELLBEING_PUSH_POLICY",
  "OTLP_INGEST",
  "DASHBOARD_TZ",
  "ACCEPT_LAST_LINE",
  "ACCEPT_TASK_TEXT",
  "ACCEPT_HOST_TEXT",
] as const;
