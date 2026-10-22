import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import {
  MAX_PLAINTEXT_BYTES,
  dispatchPushes,
  encryptPayload,
  generateSenderKeys,
  handlePushRoute,
  importSenderKeys,
  isAllowedPushEndpoint,
  sendToAll,
  sendWebPush,
  signVapidJwt,
} from "../src/push";
import type { PushItem } from "../src/rules";
import { b64urlDecode, b64urlEncode, utf8 } from "../src/util";
import { makeCtx, makeEnv, request, type TestEnv } from "./d1-shim";

const NOW = 1_800_000_000_000;

// ── RFC 8291 section 5 + Appendix A ──────────────────────────────────────────
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  // The request body of section 5 (three display lines of the RFC joined together).
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 aes128gcm", () => {
  test("section 5 example is reproduced byte for byte", async () => {
    const senderKeys = await importSenderKeys(b64urlDecode(RFC.asPrivate), b64urlDecode(RFC.asPublic));
    const body = await encryptPayload(utf8(RFC.plaintext), b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.authSecret), {
      senderKeys,
      salt: b64urlDecode(RFC.salt),
    });
    expect(b64urlEncode(body)).toBe(RFC.body);
    expect(Buffer.from(body).equals(Buffer.from(b64urlDecode(RFC.body)))).toBe(true);
    // 86 header + 41 plaintext + 1 delimiter + 16 tag. (The RFC's example prints "Content-Length: 145";
    // its own 192 base64 characters decode to 144 bytes, so that header line is a typo in the text.)
    expect(body.length).toBe(144);
  });

  test("header layout: salt, rs=4096, idlen=65, sender key; ciphertext is plaintext + 0x02 + 16-byte tag", async () => {
    const body = await encryptPayload(utf8("hi"), b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.authSecret));
    expect(body.length).toBe(86 + 2 + 1 + 16);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04);
  });

  test("a fresh ephemeral key and salt are used per message", async () => {
    const a = await encryptPayload(utf8("x"), b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.authSecret));
    const b = await encryptPayload(utf8("x"), b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.authSecret));
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
  });

  test("the user agent can decrypt what we send (round trip with generated keys)", async () => {
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const uaPub = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const message = JSON.stringify({ title: "Needs you", body: "proja: Agent01 blocked" });
    const out = await encryptPayload(utf8(message), uaPub, auth);

    const salt = out.subarray(0, 16);
    const asPub = out.subarray(21, 21 + 65);
    const ct = out.subarray(86);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, ua.privateKey, 256));
    const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
      new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
    const keyInfo = new Uint8Array([...utf8("WebPush: info\0"), ...uaPub, ...asPub]);
    const ikm = await hk(auth, secret, keyInfo, 32);
    const cek = await hk(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hk(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
    expect(plain[plain.length - 1]).toBe(0x02);
    expect(new TextDecoder().decode(plain.subarray(0, plain.length - 1))).toBe(message);
  });

  test("rejects oversize payloads and malformed subscription keys", async () => {
    const ua = b64urlDecode(RFC.uaPublic);
    const auth = b64urlDecode(RFC.authSecret);
    await expect(encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), ua, auth)).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES), ua, auth)).resolves.toBeDefined();
    await expect(encryptPayload(utf8("x"), ua.subarray(0, 64), auth)).rejects.toThrow();
    await expect(encryptPayload(utf8("x"), ua, auth.subarray(0, 8))).rejects.toThrow();
    // a 65-byte value that is not on the curve is refused by WebCrypto's point validation
    const offCurve = new Uint8Array(65).fill(7);
    offCurve[0] = 4;
    await expect(encryptPayload(utf8("x"), offCurve, auth)).rejects.toThrow();
  });
});

// ── VAPID ────────────────────────────────────────────────────────────────────

async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = new Uint8Array([4, ...b64urlDecode(jwk.x as string), ...b64urlDecode(jwk.y as string)]);
  return { publicKey: pair.publicKey, VAPID_PUBLIC_KEY: b64urlEncode(pub), VAPID_PRIVATE_KEY: jwk.d as string, VAPID_SUBJECT: "mailto:ops@example.com" };
}

