/** Rest cells: weekday + "h" labels, and a day without coverage is "no data" ("–"), never a 24 h rest. */
import { describe, expect, test } from "bun:test";
import { WB_DEFAULTS } from "../src/wellbeing";
import { coverageOf, covered, keptDays, restBlock } from "../src/wellbeing-rest";
import { readiness } from "../src/wellbeing-readiness";
import { gapCell, gapWords, weekdayShort } from "../public/wellbeing-format.js";

const H = 3_600_000;
const s = { ...WB_DEFAULTS, tz: "UTC" };
const hr = (iso: string, prompts = 1) => ({ h: Date.parse(iso), prompts, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null });
const NOW = Date.parse("2027-07-08T09:30:00Z"); // a Thursday morning
const days7 = ["2027-07-01", "2027-07-02", "2027-07-03", "2027-07-04", "2027-07-05", "2027-07-06", "2027-07-07"];

describe("coverage", () => {
  test("first data and the hours with any data (a row without prompts counts; activity too)", () => {
    const c = coverageOf([hr("2027-07-07T10:00:00Z", 0)], new Map([[Date.parse("2027-07-07T08:00:00Z"), 3]]));
    expect(c.first).toBe(Date.parse("2027-07-07T08:00:00Z"));
    expect(covered(c, c.first!, c.first!, c.first! + H)).toBe(true);
    expect(covered(c, c.first! - H, c.first!, c.first! + H)).toBe(false); // before the first data
    expect(covered(coverageOf([]), 0, 0, 1e15)).toBe(false);
  });
});

describe("hooks installed yesterday morning", () => {
  // input from 7 Jul 09:00 on (yesterday) and this morning; nothing earlier exists
  const hours = [hr("2027-07-07T09:00:00Z"), hr("2027-07-07T15:00:00Z"), hr("2027-07-07T22:00:00Z"), hr("2027-07-08T08:00:00Z")];
  test("the days before the first data are no data, not a full rest", () => {
    const r = restBlock(hours, days7, s, NOW);
    for (const g of r.gaps.slice(0, 6)) expect(g).toEqual({ day: g.day, hours: null, light: null, noData: true });
    expect(r.gaps[6]).toMatchObject({ day: "2027-07-07", noData: true }); // its window began 6 Jul 12:00, before the first data
    expect(r.lastGap).toBeNull();
    expect(keptDays(hours, s, NOW)).toMatchObject({ days: 1, endedEarly: 1 }); // only last night is measured; the 6 nights before are not counted
  });
  test("with a week of coverage the same day is measured", () => {
    const week = [...Array.from({ length: 8 }, (_, i) => hr(new Date(Date.parse("2027-06-30T10:00:00Z") + i * 24 * H).toISOString())), ...hours];
    const r = restBlock(week, days7, s, NOW);
    expect(r.gaps.every((g) => !("noData" in g))).toBe(true);
    expect(r.gaps[6]!.hours).toBeGreaterThan(0);
  });
  test("readiness: last night is no data when the data began after 18:00 the evening before", () => {
    const late = [hr("2027-07-08T07:00:00Z"), hr("2027-07-08T08:00:00Z")];
    const r = readiness(late, new Map(), { ...s, morning: "07:00" }, NOW)!;
    expect(r.rest).toEqual({ hours: null, light: null });
    const measured = readiness([hr("2027-07-07T10:00:00Z"), ...late], new Map(), { ...s, morning: "07:00" }, NOW)!;
    expect(measured.rest.hours).not.toBeNull();
  });
  test("a day without any data around it, after the first data, is no data too", () => {
    const gap = [hr("2027-07-01T10:00:00Z"), hr("2027-07-07T10:00:00Z")];
    const r = restBlock(gap, days7, s, NOW);
    expect(r.gaps.find((g) => g.day === "2027-07-04")).toMatchObject({ noData: true, hours: null });
  });
});

describe("the cells' words", () => {
  test("weekday label, hours with h, '–' for no data, '·' while running", () => {
    expect(weekdayShort("2027-07-08")).toBe("Thu");
    expect(gapCell({ hours: 7 })).toBe("7h");
    expect(gapCell({ hours: null, noData: true })).toBe("–");
    expect(gapWords({ hours: null, noData: true })).toBe("no data");
    expect(gapCell({ hours: null })).toBe("·");
  });
});
