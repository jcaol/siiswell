/** The wording rule of the well-being layer: calm by default; stronger words only in the serious case. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIGHTS } from "../public/wellbeing-light.js";
import { STATE_LABELS, STRESS_BANDS } from "../public/wellbeing-format.js";
import { dueNudges } from "../src/wellbeing-metrics";
import { intensityMessage, seriousInputs } from "../src/wellbeing-intensity";
import { seriousCase } from "../src/wellbeing-light";
import { morningMessage, operatorStatus, windDownMessage } from "../src/wellbeing-winddown";
import { BANDS } from "../src/wellbeing-stress";
import { WB_DEFAULTS } from "../src/wellbeing";

/** Never in the well-being UI, nudges or pushes. */
const BANNED = /\b(danger|dangerous|warning|critical|alert|alerts|emergency|urgent)\b|!/i;

const pub = (f: string) => readFileSync(join(import.meta.dir, "..", "public", f), "utf8");
/** The string literals a user can read (sentences or capitalised labels; not ids, classes or keys). */
const visible = (src: string) => [...src.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2] ?? "")
  .filter((t) => /\s/.test(t.trim()) || /^[A-Z]/.test(t.trim()))
  .filter((t) => !/^[a-z-]+(\.[a-z-]+)*$/.test(t) && !t.includes("=>") && !/^(svg|path|text|circle|rect|line|polygon)\b/.test(t) && t !== "!==" && !t.startsWith("/api/"));

describe("calm wording", () => {
  test("the page's well-being strings use none of the banned words and no exclamation marks", () => {
    for (const f of ["wellbeing.js", "wellbeing-format.js", "wellbeing-light.js"]) {
      const hits = visible(pub(f)).filter((t) => BANNED.test(t.replace(/!==?/g, "")));
      expect({ f, hits }).toEqual({ f, hits: [] });
    }
  });
  test("labels, lights, nudges and pushes: calm words, each status paired with a gentle action", () => {
    const words = [
      ...STATE_LABELS, ...STRESS_BANDS.map((b: { label: string }) => b.label), ...BANDS.map((b) => b.label),
      ...Object.values(LIGHTS).flatMap((l: { word: string; hint: string }) => [l.word, l.hint]),
    ];
    for (const w of words) expect([w, BANNED.test(w)]).toEqual([w, false]);
    expect(words).not.toContain("Overloaded");
    for (const l of Object.values(LIGHTS) as Array<{ hint: string }>) expect(l.hint.length).toBeGreaterThan(5); // an action / note per light
    const base = { session: { minutes: 200, start: 1 }, quietActiveToday: 2, indicators: [{ name: "burn", value: 4, level: 2 as const, text: "" }], burnTop: "web", today: "2027-07-01", quietNow: true, rapidMinutes: 30, hourKey: "2027-07-01T10", intenseDays: ["a", "b", "c"] };
    const texts = [true, false].flatMap((serious) => dueNudges({ ...base, serious }, ["A week line."], new Map()).flatMap((n) => [n.title, ...n.text]));
    texts.push(...Object.values(intensityMessage(["2027-07-01", "2027-07-02", "2027-07-03"])));
    texts.push(windDownMessage({ running: 2, waiting: 1, done: 0, blocked: 0 }, "07:00", "https://d").body, morningMessage({ running: 1, waiting: 0, done: 2, blocked: 1 }, "https://d").body);
    texts.push(operatorStatus({ ...WB_DEFAULTS, tz: "UTC" }, Date.UTC(2027, 6, 1, 23, 30)).message);
    for (const t of texts) expect([t, BANNED.test(t)]).toEqual([t, false]);
  });
});

describe("escalation: the serious case only", () => {
  const nudge = (serious: boolean) => dueNudges({ session: { minutes: 0, start: null }, quietActiveToday: 0, indicators: [], burnTop: null, today: "2027-07-03", intenseDays: ["2027-07-01", "2027-07-02", "2027-07-03"], serious }, [], new Map())[0]!;
  test("the default intensity nudge is calm; only the serious case says \"Several heavy days in a row\", and still offers an action", () => {
    expect(nudge(false).title).toBe("Plan a rest day?");
    expect(nudge(true).title).toBe("Several heavy days in a row");
    expect(nudge(true).text[0]).toContain("consider a lighter day tomorrow");
  });
  test("serious needs ALL of: red days in a row (from the You daily averages), a rest under 4 h, late nights", () => {
    const tz = { tz: "UTC" };
    const H = 3_600_000;
    const at = (day: string, hh: number) => Date.parse(`${day}T${String(hh).padStart(2, "0")}:00:00Z`);
    // two days with input almost round the clock (longest rest 2 h) including 23:00
    const busy = (day: string) => Array.from({ length: 22 }, (_, i) => ({ h: at(day, i + 2), prompts: 2, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null })).filter((x) => x.h < at(day, 0) + 24 * H);
    const hours = [...busy("2027-07-01"), ...busy("2027-07-02")];
    const red = new Map([["2027-07-01", 80], ["2027-07-02", 85]]);
    const inp = seriousInputs(red, hours, "2027-07-02", 70, tz);
    expect(inp).toEqual({ redDaysInARow: 2, shortestRestHours: 2, lateNights: 2 });
    expect(seriousCase(inp)).toBe(true);
    expect(seriousCase(seriousInputs(new Map([["2027-07-02", 85]]), hours, "2027-07-02", 70, tz))).toBe(false); // one red day
    expect(seriousCase(seriousInputs(red, [], "2027-07-02", 70, tz))).toBe(false); // long rests (no input), no late nights
    // a single prompt at 23:xx is not a late night: with that only, no serious case
    const oneLate = [...busy("2027-07-01").filter((x) => ((h) => h >= 7 && h < 23)(new Date(x.h).getUTCHours())), ...busy("2027-07-02").filter((x) => ((h) => h >= 7 && h < 23)(new Date(x.h).getUTCHours())),
      { h: at("2027-07-01", 23), prompts: 1, approvals: 0, rapid: 0, rapidMin: 0, latN: 0, latP50: null }];
    expect(seriousInputs(red, oneLate, "2027-07-02", 70, tz).lateNights).toBe(0);
    expect(seriousCase(seriousInputs(red, oneLate, "2027-07-02", 70, tz))).toBe(false);
  });
});
