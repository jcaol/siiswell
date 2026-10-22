// SPDX-License-Identifier: Apache-2.0
/**
 * What marks a task reported by the siiswell app hooks (cli/src/hooks.ts): one of the fixed titles AND the fixed summary. The
 * dashboard closes such a task when it stays BLOCKED with no update for HOOK_BLOCKED_STALE_MS (the user answered the permission
 * prompt and then left with Ctrl-C, /exit or a closed terminal, so no hook ever came back). Shared by the CLI and the Worker.
 */
// [0] a permission prompt; [1] the idle prompt as CLIs before 0.3.0 reported it (closed by the dashboard, never a block);
// [2] any other Notification that waits for the user (elicitation_dialog, unknown types)
export const HOOK_TITLES = ["Waiting for your permission", "Waiting for your input", "Waiting for your input (action needed)"] as const;
export const HOOK_MARK = "reported by the siiswell hook";
export const HOOK_BLOCKED_STALE_MS = 2 * 60 * 60_000;
export const HOOK_STALE_LINE = "Closed — no activity after the permission prompt";
/** The title older CLIs gave the idle Notification's task (not a block): the dashboard closes such a task at the next tick. */
export const HOOK_IDLE_TITLE = HOOK_TITLES[1];
export const HOOK_IDLE_LINE = "Closed — the agent had finished; waiting for input is not a block";
