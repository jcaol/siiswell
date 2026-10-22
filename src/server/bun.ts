/**
 * @file The self-hosted server: Bun.serve in front of the same runtime-neutral `route()` the Worker runs.
 * @module server/bun
 *
 *   bun src/server/bun.ts            (configuration from the environment, see config.ts and docs/deploy.md "Deploy with Docker")
 *
 * What replaces each Cloudflare piece:
 *  - D1          -> SQLite file (DB_PATH, default /data/siiswell.sqlite) through d1-sqlite.ts; migrations at startup.
 *  - assets      -> files of public/ with the headers of public/_headers (CSP, nosniff, ...) and the right content types.
 *  - Access      -> server/auth.ts (AUTH_MODE builtin login, or a trusted reverse proxy's identity header).
 *  - waitUntil   -> a set of pending promises, awaited before the process exits.
 *  - Durable Object alarm / cron -> setInterval(TICK_ALARM_MS) running the alarm's own body (`runTick`). This assumes
 *    ONE replica per database file: two servers on one file would both tick (the meta claims keep the work single,
 *    but run one replica anyway; SQLite on a shared volume is not a cluster).
 *  - Rate Limiting bindings -> an in-memory fixed window per source id (RATE_LIMIT_PER_MINUTE), same keys.
 * SIGTERM / SIGINT: stop accepting, finish in-flight requests, wait for the tick and every waitUntil, close the db.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { Env } from "../env";
import { RATE_LIMIT_PER_MINUTE } from "../env";
import { route } from "../index";
import { TICK_ALARM_MS, runTick } from "../ticker";
import { HSTS, errorJson } from "../util";
import { BrowserAuth, resolveAdminPassword, type Identify } from "./auth";
import { PASSTHROUGH_VARS, loadConfig, type ServerConfig } from "./config";
import { SqliteD1 } from "./d1-sqlite";
import { clientIp } from "./net";

// ── static assets ────────────────────────────────────────────────────────────

interface HeaderRule {
  re: RegExp;
  headers: [string, string][];
}

/** Parse Cloudflare's `_headers` format (a path pattern line, then indented `Name: value` lines; `*` = anything). */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const re = new RegExp(`^${line.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      rules.push({ re, headers: [] });
    } else {
      const i = line.indexOf(":");
      const rule = rules[rules.length - 1];
      if (rule && i > 0) rule.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  webmanifest: "application/manifest+json",
  json: "application/json",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
};

export function makeAssets(dir: string): { fetch(req: Request): Promise<Response> } {
  const root = realpathSync(dir);
  let rules: HeaderRule[] = [];
  try {
    rules = parseHeadersFile(readFileSync(join(root, "_headers"), "utf8"));
  } catch {
    /* no _headers file */
  }
  return {
    async fetch(req: Request): Promise<Response> {
      if (req.method !== "GET" && req.method !== "HEAD") return errorJson(405, "GET only", { Allow: "GET, HEAD" });
      let path: string;
      try {
        path = decodeURIComponent(new URL(req.url).pathname); // malformed %-encoding is a 400, not a 500
      } catch {
        return errorJson(400, "bad path encoding");
      }
      const rel = path === "/" ? "index.html" : path.slice(1);
      const name = rel.split("/").pop() ?? "";
      // route() already refused encoded separators and dot segments; refuse dotfiles and the _headers / _redirects files too.
      if (!rel || rel.split("/").some((s) => s.startsWith(".") || s.startsWith("_")) || rel.includes("\\")) return errorJson(404, "not found");
      let file: string;
      try {
        file = realpathSync(join(root, rel));
        if (!file.startsWith(root + sep) || !statSync(file).isFile()) return errorJson(404, "not found");
      } catch {
        return errorJson(404, "not found");
      }
      const headers = new Headers({ "Content-Type": TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream" });
      // _headers rules match the same decoded path the file was looked up by
      for (const r of rules) if (r.re.test(path)) for (const [k, v] of r.headers) headers.set(k, v);
      return new Response(req.method === "HEAD" ? null : Bun.file(file), { headers });
    },
  };
}

// ── rate limiting (stand-in for the Workers binding) ─────────────────────────

export function memoryRateLimit(limit: number, periodMs = 60_000, clock: () => number = Date.now): RateLimit {
  const windows = new Map<string, { start: number; n: number }>();
  return {
    async limit({ key }: { key: string }) {
      const now = clock();
      let w = windows.get(key);
      if (!w || now - w.start >= periodMs) {
        if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= periodMs) windows.delete(k);
        w = { start: now, n: 0 };
        windows.set(key, w);
      }
      w.n++;
      return { success: w.n <= limit };
    },
  } as RateLimit;
}

// ── server ───────────────────────────────────────────────────────────────────

/** Routes that authenticate with bearer tokens (or not at all): the browser gate never applies. */
const TOKEN_ROUTE = /^\/(?:api\/ingest\/[^/]+|mcp(?:\/.*)?|api\/health)\/?$/;

export interface RunningServer {
  url: string;
  port: number;
  db: SqliteD1;
  env: Env;
  /** Run one tick now (tests). */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export function buildEnv(cfg: ServerConfig, db: SqliteD1, source: Record<string, string | undefined>): Env {
  const env: Record<string, unknown> = {
    DB: db,
    ASSETS: makeAssets(cfg.publicDir),
    PUBLIC_URL: cfg.publicUrl,
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    RATE_LIMIT_HOST: memoryRateLimit(RATE_LIMIT_PER_MINUTE.host),
    RATE_LIMIT_CLIENT: memoryRateLimit(RATE_LIMIT_PER_MINUTE.client),
  };
  for (const k of PASSTHROUGH_VARS) {
    const v = source[k]?.trim();
    if (v) env[k] = v;
  }
  // DEV_NO_ACCESS is a Worker development switch. This server decides who may read from its own login / trusted-proxy
  // check (it is passed to route() as browserAuth, so requireAccess never runs here); the variable is never copied in.
  delete env.DEV_NO_ACCESS;
  return env as unknown as Env;
}

export function startServer(cfg: ServerConfig, source: Record<string, string | undefined> = process.env): RunningServer {
  const db = new SqliteD1({ path: cfg.dbPath, migrationsDir: cfg.migrationsDir });
  if (cfg.authMode === "builtin" && !cfg.adminPasswordHash && cfg.adminPassword) {
    cfg = { ...cfg, adminPasswordHash: resolveAdminPassword(db, cfg.adminPassword), adminPassword: "" };
  }
  const env = buildEnv(cfg, db, source);
  const auth = new BrowserAuth(cfg, db);
  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      const q = p.catch((err) => console.error("background task failed:", err instanceof Error ? err.message : String(err)));
      pending.add(q);
      void q.finally(() => pending.delete(q));
    },
  };
  // HSTS only when PUBLIC_URL is https: route() adds it to everything (right on Cloudflare, which is https only),
  // so over plain http (localhost) it is removed again.
  const secureHeaders = (res: Response): Response => {
    const want = cfg.secure;
    if (want === res.headers.has("Strict-Transport-Security")) return res;
    const out = (() => {
      try {
        if (want) res.headers.set("Strict-Transport-Security", HSTS);
        else res.headers.delete("Strict-Transport-Security");
        return res;
      } catch {
        const copy = new Response(res.body, res); // immutable headers
        if (want) copy.headers.set("Strict-Transport-Security", HSTS);
        else copy.headers.delete("Strict-Transport-Security");
        return copy;
      }
    })();
    return out;
  };

  const server = Bun.serve({
    hostname: cfg.bind,
    port: cfg.port,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(req, srv) {
      // Every response, the 500 included, leaves through secureHeaders.
      try {
        return secureHeaders(await handleRequest(req, srv.requestIP(req)?.address ?? ""));
      } catch (err) {
        console.error("unhandled error:", err instanceof Error ? err.message : String(err));
        return secureHeaders(errorJson(500, "internal error"));
      }
    },
  });

  async function handleRequest(req: Request, peer: string): Promise<Response> {
    const ip = clientIp(peer, req.headers.get("x-forwarded-for"), cfg.trustedProxies);
    const path = new URL(req.url).pathname;
    if (path !== "/auth/login") auth.noteForwarded(req, peer);
    const own = await auth.handle(req, path, ip, peer);
    if (own) return own;
    if (TOKEN_ROUTE.test(path)) return await route(req, env, ctx);
    // ONE identity check per request: the page gate below and route()'s browser-API gate share its result.
    let verdict: Promise<Identify> | null = null;
    const identify = () => (verdict ??= auth.identify(req, peer));
    if (!path.startsWith("/api/")) {
      // Pages and assets: the same gate as the API (on Cloudflare, Access covers the whole hostname too).
      const who = await identify();
      if (!who.ok) {
        if (cfg.authMode === "builtin" && (req.method === "GET" || req.method === "HEAD")) {
          return new Response(null, { status: 303, headers: { Location: "/auth/login", "Cache-Control": "no-store" } });
        }
        return errorJson(who.status, who.reason);
      }
    }
    return await route(req, env, ctx, {
      browserAuth: async () => {
        const v = await identify();
        return v.ok ? { ok: true, identity: v.identity } : { ok: false, response: errorJson(v.status, v.reason) };
      },
    });
  }

  let ticking: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (!ticking) ticking = runTick(env, Date.now()).finally(() => (ticking = null));
    return ticking;
  };
  const timer = cfg.tickerEnabled ? setInterval(() => void tick(), TICK_ALARM_MS) : null;

  let stopping: Promise<void> | null = null;
  return {
    url: `http://${cfg.bind.includes(":") ? `[${cfg.bind}]` : cfg.bind}:${server.port}`,
    port: server.port as number,
    db,
    env,
    tick,
    stop() {
      stopping ??= (async () => {
        if (timer) clearInterval(timer);
        await server.stop(false); // in-flight requests finish
        if (ticking) await ticking;
        while (pending.size) await Promise.all([...pending]);
        db.close();
      })();
      return stopping;
    },
  };
}

if (import.meta.main) {
  const loaded = loadConfig(process.env);
  if (loaded.ok === false) {
    console.error(`siiswell: invalid configuration (${loaded.errors.length} problem${loaded.errors.length > 1 ? "s" : ""}):`);
    for (const e of loaded.errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  const cfg = (loaded as Extract<typeof loaded, { ok: true }>).config;
  delete process.env.ADMIN_PASSWORD; // read once into cfg; nothing later needs it in the environment
  const running = startServer(cfg);
  for (const w of cfg.warnings) console.warn(`siiswell: WARNING: ${w}`);
  console.log(`siiswell listening on ${running.url} (public ${cfg.publicUrl}, auth ${cfg.authMode}, db ${cfg.dbPath}, ticker ${cfg.tickerEnabled ? "on" : "off"})`);
  const shutdown = (sig: string) => {
    console.log(`siiswell: ${sig}, shutting down`);
    running.stop().then(
      () => process.exit(0),
      (err) => {
        console.error("shutdown failed:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
