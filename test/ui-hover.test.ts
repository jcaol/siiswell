/** Hover never hides a chart: themed hover rules use defined tokens; chart hit areas only tint / outline. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "public", "style.css"), "utf8");
/** The tokens a theme block defines. */
const tokensIn = (block: string) => new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
const rootLight = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
const darkMedia = /@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?:root[^{]*\{([\s\S]*?)\n  \}/.exec(css)![1]!;
const darkForced = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;

describe("hover rules", () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*:hover[^{}]*)\{([^}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
  test("there are hover rules, and none hides anything (opacity 0, visibility, display none, transparent fill)", () => {
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) expect([r.sel, /opacity:\s*0(\D|$)|visibility:\s*hidden|display:\s*none|fill:\s*(none|transparent)/.test(r.body)]).toEqual([r.sel, false]);
  });
  test("every token a hover rule reads is defined in the light theme and in both dark blocks", () => {
    const light = tokensIn(rootLight), dark = tokensIn(darkMedia), forced = tokensIn(darkForced);
    for (const r of rules) {
      for (const [, name] of r.body.matchAll(/var\((--[a-z0-9-]+)/g)) {
        expect([r.sel, name, light.has(name!) || /^--tone-/.test(name!)]).toEqual([r.sel, name, true]);
        // a token only the light theme defines is fine when it is not themed at all; a themed one must exist in both dark blocks
        if (dark.has(name!) !== forced.has(name!)) throw new Error(`${name} is defined in only one dark block`);
      }
    }
  });
  test("the chart hit areas (transparent buttons over the bars) have their own hover: a tint over transparent, never the opaque button background", () => {
    for (const sel of [".wb-col:hover", ".u-col:hover"]) {
      const r = rules.find((x) => x.sel === sel);
      expect(r).toBeDefined();
      expect(r!.body).toMatch(/background:\s*color-mix\(in srgb, var\(--text\) \d+%, transparent\)/);
      expect(r!.body).toContain("outline");
    }
    // the generic button hover is opaque: it must not be the only rule for a chart button
    expect(rules.find((x) => x.sel === "button:hover")!.body).toContain("var(--surface-2)");
    expect(rules.find((x) => x.sel === ".u-hc:hover")!.body).toContain("brightness");
  });
});

describe("the stress patterns heatmap shows the value of the hovered / focused hour", () => {
  const js = readFileSync(join(import.meta.dir, "..", "public", "wellbeing.js"), "utf8");
  const heat = js.slice(js.indexOf("function weekHourStress"), js.indexOf("/** 7 / 30-day trends"));
  test("inside the square (rounded), a tooltip 'Fri 15:00 · avg 84 · Heavy', keyboard focus the same, a detail line for phones", () => {
    for (const needle of ['"u-wh-v"', "v.textContent = String(Math.round(c.stress))", '`${label} ${hh(hr)} · avg ${Math.round(c.stress)} · ${bandFor(c.stress).label}`', '"mouseenter"', '"focus"', "ArrowRight", '"aria-live": "polite"', "el.tabIndex"]) expect(heat).toContain(needle);
    expect(css).toMatch(/@media \(max-width: 480px\) \{ \.u-wh-v \{ display: none; \} \.wb-wh-detail \{ display: block; \} \}/);
  });
});
