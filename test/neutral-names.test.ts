import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tracked = (): string[] => {
  const r = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).split("\0").filter(Boolean) : [];
};

describe("no other system is named in the repository", () => {
  test("no tracked file names a specific agent orchestrator (the hooks use the neutral .siiswell-agents marker)", () => {
    const files = tracked().filter((f) => !/\.(png|jpe?g|webp|ico|lock)$/.test(f));
    if (files.length === 0) return; // not a git checkout
    const word = new RegExp(["t", "mux"].join(""), "i");
    const hits = files.filter((f) => word.test(f) || word.test(readFileSync(join(root, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
