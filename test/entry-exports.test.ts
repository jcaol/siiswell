/**
 * The Worker entry module may export only functions, classes and handlers: workerd (wrangler dev 4.142, and
 * production once it validates the same way) refuses to start with "Incorrect type for map entry '<name>': ... not of
 * type 'function or ExportedHandler'" when a named export is anything else (a string constant such as the HSTS
 * value did exactly that: production accepted it, local dev was broken). Constants belong in util.ts / env.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as entry from "../src/index";

describe("src/index.ts (the wrangler.toml `main`)", () => {
  test("every named export is a function or a class; the default export is a handler with fetch + scheduled", () => {
    const { default: handler, ...named } = entry as Record<string, unknown>;
    for (const [name, value] of Object.entries(named)) expect([name, typeof value]).toEqual([name, "function"]);
    const h = handler as Record<string, unknown>;
    expect(typeof handler).toBe("object");
    expect(typeof h.fetch).toBe("function");
    expect(typeof h.scheduled).toBe("function");
    // what the tests and the Worker itself rely on
    expect(Object.keys(named)).toEqual(expect.arrayContaining(["route", "runCron"]));
  });

  test("the HSTS value is exported from util.ts, not from the entry module", async () => {
    expect("HSTS" in entry).toBe(false);
    expect((await import("../src/util")).HSTS).toBe("max-age=31536000");
  });

  test("static guard: no `export const|let|var|enum` (value exports other than functions) in the entry source", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src.match(/^export\s+(?:const|let|var|enum)\b.*$/gm) ?? []).toEqual([]);
  });
});
