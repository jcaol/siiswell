// SPDX-License-Identifier: Apache-2.0
/**
 * @file Token-count parsing of Claude Code transcripts and Codex rollouts (ported from the original host agent's usage scanner).
 * @module cli/usage/parse
 *
 * Only numeric usage fields, the model id, the timestamp, the message id, the cwd and the app (`entrypoint` / `originator`) are read out of a line. Message
 * content, tool input/output, prompts and file contents are never read into any variable that is stored, printed or sent.
 */

/** Only id-shaped model strings pass (a transcript is untrusted input). */
export function cleanModelId(s: unknown): string | null {
  return typeof s === "string" && /^(?=.{1,80}$)[A-Za-z0-9._:/\[\]-]+(@\d{8})?$/.test(s) ? s : null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export interface ClaudeUsageLine {
  t: number;
  model: string;
  /** message id (a message is repeated once per content block with cumulative usage) */
  id: string;
  /** [fresh input, output, cache read, cache write (all TTLs)] */
  cur: [number, number, number, number];
  /** cache write that used the 1h TTL */
  w1h: number;
  fast: boolean;
  cwd?: string;
  /** the app label of the line's `entrypoint` (see claudeApp), absent when the line has none */
  app?: string;
  /** the raw `entrypoint` when it mapped to `unknown` (local diagnostics only, see collect.ts `unrecognised`) */
  rawEntry?: string;
}

/**
 * App labels: which app produced a request. A FIXED vocabulary (never a raw value from a transcript), so a label can leave the
 * machine under every privacy policy. Claude Code writes `entrypoint` on every transcript line (`cli` for the terminal, `sdk-*`
 * for the Agent SDK, `claude-vscode` / other IDE names for the editor extensions, `claude-desktop` for the desktop app);
 * Codex writes `originator` in the rollout's `session_meta` (`codex_cli_rs` for the terminal, `codex_exec` for `codex exec`,
 * `codex_vscode` for the IDE extension, a desktop name for the desktop app).
 */
export const APP_LABELS = ["claude-cli", "claude-desktop", "claude-ide", "claude-sdk", "codex-cli", "codex-exec", "codex-desktop", "codex-ide", "unknown"] as const;
export type AppLabel = (typeof APP_LABELS)[number];

/** Claude Code `entrypoint` -> app label. */
export function claudeApp(entrypoint: unknown): AppLabel {
  if (typeof entrypoint !== "string" || entrypoint.length > 64) return "unknown";
  const e = entrypoint.toLowerCase();
  if (e === "cli") return "claude-cli";
  if (e.includes("desktop")) return "claude-desktop";
  if (/^sdk(-|$)/.test(e)) return "claude-sdk";
  if (/vscode|jetbrains|intellij|cursor|windsurf|ide/.test(e)) return "claude-ide";
  return "unknown";
}

/** Codex `session_meta` `originator` (else its `source`) -> app label. */
export function codexApp(originator: unknown, source?: unknown): AppLabel {
  const o = typeof originator === "string" && originator.length <= 64 ? originator.toLowerCase() : "";
  const s = typeof source === "string" && source.length <= 64 ? source.toLowerCase() : "";
  if (o.includes("exec") || (!o && s === "exec")) return "codex-exec";
  if (o.includes("desktop") || /^codex[ _-]?app/.test(o) || o.includes("electron")) return "codex-desktop";
  if (/vscode|jetbrains|intellij|cursor|windsurf|ide|extension/.test(o) || (!o && s === "vscode")) return "codex-ide";
  if (o.includes("cli") || o.includes("tui") || (!o && s === "cli")) return "codex-cli";
  return "unknown";
}

/** The usage of an assistant transcript line, or null when the line carries none. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseClaudeUsage(o: any): ClaudeUsageLine | null {
  if (o?.type !== "assistant") return null;
  const u = o.message?.usage;
  const rawModel: unknown = o.message?.model;
  if (!u || typeof u !== "object" || !rawModel || rawModel === "<synthetic>") return null;
  const model = cleanModelId(rawModel) ?? "unknown";
  const t = Date.parse(o.timestamp);
  if (!Number.isFinite(t)) return null;
  const id = o.message?.id ?? o.requestId ?? o.uuid;
  if (typeof id !== "string" || id.length > 200) return null;
  return {
    t,
    model,
    id,
    cur: [num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)],
    w1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
    fast: u.speed === "fast",
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    ...(typeof o.entrypoint === "string" ? { app: claudeApp(o.entrypoint) } : {}),
    ...(typeof o.entrypoint === "string" && claudeApp(o.entrypoint) === "unknown" ? { rawEntry: o.entrypoint } : {}),
  };
}

export interface ClaudeGrowth {
  /** [fresh input, output, cache read, cache write, cache write 1h]: the growth only */
  delta: [number, number, number, number, number];
  /** the first line of this message id (counts as one request) */
  first: boolean;
  /** whole-request prompt size so far (fresh + cache read + cache write) */
  prompt: number;
}

