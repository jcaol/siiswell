// The pure text / time helpers of the PWA (public/format.js): no DOM needed.
import { describe, expect, test } from "bun:test";
// @ts-expect-error plain browser module without types
import { AGENT_STATE, ago, cleanEventText, cleanTitle, dur, etaText, eventIcon, friendly } from "../public/format.js";

const MIN = 60_000;
const HR = 60 * MIN;
const NOW = 1_800_000_000_000;

describe("cleanTitle", () => {
  test("strips the transport tag", () => {
    expect(cleanTitle("[Mattermost from @alice] **deploy")).toBe("deploy");
    expect(cleanTitle("**fix the login bug")).toBe("fix the login bug");
    expect(cleanTitle("**bold** title")).toBe("**bold** title"); // real emphasis is kept
    expect(cleanTitle("** not a command")).toBe("** not a command");
    expect(cleanTitle("[Mattermost from @alice]    Ingest https://x.test/a")).toBe("Ingest https://x.test/a");
    expect(cleanTitle("[Mattermost from alice] fix the build")).toBe("fix the build");
    expect(cleanTitle("[slack from @Alice:example.org] case does not matter")).toBe("case does not matter");
    for (const tr of ["Telegram", "Discord", "Matrix"]) expect(cleanTitle(`[${tr} from @bob] fix it`)).toBe("fix it");
    // only known transports: a bracketed prefix that is part of the title stays
    expect(cleanTitle("[Report from QA] build failed")).toBe("[Report from QA] build failed");
    expect(cleanTitle("[Notes from standup] ship it")).toBe("[Notes from standup] ship it");
  });
  test("renders a forwarded message as an arrow and the original sender", () => {
    expect(cleanTitle("[Forwarded from Ann Lee] Can someone confirm?")).toBe("↪ Ann Lee: Can someone confirm?");
    expect(cleanTitle("[Mattermost from @alice] [Forwarded from Ann Lee] Can someone confirm?")).toBe("↪ Ann Lee: Can someone confirm?");
  });
  test("only a LEADING tag is touched; an empty remainder falls back to the original", () => {
    expect(cleanTitle("deploy [Mattermost from @x] now")).toBe("deploy [Mattermost from @x] now");
    expect(cleanTitle("[Mattermost from @alice]")).toBe("[Mattermost from @alice]");
    expect(cleanTitle("")).toBe("(untitled)");
    expect(cleanTitle(null)).toBe("(untitled)");
  });
});

describe("cleanEventText", () => {
  const status = (text: string) => cleanEventText({ kind: "status", text });
  test("drops the STATUS prefix (the icon says which status it is) and keeps the ETA / label", () => {
    expect(status("STATUS: IN PROGRESS (ETA 1min) — 收到，跟進 pilot")).toBe("(ETA 1min) 收到，跟進 pilot");
    expect(status("STATUS: DONE（今輪分析） — 收到，目標係低成本")).toBe("（今輪分析） 收到，目標係低成本");
    expect(status("STATUS: BLOCKED need the new app secret")).toBe("need the new app secret");
    expect(status("STATUS: DONE: all good — really")).toBe("all good — really"); // later dashes are the agent's own
  });
  test("a bare status keeps its text; other kinds are never rewritten", () => {
    expect(status("STATUS: DONE")).toBe("STATUS: DONE");
    expect(status("no prefix at all")).toBe("no prefix at all");
    expect(cleanEventText({ kind: "halt", text: "STATUS: DONE is quoted in a halt notice" })).toBe("STATUS: DONE is quoted in a halt notice");
  });
});

describe("time words", () => {
  test("dur", () => {
    expect(dur(10_000)).toBe("<1 min");
    expect(dur(12 * MIN)).toBe("12 min");
    expect(dur(-12 * MIN)).toBe("12 min");
    expect(dur(3 * HR)).toBe("3 h");
    expect(dur(47 * HR)).toBe("47 h");
    expect(dur(72 * HR)).toBe("3 d");
  });
  test("ago", () => {
    expect(ago(NOW - 3_000, NOW)).toBe("just now");
    expect(ago(NOW + 5 * MIN, NOW)).toBe("just now"); // a clock a little ahead never prints a negative age
    expect(ago(NOW - 30_000, NOW)).toBe("30s ago");
    expect(ago(NOW - 7 * MIN, NOW)).toBe("7 min ago");
    expect(ago(NOW - 5 * HR, NOW)).toBe("5 h ago");
  });
  test("etaText: in the future an ETA, in the past overdue", () => {
    expect(etaText(NOW + 12 * MIN, NOW)).toBe("ETA in 12 min");
    expect(etaText(NOW + 3 * HR, NOW)).toBe("ETA in 3 h");
    expect(etaText(NOW - 5 * MIN, NOW)).toBe("overdue 5 min");
    expect(etaText(NOW - 10_000, NOW)).toBe("overdue <1 min");
  });
});

describe("agent states", () => {
  test("every state of the wire contract has a friendly word; killed and frozen are calm, not red", () => {
    const states = ["working", "idle", "frozen", "killed", "wedged", "benched", "usage-limit", "compacting", "unknown"];
    for (const s of states) expect(AGENT_STATE[s]).toBeDefined();
    expect(friendly("killed")).toMatchObject({ label: "asleep", tone: "sleep" });
    expect(friendly("frozen")).toMatchObject({ label: "paused", tone: "sleep" });
    expect(friendly("wedged")).toMatchObject({ label: "stuck", tone: "crit" });
    expect(friendly("usage-limit").label).toBe("limit");
    expect(friendly("something-new").label).toBe("unknown"); // a newer server state never breaks the page
  });
});

describe("eventIcon", () => {
  test("status events by their status, others by kind / severity", () => {
    expect(eventIcon({ kind: "status", status: "DONE" })).toMatchObject({ g: "✓", tone: "ok" });
    expect(eventIcon({ kind: "status", status: "IN_PROGRESS" })).toMatchObject({ g: "…", tone: "info" });
    expect(eventIcon({ kind: "status", status: "BLOCKED" })).toMatchObject({ g: "⛔", tone: "crit" });
    expect(eventIcon({ kind: "halt", severity: "critical" }).tone).toBe("crit");
    expect(eventIcon({ kind: "halt", severity: "warn" }).tone).toBe("warn");
    expect(eventIcon({ kind: "halt", severity: "info" }).tone).toBe("info");
    expect(eventIcon({ kind: "approval", severity: "info" }).tone).toBe("warn");
  });
});

describe("the PWA keeps its safety rules", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const raw = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
  const code = (f: string) => raw(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // the comments may NAME the forbidden calls
  test("no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval in any script, no inline style or script in the page", () => {
    for (const f of ["app.js", "format.js", "sw.js"]) {
      expect(code(f)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|setAttribute\(\s*["']style["']/);
    }
    const html = raw("index.html");
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=|<style|<script(?![^>]*\bsrc=)/i);
    expect(code("app.js")).not.toMatch(/\.style\.|cssText/); // looks come from classes in style.css
  });
  test("the new page never says 'reply never' and keeps its stale / truncation banners", () => {
    expect(code("app.js")).not.toMatch(/reply never|"never"/);
    const html = raw("index.html");
    for (const id of ["stale", "rules-warning", "state-truncated", "notify-help", "btn-notify"]) expect(html).toContain(`id="${id}"`);
  });
});
