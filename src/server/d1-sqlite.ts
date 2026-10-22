/**
 * @file D1-compatible database over `bun:sqlite`: the storage adapter of the self-hosted (Bun / Docker) server, and
 * the database the test suite runs on, so there is exactly ONE implementation of the D1 surface this code uses.
 * @module server/d1-sqlite
 *
 * Surface (everything src/ calls): `prepare(sql).bind(...).run() / all() / first(col?) / raw()`, `batch([...])`,
 * `exec(sql)`. How the D1-specific behaviours are matched:
 *  - batch(): ONE transaction (BEGIN ... COMMIT, ROLLBACK on the first error), like D1's batch. Nothing awaits inside
 *    the loop, so no other statement can interleave on the single connection.
 *  - bind(): `undefined` and booleans are rejected, more than 100 parameters are rejected (D1's limit), numbers /
 *    strings / null pass. A statement is immutable: bind() returns a new one (D1 does the same).
 *  - rows: a statement answers rows iff it has result columns (`columnNames`), never by guessing from its text.
 *  - meta.changes: the statement's OWN rows (`changes()`), not rows written by triggers (bun's `run().changes` counts those;
 *    the local D1 runtime does too, which is why the code claims budgets with RETURNING and never reads `changes`).
 *    `UPDATE/INSERT ... RETURNING` answers rows in `results`, like D1, and `changes` is the number of rows returned.
 *  - first(col) throws D1_COLUMN_NOTFOUND when the row has no such column (D1 does); no row at all is null.
 *  - meta.last_row_id = last_insert_rowid() (rowid tables); WITHOUT ROWID tables work as in D1 (same SQLite engine).
 *  - SQL functions (json_each / json_extract / TOTAL() / RETURNING / upsert) come from the SQLite bundled with Bun, which
 *    is newer than D1's; the code only uses what D1 has too.
 *  - PRAGMA: foreign_keys=ON like D1 (the schema has no FKs today), WAL + synchronous=NORMAL + busy_timeout for a file db
 *    (D1 manages these itself).
 *  - Migrations are applied in file order at startup, each in one transaction, recorded in `_migrations` (idempotent).
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Param = string | number | null;

/** Test switch: mimic the local D1 runtime, whose `changes` also counts rows written by triggers. */
export const shimOptions = { inflateChanges: false };

/** D1 refuses more bound parameters than this per statement. */
export const MAX_BOUND_PARAMS = 100;

export interface D1ResultLike {
  success: true;
  results: Record<string, unknown>[];
  meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number; changed_db: boolean };
}

const meta = (changes: number, lastRowId: number): D1ResultLike["meta"] => ({
  changes,
  last_row_id: lastRowId,
  duration: 0,
  rows_read: 0,
  rows_written: changes,
  changed_db: changes > 0,
});

export class SqliteStatement {
  constructor(
    private readonly db: Database,
    readonly sql: string,
    private readonly params: Param[] = [],
    private readonly log?: (sql: string) => void,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    for (const v of values) {
      if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
      if (typeof v === "boolean") throw new Error("D1_TYPE_ERROR: booleans are not supported, bind 0/1");
    }
    if (values.length > MAX_BOUND_PARAMS) throw new Error(`D1_ERROR: too many bound parameters (max ${MAX_BOUND_PARAMS})`);
    return new SqliteStatement(this.db, this.sql, values as Param[], this.log);
  }

  /** Synchronous core shared by run/all/first and batch. */
  exec(): D1ResultLike {
    this.log?.(this.sql);
    const q = this.db.query(this.sql);
    // A statement answers rows iff it has result columns (SELECT, WITH, PRAGMA, ... RETURNING), whatever its text
    // starts with (comments included). Whether it WROTE is told by total_changes(): a write ... RETURNING reports
    // the rows it returned as its changes (D1 does), a read reports 0.
    if (q.columnNames.length > 0) {
      const before = this.totalChanges();
      const rows = q.all(...this.params) as Record<string, unknown>[];
      const wrote = this.totalChanges() !== before;
      const changes = wrote ? rows.length : 0;
      return { success: true, results: rows, meta: meta(shimOptions.inflateChanges && wrote ? changes + 7 : changes, 0) };
    }
    const r = q.run(...this.params);
    const own = (this.db.query("SELECT changes() AS c").get() as { c: number }).c;
    return { success: true, results: [], meta: meta(shimOptions.inflateChanges ? r.changes : own, Number(r.lastInsertRowid)) };
  }

