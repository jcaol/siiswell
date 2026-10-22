// SPDX-License-Identifier: Apache-2.0
/**
 * @file `siiswell mcp`: a stdio MCP server that relays every message to the dashboard's remote /mcp endpoint.
 * @module cli/mcp-stdio
 *
 * For clients that cannot do remote HTTP with a custom header (Claude Desktop, some CLIs). Newline-delimited JSON-RPC on
 * stdin/stdout; every message is POSTed to `${url}/mcp` with the client token. Before a `tools/call` leaves the machine its
 * free-text arguments (title, summary) are scrubbed and clipped with the same function the server uses (src/shared/redact.ts),
 * so a secret never reaches the network even once. Nothing but MCP messages is written to stdout; logs go to stderr and never
 * contain the token. A report_task without a `project` gets the current project's folder name (never a path), and every report_task
 * carries the configured `machine` label, so the dashboard can group several apps of one machine. Same behaviour as bridge/siiswell-bridge.mjs otherwise (protocol-version headers, initialize gate).
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { clipText } from "../../src/shared/redact";
import { MAX_TEXT, MAX_TITLE } from "../../src/shared/schema";
import { DEFAULT_TASK_TEXT, applyTaskText, type TaskTextMode } from "./tasktext";
import { HttpError, send, type FetchLike } from "./http";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface CallDefaults {
  /** project for a report_task that names none (config `project`, else the MCP process's folder: see mcpDefaultProject) */
  project?: string;
  /** machine label added to every report_task (config `machine`) */
  machine?: string;
  /** the `taskText` setting (default brief when a caller sets none): limits title / summary before they are sent */
  taskText?: TaskTextMode;
}

/** Fill a report_task's missing `project` and the `machine` label in place (never overriding what the agent sent); true when changed. */
export function fillToolCall(msg: unknown, d: CallDefaults): boolean {
  if (!isObj(msg) || msg.method !== "tools/call" || !isObj(msg.params) || msg.params.name !== "report_task") return false;
  if (msg.params.arguments === undefined) msg.params.arguments = {};
  const args = msg.params.arguments;
  if (!isObj(args)) return false;
  let changed = false;
  if (d.project && (args.project === undefined || args.project === null || args.project === "")) {
    args.project = d.project;
    changed = true;
  }
  if (d.machine && args.machine === undefined) {
    args.machine = d.machine;
    changed = true;
  }
  return changed;
}

/**
 * The tools/list answer as this bridge serves it: report_task's `project` becomes optional when the bridge can fill it in, and
 * `machine` (the bridge's own field) is not offered to the agent. In place.
 */
export function adjustToolsList(reply: unknown, d: CallDefaults): void {
  const tools = isObj(reply) && isObj(reply.result) && Array.isArray(reply.result.tools) ? reply.result.tools : null;
  for (const t of tools ?? []) {
    if (!isObj(t) || t.name !== "report_task" || !isObj(t.inputSchema)) continue;
    const schema = t.inputSchema;
    if (isObj(schema.properties)) delete schema.properties.machine;
    if (d.project && Array.isArray(schema.required)) {
      schema.required = schema.required.filter((r) => r !== "project");
      if (isObj(schema.properties) && isObj(schema.properties.project)) {
        schema.properties.project.description = `${String(schema.properties.project.description ?? "")} Optional here: defaults to "${d.project}" (the current project).`.trim();
      }
    }
  }
}

/** Limit the title / summary of a report_task / update_task call in place per `mode`; true when anything changed. */
export function limitToolCallText(msg: unknown, mode: TaskTextMode): boolean {
  if (mode === "full" || !isObj(msg) || msg.method !== "tools/call" || !isObj(msg.params) || !isObj(msg.params.arguments)) return false;
  const name = String(msg.params.name);
  const before = JSON.stringify(msg.params.arguments);
  const after = applyTaskText(name, msg.params.arguments, mode);
  if (JSON.stringify(after) === before) return false;
  msg.params.arguments = after;
  return true;
}

/** Scrub the free text of one tools/call message in place; returns true when anything changed. */
export function redactToolCall(msg: unknown): boolean {
  if (!isObj(msg) || msg.method !== "tools/call" || !isObj(msg.params) || !isObj(msg.params.arguments)) return false;
  const args = msg.params.arguments;
  let changed = false;
  for (const [field, max] of [["title", MAX_TITLE], ["summary", MAX_TEXT]] as const) {
    if (typeof args[field] === "string") {
      const clean = clipText(args[field] as string, max);
      if (clean !== args[field]) {
        args[field] = clean;
        changed = true;
      }
    }
  }
  return changed;
}

function fromSse(text: string): unknown {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (data) return JSON.parse(data);
  }
  return null;
}

