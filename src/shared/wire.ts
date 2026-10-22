// SPDX-License-Identifier: Apache-2.0
/**
 * @file Wire / storage values of `origin` (`tasks.origin`, `alerts.origin`, `events.origin`, and the `origin` of an
 * ingested event). Everything else refers to them through these constants.
 *
 * Older clients still send other values: ingest accepts those (./legacyOrigins) and stores the canonical value
 * (migration 0004 rewrote the rows stored before). Nothing is ever written or sent with a legacy value.
 */
import { LEGACY_ORIGINS } from "./legacyOrigins";

/** Origin of an event / task / alert produced by a host's own agents. */
export const ORIGIN_HOST = "host" as const;
/** Origin of an event / task forwarded by a host, sent by an agent NOT run by that host. */
export const ORIGIN_RELAY = "relay" as const;

/** Older clients' origin values -> the canonical one (accepted on ingest only). */
export const LEGACY_ORIGIN_ALIASES: Readonly<Record<string, typeof ORIGIN_HOST | typeof ORIGIN_RELAY>> = LEGACY_ORIGINS;

/**
 * TRANSITION (migration 0004): SQL that compares or returns `origin` treats a legacy value exactly like its canonical
 * one, so the Worker and migration 0004 can be deployed in either order and rows written before 0004 behave the same.
 * A later release (after 0004 has run everywhere) can narrow these back to the canonical value alone.
 * The values are constants of this file, never user input, so inlining them into SQL is safe.
 */
const sqlList = (canonical: string): string =>
  [canonical, ...Object.keys(LEGACY_ORIGIN_ALIASES).filter((k) => LEGACY_ORIGIN_ALIASES[k] === canonical)].map((v) => `'${v}'`).join(", ");
/** `'host', <its legacy alias>` for `origin IN (...)`. */
export const SQL_HOST_ORIGINS = sqlList(ORIGIN_HOST);
/** `'relay', <its legacy alias>` for `origin IN (...)` / `NOT IN (...)`. */
export const SQL_RELAY_ORIGINS = sqlList(ORIGIN_RELAY);
/** `col` read back as its canonical value. */
export function sqlCanonicalOrigin(col: string): string {
  return `CASE ${col} ${Object.entries(LEGACY_ORIGIN_ALIASES).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE ${col} END`;
}

/** An origin as received: a legacy alias becomes its canonical value, anything else is returned unchanged. */
export function canonicalOrigin(v: unknown): unknown {
  return typeof v === "string" && Object.hasOwn(LEGACY_ORIGIN_ALIASES, v) ? LEGACY_ORIGIN_ALIASES[v] : v;
}