  private totalChanges(): number {
    return (this.db.query("SELECT total_changes() AS c").get() as { c: number }).c;
  }

  async run(): Promise<D1ResultLike> {
    return this.exec();
  }
  async all(): Promise<D1ResultLike> {
    return this.exec();
  }
  async first(column?: string): Promise<unknown> {
    this.log?.(this.sql);
    const row = this.db.query(this.sql).get(...this.params) as Record<string, unknown> | null;
    if (!row) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] ?? null;
  }
  async raw(): Promise<unknown[][]> {
    this.log?.(this.sql);
    return this.db.query(this.sql).values(...this.params) as unknown[][];
  }
}

export interface SqliteD1Options {
  /** Database file; default ":memory:". */
  path?: string;
  /** Directory of NNNN_name.sql migrations applied at construction (default: none). */
  migrationsDir?: string;
}

/**
 * Transaction control inside a migration file would end the transaction each file runs in (a failure could then
 * leave half a migration applied). Matched as whole statements, so `CREATE TRIGGER ... BEGIN ... END` passes.
 */
const TXN_STATEMENT = /(?:^|;)\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*(?:;|$)|COMMIT\b|END(?:\s+TRANSACTION)?\s*(?:;|$)|ROLLBACK\b|SAVEPOINT\b|RELEASE\b)/i;
/** The text the check looks at: no comments, no string literals, no trigger bodies (their BEGIN ... END is not a transaction). */
const stripSqlComments = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b[\s\S]*?\bBEGIN\b[\s\S]*?\bEND\s*(?:;|$)/gi, ";");

/**
 * Apply `dir/*.sql` in name order, each once, each in its own transaction (recorded in `_migrations`). Returns the
 * names applied now.
 *  - A database imported from a D1 export carries wrangler's `d1_migrations` table: when `_migrations` is still
 *    empty it is seeded from there, so migrations D1 already ran are not run again.
 *  - Files containing transaction statements (BEGIN / COMMIT / ROLLBACK / SAVEPOINT ...) are refused.
 *  - `PRAGMA foreign_keys` is a no-op inside a transaction, so a migration cannot switch it (the connection keeps
 *    foreign_keys = ON, like D1); a migration that rebuilds a table referenced by foreign keys needs care.
 */
export function applyMigrations(db: Database, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) WITHOUT ROWID");
  const hasD1 = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get() !== null;
  if (hasD1 && (db.query("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number }).n === 0) {
    db.query("INSERT OR IGNORE INTO _migrations (name, applied_at) SELECT name, ? FROM d1_migrations").run(Date.now());
  }
  const done = new Set((db.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    if (TXN_STATEMENT.test(stripSqlComments(sql))) throw new Error(`migration ${f} contains transaction statements (each file already runs in one transaction)`);
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(f, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${f} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    applied.push(f);
  }
  return applied;
}

export class SqliteD1 {
  readonly sqlite: Database;
  /** Number of prepared statements executed through batch() (to assert subrequest-budget behaviour). */
  executed = 0;
  /** Number of batch() calls (each is ONE subrequest on D1, however many statements it holds). */
  batches = 0;
  /** The SQL text of every statement executed through the D1 API, in order, when `recordStatements` is on (tests). */
  readonly statements: string[] = [];
  recordStatements = false;

  constructor(opts: SqliteD1Options = {}) {
    const path = opts.path ?? ":memory:";
    this.sqlite = new Database(path, { create: true });
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") {
      this.sqlite.exec("PRAGMA journal_mode = WAL");
      this.sqlite.exec("PRAGMA synchronous = NORMAL");
      this.sqlite.exec("PRAGMA busy_timeout = 5000");
    }
    if (opts.migrationsDir) applyMigrations(this.sqlite, opts.migrationsDir);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.sqlite, sql, [], this.recordStatements ? (s) => this.statements.push(s) : undefined);
  }

  async batch(stmts: SqliteStatement[]): Promise<D1ResultLike[]> {
    this.batches++;
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        this.executed++;
        return s.exec();
      });
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  /** Test / CLI convenience: run a query and return rows. */
  rows<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.sqlite.query(sql).all(...params) as T[];
  }

  close(): void {
    this.sqlite.close();
  }
}
