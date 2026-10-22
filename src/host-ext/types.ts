/**
 * @file Optional advanced host integration: the snapshot fields only a host integration sends (a reporter process that
 * runs next to the agents and pushes snapshots). Desktop clients (MCP, CLI hooks) never send them; every UI section fed by
 * them stays hidden without data. Types only, no imports: `src/shared/schema.ts` re-exports them.
 */

/** A multi-agent thread a host reports (a conversation several agents take turns in). */
export interface DiscussionSnapshot {
  id: string;
  topic: string;
  status: string;
  /** turns taken / allowed */
  round: number;
  maxRounds: number;
  messages: number;
  maxMessages: number;
  participants: string[];
  /** participants the host has put on hold in this thread */
  benched: string[];
  lastSpeaker?: string;
  updatedAt: number;
}

/** The host's reporter process (field name `poller` on the wire). */
export interface PollerSnapshot {
  /** e.g. "running" */
  status: string;
  /** the reporter's version */
  binaryVersion: string;
  /** epoch ms of its last check */
  lastPoll?: number;
  startedAt?: number;
  /** the reporter runs a binary that has since been replaced on disk */
  exeStale?: boolean;
}
