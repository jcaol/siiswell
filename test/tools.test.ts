// The helper scripts and the stdio bridge, run as real processes.
import { d1Name } from "../scripts/d1-name";
import { ORIGIN_HOST } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { route } from "../src/index";
import { importVapidPrivateKey, signVapidJwt } from "../src/push";
import { b64urlDecode, sha256Hex } from "../src/util";
import { addSource, makeCtx, makeEnv } from "./d1-shim";

const ROOT = join(import.meta.dir, "..");

async function run(cmd: string[], env: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe("scripts/new-token.ts", () => {
  test("--apply registers the hash in the local SQLite only (never wrangler); --rotate --apply needs an existing source", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "siiswell-tok-"));
    try {
      const env = { DB_PATH: join(dir, "s.sqlite") };
      const r = await run(["bun", "scripts/new-token.ts", "laptop-1", "client", "--apply"], env);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('client source "laptop-1" is ready to use');
      expect(r.stdout).not.toContain("wrangler");
      const token = /(oct_[A-Za-z0-9_-]{43})/.exec(r.stdout)![1]!;
      const { SqliteD1 } = await import("../src/server/d1-sqlite");
      const db = new SqliteD1({ path: env.DB_PATH });
      expect(db.sqlite.query("SELECT name, kind, token_sha256 FROM sources").all()).toEqual([{ name: "laptop-1", kind: "client", token_sha256: await sha256Hex(token) }]);
      db.close();
      const missing = await run(["bun", "scripts/new-token.ts", "nobody", "client", "--rotate", "--apply"], env);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('no client source named "nobody" to rotate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
  test("prints the token once with the sha256 registration SQL, and does not run anything", async () => {
    const r = await run(["bun", "scripts/new-token.ts", "client2", "client"]);
    expect(r.code).toBe(0);
    const token = /token \(shown once, copy it now\): (oct_[A-Za-z0-9_-]{43})/.exec(r.stdout)?.[1];
    expect(token).toBeDefined();
    const sha = await sha256Hex(token as string);
    expect(r.stdout).toContain(`'${sha}'`);
    expect(r.stdout).toContain("INSERT INTO sources (id, name, kind, token_sha256, created) VALUES (");
    expect(r.stdout).toContain("'client2', 'client'");
    expect(r.stdout).toContain(`wrangler d1 execute ${d1Name()} --remote`);
    expect(r.stdout).toContain(`wrangler d1 execute ${d1Name()} --local`);
    expect(r.stdout).toContain("SIISWELL_TOKEN");
    // The printed hash really authenticates that token against the schema's constraints.
    const { db } = makeEnv();
    const sql = /--local --command "(INSERT[^"]+)"/.exec(r.stdout)?.[1] as string;
    db.sqlite.exec(sql);
    expect(db.rows("SELECT name, kind, token_sha256 FROM sources")).toEqual([{ name: "client2", kind: "client", token_sha256: sha }]);
  }, 30_000);

  test("host tokens point at SIISWELL_HOST_TOKEN; tokens differ per run", async () => {
    const a = await run(["bun", "scripts/new-token.ts", "hosta", "host"]);
    const b = await run(["bun", "scripts/new-token.ts", "hosta", "host"]);
    expect(a.stdout).toContain("SIISWELL_HOST_TOKEN=");
    expect(a.stdout).toContain('bound to the host label "hosta"');
    expect(a.stdout).toContain("host label configured in the host agent");
    const tok = (s: string) => /(oct_[A-Za-z0-9_-]{43})/.exec(s)?.[1];
    expect(tok(a.stdout)).not.toBe(tok(b.stdout));
  }, 30_000);

  test("rejects bad usage and unsafe names (they end up inside a shell command)", async () => {
    for (const args of [[], ["x"], ["x", "robot"], ["bad name", "host"], ["a';DROP TABLE sources;--", "host"], ["$(id)", "client"], ["x", "host", "--bogus"]]) {
      const r = await run(["bun", "scripts/new-token.ts", ...args]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("usage");
    }
  }, 30_000);

  test("--rotate prints an UPDATE for an existing (even revoked) source: the new token works, the old one stops, budgets and id are kept", async () => {
    const { db, env } = makeEnv();
    const oldToken = await addSource(db, "hosta", "host", { revoked: true });
    db.sqlite.query("UPDATE sources SET wr_count = 777, wr_window_start = 5, mut_count = 3 WHERE name = 'hosta'").run();
    // names are unique: minting a second row with the INSERT form of the same label is impossible
    const plain = await run(["bun", "scripts/new-token.ts", "hosta", "host"]);
    expect(() => db.sqlite.exec(/--local --command "(INSERT[^"]+)"/.exec(plain.stdout)?.[1] as string)).toThrow();

    const r = await run(["bun", "scripts/new-token.ts", "hosta", "host", "--rotate"]);
    expect(r.code).toBe(0);
    const token = /token \(shown once, copy it now\): (oct_[A-Za-z0-9_-]{43})/.exec(r.stdout)?.[1] as string;
    expect(r.stdout).toContain("Rotate the token of host source \"hosta\"");
    expect(r.stdout).not.toContain("INSERT INTO sources");
    const sql = /--local --command "(UPDATE[^"]+)"/.exec(r.stdout)?.[1] as string;
    expect(sql).toBe(`UPDATE sources SET token_sha256 = '${await sha256Hex(token)}', revoked = 0 WHERE name = 'hosta' AND kind = 'host';`);
    expect(r.stdout).toContain("--remote --command");
    db.sqlite.exec(sql);
    expect(db.rows("SELECT id, revoked, wr_count, wr_window_start, mut_count FROM sources")).toEqual([{ id: "src-hosta", revoked: 0, wr_count: 777, wr_window_start: 5, mut_count: 3 }]);
    const { authenticateBearer } = await import("../src/auth");
    const req = (tok: string) => new Request("http://x/api/ingest/heartbeat", { method: "POST", headers: { Authorization: `Bearer ${tok}` } });
    expect((await authenticateBearer(req(token), env, "host", Date.now())).ok).toBe(true);
    const stale = await authenticateBearer(req(oldToken), env, "host", Date.now());
    expect(stale.ok === false && stale.response.status).toBe(401);
  }, 30_000);
});

