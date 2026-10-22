/**
 * `bun run deploy [-- --dry-run ...]`: `wrangler deploy` with the build stamp (git short sha, UTC build day) defined as
 * `__SIISWELL_BUILD__` (src/build-info.ts). Extra arguments go to wrangler unchanged.
 */
import { spawnSync } from "node:child_process";
import { embedClient, restoreStub } from "./embed-client";

const git = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" });
const sha = git.status === 0 ? git.stdout.trim() : "dev";
const stamp = JSON.stringify({ sha, built: new Date().toISOString().slice(0, 10) });
// The CLI bundle `siiswell update` downloads rides inside the Worker (src/client-dist.ts); it is embedded for the deploy only.
// A --dry-run builds it too (so the size check is real); the empty stub is put back afterwards either way.
let res: ReturnType<typeof spawnSync>;
try {
  process.env.SIISWELL_BUILD_SHA = sha;
  process.env.SIISWELL_BUILD_DATE = JSON.parse(stamp).built;
  if (sha !== "dev") await embedClient();
  else console.log("no git sha: deploying without a client bundle (siiswell update will answer 404)");
  res = spawnSync(process.execPath, ["x", "wrangler", "deploy", "--define", `__SIISWELL_BUILD__:${stamp}`, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
} finally {
  restoreStub();
}
process.exit(res.status ?? 1);
