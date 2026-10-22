#!/usr/bin/env bun
/**
 * Run SQL against the self-hosted server's SQLite database (the Docker counterpart of `wrangler d1 execute`), e.g. the
 * INSERT / UPDATE that scripts/new-token.ts or scripts/purge-source.ts print.
 *
 *   docker compose exec siiswell bun scripts/db-exec.ts "SELECT name, kind, revoked FROM sources"
 *   echo "<sql>" | docker compose exec -T siiswell bun scripts/db-exec.ts
 *
 * Database: DB_PATH, else $DATA_DIR/siiswell.sqlite (DATA_DIR default /data). Safe while the server runs (WAL).
 * Before the server's first start the file does not exist yet: it is created and the migrations applied (exactly what
 * the server does at startup), so tokens can be registered first.
 */
import { defaultDbPath } from "../src/server/config";
import { join } from "node:path";
import { SqliteD1 } from "../src/server/d1-sqlite";

const path = process.env.DB_PATH || defaultDbPath(process.env.DATA_DIR || "/data");
const sql = process.argv.slice(2).join(" ").trim() || (await new Response(Bun.stdin.stream()).text()).trim();
if (!sql) {
  console.error('usage: bun scripts/db-exec.ts "<sql>"   (or pipe the SQL on stdin)');
  process.exit(1);
}
const adapter = new SqliteD1({ path, migrationsDir: join(import.meta.dir, "..", "migrations") }); // creates + migrates if needed
const db = adapter.sqlite;
if (/^\s*(select|with|pragma)\b/i.test(sql) && !sql.replace(/;\s*$/, "").includes(";")) console.table(db.query(sql).all());
else {
  db.exec(sql);
  console.log(`ok (${(db.query("SELECT changes() AS c").get() as { c: number }).c} row(s) changed by the last statement)`);
}
adapter.close();
