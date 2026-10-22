#!/usr/bin/env bun
/**
 * Make ADMIN_PASSWORD_HASH for the self-hosted server (AUTH_MODE=builtin): an argon2id hash (Bun.password).
 *
 *   bun scripts/hash-password.ts            (reads the password from stdin, first line; nothing is written to disk)
 *   docker run --rm -i siiswell bun scripts/hash-password.ts
 *
 * Use a LONG RANDOM password (a password manager's 20+ characters, or e.g. `openssl rand -base64 24`): the login rate
 * limits only slow a guesser down, the password's length is the real defence. Fewer than 12 characters is refused.
 * The password is read from stdin rather than argv so it does not land in shell history or `ps`.
 * In docker-compose.yml / .env files every `$` of the hash must be written `$$` (compose interpolates `$`).
 */
const tty = process.stdin.isTTY;
if (tty) process.stderr.write("Admin password (min 12 characters, input is echoed; pipe it in to avoid that): ");
const line = (await new Response(Bun.stdin.stream()).text()).split(/\r?\n/)[0] ?? "";
if (line.length < 12 || line.length > 1024) {
  console.error("password must be 12-1024 characters");
  process.exit(1);
}
// Bun's argon2id default (m=65536 KiB, t=2) is above the floor the server checks at startup (m >= 19456, t >= 2).
console.log(await Bun.password.hash(line, { algorithm: "argon2id" }));
