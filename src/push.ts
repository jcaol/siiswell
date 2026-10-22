/**
 * @file Web Push with WebCrypto only: VAPID (RFC 8292, ES256 JWT) + message encryption
 * `aes128gcm` (RFC 8291 over RFC 8188), plus the HTTP routes and the alert-push dispatcher.
 * @module dashboard-worker/push
 *
 * The encryption is pure given (plaintext, UA public key, auth secret, sender key pair, salt), and
 * the key pair + salt can be injected, so tests can reproduce the byte-exact example in
 * RFC 8291 section 5.
 */
import { stormMessage } from "./wellbeing";
import { ORIGIN_HOST, ORIGIN_RELAY } from "./shared/wire";
import type { FetchLike } from "./auth";
import {
  DAY_MS,
  PUSH_TOUCH_EVERY_MS,
  SQL_PUSH_BUDGETS,
  SQL_PUSH_SUMMARIES_DUE,
  SQL_REFUND_PUSH_SLOTS,
  SQL_REFUND_SUMMARY_SLOT,
  SQL_RESTORE_SUPPRESSED,
  SQL_SUPPRESS_PUSH,
  SQL_TAKE_SUPPRESSED,
  claimPushSlots,
  claimedRow,
  ensurePushBudgets,
  pushBudgetSpent,
  type PushBudgetKey,
  type PushLimits,
} from "./budget";
import { all, first, run, stmt, type PushSubRow } from "./db";
import { budgetKey } from "./keys";
import {
  CRITICAL_AGENT_DEDUPE_MS,
  CRITICAL_PUSH_WINDOW_MS,
  MAX_CRITICAL_PUSHES_PER_DAY,
  MAX_CRITICAL_PUSHES_PER_HOUR,
  MAX_PUSHES_PER_INVOCATION,
  MAX_PUSHES_PER_OWNER_PER_DAY,
  MAX_PUSHES_PER_SOURCE_PER_DAY,
  MAX_PUSHES_PER_SOURCE_PER_WINDOW,
  MAX_PUSH_SLOTS_PER_SOURCE_PER_INVOCATION,
  MAX_RELAY_PUSHES_PER_DAY,
  MAX_RELAY_PUSHES_PER_WINDOW,
  MAX_SETTLED_PER_INVOCATION,
  MAX_PUSH_SUBREQUESTS,
  PUSH_DEADLINE_MS,
  PUSH_WINDOW_MS,
  type AppCtx,
  type Env,
} from "./env";
import { prioritizePushes, pushBudgetOf, pushMessage, summaryPushMessage, type PushItem, type PushMessage } from "./rules";
import { b64urlDecode, b64urlEncode, errorJson, isObj, json, utf8 } from "./util";

const RECORD_SIZE = 4096;
/** 4096 - 86 (header) - 16 (GCM tag) - 1 (delimiter) */
export const MAX_PLAINTEXT_BYTES = 3993;
const VAPID_JWT_LIFETIME_S = 11 * 3600; // RFC 8292 caps at 24 h; keep well under 12 h
const PUSH_TIMEOUT_MS = 8000;
const MAX_SUBSCRIPTIONS = 25;

// ── RFC 8291 encryption ──────────────────────────────────────────────────────

export interface SenderKeys {
  /** ECDH P-256 private key (CryptoKey). */
  privateKey: CryptoKey;
  /** 65-byte uncompressed public point (0x04 || X || Y). */
  publicRaw: Uint8Array;
}

export async function generateSenderKeys(): Promise<SenderKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicRaw };
}

/** Import a raw P-256 private scalar (+ its public point) as an ECDH key; used by tests. */
export async function importSenderKeys(privateRaw: Uint8Array, publicRaw: Uint8Array): Promise<SenderKeys> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: b64urlEncode(privateRaw),
    x: b64urlEncode(publicRaw.subarray(1, 33)),
    y: b64urlEncode(publicRaw.subarray(33, 65)),
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey, publicRaw };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, lengthBytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface EncryptOptions {
  /** Inject the ephemeral application-server key pair (default: fresh). */
  senderKeys?: SenderKeys;
  /** Inject the 16-byte salt (default: random). */
  salt?: Uint8Array;
}

