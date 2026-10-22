// SPDX-License-Identifier: Apache-2.0
/**
 * @file Is a hook running in an agent workspace that another tool drives? An agent orchestrator (or any automation that
 * types the prompts itself and reports its own tasks through the host integration) marks its projects with a file named
 * `.siiswell-agents` in the project root; its agents work in `<root>/<project>/worktrees/...`. It can also set
 * `SIISWELL_AGENT=1` in the agents' environment. A hook there records nothing and reports nothing, so the hooks can live on
 * such a server and count only the operator's own sessions (e.g. one in <root>/<project> or any other checkout outside a
 * worktrees folder), and no task is reported twice.
 * Cheap: only a cwd with a "worktrees" segment costs one existsSync per such segment; the answer is cached per cwd.
 */
import { existsSync } from "node:fs";

/** The marker file in a project root whose `worktrees/...` are agent workspaces. */
export const AGENT_MARKER = ".siiswell-agents";

const cache = new Map<string, boolean>();

/** `SIISWELL_AGENT` set to 1 / true / yes by whatever starts the agent. */
export function agentByEnv(env: Record<string, string | undefined>): boolean {
  return /^(1|true|yes)$/i.test((env.SIISWELL_AGENT ?? "").trim());
}

export function inAgentPane(cwd: string | undefined, env: Record<string, string | undefined> = {}): boolean {
  if (agentByEnv(env)) return true;
  if (!cwd) return false;
  const hit = cache.get(cwd);
  if (hit !== undefined) return hit;
  const segs = cwd.split("/");
  let yes = false;
  for (let i = 2; i < segs.length && !yes; i++) {
    if (segs[i] !== "worktrees") continue;
    const project = segs.slice(0, i).join("/");
    if (project && existsSync(`${project}/${AGENT_MARKER}`)) yes = true;
  }
  if (cache.size > 200) cache.clear();
  cache.set(cwd, yes);
  return yes;
}
