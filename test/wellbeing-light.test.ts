/** The stress traffic light (user thresholds, default 40 / 70) and its one-module mapping. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIGHTS, LIGHT_DEFAULTS, lightGradientStops, lightLegend, lightOf, lightScale, lightView, sustainedRed, thresholdsOf } from "../public/wellbeing-light.js";
import { WB_DEFAULTS, parseStoredSettings, validateSettings } from "../src/wellbeing";
import { lightOf as serverLight, seriousCase } from "../src/wellbeing-light";

describe("the traffic light", () => {
  test("defaults 40 / 70: green < 40, yellow 40-69, red >= 70 (on the rounded level shown); the server agrees", () => {
    expect(LIGHT_DEFAULTS).toEqual({ yellow: 40, red: 70 });
    expect([0, 39, 39.4, 39.5, 40, 69, 69.5, 70, 100].map((v) => lightOf(v)!.key)).toEqual(["green", "green", "green", "yellow", "yellow", "yellow", "red", "red", "red"]);
    for (const v of [0, 39.5, 69.4, 70, 100]) expect(serverLight(v, LIGHT_DEFAULTS)).toBe(lightOf(v)!.key);
    expect(lightOf(null)).toBeNull();
  });
  test("the user's thresholds move every boundary; words are never colour alone", () => {
    const t = thresholdsOf({ lightYellow: 30, lightRed: 50 });
    expect([29, 30, 49, 50].map((v) => lightOf(v, t)!.key)).toEqual(["green", "yellow", "yellow", "red"]);
    expect(lightScale(t).map((x) => [x.key, x.min, x.max])).toEqual([["green", 0, 30], ["yellow", 30, 50], ["red", 50, 100]]);
    expect(lightGradientStops(t).map((x) => x.offset)).toEqual([0, 30, 30, 50, 50, 100]);
    expect([LIGHTS.green.word, LIGHTS.yellow.word, LIGHTS.red.word]).toEqual(["OK", "Watch", "Rest"]);
    expect(lightLegend(t)).toBe("OK < 30 · Watch 30–49 · Rest ≥ 50");
    expect(thresholdsOf({ lightYellow: 70, lightRed: 40 })).toEqual(LIGHT_DEFAULTS); // invalid -> defaults
  });
  test("red is rare: a single red reading = amber text + red dot; red text and the border only when sustained", () => {
    expect(lightView(75, LIGHT_DEFAULTS, false)).toMatchObject({ dot: "over", text: "strained", border: false });
    expect(lightView(75, LIGHT_DEFAULTS, true)).toMatchObject({ dot: "over", text: "over", border: true });
    expect(lightView(50, LIGHT_DEFAULTS, true)).toMatchObject({ dot: "strained", text: "strained", border: false });
    expect(sustainedRed([20, 72, 75], [], LIGHT_DEFAULTS)).toBe(true); // two hours in a row
    expect(sustainedRed([72, 20, 75], [], LIGHT_DEFAULTS)).toBe(false);
    expect(sustainedRed([], [71, 30, 80], LIGHT_DEFAULTS)).toBe(true); // two red days
    expect(sustainedRed([75], [75], LIGHT_DEFAULTS)).toBe(false);
  });
  test("settings: two whole numbers 1-99, yellow below red; stored as a pair", () => {
    expect([WB_DEFAULTS.lightYellow, WB_DEFAULTS.lightRed]).toEqual([40, 70]);
    expect(validateSettings({ lightYellow: 30, lightRed: 60 }).ok).toBe(true);
    expect(validateSettings({ lightYellow: 75 }).ok).toBe(false); // above the default red
    expect(validateSettings({ lightYellow: 60, lightRed: 60 }).ok).toBe(false);
    expect(validateSettings({ lightYellow: 0, lightRed: 50 }).ok).toBe(false);
    expect(validateSettings({ lightRed: 100 }).ok).toBe(false);
    expect(validateSettings({ lightYellow: 2.5, lightRed: 50 }).ok).toBe(false);
    expect(parseStoredSettings(JSON.stringify({ lightYellow: 75, lightRed: 90 }))).toMatchObject({ lightYellow: 75, lightRed: 90 });
    expect(parseStoredSettings(JSON.stringify({ lightYellow: 75, lightRed: 60 }))).toMatchObject({ lightYellow: 40, lightRed: 70 });
  });
  test("one module: the page maps colours only through public/wellbeing-light.js", () => {
    const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
    expect(js).toContain('from "/wellbeing-light.js"');
    expect(js).not.toMatch(/BAND_TONE|bandGradientStops/);
    for (const use of ["lightScale(t)", "lightView(st.level, t, sustained)", "lightOf(norm.get(name), t)", "wb-ldot", "lightGradientStops(lt)", "lightOf(c.stress, lt)"]) expect(js).toContain(use);
  });
  test("serious case only: red several days AND very short rest AND late nights", () => {
    expect(seriousCase({ redDaysInARow: 2, shortestRestHours: 3.5, lateNights: 2 })).toBe(true);
    expect(seriousCase({ redDaysInARow: 1, shortestRestHours: 3, lateNights: 3 })).toBe(false);
    expect(seriousCase({ redDaysInARow: 3, shortestRestHours: 5, lateNights: 3 })).toBe(false);
    expect(seriousCase({ redDaysInARow: 3, shortestRestHours: 2, lateNights: 1 })).toBe(false);
    expect(seriousCase({ redDaysInARow: 3, shortestRestHours: null, lateNights: 3 })).toBe(false);
  });
});
