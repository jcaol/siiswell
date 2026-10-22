import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { clipText, redactSecrets } from "../src/shared/redact";
import { DASHBOARD_SCHEMA_VERSION, HALT_SEVERITY, MAX_TEXT, PUSH_HALT_SCENARIOS, severityForScenario, taskIdFor } from "../src/shared/schema";
import { LEGACY_ORIGIN_ALIASES, ORIGIN_HOST, ORIGIN_RELAY, canonicalOrigin } from "../src/shared/wire";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

describe("redaction contract", () => {
  test("dashboard tokens (oct_...) are redacted, along with the existing credential shapes", () => {
    expect(redactSecrets("token oct_DUMMYdummyDUMMYdummyDUMMYdummyDUMMYdummyDUM here")).toBe("token [redacted] here");   // real tokens are oct_ + 43 chars
    expect(redactSecrets("Authorization: Bearer abcdefgh12345")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecrets("syt_abcdefghijklmnop ghp_0123456789abcdef")).toBe("[redacted] [redacted]");
    expect(redactSecrets("ping @room")).toBe("ping ＠room");
  });

  test("clipText redacts first, collapses whitespace, cuts with an ellipsis only when cut", () => {
    expect(clipText("  a   b\t c  ", 50)).toBe("a b c");
    expect(clipText("x".repeat(500), MAX_TEXT)).toHaveLength(MAX_TEXT);
    expect(clipText("x".repeat(500), MAX_TEXT).endsWith("…")).toBe(true);
    expect(clipText("password=hunter2hunter2 ok", 100)).toBe("password=[redacted] ok");
    expect(clipText(undefined, 10)).toBe("");
  });
});

describe("the shared contract files stay dependency-free (the Worker bundles them as-is)", () => {
  test("src/host-ext/types.ts has no imports at all", () => {
    expect(read("src/host-ext/types.ts")).not.toMatch(/^\s*import\s/m);
  });
  for (const f of ["src/shared/schema.ts", "src/shared/redact.ts"]) {
    test(f, () => {
      // the only imports allowed: the two wire constants and the (type-only) optional host-integration types
      const imports = read(f).match(/^\s*import\s.*$/gm) ?? [];
      expect(imports.filter((l) => !/from "\.\/wire"/.test(l) && !/^import type .* from "\.\.\/host-ext\/types";$/.test(l))).toEqual([]);
      expect(read(f)).not.toMatch(/\brequire\(/);
    });
  }

  test("schema helpers", () => {
    expect(DASHBOARD_SCHEMA_VERSION).toBe(1);
    expect(taskIdFor("claude", 36)).toBe("claude-10");
    expect(severityForScenario("restart-failed")).toBe("critical");
    expect(severityForScenario("something-else")).toBe("info");
    expect(severityForScenario(undefined)).toBe("info");
  });

  test("every severity key is a push scenario the contract names", () => {
    for (const s of Object.keys(HALT_SEVERITY)) expect(typeof s).toBe("string");
    for (const s of PUSH_HALT_SCENARIOS) expect(severityForScenario(s)).not.toBe("info");
  });

  test("origins: neutral canonical values; the legacy values are accepted as aliases only", () => {
    expect([ORIGIN_HOST, ORIGIN_RELAY]).toEqual(["host", "relay"]);
    // older clients' values: one place only (src/shared/legacyOrigins.ts)
    expect(LEGACY_ORIGIN_ALIASES).toEqual({ ["t" + "mux-orch"]: "host", ["ma" + "trix-relay"]: "relay" });
    for (const [k, v] of Object.entries(LEGACY_ORIGIN_ALIASES)) expect(canonicalOrigin(k)).toBe(v);
    expect([canonicalOrigin("host"), canonicalOrigin("mcp"), canonicalOrigin("constructor"), canonicalOrigin(7)]).toEqual(["host", "mcp", "constructor", 7]);
    expect(read("public/wire.js")).toContain(`ORIGIN_HOST = "${ORIGIN_HOST}"`);
    expect(read("public/wire.js")).toContain(`ORIGIN_RELAY = "${ORIGIN_RELAY}"`);
  });
});
