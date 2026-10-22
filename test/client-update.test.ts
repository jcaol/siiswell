import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "../src/index";
import type { ClientDist } from "../src/client-dist";
import { compareSemver, parseSemver } from "../src/shared/semver";
import { isNewer, isSafeUrl, parseManifest, replaceFileAtomic } from "../cli/src/selfupdate";
import { cliLabel, updateAvailable, updateNote } from "../public/version.js";
import { addSource, makeCtx, makeEnv, request } from "./d1-shim";
import { cli, scratchHome } from "./cli-helpers";

const SRC = '#!/usr/bin/env node\nconsole.log("0.9.0 (fake)");\n';
const dist = (source = SRC, over: Record<string, unknown> = {}): ClientDist => ({
  manifest: { version: "0.9.0", sha: "abc1234", sha256: createHash("sha256").update(source).digest("hex"), size: Buffer.byteLength(source), ...over } as ClientDist["manifest"],
  source,
});
const TOK = (c: string) => `oct_${c.repeat(43)}`;

describe("routes /api/ingest/client/*", () => {
  const D = dist();
  test("no token / junk token / revoked token -> 401, nothing leaks", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const revoked = await addSource(t.db, "old", "client", { revoked: true });
    for (const path of ["/api/ingest/client/latest", "/api/ingest/client/siiswell.mjs"]) {
      for (const token of [undefined, "nope", TOK("z"), revoked]) {
        const res = await route(request(path, { token }), t.env, ctx, { clientDist: D });
        expect(res.status).toBe(401);
        expect(await res.text()).not.toContain("fake");
      }
    }
  });
  test("a client token and a host token both get the manifest and the bundle", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const c = await addSource(t.db, "lap-client", "client");
    const h = await addSource(t.db, "lap", "host");
    for (const token of [c, h]) {
      const m = await route(request("/api/ingest/client/latest", { token }), t.env, ctx, { clientDist: D });
      expect(m.status).toBe(200);
      expect(await m.json()).toEqual(D.manifest);
      const b = await route(request("/api/ingest/client/siiswell.mjs", { token }), t.env, ctx, { clientDist: D });
      expect(b.status).toBe(200);
      expect(b.headers.get("cache-control")).toBe("no-store");
      expect(await b.text()).toBe(SRC);
    }
  });
  test("POST is refused, and a server without a bundle answers 404 (after auth)", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const c = await addSource(t.db, "c1", "client");
    expect((await route(request("/api/ingest/client/latest", { token: c, method: "POST", rawBody: "{}" }), t.env, ctx, { clientDist: D })).status).toBe(405);
    expect((await route(request("/api/ingest/client/latest", { token: c }), t.env, ctx, { clientDist: null })).status).toBe(404);
    expect((await route(request("/api/ingest/client/latest"), t.env, ctx, { clientDist: null })).status).toBe(401);
  });
  test("the per-token rate limit applies", async () => {
    const t = makeEnv({ RATE_LIMIT_CLIENT: { limit: async () => ({ success: false }) } as unknown as RateLimit });
    const c = await addSource(t.db, "c2", "client");
    expect((await route(request("/api/ingest/client/latest", { token: c }), t.env, makeCtx(), { clientDist: D })).status).toBe(429);
  });
  test("the bundle is not reachable as a static asset path", async () => {
    const t = makeEnv();
    const res = await route(request("/api/ingest/client/siiswell.mjs/"), t.env, makeCtx(), { clientDist: D });
    expect(res.status).toBe(401);
  });
});

