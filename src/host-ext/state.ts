/** @file Optional advanced host integration: which reported threads are still active (shown in the state). */
import type { DiscussionSnapshot } from "./types";

/** A thread in one of these states is over: only the others are "active". */
const CLOSED = new Set(["completed", "timeout", "consensus", "ended", "closed", "done", "failed", "cancelled", "canceled"]);

/** The active threads of one stored snapshot, at most `max`, tagged with their host and project. */
export function activeDiscussions(list: DiscussionSnapshot[] | undefined, host: string, project: string, max: number): Array<DiscussionSnapshot & { host: string; project: string }> {
  return (list ?? [])
    .filter((d) => !CLOSED.has(String(d.status).toLowerCase()))
    .slice(0, max)
    .map((d) => ({ host, project, ...d }));
}
