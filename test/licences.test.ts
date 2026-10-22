import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((n) => {
    const rel = join(dir, n);
    if (n === "dist" || n === "node_modules") return [];
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });

describe("licences: the client is Apache-2.0, the server AGPL-3.0", () => {
  test("every client source file (cli/, bridge/, src/shared/) is marked Apache-2.0 in its first lines", () => {
    const files = [...walk("cli"), ...walk("bridge"), ...walk("src/shared")].filter((f) => /\.(ts|mjs|js)$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    const unmarked = files.filter((f) => !readFileSync(join(root, f), "utf8").split("\n").slice(0, 3).some((l) => l.includes("SPDX-License-Identifier: Apache-2.0")));
    expect(unmarked).toEqual([]);
  });
  test("the CLI package names Apache-2.0 and ships the licence text", () => {
    const pkg = JSON.parse(readFileSync(join(root, "cli", "package.json"), "utf8"));
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.files).toContain("LICENSE");
    expect(pkg.files).toContain("NOTICE");
    expect(readFileSync(join(root, "cli", "NOTICE"), "utf8")).toContain("Copyright 2026 siiswell.com");
    expect(readFileSync(join(root, "cli", "LICENSE"), "utf8")).toBe(readFileSync(join(root, "LICENSE-APACHE"), "utf8"));
    expect(readFileSync(join(root, "LICENSE-APACHE"), "utf8")).toContain("Apache License\n                           Version 2.0, January 2004");
  });
  test("the built CLI carries the licence line after the shebang", async () => {
    const { buildCli } = await import("../cli/build");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const out = await buildCli(join(mkdtempSync(join(tmpdir(), "siiswell-lic-")), "siiswell.mjs"));
    expect(readFileSync(out, "utf8").split("\n").slice(0, 3)).toEqual(["#!/usr/bin/env node", "// siiswell CLI · SPDX-License-Identifier: Apache-2.0 · https://siiswell.com", "// Copyright 2026 siiswell.com"]);
  });
});