describe("version header", () => {
  test("stored per source on a token call; junk ignored; absence keeps null", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const c = await addSource(t.db, "c3", "client");
    const h = await addSource(t.db, "h3", "host");
    const row = (n: string) => (t.db.sqlite.query("SELECT client_version v FROM sources WHERE name = ?").get(n) as { v: string | null }).v;
    await route(request("/api/ingest/client/latest", { token: c }), t.env, ctx, { clientDist: dist() });
    expect(row("c3")).toBeNull();
    await route(request("/api/ingest/client/latest", { token: c, headers: { "X-Siiswell-Client": "<script>" } }), t.env, ctx, { clientDist: dist() });
    expect(row("c3")).toBeNull();
    await route(request("/api/ingest/client/latest", { token: c, headers: { "X-Siiswell-Client": "0.4.0+abc1234" } }), t.env, ctx, { clientDist: dist() });
    expect(row("c3")).toBe("0.4.0+abc1234");
    await route(request("/api/ingest/heartbeat", { token: h, body: { host: "h3" }, headers: { "X-Siiswell-Client": "0.3.0" } }), t.env, ctx);
    expect(row("h3")).toBe("0.3.0");
    // /api/state carries it for the dashboard
    const { buildState } = await import("../src/state");
    const st = await buildState(t.env.DB, Date.now());
    expect(st.clients.find((x) => x.name === "c3")?.clientVersion).toBe("0.4.0+abc1234");
    expect(st.serverVersion).toBe("0.6.0");
  });
  test("the CLI sends its version on every request", async () => {
    const seen: string[] = [];
    const home = scratchHome();
    await cli(["heartbeat"], { HOME: home, SIISWELL_URL: "https://d.example", SIISWELL_TOKEN: TOK("a") }, {
      fetch: async (_u, init) => { seen.push(String((init?.headers as Record<string, string>)["X-Siiswell-Client"])); return new Response("{}", { status: 200 }); },
    });
    expect(seen[0]).toMatch(/^0\.6\.0\+(dev|[0-9a-f]{7,12})$/);
  });
});

describe("semver + UI hint", () => {
  test("parse / compare", () => {
    expect(parseSemver("0.5.0+abc1234")).toEqual([0, 5, 0]);
    expect(parseSemver("x")).toBeNull();
    expect(compareSemver("0.4.9", "0.5.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.5.0+a", "0.5.0")).toBe(0);
    expect(compareSemver("?", "0.5.0")).toBeNull();
  });
  test("hint only when stored < server; unknown ignored; plain text", () => {
    expect(updateAvailable("0.4.0+abc1234", "0.5.0")).toBe(true);
    expect(updateAvailable("0.5.0", "0.5.0")).toBe(false);
    expect(updateAvailable("0.6.0", "0.5.0")).toBe(false);
    expect(updateAvailable(null, "0.5.0")).toBe(false);
    expect(updateAvailable("weird", "0.5.0")).toBe(false);
    expect(updateAvailable("0.4.0", undefined)).toBe(false);
    expect(updateNote("0.4.0+abc1234", "0.5.0")).toBe("CLI 0.4.0: a newer version is available (siiswell update)");
    expect(cliLabel("0.5.3+abc1234")).toBe("CLI 0.5.3");
    expect(cliLabel(null)).toBe("CLI not reported");
    expect(updateNote("0.5.0", "0.5.0")).toBeNull();
  });
});

