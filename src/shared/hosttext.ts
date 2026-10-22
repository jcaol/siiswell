// SPDX-License-Identifier: Apache-2.0
/**
 * @file The server's ceiling for the free text of host snapshots and events (ACCEPT_HOST_TEXT), the counterpart of
 * ACCEPT_TASK_TEXT for clients. A host's task titles are often the operator's own request text, so by default the server keeps
 * only labels built from structured fields. Same level names and order as the task text: none < minimal < brief < full.
 * - full: as sent (still redacted and clipped).
 * - brief: task titles redacted and clipped to 60 characters; approval summaries replaced by a fixed label; discussion
 *   topics clipped to 60; event text as under `lastLine` rules.
 * - minimal (default) / none: task titles become "Task for <agent>" (none: "Task"); approval summaries a fixed label;
 *   discussion topics dropped; event text a fixed label; `lastLine` dropped.
 * Ids, states, ETAs, agent and project are kept in every mode.
 * @module shared/hosttext
 */
import { BRIEF_TITLE_MAX, parseTaskText, stricterTaskText, type TaskTextMode } from "./tasktext";
import { clipText } from "./redact";
export { APPROVAL_LABEL, LIFECYCLE_LABEL } from "./labels";

export type HostTextMode = TaskTextMode;
export const DEFAULT_HOST_TEXT: HostTextMode = "minimal";

/** The effective level for a host source: the stricter of the server setting (default minimal) and the source's own `task_text`. */
export function hostTextMode(envValue: string | undefined, sourceValue: string | null | undefined): HostTextMode {
  return stricterTaskText(parseTaskText(envValue) ?? DEFAULT_HOST_TEXT, parseTaskText(sourceValue));
}

/** The title stored for a host task. `agent` is a validated identifier, never free text. */
export function hostTaskTitle(title: string, agent: string | undefined, mode: HostTextMode): string {
  if (mode === "full") return title;
  if (mode === "brief") return clipText(title, BRIEF_TITLE_MAX) || "Task";
  return mode === "none" || !agent ? "Task" : `Task for ${agent.slice(0, 32)}`;
}
