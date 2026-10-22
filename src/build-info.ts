/**
 * @file The build stamp: the package version, and the git short sha and build day stamped in at build time
 * (`bun run deploy` defines `__SIISWELL_BUILD__`; the Docker image takes SIISWELL_BUILD_SHA / SIISWELL_BUILD_DATE).
 * An unstamped run (tests, `wrangler dev`) says `dev`. Shown by `/api/health`, the page footer and Settings.
 * @module dashboard-worker/build-info
 */
import pkg from "../package.json";

declare const __SIISWELL_BUILD__: { sha?: unknown; built?: unknown } | undefined;

const SHA_RE = /^[0-9a-f]{7,12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function stamp(): { sha?: unknown; built?: unknown } {
  if (typeof __SIISWELL_BUILD__ === "object" && __SIISWELL_BUILD__) return __SIISWELL_BUILD__;
  const env = typeof process === "object" && process?.env ? process.env : {};
  return { sha: env.SIISWELL_BUILD_SHA, built: env.SIISWELL_BUILD_DATE };
}

const s = stamp();
export const BUILD: { version: string; sha: string; built: string | null } = {
  version: pkg.version,
  sha: typeof s.sha === "string" && SHA_RE.test(s.sha) ? s.sha : "dev",
  built: typeof s.built === "string" && DAY_RE.test(s.built) ? s.built : null,
};