export interface StdioOptions {
  base: string;
  token: string;
  input: Readable;
  output: Writable;
  log: (msg: string) => void;
  fetch?: FetchLike;
  defaults?: CallDefaults;
  /**
   * Set inside an agent workspace (see ../agentpane): the tools that write (report_task, update_task, heartbeat) are answered here with this
   * text and never sent, since the host integration already reports those tasks. The read tools still go through.
   */
  skipWrites?: string;
}

/** The tools that file or change something on the dashboard. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["report_task", "update_task", "heartbeat"]);

/** The local answer to a write tool call that must not leave the machine, or null when `m` is not one. */
export function skippedCall(m: unknown, reason: string): Json | null {
  if (!isObj(m) || m.method !== "tools/call" || !isObj(m.params) || !WRITE_TOOLS.has(String(m.params.name))) return null;
  return { jsonrpc: "2.0", id: "id" in m ? m.id : null, result: { content: [{ type: "text", text: reason }], isError: false } };
}

/** Run until stdin closes and every request in flight has been answered. */
export function runMcpStdio(o: StdioOptions): Promise<void> {
  let negotiated = "";
  const out = (obj: unknown) => o.output.write(`${JSON.stringify(obj)}\n`);

  const headersFor = (msg: unknown): Record<string, string> => {
    const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
    const params = isObj(msg) && isObj(msg.params) ? msg.params : null;
    const meta = params && isObj(params._meta) ? params._meta : null;
    const modern = meta && typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : "";
    const version = modern || negotiated;
    if (version) headers["MCP-Protocol-Version"] = version;
    if (modern && isObj(msg) && typeof msg.method === "string") {
      headers["Mcp-Method"] = msg.method;
      const name = params!.name ?? params!.uri;
      if (name !== undefined) headers["Mcp-Name"] = /^[\x21-\x7e]+$/.test(String(name)) ? String(name) : `=?base64?${Buffer.from(String(name)).toString("base64")}?=`;
    }
    return headers;
  };

  const forward = async (line: string): Promise<void> => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (o.skipWrites) {
      const reason = o.skipWrites;
      if (Array.isArray(msg)) {
        const local = msg.map((m) => skippedCall(m, reason)).filter((r): r is Json => r !== null);
        if (local.length) {
          const rest = msg.filter((m) => !skippedCall(m, reason));
          // the skipped calls are answered together; whatever else the batch held goes on its own
          if (rest.length) await forward(JSON.stringify(rest));
          out(local);
          return;
        }
      } else {
        const local = skippedCall(msg, reason);
        if (local) {
          if ("id" in (msg as Json)) out(local); // a call sent as a notification gets no answer
          return;
        }
      }
    }
    const id = isObj(msg) && "id" in msg ? msg.id : undefined;
    const d = o.defaults ?? {};
    const one = (m: unknown) => [fillToolCall(m, d), redactToolCall(m), limitToolCallText(m, d.taskText ?? DEFAULT_TASK_TEXT)].some(Boolean);
    const changed = Array.isArray(msg) ? msg.map(one).some(Boolean) : one(msg);
    const body = changed ? JSON.stringify(msg) : line;
    try {
      const res = await send(o.base, "/mcp", { token: o.token, body, headers: headersFor(msg), fetch: o.fetch });
      if (res.status === 202) return; // a notification was accepted: nothing to write
      let reply: unknown = res.json;
      if (reply === null && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        try { reply = fromSse(res.text); } catch { reply = null; }
      }
      const jsonRpc = Array.isArray(reply) || (isObj(reply) && reply.jsonrpc === "2.0");
      if (jsonRpc) {
        if (isObj(msg) && msg.method === "tools/list") adjustToolsList(reply, d);
        if (isObj(msg) && msg.method === "initialize" && isObj(reply) && isObj(reply.result) && typeof reply.result.protocolVersion === "string") {
          negotiated = reply.result.protocolVersion;
        }
        out(reply);
        return;
      }
      const why = isObj(reply) && typeof reply.error === "string" ? `: ${reply.error.slice(0, 120)}` : "";
      o.log(`HTTP ${res.status} without a JSON-RPC body${why}`);
      if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32603, message: `Dashboard answered HTTP ${res.status}${why}` } });
    } catch (err) {
      o.log(`request failed: ${err instanceof HttpError ? err.message : "network error"}`);
      if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32603, message: "Dashboard unreachable" } });
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: o.input, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    let initGate: Promise<unknown> = Promise.resolve(); // later messages wait for an in-flight initialize so they carry its version
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const isInit = /"method"\s*:\s*"initialize"/.test(line);
      const p: Promise<void> = (isInit ? forward(line) : initGate.then(() => forward(line))).finally(() => pending.delete(p));
      if (isInit) initGate = p.catch(() => undefined);
      pending.add(p);
    });
    rl.on("close", () => {
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
