/**
 * `siiswell doctor` behind an access proxy (Cloudflare Access style): /api/health answers with a redirect to a login page, the token
 * routes (/mcp) are let through. doctor must call that "protected by an access proxy (fine)", prove reachability with the token
 * probe (tools/list: no side effects), and never send a token to a redirect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { route } from "../src/index";
import { isAccessRedirect } from "../cli/src/http";
import { addSource, makeCtx, makeEnv } from "./d1-shim";
import { cli, scratchHome } from "./cli-helpers";

describe("doctor behind an access proxy", () => {
  let proxy: ReturnType<typeof Bun.serve>;
  let client = "";
  let host = "";
  const redirectsWithToken: string[] = [];
  const mcpBodies: string[] = [];
  let tasksBefore = 0;
  let t: ReturnType<typeof makeEnv>;
  beforeAll(async () => {
    t = makeEnv();
    const ctx = makeCtx();
    client = await addSource(t.db, "cc-laptop", "client");
    host = await addSource(t.db, "laptop", "host");
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        // the proxy's policy: token routes bypass, everything else needs a login
        if (path === "/mcp" || path.startsWith("/api/ingest/")) {
          if (path === "/mcp") mcpBodies.push(await req.clone().text());
          const res = await route(req, t.env, ctx);
          await ctx.flush();
          return res;
        }
        if (req.headers.has("authorization")) redirectsWithToken.push(path);
        return new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/dash.example?redirect_url=%2Fapi%2Fhealth" } });
      },
    });
    tasksBefore = (t.db.rows<{ c: number }>("SELECT COUNT(*) AS c FROM tasks")[0] as { c: number }).c;
  });
  afterAll(() => proxy.stop(true));

  test("the login redirect is fine, the token routes prove reachability, exit 0", async () => {
    const r = await cli(["doctor"], { HOME: scratchHome(), SIISWELL_URL: `http://127.0.0.1:${proxy.port}`, SIISWELL_TOKEN: client, SIISWELL_HOST_TOKEN: host, SIISWELL_HOST: "laptop" });
    expect(r.out).toContain("protected by an access proxy (fine)");
    expect(r.out).toContain("[ok] client token (SIISWELL_TOKEN): accepted, kind 'client'");
    expect(r.out).toContain("[ok] host token (SIISWELL_HOST_TOKEN): accepted, kind 'host'");
    expect(r.out).toContain("[ok] reachable: the dashboard answered on its token routes");
    expect(r.out).not.toContain("[!!]");
    expect(r.code).toBe(0);
    expect(redirectsWithToken).toEqual([]);
    // only tools/list: nothing was written
    expect(mcpBodies.every((b) => JSON.parse(b).method === "tools/list")).toBe(true);
    expect((t.db.rows<{ c: number }>("SELECT COUNT(*) AS c FROM tasks")[0] as { c: number }).c).toBe(tasksBefore);
  });

  test("a redirect on the token routes is a failure that says what the proxy must bypass", async () => {
    const all = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" } }) });
    try {
      const r = await cli(["doctor"], { HOME: scratchHome(), SIISWELL_URL: `http://127.0.0.1:${all.port}`, SIISWELL_TOKEN: client });
      expect(r.code).toBe(1);
      expect(r.out).toContain("protected by an access proxy (fine)");
      expect(r.out).toContain("must let /mcp and /api/ingest/* through");
    } finally {
      all.stop(true);
    }
  });

  test("isAccessRedirect: login targets yes, an ordinary redirect no", () => {
    const res = (status: number, location?: string) => ({ status, json: null, text: "", headers: new Headers(location ? { location } : {}) });
    expect(isAccessRedirect(res(302, "https://x.cloudflareaccess.com/cdn-cgi/access/login/y"))).toBe(true);
    expect(isAccessRedirect(res(302, "/oauth2/start?rd=%2F"))).toBe(true);
    expect(isAccessRedirect(res(301, "https://dash.example.com/api/health"))).toBe(false);
    expect(isAccessRedirect(res(200, "/login"))).toBe(false);
  });
});
