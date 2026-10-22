// SPDX-License-Identifier: Apache-2.0
/**
 * @file Build the CLI into ONE dependency-free ES module for Node >= 18 and Bun: cli/dist/siiswell.mjs.
 * Usage: bun cli/build.ts [outfile]
 */
import { chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/** The git short sha of this checkout ("dev" outside git) and the UTC build day, for `siiswell --version`. */
export function stamp(): { sha: string; built: string } {
  const envSha = process.env.SIISWELL_BUILD_SHA ?? "";
  const envDay = process.env.SIISWELL_BUILD_DATE ?? "";
  if (/^[0-9a-f]{7,12}$/.test(envSha)) return { sha: envSha, built: /^\d{4}-\d{2}-\d{2}$/.test(envDay) ? envDay : new Date().toISOString().slice(0, 10) };
  const git = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: import.meta.dir, encoding: "utf8" });
  return { sha: git.status === 0 ? git.stdout.trim() : "dev", built: new Date().toISOString().slice(0, 10) };
}

export async function buildCli(outfile = join(import.meta.dir, "dist", "siiswell.mjs")): Promise<string> {
  const res = await Bun.build({
    entrypoints: [join(import.meta.dir, "src", "bin.ts")],
    outdir: dirname(outfile),
    naming: basename(outfile),
    target: "node",
    format: "esm",
    minify: false,
    banner: "#!/usr/bin/env node\n// siiswell CLI · SPDX-License-Identifier: Apache-2.0 · https://siiswell.com\n// Copyright 2026 siiswell.com",
    define: { __SIISWELL_CLI_BUILD__: JSON.stringify(stamp()) },
  });
  if (!res.success) throw new Error(res.logs.map((l) => String(l)).join("\n"));
  chmodSync(outfile, 0o755);
  return outfile;
}

if (import.meta.main) console.log(await buildCli(process.argv[2]));
