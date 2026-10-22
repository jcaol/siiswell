/**
 * `bun scripts/embed-client.ts [--restore]`: build the CLI (cli/build.ts, same build stamp as the server) and write it, with its
 * manifest {version, sha, sha256, size}, into src/client-dist.ts so the Worker / Bun server can serve it to `siiswell update`.
 * --restore writes the empty stub back. The stamp: SIISWELL_BUILD_SHA / SIISWELL_BUILD_DATE, else git, else "dev".
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli, stamp } from "../cli/build";
import pkg from "../package.json";

export const TARGET = join(import.meta.dir, "..", "src", "client-dist.ts");

const HEAD = (what: string) => `/**
 * @file The CLI bundle this server hands to \`siiswell update\`. ${what}
 * \`bun scripts/embed-client.ts\` writes the real bundle into this file for a deploy / Docker build and
 * \`bun scripts/embed-client.ts --restore\` puts the stub back (\`bun run deploy\` does both). Do not commit the embedded form.
 */
export interface ClientDist {
  manifest: { version: string; sha: string; sha256: string; size: number };
  source: string;
}
`;

/** Refuse to embed while the committed stub has changes in the index or working tree: the bundle must never reach a commit. */
export function assertStubClean(target = TARGET): void {
  const r = spawnSync("git", ["status", "--porcelain", "--", target], { encoding: "utf8", cwd: join(import.meta.dir, "..") });
  if (r.status === 0 && r.stdout.trim() !== "") {
    throw new Error(`${target} has uncommitted changes (staged or not); run \`bun scripts/embed-client.ts --restore\` or \`git restore --staged --worktree\` on it first`);
  }
}

export function restoreStub(target = TARGET): void {
  writeFileSync(target, `${HEAD("THIS IS THE EMPTY STUB (no bundle published).")}export const CLIENT_DIST: ClientDist | null = null;\n`);
}

export async function embedClient(target = TARGET, check = true): Promise<{ version: string; sha: string; sha256: string; size: number }> {
  if (check) assertStubClean(target);
  const dir = mkdtempSync(join(tmpdir(), `siiswell-embed-${randomBytes(4).toString("hex")}-`));
  try {
    const out = await buildCli(join(dir, "siiswell.mjs"));
    const buf = readFileSync(out);
    const manifest = { version: pkg.version, sha: stamp().sha, sha256: createHash("sha256").update(buf).digest("hex"), size: buf.byteLength };
    writeFileSync(
      target,
      `${HEAD("EMBEDDED BUILD (generated).")}export const CLIENT_DIST: ClientDist | null = {\n  manifest: ${JSON.stringify(manifest)},\n  source: ${JSON.stringify(buf.toString("utf8"))},\n};\n`,
    );
    return manifest;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.includes("--restore")) {
    restoreStub();
    console.log("client-dist stub restored");
  } else {
    let m;
    try { m = await embedClient(); } catch (e) { console.error((e as Error).message); process.exit(1); }
    console.log(`embedded CLI ${m.version} (${m.sha}), ${m.size} bytes, sha256 ${m.sha256.slice(0, 12)}...`);
  }
}
