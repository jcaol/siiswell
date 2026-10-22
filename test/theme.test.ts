import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { PROJECT_OFFLINE_AFTER_MS as UI_PROJECT_OFFLINE_AFTER_MS, dueOnVisible, pollDelay, POLL_MS, projectSilent, REFETCH_ON_VISIBLE_MS, themeView } from "../public/format.js";
import { PROJECT_OFFLINE_AFTER_MS } from "../src/shared/schema";

/**
 * The manual light / dark / auto theme (public/theme.js + style.css + the header switch) and the page's calmer
 * update cadence (public/format.js pollDelay / dueOnVisible, public/app.js). No DOM library: theme.js is run in a
 * `node:vm` context with a hand-made document, the CSS is parsed as text.
 */
const PUBLIC = join(import.meta.dir, "..", "public");
const read = (f: string) => readFileSync(join(PUBLIC, f), "utf8");
const THEME_JS = read("theme.js");
const CSS = read("style.css");
const HTML = read("index.html");
const APP = read("app.js");
const HEADERS = read("_headers");

// ── theme.js ─────────────────────────────────────────────────────────────────

interface FakeMeta { media: string; content: string; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }
function meta(media: string, content: string): FakeMeta {
  const m: FakeMeta = {
    media, content,
    getAttribute: (n) => (n === "media" ? (m.media || null) : n === "content" ? m.content : null),
    setAttribute: (n, v) => { if (n === "content") m.content = v; },
  };
  return m;
}

/** Run theme.js against a fake page. `storage`: a stored value, "throws" (blocked storage) or undefined (empty). */
function load(storage?: string | "throws", pre: Array<[string, string]> = []) {
  const attrs: Record<string, string> = {};
  const light = meta("(prefers-color-scheme: light)", "#f6f7f9");
  const dark = meta("(prefers-color-scheme: dark)", "#0e1013");
  const scheme = meta("", "light dark");
  const store = new Map<string, string>([...pre, ...(storage && storage !== "throws" ? ([["siiswell-theme", storage]] as Array<[string, string]>) : [])]);
  const document = {
    documentElement: {
      setAttribute: (n: string, v: string) => { attrs[n] = v; },
      removeAttribute: (n: string) => { delete attrs[n]; },
      getAttribute: (n: string) => attrs[n] ?? null,
    },
    querySelectorAll: (sel: string) => (sel === 'meta[name="theme-color"]' ? [light, dark] : []),
    querySelector: (sel: string) => (sel === 'meta[name="color-scheme"]' ? scheme : null),
  };
  const ctx: Record<string, unknown> = { window: {}, document };
  if (storage === "throws") {
    Object.defineProperty(ctx, "localStorage", { get() { throw new Error("SecurityError: storage is blocked"); } });
  } else {
    ctx.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  }
  createContext(ctx);
  runInContext(THEME_JS, ctx);
  const api = (ctx.window as { OrchTheme: { get(): string; set(c: string): string; next(c: string): string; ORDER: string[] } }).OrchTheme;
  return { api, attrs, light, dark, scheme, store };
}

