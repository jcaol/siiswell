import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, scratchHome } from "./cli-helpers";

const TOK = (c: string) => `oct_${c.repeat(43)}`;

/** A home with the per-app configs setup-client.sh writes (no config.json): Claude Code (client token) and usage (host token). */
function home() {
  const h = scratchHome();
  const dir = join(h, ".config", "siiswell");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claude-code.json"), JSON.stringify({ url: "https://d.example", token: TOK("c"), machine: "laptop-1" }), { mode: 0o600 });
  writeFileSync(join(dir, "usage.json"), JSON.stringify({ url: "https://d.example", hostToken: TOK("h"), host: "laptop-1" }), { mode: 0o600 });
  return h;
}

describe("commands typed by hand find the per-app config when there is no config.json", () => {
  test("task commands use the config with a client token; usage uses the one with a host token", async () => {
    const h = home();
    const seen: string[] = [];
    const fetch = async (_u: unknown, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{\"now\":0,\"tasks\":[]}" }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await cli(["heartbeat"], { HOME: h }, { fetch });
    expect(seen.at(-1)).toBe(`Bearer ${TOK("c")}`);
    const cfg = await cli(["config"], { HOME: h });
    expect(cfg.out).toContain("claude-code.json");
    const usage = await cli(["usage", "push", "--dry-run", "--no-collect"], { HOME: h }, { fetch });
    expect(usage.err).not.toContain("no host token");
    expect(usage.out + usage.err).not.toContain(TOK("h"));
  });
  test("SIISWELL_CONFIG and --url still win; nothing is guessed then", async () => {
    const h = home();
    const r = await cli(["config"], { HOME: h, SIISWELL_CONFIG: join(h, "missing.json") });
    expect(r.out).not.toContain("claude-code.json");
  });
});