describe("selfupdate helpers", () => {
  test("url safety and manifest shape", () => {
    expect(isSafeUrl("https://d.example")).toBe(true);
    expect(isSafeUrl("http://localhost:8787")).toBe(true);
    expect(isSafeUrl("http://127.0.0.1:1")).toBe(true);
    expect(isSafeUrl("http://d.example")).toBe(false);
    expect(parseManifest(dist().manifest)).not.toBeNull();
    expect(parseManifest({ ...dist().manifest, sha256: "zz" })).toBeNull();
    expect(parseManifest({ ...dist().manifest, size: 0 })).toBeNull();
    expect(parseManifest({ ...dist().manifest, version: "latest" })).toBeNull();
  });
  test("isNewer: version first, sha only between two real builds", () => {
    const m = (version: string, sha: string) => ({ ...dist().manifest, version, sha });
    expect(isNewer(m("0.6.0", "aaaaaaa"), "0.5.0", "bbbbbbb")).toBe(true);
    expect(isNewer(m("0.4.0", "aaaaaaa"), "0.5.0", "bbbbbbb")).toBe(false);
    expect(isNewer(m("0.5.0", "aaaaaaa"), "0.5.0", "bbbbbbb")).toBe(true);
    expect(isNewer(m("0.5.0", "aaaaaaa"), "0.5.0", "aaaaaaa")).toBe(false);
    expect(isNewer(m("0.5.0", "aaaaaaa"), "0.5.0", "dev")).toBe(false);
  });
  test("atomic replace keeps the mode, leaves no temp file, and a failing smoke check keeps the old file", () => {
    const dir = join(scratchHome(), "lib");
    mkdirSync(dir);
    const f = join(dir, "siiswell.mjs");
    writeFileSync(f, "old");
    chmodSync(f, 0o755);
    replaceFileAtomic(f, Buffer.from("new"));
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(statSync(f).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual(["siiswell.mjs"]);
    expect(() => replaceFileAtomic(f, Buffer.from("bad"), () => "broken")).toThrow("broken");
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["siiswell.mjs"]);
  });
  test("the temp file runs as an ES module under node, so a real ESM bundle passes the smoke check", () => {
    const dir = join(scratchHome(), "lib");
    mkdirSync(dir);
    const f = join(dir, "siiswell.mjs");
    writeFileSync(f, "old");
    const esm = 'import { argv } from "node:process";\nif (argv.includes("--version")) console.log("9.9.9");\n';
    const smoke = (tmp: string): string | null => {
      const res = spawnSync("node", [tmp, "--version"], { encoding: "utf8" });
      return res.status === 0 && res.stdout.trim() === "9.9.9" ? null : `smoke failed: ${res.stderr}`;
    };
    replaceFileAtomic(f, Buffer.from(esm), smoke);
    expect(readFileSync(f, "utf8")).toBe(esm);
  });
});

