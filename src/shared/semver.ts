// SPDX-License-Identifier: Apache-2.0
/** @file Minimal semver comparison for "x.y.z" (an optional "+build" suffix is ignored). Unknown shapes compare as null. */

export function parseSemver(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[+-][0-9A-Za-z.+-]{0,30})?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1, or null when either side is not a version. */
export function compareSemver(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** The version header a client sends: "0.5.0+abc1234" (or "+dev"). */
export const CLIENT_HEADER = "X-Siiswell-Client";
export const CLIENT_HEADER_RE = /^(\d{1,4}\.\d{1,4}\.\d{1,4})(?:\+([0-9a-f]{7,12}|dev))?$/;
