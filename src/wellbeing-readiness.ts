/**
 * @file Morning Readiness: from the user's morning time until noon (local), one card with last night's rest, yesterday's load
 * (the You stress average and active hours), the 7-day after-hours ratio and ONE doable suggestion. Every number comes with
 * an action. PURE: no I/O, no AI.
 */
import type { HumanHourSum } from "./human";
import { localMinuteStart, localTime, type WbSettings } from "./wellbeing";
import { dayLoads } from "./wellbeing-intensity";
import { lightOf } from "./wellbeing-light";
import { localHourStart } from "./wellbeing-metrics";
import { afterHoursRatio, coverageOf, covered, lightAbove, lightBelow, type Coverage, type Light } from "./wellbeing-rest";

const POINTS: Record<Light, number> = { green: 0, yellow: 1, red: 2 };
const prevDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Last night's rest: the longest run of hours without input from 18:00 (local) of `evening` up to now. */
export function lastNightRest(hours: readonly HumanHourSum[], evening: string, s: Pick<WbSettings, "tz">, now: number): number {
  const busy = new Set(hours.filter((h) => h.prompts + h.approvals > 0).map((h) => h.h));
  let best = 0;
  let run = 0;
  for (let h = localHourStart(evening, 18, s.tz); h + 3_600_000 <= now; h += 3_600_000) {
    run = busy.has(h) ? 0 : run + 1;
    best = Math.max(best, run);
  }
  return best;
}

export interface Readiness {
  label: "Ready" | "Take it steady" | "Go easy today";
  rest: { hours: number | null; light: Light | null };
  yesterday: { stress: number | null; activeHours: number; light: Light | null };
  afterHours: { pct: number | null; light: Light | null };
  suggestion: string;
}

/** The card while it is due (morning time .. 12:00 local), else null. `youDaily` = the You daily average stress per day. */
export function readiness(hours: readonly HumanHourSum[], youDaily: ReadonlyMap<string, number>, s: WbSettings & { maxProjects?: number }, now: number, cov: Coverage = coverageOf(hours)): Readiness | null {
  const lt = localTime(now, s.tz);
  const from = localMinuteStart(lt.day, Number(s.morning.slice(0, 2)), Number(s.morning.slice(3, 5)), s.tz);
  if (now < from || lt.hour >= 12 || !hours.length) return null;
  // last night is measured only when the data began by 18:00 yesterday and some lies around it (else: no data, not a full rest)
  const evening = localHourStart(prevDay(lt.day), 18, s.tz);
  const restH = covered(cov, evening, evening - 12 * 3_600_000, now + 1) ? lastNightRest(hours, prevDay(lt.day), s, now) : null;
  const rest = { hours: restH, light: lightBelow(restH, s.restYellow, s.restRed) };
  const yd = prevDay(lt.day);
  const ys = youDaily.get(yd) ?? null;
  const yesterday = { stress: ys, activeHours: dayLoads(hours, s).get(yd)?.activeHours ?? 0, light: ys === null ? null : lightOf(ys, { yellow: s.lightYellow, red: s.lightRed }) };
  const ah = afterHoursRatio(hours, s, now);
  const afterHours = { pct: ah.pct, light: lightAbove(ah.pct, s.afterHoursYellow, s.afterHoursRed) };
  const score = POINTS[rest.light ?? "green"] + POINTS[yesterday.light ?? "green"] + POINTS[afterHours.light ?? "green"];
  const label = score <= 1 ? "Ready" : score <= 3 ? "Take it steady" : "Go easy today";
  // ONE suggestion: for the factor that needs it most (rest, then yesterday's load, then late hours)
  const max = s.maxProjects ?? 3;
  let suggestion = "Keep to your plan; your summaries will tell you what the agents did.";
  if (rest.light === "red" || rest.light === "yellow") suggestion = "Short rest last night: keep today shorter and let the agents run on their own between check-ins.";
  else if (yesterday.light === "red" || yesterday.light === "yellow") suggestion = `Busy day yesterday: keep to ${max} projects or fewer today.`;
  else if (afterHours.light === "red" || afterHours.light === "yellow") suggestion = "Late hours this week: set today's wind-down time and stop there.";
  return { label, rest, yesterday, afterHours, suggestion };
}
