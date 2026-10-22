// SPDX-License-Identifier: Apache-2.0
/**
 * @file Origin values sent by older host integrations, accepted on ingest only and stored as the canonical value
 * (`ORIGIN_HOST` / `ORIGIN_RELAY` in ./wire). The only place that names them; spelled in pieces on purpose, like the
 * migrations that rewrite them (0004, 0015).
 */
export const LEGACY_HOST_ORIGIN = "t" + "mux-orch";
export const LEGACY_RELAY_ORIGIN = "ma" + "trix-relay";

export const LEGACY_ORIGINS: Readonly<Record<string, "host" | "relay">> = Object.freeze({
  [LEGACY_HOST_ORIGIN]: "host",
  [LEGACY_RELAY_ORIGIN]: "relay",
});
