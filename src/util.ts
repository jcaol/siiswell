/**
 * @file Small helpers shared by the Worker modules: base64url, hashing, JSON responses,
 * input cleaning. Web APIs only (runs in workerd and in bun for the tests).
 * @module dashboard-worker/util
 */

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function b64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepts base64url and plain base64, with or without padding. Throws on invalid input. */
export function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", utf8(text)));
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** HTTPS only for a year, on every response. (Static assets get the same header from public/_headers.) */
export const HSTS = "max-age=31536000";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...extra },
  });
}

export function errorJson(status: number, message: string, extra: Record<string, string> = {}): Response {
  return json({ error: message }, status, extra);
}

/** 202 with no body (MCP notifications). */
export function accepted(): Response {
  return new Response(null, { status: 202, headers: BASE_HEADERS });
}

// ── identifiers ──────────────────────────────────────────────────────────────
//
// Identifiers (host, project, agent, task/approval/discussion ids, chat senders) are VALIDATED and
// REJECTED, never rewritten: running them through the redaction in `clipText` would turn a label like
// `sk-build-server` into `[redacted]` and make two different raw names collide. They also end up in
// alert/task keys that use `|` as separator, which none of these character sets contain.

export const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PROJECT_RE = HOST_RE;
/** Agent names; relay/MCP agents contain `@` (`claude@<localpart>`, `codex@client2`). */
export const AGENT_RE = /^[A-Za-z0-9._@=/+-]{1,96}$/;   // `+` and `=`: chat localparts in relayed agent names
/** Task ids (`${agent}-${base36}`), approval ids, discussion ids. */
export const ID_RE = /^[A-Za-z0-9._@=:/-]{1,128}$/;
/** chat user ids (`@localpart:server`). */
export const SENDER_RE = /^[A-Za-z0-9._@=:/+-]{1,128}$/;
export const BASE_CLI_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const SCENARIO_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** A request the sender must fix (HTTP 400 for ingest, an `isError` tool result for MCP). */
export class BadRequest extends Error {}

// C0/C1 controls (CR, LF, NUL, ESC, ...) and the Unicode line/paragraph separators.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

export function badIdentifier(field: string, re: RegExp, v: unknown): BadRequest {
  // The offending value is echoed back in a 400: cut it, and replace CR/LF and every other control
  // character (and the Unicode line separators) so it can never forge a log line or a header.
  const cut = typeof v === "string" ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : "";
  const shown = typeof v === "string" ? ` (got '${cut.replace(CONTROL_CHARS, "?")}')` : "";
  return new BadRequest(`${field} must match ${re.source}${shown}`);
}

/** The raw value if it is a string matching `re`, else a BadRequest. Never rewrites. */
export function ident(v: unknown, re: RegExp, field: string): string {
  if (typeof v !== "string" || !re.test(v)) throw badIdentifier(field, re, v);
  return v;
}

/** Like `ident` but `undefined`/`null` mean "absent". */
export function optIdent(v: unknown, re: RegExp, field: string): string | undefined {
  return v === undefined || v === null ? undefined : ident(v, re, field);
}

/** Agent names are matched case-insensitively everywhere: validated, then lower-cased at ingest. */
export function agentId(v: unknown, field: string): string {
  return ident(v, AGENT_RE, field).toLowerCase();
}
export function optAgentId(v: unknown, field: string): string | undefined {
  return v === undefined || v === null ? undefined : agentId(v, field);
}

/** Dedupe keys supplied by senders: bounded, control characters stripped, NOT redacted. */
export function cleanKey(v: unknown, max = 200): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

export type BodyText = { ok: true; text: string } | { ok: false };

/** Read a request body as UTF-8 text, refusing anything over `max` bytes (declared or streamed). */
export async function readBodyText(req: Request, max: number): Promise<BodyText> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { ok: false };
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

/** n characters from [0-9a-z], unbiased (rejection sampling). */
export function randomBase36(n: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  while (out.length < n) {
    const buf = new Uint8Array(n * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 252 && out.length < n) out += alphabet[b % 36];
    }
  }
  return out;
}

/** Finite number or undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
