// SPDX-License-Identifier: Apache-2.0
/**
 * @file `siiswell permissions suggest`: which tool calls in the last 7 days of local Claude Code transcripts were NOT covered
 * by the `permissions.allow` rules of ~/.claude/settings.json (+ settings.local.json), so each of them asked for approval
 * (unless the session ran in an auto-approve mode), counted per allowlist key, with a snippet to paste. Local only: nothing
 * is sent, and only rule keys are printed (a command's first word(s), a domain, a tool name), never a full command.
 */
import { closeSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openRegular, readLines, readSmall } from "./usage/collect";

export const SUGGEST_DAYS = 7;
/** Commands whose second word is the real action: `git push` and `git status` are different rules. */
const TWO_WORD = new Set(["git", "npm", "pnpm", "yarn", "bun", "bunx", "npx", "docker", "kubectl", "cargo", "go", "make", "gh", "uv", "pip", "pip3", "python", "python3", "node", "deno", "terraform", "brew", "systemctl", "wrangler"]);
const SAFE_WORD = /^[A-Za-z0-9._+-]{1,40}$/;

/** The allowlist key for one tool call, or null when it is not worth a rule (read-only tools, odd input). Pure. */
export function ruleKey(tool: string, input: unknown): string | null {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "Bash") {
    const cmd = typeof i.command === "string" ? i.command.trim() : "";
    // the first simple command only: leading env assignments skipped; a word with a path or shell syntax is not a rule key
    const words = cmd.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const first = words[0] ?? "";
    if (!SAFE_WORD.test(first)) return null;
    const second = words[1] ?? "";
    if (TWO_WORD.has(first) && SAFE_WORD.test(second) && !second.startsWith("-")) return `Bash(${first} ${second}:*)`;
    return `Bash(${first}:*)`;
  }
  if (tool === "WebFetch") {
    try {
      const host = new URL(String(i.url ?? "")).hostname;
      return host ? `WebFetch(domain:${host})` : null;
    } catch {
      return null;
    }
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit" || tool === "WebSearch") return tool;
  if (/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(tool)) return tool;
  return null; // Read, Glob, Grep, ...: no approval needed
}

/** Does an allow rule cover this key? Exact, the whole tool (`Bash`, `mcp__server`), or a `Bash(prefix:*)` prefix. Pure. */
export function covered(key: string, allow: readonly string[]): boolean {
  for (const r of allow) {
    if (r === key) return true;
    const tool = key.replace(/\(.*$/, "");
    if (r === tool) return true;
    if (key.startsWith("mcp__") && (key === r || key.startsWith(`${r}__`))) return true;
    const m = /^Bash\((.+):\*\)$/.exec(r);
    const k = /^Bash\((.+):\*\)$/.exec(key);
    if (m && k && (k[1] === m[1] || k[1]!.startsWith(`${m[1]} `))) return true;
  }
  return false;
}

function allowRules(home: string): string[] {
  const out: string[] = [];
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      const j = JSON.parse(readSmall(join(home, ".claude", f), 4 << 20) ?? "{}") as { permissions?: { allow?: unknown } };
      if (Array.isArray(j.permissions?.allow)) for (const r of j.permissions!.allow) if (typeof r === "string") out.push(r);
    } catch { /* no file / not JSON */ }
  }
  return out;
}

function transcripts(root: string, since: number, max = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length >= max) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (n.endsWith(".jsonl") && st.isFile() && st.mtimeMs >= since) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

export interface Suggestion { rule: string; count: number }

/** Scan the transcripts of the last SUGGEST_DAYS days. Never throws; never reads more than the files' current size. */
export function suggestPermissions(home: string, now: number): { suggestions: Suggestion[]; allowed: number; files: number; calls: number } {
  const since = now - SUGGEST_DAYS * 86_400_000;
  const allow = allowRules(home);
  const counts = new Map<string, number>();
  let calls = 0;
  let allowed = 0;
  const files = transcripts(join(home, ".claude", "projects"), since);
  for (const f of files) {
    const h = openRegular(f);
    if (!h) continue;
    try {
      readLines(h.fd, 0, h.size, (buf, a, b) => {
        if (buf.indexOf('"tool_use"', a) < 0 || buf.indexOf('"tool_use"', a) >= b) return;
        let j: { timestamp?: string; message?: { content?: unknown } };
        try { j = JSON.parse(buf.toString("utf8", a, b)); } catch { return; }
        const t = Date.parse(j.timestamp ?? "");
        if (Number.isFinite(t) && t < since) return;
        for (const c of Array.isArray(j.message?.content) ? (j.message!.content as Array<Record<string, unknown>>) : []) {
          if (c?.type !== "tool_use" || typeof c.name !== "string") continue;
          const key = ruleKey(c.name, c.input);
          if (!key) continue;
          calls++;
          if (covered(key, allow)) { allowed++; continue; }
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }, { bytes: 0 });
    } finally {
      try { closeSync(h.fd); } catch { /* closed */ }
    }
  }
  const suggestions = [...counts.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count || (a.rule < b.rule ? -1 : 1));
  return { suggestions, allowed, files: files.length, calls };
}
