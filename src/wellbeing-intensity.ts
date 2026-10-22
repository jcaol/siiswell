/**
 * @file Intensity: long or late days of the operator's OWN input (human_hourly, src/human.ts). PURE: no I/O, no AI.
 *
 * A day (local, the settings' zone) is high-intensity when the operator was active for at least INTENSE_ACTIVE_HOURS hours,
 * or had a late night before it: input in at least LATE_NIGHT_HOURS hours of one night, 23:00 of the previous day through
 * 06:59 of the day (one night, across midnight). Three such days in a row (today included: today
 * counts from its early hours) bring, at 18:00 on the third day, one neutral suggestion to plan a rest day. The weekly
 * reflection lists the high-intensity days of the last 7 with what drove them and 2-3 rule-based suggestions.
 */
import { humanHours, type HumanHourSum } from "./human";
import type { PushMessage } from "./rules";
import { kvSet, localTime, type WbSettings } from "./wellbeing";

export const INTENSE_ACTIVE_HOURS = 18;
export const INTENSE_STREAK_DAYS = 3;
/** The suggestion's local time (hour) on the third day. */
export const INTENSITY_HOUR = 18;
const isLateHour = (h: number) => h >= 23 || h < 7;

/** lateHours: the hours with input of the NIGHT BEFORE the day (23:00 of the previous day and 00:00-06:59 of this one). */
export interface DayLoad { day: string; activeHours: number; lateHours: number; approvals: number; prompts: number }

