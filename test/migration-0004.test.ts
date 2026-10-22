import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../src/index";
import { applyMigrations } from "../src/server/d1-sqlite";
import { LEGACY_ORIGIN_ALIASES, ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const legacyOf = (canonical: string) => Object.entries(LEGACY_ORIGIN_ALIASES).find(([, v]) => v === canonical)![0];
const OLD_HOST = legacyOf(ORIGIN_HOST);
const OLD_RELAY = legacyOf(ORIGIN_RELAY);

function insertRows(db: Database, origins: string[]) {
  origins.forEach((o, i) => {
    db.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 's', ?, 'h', 'p', 'a', ?, 't', 'running', 1, 1)").run(`k${i}`, o, `t${i}`);
    db.query("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES ('s', ?, 'h', 'p', 'status', ?, 'info', 'x', 1, 1)").run(`e${i}`, o);
    db.query("INSERT INTO alerts (key, rule, severity, origin, host, text, opened) VALUES (?, 'blocked', 'warn', ?, 'h', 'x', 1)").run(`a${i}`, o);
  });
}
const originsOf = (db: Database, table: string) => (db.query(`SELECT origin FROM ${table} ORDER BY rowid`).all() as { origin: string }[]).map((r) => r.origin);

describe("migration 0004: neutral origin values", () => {
  test("a fresh database gets 0001..0004; every alerts insert names its origin (the legacy 0001 DEFAULT is never used)", () => {
    const db = new Database(":memory:");
    expect(applyMigrations(db, MIGRATIONS)).toEqual(readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort());
    const src = readdirSync(join(import.meta.dir, "..", "src")).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(import.meta.dir, "..", "src", f), "utf8")).join("\n");
    const inserts = src.match(/INSERT[^`(]*INTO alerts\s*\(([^)]*)\)/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const i of inserts) expect(i).toContain("origin");
  });

  test("on a database with legacy rows: only 0004 runs, every legacy origin is rewritten, others are untouched, idempotent", () => {
    const old = mkdtempSync(join(tmpdir(), "siiswell-mig-"));
    for (const f of readdirSync(MIGRATIONS).filter((f) => f < "0004")) copyFileSync(join(MIGRATIONS, f), join(old, f));
    const db = new Database(":memory:");
    applyMigrations(db, old);
    insertRows(db, [OLD_HOST, OLD_RELAY, "mcp", ORIGIN_HOST]);
    expect(applyMigrations(db, MIGRATIONS)).toEqual(["0004_neutral_origins.sql", "0005_usage_hourly.sql", "0006_task_machine.sql", "0007_wellbeing.sql", "0008_wellbeing_indexes.sql", "0009_otlp_seen.sql", "0010_task_client_ref.sql", "0011_human_hourly.sql", "0012_clear_last_line.sql", "0013_client_version.sql", "0014_task_kind.sql", "0015_scrub_host_text.sql"]);
    for (const t of ["tasks", "events", "alerts"]) expect(originsOf(db, t)).toEqual(["host", "relay", "mcp", "host"]);
    db.exec(readFileSync(join(MIGRATIONS, "0004_neutral_origins.sql"), "utf8"));
    for (const t of ["tasks", "events", "alerts"]) expect(originsOf(db, t)).toEqual(["host", "relay", "mcp", "host"]);
    expect(applyMigrations(db, MIGRATIONS)).toEqual([]);
  });

  test("ingest still accepts the legacy values and stores the canonical ones", async () => {
    const t = makeEnv();
    const token = await addSource(t.db, "hosta", "host");
    const now = 1_800_000_000_000;
    const body = {
      v: 1, host: "hosta", project: "proja",
      events: [
        { kind: "halt", origin: OLD_HOST, at: now - 1000, severity: "critical", key: "ev-1", agent: "Agent02", scenario: "restart-failed", text: "restart failed" },
        { kind: "status", origin: OLD_RELAY, at: now - 1000, severity: "info", key: "ev-2", agent: "bot", sender: "@bot:example.org", status: "IN_PROGRESS", etaMin: 10, text: "working on it" },
      ],
    };
    const res = await route(request("/api/ingest/events", { token, body }), t.env, makeCtx(), { now });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(2);
    expect(t.db.sqlite.query("SELECT key, origin FROM events ORDER BY key").all()).toEqual([{ key: "ev-1", origin: "host" }, { key: "ev-2", origin: "relay" }]);
    expect(t.db.sqlite.query("SELECT DISTINCT origin FROM tasks").all()).toEqual([{ origin: "relay" }]);
    const legacy = new Set(Object.keys(LEGACY_ORIGIN_ALIASES));
    for (const table of ["tasks", "events", "alerts"]) for (const r of t.db.sqlite.query(`SELECT origin FROM ${table}`).all() as { origin: string }[]) expect(legacy.has(r.origin)).toBe(false);
  });
});

describe("transition: a new Worker on rows that 0004 has not rewritten yet", () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  async function boot() {
    const t = makeEnv();
    const ctx = makeCtx();
    const token = await addSource(t.db, "hosta", "host");
    const ins = (key: string, origin: string, state: string, updated: number, task = key) =>
      t.db.sqlite.query("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, 'src-hosta', ?, 'hosta', 'proja', 'Agent01', ?, 'title', ?, ?, ?)").run(key, origin, task, state, updated - H, updated);
    return { ...t, ctx, token, ins };
  }
  const snap = (tasks: unknown[], now: number) => ({
    v: 1, host: "hosta", project: "proja", sentAt: now, poller: { status: "running", binaryVersion: "1" },
    agents: [{ name: "Agent01", state: "working" }], tasks,
  });

  test("snapshot upsert updates a legacy host row (and makes it canonical); delete-absent removes a legacy one", async () => {
    const b = await boot();
    b.ins("hosta|proja|t-keep", OLD_HOST, "running", NOW - H, "t-keep");
    b.ins("hosta|proja|t-gone", OLD_HOST, "running", NOW - H, "t-gone");
    const body = snap([{ id: "t-keep", agent: "Agent01", title: "title", state: "blocked", dispatchedAt: NOW - 2 * H, updatedAt: NOW - 1000 }], NOW);
    const res = await route(request("/api/ingest/snapshot", { token: b.token, body }), b.env, b.ctx, { now: NOW });
    expect(res.status).toBe(200);
    expect(b.db.sqlite.query("SELECT key, origin, state FROM tasks ORDER BY key").all()).toEqual([{ key: "hosta|proja|t-keep", origin: "host", state: "blocked" }]);
    // the blocked rule sees it as the host's own task: no "via" suffix on the alert
    const alert = b.db.sqlite.query("SELECT origin, text FROM alerts WHERE rule = 'blocked'").get() as { origin: string; text: string };
    expect(alert.origin).toBe("host");
    expect(alert.text).not.toContain("via");
  });

  test("relay filter and /api/state treat legacy relay rows like canonical ones", async () => {
    const b = await boot();
    b.ins("relay|hosta|proja|fresh", OLD_RELAY, "running", NOW - H);
    b.ins("relay|hosta|proja|stale", OLD_RELAY, "running", NOW - 30 * H);
    b.ins("hosta|proja|own", OLD_HOST, "running", NOW - 30 * H);
    const res = await route(request("/api/state"), b.env, b.ctx, { now: NOW });
    const state = (await res.json()) as { tasks: Array<{ key?: string; taskId?: string; origin: string; title: string }> };
    const origins = state.tasks.map((x) => x.origin).sort();
    expect(origins).toEqual(["host", "relay"]); // the stale relay row is filtered; every origin comes back canonical
    const legacy = new Set(Object.keys(LEGACY_ORIGIN_ALIASES));
    expect(JSON.stringify(state).split('"').some((s) => legacy.has(s))).toBe(false);
  });
});
