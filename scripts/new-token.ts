#!/usr/bin/env bun
/**
 * Mint a bearer token for the dashboard and print what to run to register it.
 *
 *   bun scripts/new-token.ts <host-label|client-name> <host|client> [--rotate] [--task-text none|minimal|brief|full]
 *
 * - `host`   tokens go in the host integration's token setting, or SIISWELL_HOST_TOKEN for the siiswell usage collector. The name IS
 *            THE HOST LABEL the token is bound to: ingest answers 403 to any payload whose `host`
 *            differs, so it must equal the host label configured in the host agent, or `os.hostname()`
 *            when that is unset (case-sensitive). One token per host label; projects on the same
 *            host share it.
 * - `client` tokens go in a desktop client's MCP config / SIISWELL_TOKEN (any unique name).
 * - `--rotate` replaces the token of a source that ALREADY exists (lost, leaked or revoked): names are
 *            unique, so re-minting a revoked label with the INSERT would fail. It prints an UPDATE that
 *            swaps `token_sha256` and clears `revoked`; the row keeps its id, name and budgets, and
 *            the old token stops working the moment the UPDATE runs.
 *
 * - `--task-text MODE` sets this source's own ceiling for task text (`sources.task_text`, migration 0014); without it the source
 *            follows the server default (ACCEPT_TASK_TEXT). Later: UPDATE sources SET task_text = 'full' WHERE name = '<name>';
 *
 * The token is printed ONCE and never stored; only its sha256 goes into D1. This script does NOT
 * touch Cloudflare: it prints the `wrangler d1 execute` commands for you to run (remote = outward
 * facing: it changes your live database). Revoke a token with: UPDATE sources SET revoked = 1 WHERE name = '<name>';
 */
import { d1Name } from "./d1-name";

const DB = d1Name();

const args = process.argv.slice(2);
const rotate = args.includes("--rotate");
// --apply: register the hash in THIS machine's SQLite database (the Docker / self-hosted server) right away.
// It never runs wrangler and never touches Cloudflare.
const apply = args.includes("--apply");
const ttAt = args.indexOf("--task-text");
const taskText = ttAt >= 0 ? args[ttAt + 1] : undefined;
const [name, kind, ...rest] = args.filter((a, i) => a !== "--rotate" && a !== "--apply" && !(ttAt >= 0 && (i === ttAt || i === ttAt + 1)));

if (ttAt >= 0 && !["none", "minimal", "brief", "full"].includes(String(taskText))) {
  console.error("--task-text must be one of: none, minimal, brief, full");
  process.exit(1);
}
if (!name || (kind !== "host" && kind !== "client") || rest.length || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
  console.error("usage: bun scripts/new-token.ts <host-label|client-name> <host|client> [--rotate] [--task-text none|minimal|brief|full] [--apply]");
  console.error("  name: 1-64 chars of letters, digits, '.', '_' or '-' (e.g. hosta, client2)");
  console.error("  for a host token the name is the host label: it must equal the host label configured in the host agent (default: os.hostname())");
  console.error("  --rotate: replace the token of an existing (e.g. revoked) source instead of inserting a new one");
  console.error("  --apply:  register it now in the self-hosted server's SQLite (DB_PATH, else $DATA_DIR/siiswell.sqlite, DATA_DIR default /data)");
  process.exit(1);
}

const bytes = crypto.getRandomValues(new Uint8Array(32));
const token = "oct_" + Buffer.from(bytes).toString("base64url"); // oct_ + 43 characters: the only shape the Worker accepts
const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
const id = crypto.randomUUID();
const sql = rotate
  ? `UPDATE sources SET token_sha256 = '${sha256}', revoked = 0${taskText ? `, task_text = '${taskText}'` : ""} WHERE name = '${name}' AND kind = '${kind}';`
  : `INSERT INTO sources (id, name, kind, token_sha256, created${taskText ? ", task_text" : ""}) VALUES ('${id}', '${name}', '${kind}', '${sha256}', ${Date.now()}${taskText ? `, '${taskText}'` : ""});`;

let applied = "";
if (apply) {
  const { SqliteD1 } = await import("../src/server/d1-sqlite");
  const { defaultDbPath } = await import("../src/server/config");
  const { join } = await import("node:path");
  const path = process.env.DB_PATH || defaultDbPath(process.env.DATA_DIR || "/data");
  const adapter = new SqliteD1({ path, migrationsDir: join(import.meta.dir, "..", "migrations") }); // creates + migrates if needed
  try {
    adapter.sqlite.exec(sql);
    const changed = (adapter.sqlite.query("SELECT changes() AS c").get() as { c: number }).c;
    if (changed !== 1) {
      console.error(rotate ? `no ${kind} source named "${name}" to rotate in ${path}` : `nothing was registered in ${path}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`could not register "${name}" in ${path}: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
    process.exit(1);
  } finally {
    adapter.close();
  }
  applied = path;
}

const next =
  kind === "host"
    ? `This token is bound to the host label "${name}": every snapshot, event and heartbeat it sends must carry
host: "${name}" (the host label configured in the host agent, or os.hostname() when unset; case-sensitive), otherwise
the dashboard answers 403. Check with: node -p "require('os').hostname()"

Then on the host: SIISWELL_HOST_TOKEN=${token} for the usage collector ("hostToken" in its config file, mode 0600),
or the token setting of your host integration (keep its file mode 0600).`
    : `Then give the client SIISWELL_TOKEN=${token}  (see docs/INSTALL-CLIENTS.md)`;

console.log(
  applied
    ? `
token (shown once, copy it now): ${token}

Registered in ${applied}: ${kind} source "${name}" is ready to use.

${next}
`
    : `
token (shown once, copy it now): ${token}

${rotate ? `Rotate the token of ${kind} source "${name}": the UPDATE below swaps its hash and clears revoked; the old
token stops working as soon as it runs, and its id, name and budgets are kept. Verify with
"SELECT name, kind, revoked FROM sources WHERE name = '${name}'" that exactly one row exists first.` : "Register its hash."} Nothing below has been run.

  # self-hosted (Docker): register it directly instead
  bun scripts/new-token.ts ${name} ${kind}${rotate ? " --rotate" : ""} --apply      (inside the container: docker compose exec siiswell ...)

  # local dev database (safe)
  bunx wrangler d1 execute ${DB} --local --command "${sql}"

  # production (changes your live database; run it once the Worker and D1 are deployed)
  bunx wrangler d1 execute ${DB} --remote --command "${sql}"

${next}
`,
);
