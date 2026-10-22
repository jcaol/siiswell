/**
 * @file Energy battery (0-100): an ESTIMATE of how much is left in the tank, from the operator's own input (human_hourly) and
 * the context switches of the agents' usage. Not a physiological measure. PURE: no I/O, no AI.
 *
 * Hour by hour over the last 48 hours, starting at ENERGY_START:
 *  - an hour without operator input charges: +ENERGY_REST (a gap of an hour or more is >= 45 min of rest), +ENERGY_NIGHT
 *    inside the quiet hours (night rest);
 *  - an hour with input drains: ENERGY_BASE + up to 8 for the number of prompts / approvals (1 per 8) + up to 4 for the
 *    context switches of that hour + ENERGY_LATE inside the quiet hours (after-hours);
 *  - the current hour counts pro rata; the level stays within 0-100.
 */
import type { HumanHourSum } from "./human";
import { isQuietAt, localTime, type WbSettings } from "./wellbeing";

const HOUR = 3_600_000;
export const ENERGY_START = 60;
export const ENERGY_REST = 6;
export const ENERGY_NIGHT = 12;
export const ENERGY_BASE = 3;
export const ENERGY_LATE = 3;
export const ENERGY_HOURS = 48;

export interface EnergyPoint { h: number; level: number; kind: "charge" | "drain" }

/** The battery at `now` and its hourly curve (the last ENERGY_HOURS hours, oldest first). */
export function energy(hours: readonly HumanHourSum[], switches: ReadonlyMap<number, number>, s: Pick<WbSettings, "tz" | "quietStart" | "quietEnd" | "weekendsQuiet">, now: number): { level: number; series: EnergyPoint[] } {
  const by = new Map(hours.map((h) => [h.h, h]));
  const cur = Math.floor(now / HOUR) * HOUR;
  let level = ENERGY_START;
  const series: EnergyPoint[] = [];
  for (let h = cur - (ENERGY_HOURS - 1) * HOUR; h <= cur; h += HOUR) {
    const frac = h === cur ? (now - cur) / HOUR : 1;
    const x = by.get(h);
    const n = x ? x.prompts + x.approvals : 0;
    const lt = localTime(h, s.tz);
    const quiet = isQuietAt({ hour: lt.hour, minute: 0, weekday: lt.weekday }, s);
    let delta: number;
    if (n <= 0) delta = (quiet ? ENERGY_NIGHT : ENERGY_REST) * frac;
    else delta = -(ENERGY_BASE + Math.min(8, n / 8) + Math.min(4, switches.get(h) ?? 0) + (quiet ? ENERGY_LATE : 0)) * frac;
    level = Math.max(0, Math.min(100, level + delta));
    series.push({ h, level: Math.round(level), kind: n > 0 ? "drain" : "charge" });
  }
  return { level: Math.round(level), series };
}

/** Today's local hours with the battery level at the end of each (null for hours not reached yet). */
export function energyDay(series: readonly EnergyPoint[], s: Pick<WbSettings, "tz">, now: number): Array<{ hour: number; level: number | null; kind: "charge" | "drain" | null }> {
  const today = localTime(now, s.tz).day;
  const out: Array<{ hour: number; level: number | null; kind: "charge" | "drain" | null }> = Array.from({ length: 24 }, (_, hour) => ({ hour, level: null, kind: null }));
  for (const p of series) {
    const lt = localTime(p.h, s.tz);
    if (lt.day === today) out[lt.hour] = { hour: lt.hour, level: p.level, kind: p.kind };
  }
  return out;
}
