#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// siiswell stdio <-> HTTPS MCP bridge (`siiswell mcp` does the same job) for clients that cannot do remote HTTP + custom headers.
// Zero dependencies, Node >= 18. Newline-delimited JSON-RPC on stdin/stdout; every message is POSTed
// to ${SIISWELL_URL}/mcp with `Authorization: Bearer ${SIISWELL_TOKEN}`. Nothing is written to
// stdout except MCP messages; logs go to stderr and never contain the token.
import { createInterface } from "node:readline";

const base = (process.env.SIISWELL_URL || "").replace(/\/+$/, "").replace(/\/mcp$/, "");
const token = process.env.SIISWELL_TOKEN || "";
if (!/^https?:\/\//.test(base) || !token) {
  console.error("siiswell-bridge: set SIISWELL_URL (e.g. https://dash.example.com) and SIISWELL_TOKEN");
  process.exit(2);
}
if (!base.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
  console.error("siiswell-bridge: refusing to send the token over plain http to a non-local host");
  process.exit(2);
}

let negotiated = ""; // protocol version agreed in `initialize` (legacy handshake)
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`); // JSON.stringify never emits raw newlines
const log = (msg) => console.error(`siiswell-bridge: ${msg}`);

function headersFor(msg) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  const modern = msg && msg.params && msg.params._meta && msg.params._meta[META_VERSION];
  const version = modern || negotiated;
  if (version) headers["MCP-Protocol-Version"] = version;
  if (modern && msg.method) {
    headers["Mcp-Method"] = msg.method; // 2026-07-28 mirrors method/name into headers
    const name = msg.params.name ?? msg.params.uri;
    if (name !== undefined) headers["Mcp-Name"] = /^[\x21-\x7e]+$/.test(String(name)) ? String(name) : `=?base64?${Buffer.from(String(name)).toString("base64")}?=`;
  }
  return headers;
}

function fromSse(text) {
  // Not expected (the server answers JSON), but tolerate a single-event SSE body.
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (data) return JSON.parse(data);
  }
  return null;
}

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const id = msg && typeof msg === "object" && "id" in msg ? msg.id : undefined;
  try {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: headersFor(msg), body: line, signal: AbortSignal.timeout(30_000), redirect: "error" }); // never follow a redirect with the bearer token attached
    if (res.status === 202) return; // notification accepted, nothing to write
    const text = await res.text();
    let reply = null;
    try {
      reply = (res.headers.get("content-type") || "").includes("text/event-stream") ? fromSse(text) : JSON.parse(text);
    } catch {
      /* handled below */
    }
    const jsonRpc = (m) => m && typeof m === "object" && (Array.isArray(m) || m.jsonrpc === "2.0");
    if (jsonRpc(reply)) {
      if (msg && msg.method === "initialize" && reply.result && reply.result.protocolVersion) negotiated = reply.result.protocolVersion;
      return out(reply);
    }
    // Not a JSON-RPC reply (e.g. {"error":"invalid or revoked token"} from the auth layer).
    const why = reply && typeof reply.error === "string" ? `: ${reply.error.slice(0, 120)}` : "";
    log(`HTTP ${res.status} without a JSON-RPC body${why}`);
    if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32603, message: `Dashboard answered HTTP ${res.status}${why}` } });
  } catch (err) {
    log(`request failed: ${err && err.name === "TimeoutError" ? "timeout" : /redirect/i.test(`${err && err.message} ${err && err.cause && (err.cause.message || err.cause)}`) ? "the server answered with a redirect, which is refused (the token is never sent to a redirect target): check SIISWELL_URL" : "network error"}`);
    if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32603, message: "Dashboard unreachable" } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
let initGate = Promise.resolve(); // later messages wait for an in-flight `initialize` so they carry its version
rl.on("line", (line) => {
  if (!line.trim()) return;
  const isInit = /"method"\s*:\s*"initialize"/.test(line);
  const p = (isInit ? forward(line) : initGate.then(() => forward(line))).finally(() => pending.delete(p));
  if (isInit) initGate = p.catch(() => undefined);
  pending.add(p);
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
});
