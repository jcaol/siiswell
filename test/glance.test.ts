import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RANGES, bandPlace, bucketRange, highlights, loadPref, parsePins, pinOrder, rangeRows, rangesFor, savePref, togglePin, valueParts } from "../public/glance.js";

const pub = (f: string) => readFileSync(join(import.meta.dir, "..", "public", f), "utf8");

describe("ranges: only what the data can fill", () => {
  test("W / M / 6M / Y by the days of data", () => {
    expect(RANGES.map((r) => r.key)).toEqual(["W", "M", "6M", "Y"]);
    expect(rangesFor(30).map((r) => r.key)).toEqual(["W", "M"]);
    expect(rangesFor(365).map((r) => r.key)).toEqual(["W", "M", "6M", "Y"]);
    expect(rangesFor(6)).toEqual([]);
    expect(rangesFor(Number.NaN)).toEqual([]);
  });
});

describe("the viewer's preferences survive missing or broken storage", () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  test("load / save with a fallback", () => {
    const s = mem();
    expect(loadPref(s, "range.usage", ["W", "M"], "M")).toBe("M");
    expect(savePref(s, "range.usage", "W")).toBe(true);
    expect(s.m.get("siiswell.range.usage")).toBe("W");
    expect(loadPref(s, "range.usage", ["W", "M"], "M")).toBe("W");
    s.setItem("siiswell.range.usage", "Z");
    expect(loadPref(s, "range.usage", ["W", "M"], "M")).toBe("M"); // not an allowed value
    expect([loadPref(broken, "x", null, "d"), savePref(broken, "x", "1"), loadPref(null, "x", null, "d"), savePref(null, "x", "1")]).toEqual(["d", false, "d", false]);
  });
  test("pins: parse defensively, toggle, pinned first in pin order", () => {
    expect(parsePins('["hl-rest","hl-usage","hl-rest","<b>",7]')).toEqual(["hl-rest", "hl-usage"]);
    expect([parsePins("not json"), parsePins(null), parsePins('{"a":1}')]).toEqual([[], [], []]);
    expect(togglePin(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePin(["a", "b"], "a")).toEqual(["b"]);
    expect(pinOrder(["rest", "target", "today", "trends"], ["trends", "gone", "rest"])).toEqual(["trends", "rest", "target", "today"]);
    expect(pinOrder(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("usual range", () => {
  test("where now sits, in calm words", () => {
    expect(bandPlace(10, 20, 40)).toEqual({ key: "below", text: "below your usual range" });
    expect(bandPlace(30, 20, 40).key).toBe("within");
    expect(bandPlace(55, 20, 40)).toEqual({ key: "above", text: "above your usual range" });
    expect(bandPlace(30, null, null).key).toBe("none");
  });
  test("rows clamp to 0..100 and keep nulls", () => {
    expect(rangeRows([{ name: "burn", now: 140, week: 30.5, lo: -5, hi: 60 }, { name: "session", now: 0, week: null, lo: null, hi: null }])).toEqual([
      { name: "burn", now: 100, avg: 30.5, lo: 0, hi: 60, place: { key: "above", text: "above your usual range" } },
      { name: "session", now: 0, avg: null, lo: null, hi: null, place: { key: "none", text: "no usual range yet" } },
    ]);
  });
});

describe("long usage ranges", () => {
  const byDay = new Map([
    ["2026-10-19", { usd: 2, input: 100, output: 50, requests: 3 }],
    ["2026-10-13", { usd: 1, input: 10, output: 0, requests: 1, unpricedTokens: 5 }],
    ["2026-09-30", { usd: 4, input: 0, output: 0, requests: 2 }],
  ]);
  test("W / M: one bucket per day, real days with nothing count as zero", () => {
    const w = bucketRange(byDay, "2026-10-19", "W");
    expect(w.length).toBe(7);
    expect(w[6]).toMatchObject({ key: "2026-10-19", usd: 2, tokens: 150, requests: 3, label: "19 Oct" });
    expect(w[0]).toMatchObject({ key: "2026-10-13", usd: 1, unpricedTokens: 5 });
    expect(w.slice(1, 6).every((b) => b.usd === 0)).toBe(true);
  });
  test("6M: weeks starting Monday; Y: calendar months", () => {
    const six = bucketRange(byDay, "2026-10-19", "6M");
    expect(six.every((b) => new Date(`${b.key}T00:00:00Z`).getUTCDay() === 1 || b === six[0])).toBe(true);
    const last = six[six.length - 1];
    expect(last).toMatchObject({ key: "2026-10-19", usd: 2, label: "week of 19 Oct" });
    expect(six.find((b) => b.key === "2026-10-12")).toMatchObject({ usd: 1 });
    const y = bucketRange(byDay, "2026-10-19", "Y");
    expect(y.length).toBe(13); // 365 days reach back into October 2025
    expect(y[y.length - 1]).toMatchObject({ key: "2026-10", usd: 3, label: "Oct 2026", tick: "Oct" });
    expect(y.find((b) => b.key === "2026-09")).toMatchObject({ usd: 4 });
    expect(bucketRange(byDay, "2026-10-19", "nope")).toEqual([]);
  });
});

describe("big-number parts", () => {
  test("digits large, units small", () => {
    expect(valueParts("$1,234")).toEqual([{ text: "$", unit: true }, { text: "1,234", unit: false }]);
    expect(valueParts("3h 10m")).toEqual([{ text: "3", unit: false }, { text: "h ", unit: true }, { text: "10", unit: false }, { text: "m", unit: true }]);
    expect(valueParts("12.3M")).toEqual([{ text: "12.3", unit: false }, { text: "M", unit: true }]);
    expect(valueParts("37/100")).toEqual([{ text: "37", unit: false }, { text: "/", unit: true }, { text: "100", unit: false }]);
    expect(valueParts("—")).toEqual([{ text: "—", unit: true }]);
    expect(valueParts("")).toEqual([{ text: "", unit: false }]);
  });
});

describe("Highlights: fixed templates, only with enough data", () => {
  const days = (today: string, n: number, f: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ day: new Date(Date.parse(`${today}T00:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10), usd: f(i), input: 1000, output: 0, requests: 1 }));
  test("usage: the last 7 days against the 7 before", () => {
    const ins = { today: "2026-10-19", daily: days("2026-10-19", 14, (i) => (i < 7 ? 10 : 5)) };
    const [u] = highlights({ ins });
    expect(u).toMatchObject({ id: "hl-usage", cat: "usage", value: "$35.00", unit: "last 7 days", text: "About 50% less than the 7 days before." });
    expect(u.spark.length).toBe(14);
    const same = highlights({ ins: { today: "2026-10-19", daily: days("2026-10-19", 14, () => 5) } })[0];
    expect(same.text).toBe("About the same as the 7 days before.");
    // only this week known: no comparison, a plain number
    expect(highlights({ ins: { today: "2026-10-19", daily: days("2026-10-19", 7, () => 5) } })[0].text).toBe("7k tokens in the last 7 days.");
    expect(highlights({ ins: { today: "2026-10-19", daily: [] } })).toEqual([]);
  });
  test("well-being: workload, evenings, active hours; nothing without data", () => {
    const trend = Array.from({ length: 14 }, (_, i) => ({ day: `d${i}`, stress: i < 7 ? 50 : 30 }));
    const trends = Array.from({ length: 14 }, (_, i) => ({ day: `d${i}`, activeHours: i < 7 ? 8 : 5 }));
    const out = highlights({ wb: { stress: { trend }, rest: { kept: { days: 7, endedEarly: 6, end: "23:00" } }, trends } });
    expect(out.map((x) => x.id)).toEqual(["hl-stress", "hl-rest", "hl-active"]);
    expect(out[0]).toMatchObject({ value: "30", unit: "/100 avg this week", text: "A lighter week than the one before." });
    expect(out[1]).toMatchObject({ value: "6", unit: "of 7 days", text: "6 days ended before 23:00." });
    expect(out[2]).toMatchObject({ value: "5h", text: "Fewer than the week before (8h)." });
    expect(highlights({ wb: { pending: true } })).toEqual([]);
    expect(highlights({})).toEqual([]);
  });
  test("calm wording only (no praise, blame or alarm)", () => {
    const text = pub("glance.js") + pub("glance-ui.js");
    expect(text).not.toMatch(/\b(great job|well done|bad|warning|danger|critical|you must|failed|streak|score)\b/i);
  });
});

describe("the page uses the shared pieces", () => {
  test("one range control and the big-number style across sections; no radar any more", () => {
    const wb = pub("wellbeing.js");
    const us = pub("usage.js");
    for (const js of [wb, us]) {
      expect(js).toContain("rangeControl(");
      expect(js).toContain("bigValue(");
    }
    expect(wb).toContain("usualRange(d)");
    expect(wb).not.toContain("radar(d.stress)");
    expect(pub("index.html")).toContain('id="sec-highlights"');
    expect(pub("app.js")).toContain("initHighlights()");
  });
});
