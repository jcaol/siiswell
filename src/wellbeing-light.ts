/**
 * @file The stress traffic light on the server: the two thresholds (Settings `lightYellow` / `lightRed`, default 40 / 70)
 * and their validation, the light of a level, and the "serious case" rule that alone allows stronger wording. The page's twin
 * is public/wellbeing-light.js (the colours and words). Pure.
 */
export const LIGHT_DEFAULTS = Object.freeze({ yellow: 40, red: 70 });
export type Light = "green" | "yellow" | "red";

/** Validate a pair (either may be absent: the other comes from `base`). */
export function validateLight(raw: { lightYellow?: unknown; lightRed?: unknown }, base: { lightYellow: number; lightRed: number }): { ok: true; yellow: number; red: number } | { ok: false; error: string } {
  const y = raw.lightYellow === undefined ? base.lightYellow : raw.lightYellow;
  const r = raw.lightRed === undefined ? base.lightRed : raw.lightRed;
  const okNum = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 99;
  if (!okNum(y) || !okNum(r)) return { ok: false, error: "lightYellow and lightRed must be whole numbers 1-99" };
  if (y >= r) return { ok: false, error: "lightYellow must be below lightRed" };
  return { ok: true, yellow: y, red: r };
}

export function lightOf(level: number, t: { yellow: number; red: number }): Light {
  const v = Math.round(level);
  return v >= t.red ? "red" : v >= t.yellow ? "yellow" : "green";
}

/**
 * The ONLY case that allows stronger (still supportive) wording: red on several days in a row (>= 2) AND a very short rest
 * (< 4 h) AND late nights. Everything else keeps the calm default tone.
 */
export function seriousCase(x: { redDaysInARow: number; shortestRestHours: number | null; lateNights: number }): boolean {
  return x.redDaysInARow >= 2 && x.shortestRestHours !== null && x.shortestRestHours < 4 && x.lateNights >= 2;
}
