// SPDX-License-Identifier: Apache-2.0
/**
 * @file The only way the CLI talks to the dashboard: POST/GET with a bearer token, no redirects, bounded bodies, timeouts.
 * @module cli/http
 *
 * A redirect is never followed (`redirect: "manual"` and any 3xx is refused): following one would hand the token to whatever
 * host the redirect names. Errors never contain the token. Plain http is refused by config.ts except for localhost.
 */

import { CLI_SHA, CLI_VERSION } from "./build-info";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** The MCP protocol version the CLI speaks when it is not relaying a client's own (`2025-06-18`, supported by the server). */
export const CLI_MCP_VERSION = "2025-06-18";

export interface HttpResult {
  status: number;
  /** parsed JSON body, or null when the body is not JSON */
  json: unknown;
  text: string;
  headers: Headers;
}

export class HttpError extends Error {
  constructor(message: string, readonly kind: "redirect" | "timeout" | "network" | "too-large") {
    super(message);
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > max) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new HttpError("the server answered with a body that is too large", "too-large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new HttpError("the server answered with a body that is too large", "too-large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export interface SendOptions {
  method?: "GET" | "POST";
  token?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Largest body accepted (default MAX_RESPONSE_BYTES); `siiswell update` raises it for the CLI bundle. */
  maxBytes?: number;
  /**
   * Return a 3xx as a result (its `location` header readable) instead of throwing. Still never FOLLOWED. Only for requests that carry
   * no token (doctor's health probe, which an access proxy in front of the dashboard answers with a redirect to its login page).
   */
  returnRedirect?: boolean;
  /** Skip JSON.parse of the body (`json` stays null): for the CLI bundle download. */
  raw?: boolean;
}

/** One request to `${base}${path}`. Throws HttpError on a redirect, a timeout or a network failure; any other status is returned. */
export async function send(base: string, path: string, opts: SendOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: "application/json", "X-Siiswell-Client": `${CLI_VERSION}+${CLI_SHA}`, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  let res: Response;
  try {
    res = await doFetch(`${base}${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      body: opts.body,
      redirect: "manual", // never follow a redirect with the bearer token attached
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { message?: string } };
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new HttpError("the dashboard did not answer in time", "timeout");
    if (/redirect/i.test(`${e?.message ?? ""} ${e?.cause?.message ?? ""}`)) throw redirectError();
    throw new HttpError("the dashboard cannot be reached (network error)", "network");
  }
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (opts.returnRedirect && !opts.token) return { status: res.status || 302, json: null, text: "", headers: res.headers };
    throw redirectError();
  }
  const text = await readCapped(res, opts.maxBytes ?? MAX_RESPONSE_BYTES);
  let json: unknown = null;
  try {
    json = text && !opts.raw ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

function redirectError(): HttpError {
  return new HttpError(
    "the server answered with a redirect, which is refused (the token is never sent to a redirect target): check the dashboard URL",
    "redirect",
  );
}

/** A short reason from an error body (`{"error": "..."}`), never more than 200 characters. */
export function errorDetail(r: HttpResult): string {
  const j = r.json as { error?: unknown } | null;
  if (j && typeof j === "object" && typeof j.error === "string") return j.error.slice(0, 200);
  if (j && typeof j === "object" && j.error && typeof (j.error as { message?: unknown }).message === "string") return String((j.error as { message: string }).message).slice(0, 200);
  return "";
}

/** POST one JSON-RPC message to /mcp with a client token. */
export function postMcp(base: string, token: string, message: unknown, opts: { fetch?: FetchLike; headers?: Record<string, string>; rawBody?: string; timeoutMs?: number } = {}): Promise<HttpResult> {
  return send(base, "/mcp", {
    token,
    timeoutMs: opts.timeoutMs,
    body: opts.rawBody ?? JSON.stringify(message),
    headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": CLI_MCP_VERSION, ...(opts.headers ?? {}) },
    fetch: opts.fetch,
  });
}

/**
 * Does a redirect (or a 401/403 HTML page) come from an access proxy in front of the dashboard (Cloudflare Access, oauth2-proxy,
 * a login page) rather than from the dashboard? Judged by the Location target only; nothing is fetched.
 */
export function isAccessRedirect(r: HttpResult): boolean {
  if (r.status < 300 || r.status >= 400) return false;
  const loc = r.headers.get("location") ?? "";
  return /cloudflareaccess\.com|\/cdn-cgi\/access\/|oauth2|\/login|\/signin|\/sign_in|\/auth\b|accounts\.google\.com|\/sso\b/i.test(loc);
}