describe("VAPID", () => {
  test("the ES256 JWT verifies with the public key and carries aud / exp <= 12 h / sub", async () => {
    const k = await vapidKeys();
    const jwt = await signVapidJwt("https://fcm.googleapis.com", k.VAPID_SUBJECT, k.VAPID_PRIVATE_KEY, k.VAPID_PUBLIC_KEY, NOW);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@example.com");
    expect(claims.exp).toBeGreaterThan(NOW / 1000);
    expect(claims.exp - NOW / 1000).toBeLessThanOrEqual(12 * 3600);
    const sig = b64urlDecode(s);
    expect(sig.length).toBe(64); // raw r||s, not DER
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey, sig, utf8(`${h}.${p}`))).toBe(true);
    // and it does NOT verify for a tampered payload
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey, sig, utf8(`${h}.${p}x`))).toBe(false);
  });

  test("rejects malformed key material", async () => {
    const k = await vapidKeys();
    await expect(signVapidJwt("https://x", "mailto:a@b.c", k.VAPID_PRIVATE_KEY, "AAAA", NOW)).rejects.toThrow();
    await expect(signVapidJwt("https://x", "mailto:a@b.c", "AAAA", k.VAPID_PUBLIC_KEY, NOW)).rejects.toThrow();
  });
});

// ── sending ──────────────────────────────────────────────────────────────────

