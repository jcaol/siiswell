// The stress traffic light: the ONE place that maps a stress level (0-100) to green / yellow / red with the user's two
// thresholds (Settings; default 40 / 70), and the words and tones that go with it. Every chart of the You card uses it.
// Pure (no DOM). The server's twin for the thresholds' validation is src/wellbeing-light.ts.
//
// Wording rule: the default tone is calm. A single red reading shows as amber TEXT with a red DOT only; the full red
// treatment (red text, the card border) is for sustained red (two hours in a row, or red on two days).

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const LIGHT_DEFAULTS = Object.freeze({ yellow: 40, red: 70 });

/** Colour is never alone: every light has its word (screen readers, colour-blind users). One word, not "Green · OK". */
export const LIGHTS = Object.freeze({
  green: { key: "green", tone: "calm", word: "OK", band: "relaxed", hint: "A steady pace." },
  yellow: { key: "yellow", tone: "strained", word: "Watch", band: "strained", hint: "Busy day: worth a short break when you can." },
  red: { key: "red", tone: "over", word: "Rest", band: "overloaded", hint: "You've been at it a while: a lighter hour would help." },
});

/** The thresholds in effect (the settings', when valid; else the defaults). */
export function thresholdsOf(settings) {
  const y = settings && settings.lightYellow;
  const r = settings && settings.lightRed;
  return isNum(y) && isNum(r) && y >= 1 && r <= 99 && y < r ? { yellow: y, red: r } : { ...LIGHT_DEFAULTS };
}

/** The light of a level (rounded as shown), or null without one. */
export function lightOf(level, t = LIGHT_DEFAULTS) {
  if (!isNum(level)) return null;
  const v = Math.round(level);
  return v >= t.red ? LIGHTS.red : v >= t.yellow ? LIGHTS.yellow : LIGHTS.green;
}

/** The gauge's scale segments (0..yellow, yellow..red, red..100). */
export function lightScale(t = LIGHT_DEFAULTS) {
  return [["green", 0, t.yellow], ["yellow", t.yellow, t.red], ["red", t.red, 100]].map(([k, min, max]) => ({ key: k, tone: LIGHTS[k].tone, min, max }));
}

/** Hard gradient stops at the thresholds (the trend chart's line / area take the light of their height). */
export function lightGradientStops(t = LIGHT_DEFAULTS) {
  return lightScale(t).flatMap((x) => [{ tone: x.tone, offset: x.min }, { tone: x.tone, offset: x.max }]);
}

/**
 * Sustained red: the last two hourly readings both red (two hours), or the daily averages of two of the last days red.
 * `hourly` / `daily`: numbers or null, oldest first.
 */
export function sustainedRed(hourly, daily, t = LIGHT_DEFAULTS) {
  const h = (Array.isArray(hourly) ? hourly : []).filter(isNum);
  const lastTwo = h.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((v) => Math.round(v) >= t.red)) return true;
  const days = (Array.isArray(daily) ? daily : []).filter(isNum);
  return days.filter((v) => Math.round(v) >= t.red).length >= 2;
}

/**
 * How to show a level: the dot's tone always follows the light; the TEXT is amber for a single red reading and red only
 * when red is sustained, which also gets the card border.
 */
export function lightView(level, t = LIGHT_DEFAULTS, sustained = false) {
  const light = lightOf(level, t);
  if (!light) return { light: null, dot: "none", text: "none", border: false };
  const red = light.key === "red";
  return { light, dot: light.tone, text: red && !sustained ? LIGHTS.yellow.tone : light.tone, border: red && sustained };
}

/** The legend line: "OK < 40 · Watch 40–69 · Rest ≥ 70" (one word per light: the dot already carries the colour). */
export const lightLegend = (t = LIGHT_DEFAULTS) => `OK < ${t.yellow} · Watch ${t.yellow}–${t.red - 1} · Rest ≥ ${t.red}`;

/** The energy battery's light: green at or above `energyGreen`, yellow from `energyYellow`, red below (defaults 50 / 25). */
export function energyLight(level, settings) {
  if (!isNum(level)) return null;
  const g = isNum(settings && settings.energyGreen) ? settings.energyGreen : 50;
  const y = isNum(settings && settings.energyYellow) ? settings.energyYellow : 25;
  const v = Math.round(level);
  return v >= g ? LIGHTS.green : v >= y ? LIGHTS.yellow : LIGHTS.red;
}