describe("scripts/purge-source.ts", () => {
  test("prints the DELETEs for everything a source wrote; run against a database they remove exactly that source's rows", async () => {
    const t = makeEnv();
    await addSource(t.db, "evil", "host");
    await addSource(t.db, "hosta", "host");
    const q = (sql: string, ...p: Array<string | number>) => t.db.sqlite.query(sql).run(...p);
    for (const [src, host] of [["src-evil", "evil"], ["src-hosta", "hosta"]] as const) {
      q("INSERT INTO events (source_id, key, host, project, kind, origin, severity, text, at, received_at) VALUES (?, 'e1', ?, 'p', 'status', '" + ORIGIN_HOST + "', 'info', 'x', 1, 1)", src, host);
      q("INSERT INTO tasks (key, source_id, origin, host, project, agent, task_id, title, state, created, updated) VALUES (?, ?, '" + ORIGIN_HOST + "', ?, 'p', 'a', 't', 't', 'running', 1, 1)", `${host}|p|t`, src, host);
      q("INSERT INTO snapshots (source_id, host, project, json, received_at) VALUES (?, ?, 'p', '{}', 1)", src, host);
      q("INSERT INTO hosts (host, source_id, last_seen) VALUES (?, ?, 1)", host, src);
      q("INSERT INTO project_seen (host, project, last_seen) VALUES (?, 'p', 1)", host);
      q("INSERT INTO usage_daily VALUES ('2027-01-01', ?, 'p', 'a', 'claude', 'm', 1, 1, 1, 1, 1, 1, 1.0, 1)", host);
      q("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz) VALUES (?, 1, 1, 'Europe/London')", host);
      q("INSERT INTO alerts (key, rule, severity, host, text, opened) VALUES (?, 'host-offline', 'critical', ?, 'x', 1)", `host-offline|${host}`, host);
      q("INSERT INTO push_budget (k, owner, count) VALUES (?, ?, 1), (?, ?, 1), (?, ?, 1), (?, ?, 1)", `own|${host}`, host, `rs|${host}|@bot:srv`, host, `ct|${host}`, host, `all|${host}`, host);
    }
    // another source named `all` whose relay sender is called `evil`: its key spells the name `evil`, but the OWNER is `all`
    q("INSERT INTO push_budget (k, owner, count) VALUES ('rs|all|evil', 'all', 1)");
    const r = await run(["bun", "scripts/purge-source.ts", "evil"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing below has been run");
    expect(r.stdout).toContain("UPDATE sources SET revoked = 1 WHERE name = 'evil';");
    const deletes = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("DELETE FROM"));
    expect(deletes).toHaveLength(9);
    for (const d of deletes) t.db.sqlite.exec(d);
    for (const table of ["events", "tasks", "snapshots", "hosts", "project_seen", "alerts", "usage_daily", "usage_hosts"]) {
      expect(t.db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n).toBe(1); // only hosta's row is left
    }
    expect(t.db.rows<{ k: string }>("SELECT k FROM push_budget ORDER BY k").map((x) => x.k)).toEqual(["all|hosta", "ct|hosta", "own|hosta", "rs|all|evil", "rs|hosta|@bot:srv"]); // by OWNER: nothing of another source goes, whatever its key spells
    expect(t.db.rows("SELECT name FROM sources ORDER BY name")).toEqual([{ name: "evil" }, { name: "hosta" }]); // the source row itself stays (revoke, then rotate)
  }, 30_000);

  test("--id works when the sources row is gone; unsafe names are refused (they end up inside SQL)", async () => {
    const r = await run(["bun", "scripts/purge-source.ts", "evil", "--id", "src-123"]);
    expect(r.stdout).toContain("DELETE FROM events    WHERE source_id = 'src-123';");
    for (const args of [[], ["a b"], ["x';DROP TABLE sources;--"], ["evil", "--id", "x'y"], ["evil", "extra"]]) {
      const bad = await run(["bun", "scripts/purge-source.ts", ...args]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("usage");
    }
  }, 30_000);
});

describe("scripts/vapid.ts", () => {
  test("prints a usable key pair (65-byte public point, 32-byte scalar) and the secret commands", async () => {
    const r = await run(["bun", "scripts/vapid.ts", "mailto:ops@example.com"]);
    expect(r.code).toBe(0);
    const pub = /VAPID_PUBLIC_KEY\s+= (\S+)/.exec(r.stdout)?.[1] as string;
    const priv = /VAPID_PRIVATE_KEY\s+= (\S+)/.exec(r.stdout)?.[1] as string;
    expect(b64urlDecode(pub).length).toBe(65);
    expect(b64urlDecode(pub)[0]).toBe(4);
    expect(b64urlDecode(priv).length).toBe(32);
    expect(r.stdout).toContain("VAPID_SUBJECT     = mailto:ops@example.com");
    expect(r.stdout).toContain("wrangler secret put VAPID_PRIVATE_KEY");
    await importVapidPrivateKey(priv, pub); // the Worker accepts exactly this format
    const jwt = await signVapidJwt("https://fcm.googleapis.com", "mailto:ops@example.com", priv, pub, Date.now());
    const verifyKey = await crypto.subtle.importKey(
      "raw",
      b64urlDecode(pub),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  }, 30_000);

  test("rejects a malformed subject", async () => {
    expect((await run(["bun", "scripts/vapid.ts", "not a subject"])).code).toBe(1);
  }, 30_000);
});

describe("bridge/siiswell-bridge.mjs (node, stdio <-> HTTPS MCP)", () => {
  async function withServer<T>(fn: (url: string, ctx: { db: ReturnType<typeof makeEnv>["db"]; token: string; seen: Request[] }) => Promise<T>) {
    const t = makeEnv();
    const token = await addSource(t.db, "grok-box", "client");
    const wctx = makeCtx();
    const seen: Request[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        seen.push(req.clone());
        return route(req, t.env, wctx, { now: Date.now() });
      },
    });
    try {
      return await fn(`http://127.0.0.1:${server.port}`, { db: t.db, token, seen });
    } finally {
      server.stop(true);
    }
  }

  const lines = (...msgs: unknown[]) => msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";

  test("round trip through the real Worker: initialize, notification (no output), tools/list, report_task", async () => {
    await withServer(async (url, { db, token, seen }) => {
      const input = lines(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_task", arguments: { project: "p", title: "from the bridge", status: "IN_PROGRESS", eta_min: 5 } } },
      );
      const r = await run(["node", "bridge/siiswell-bridge.mjs"], { SIISWELL_URL: url, SIISWELL_TOKEN: token }, input);
      expect(r.code).toBe(0);
      const out = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
      expect(out.map((m) => m.id).sort()).toEqual([1, 2, 3]); // nothing for the notification
      expect(out.find((m) => m.id === 1).result.protocolVersion).toBe("2025-06-18");
      expect(out.find((m) => m.id === 2).result.tools).toHaveLength(5);
      expect(JSON.parse(out.find((m) => m.id === 3).result.content[0].text).state).toBe("running");
      expect(db.rows("SELECT title, host FROM tasks")).toEqual([{ title: "from the bridge", host: "grok-box" }]);
      // the token is sent as a header, and never printed on either stream
      expect(seen.every((q) => q.headers.get("authorization") === `Bearer ${token}`)).toBe(true);
      expect(r.stdout + r.stderr).not.toContain(token);
      // the negotiated version is echoed on later requests
      expect(seen[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    });
  }, 30_000);

  test("a modern (2026-07-28) probe gets the mirrored Mcp-* headers", async () => {
    await withServer(async (url, { token }) => {
      const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
      const r = await run(["node", "bridge/siiswell-bridge.mjs"], { SIISWELL_URL: url, SIISWELL_TOKEN: token }, lines({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: meta } }));
      const reply = JSON.parse(r.stdout.trim());
      expect(reply.result.supportedVersions).toContain("2026-07-28");
      expect(reply.result.resultType).toBe("complete");
    });
  }, 30_000);

  test("errors become JSON-RPC errors for requests and silence for notifications; HTTP 401 is reported without leaking the token", async () => {
    await withServer(async (url) => {
      const bad = "oct_thisisnotavalidtoken00000000000000000000000";
      const r = await run(["node", "bridge/siiswell-bridge.mjs"], { SIISWELL_URL: url, SIISWELL_TOKEN: bad }, lines({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }));
      const msgs = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ id: 9, error: { code: -32603 } });
      expect(r.stdout + r.stderr).not.toContain(bad);
    });
    const unreachable = await run(["node", "bridge/siiswell-bridge.mjs"], { SIISWELL_URL: "http://127.0.0.1:9", SIISWELL_TOKEN: "oct_abcdefghijklmnop" }, lines({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(JSON.parse(unreachable.stdout.trim())).toMatchObject({ id: 1, error: { message: "Dashboard unreachable" } });
  }, 30_000);

  test("refuses to run without config, and refuses plain http to a remote host", async () => {
    expect((await run(["node", "bridge/siiswell-bridge.mjs"], {}, "")).code).toBe(2);
    const plain = await run(["node", "bridge/siiswell-bridge.mjs"], { SIISWELL_URL: "http://dash.example.com", SIISWELL_TOKEN: "oct_abcdefghijklmnop" }, "");
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain("plain http");
  }, 30_000);

  test("a redirect is never followed: the bearer token is not replayed to the Location target", async () => {
    const hits: Request[] = [];
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { hits.push(req); return new Response("{}"); } });
    const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${target.port}/mcp` } }) });
    try {
      const token = "oct_" + "a".repeat(43);
      const r = await run(["node", "bridge/siiswell-bridge.mjs"], { SIISWELL_URL: `http://127.0.0.1:${redirector.port}`, SIISWELL_TOKEN: token }, lines({ jsonrpc: "2.0", id: 4, method: "tools/list" }));
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ id: 4, error: { code: -32603 } });
      expect(hits).toHaveLength(0);
      expect(r.stdout + r.stderr).not.toContain(token);
      expect(r.stderr.toLowerCase()).toContain("redirect");
    } finally {
      redirector.stop(true);
      target.stop(true);
    }
  }, 30_000);

  test("garbage on stdin produces a parse error, not a crash", async () => {
    await withServer(async (url, { token }) => {
      const r = await run(["node", "bridge/siiswell-bridge.mjs"], { SIISWELL_URL: url, SIISWELL_TOKEN: token }, "not json\n");
      expect(JSON.parse(r.stdout.trim()).error.code).toBe(-32700);
    });
  }, 30_000);
});
