/**
 * Test support for the CLI: a real HTTP server on 127.0.0.1 in front of the repo's own `route()` (SQLite adapter), a
 * recording fetch, captured streams and a private scratch HOME per test. Nothing here touches the real home directory.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { route } from "../src/index";
import { run, type Io } from "../cli/src/main";
import { addSource, makeCtx, makeEnv, type TestEnv } from "./d1-shim";

export interface TestServer {
  url: string;
  t: TestEnv;
  client: string;
  host: string;
  hostName: string;
  /** every request body the server received (path + body + whether it carried a bearer token) */
  seen: Array<{ path: string; body: string; auth: boolean }>;
  stop(): void;
}

export async function startServer(opts: { now?: () => number } = {}): Promise<TestServer> {
  const t = makeEnv();
  const ctx = makeCtx();
  const client = await addSource(t.db, "laptop-client", "client");
  const hostName = "laptop";
  const host = await addSource(t.db, hostName, "host");
  const seen: TestServer["seen"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.clone().text() : "";
      seen.push({ path: new URL(req.url).pathname, body, auth: req.headers.has("authorization") });
      const res = await route(req, t.env, ctx, opts.now ? { now: opts.now() } : {});
      await ctx.flush();
      return res;
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, t, client, host, hostName, seen, stop: () => server.stop(true) };
}

/** A fresh empty HOME under the OS temp dir (the test runner's HOME is already a scratch dir). */
export function scratchHome(): string {
  const base = mkdtempSync(join(tmpdir(), "siiswell-cli-"));
  mkdirSync(join(base, "work", "myproj"), { recursive: true });
  return base;
}

export interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI in-process with exactly this environment (nothing inherited from the test process). */
export async function cli(argv: string[], env: Record<string, string | undefined>, extra: Partial<Io> & { input?: string } = {}): Promise<Ran> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (d) => (out += d));
  stderr.on("data", (d) => (err += d));
  if (extra.input !== undefined) stdin.end(extra.input);
  else stdin.end();
  const code = await run(argv, { env, cwd: extra.cwd ?? env.HOME ?? "/", stdout, stderr, stdin, fetch: extra.fetch, now: extra.now, platform: extra.platform, spawnBackground: extra.spawnBackground, sleep: extra.sleep, scriptPath: extra.scriptPath, smokeUpdate: extra.smokeUpdate });
  await new Promise((r) => setImmediate(r));
  return { code, out, err };
}
