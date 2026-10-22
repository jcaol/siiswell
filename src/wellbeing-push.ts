/**
 * @file Well-being reminders as push (settings `wellbeingPush`, default on): the micro-break, pace, after-hours, session
 * and usage nudges, gently worded. At most WB_PUSH_DAILY_CAP a day in total and each at most once a day; never in Focus or an
 * agent-free block; outside the quiet hours only, except the after-hours one, which is sent once when late activity
 * begins. "Not today" / "Never" on the page suppress the push too. Checked at the ticker's stress minute (every 15 min):
 * one read of the inputs, one of the bookkeeping, and only when something is due. Zero AI.
 * @module dashboard-worker/wellbeing-push
 */
import { all } from "./db";
import type { PushMessage } from "./rules";
import { isQuiet, kvSet, localTime, type WbState } from "./wellbeing";
import { STRESS_TICK_MINUTE, activityOf, humanRowsOf, indicatorsFromRow, readStressInputs, stressTickMinute } from "./wellbeing-metrics";
import { blockAt } from "./wellbeing-winddown";
import { PACE_NUDGE_MINUTES, rapidMinutes, youIndicators } from "./wellbeing-you";
import { sumHours } from "./human";

export const WB_PUSH_DAILY_CAP = 4;
const HOUR = 3_600_000;

export interface WbPushCandidate { id: "microbreak" | "pace" | "late" | "session" | "burn"; title: string; body: string }

/** The reminders due now, in order (the first one goes out). Pure. */
export function wbPushCandidates(x: { burn: number | null; rapidMin: number; youSessionMin: number; microBreakMin: number; quiet: boolean; activeThisHour: boolean }): WbPushCandidate[] {
  const out: WbPushCandidate[] = [];
  if (x.quiet) {
    // the quiet hours: only the after-hours note, once, when late activity begins
    if (x.activeThisHour) out.push({ id: "late", title: "It is your quiet time", body: "The agents can keep working on their own; the morning summary will tell you what happened." });
    return out;
  }
  if (x.youSessionMin >= x.microBreakMin) out.push({ id: "microbreak", title: "Worth a break", body: "You've been at it a while — a five-minute break now? The agents keep going." });
  if (x.rapidMin >= PACE_NUDGE_MINUTES) out.push({ id: "pace", title: "Your pace", body: "Agents can wait — batch your replies every 10 min?" });
  // the operator's own session (input or the operator apps), never the agents': they run for hours with nobody there
  if (x.youSessionMin >= 180) out.push({ id: "session", title: "A pause?", body: `You've been at it for about ${Math.floor(x.youSessionMin / 60)} hours. The agents can carry on for ten minutes without you.` });
  if (x.burn !== null && x.burn >= 3) out.push({ id: "burn", title: "Usage today", body: `Today's usage is about ${Math.round(x.burn)}x your usual for this time of day.` });
  return out;
}

/** The push of one reminder, quiet (no renotify), tagged per reminder. */
const message = (c: WbPushCandidate, url: string): PushMessage => ({ title: c.title, body: c.body, tag: `wb:${c.id}`, renotify: false, url: `${url.replace(/\/+$/, "")}/` });

/** The ticker's step (see the file comment). Returns the reminder sent, or null. Never throws. */
export async function runWellbeingPushes(db: D1Database, st: WbState, now: number, publicUrl: string, send: (m: PushMessage) => Promise<boolean>): Promise<string | null> {
  try {
    const s = st.settings;
    if (!s.wellbeingPush || stressTickMinute(now) !== STRESS_TICK_MINUTE) return null;
    if (now < st.focusUntil || blockAt(s, now).in) return null;
    const row = await readStressInputs(db, s, now);
    if (!row) return null;
    const ind = indicatorsFromRow(row, s, now);
    const hours = sumHours(humanRowsOf(row));
    const activity = activityOf(row, s.tz);
    const cur = Math.floor(now / HOUR) * HOUR;
    const youSession = youIndicators(hours, now, s, activity, true)?.find((i) => i.name === "session")?.value ?? 0;
    const cands = wbPushCandidates({
      burn: ind.find((i) => i.name === "burn")?.value ?? null,
      rapidMin: rapidMinutes(hours, now),
      youSessionMin: youSession, // 0 without any You data: no session push
      microBreakMin: s.microBreakMin,
      quiet: isQuiet(now, s),
      activeThisHour: hours.some((h) => h.h === cur && h.prompts + h.approvals > 0) || (activity.get(cur) ?? 0) > 0,
    });
    if (!cands.length) return null;
    const rows = await all<{ k: string; v: string }>(db, "SELECT k, v FROM wb_settings WHERE k = 'rt:wbpush' OR (k >= 'nudge:' AND k < 'nudge;') LIMIT 20");
    const kv = new Map(rows.map((r) => [r.k, r.v]));
    const today = localTime(now, s.tz).day;
    let book: { day: string; n: number; sent: string[] } = { day: today, n: 0, sent: [] };
    try {
      const b = JSON.parse(kv.get("rt:wbpush") ?? "null") as typeof book | null;
      if (b && b.day === today && typeof b.n === "number" && Array.isArray(b.sent)) book = b;
    } catch { /* a new day */ }
    if (book.n >= WB_PUSH_DAILY_CAP) return null;
    const pick = cands.find((c) => {
      if (book.sent.includes(c.id)) return false; // each at most once a day
      try {
        const d = JSON.parse(kv.get(`nudge:${c.id === "microbreak" ? "microbreak" : c.id}`) ?? "null") as { never?: boolean; day?: string } | null;
        if (d?.never || d?.day === today) return false; // "Never" / "Not today" on the page
      } catch { /* none */ }
      return true;
    });
    if (!pick) return null;
    await kvSet(db, "rt:wbpush", JSON.stringify({ day: today, n: book.n + 1, sent: [...book.sent, pick.id] }), now).run(); // claimed first
    await send(message(pick, publicUrl));
    return pick.id;
  } catch (err) {
    console.error("well-being push failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
