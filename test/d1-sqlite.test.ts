/**
 * The SQLite adapter (src/server/d1-sqlite.ts) against the D1 behaviours this code relies on. The whole suite runs on
 * it through test/d1-shim.ts; these are the parity points that matter for the self-hosted server.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteD1, applyMigrations, MAX_BOUND_PARAMS } from "../src/server/d1-sqlite";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

describe("d1-sqlite adapter", () => {
  test("batch is one transaction: a failing statement rolls back the earlier ones", async () => {
    const db = new SqliteD1();
    await db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)");
    await db.prepare("INSERT INTO t VALUES (?, ?)").bind("a", 1).run();
    await expect(
      db.batch([db.prepare("INSERT INTO t VALUES (?, ?)").bind("b", 2), db.prepare("INSERT INTO t VALUES (?, ?)").bind("a", 3)]),
    ).rejects.toThrow();
    expect(db.rows("SELECT k FROM t ORDER BY k")).toEqual([{ k: "a" }]);
    // and the connection is usable afterwards (no transaction left open)
    const res = await db.batch([db.prepare("INSERT INTO t VALUES (?, ?)").bind("c", 4)]);
    expect(res[0]?.meta.changes).toBe(1);
  });

  test("bind rejects undefined, booleans and more than the D1 parameter limit; bind returns a new statement", () => {
    const db = new SqliteD1();
    const s = db.prepare("SELECT ?");
    expect(() => s.bind(undefined)).toThrow(/D1_TYPE_ERROR/);
    expect(() => s.bind(true)).toThrow(/D1_TYPE_ERROR/);
    expect(() => s.bind(...Array.from({ length: MAX_BOUND_PARAMS + 1 }, () => 1))).toThrow(/too many/);
    expect(s.bind(1)).not.toBe(s);
  });

  test("meta.changes counts the statement's own rows, not trigger writes; RETURNING answers rows", async () => {
    const db = new SqliteD1();
    await db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER); CREATE TABLE log (x INTEGER);" +
      "CREATE TRIGGER tr AFTER UPDATE ON t BEGIN INSERT INTO log VALUES (1); INSERT INTO log VALUES (2); END;");
    await db.prepare("INSERT INTO t VALUES ('a', 1), ('b', 2)").run();
    const upd = await db.prepare("UPDATE t SET v = v + 1").run();
    expect(upd.meta.changes).toBe(2);
    const ret = await db.prepare("UPDATE t SET v = 0 WHERE k = ? RETURNING k").bind("a").run();
    expect(ret.results).toEqual([{ k: "a" }]);
    expect(ret.meta.changes).toBe(1);
  });

  test("first() / first(col) (throws on a missing column, like D1) / raw() / last_row_id", async () => {
    const db = new SqliteD1();
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = await db.prepare("INSERT INTO t (v) VALUES (?)").bind("x").run();
    expect(ins.meta.last_row_id).toBe(1);
    expect(await db.prepare("SELECT * FROM t").first()).toEqual({ id: 1, v: "x" });
    expect(await db.prepare("SELECT v FROM t").first("v")).toBe("x");
    expect(await db.prepare("SELECT * FROM t WHERE id = 9").first()).toBeNull();
    await expect(db.prepare("SELECT v FROM t").first("nope")).rejects.toThrow(/D1_COLUMN_NOTFOUND/); // as D1
    expect(await db.prepare("SELECT v FROM t WHERE id = 9").first("nope")).toBeNull(); // no row: null, column not checked
    expect(await db.prepare("SELECT id, v FROM t").raw()).toEqual([[1, "x"]]);
  });

  test("WITHOUT ROWID, TOTAL(), json_each / json_extract, upsert behave as in D1", async () => {
    const db = new SqliteD1();
    await db.exec("CREATE TABLE w (k TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID");
    await db.prepare("INSERT INTO w VALUES ('a', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1").run();
    await db.prepare("INSERT INTO w VALUES ('a', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1").run();
    expect(db.rows("SELECT * FROM w")).toEqual([{ k: "a", n: 2 }]);
    expect(db.rows("SELECT TOTAL(n) AS t FROM w WHERE k = 'none'")).toEqual([{ t: 0 }]); // TOTAL of nothing is 0.0, SUM is NULL
    const r = await db.prepare("SELECT SUM(json_extract(value, '$.n')) AS s FROM json_each(?)").bind(JSON.stringify([{ n: 2 }, { n: 3 }])).all();
    expect(r.results).toEqual([{ s: 5 }]);
    expect(db.rows("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  test("migrations: applied in order, recorded, idempotent on a file database; a broken one rolls back and throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "siiswell-d1-"));
    try {
      const file = join(dir, "db.sqlite");
      const a = new SqliteD1({ path: file, migrationsDir: MIGRATIONS });
      expect(a.rows<{ journal_mode: string }>("PRAGMA journal_mode")[0]?.journal_mode).toBe("wal");
      const names = a.rows<{ name: string }>("SELECT name FROM _migrations ORDER BY name").map((r) => r.name);
      expect(names.length).toBeGreaterThanOrEqual(3);
      expect(names).toEqual([...names].sort());
      a.close();
      const b = new SqliteD1({ path: file });
      expect(applyMigrations(b.sqlite, MIGRATIONS)).toEqual([]);

      const bad = join(dir, "mig");
      mkdirSync(bad);
      writeFileSync(join(bad, "0001_ok.sql"), "CREATE TABLE ok1 (x INTEGER);");
      writeFileSync(join(bad, "0002_bad.sql"), "CREATE TABLE half (x INTEGER); NOT SQL;");
      expect(() => applyMigrations(b.sqlite, bad)).toThrow(/0002_bad\.sql/);
      expect(b.rows("SELECT name FROM sqlite_master WHERE name IN ('ok1', 'half')")).toEqual([{ name: "ok1" }]);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rows are decided by result columns, not by the statement's text", async () => {
    const db = new SqliteD1();
    await db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)");
    await db.prepare("INSERT INTO t VALUES ('a', 1)").run();
    const commented = await db.prepare("-- leading comment\n/* and another */ SELECT k, v FROM t").all();
    expect(commented.results).toEqual([{ k: "a", v: 1 }]);
    expect(commented.meta.changes).toBe(0);
    const values = await db.prepare("VALUES (1), (2)").all();
    expect(values.results).toHaveLength(2);
    const ret = await db.prepare("-- c\nINSERT INTO t VALUES ('b', 2) RETURNING k").run();
    expect(ret.results).toEqual([{ k: "b" }]);
    expect(ret.meta.changes).toBe(1);
    const noop = await db.prepare("UPDATE t SET v = 9 WHERE k = 'zz' RETURNING k").run();
    expect(noop.results).toEqual([]);
    expect(noop.meta.changes).toBe(0);
    // a column literally named "returning" in a plain write is not mistaken for RETURNING
    await db.exec("CREATE TABLE r (\"returning\" TEXT)");
    const plain = await db.prepare("INSERT INTO r (\"returning\") VALUES ('x')").run();
    expect(plain.results).toEqual([]);
    expect(plain.meta.changes).toBe(1);
  });

  test("migrations: seeded from wrangler's d1_migrations (imported D1 export); transaction statements refused, triggers allowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "siiswell-mig-"));
    try {
      const imported = new SqliteD1();
      imported.sqlite.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP)");
      imported.sqlite.exec("INSERT INTO d1_migrations (name) VALUES ('0001_ok.sql')");
      imported.sqlite.exec("CREATE TABLE ok1 (x INTEGER)"); // what 0001 created on D1
      writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE ok1 (x INTEGER);");
      writeFileSync(join(dir, "0002_trigger.sql"), "CREATE TABLE t2 (x INTEGER);\nCREATE TRIGGER tr AFTER INSERT ON t2 BEGIN\n  INSERT INTO ok1 VALUES (NEW.x);\nEND;\n-- BEGIN; in a comment is fine\nINSERT INTO t2 VALUES (1);");
      expect(applyMigrations(imported.sqlite, dir)).toEqual(["0002_trigger.sql"]);
      expect(imported.rows("SELECT x FROM ok1")).toEqual([{ x: 1 }]);

      for (const [i, bad] of ["BEGIN;\nCREATE TABLE b1 (x INTEGER);\nCOMMIT;", "CREATE TABLE b2 (x INTEGER); commit", "BEGIN IMMEDIATE TRANSACTION; SELECT 1;", "SAVEPOINT s; SELECT 1;", "SELECT 1; ROLLBACK;"].entries()) {
        const d = join(dir, `bad${i}`);
        mkdirSync(d);
        writeFileSync(join(d, "0001_bad.sql"), bad);
        const fresh = new SqliteD1();
        expect(() => applyMigrations(fresh.sqlite, d)).toThrow(/transaction statements/);
        expect(fresh.rows("SELECT name FROM sqlite_master WHERE name LIKE 'b%'")).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
