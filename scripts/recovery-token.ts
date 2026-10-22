#!/usr/bin/env bun
/**
 * Mint a ONE-TIME login recovery code for the self-hosted server (AUTH_MODE=builtin).
 *
 *   docker compose exec siiswell bun scripts/recovery-token.ts
 *   DATA_DIR=./data bun scripts/recovery-token.ts            (without Docker)
 *
 * Use it when the login page refuses you with 429 because of somebody else's guessing (for example right after a
 * password change, which voids every known-device cookie): enter it under "Recovery code" together with the password.
 * That login skips the per-address, per-prefix and global limits once. The code is printed ONCE; only its sha256 is
 * stored. It expires after 24 h, after one successful login, or after 5 wrong passwords. It is not a password: the
 * admin password is still required.
 */
import { defaultDbPath } from "../src/server/config";
import { join } from "node:path";
import { RECOVERY_TABLE_SQL, RECOVERY_TTL_MS } from "../src/server/auth";
import { SqliteD1 } from "../src/server/d1-sqlite";
import { sha256Hex } from "../src/util";

const path = process.env.DB_PATH || defaultDbPath(process.env.DATA_DIR || "/data");
const adapter = new SqliteD1({ path, migrationsDir: join(import.meta.dir, "..", "migrations") }); // creates + migrates if needed
const db = adapter.sqlite;
db.exec(RECOVERY_TABLE_SQL);
const now = Date.now();
db.query("DELETE FROM auth_recovery WHERE expires <= ? OR used_at IS NOT NULL").run(now);
const code = `orr_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
db.query("INSERT INTO auth_recovery (id_sha256, created, expires) VALUES (?, ?, ?)").run(await sha256Hex(code), now, now + RECOVERY_TTL_MS);
adapter.close();
console.log(`${code}\n(one-time recovery code, valid until ${new Date(now + RECOVERY_TTL_MS).toISOString()}; enter it with the admin password)`);
