// SPDX-License-Identifier: Apache-2.0
/**
 * @file Model price table → estimated API-equivalent cost of a usage record.
 * @module shared/pricing
 *
 * Why this exists: The first usage reports showed "billable tokens" (fresh input +
 * output + cache writes). That number is dominated by ONE-OFF cache writes — a
 * session (re)loading its context writes ~all of it to the prompt cache in a
 * single turn — so a haiku session that re-cached 115k tokens showed "120k in
 * the last 5h" while costing about a quarter. Tokens of different kinds are
 * priced very differently (cache read, output, 1h cache write), so the honest
 * single number is dollars.
 *
 * Prices live in `model-prices.json` — the vendors' OFFICIAL price pages
 * (Anthropic and OpenAI, retrieved 2026-10-14), hand-maintained and cited, never
 * fetched at runtime. Cache read / cache write (5 min and 1 h) / output are
 * priced per model (they are NOT fixed multiples: Opus 5.5 reads the cache at
 * 0.05x its input price, Opus 5 at 0.1x). Two rate-card variants exist:
 *   - fast mode (Opus 5.5 / 5 / 4.8, when the log says `usage.speed == "fast"`)
 *   - long context (Haiku 5.5 above 100k prompt tokens, GPT-5.x above 272k):
 *     decided PER REQUEST from the whole prompt (fresh + cache read + cache write)
 *
 * An unknown model returns null (shown as "unpriced"), never $0 and never a
 * guess; a host-side override lets an operator correct/extend the
 * table without a release. For subscription plans (Claude Max, ChatGPT) this is
 * the API-EQUIVALENT value of the usage, not what is billed.
 */

import table from "./model-prices.json";

/** A complete rate card, USD per 1M tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** What `priceFor` resolves a model to. */
export interface ModelPrice extends Rates {
  /** table name, e.g. "Opus 5.5" ("override" for pricingOverrides) */
  name?: string;
  vendor?: "anthropic" | "openai" | "override";
  /** Anthropic fast-mode price (input / output), when the model has one */
  fast?: { input: number; output: number };
  /**
   * second rate card for requests whose prompt exceeds `thresholdTokens`. `rates: null` = the page does not publish that
   * tier: short-context requests are still priced, only requests ABOVE the threshold are unpriced (null), never guessed.
   */
  longContext?: { thresholdTokens: number; rates: Rates | null };
}

/** The shape of a `pricingOverrides` entry (config). Cache read defaults to 0.1 x input. */
export interface ModelPriceOverride {
  input: number;
  output: number;
  cacheRead?: number;
}

/** Cache multipliers on the input price, used ONLY for operator overrides that give just input/output. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2.0;
export const CACHE_READ_MULT = 0.1;

// ── the table ────────────────────────────────────────────────────────

export interface RawRates { input: number; output: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number }
export interface RawEntry extends RawRates {
  name: string;
  vendor: "anthropic" | "openai";
  ids: string[];
  fast?: { input: number; output: number };
  /** `unknown: true` = the long-context prices are not published (see ModelPrice.longContext) */
  longContext?: (RawRates & { thresholdTokens: number }) | { thresholdTokens: number; unknown: true };
}
interface RawTable { retrieved: string; source: Record<string, string>; models: RawEntry[] }

const RAW = table as unknown as RawTable;

/** Date the table was copied from the vendors' price pages. */
export const PRICE_TABLE_RETRIEVED: string = RAW.retrieved;
export const PRICE_TABLE_SOURCES: Record<string, string> = RAW.source;

/** Missing cache fields mean "no separate cache price": billed as plain input (OpenAI has no cache-write premium). */
function ratesOf(r: RawRates): Rates {
  return {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead ?? r.input,
    cacheWrite5m: r.cacheWrite5m ?? r.input,
    cacheWrite1h: r.cacheWrite1h ?? r.input,
  };
}

/** id → price for a list of table entries (exported so the "unknown long-context tier" rule can be tested on a synthetic table). */
export function buildPriceIndex(models: RawEntry[]): Map<string, ModelPrice> {
  const idx = new Map<string, ModelPrice>();
  for (const e of models) {
    const price: ModelPrice = { ...ratesOf(e), name: e.name, vendor: e.vendor };
    if (e.fast) price.fast = { input: e.fast.input, output: e.fast.output };
    if (e.longContext) {
      const lc = e.longContext;
      price.longContext = { thresholdTokens: lc.thresholdTokens, rates: "unknown" in lc ? null : ratesOf(lc) };
    }
    for (const id of e.ids) idx.set(id, price);
  }
  return idx;
}
const INDEX = buildPriceIndex(RAW.models);

/** Every normalized model id the table knows (for tests and tooling). */
export function knownModelIds(): string[] {
  return [...INDEX.keys()];
}

