/**
 * @file Optional advanced host integration: validation of the host-only snapshot fields (threads, the reporter
 * process). The generic helpers come from ingest.ts, so the rules (identifiers, clipping, timestamps) are the same.
 */
import { MAX_TITLE } from "../shared/schema";
import type { DiscussionSnapshot, PollerSnapshot } from "./types";

/** The ingest helpers these sanitisers use (passed in by ingest.ts). */
export interface IngestHelpers<Issues> {
  isObj: (v: unknown) => v is Record<string, unknown>;
  ident: (v: unknown, re: RegExp, field: string) => string;
  idRe: RegExp;
  clipText: (v: string | undefined, max: number) => string;
  num: (v: unknown) => number | undefined;
  ts: (v: unknown, now: number) => number | undefined;
  agentNames: (v: unknown, field: string, issues: Issues) => string[];
  optAgent: (issues: Issues, v: unknown, field: string) => string | undefined;
  drop: <T extends object>(o: T) => T;
}

export function sanitizeDiscussion<I>(raw: unknown, now: number, issues: I, h: IngestHelpers<I>): DiscussionSnapshot | null {
  if (!h.isObj(raw)) return null;
  return h.drop({
    id: h.ident(raw.id, h.idRe, "id"),
    topic: h.clipText(typeof raw.topic === "string" ? raw.topic : "", MAX_TITLE),
    status: h.clipText(typeof raw.status === "string" ? raw.status : "", 24),
    round: Math.max(0, h.num(raw.round) ?? 0),
    maxRounds: Math.max(0, h.num(raw.maxRounds) ?? 0),
    messages: Math.max(0, h.num(raw.messages) ?? 0),
    maxMessages: Math.max(0, h.num(raw.maxMessages) ?? 0),
    participants: h.agentNames(raw.participants, "participants", issues),
    benched: h.agentNames(raw.benched, "benched", issues),
    lastSpeaker: h.optAgent(issues, raw.lastSpeaker, "lastSpeaker"),
    updatedAt: h.ts(raw.updatedAt, now) ?? now,
  });
}

export function sanitizePoller<I>(p: Record<string, unknown>, now: number, h: IngestHelpers<I>): PollerSnapshot {
  return h.drop({
    status: h.clipText(typeof p.status === "string" ? p.status : "", 40),
    binaryVersion: h.clipText(typeof p.binaryVersion === "string" ? p.binaryVersion : "", 40),
    lastPoll: h.ts(p.lastPoll, now),
    startedAt: h.ts(p.startedAt, now),
    exeStale: typeof p.exeStale === "boolean" ? p.exeStale : undefined,
  });
}
