/**
 * Test support: a D1-compatible subset (`prepare().bind().run()/all()/first()/raw()`, `batch`,
 * `exec`) over bun:sqlite, applying migrations/*.sql, plus env / ctx / token / request helpers.
 *
 * Mirrors the D1 behaviours that matter to this code: `undefined` is rejected at bind time,
 * `run()` reports `meta.changes`, and `batch()` is one transaction (all or nothing).
 */
import { join } from "node:path";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/util";

import { SqliteD1, shimOptions } from "../src/server/d1-sqlite";

export { shimOptions };

/** The production SQLite adapter with the repo's migrations applied, recording every statement (tests count them). */
export class D1Shim extends SqliteD1 {
  constructor() {
    super({ migrationsDir: join(import.meta.dir, "..", "migrations") });
    this.recordStatements = true;
  }
}

export interface TestCtx {
  waitUntil(p: Promise<unknown>): void;
  /** Await every promise handed to waitUntil (including ones added while flushing). */
  flush(): Promise<void>;
}

export function makeCtx(): TestCtx {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p) {
      pending.push(p.catch(() => undefined));
    },
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

export interface TestEnv {
  env: Env;
  db: D1Shim;
}

export function makeEnv(overrides: Partial<Env> = {}): TestEnv {
  const db = new D1Shim();
  const env = {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Fetcher,
    PUBLIC_URL: "https://dash.test",
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    DEV_NO_ACCESS: "1",
    // Host snapshots keep their lastLine here (production default drops it; test/ingest.test.ts covers the default).
    ACCEPT_LAST_LINE: "1",
    // Task text kept as sent (production default is minimal; test/task-text-policy.test.ts covers the default).
    ACCEPT_TASK_TEXT: "full",
    // Host text kept as sent here too (production default is minimal; test/host-text.test.ts covers the modes).
    ACCEPT_HOST_TEXT: "full",
    // The ingest-triggered evaluation throttle (30 s by default) is off in the tests, which evaluate on every change
    // within a few ms of each other; test/fix7.test.ts runs the production setting.
    RULES_MIN_INTERVAL_MS: "0",
    // Opportunistic maintenance (purge, time-based rules after an ingest) is off by default in the tests, which count
    // evaluations, statements and meta rows exactly. test/privacy.test.ts turns it on (retention, time-based rules without the
    // cron, and the D1 statement budget of a full ingest / state read with maintenance ON).
    OPPORTUNISTIC_MAINTENANCE: "0",
    // The well-being push policy (tiers, digest, quiet hours, Focus, storm control) is off by default here: most suites test
    // the per-alert dispatcher underneath it (budgets, fairness, criticals). test/wellbeing-*.test.ts turn it on.
    WELLBEING_PUSH_POLICY: "0",
    ...overrides,
  } as Env;
  return { env, db };
}

/** Insert a source row and return its (plaintext) token. */
export async function addSource(
  db: D1Shim,
  name: string,
  kind: "host" | "client",
  opts: { revoked?: boolean; lastSeen?: number | null } = {},
): Promise<string> {
  const token = `oct_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`; // the exact shape new-token.ts mints
  db.sqlite
    .query("INSERT INTO sources (id, name, kind, token_sha256, created, last_seen, revoked) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`src-${name}`, name, kind, await sha256Hex(token), 1, opts.lastSeen ?? null, opts.revoked ? 1 : 0);
  return token;
}

export const BASE = "http://localhost:8787";

export function request(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string; base?: string } = {},
): Request {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  if (hasBody && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return new Request(`${opts.base ?? BASE}${path}`, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    headers,
    body: hasBody ? (opts.rawBody ?? JSON.stringify(opts.body)) : undefined,
  });
}

// ── payload builders (valid v1 contract objects) ─────────────────────────────

import { DASHBOARD_SCHEMA_VERSION, type ProjectSnapshot } from "../src/shared/schema";

export function snapshot(over: Partial<ProjectSnapshot> = {}, now = Date.now()): ProjectSnapshot {
  return {
    v: DASHBOARD_SCHEMA_VERSION,
    host: "hosta",
    project: "proja",
    sentAt: now,
    poller: { status: "running", binaryVersion: "1.0.1", lastPoll: now, startedAt: now - 3600_000 },
    agents: [
      { name: "Agent01", baseCli: "claude", state: "working", lastReplyAt: now - 60_000, usage: [{ label: "5h", usedPercent: 42 }], contextPercent: 30 },
      { name: "Agent02", baseCli: "codex", state: "idle" },
    ],
    tasks: [],
    discussions: [],
    approvals: [],
    ...over,
  };
}

/**
 * Give an env a VAPID key pair and one push subscription, and return the list that collects every
 * push request plus a `fetch` stub for `route(..., { fetch })` / `runCron(..., { fetch })`.
 */
export async function setupPush(t: TestEnv): Promise<{ pushes: string[]; fetch: (url: string) => Promise<Response> }> {
  const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, "base64url"), Buffer.from(jwk.y as string, "base64url")]);
  Object.assign(t.env, { VAPID_PUBLIC_KEY: b64u(pub), VAPID_PRIVATE_KEY: jwk.d as string, VAPID_SUBJECT: "mailto:ops@example.com" });
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  t.db.sqlite
    .query("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, 1)")
    .run("https://fcm.googleapis.com/fcm/send/dev", b64u(new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer)), b64u(crypto.getRandomValues(new Uint8Array(16))));
  const pushes: string[] = [];
  return {
    pushes,
    fetch: async (url: string) => {
      pushes.push(url);
      return new Response(null, { status: 201 });
    },
  };
}