/**
 * Canonical form of a model id as found in a transcript: lower-case, without
 * `[1m]` / `-latest` / dated-snapshot suffixes, vendor prefixes (`anthropic/`,
 * Bedrock `us.anthropic.…-v1:0`, Vertex `@20250514`), and with legacy
 * `claude-3-5-haiku` spelled `claude-haiku-3-5`.
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  id = id.replace(/\[[^\]]*\]\s*$/, "");
  id = id.replace(/^(?:[a-z0-9._-]+\/)+/, "");
  id = id.replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
  id = id.replace(/-v\d+(?::\d+)?$/, "");
  id = id.replace(/@\d{8}$/, "");
  id = id.replace(/-latest$/, "");
  id = id.replace(/-(?:20\d{6}|20\d{2}-\d{2}-\d{2})$/, "");
  const legacy = id.match(/^claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)$/);
  if (legacy) id = `claude-${legacy[3]}-${legacy[1]}${legacy[2] ? `-${legacy[2]}` : ""}`;
  return id;
}

function fromOverride(o: ModelPriceOverride): ModelPrice {
  return {
    input: o.input,
    output: o.output,
    cacheRead: o.cacheRead ?? o.input * CACHE_READ_MULT,
    cacheWrite5m: o.input * CACHE_WRITE_5M,
    cacheWrite1h: o.input * CACHE_WRITE_1H,
    name: "override",
    vendor: "override",
  };
}

/** Price of a model id (null = unpriced). Operator overrides (substring of the id) win over the table. */
export function priceFor(model: string | undefined, overrides: Record<string, ModelPriceOverride> = {}): ModelPrice | null {
  if (!model) return null;
  const id = model.toLowerCase();
  for (const [key, p] of Object.entries(overrides)) if (key && id.includes(key.toLowerCase())) return fromOverride(p);
  return INDEX.get(normalizeModelId(model)) ?? null;
}

/** True when a request with this prompt size is billed on the model's long-context rate card. */
export function isLongContext(price: ModelPrice | null, promptTokens: number): boolean {
  return !!price?.longContext && promptTokens > price.longContext.thresholdTokens;
}

/** Same, by model id (used by the rollup to decide the bucket variant at ingest time). */
export function isLongContextFor(model: string | undefined, promptTokens: number, overrides: Record<string, ModelPriceOverride> = {}): boolean {
  return isLongContext(priceFor(model, overrides), promptTokens);
}

/**
 * The rate card actually applied: long-context card if `long`, then the fast-mode scaling if `fast` and the model has one.
 * (A model whose long-context tier is unpublished has no card for it: costOfPrice returns null before asking.)
 */
export function ratesFor(price: ModelPrice, opts: { fast?: boolean; long?: boolean } = {}): Rates {
  const base = opts.long && price.longContext?.rates ? price.longContext.rates : price;
  if (!opts.fast || !price.fast) return base;
  // fast mode replaces the standard input/output price; the prompt-caching ratios ride on top of the fast input.
  const kIn = price.fast.input / price.input;
  const kOut = price.fast.output / price.output;
  return {
    input: base.input * kIn,
    output: base.output * kOut,
    cacheRead: base.cacheRead * kIn,
    cacheWrite5m: base.cacheWrite5m * kIn,
    cacheWrite1h: base.cacheWrite1h * kIn,
  };
}

export interface CostInput {
  model?: string;
  input: number;       // fresh (non-cached) input tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;  // all cache-write tokens
  /** the part of cacheWrite that used the 1h TTL; the rest is treated as 5m */
  cacheWrite1h?: number;
  /** the request ran in fast mode (usage.speed == "fast") */
  fast?: boolean;
  /**
   * Size of the WHOLE request prompt (fresh + cache read + cache write; for OpenAI the input incl. cached). Needed
   * when the record is only a slice of a request (a later content block of the same message carries just the output
   * growth). Defaults to this record's own input + cacheRead + cacheWrite.
   */
  promptTokens?: number;
  /** Decide the long-context tier explicitly (rollup buckets carry it as their variant); overrides promptTokens. */
  long?: boolean;
}

/** Estimated USD for one usage record, or null when the model has no known price. */
export function costOf(r: CostInput, overrides: Record<string, ModelPriceOverride> = {}): number | null {
  const p = priceFor(r.model, overrides);
  return p ? costOfPrice(p, r) : null;
}

/** Same for an already resolved price. null when the request falls in a long-context tier the vendor does not publish. */
export function costOfPrice(p: ModelPrice, r: CostInput): number | null {
  const long = r.long ?? isLongContext(p, r.promptTokens ?? r.input + r.cacheRead + r.cacheWrite);
  if (long && p.longContext && !p.longContext.rates) return null;
  const rt = ratesFor(p, { fast: r.fast, long });
  const w1h = Math.min(r.cacheWrite1h ?? 0, r.cacheWrite);
  const w5m = r.cacheWrite - w1h;
  return (
    r.input * rt.input +
    r.output * rt.output +
    w5m * rt.cacheWrite5m +
    w1h * rt.cacheWrite1h +
    r.cacheRead * rt.cacheRead
  ) / 1_000_000;
}

export function fmtUSD(n: number): string {
  if (n < 0.005) return n === 0 ? "$0" : "<$0.01";
  return n < 10 ? `$${n.toFixed(2)}` : n < 1000 ? `$${n.toFixed(1)}` : `$${Math.round(n).toLocaleString("en-US")}`;
}