/**
 * Encrypt `plaintext` for a push subscription. Returns the complete `aes128gcm` request body:
 * salt(16) || rs(4, BE) || idlen(1) || as_public(65) || AES-128-GCM(plaintext || 0x02).
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("push payload too large");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("invalid subscription public key");
  if (authSecret.length < 16) throw new Error("invalid subscription auth secret");

  const sender = opts.senderKeys ?? (await generateSenderKeys());
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");

  // WebCrypto validates that the point is on the curve (RFC 8291 section 7).
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // `public` is the WebCrypto standard member; workers-types spells it `$public`, hence the cast.
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, sender.privateKey, 256));

  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info" 0x00 ua_public as_public, L = 32)
  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, sender.publicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Single record: plaintext || 0x02 (last-record delimiter), no extra padding.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = sender.publicRaw.length;
  return concat(header, sender.publicRaw, ciphertext);
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────────

export async function importVapidPrivateKey(privateB64u: string, publicB64u: string): Promise<CryptoKey> {
  const pub = b64urlDecode(publicB64u);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point");
  const d = b64urlDecode(privateB64u);
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY must be a 32-byte P-256 scalar");
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: b64urlEncode(d), x: b64urlEncode(pub.subarray(1, 33)), y: b64urlEncode(pub.subarray(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** ES256 JWT for a push service origin. WebCrypto ECDSA already emits raw r||s (JOSE format). */
export async function signVapidJwt(
  audience: string,
  subject: string,
  privateB64u: string,
  publicB64u: string,
  now: number,
): Promise<string> {
  const header = b64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + VAPID_JWT_LIFETIME_S, sub: subject })),
  );
  const key = await importVapidPrivateKey(privateB64u, publicB64u);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`));
  return `${header}.${claims}.${b64urlEncode(sig)}`;
}

export function vapidConfigured(env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

// ── endpoint allow-list (SSRF guard) ─────────────────────────────────────────

/** Host suffixes of the push services browsers use (FCM, Mozilla autopush, Apple, Windows WNS). */
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export function isAllowedPushEndpoint(endpoint: string, extraHosts?: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || endpoint.length > 2048) return false;
  const host = url.hostname.toLowerCase();
  const extra = (extraHosts ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...PUSH_HOST_SUFFIXES, ...extra].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// ── sending ──────────────────────────────────────────────────────────────────

export type SendOutcome = "ok" | "gone" | "transient" | "failed";

export interface SendResult {
  outcome: SendOutcome;
  status: number;
}

export interface SendOptions {
  fetch?: FetchLike;
  now?: number;
  senderKeys?: SenderKeys;
  salt?: Uint8Array;
}

/** Encrypt + POST one message to one subscription. Never throws. */
export async function sendWebPush(
  sub: Pick<PushSubRow, "endpoint" | "p256dh" | "auth">,
  message: PushMessage | Record<string, unknown>,
  env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">,
  opts: SendOptions = {},
): Promise<SendResult> {
  if (!vapidConfigured(env)) return { outcome: "failed", status: 0 };
  const f: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? Date.now();
  try {
    const body = await encryptPayload(utf8(JSON.stringify(message)), b64urlDecode(sub.p256dh), b64urlDecode(sub.auth), {
      senderKeys: opts.senderKeys,
      salt: opts.salt,
    });
    const audience = new URL(sub.endpoint).origin;
    const jwt = await signVapidJwt(audience, env.VAPID_SUBJECT as string, env.VAPID_PRIVATE_KEY as string, env.VAPID_PUBLIC_KEY as string, now);
    const res = await f(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "3600",
        Urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    await res.arrayBuffer().catch(() => undefined); // drain
    if (res.status >= 200 && res.status < 300) return { outcome: "ok", status: res.status };
    if (res.status === 404 || res.status === 410) return { outcome: "gone", status: res.status };
    if (res.status === 429 || res.status >= 500) return { outcome: "transient", status: res.status };
    return { outcome: "failed", status: res.status };
  } catch {
    return { outcome: "transient", status: 0 };
  }
}

export interface FanOutResult {
  attempted: number;
  ok: number;
  gone: number;
  transient: number;
  failed: number;
}

/** Send to every stored subscription; 404/410 deletes the subscription; success stamps last_ok. */
export async function sendToAll(
  env: Env,
  message: PushMessage | Record<string, unknown>,
  opts: SendOptions = {},
): Promise<FanOutResult> {
  const result: FanOutResult = { attempted: 0, ok: 0, gone: 0, transient: 0, failed: 0 };
  if (!vapidConfigured(env)) return result;
  const subs = await all<PushSubRow>(env.DB, "SELECT * FROM push_subs");
  const now = opts.now ?? Date.now();
  const outcomes = await Promise.all(subs.map((s) => sendWebPush(s, message, env, opts)));
  const goneEndpoints: string[] = [];
  const okEndpoints: string[] = [];
  outcomes.forEach((o, i) => {
    result.attempted++;
    result[o.outcome]++;
    const endpoint = (subs[i] as PushSubRow).endpoint;
    if (o.outcome === "gone") goneEndpoints.push(endpoint);
    if (o.outcome === "ok") okEndpoints.push(endpoint);
  });
  try {
    if (goneEndpoints.length) {
      await run(env.DB, "DELETE FROM push_subs WHERE endpoint IN (SELECT value FROM json_each(?))", JSON.stringify(goneEndpoints));
    }
    if (okEndpoints.length) {
      await run(env.DB, "UPDATE push_subs SET last_ok = ? WHERE endpoint IN (SELECT value FROM json_each(?))", now, JSON.stringify(okEndpoints));
    }
  } catch {
    /* bookkeeping only */
  }
  const failedHosts = outcomes.filter((o) => o.outcome === "failed" || o.outcome === "transient").map((o) => o.status);
  if (failedHosts.length) console.warn(`web push: ${failedHosts.length} delivery problem(s), statuses ${failedHosts.join(",")}`);
  return result;
}

// ── alert dispatch ───────────────────────────────────────────────────────────

interface Outcome {
  attempted: number;
  ok: number;
  gone: number;
  transient: number;
  failed: number;
}

const newOutcome = (): Outcome => ({ attempted: 0, ok: 0, gone: 0, transient: 0, failed: 0 });

/**
 * Send every message to every subscription IN PARALLEL under one overall deadline (PUSH_DEADLINE_MS, well
 * inside the 30 s a scheduled/waitUntil task may run; each request also has its own 8 s timeout). Sends
 * still in flight at the deadline count as transient. Returns the per-message outcome plus which
 * endpoints answered 404/410 (to delete) and which succeeded (to stamp).
 */
async function fanOut(
  env: Env,
  subs: PushSubRow[],
  messages: Array<{ key: string; message: PushMessage }>,
  opts: SendOptions & { deadlineMs?: number },
): Promise<{ outcomes: Map<string, Outcome>; gone: Set<string>; ok: Set<string> }> {
  const outcomes = new Map<string, Outcome>(messages.map((m) => [m.key, newOutcome()]));
  const gone = new Set<string>();
  const ok = new Set<string>();
  const tasks: Promise<void>[] = [];
  for (const m of messages) {
    for (const sub of subs) {
      tasks.push(
        sendWebPush(sub, m.message, env, opts).then((r) => {
          const o = outcomes.get(m.key) as Outcome;
          o.attempted++;
          o[r.outcome]++;
          if (r.outcome === "gone") gone.add(sub.endpoint);
          if (r.outcome === "ok") ok.add(sub.endpoint);
        }),
      );
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts.deadlineMs ?? PUSH_DEADLINE_MS);
  });
  try {
    await Promise.race([Promise.all(tasks), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  for (const o of outcomes.values()) {
    const missing = subs.length - o.attempted; // still in flight at the deadline
    if (missing > 0) {
      o.attempted += missing;
      o.transient += missing;
    }
  }
  return { outcomes, gone, ok };
}

/** Subscription bookkeeping after a fan-out: delete expired endpoints, stamp the ones that worked. */
async function settleSubscriptions(env: Env, gone: Set<string>, ok: Set<string>, now: number): Promise<void> {
  try {
    if (gone.size) await run(env.DB, "DELETE FROM push_subs WHERE endpoint IN (SELECT value FROM json_each(?))", JSON.stringify([...gone]));
    if (ok.size) await run(env.DB, "UPDATE push_subs SET last_ok = ? WHERE endpoint IN (SELECT value FROM json_each(?))", now, JSON.stringify([...ok]));
  } catch {
    /* bookkeeping only */
  }
}

const everyAttemptFailedTransiently = (o: Outcome): boolean => o.attempted > 0 && o.ok === 0 && o.transient > 0;

interface Claimed {
  item: PushItem;
  /** The budget keys a push slot was taken from (to give them back on rollback); null = none taken. */
  slotKeys: string[] | null;
}

/** Give a claimed alert (and its budget slots) back: it was never delivered, the next cron minute retries. */
async function rollback(env: Env, c: Claimed): Promise<void> {
  await stmt(
    env.DB,
    "UPDATE alerts SET last_pushed = ?, push_count = ? WHERE key = ? AND push_count = ?",
    c.item.lastPushed,
    c.item.pushCount,
    c.item.key,
    c.item.pushCount + 1,
  ).run();
  if (c.slotKeys?.length) await stmt(env.DB, SQL_REFUND_PUSH_SLOTS, JSON.stringify(c.slotKeys)).run();
}

const NO_DAILY_CAP = 1_000_000_000;

/** What one owner (a host label or client name) may push per day in all, summaries included. */
const totalOf = (owner: string): PushBudgetKey => ({
  key: budgetKey("all", owner),
  owner,
  limits: { windowMs: DAY_MS, perWindow: MAX_PUSHES_PER_OWNER_PER_DAY, dayMs: DAY_MS, perDay: MAX_PUSHES_PER_OWNER_PER_DAY },
});

/** How an alert is budgeted. */
export interface PushPlan {
  owner: string;
  /** Round-robin group for the invocation's slots: the owner (relay senders and invented names collapse into it). */
  group: string;
  /** Where alerts held back by this plan are counted and summarised. */
  holdKey: string;
  /** The push must fit ALL of these. */
  keys: PushBudgetKey[];
}

/**
 * The budget keys an alert is charged to (typed and escaped, see keys.ts: no host label, client name, sender or agent
 * name can spell another source's key). The key parts that come from the host's OWN payload (a relay sender, an
 * agent name) can be invented at will, so none of them is what bounds a host: every plan ends in the owner's grand
 * total (`all|owner`), relay senders share `rt|host`, and critical alerts share `ct|host`.
 *  - host agent CRITICAL: exempt from the ordinary budget; `ct|host` (30 an hour, 60 a day), one per agent per
 *    30 minutes (`ca|host|agent`);
 *  - relayed foreign agent: its own `rs|host|sender` (3 per 10 min, 30 a day) AND `rt|host` (10 per 10 min and 30
 *    a day over all senders);
 *  - everything else of host agent: `own|host` (3 per 10 min); MCP clients: `own|client` (3 per 10 min, 30 a day).
 */
export function pushPlan(item: Pick<PushItem, "origin" | "severity" | "host" | "sender" | "agent">): PushPlan {
  const owner = item.host;
  const b = pushBudgetOf(item);
  const short = (key: string, perDay: number): PushBudgetKey => ({ key, owner, limits: { windowMs: PUSH_WINDOW_MS, perWindow: MAX_PUSHES_PER_SOURCE_PER_WINDOW, dayMs: DAY_MS, perDay } });
  if (b.exempt) {
    const keys: PushBudgetKey[] = [{ key: b.key, owner, limits: { windowMs: CRITICAL_PUSH_WINDOW_MS, perWindow: MAX_CRITICAL_PUSHES_PER_HOUR, dayMs: DAY_MS, perDay: MAX_CRITICAL_PUSHES_PER_DAY } }];
    if (item.agent) keys.push({ key: budgetKey("ca", owner, item.agent), owner, limits: { windowMs: CRITICAL_AGENT_DEDUPE_MS, perWindow: 1, dayMs: DAY_MS, perDay: NO_DAILY_CAP } });
    return { owner, group: budgetKey("grc", owner), holdKey: b.key, keys: [...keys, totalOf(owner)] };
  }
  if (item.origin === ORIGIN_RELAY && item.sender) {
    const all = budgetKey("rt", owner);
    return {
      owner,
      group: budgetKey("grp", owner),
      holdKey: all,
      keys: [
        short(b.key, MAX_PUSHES_PER_SOURCE_PER_DAY),
        { key: all, owner, limits: { windowMs: PUSH_WINDOW_MS, perWindow: MAX_RELAY_PUSHES_PER_WINDOW, dayMs: DAY_MS, perDay: MAX_RELAY_PUSHES_PER_DAY } },
        totalOf(owner),
      ],
    };
  }
  return { owner, group: budgetKey("grp", owner), holdKey: b.key, keys: [short(b.key, item.origin === ORIGIN_HOST ? NO_DAILY_CAP : MAX_PUSHES_PER_SOURCE_PER_DAY), totalOf(owner)] };
}

/**
 * Send the pushes the rules asked for, within the limits of ONE Worker invocation (Free plan: 50 D1
 * queries and 50 subrequests):
 * - the subscriptions are read ONCE; at most MAX_PUSHES_PER_INVOCATION alerts are handled (fewer when
 *   alerts x devices would exceed MAX_PUSH_SUBREQUESTS); the rest stay unclaimed for the next cron minute;
 * - fairness: alerts whose budget (any of its keys, see pushPlan) is already spent are taken out of the running
 *   and SUMMARISED (`summarized_at`, counted for ONE later "N more items via <key>" push, see
 *   flushPushSummaries); the slots go round-robin over the OWNERS (a host label or client name; invented relay
 *   senders and agent names cannot multiply them), at most MAX_PUSH_SLOTS_PER_SOURCE_PER_INVOCATION each,
 *   the host-agent's critical alerts first (prioritizePushes) in a group of their own, oldest first;
 * - each alert that is to be pushed is CLAIMED first (`push_count` bumped with an optimistic guard) so two
 *   concurrent evaluators never double-push, then ALL its budget keys are claimed in one statement;
 *   `push_count` therefore counts the individual pushes that really went out, never an alert that only the
 *   summary mentions;
 * - all sends run in parallel under an overall deadline;
 * - claim -> send is wrapped in try/finally: whatever fails (an exception anywhere, a D1/subrequest limit,
 *   or every delivery failing transiently), the claim and the slots are rolled back so the next
 *   cron minute retries (bounded by the rules' PUSH_RETRY_WINDOW_MS).
 * Without a VAPID key or a subscription nothing is claimed at all.
 */
export async function dispatchPushes(env: Env, items: PushItem[], now: number, fetchImpl?: FetchLike, dispatchOpts: { deadlineMs?: number; storm?: boolean } = {}): Promise<void> {
  if (!items.length || !vapidConfigured(env)) return;
  let subs: PushSubRow[];
  try {
    subs = await all<PushSubRow>(env.DB, "SELECT * FROM push_subs");
  } catch (err) {
    console.error("push precheck failed:", err instanceof Error ? err.message : String(err));
    return;
  }
  if (!subs.length) return;

  const perInvocation = Math.max(1, Math.min(MAX_PUSHES_PER_INVOCATION, Math.floor(MAX_PUSH_SUBREQUESTS / subs.length)));
  const pending = new Map<string, Claimed>();
  // Alerts summarised in THIS dispatch, per hold key (and the owner it belongs to): counted in one statement at the end.
  const held = new Map<string, { owner: string; n: number }>();
  const hold = (plan: PushPlan): void => void held.set(plan.holdKey, { owner: plan.owner, n: (held.get(plan.holdKey)?.n ?? 0) + 1 });
  try {
    const sends: Array<{ key: string; message: PushMessage }> = [];
    const ordered = prioritizePushes(items);
    const plans = new Map(ordered.map((i) => [i.key, pushPlan(i)] as const));
    const { spent, fresh } = await budgetState(env.DB, [...plans.values()], now);
    const isSpent = (i: PushItem): boolean => (plans.get(i.key) as PushPlan).keys.some((k) => spent.has(k.key));
    const candidates = ordered.filter((i) => !isSpent(i));
    const chosen = pickFairly(candidates, perInvocation, MAX_PUSH_SLOTS_PER_SOURCE_PER_INVOCATION);
    const settled = ordered.filter(isSpent).slice(0, MAX_SETTLED_PER_INVOCATION);
    // Spent keys: the alert is summarised in bulk (one statement per distinct state), never claimed as a push.
    const summarised = await summariseAlerts(env.DB, settled, now);
    for (const item of settled) if (summarised.has(item.key)) hold(plans.get(item.key) as PushPlan);
    const won = await claimAlerts(env.DB, chosen, now); // ONE statement per distinct (push_count, summarized_at)
    // The budget rows of the chosen alerts must exist before they can be claimed (ONE statement for all the missing ones).
    // A row that exists and was touched in the last PUSH_TOUCH_EVERY_MS is left alone (nothing to write, and the purge
    // never takes a row that young); an older one is ensured again, which touches it before the claim that follows.
    const wanted = new Map<string, PushBudgetKey>();
    for (const item of chosen) if (won.has(item.key)) for (const k of (plans.get(item.key) as PushPlan).keys) if (!fresh.has(k.key)) wanted.set(k.key, k);
    if (wanted.size) await ensurePushBudgets(env.DB, [...wanted.values()], now);
    const full = new Set<string>(); // hold keys found spent while claiming in THIS dispatch
    for (const item of chosen) {
      if (!won.has(item.key)) continue; // resolved meanwhile, or another evaluator claimed it
      const plan = plans.get(item.key) as PushPlan;
      const entry: Claimed = { item, slotKeys: null };
      pending.set(item.key, entry);
      const keys = plan.keys.map((k) => k.key);
      if (full.has(plan.holdKey) || !(await claimPushSlots(env.DB, keys, now))) {
        // A budget is spent after all: take the alert's claim back and summarise it instead of pushing it.
        full.add(plan.holdKey);
        await stmt(env.DB, SQL_SUMMARISE_CLAIMED, item.pushCount, item.lastPushed, now, item.key, item.pushCount + 1).run();
        pending.delete(item.key);
        hold(plan);
        continue;
      }
      entry.slotKeys = keys;
      sends.push({ key: item.key, message: pushMessage(item, env.PUBLIC_URL) });
    }
    // Storm control (well-being W1): several pushes of one tick go out as ONE message, oldest first; its outcome is every one's.
    const merged = dispatchOpts.storm && sends.length > 1 ? sends.map((x) => x.key) : null;
    const toSend = merged ? [{ key: merged[0] as string, message: stormMessage(merged.map((k) => (pending.get(k) as Claimed).item), env.PUBLIC_URL) }] : sends;
    if (toSend.length) {
      const { outcomes, gone, ok } = await fanOut(env, subs, toSend, { fetch: fetchImpl, now, deadlineMs: dispatchOpts.deadlineMs });
      if (merged) for (const k of merged.slice(1)) outcomes.set(k, outcomes.get(merged[0] as string) as Outcome);
      await settleSubscriptions(env, gone, ok, now);
      for (const [key, o] of outcomes) if (!everyAttemptFailedTransiently(o)) pending.delete(key); // delivered or hard-failed
      const bad = [...outcomes.values()].filter((o) => o.failed + o.transient > 0).length;
      if (bad) console.warn(`web push: ${bad} of ${outcomes.size} notification(s) had delivery problems`);
    }
  } catch (err) {
    console.error("push dispatch failed:", err instanceof Error ? err.message : String(err));
  } finally {
    // Anything still pending was claimed but never delivered: give it back.
    for (const c of pending.values()) {
      try {
        await rollback(env, c);
      } catch (err) {
        console.error("push rollback failed:", err instanceof Error ? err.message : String(err));
      }
    }
    for (const [key, h] of held) {
      try {
        await stmt(env.DB, SQL_SUPPRESS_PUSH, key, h.n, h.owner, now).run();
      } catch {
        /* the alerts stay in the inbox; only the summary's count is short */
      }
    }
  }
}

/**
 * Claims alerts whose push is due: bump `push_count` where it, and the `summarized_at` mark, still have the
 * values the rules saw. `?1` now, `?2` push_count seen, `?3` JSON keys, `?4` summarized_at seen (0 = never).
 */
export const SQL_CLAIM_ALERTS =
  "UPDATE alerts SET last_pushed = ?1, push_count = push_count + 1 WHERE key IN (SELECT value FROM json_each(?3)) AND push_count = ?2 AND COALESCE(summarized_at, 0) = ?4 AND +resolved IS NULL RETURNING key";
/** Marks alerts as summarised (not pushed individually): same optimistic guard, `push_count` untouched. */
export const SQL_SUMMARISE_ALERTS =
  "UPDATE alerts SET summarized_at = ?1 WHERE key IN (SELECT value FROM json_each(?3)) AND push_count = ?2 AND COALESCE(summarized_at, 0) = ?4 AND +resolved IS NULL RETURNING key";
/** An alert that was claimed for a push but whose budget turned out spent: undo the claim, mark it summarised. */
export const SQL_SUMMARISE_CLAIMED =
  "UPDATE alerts SET push_count = ?1, last_pushed = ?2, summarized_at = ?3 WHERE key = ?4 AND push_count = ?5";

/**
 * Which budget keys of these plans are spent right now (window or daily cap used up), and which rows exist and were
 * touched lately (`fresh`: nothing to ensure). A failed lookup means "unknown": nothing is treated as spent (the claim
 * still enforces every budget) and every row is (re-)ensured.
 */
async function budgetState(db: D1Database, plans: PushPlan[], now: number): Promise<{ spent: Set<string>; fresh: Set<string> }> {
  const spent = new Set<string>();
  const fresh = new Set<string>();
  const limits = new Map<string, PushLimits>();
  for (const p of plans) for (const k of p.keys) limits.set(k.key, k.limits);
  const keys = [...limits.keys()].slice(0, 300);
  if (!keys.length) return { spent, fresh };
  try {
    for (const r of await all<{ k: string; window_start: number; count: number; day_start: number; day_count: number; touched: number }>(db, SQL_PUSH_BUDGETS, JSON.stringify(keys))) {
      const l = limits.get(r.k);
      if (now - r.touched < PUSH_TOUCH_EVERY_MS) fresh.add(r.k);
      if (l && pushBudgetSpent(r, now, l)) spent.add(r.k);
    }
  } catch (err) {
    console.error("push budget lookup failed:", err instanceof Error ? err.message : String(err));
  }
  return { spent, fresh };
}

/**
 * Round-robin over the groups (owners; the host-agent's critical alerts of an owner are a group of their own), in the
 * order of their most urgent alert: round 1 takes each group's first alert, round 2 each one's second, and so on
 * up to `perSource` rounds or `total` alerts. `items` must already be in priority order. A host with 1,000
 * alerts, however many relay senders or agent names it invents, therefore holds at most `perSource` slots.
 */
export function pickFairly(items: PushItem[], total: number, perSource: number): PushItem[] {
  const byGroup = new Map<string, PushItem[]>();
  for (const i of items) {
    const g = pushPlan(i).group;
    byGroup.set(g, [...(byGroup.get(g) ?? []), i]);
  }
  const picked: PushItem[] = [];
  for (let round = 0; round < perSource && picked.length < total; round++) {
    for (const list of byGroup.values()) {
      const item = list[round];
      if (item && picked.length < total) picked.push(item);
    }
  }
  return picked;
}

/** Run an optimistic alert-state statement for each distinct (push_count, summarized_at) of `items`; the keys that changed. */
async function guardedUpdate(db: D1Database, sql: string, items: PushItem[], now: number): Promise<Set<string>> {
  const groups = new Map<string, { count: number; summarized: number; keys: string[] }>();
  for (const i of items) {
    const summarized = i.summarizedAt ?? 0;
    const g = groups.get(`${i.pushCount}|${summarized}`) ?? { count: i.pushCount, summarized, keys: [] };
    g.keys.push(i.key);
    groups.set(`${i.pushCount}|${summarized}`, g);
  }
  const won = new Set<string>();
  for (const g of groups.values()) {
    for (const r of await all<{ key: string }>(db, sql, now, g.count, JSON.stringify(g.keys), g.summarized)) won.add(r.key);
  }
  return won;
}

/** Keys this caller (and nobody else) just claimed. Optimistic: a concurrent evaluator that got there first wins them. */
const claimAlerts = (db: D1Database, items: PushItem[], now: number): Promise<Set<string>> => guardedUpdate(db, SQL_CLAIM_ALERTS, items, now);
const summariseAlerts = (db: D1Database, items: PushItem[], now: number): Promise<Set<string>> => guardedUpdate(db, SQL_SUMMARISE_ALERTS, items, now);
/** Alerts the well-being policy holds back (the digest carries them): marked like a summarised alert, so the rules stop offering them. */
export const holdAlerts = summariseAlerts;

/**
 * One summary push ("N more items via <key>") for every budget key (at most 3 per call) that has alerts held
 * back by its budget and whose budget window has ended. Called by the cron every minute; with the partial index
 * on `suppressed` it reads nothing when no key is owed one. The summary takes a slot like any push: from the
 * key's own limits (kept on its row) AND from its owner's daily total (`all|owner`), so summaries count towards
 * what a host may push in a day. Nothing is consumed without a VAPID key or a subscription; a failed delivery
 * puts the count back.
 */
export async function flushPushSummaries(env: Env, now: number, fetchImpl?: FetchLike): Promise<void> {
  if (!vapidConfigured(env)) return;
  let due: Array<{ k: string; owner: string; suppressed: number; window_start: number }>;
  try {
    due = await all(env.DB, SQL_PUSH_SUMMARIES_DUE, now);
    if (!due.length) return;
  } catch (err) {
    console.error("push summary lookup failed:", err instanceof Error ? err.message : String(err));
    return;
  }
  let subs: PushSubRow[];
  try {
    subs = await all<PushSubRow>(env.DB, "SELECT * FROM push_subs");
  } catch {
    return;
  }
  if (!subs.length) return;
  for (const d of due.slice(0, 3)) {
    let slotKeys: string[] | null = null;
    let taken = false;
    try {
      const total = totalOf(d.owner); // the owner column is authoritative: the key is never parsed for it
      await ensurePushBudgets(env.DB, [total], now);
      const keys = [d.k, total.key];
      if (!(await claimPushSlots(env.DB, keys, now))) continue;
      slotKeys = keys;
      taken = await claimedRow(env.DB, SQL_TAKE_SUPPRESSED, d.k, d.suppressed);
      if (!taken) continue; // another evaluator took (or changed) the count
      const message = summaryPushMessage(d.k, d.suppressed, env.PUBLIC_URL);
      const { outcomes, gone, ok } = await fanOut(env, subs, [{ key: d.k, message }], { fetch: fetchImpl, now });
      await settleSubscriptions(env, gone, ok, now);
      if (everyAttemptFailedTransiently(outcomes.get(d.k) as Outcome)) throw new Error("summary push not delivered");
      taken = false; // delivered (or hard-failed): settled
      slotKeys = null;
    } catch (err) {
      console.error("push summary failed:", err instanceof Error ? err.message : String(err));
    } finally {
      try {
        if (taken) await stmt(env.DB, SQL_RESTORE_SUPPRESSED, d.k, d.suppressed).run();
        if (slotKeys) {
          await stmt(env.DB, SQL_REFUND_SUMMARY_SLOT, d.k, d.window_start, now).run(); // also puts the window back
          await stmt(env.DB, SQL_REFUND_PUSH_SLOTS, JSON.stringify(slotKeys.filter((k) => k !== d.k))).run();
        }
      } catch {
        /* best effort */
      }
    }
  }
}

// ── HTTP routes (Access-protected by the router) ─────────────────────────────

function sameOriginOrAbsent(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

export async function handlePushRoute(
  req: Request,
  env: Env,
  _ctx: AppCtx,
  path: string,
  now: number,
  fetchImpl?: FetchLike,
): Promise<Response> {
  if (path === "/api/push/key") {
    if (req.method !== "GET") return errorJson(405, "GET only", { Allow: "GET" });
    if (!env.VAPID_PUBLIC_KEY) return errorJson(503, "VAPID keys are not configured");
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (path !== "/api/push/subscribe" && path !== "/api/push/test") return errorJson(404, "not found");
  if (req.method !== "POST") return errorJson(405, "POST only", { Allow: "POST" });
  // CSRF guard: the Access cookie rides along on cross-site requests, so insist on a JSON body
  // (cross-site forms cannot send one without a CORS preflight, which we never grant) and a
  // same-origin Origin header when the browser sends one.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json") || !sameOriginOrAbsent(req)) {
    return errorJson(400, "expected a same-origin application/json request");
  }

  if (path === "/api/push/test") {
    if (!vapidConfigured(env)) return errorJson(503, "VAPID keys are not configured");
    const res = await sendToAll(
      env,
      { title: "Test push", body: "siiswell push works", tag: "test", url: env.PUBLIC_URL.replace(/\/+$/, "") + "/" },
      { fetch: fetchImpl, now },
    );
    return json({ ok: true, subscriptions: res.attempted, sent: res.ok, removed: res.gone, failed: res.failed + res.transient });
  }

  // subscribe
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "body is not valid JSON");
  }
  if (!isObj(body) || typeof body.endpoint !== "string" || !isObj(body.keys)) return errorJson(400, "expected a PushSubscription (endpoint, keys)");
  const { endpoint } = body;
  const { p256dh, auth } = body.keys;
  if (!isAllowedPushEndpoint(endpoint, env.PUSH_ALLOWED_HOSTS)) return errorJson(400, "push endpoint is not an allowed https push service");
  if (typeof p256dh !== "string" || typeof auth !== "string") return errorJson(400, "keys.p256dh and keys.auth are required");
  try {
    const pk = b64urlDecode(p256dh);
    if (pk.length !== 65 || pk[0] !== 0x04) throw new Error("bad p256dh");
    if (b64urlDecode(auth).length < 16) throw new Error("bad auth");
  } catch {
    return errorJson(400, "invalid subscription keys");
  }
  const existing = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM push_subs WHERE endpoint != ?", endpoint);
  if ((existing?.n ?? 0) >= MAX_SUBSCRIPTIONS) return errorJson(409, "too many subscriptions");
  await run(
    env.DB,
    `INSERT INTO push_subs (endpoint, p256dh, auth, created, last_ok) VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    endpoint,
    p256dh,
    auth,
    now,
  );
  return json({ ok: true });
}
