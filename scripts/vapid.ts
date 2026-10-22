#!/usr/bin/env bun
/**
 * Generate a VAPID key pair for Web Push and print it in the formats the Worker expects.
 *
 *   bun scripts/vapid.ts [mailto:you@example.com]
 *
 * Prints the keys once; nothing is written to disk and nothing contacts Cloudflare. Set them with
 * `wrangler secret put` (outward-facing, at deploy time) or, for local dev, in .dev.vars
 * (gitignored). Treat VAPID_PRIVATE_KEY like a password: anyone holding it can send pushes to
 * every device subscribed to this dashboard.
 */

const subject = process.argv[2] ?? "mailto:you@example.com";
if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
  console.error("usage: bun scripts/vapid.ts [mailto:you@example.com | https://your.site]");
  process.exit(1);
}

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
const rawPublic = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, "base64url"), Buffer.from(jwk.y as string, "base64url")]);

const publicKey = rawPublic.toString("base64url"); // 65-byte uncompressed point, what the browser needs as applicationServerKey
const privateKey = jwk.d as string; // 32-byte scalar, already base64url without padding

console.log(`
VAPID_PUBLIC_KEY  = ${publicKey}
VAPID_PRIVATE_KEY = ${privateKey}
VAPID_SUBJECT     = ${subject}

Production (outward-facing, run from the repo root after the Worker exists; paste the value when asked):
  bunx wrangler secret put VAPID_PUBLIC_KEY
  bunx wrangler secret put VAPID_PRIVATE_KEY
  bunx wrangler secret put VAPID_SUBJECT

Docker / self-hosted: add these three lines to .env (keep it private), then \`docker compose up -d\`:

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=${subject}

Local dev: the same three lines in .dev.vars (gitignored, never commit it).
`);
