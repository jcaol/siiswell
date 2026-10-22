/** Human load step 4: the intensity streak and the weekly "high-intensity days". */
import { afterEach, describe, expect, test } from "bun:test";
import { configureDashboardTz } from "../src/tz";
import { route } from "../src/index";
import { WB_DEFAULTS } from "../src/wellbeing";
import { INTENSE_ACTIVE_HOURS, dayLoads, highIntensityWeek, intensitySentences, intensityStreak, isIntense, runIntensityIfDue } from "../src/wellbeing-intensity";
import { makeCtx, makeEnv, request } from "./d1-shim";

afterEach(() => {
  configureDashboardTz({}); // reset
});

const H = 3_600_000;
const s = { ...WB_DEFAULTS, tz: "Europe/London" };
// BST: local hh:00 on day d = UTC (hh - 1)
const local = (day: string, hh: number) => Date.parse(`${day}T${String(hh).padStart(2, "0")}:00:00+01:00`);
const hr = (day: string, hh: number, n = 3) => ({ h: local(day, hh), prompts: n, approvals: 1, rapid: 0, rapidMin: 0, latN: 0, latP50: null });

describe("intensity (pure)", () => {
  test("a day is high-intensity with 18+ active hours, or a late night before it (2+ hours of ONE night 23:00-06:59, local)", () => {
    const loads = dayLoads([hr("2027-07-01", 9), hr("2027-07-01", 10), hr("2027-07-01", 23), hr("2027-07-02", 0), hr("2027-07-03", 2), hr("2027-07-03", 3), hr("2027-07-08", 23), { ...hr("2027-07-04", 9), prompts: 0, approvals: 0 }], s);
    expect(loads.get("2027-07-01")).toEqual({ day: "2027-07-01", activeHours: 3, lateHours: 0, approvals: 3, prompts: 9 }); // its 23:00 counts for the night before 2 Jul
    expect([isIntense(loads.get("2027-07-01")), isIntense(loads.get("2027-07-02")), isIntense(loads.get("2027-07-03")), isIntense(loads.get("2027-07-04"))]).toEqual([false, true, true, false]);
    expect(isIntense(loads.get("2027-07-09"))).toBe(false); // one prompt at 23:xx (8 Jul) is not a late night
    expect(loads.get("2027-07-02")!.lateHours).toBe(2); // 1 Jul 23:00 + 2 Jul 00:00 = one night, the night before 2 Jul
    // 23:00 and 02:00 of the SAME calendar day are two different nights: neither is a late night
    const split = dayLoads([hr("2027-07-10", 2), hr("2027-07-10", 23)], s);
    expect([split.get("2027-07-10")!.lateHours, split.get("2027-07-11")!.lateHours, isIntense(split.get("2027-07-10")), isIntense(split.get("2027-07-11"))]).toEqual([1, 1, false, false]);
    // 18 distinct daytime hours (05:00-22:59 has none in the late window but 05 and 06): 07:00-22:59 is 16 hours, not enough
    expect(isIntense(dayLoads(Array.from({ length: 16 }, (_, i) => hr("2027-07-05", 7 + i)), s).get("2027-07-05"))).toBe(false);
    // the same hour from two machines counts once
    expect(dayLoads([hr("2027-07-06", 9), hr("2027-07-06", 9)], s).get("2027-07-06")!.activeHours).toBe(1);
    // 18 hours, 07:00 to 00:59 the next day would be late; 18 daytime hours need 05:00 (late) - so 18+ hours always pass
    const eighteen = dayLoads(Array.from({ length: 18 }, (_, i) => hr("2027-07-07", 5 + i)), s).get("2027-07-07")!;
    expect([eighteen.activeHours, isIntense(eighteen)]).toEqual([18, true]);
  });

  test("the streak: three intense days in a row, today included, only from 18:00 local", () => {
    const hours = [hr("2027-06-30", 23), hr("2027-07-01", 0), hr("2027-07-02", 1), hr("2027-07-02", 2), hr("2027-07-03", 0), hr("2027-07-03", 1)];
    expect(intensityStreak(hours, s, local("2027-07-03", 17))).toBeNull();
    expect(intensityStreak(hours, s, local("2027-07-03", 18))).toEqual(["2027-07-01", "2027-07-02", "2027-07-03"]);
    expect(intensityStreak(hours.slice(1), s, local("2027-07-03", 18))).toBeNull();
  });

  test("the weekly section: each intense day with hours and drivers; 2-3 rule-based suggestions", () => {
    const loads = dayLoads([hr("2027-06-30", 23), hr("2027-07-01", 0), hr("2027-07-02", 2), hr("2027-07-02", 3), hr("2027-07-02", 10), hr("2027-07-03", 10)], s);
    const drivers = new Map([["2027-07-01", { projects: ["web", "api", "x"], apps: ["claude-cli"] }]]);
    const w = highIntensityWeek(loads, ["2027-07-01", "2027-07-02", "2027-07-03"], drivers, { windDown: "23:00" }, 12);
    expect(w.days.map((d) => [d.day, d.activeHours, d.lateHours, d.projects])).toEqual([["2027-07-01", 1, 2, ["web", "api"]], ["2027-07-02", 3, 2, []]]);
    expect(w.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(w.suggestions.length).toBeLessThanOrEqual(3);
    expect(w.suggestions.join(" ")).toContain("permissions suggest");
    expect(intensitySentences(w)[0]).toBe("High-intensity days: Thu 1: 1 h active, 2 h late (mostly web and api in claude-cli); Fri 2: 3 h active, 2 h late.");
    expect(highIntensityWeek(new Map(), ["2027-07-01"], new Map(), { windDown: "" }, 0)).toEqual({ days: [], suggestions: [] });
    expect(INTENSE_ACTIVE_HOURS).toBe(18);
  });
});

describe("intensity (the ticker and the page)", () => {
  const seed = (t: ReturnType<typeof makeEnv>) => {
    const ins = t.db.sqlite.query("INSERT INTO human_hourly (source_id, hour, prompts, approvals, rapid, rapid_min, lat_n, lat_p50_ms, updated) VALUES ('s', ?, 3, 1, 0, 0, 0, NULL, 1)");
    for (const [d, hh] of [["2027-06-30", 23], ["2027-07-01", 0], ["2027-07-02", 1], ["2027-07-02", 2], ["2027-07-03", 0], ["2027-07-03", 1], ["2027-07-03", 10]] as const) ins.run(local(d, hh));
  };
  test("one push at 18:00 on the third day; once a day; not before 18:00 or after 22:00", async () => {
    const t = makeEnv();
    seed(t);
    const sent: Array<{ title: string; body: string }> = [];
    const send = async (m: { title: string; body: string }) => { sent.push(m); return true; };
    const sentDay = () => (t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'rt:intense'")[0]?.v ?? "");
    expect(await runIntensityIfDue(t.env.DB, s, sentDay(), local("2027-07-03", 17), "https://d.example", send)).toBe(false);
    expect(await runIntensityIfDue(t.env.DB, s, sentDay(), local("2027-07-03", 18) + 60_000, "https://d.example", send)).toBe(true);
    expect(await runIntensityIfDue(t.env.DB, s, sentDay(), local("2027-07-03", 19), "https://d.example", send)).toBe(false);
    expect(sent).toEqual([{ title: "Plan a rest day?", body: "Thu 1, Fri 2, Sat 3 were long or late days. A lighter day or a rest day soon may help; the agents can carry on without you.", tag: "wb:intensity", renotify: false, url: "https://d.example/" } as never]);
    const t2 = makeEnv();
    seed(t2);
    expect(await runIntensityIfDue(t2.env.DB, s, "", local("2027-07-03", 22), "https://d.example", send)).toBe(false);
  });
  test("the page: the intensity nudge from 18:00, and the weekly reflection lists the high-intensity days", async () => {
    const t = makeEnv({ DASHBOARD_TZ: "Europe/London" });
    seed(t);
    const ctx = makeCtx();
    const d = (await (await route(request("/api/wellbeing"), t.env, ctx, { now: local("2027-07-03", 18) + 60_000 })).json()) as any;
    expect(d.nudges.map((n: { id: string }) => n.id)).toContain("intensity");
    expect(d.intensity.days.map((x: { day: string }) => x.day)).toEqual(["2027-07-01", "2027-07-02", "2027-07-03"]);
    expect(H).toBe(3_600_000);
  });
});
