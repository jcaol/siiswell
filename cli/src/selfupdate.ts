// SPDX-License-Identifier: Apache-2.0
/**
 * @file `siiswell update [--check] [--yes]`: replace this installed CLI bundle with the one the dashboard publishes.
 * @module cli/selfupdate
 *
 * Fetches GET /api/ingest/client/latest (manifest {version, sha, sha256, size}), compares it with this build, downloads
 * GET /api/ingest/client/siiswell.mjs, verifies size and sha256, then replaces the installed file atomically (temp file in the same
 * directory, same mode, fsync, rename). The path stays the same, so the MCP registrations, hooks and schedules that name it keep
 * working; configs and tokens are not read or written here. Never follows redirects (http.ts); https only (localhost excepted).
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, basename, join } from "node:path";
import { compareSemver, parseSemver } from "../../src/shared/semver";
import { CLI_SHA, CLI_VERSION } from "./build-info";
import { ConfigError, type Config } from "./config";
import { HttpError, errorDetail, send, type FetchLike } from "./http";

export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface Manifest {
  version: string;
  sha: string;
  sha256: string;
  size: number;
}

export interface SelfUpdateIo {
  out: (s: string) => void;
  err: (s: string) => void;
  fetch?: FetchLike;
  /** The installed script to replace (default: this process's own script, symlinks resolved). */
  scriptPath?: string;
  /** Ask a yes/no question (default: no, so a non-interactive run needs --yes). */
  confirm?: (question: string) => Promise<boolean>;
  /** Run the new file with --version before the swap (default true); tests with a fake bundle turn it off. */
  smoke?: boolean;
}

export function isSafeUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export function parseManifest(j: unknown): Manifest | null {
  if (!j || typeof j !== "object") return null;
  const m = j as Record<string, unknown>;
  if (!parseSemver(m.version) || typeof m.version !== "string") return null;
  if (typeof m.sha !== "string" || !/^([0-9a-f]{7,12}|dev)$/.test(m.sha)) return null;
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
  if (typeof m.size !== "number" || !Number.isInteger(m.size) || m.size < 1 || m.size > MAX_BUNDLE_BYTES) return null;
  return { version: m.version, sha: m.sha, sha256: m.sha256, size: m.size };
}

/** Is the published build different from (and not older than) this one? A "dev" sha never triggers an update by itself. */
export function isNewer(m: Manifest, ownVersion = CLI_VERSION, ownSha = CLI_SHA): boolean {
  const c = compareSemver(m.version, ownVersion);
  if (c === null) return false;
  if (c !== 0) return c > 0;
  return m.sha !== "dev" && ownSha !== "dev" && m.sha !== ownSha;
}

/** Write `data` over `target` atomically: temp file next to it with the same mode, fsync, rename. Throws on failure; the temp file is removed. */
export function replaceFileAtomic(target: string, data: Buffer, smoke?: (tmp: string) => string | null): void {
  const mode = statSync(target).mode & 0o777;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp.mjs`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", mode);
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const problem = smoke?.(tmp);
    if (problem) throw new ConfigError(problem);
    renameSync(tmp, target);
    try {
      const d = openSync(dirname(target), "r");
      try { fsyncSync(d); } finally { closeSync(d); }
    } catch { /* directory fsync is best effort */ }
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function why(status: number, detail: string, what: string): ConfigError {
  const d = detail ? `: ${detail}` : "";
  if (status === 401) return new ConfigError(`the dashboard did not accept the token (401${d}); check SIISWELL_TOKEN or SIISWELL_HOST_TOKEN`);
  if (status === 404) return new ConfigError(`this dashboard does not publish a client build yet (${what})`);
  if (status === 429) return new ConfigError("rate limited (429); please try again in a minute");
  return new ConfigError(`unexpected answer from the dashboard (HTTP ${status}) for ${what}`);
}

export async function selfUpdate(cfg: Config, io: SelfUpdateIo, o: { check: boolean; yes: boolean }): Promise<number> {
  if (!cfg.url) throw new ConfigError('no dashboard URL: set SIISWELL_URL or "url" in the config file');
  if (!isSafeUrl(cfg.url)) throw new ConfigError("the dashboard URL must use https (plain http only for localhost): not updating");
  const token = cfg.token ?? cfg.hostToken;
  if (!token) throw new ConfigError("no token: set SIISWELL_TOKEN (client) or SIISWELL_HOST_TOKEN (host), or use the config file");

  const r = await send(cfg.url, "/api/ingest/client/latest", { token, fetch: io.fetch, timeoutMs: 20_000 });
  if (r.status !== 200) throw why(r.status, errorDetail(r), "manifest");
  const m = parseManifest(r.json);
  if (!m) throw new ConfigError("the dashboard's client manifest could not be read; nothing was changed");

  io.out(`installed: ${CLI_VERSION} (${CLI_SHA})`);
  io.out(`published: ${m.version} (${m.sha})`);
  if (!isNewer(m)) {
    io.out("siiswell is up to date.");
    return 0;
  }
  if (o.check) {
    io.out("An update is available. Run `siiswell update` to install it.");
    return 0;
  }
  if (!o.yes) {
    const ok = io.confirm ? await io.confirm(`Install ${m.version}?`) : false;
    if (!ok) {
      io.out("No change made. Run `siiswell update --yes` to install without being asked.");
      return 0;
    }
  }

  let target: string;
  try {
    target = io.scriptPath ?? realpathSync(process.argv[1] ?? "");
    if (!statSync(target).isFile() || !/\.mjs$/.test(target)) throw new Error("not a bundle");
  } catch {
    throw new ConfigError("this copy is not an installed siiswell.mjs (a source checkout?), so there is nothing to replace; no change made");
  }

  const b = await send(cfg.url, "/api/ingest/client/siiswell.mjs", { token, fetch: io.fetch, timeoutMs: 60_000, maxBytes: MAX_BUNDLE_BYTES, raw: true, headers: { Accept: "text/javascript" } });
  if (b.status !== 200) throw why(b.status, errorDetail(b), "bundle");
  const data = Buffer.from(b.text, "utf8");
  if (data.byteLength !== m.size) throw new ConfigError(`the download has the wrong size (${data.byteLength}, expected ${m.size}); nothing was changed`);
  if (createHash("sha256").update(data).digest("hex") !== m.sha256) throw new ConfigError("the download does not match its checksum; nothing was changed");

  const smoke = io.smoke === false ? undefined : (tmp: string): string | null => {
    const res = spawnSync(process.execPath, [tmp, "--version"], { encoding: "utf8", timeout: 20_000 });
    return res.status === 0 && /^\d+\.\d+\.\d+ \(/.test(res.stdout ?? "") ? null : "the downloaded file did not start correctly; nothing was changed";
  };
  try {
    replaceFileAtomic(target, data, smoke);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`could not replace ${target} (${(e as NodeJS.ErrnoException).code ?? "error"}); nothing was changed`);
  }
  io.out(`Updated to ${m.version} (${m.sha}): ${target}`);
  io.out("The file path is unchanged, so the MCP registration, hooks and usage schedule keep working; tokens and configs were not touched.");
  io.out("Open sessions pick the new version up the next time they start the CLI. If a release note says hooks or rules changed, run scripts/setup-client.sh --reuse from a checkout.");
  return 0;
}

export { HttpError };
