/**
 * @file The CLI bundle this server hands to `siiswell update`. THIS IS THE EMPTY STUB (no bundle published).
 * `bun scripts/embed-client.ts` writes the real bundle into this file for a deploy / Docker build and
 * `bun scripts/embed-client.ts --restore` puts the stub back (`bun run deploy` does both). Do not commit the embedded form.
 */
export interface ClientDist {
  manifest: { version: string; sha: string; sha256: string; size: number };
  source: string;
}
export const CLIENT_DIST: ClientDist | null = null;
