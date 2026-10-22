// SPDX-License-Identifier: Apache-2.0
/** The CLI's build stamp: package version, plus the git short sha and build day that cli/build.ts defines (`dev` from source). */
import pkg from "../package.json";

declare const __SIISWELL_CLI_BUILD__: { sha?: unknown; built?: unknown } | undefined;

const s = typeof __SIISWELL_CLI_BUILD__ === "object" && __SIISWELL_CLI_BUILD__ ? __SIISWELL_CLI_BUILD__ : {};
export const CLI_VERSION: string = pkg.version;
export const CLI_SHA: string = typeof s.sha === "string" && /^[0-9a-f]{7,12}$/.test(s.sha) ? s.sha : "dev";
export const CLI_BUILT: string | null = typeof s.built === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.built) ? s.built : null;
/** `siiswell --version`: `0.5.0 (abc1234, built 2026-10-18)`, or `0.5.0 (dev)`. */
export const CLI_VERSION_LINE = `${CLI_VERSION} (${CLI_SHA}${CLI_BUILT ? `, built ${CLI_BUILT}` : ""})`;
