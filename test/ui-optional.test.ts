import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_STATE, eventIcon, showOptionalSection } from "../public/format.js";

const pub = (f: string) => readFileSync(join(import.meta.dir, "..", "public", f), "utf8");
const fnBody = (src: string, name: string): string => {
  const start = src.indexOf(`function ${name}(`);
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};

describe("optional sections render nothing without data", () => {
  test("showOptionalSection: only a non-empty list shows", () => {
    expect([undefined, null, [], {}, "x"].map((v) => showOptionalSection(v as unknown[]))).toEqual([false, false, false, false, false]);
    expect(showOptionalSection([{}])).toBe(true);
  });

  test("Threads and Projects start hidden in the page (no heading flashes before the first state)", () => {
    const html = pub("index.html");
    for (const id of ["sec-discussions", "sec-projects"]) expect(html).toMatch(new RegExp(`<section id="${id}"[^>]*\\shidden>`));
  });

  test("their renderers hide the whole section and write no empty-state text", () => {
    const app = pub("app.js");
    const ext = pub("host-ext.js"); // the optional host integration's renderers
    for (const [src, fn, sec, list] of [[ext, "renderThreads", "sec-discussions", "list"], [app, "renderProjects", "sec-projects", "s.projects"]] as const) {
      const body = fnBody(src, fn);
      expect(body).toContain(`showOptionalSection(${list})`);
      expect(body).toContain(`$("${sec}").hidden = !show`);
      expect(body).not.toContain("empty(");
    }
    // no Projects tile in the summary strip while there are no projects
    expect(fnBody(app, "renderSummary")).toContain("showOptionalSection(s.projects) || showOptionalSection(s.mcpProjects) ?");
  });

  test("the summary strip has one column per rendered tile (a left-out tile leaves no gap)", () => {
    const css = pub("style.css");
    const rule = /\.summary \{[^}]*\}/.exec(css)![0];
    expect(rule).toContain("grid-auto-flow: column");
    expect(rule).not.toMatch(/grid-template-columns:\s*repeat\(\d/);
  });

  test("no orchestrator wording in what the page shows", () => {
    const text = pub("index.html") + pub("app.js") + pub("format.js") + pub("host-ext.js");
    const visible = [...text.matchAll(/"([^"\n]*)"|`([^`\n]*)`|>([^<\n]+)</g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "")
      .filter((t) => /\s/.test(t.trim()) || /^[A-Z]/.test(t.trim())) // sentences and labels; element ids and wire values (`sec-discussions`, `approval`) are not shown
      .join("\n");
    expect(visible.match(/\bdiscussions?\b|\bapprovals?\b(?! waiting)|\brelay\b|\bround \$|\bpoll\b|orchestrat|\bbenched:|active discussion/gi) ?? []).toEqual([]);
    expect(AGENT_STATE.benched.label).toBe("on hold");
    expect(eventIcon({ kind: "approval" }).what).toBe("pending action");
  });
});
