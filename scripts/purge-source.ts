#!/usr/bin/env bun
/**
 * Print the SQL that deletes EVERY row a source (a host token or an MCP client token) wrote, for use after
 * revoking a leaked token. It does NOT touch Cloudflare and runs nothing: you run the printed lines yourself
 * (`wrangler d1 execute <db-name> --remote ...`, outward-facing: it changes your live database).
 *
 *   bun scripts/purge-source.ts <name> [--id <source-id>]
 *
 * What a source wrote, and where it is found:
 *   events, tasks, snapshots, hosts   by `source_id` (the sources row, looked up by NAME; pass `--id` when the
 *                                     row itself has been deleted)
 *   alerts                            by `host`: the alert host label IS the token-bound source name (a host
 *                                     label, or the client name for MCP alerts), including the source's own
 *                                     `budget-exhausted` and `host-offline` alerts
 *   usage_daily, usage_hosts          by `host` (the token-bound label; the key of every usage row carries it)
 *   push_budget                       by `owner` (the column, never the key text: every budget key of a source carries its
 *                                     name as owner, see src/keys.ts)
 * Revoke the token FIRST (`UPDATE sources SET revoked = 1 WHERE name = '<name>'`), otherwise it can write
 * the rows again. The deletes are ordinary single statements (no triggers, no cascades); `PRAGMA foreign_keys`
 * is not involved (the schema has no foreign keys).
 */
import { d1Name } from "./d1-name";

const DB = d1Name();
const args = process.argv.slice(2);
const idIdx = args.indexOf("--id");
const idArg = idIdx >= 0 ? args.splice(idIdx, 2)[1] : undefined;
const [name, ...rest] = args;

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
if (!name || rest.length || !NAME_RE.test(name) || (idArg !== undefined && !ID_RE.test(idArg))) {
  console.error("usage: bun scripts/purge-source.ts <source-name> [--id <source-id>]");
  console.error("  name: the source name (host label or client name): 1-64 chars of letters, digits, '.', '_' or '-'");
  console.error("  prints the DELETE statements for everything that source wrote; runs nothing");
  process.exit(1);
}

const owner = idArg !== undefined ? `'${idArg}'` : `(SELECT id FROM sources WHERE name = '${name}')`;
const sql = [
  `DELETE FROM events    WHERE source_id = ${owner};`,
  `DELETE FROM tasks     WHERE source_id = ${owner};`,
  `DELETE FROM snapshots WHERE source_id = ${owner};`,
  `DELETE FROM hosts     WHERE source_id = ${owner} OR host = '${name}';`,
  `DELETE FROM project_seen WHERE host = '${name}';`,   // migration 0002
  `DELETE FROM usage_daily WHERE host = '${name}';`,   // migration 0003: the usage rows the host wrote (host is part of the key)
  `DELETE FROM usage_hosts WHERE host = '${name}';`,
  `DELETE FROM alerts    WHERE host = '${name}';`,
  `DELETE FROM push_budget WHERE owner = '${name}';`,
];

console.log(`
Rows written by source "${name}"${idArg !== undefined ? ` (id ${idArg})` : ""}. Nothing below has been run.

1. Revoke the token first, so it cannot write again (skip if already done):

     UPDATE sources SET revoked = 1 WHERE name = '${name}';

2. Then delete what it wrote:

${sql.map((l) => `     ${l}`).join("\n")}

Run them one by one:

  # local dev database (safe)
  bunx wrangler d1 execute ${DB} --local --command "<one line from above>"

  # production (changes your live database)
  bunx wrangler d1 execute ${DB} --remote --command "<one line from above>"

Afterwards GET /api/state shows the project / host / alerts gone; the next cron minute re-evaluates the rules.
To let the source write again, rotate its token: bun scripts/new-token.ts ${name} <host|client> --rotate
`);