describe("theme.js", () => {
  test("the choice stored under the pre-rename key is moved to the new key once (a newer choice wins)", () => {
    const moved = load(undefined, [["orch-theme", "dark"]]);
    expect(moved.api.get()).toBe("dark");
    expect([...moved.store.entries()]).toEqual([["siiswell-theme", "dark"]]);
    const both = load("light", [["orch-theme", "dark"]]);
    expect(both.api.get()).toBe("light");
    expect(both.store.has("orch-theme")).toBe(false);
  });

  test("nothing stored: Auto, no data-theme (the page follows the device), the meta tags untouched", () => {
    const t = load();
    expect(t.api.get()).toBe("auto");
    expect(t.attrs["data-theme"]).toBeUndefined();
    expect([t.light.content, t.dark.content, t.scheme.content]).toEqual(["#f6f7f9", "#0e1013", "light dark"]);
  });

  test("a stored choice is applied before first paint: data-theme, BOTH theme-color metas and color-scheme follow it", () => {
    const d = load("dark");
    expect(d.api.get()).toBe("dark");
    expect(d.attrs["data-theme"]).toBe("dark");
    expect([d.light.content, d.dark.content, d.scheme.content]).toEqual(["#0e1013", "#0e1013", "dark"]);   // the device may be light: the browser chrome still matches
    const l = load("light");
    expect(l.attrs["data-theme"]).toBe("light");
    expect([l.light.content, l.dark.content, l.scheme.content]).toEqual(["#f6f7f9", "#f6f7f9", "light"]);
  });

  test("a stored value that is not a choice is Auto", () => {
    for (const junk of ["", "blue", "DARK", "auto", "1"]) expect(load(junk).api.get()).toBe("auto");
  });

  test("set() applies, persists, and Auto removes the key again and restores each meta's own colour", () => {
    const t = load();
    expect(t.api.set("dark")).toBe("dark");
    expect(t.store.get("siiswell-theme")).toBe("dark");
    expect(t.attrs["data-theme"]).toBe("dark");
    expect(t.api.set("light")).toBe("light");
    expect(t.store.get("siiswell-theme")).toBe("light");
    expect(t.attrs["data-theme"]).toBe("light");
    expect(t.api.set("auto")).toBe("auto");
    expect(t.store.has("siiswell-theme")).toBe(false);
    expect(t.attrs["data-theme"]).toBeUndefined();
    expect([t.light.content, t.dark.content, t.scheme.content]).toEqual(["#f6f7f9", "#0e1013", "light dark"]);
    expect(t.api.set("bogus")).toBe("auto");
  });

  test("a browser that blocks storage: no exception, Auto at load, and a choice still works for the session", () => {
    const t = load("throws");
    expect(t.api.get()).toBe("auto");
    expect(t.attrs["data-theme"]).toBeUndefined();
    expect(() => t.api.set("dark")).not.toThrow();
    expect(t.api.get()).toBe("dark");
    expect(t.attrs["data-theme"]).toBe("dark");
    expect(t.api.set("auto")).toBe("auto");
  });

  test("a storage that throws on write (quota, private mode) is survived too", () => {
    const attrs: Record<string, string> = {};
    const ctx: Record<string, unknown> = {
      window: {},
      document: { documentElement: { setAttribute: (n: string, v: string) => { attrs[n] = v; }, removeAttribute: (n: string) => { delete attrs[n]; } }, querySelectorAll: () => [], querySelector: () => null },
      localStorage: { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => { throw new Error("blocked"); } },
    };
    createContext(ctx);
    runInContext(THEME_JS, ctx);
    const api = (ctx.window as { OrchTheme: { set(c: string): string } }).OrchTheme;
    expect(() => api.set("light")).not.toThrow();
    expect(attrs["data-theme"]).toBe("light");
    expect(() => api.set("auto")).not.toThrow();
  });

  test("next() cycles Auto -> Light -> Dark -> Auto", () => {
    const { api } = load();
    expect(api.ORDER).toEqual(["auto", "light", "dark"]);
    expect(api.next("auto")).toBe("light");
    expect(api.next("light")).toBe("dark");
    expect(api.next("dark")).toBe("auto");
    expect(api.next("junk")).toBe("light");
  });

  test("it is a classic script: no module syntax, nothing inline-eval'd, no network", () => {
    expect(THEME_JS).not.toMatch(/^\s*(import|export)\s/m);
    expect(THEME_JS).not.toMatch(/\beval\s*\(|new Function|innerHTML|fetch\(|XMLHttpRequest/);
  });
});

// ── index.html / CSP ─────────────────────────────────────────────────────────

describe("index.html", () => {
  const head = HTML.slice(HTML.indexOf("<head>"), HTML.indexOf("</head>"));

  test("theme.js is an external, synchronous script in <head>, after the meta tags it rewrites and the stylesheet", () => {
    const tag = /<script\b[^>]*\bsrc="\/theme\.js"[^>]*><\/script>/.exec(head);
    expect(tag).not.toBeNull();
    expect(tag![0]).not.toMatch(/\b(type|defer|async)\b/);          // classic and blocking: runs before the first paint
    for (const marker of ['name="theme-color"', 'name="color-scheme"', 'rel="stylesheet"']) {
      expect(head.indexOf(marker)).toBeGreaterThan(-1);
      expect(head.indexOf(marker)).toBeLessThan(head.indexOf("/theme.js"));
    }
  });

  test("no inline script or style anywhere (the CSP forbids them), every script has a src", () => {
    for (const m of HTML.matchAll(/<script\b([^>]*)>/g)) expect(m[1]).toMatch(/\bsrc="\//);
    expect(HTML).not.toMatch(/<style\b/);
    expect(HTML).not.toMatch(/\sstyle="/);
    expect(HTML).not.toMatch(/\son[a-z]+="/);
  });

  test("the CSP stays strict: scripts from 'self' only, no unsafe-inline / unsafe-eval", () => {
    const csp = /Content-Security-Policy:\s*(.+)/.exec(HEADERS)![1];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  test("the header carries the theme switch, the Sign out link to Cloudflare Access and a refresh button", () => {
    expect(HTML).toMatch(/<button id="btn-theme" class="tool" type="button"/);
    expect(HTML).toMatch(/<a id="link-signout" class="tool" href="\/cdn-cgi\/access\/logout">Sign out<\/a>/);
    expect(HTML).toMatch(/<button id="btn-refresh"[^>]*aria-label="Refresh now"/);
    // all three sit inside <header>, before the first section
    const header = HTML.slice(HTML.indexOf("<header"), HTML.indexOf("</header>"));
    for (const id of ["btn-theme", "link-signout", "btn-refresh", "refreshed"]) expect(header).toContain(`id="${id}"`);
  });

  test("the sign-out link is plain navigation (same origin, no script involved)", () => {
    expect(APP).not.toContain("link-signout");
    expect(APP).not.toContain("cdn-cgi");
  });
});

// ── style.css ────────────────────────────────────────────────────────────────

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
/** The text between the `{` that follows `selector` and its matching `}` (the first nested block closes at the first `}`). */
function block(selector: string, from = 0): string {
  const at = CSS.indexOf(selector, from);
  expect(at).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}
const LIGHT = tokens(block(":root {"));
const DARK_MEDIA = tokens(block(':root:not([data-theme="light"])', CSS.indexOf("@media (prefers-color-scheme: dark)")));
const DARK_ATTR = tokens(block(':root[data-theme="dark"] {'));

describe("style.css palettes", () => {
  test("the light palette is :root, the dark one is under the media query (unless Light is chosen) AND under [data-theme=dark], identical", () => {
    expect(Object.keys(DARK_MEDIA).length).toBeGreaterThanOrEqual(18);
    expect(DARK_ATTR).toEqual(DARK_MEDIA);
    const colourTokens = Object.keys(LIGHT).filter((k) => k !== "radius").sort();
    expect(Object.keys(DARK_MEDIA).sort()).toEqual(colourTokens);                       // no token missing in either theme
    expect(CSS).toMatch(/:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/);   // native controls follow a forced Light
    expect(block(':root[data-theme="dark"] {')).toMatch(/color-scheme:\s*dark;/);
    expect(block(':root:not([data-theme="light"])', CSS.indexOf("@media (prefers-color-scheme: dark)"))).toMatch(/color-scheme:\s*dark;/);
  });

  test("every colour in the stylesheet is a token (nothing hard-coded outside the palettes)", () => {
    const rest = CSS
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/:root\s*\{[^}]*\}/g, "")
      .replace(/:root:not\(\[data-theme="light"\]\)\s*\{[^}]*\}/g, "")
      .replace(/:root\[data-theme="(?:light|dark)"\]\s*\{[^}]*\}/g, "");
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  // WCAG 2.x contrast: 4.5:1 for text, 3:1 for the focus ring / outlines
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (c: number[]) => {
    const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mix = (a: number[], pa: number, b: number[]) => a.map((v, i) => v * pa + b[i] * (1 - pa));

  for (const [name, t] of [["light", LIGHT], ["dark", DARK_ATTR]] as const) {
    test(`${name}: every text / background pair the page uses reads (>= 4.5:1), focus ring and outlines >= 3:1`, () => {
      const C = (k: string) => rgb(t[k]);
      const text: Array<[string, number[], number[]]> = [
        ["text on bg", C("text"), C("bg")], ["text on surface", C("text"), C("surface")], ["text on surface-2 (agent cards)", C("text"), C("surface-2")],
        ["muted on bg (help, legend)", C("muted"), C("bg")], ["muted on surface (sub lines)", C("muted"), C("surface")], ["muted on surface-2", C("muted"), C("surface-2")],
        ["ok chip / pill", C("ok"), C("ok-bg")], ["warn chip / banner / late", C("warn"), C("warn-bg")], ["crit chip / banner / stat", C("crit"), C("crit-bg")],
        ["info chip / agent tag", C("info"), C("info-bg")], ["idle chip / pill", C("idle"), C("idle-bg")], ["sleep chip", C("sleep"), C("sleep-bg")],
        ["ok number on surface", C("ok"), C("surface")], ["crit on surface (failed count)", C("crit"), C("surface")],
        ["crit on surface-2 (hot %)", C("crit"), C("surface-2")], ["warn on surface-2 (warm %)", C("warn"), C("surface-2")],
        ["text on a critical alert", C("text"), mix(C("crit-bg"), 0.45, C("surface"))], ["muted on a critical alert", C("muted"), mix(C("crit-bg"), 0.45, C("surface"))],
        ["text on a warn alert / blocked task", C("text"), mix(C("warn-bg"), 0.45, C("surface"))], ["muted on a warn alert / blocked task", C("muted"), mix(C("warn-bg"), 0.45, C("surface"))],
        ["text on a failed result", C("text"), mix(C("crit-bg"), 0.4, C("surface"))], ["muted on a failed result", C("muted"), mix(C("crit-bg"), 0.4, C("surface"))],
        ["accent text on bg", C("accent"), C("bg")],
        // the well-being section's band colours (pills, tiles, gauge labels)
        ...["calm", "steady", "strained", "over"].flatMap((b): Array<[string, number[], number[]]> => [
          [`wb ${b} text on its tint`, C(`wb-${b}-fg`), C(`wb-${b}-bg`)], [`wb ${b} text on surface`, C(`wb-${b}-fg`), C("surface")],
        ]),
      ];
      for (const [what, fg, bg] of text) expect({ what, ok: ratio(fg, bg) >= 4.5 }).toEqual({ what, ok: true });
      for (const bg of ["bg", "surface", "surface-2"]) expect(ratio(C("accent"), C(bg))).toBeGreaterThanOrEqual(3);   // :focus-visible ring, highlighted alert
      // chart lines and marks (gauge arc, sparklines, trend, bars): non-text contrast, WCAG 1.4.11
      for (const b of ["calm", "steady", "strained", "over"]) for (const bg of ["surface", "bg"]) expect({ b, bg, line: ratio(C(`wb-${b}-line`), C(bg)) >= 3 }).toEqual({ b, bg, line: true });
      // the category colours (Highlights stripes, sparklines, heading dots): marks, >= 3:1 on every surface they sit on
      for (const c of ["tasks", "usage", "you", "rest"]) for (const bg of ["surface", "bg"]) expect({ c, bg, mark: ratio(C(`cat-${c}`), C(bg)) >= 3 }).toEqual({ c, bg, mark: true });
    });
  }

  test("the header controls are styled for both themes (tokens only) and fit a phone", () => {
    const tool = block(".tool {");
    expect(tool).toMatch(/color:\s*var\(--text\)/);
    expect(tool).toMatch(/background:\s*var\(--surface\)/);
    expect(tool).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(tool).toMatch(/min-height:\s*36px/);
    expect(CSS).toMatch(/a:focus-visible/);                                              // the Sign out link gets the focus ring too
  });
});

// ── update cadence ───────────────────────────────────────────────────────────

describe("page polling cadence", () => {
  test("60 s while visible, an immediate fetch on coming back only when the data is older than 15 s", () => {
    expect(POLL_MS).toBe(60_000);
    expect(REFETCH_ON_VISIBLE_MS).toBe(15_000);
    const T = 1_800_000_000_000;
    expect(dueOnVisible(0, T)).toBe(true);                       // nothing fetched yet
    expect(dueOnVisible(T - 15_000, T)).toBe(false);
    expect(dueOnVisible(T - 15_001, T)).toBe(true);
    expect(dueOnVisible(T - 2 * 3_600_000, T)).toBe(true);      // hours in the background
    expect(dueOnVisible(Number.NaN, T)).toBe(true);
  });

  test("the next poll is one POLL_MS after the LAST fetch, never sooner than 1 s", () => {
    const T = 1_800_000_000_000;
    expect(pollDelay(T, T)).toBe(60_000);
    expect(pollDelay(T - 20_000, T)).toBe(40_000);               // a visibility fetch 20 s ago: the timer does not double up
    expect(pollDelay(T - 59_500, T)).toBe(1_000);
    expect(pollDelay(T - 10 * 60_000, T)).toBe(1_000);           // overdue (laptop slept): soon, not instantly in a loop
  });

  test("a clock that jumps BACKWARDS cannot make the next poll wait longer than POLL_MS, or block the fetch on coming back", () => {
    const T = 1_800_000_000_000;
    expect(pollDelay(T + 3_600_000, T)).toBe(POLL_MS);           // the last fetch is "an hour in the future": 60 s, not an hour
    expect(pollDelay(T + 1, T)).toBe(POLL_MS);
    expect(dueOnVisible(T + 3_600_000, T)).toBe(true);           // coming back after the clock went back: fetch at once
    expect(dueOnVisible(T + 1, T)).toBe(true);
    expect(dueOnVisible(T, T)).toBe(false);
  });

  test("app.js polls with one self-rescheduling timer, pauses while hidden, and has a manual refresh", () => {
    expect(APP).not.toContain("setInterval");
    expect(APP).toMatch(/setTimeout\(refresh, pollDelay\(/);
    expect(APP).toMatch(/visibilityState !== "visible"/);        // no timer, no fetch while the page is hidden
    expect(APP).toMatch(/dueOnVisible\(ui\.lastFetchAt/);
    expect(APP).toMatch(/\$\("btn-refresh"\)\.addEventListener\("click", refresh\)/);
    expect(APP).not.toContain("20_000");
    expect(APP).not.toContain("OFFLINE_AFTER_MS");               // a project's snapshot age is not its liveness (heartbeats keep an unchanged project's snapshot old)
  });
});

describe("theme switch text", () => {
  test("Auto -> Light -> Dark: a visible label + glyph, and an accessible name that says what it is and what a press does", () => {
    const auto = themeView("auto", "light");
    expect(auto.label).toBe("Auto");
    expect(auto.aria).toBe("Theme: Auto (follows your device). Press to switch to Light.");
    expect(themeView("light", "dark")).toMatchObject({ label: "Light", aria: "Theme: Light (always light). Press to switch to Dark." });
    expect(themeView("dark", "auto")).toMatchObject({ label: "Dark", aria: "Theme: Dark (always dark). Press to switch to Auto." });
    for (const c of ["auto", "light", "dark"]) expect(themeView(c, "auto").glyph.length).toBeGreaterThan(0);
    expect(themeView("nonsense", "nonsense").label).toBe("Auto");
  });
});

describe("per-project liveness in the page", () => {
  test("a project is 'reporter offline' when its lastSeen is older than 6 min (the Worker's constant), never when nothing is recorded", () => {
    expect(UI_PROJECT_OFFLINE_AFTER_MS).toBe(PROJECT_OFFLINE_AFTER_MS);                    // page and Worker agree
    const T = 1_800_000_000_000;
    expect(projectSilent(T - 6 * 60_000, T)).toBe(false);
    expect(projectSilent(T - 6 * 60_000 - 1, T)).toBe(true);
    expect(projectSilent(null, T)).toBe(false);                                           // not recorded (yet): nothing is claimed
    expect(projectSilent(undefined, T)).toBe(false);
    expect(projectSilent(T - 7 * 60_000, undefined, T)).toBe(true);                       // no server clock: the client's
    expect(projectSilent(T - 7 * 60_000, T - 3 * 60_000, T)).toBe(false);                 // the server's clock wins over the client's
  });

  test("app.js marks a silent project on a LIVE host as offline (crit), says so in the tooltip, and shows when it was last heard", () => {
    expect(APP).toMatch(/projectSilent\(p\.lastSeen, s\.now, now\)/);
    expect(APP).toMatch(/const stale = hostOffline \|\| silent;/);
    expect(APP).toMatch(/"project-offline": "Reporter offline"/);
    // the reporter line is built by the optional host integration's module
    expect(readFileSync(join(import.meta.dir, "..", "public", "host-ext.js"), "utf8")).toContain("last heard ${ago(lastSeen, now)}");
    expect(APP).toContain("reporterView(p.poller, p.lastSeen, p.host, now)");
  });
});
