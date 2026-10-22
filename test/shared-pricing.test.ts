/**
 * Price table = the vendors' official price pages (src/shared/model-prices.json, retrieved 2026-10-14).
 * Per-MTok USD: input / 5m cache write / 1h cache write / cache read / output.
 */
import { describe, expect, test } from "bun:test";
import table from "../src/shared/model-prices.json";
import {
  buildPriceIndex, costOf, costOfPrice, fmtUSD, isLongContextFor, knownModelIds, normalizeModelId, priceFor, PRICE_TABLE_RETRIEVED, ratesFor,
  type RawEntry,
} from "../src/shared/pricing";

const M = 1_000_000;
/** $ for exactly 1M tokens of ONE kind, to read a rate straight off costOf */
const one = (model: string, kind: "input" | "output" | "cacheRead" | "w5m" | "w1h", extra: object = {}) =>
  costOf({
    model, input: kind === "input" ? M : 0, output: kind === "output" ? M : 0, cacheRead: kind === "cacheRead" ? M : 0,
    cacheWrite: kind === "w5m" || kind === "w1h" ? M : 0, cacheWrite1h: kind === "w1h" ? M : 0, ...extra,
  });

describe("priceFor", () => {
  test("Anthropic models resolve to the published rate card (input / 5m / 1h / read / output)", () => {
    const card = (id: string) => {
      const p = priceFor(id)!;
      return [p.input, p.cacheWrite5m, p.cacheWrite1h, p.cacheRead, p.output];
    };
    expect(card("claude-fable-5-1")).toEqual([10, 12.5, 20, 0.25, 50]);
    expect(card("claude-mythos-5-1")).toEqual([10, 12.5, 20, 0.25, 50]);
    expect(card("claude-fable-5")).toEqual([10, 12.5, 20, 1, 50]);
    expect(card("claude-mythos-5")).toEqual([10, 12.5, 20, 1, 50]);
    expect(card("claude-opus-5-5")).toEqual([4, 5, 8, 0.2, 20]);
    for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"]) {
      expect(card(id)).toEqual([5, 6.25, 10, 0.5, 25]);
    }
    expect(card("claude-opus-4-1")).toEqual([15, 18.75, 30, 1.5, 75]);
    expect(card("claude-opus-4")).toEqual([15, 18.75, 30, 1.5, 75]);
    expect(card("claude-sonnet-5-5")).toEqual([2, 2.5, 4, 0.1, 10]);
    expect(card("claude-sonnet-5")).toEqual([2, 2.5, 4, 0.2, 10]);       // 5 and 5.5 differ ONLY in the cache read
    for (const id of ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"]) expect(card(id)).toEqual([3, 3.75, 6, 0.3, 15]);
    expect(card("claude-haiku-5-5")).toEqual([0.1, 0.125, 0.2, 0.01, 0.5]);
    expect(card("claude-haiku-4-5")).toEqual([1, 1.25, 2, 0.1, 5]);
    expect(card("claude-haiku-3-5")).toEqual([0.8, 1, 1.6, 0.08, 4]);
  });

  test("OpenAI models: input / cached input / output (no cache-write premium unless the page lists one)", () => {
    const card = (id: string) => { const p = priceFor(id)!; return [p.input, p.cacheRead, p.output]; };
    expect(card("gpt-5.6-sol")).toEqual([4, 0.4, 20]);
    expect(card("gpt-5.6-terra")).toEqual([2, 0.2, 12]);
    expect(card("gpt-5.6-luna")).toEqual([0.2, 0.02, 1.2]);
    expect(card("gpt-5.5")).toEqual([5, 0.5, 30]);
    expect(card("gpt-5.4")).toEqual([2.5, 0.25, 15]);
    expect(card("gpt-5.4-mini")).toEqual([0.75, 0.075, 4.5]);
    expect(card("gpt-5.4-nano")).toEqual([0.2, 0.02, 1.25]);
    expect(card("gpt-5.3-codex")).toEqual([1.75, 0.175, 14]);
    expect(card("gpt-5.2")).toEqual([1.75, 0.175, 14]);
    expect(card("gpt-5.1")).toEqual([1.25, 0.125, 10]);
    expect(card("gpt-5")).toEqual([1.25, 0.125, 10]);
    expect(card("gpt-5-mini")).toEqual([0.25, 0.025, 2]);
    expect(card("gpt-5-nano")).toEqual([0.05, 0.005, 0.4]);
    // GPT-6.x ids that really appear in this host's Codex logs (price page lists them with a cache-write column)
    expect(card("gpt-6.1-sol")).toEqual([2, 0.1, 10]);
    expect(card("gpt-6-luna")).toEqual([0.1, 0.01, 0.5]);
    expect(card("gpt-6-sol")).toEqual([2, 0.2, 10]);
    expect(card("gpt-6-astra")).toEqual([10, 1, 50]);
    // the cache-write column (not an additive fee: the collector takes the write out of the fresh input)
    const writes = (id: string) => { const p = priceFor(id)!; return [p.cacheWrite5m, p.cacheWrite1h]; };
    expect(writes("gpt-6-sol")).toEqual([2.5, 2.5]);
    expect(writes("gpt-5.6-sol")).toEqual([5, 5]);
    expect(writes("gpt-5.5")).toEqual([5, 5]);        // no Cache writes column on the page: billed as plain input
    // "pro" models have no cached-input price: cached tokens bill as plain input
    expect(priceFor("gpt-5.5-pro")).toMatchObject({ input: 30, cacheRead: 30, output: 180 });
  });

  test("dated, suffixed, prefixed and upper-case ids resolve to the same price as the plain id", () => {
    const opus55 = priceFor("claude-opus-5-5");
    for (const id of [
      "claude-opus-5-5-20261001", "claude-opus-5-5[1m]", "CLAUDE-OPUS-5-5", "claude-opus-5-5-20261001[1m]",
      "anthropic/claude-opus-5-5", "claude-opus-5-5-latest",
    ]) expect(priceFor(id)).toBe(opus55);
    expect(priceFor("claude-haiku-4-5-20251001")).toBe(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-opus-4-1-20250805")).toBe(priceFor("claude-opus-4-1"));
    expect(priceFor("claude-sonnet-4-20250514")).toBe(priceFor("claude-sonnet-4"));
    expect(priceFor("claude-3-5-haiku-20241022")).toBe(priceFor("claude-haiku-3-5"));
    expect(priceFor("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(priceFor("claude-sonnet-4-5"));
    expect(priceFor("claude-sonnet-4-5@20250929")).toBe(priceFor("claude-sonnet-4-5"));
    expect(priceFor("gpt-5.4-2026-03-05")).toBe(priceFor("gpt-5.4"));
    expect(priceFor("GPT-5.6-Sol")).toBe(priceFor("gpt-5.6-sol"));
    expect(priceFor("openai/gpt-5.5-pro-2026-04-23")).toBe(priceFor("gpt-5.5-pro"));
    // the date strip must not turn one model into another
    expect(priceFor("claude-sonnet-5-20261001")).toBe(priceFor("claude-sonnet-5"));
    expect(priceFor("claude-sonnet-5-20261001")).not.toBe(priceFor("claude-sonnet-5-5"));
    expect(normalizeModelId(" Claude-Opus-5-5-20261001[1m] ")).toBe("claude-opus-5-5");
  });

  test("unknown models are unpriced (null), never $0 and never guessed; overrides win", () => {
    for (const id of ["gpt-nonexistent-9", "gpt-5.4-medium", "gpt-5.6", "gpt-5.2-codex", "gpt-6", "llama-3.3-70b-versatile", "o3-mini", "<synthetic>", "claude-opus-9", ""]) {
      expect(priceFor(id)).toBeNull();
    }
    expect(priceFor(undefined)).toBeNull();
    expect(costOf({ model: "gpt-nonexistent-9", input: M, output: M, cacheRead: M, cacheWrite: 0 })).toBeNull();
    expect(costOf({ model: undefined, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    const o = priceFor("gpt-5.6-sol", { "gpt-5.6": { input: 1.25, output: 10 } })!;
    expect([o.input, o.output, o.cacheRead, o.cacheWrite5m, o.cacheWrite1h]).toEqual([1.25, 10, 0.125, 1.25 * 1.25, 2.5]);
    expect(priceFor("gpt-nonexistent-9", { "NONEXISTENT": { input: 2, output: 3, cacheRead: 0.5 } })).toMatchObject({ input: 2, output: 3, cacheRead: 0.5 });
  });

  test("table integrity: every Anthropic entry lists all five prices, every id is normalized and unique", () => {
    const seen = new Set<string>();
    for (const e of table.models as any[]) {
      if (e.vendor === "anthropic") {
        for (const k of ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"]) expect(typeof e[k]).toBe("number");
        // documented multipliers: 5m write 1.25x, 1h write 2x of the input price
        expect(e.cacheWrite5m).toBeCloseTo(e.input * 1.25, 9);
        expect(e.cacheWrite1h).toBeCloseTo(e.input * 2, 9);
      }
      for (const id of e.ids as string[]) {
        expect(normalizeModelId(id)).toBe(id);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(knownModelIds().length).toBe(seen.size);
    expect(PRICE_TABLE_RETRIEVED).toBe("2026-10-14");
    expect(table.source.anthropic).toContain("platform.claude.com");
    expect(table.source.openai).toContain("developers.openai.com");
  });
});

describe("costOf", () => {
  test("every kind of token is priced at its own per-model rate", () => {
    expect(one("claude-opus-5-5", "input")).toBeCloseTo(4, 9);
    expect(one("claude-opus-5-5", "output")).toBeCloseTo(20, 9);
    expect(one("claude-opus-5-5", "w5m")).toBeCloseTo(5, 9);
    expect(one("claude-opus-5-5", "w1h")).toBeCloseTo(8, 9);
    expect(one("claude-opus-5-5", "cacheRead")).toBeCloseTo(0.2, 9);          // 0.05x, NOT the old fixed 0.1x
    expect(one("claude-opus-5", "cacheRead")).toBeCloseTo(0.5, 9);
    expect(one("claude-fable-5-1", "cacheRead")).toBeCloseTo(0.25, 9);
    expect(one("claude-fable-5", "cacheRead")).toBeCloseTo(1, 9);
    expect(one("claude-sonnet-5-5", "cacheRead")).toBeCloseTo(0.1, 9);
    expect(one("claude-sonnet-5", "cacheRead")).toBeCloseTo(0.2, 9);
    // (1M tokens of one kind is itself a long-context prompt for GPT-5.x: pin the short card)
    expect(one("gpt-5.4", "input", { long: false })).toBeCloseTo(2.5, 9);
    expect(one("gpt-5.4", "cacheRead", { long: false })).toBeCloseTo(0.25, 9);
    expect(one("gpt-5.4", "output", { long: false })).toBeCloseTo(15, 9);
  });

  test("the previous table overstated Opus 5.5 by ~25% (it priced it as Opus 5: $5/$25, read 0.5)", () => {
    const mix = { model: "claude-opus-5-5", input: 1000, output: 100_000, cacheRead: 50 * M, cacheWrite: 2 * M, cacheWrite1h: M };
    const now = costOf(mix)!;
    const old = (1000 * 5 + 100_000 * 25 + M * 5 * 1.25 + M * 5 * 2 + 50 * M * 0.5) / M;
    expect(now).toBeCloseTo((1000 * 4 + 100_000 * 20 + M * 5 + M * 8 + 50 * M * 0.2) / M, 6);
    expect(now / old).toBeGreaterThan(0.45);
    expect(now).toBeLessThan(old);
  });

  test("the projg2 case: a 115k one-off 1h cache write on haiku 4.5 is cents, not 'a lot'", () => {
    // 8 real haiku turns from a 5h window: 68 in, 1,320 out, 817,515 cache-read, 118,595 cache-write (all 1h)
    const c = costOf({ model: "claude-haiku-4-5-20251001", input: 68, output: 1320, cacheRead: 817_515, cacheWrite: 118_595, cacheWrite1h: 118_595 })!;
    expect(c).toBeCloseTo((68 * 1 + 1320 * 5 + 118_595 * 2 + 817_515 * 0.1) / 1e6, 6);
    expect(c).toBeGreaterThan(0.3);
    expect(c).toBeLessThan(0.4);
  });

  test("5m is assumed when the 1h split is unknown; the 1h part never exceeds the write total", () => {
    const base = { model: "claude-sonnet-5", input: 0, output: 0, cacheRead: 0, cacheWrite: M };
    expect(costOf(base)).toBeCloseTo(2.5, 6);
    expect(costOf({ ...base, cacheWrite1h: M })).toBeCloseTo(4, 6);
    expect(costOf({ ...base, cacheWrite1h: 5 * M })).toBeCloseTo(4, 6);
  });

  test("Haiku 5.5: the whole request flips to the second rate card above 100,000 prompt tokens (cache reads and writes count)", () => {
    const req = (cacheRead: number, extra: object = {}) =>
      costOf({ model: "claude-haiku-5-5", input: 0, output: M, cacheRead, cacheWrite: 0, ...extra })!;
    expect(req(100_000)).toBeCloseTo(0.5 + 100_000 * 0.01 / M, 9);          // prompt = 100,000: still short
    expect(req(100_001)).toBeCloseTo(2.5 + 100_001 * 0.05 / M, 9);          // 100,001: long card on EVERYTHING (output too)
    const w = costOf({ model: "claude-haiku-5-5", input: 40_000, output: 0, cacheRead: 30_000, cacheWrite: 31_000, cacheWrite1h: 31_000 })!;
    expect(w).toBeCloseTo((40_000 * 0.5 + 30_000 * 0.05 + 31_000 * 1) / M, 9); // 101,000 total → long
    // a record that is only the output slice of a message carries the request's prompt size
    expect(req(0, { promptTokens: 150_000 })).toBeCloseTo(2.5, 9);
    expect(req(0, { promptTokens: 90_000 })).toBeCloseTo(0.5, 9);
    // a bucket that knows its tier says so explicitly
    expect(req(0, { long: true })).toBeCloseTo(2.5, 9);
    expect(req(200_000, { long: false })).toBeCloseTo(0.5 + 200_000 * 0.01 / M, 9);
    // models without a long-context card are unaffected by prompt size
    expect(costOf({ model: "claude-opus-5-5", input: 0, output: M, cacheRead: 0, cacheWrite: 0, promptTokens: 900_000 })).toBeCloseTo(20, 9);
    expect(isLongContextFor("claude-haiku-5-5", 100_001)).toBe(true);
    expect(isLongContextFor("claude-haiku-5-5", 100_000)).toBe(false);
    expect(isLongContextFor("claude-opus-5-5", 5_000_000)).toBe(false);
  });

  test("Opus 5.5 fast mode: input 8 / output 40, prompt-caching ratios ride on the fast input", () => {
    expect(one("claude-opus-5-5", "input", { fast: true })).toBeCloseTo(8, 9);
    expect(one("claude-opus-5-5", "output", { fast: true })).toBeCloseTo(40, 9);
    expect(one("claude-opus-5-5", "w5m", { fast: true })).toBeCloseTo(10, 9);   // 1.25 x 8
    expect(one("claude-opus-5-5", "w1h", { fast: true })).toBeCloseTo(16, 9);   // 2 x 8
    expect(one("claude-opus-5-5", "cacheRead", { fast: true })).toBeCloseTo(0.4, 9); // Opus 5.5 reads at 0.05x of its input
    // Opus 5 / 4.8: 10 / 50
    for (const m of ["claude-opus-5", "claude-opus-4-8"]) {
      expect(one(m, "input", { fast: true })).toBeCloseTo(10, 9);
      expect(one(m, "output", { fast: true })).toBeCloseTo(50, 9);
      expect(one(m, "w5m", { fast: true })).toBeCloseTo(12.5, 9);
      expect(one(m, "cacheRead", { fast: true })).toBeCloseTo(1, 9);
    }
    // 4.6 "fast" runs and bills at standard; models without a fast card ignore the flag; standard stays standard
    expect(one("claude-opus-4-6", "output", { fast: true })).toBeCloseTo(25, 9);
    expect(one("claude-sonnet-5", "output", { fast: true })).toBeCloseTo(10, 9);
    expect(one("claude-opus-5-5", "output", { fast: false })).toBeCloseTo(20, 9);
    expect(ratesFor(priceFor("claude-opus-5-5")!, { fast: true }).output).toBe(40);
  });

  test("OpenAI long context: only input > 272,000 flips the request to the long card (cached input and output too)", () => {
    const req = (input: number, cached: number) =>
      costOf({ model: "gpt-5.5", input, output: M, cacheRead: cached, cacheWrite: 0 })!;
    expect(req(272_000, 0)).toBeCloseTo((272_000 * 5 + M * 30) / M, 9);       // exactly 272k: short
    expect(req(272_001, 0)).toBeCloseTo((272_001 * 10 + M * 45) / M, 9);      // long: input 10, output 45
    expect(req(100_000, 200_000)).toBeCloseTo((100_000 * 10 + 200_000 * 1 + M * 45) / M, 9); // cached counts toward the prompt; long cached = 1
    expect(costOf({ model: "gpt-5.6-luna", input: 0, output: M, cacheRead: 0, cacheWrite: 0, promptTokens: 300_000 })).toBeCloseTo(1.8, 9);
    expect(costOf({ model: "gpt-5.6-luna", input: 0, output: M, cacheRead: 0, cacheWrite: 0, promptTokens: 272_000 })).toBeCloseTo(1.2, 9);
    expect(costOf({ model: "gpt-6.1-sol", input: 0, output: M, cacheRead: 0, cacheWrite: 0, long: true })).toBeCloseTo(15, 9);
    // gpt-6-sol (official page JS bundle: short 2 / 0.2 / 2.5 / 10, long 4 / 0.4 / 5 / 15 per 1M)
    const sol6 = (over: object) => costOf({ model: "gpt-6-sol", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over })!;
    expect(sol6({ input: M, long: false })).toBeCloseTo(2, 9);
    expect(sol6({ cacheRead: M, long: false })).toBeCloseTo(0.2, 9);
    expect(sol6({ cacheWrite: M, long: false })).toBeCloseTo(2.5, 9);
    expect(sol6({ output: M, long: false })).toBeCloseTo(10, 9);
    expect(sol6({ input: M, long: true })).toBeCloseTo(4, 9);
    expect(sol6({ cacheRead: M, long: true })).toBeCloseTo(0.4, 9);
    expect(sol6({ cacheWrite: M, long: true })).toBeCloseTo(5, 9);
    expect(sol6({ output: M, long: true })).toBeCloseTo(15, 9);
    // long-context cache-write prices of GPT-5.6 (sol 10 / terra 5 / luna 0.50) — previously fell back to the long INPUT price
    for (const [id, w] of [["gpt-5.6-sol", 10], ["gpt-5.6-terra", 5], ["gpt-5.6-luna", 0.5]] as const) {
      expect(costOf({ model: id, input: 0, output: 0, cacheRead: 0, cacheWrite: M, long: true })).toBeCloseTo(w, 9);
    }
    // a model with no long-context card never flips
    expect(costOf({ model: "gpt-5.4-mini", input: 0, output: M, cacheRead: 0, cacheWrite: 0, promptTokens: 900_000 })).toBeCloseTo(4.5, 9);
    // no cached discount on pro models: cached input bills at the input price
    expect(costOf({ model: "gpt-5.4-pro", input: 0, output: 0, cacheRead: 100_000, cacheWrite: 0 })).toBeCloseTo(3, 9);
  });

  test("a model whose LONG-context tier is unpublished: short-context requests are priced, only requests above the threshold are unpriced", () => {
    const synthetic: RawEntry = {
      name: "Synthetic", vendor: "openai", ids: ["gpt-synth"], input: 2, cacheRead: 0.2, output: 10,
      longContext: { thresholdTokens: 272_000, unknown: true },
    };
    const p = buildPriceIndex([synthetic]).get("gpt-synth")!;
    expect(p.longContext).toEqual({ thresholdTokens: 272_000, rates: null });
    const req = (input: number, extra: object = {}) => costOfPrice(p, { input, output: 1000, cacheRead: 0, cacheWrite: 0, ...extra });
    expect(req(272_000)).toBeCloseTo((272_000 * 2 + 1000 * 10) / M, 9);   // exactly at the threshold: priced
    expect(req(272_001)).toBeNull();                                      // above it: unpriced, not guessed, not $0
    expect(req(1, { cacheRead: 300_000 })).toBeNull();                    // cached input counts toward the prompt
    expect(req(1, { promptTokens: 400_000 })).toBeNull();                 // a slice of a long request
    expect(req(10, { long: false })).toBeCloseTo((10 * 2 + 1000 * 10) / M, 9);
    expect(req(10, { long: true })).toBeNull();                           // a rollup bucket that is the long variant
    // a model with no long-context tier at all never becomes unpriced because of its prompt size
    const plain = buildPriceIndex([{ name: "Plain", vendor: "openai", ids: ["gpt-plain"], input: 1, output: 4 }]).get("gpt-plain")!;
    expect(costOfPrice(plain, { input: 900_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.9, 9);
  });

  test("table integrity: every long-context card is complete or explicitly unknown", () => {
    for (const e of table.models as any[]) {
      const lc = e.longContext;
      if (!lc) continue;
      expect(typeof lc.thresholdTokens).toBe("number");
      if (lc.unknown) continue;
      expect(typeof lc.input).toBe("number");
      expect(typeof lc.output).toBe("number");
      expect(lc.input).toBeGreaterThanOrEqual(e.input);        // a long-context card is never cheaper
      expect(lc.output).toBeGreaterThanOrEqual(e.output);
    }
  });
});