/**
 * One API message appears once per content block with CUMULATIVE usage: count only the growth.
 * `seen` (message id -> cumulative [in,out,cr,cw,cw1h]) is updated in place. null = nothing new.
 */
export function claudeGrowth(seen: Record<string, number[]>, l: ClaudeUsageLine): ClaudeGrowth | null {
  const known = seen[l.id];
  const before = known ?? [0, 0, 0, 0, 0];
  const now5 = [...l.cur, l.w1h];
  const delta = now5.map((v, i) => Math.max(0, v - (before[i] ?? 0)));
  const cum = now5.map((v, i) => Math.max(v, before[i] ?? 0));
  seen[l.id] = cum;
  if (delta.slice(0, 4).every((d) => d === 0)) return null;
  return { delta: delta as ClaudeGrowth["delta"], first: !known, prompt: cum[0]! + cum[2]! + cum[3]! };
}

/**
 * The model of a Codex rollout from its head (the first bytes of the file), for token_count lines that arrive before (or without)
 * a `turn_context` in the part being read: an incremental read that starts mid-file, or a rollout whose turns carry no model.
 * Tried in order: `session_meta` `payload.model` (matched in the first line's TEXT, never parsed: that line also holds the
 * instructions), then the first complete `turn_context` line's `payload.model`. `model_provider` alone names no model and is
 * ignored. null = no model id in the head.
 */
export function codexHeadModel(head: string): string | null {
  const lines = head.split("\n");
  const complete = head.endsWith("\n") ? lines : lines.slice(0, -1);
  const first = lines[0] ?? "";
  if (first.includes('"session_meta"')) {
    const m = cleanModelId(first.match(/"model":"([^"\\]{1,80})"/)?.[1]);
    if (m) return m;
  }
  for (const l of complete) {
    if (!l.includes('"turn_context"')) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    if (o?.type !== "turn_context") continue;
    const m = cleanModelId(o.payload?.model);
    if (m) return m;
  }
  return null;
}

export interface CodexDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  prompt: number;
}

/** token_count repeats after non-model events; only a growing total is new spend. `st.lastTotal` advances in place. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function codexDelta(info: any, st: { lastTotal?: number }): CodexDelta | null {
  const last = info?.last_token_usage;
  const total = info?.total_token_usage?.total_tokens;
  let rec: CodexDelta | null = null;
  if (last && typeof total === "number" && total > (st.lastTotal ?? 0)) {
    const cached = num(last.cached_input_tokens);
    const written = num(last.cache_write_input_tokens);
    // input tokens are EITHER fresh, cached OR a cache write: the write is taken out of the fresh input (never charged twice)
    rec = { input: Math.max(0, num(last.input_tokens) - cached - written), output: num(last.output_tokens), cacheRead: cached, cacheWrite: written, prompt: num(last.input_tokens) };
  }
  if (typeof total === "number" && Number.isFinite(total)) st.lastTotal = Math.max(st.lastTotal ?? 0, total);
  return rec;
}
