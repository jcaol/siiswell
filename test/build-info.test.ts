/** The build stamp: package version (0.6.0) + git short sha + build day, in /api/health, the page and the CLI. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD } from "../src/build-info";
import { DASHBOARD_VERSION } from "../src/env";
import { CLI_VERSION, CLI_VERSION_LINE } from "../cli/src/build-info";
import { buildLine } from "../public/version.js";

const pkg = (p: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", p), "utf8")) as { version: string };

describe("build stamp", () => {
  test("server and the CLI 0.6.0, from package.json (not hard-coded)", () => {
    expect(pkg("package.json").version).toBe("0.6.0");
    expect(pkg("cli/package.json").version).toBe("0.6.0");
    expect(BUILD.version).toBe("0.6.0");
    expect(DASHBOARD_VERSION).toBe("0.6.0");
    expect(CLI_VERSION).toBe("0.6.0");
    expect(BUILD.sha).toBe("dev"); // unstamped run
    expect(CLI_VERSION_LINE).toBe("0.6.0 (dev)");
  });
  test("the page's line: text only, checked fields", () => {
    expect(buildLine({ ok: true, version: "0.6.0", sha: "4cb5fd0", built: "2026-10-18" })).toBe("siiswell 0.6.0 · 4cb5fd0 · built 2026-10-18");
    expect(buildLine({ version: "0.6.0", sha: "dev", built: null })).toBe("siiswell 0.6.0 · dev");
    expect(buildLine({ version: "<b>x</b>" })).toBeNull();
    expect(buildLine({ version: "0.6.0", sha: "<img>", built: "x" })).toBe("siiswell 0.6.0 · dev");
    expect(buildLine(null)).toBeNull();
  });
  test("the CLI bundle carries the stamp", async () => {
    const src = readFileSync(join(import.meta.dir, "..", "cli", "build.ts"), "utf8");
    expect(src).toContain("__SIISWELL_CLI_BUILD__");
  });
});