describe("siiswell update (end to end against route())", () => {
  let server: ReturnType<typeof Bun.serve>;
  let url = "";
  let token = "";
  let current: ClientDist = dist();
  beforeAll(async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    token = await addSource(t.db, "e2e-client", "client");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => { const r = await route(req, t.env, ctx, { clientDist: current }); await ctx.flush(); return r; } });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));
  const setup = () => {
    const home = scratchHome();
    const dir = join(home, "lib");
    mkdirSync(dir);
    const script = join(dir, "siiswell.mjs");
    writeFileSync(script, "OLD");
    chmodSync(script, 0o644);
    return { home, script, env: { HOME: home, SIISWELL_URL: url, SIISWELL_TOKEN: token } };
  };

  test("--check reports and changes nothing", async () => {
    current = dist();
    const s = setup();
    const r = await cli(["update", "--check"], s.env, { scriptPath: s.script, smokeUpdate: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain("An update is available");
    expect(readFileSync(s.script, "utf8")).toBe("OLD");
  });
  test("run by hand with no config.json: uses the first per-app config that names a URL", async () => {
    current = dist();
    const s = setup();
    const cfgDir = join(s.home, ".config", "siiswell");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "claude-code.json"), JSON.stringify({}), { mode: 0o600 });
    writeFileSync(join(cfgDir, "codex.json"), JSON.stringify({ url, token }), { mode: 0o600 });
    const r = await cli(["update", "--check"], { HOME: s.home }, { scriptPath: s.script, smokeUpdate: false });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("An update is available");
  });
  test("--yes installs; without --yes and no terminal nothing is installed", async () => {
    current = dist();
    const s = setup();
    const no = await cli(["update"], s.env, { scriptPath: s.script, smokeUpdate: false });
    expect(no.out).toContain("No change made");
    expect(readFileSync(s.script, "utf8")).toBe("OLD");
    const r = await cli(["update", "--yes"], s.env, { scriptPath: s.script, smokeUpdate: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updated to 0.9.0");
    expect(readFileSync(s.script, "utf8")).toBe(SRC);
    expect(statSync(s.script).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(s.home, "lib"))).toEqual(["siiswell.mjs"]);
    expect(r.out + r.err).not.toContain(token);
  });
  test("task flags without a task id are a usage error, not a self-update", async () => {
    current = dist();
    const s = setup();
    for (const f of [["--summary", "x"], ["--eta-min", "5"], ["--json"], ["--title", "t"]]) {
      const r = await cli(["update", ...f, "--yes"], s.env, { scriptPath: s.script, smokeUpdate: false });
      expect(r.code).toBe(2);
      expect(readFileSync(s.script, "utf8")).toBe("OLD");
    }
  });
  test("sha256 mismatch refuses to replace", async () => {
    current = dist(SRC, { sha256: "0".repeat(64) });
    const s = setup();
    const r = await cli(["update", "--yes"], s.env, { scriptPath: s.script, smokeUpdate: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("checksum");
    expect(readFileSync(s.script, "utf8")).toBe("OLD");
    expect(readdirSync(join(s.home, "lib"))).toEqual(["siiswell.mjs"]);
  });
  test("size mismatch refuses to replace", async () => {
    current = dist(SRC, { size: 5 });
    const s = setup();
    const r = await cli(["update", "--yes"], s.env, { scriptPath: s.script, smokeUpdate: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("wrong size");
    expect(readFileSync(s.script, "utf8")).toBe("OLD");
  });
  test("already current, and a refused token", async () => {
    current = dist(SRC, { version: "0.5.1", sha: "dev" });
    const s = setup();
    expect((await cli(["update", "--yes"], s.env, { scriptPath: s.script, smokeUpdate: false })).out).toContain("up to date");
    current = dist();
    const bad = await cli(["update", "--yes"], { ...s.env, SIISWELL_TOKEN: TOK("q") }, { scriptPath: s.script, smokeUpdate: false });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("did not accept the token");
  });
  test("a source checkout (not an .mjs) is not replaced; plain http to a real host is refused", async () => {
    current = dist();
    const s = setup();
    const r = await cli(["update", "--yes"], s.env, { scriptPath: join(s.home, "lib") , smokeUpdate: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not an installed siiswell.mjs");
    const h = await cli(["update", "--yes"], { HOME: s.home, SIISWELL_URL: "http://dash.example.com", SIISWELL_TOKEN: TOK("a") }, { scriptPath: s.script });
    expect(h.code).toBe(1);
  });
  test("the task command `update <id> --status` still works (not a self-update)", async () => {
    const s = setup();
    const r = await cli(["update", "t-1", "--status", "DONE"], s.env, { fetch: async () => new Response("{}", { status: 200 }) });
    expect(r.err).not.toContain("installed");
  });
  test("a real built bundle passes the smoke run and replaces the file", async () => {
    const { buildCli } = await import("../cli/build");
    const dir = join(scratchHome(), "b");
    mkdirSync(dir);
    const built = await buildCli(join(dir, "siiswell.mjs"));
    const text = readFileSync(built, "utf8");
    current = dist(text, { version: "0.6.1", sha: "ffffff1" });
    const s = setup();
    const r = await cli(["update", "--yes"], s.env, { scriptPath: s.script });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updated to 0.6.1");
    expect(existsSync(s.script)).toBe(true);
    expect(readFileSync(s.script, "utf8")).toBe(text);
  });
});

describe("committed src/client-dist.ts", () => {
  test("is the empty stub (no embedded bundle)", async () => {
    const { readFileSync } = await import("node:fs");
    const { CLIENT_DIST } = await import("../src/client-dist");
    expect(CLIENT_DIST).toBeNull();
    expect(readFileSync(new URL("../src/client-dist.ts", import.meta.url)).byteLength).toBeLessThan(2048);
  });
});
