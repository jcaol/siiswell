// SPDX-License-Identifier: Apache-2.0
/**
 * @file The project label a task from `siiswell mcp`, a hook or `siiswell report` gets when none is named. The folder name is
 * found by mcpDefaultProject (configured roots, else only when kept or opted in), then shown exactly as the usage upload shows
 * it (usage.projectNames: the name if kept or "all", its salted hash if "hashed", nothing if "other"), so a name hidden on the
 * usage page never appears next to a task. An install whose usage bank predates these defaults (0.2.x) sends the name as
 * before, unless it sets usage.projectNames ("hashed" / "other" hide it); `siiswell doctor` says so.
 */
import { mcpDefaultProject, type Config } from "./config";
import { projectHasher, projectLabel } from "./usage/push";

let warned = false;
const stderrOnce = (m: string) => { process.stderr.write(`siiswell: ${m}\n`); };

/**
 * The label, or undefined (= file under "other"). Never throws: when the salt cannot be created (a read-only state dir) the
 * name is left out and ONE warning is printed per process.
 */
export function taskProject(cwd: string, cfg: Config, home?: string, warn: (m: string) => void = stderrOnce): string | undefined {
  const u = cfg.usage;
  const name = mcpDefaultProject(cwd, u.roots, home, u.inferProjectOutsideRoots, u.keep);
  // an install from before these defaults keeps sending the name, until it sets projectNames itself
  if (!name || (u.legacyBank && !u.projectNamesSet)) return name;
  try {
    const label = projectLabel(name, u, (n) => projectHasher(cfg.stateDir)(n));
    return label === "(other)" ? undefined : label;
  } catch {
    if (!warned) {
      warned = true;
      warn(`the project-name salt could not be created in ${cfg.stateDir}: tasks are filed without a project name`);
    }
    return undefined;
  }
}