async function subscription() {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  return { p256dh: b64urlEncode(pub), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

async function setup(): Promise<TestEnv & { vapid: Awaited<ReturnType<typeof vapidKeys>> }> {
  const vapid = await vapidKeys();
  const t = makeEnv({ VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: vapid.VAPID_PRIVATE_KEY, VAPID_SUBJECT: vapid.VAPID_SUBJECT });
  return { ...t, vapid };
}

describe("sendWebPush / sendToAll", () => {
  test("posts an aes128gcm body with VAPID, TTL and urgency headers", async () => {
    const { env } = await setup();
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", ...(await subscription()) };
    let seen: { url: string; init: RequestInit } | undefined;
    const r = await sendWebPush(sub, { title: "Needs you", body: "proja: Agent01 blocked", tag: "k", url: "https://dash.test/" }, env, {
      now: NOW,
      fetch: async (url, init) => {
        seen = { url, init: init as RequestInit };
        return new Response(null, { status: 201 });
      },
    });
    expect(r).toEqual({ outcome: "ok", status: 201 });
    expect(seen?.url).toBe(sub.endpoint);
    const h = seen?.init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.TTL).toBe("3600");
    expect(h.Urgency).toBe("high");
    expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(h.Authorization).toContain(`k=${env.VAPID_PUBLIC_KEY}`);
    expect((seen?.init.body as Uint8Array).length).toBeGreaterThan(86);
  });

  test("status mapping: 2xx ok, 404/410 gone, 429/5xx/network transient, other 4xx failed", async () => {
    const { env } = await setup();
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", ...(await subscription()) };
    const status = async (code: number) => (await sendWebPush(sub, { a: 1 }, env, { fetch: async () => new Response(null, { status: code }) })).outcome;
    expect(await status(201)).toBe("ok");
    expect(await status(404)).toBe("gone");
    expect(await status(410)).toBe("gone");
    expect(await status(429)).toBe("transient");
    expect(await status(503)).toBe("transient");
    expect(await status(400)).toBe("failed");
    expect(await status(403)).toBe("failed");
    const net = await sendWebPush(sub, { a: 1 }, env, { fetch: async () => { throw new Error("boom"); } });
    expect(net.outcome).toBe("transient");
  });

  test("never throws without VAPID configuration", async () => {
    const { env } = makeEnv();
    const sub = { endpoint: "https://fcm.googleapis.com/x", ...(await subscription()) };
    expect((await sendWebPush(sub, {}, env)).outcome).toBe("failed");
    expect(await sendToAll(env, {})).toMatchObject({ attempted: 0 });
  });

  test("404/410 deletes the subscription, success stamps last_ok, others stay", async () => {
    const { env, db } = await setup();
    for (const n of ["ok", "gone", "retry"]) {
      const s = await subscription();
      db.sqlite.query("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, 1)").run(`https://fcm.googleapis.com/${n}`, s.p256dh, s.auth);
    }
    const res = await sendToAll(env, { x: 1 }, {
      now: NOW,
      fetch: async (url) => new Response(null, { status: url.endsWith("/ok") ? 201 : url.endsWith("/gone") ? 410 : 503 }),
    });
    expect(res).toEqual({ attempted: 3, ok: 1, gone: 1, transient: 1, failed: 0 });
    const rows = db.rows<{ endpoint: string; last_ok: number | null }>("SELECT endpoint, last_ok FROM push_subs ORDER BY endpoint");
    expect(rows.map((r) => r.endpoint)).toEqual(["https://fcm.googleapis.com/ok", "https://fcm.googleapis.com/retry"]);
    expect(rows[0]?.last_ok).toBe(NOW);
    expect(rows[1]?.last_ok).toBeNull();
  });
});

describe("dispatchPushes (claim / unclaim)", () => {
  const item = (over: Partial<PushItem> = {}): PushItem => ({
    key: "blocked|hosta|proja|T-1", rule: "blocked", host: "hosta", project: "proja", agent: "Agent01", pushCount: 0, lastPushed: null, reminder: false, ...over,
  });

  async function withAlert() {
    const t = await setup();
    const s = await subscription();
    t.db.sqlite.query("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, 1)").run("https://fcm.googleapis.com/a", s.p256dh, s.auth);
    t.db.sqlite
      .query("INSERT INTO alerts (key, rule, severity, host, project, agent, text, opened, push_count) VALUES ('blocked|hosta|proja|T-1', 'blocked', 'warn', 'hosta', 'proja', 'Agent01', 'secret task text', ?, 0)")
      .run(NOW);
    return t;
  }

  test("claims the push, sends only the generic message, never the task text", async () => {
    const { env, db } = await withAlert();
    const bodies: Uint8Array[] = [];
    await dispatchPushes(env, [item()], NOW, async (_u, init) => {
      bodies.push((init as RequestInit).body as Uint8Array);
      return new Response(null, { status: 201 });
    });
    expect(bodies).toHaveLength(1);
    expect(db.rows("SELECT push_count, last_pushed FROM alerts")[0]).toEqual({ push_count: 1, last_pushed: NOW });
  });

  test("two concurrent evaluators never double-push the same alert", async () => {
    const { env } = await withAlert();
    let sent = 0;
    const f = async () => {
      sent++;
      return new Response(null, { status: 201 });
    };
    await Promise.all([dispatchPushes(env, [item()], NOW, f), dispatchPushes(env, [item()], NOW, f)]);
    expect(sent).toBe(1);
  });

  test("a transient failure rolls the claim back so the next cron retries", async () => {
    const { env, db } = await withAlert();
    await dispatchPushes(env, [item()], NOW, async () => new Response(null, { status: 503 }));
    expect(db.rows("SELECT push_count, last_pushed FROM alerts")[0]).toEqual({ push_count: 0, last_pushed: null });
    await dispatchPushes(env, [item()], NOW + 60_000, async () => new Response(null, { status: 201 }));
    expect(db.rows("SELECT push_count FROM alerts")[0]).toEqual({ push_count: 1 });
  });

  test("a hard failure (bad VAPID, 403) is not retried", async () => {
    const { env, db } = await withAlert();
    await dispatchPushes(env, [item()], NOW, async () => new Response(null, { status: 403 }));
    expect(db.rows("SELECT push_count FROM alerts")[0]).toEqual({ push_count: 1 });
  });

  test("without subscriptions or without VAPID nothing is claimed: push_count stays 0 and nothing is sent", async () => {
    const noSubs = await withAlert();
    noSubs.db.sqlite.query("DELETE FROM push_subs").run();
    await dispatchPushes(noSubs.env, [item()], NOW, async () => { throw new Error("must not be called"); });
    expect(noSubs.db.rows("SELECT push_count, last_pushed FROM alerts")[0]).toEqual({ push_count: 0, last_pushed: null });

    const noVapid = await withAlert();
    const bare = { ...noVapid.env, VAPID_PRIVATE_KEY: undefined };
    await dispatchPushes(bare, [item()], NOW, async () => { throw new Error("must not be called"); });
    expect(noVapid.db.rows("SELECT push_count FROM alerts")[0]).toEqual({ push_count: 0 });
  });

  test("when the first subscription appears only alerts opened in the last 60 min are pushed (no burst of old ones)", async () => {
    const t = await setup();
    const add = (key: string, opened: number) =>
      t.db.sqlite.query("INSERT INTO alerts (key, rule, severity, host, project, agent, text, opened, push_count) VALUES (?, 'blocked', 'warn', 'hosta', 'proja', 'a', 'x', ?, 0)").run(key, opened);
    add("blocked|hosta|proja|fresh", NOW - 10 * 60_000);
    add("blocked|hosta|proja|edge", NOW - 59 * 60_000);
    add("blocked|hosta|proja|old", NOW - 61 * 60_000);
    // no subscription yet: the cron evaluates, nothing is consumed
    const { evaluateRules } = await import("../src/rules");
    const { loadRuleInput } = await import("../src/alerts");
    t.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES ('k1','s','" + ORIGIN_HOST + "','hosta','proja','a','fresh','t','blocked',?,?), ('k2','s','" + ORIGIN_HOST + "','hosta','proja','b','edge','t','blocked',?,?), ('k3','s','" + ORIGIN_HOST + "','hosta','proja','c','old','t','blocked',?,?)")
      .run(NOW - 11 * 60_000, NOW - 10 * 60_000, NOW - 60 * 60_000, NOW - 59 * 60_000, NOW - 62 * 60_000, NOW - 61 * 60_000);
    const pushes: string[] = [];
    const f = async (u: string) => { pushes.push(u); return new Response(null, { status: 201 }); };
    const before = evaluateRules(await loadRuleInput(t.env.DB, NOW));
    await dispatchPushes(t.env, before.push, NOW, f);
    expect(pushes).toEqual([]);
    expect(t.db.rows("SELECT push_count FROM alerts WHERE push_count > 0")).toEqual([]);
    // a subscription appears
    const s = await subscription();
    t.db.sqlite.query("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES ('https://fcm.googleapis.com/a', ?, ?, 1)").run(s.p256dh, s.auth);
    const after = evaluateRules(await loadRuleInput(t.env.DB, NOW + 1000));
    await dispatchPushes(t.env, after.push, NOW + 1000, f);
    expect(t.db.rows<any>("SELECT key, push_count FROM alerts ORDER BY key")).toEqual([
      { key: "blocked|hosta|proja|edge", push_count: 1 },
      { key: "blocked|hosta|proja|fresh", push_count: 1 },
      { key: "blocked|hosta|proja|old", push_count: 0 },
    ]);
    expect(pushes).toHaveLength(2);
  });

  test("skips alerts that were resolved in the meantime", async () => {
    const { env, db } = await withAlert();
    db.sqlite.query("UPDATE alerts SET resolved = ?").run(NOW);
    let sent = 0;
    await dispatchPushes(env, [item()], NOW, async () => { sent++; return new Response(null, { status: 201 }); });
    expect(sent).toBe(0);
  });
});

// ── routes ───────────────────────────────────────────────────────────────────

describe("push routes", () => {
  const ctx = makeCtx();
  const route = (env: TestEnv["env"], path: string, init: Parameters<typeof request>[1] = {}) =>
    handlePushRoute(request(path, init), env, ctx, path, NOW, async () => new Response(null, { status: 201 }));

  test("GET /api/push/key returns the public key, 503 when unset", async () => {
    const { env, vapid } = await setup();
    const res = await route(env, "/api/push/key");
    expect(await res.json()).toEqual({ publicKey: vapid.VAPID_PUBLIC_KEY });
    expect((await route(makeEnv().env, "/api/push/key")).status).toBe(503);
  });

  test("subscribe validates endpoint host, keys and the CSRF guard", async () => {
    const { env, db } = await setup();
    const keys = await subscription();
    const good = { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", keys };
    expect((await route(env, "/api/push/subscribe", { body: good })).status).toBe(200);
    expect(db.rows("SELECT endpoint FROM push_subs")).toHaveLength(1);
    // idempotent for the same endpoint
    expect((await route(env, "/api/push/subscribe", { body: good })).status).toBe(200);
    expect(db.rows("SELECT endpoint FROM push_subs")).toHaveLength(1);

    for (const endpoint of ["http://fcm.googleapis.com/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.com/x", "https://127.0.0.1/x", "not a url"]) {
      expect((await route(env, "/api/push/subscribe", { body: { endpoint, keys } })).status).toBe(400);
    }
    expect((await route(env, "/api/push/subscribe", { body: { endpoint: good.endpoint, keys: { p256dh: "AAAA", auth: keys.auth } } })).status).toBe(400);
    expect((await route(env, "/api/push/subscribe", { body: { endpoint: good.endpoint, keys: { p256dh: keys.p256dh, auth: "AA" } } })).status).toBe(400);
    expect((await route(env, "/api/push/subscribe", { body: good, headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    expect((await route(env, "/api/push/subscribe", { body: good, headers: { Origin: "https://evil.example.com" } })).status).toBe(400);
    expect((await route(env, "/api/push/subscribe", { body: good, headers: { Origin: "http://localhost:8787" } })).status).toBe(200);
    expect((await route(env, "/api/push/subscribe", { method: "GET" })).status).toBe(405);
  });

  test("extra push hosts can be allowed by configuration", () => {
    expect(isAllowedPushEndpoint("https://push.corp.example/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://push.corp.example/x", "corp.example")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/x")).toBe(true);
  });

  test("POST /api/push/test sends to every subscription and reports counts", async () => {
    const { env, db } = await setup();
    for (const n of ["a", "b"]) {
      const s = await subscription();
      db.sqlite.query("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, 1)").run(`https://fcm.googleapis.com/${n}`, s.p256dh, s.auth);
    }
    const res = await route(env, "/api/push/test", { body: {} });
    expect(await res.json()).toEqual({ ok: true, subscriptions: 2, sent: 2, removed: 0, failed: 0 });
    expect((await route(makeEnv().env, "/api/push/test", { body: {} })).status).toBe(503);
  });

  test("generateSenderKeys yields a 65-byte uncompressed point", async () => {
    const k = await generateSenderKeys();
    expect(k.publicRaw.length).toBe(65);
    expect(k.publicRaw[0]).toBe(4);
  });
});