/** Per local day: hours with operator input, the late hours of the night before it, and the counts. Pure. */
export function dayLoads(hours: readonly HumanHourSum[], s: Pick<WbSettings, "tz">): Map<string, DayLoad> {
  const out = new Map<string, DayLoad>();
  const seen = new Set<number>(); // an hour counts once, however many rows (sources) it has
  for (const h of hours) {
    if (h.prompts + h.approvals <= 0) continue;
    const lt = localTime(h.h, s.tz);
    const d = out.get(lt.day) ?? { day: lt.day, activeHours: 0, lateHours: 0, approvals: 0, prompts: 0 };
    out.set(lt.day, d);
    if (!seen.has(h.h)) {
      seen.add(h.h);
      d.activeHours++;
      if (isLateHour(lt.hour)) {
        // one night: 23:xx belongs with the early hours of the NEXT calendar day (the night before that day)
        const night = lt.hour >= 23 ? new Date(Date.parse(`${lt.day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : lt.day;
        const n = out.get(night) ?? { day: night, activeHours: 0, lateHours: 0, approvals: 0, prompts: 0 };
        n.lateHours++;
        out.set(night, n);
      }
    }
    d.approvals += h.approvals;
    d.prompts += h.prompts;
    out.set(lt.day, d);
  }
  return out;
}

/** The longest run of hours without operator input inside one local day (0-24); 24 for a day without input. Pure. */
export function longestRestHours(hours: readonly HumanHourSum[], day: string, s: Pick<WbSettings, "tz">): number {
  const busy = new Set<number>();
  for (const h of hours) {
    if (h.prompts + h.approvals <= 0) continue;
    const lt = localTime(h.h, s.tz);
    if (lt.day === day) busy.add(lt.hour);
  }
  let best = 0;
  let run = 0;
  for (let hr = 0; hr < 24; hr++) {
    run = busy.has(hr) ? 0 : run + 1;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * The inputs of the serious-case rule (wellbeing-light.ts seriousCase) for the days ending `today`: how many days in a row
 * (back from today, or from yesterday when today has no reading yet) had a red average You stress, the shortest daily rest
 * among them and how many of them had late input. Pure.
 */
export function seriousInputs(dailyYou: ReadonlyMap<string, number>, hours: readonly HumanHourSum[], today: string, red: number, s: Pick<WbSettings, "tz">): { redDaysInARow: number; shortestRestHours: number | null; lateNights: number } {
  const loads = dayLoads(hours, s);
  let d = dailyYou.has(today) ? today : prev(today, 1);
  const days: string[] = [];
  while (days.length < 14 && (dailyYou.get(d) ?? -1) >= red) { days.push(d); d = prev(d, 1); }
  return {
    redDaysInARow: days.length,
    shortestRestHours: days.length ? Math.min(...days.map((x) => longestRestHours(hours, x, s))) : null,
    lateNights: days.filter((x) => isLateNight(loads.get(x))).length,
  };
}

/** A late night: at least this many hours with input in the late window (one prompt at 23:05 is not a late night). */
export const LATE_NIGHT_HOURS = 2;
export const isLateNight = (d: DayLoad | undefined): boolean => !!d && d.lateHours >= LATE_NIGHT_HOURS;
export const isIntense = (d: DayLoad | undefined): boolean => !!d && (d.activeHours >= INTENSE_ACTIVE_HOURS || isLateNight(d));

const prev = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** On the third high-intensity day in a row, from 18:00 local: the days (oldest first); else null. Pure. */
export function intensityStreak(hours: readonly HumanHourSum[], s: Pick<WbSettings, "tz">, now: number): string[] | null {
  const lt = localTime(now, s.tz);
  if (lt.hour < INTENSITY_HOUR) return null;
  const loads = dayLoads(hours, s);
  const days = Array.from({ length: INTENSE_STREAK_DAYS }, (_, i) => prev(lt.day, INTENSE_STREAK_DAYS - 1 - i));
  return days.every((d) => isIntense(loads.get(d))) ? days : null;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const label = (day: string) => `${WD[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${Number(day.slice(8, 10))}`;

export function intensityMessage(days: readonly string[]): { title: string; body: string } {
  return {
    title: "Plan a rest day?",
    body: `${days.map(label).join(", ")} were long or late days. A lighter day or a rest day soon may help; the agents can carry on without you.`,
  };
}

export interface DayDrivers { projects: string[]; apps: string[] }
export interface HighIntensityDay { day: string; label: string; activeHours: number; lateHours: number; projects: string[]; apps: string[] }

/**
 * The weekly reflection's "high-intensity days": each intense day of `days` (oldest first) with its hours and what drove it
 * (the busiest projects and apps of that day, from the usage), plus 2-3 rule-based suggestions. Pure.
 */
export function highIntensityWeek(loads: ReadonlyMap<string, DayLoad>, days: readonly string[], drivers: ReadonlyMap<string, DayDrivers>, s: Pick<WbSettings, "windDown">, approvalsPerDay: number): { days: HighIntensityDay[]; suggestions: string[] } {
  const out: HighIntensityDay[] = [];
  for (const d of days) {
    const l = loads.get(d);
    if (!isIntense(l)) continue;
    const dr = drivers.get(d) ?? { projects: [], apps: [] };
    out.push({ day: d, label: label(d), activeHours: l!.activeHours, lateHours: l!.lateHours, projects: dr.projects.slice(0, 2), apps: dr.apps.slice(0, 2) });
  }
  const suggestions: string[] = [];
  if (!out.length) return { days: out, suggestions };
  const late = out.filter((d) => d.lateHours >= LATE_NIGHT_HOURS).length;
  const long = out.filter((d) => d.activeHours >= INTENSE_ACTIVE_HOURS).length;
  if (late >= 2) suggestions.push(s.windDown ? `Late work on ${late} days: at your wind-down time (${s.windDown}) the agents are told you are away; you can leave them to it.` : `Late work on ${late} days: a wind-down time (Settings) tells the agents you are away at night.`);
  if (long >= 1) suggestions.push(`${long} day${long === 1 ? "" : "s"} of ${INTENSE_ACTIVE_HOURS}+ active hours: batching replies (the approval inbox, every 15 or 30 min) gives longer stretches without interruptions.`);
  if (approvalsPerDay >= 10) suggestions.push(`About ${approvalsPerDay} approvals a day: \`siiswell permissions suggest\` lists the most frequent ones you could allow.`);
  if (suggestions.length < 2) suggestions.push("Plan one lighter day this week; the agents keep working from their task lists.");
  return { days: out, suggestions: suggestions.slice(0, 3) };
}

/** One sentence per high-intensity day for the reflection text. */
export function intensitySentences(w: { days: HighIntensityDay[]; suggestions: string[] }): string[] {
  if (!w.days.length) return [];
  const parts = w.days.map((d) => {
    const what = [d.projects.length ? `mostly ${d.projects.join(" and ")}` : "", d.apps.length ? `in ${d.apps.join(" and ")}` : ""].filter(Boolean).join(" ");
    return `${d.label}: ${d.activeHours} h active${d.lateHours ? `, ${d.lateHours} h late` : ""}${what ? ` (${what})` : ""}`;
  });
  return [`High-intensity days: ${parts.join("; ")}.`, ...w.suggestions];
}

/** The suggestion goes out between 18:00 and this hour (a ticker that was down does not send it at midnight). */
export const INTENSITY_LAST_HOUR = 22;

/**
 * The ticker's step: from 18:00 local, once per day (kv `rt:intense` = the day), when today is the third long / late day in a
 * row, ONE push. D1: nothing outside 18:00-22:00 or once sent; else 1 read (+ 1 write and the push when due).
 */
export async function runIntensityIfDue(db: D1Database, s: WbSettings, sentDay: string, now: number, publicUrl: string, send: (m: PushMessage) => Promise<boolean>): Promise<boolean> {
  const lt = localTime(now, s.tz);
  if (lt.hour < INTENSITY_HOUR || lt.hour >= INTENSITY_LAST_HOUR || sentDay === lt.day) return false;
  const days = intensityStreak(await humanHours(db, now - (INTENSE_STREAK_DAYS + 1) * 86_400_000), s, now);
  await kvSet(db, "rt:intense", lt.day, now).run(); // checked for today, due or not: one read a day
  if (!days) return false;
  const m = intensityMessage(days);
  await send({ ...m, tag: "wb:intensity", renotify: false, url: `${publicUrl.replace(/\/+$/, "")}/` });
  return true;
}
