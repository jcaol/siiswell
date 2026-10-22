/**
 * Codex rollouts whose spend arrives without a `turn_context` model in the part being read: the model is taken from the rollout's
 * head (session_meta `payload.model`, else the first turn_context), so fewer rows end up `unknown` (unpriced). Fixtures only.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectUsage } from "../cli/src/usage/collect";
import { codexHeadModel } from "../cli/src/usage/parse";
import { scratchHome } from "./cli-helpers";

const NOW = Date.parse("2026-10-16T12:30:00Z");
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const meta = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: iso(2 * H), type: "session_meta", payload: { cwd: "/w/p", originator: "codex_cli_rs", ...payload } });
const ctx = (model: unknown) => JSON.stringify({ timestamp: iso(2 * H), type: "turn_context", payload: { model, cwd: "/w/p" } });
const tok = (total: number, ago = H) => JSON.stringify({ timestamp: iso(ago), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 60, cached_input_tokens: 10, output_tokens: 40 } } } });

describe("codexHeadModel", () => {
  test("session_meta model, else the first complete turn_context; model_provider alone is not a model", () => {
    expect(codexHeadModel(`${meta({ model: "gpt-5.5", model_provider: "openai" })}\n${tok(1)}\n`)).toBe("gpt-5.5");
    expect(codexHeadModel(`${meta({ model_provider: "openai" })}\n${tok(1)}\n${ctx("gpt-5.4")}\n${ctx("gpt-5.5")}\n`)).toBe("gpt-5.4");
    expect(codexHeadModel(`${meta({ model_provider: "openai" })}\n${tok(1)}\n`)).toBeNull();
    // a turn_context cut off at the end of the head is not parsed
    expect(codexHeadModel(`${meta({})}\n${ctx("gpt-5.5").slice(0, 40)}`)).toBeNull();
    // ids only: anything that is not id-shaped is ignored
    expect(codexHeadModel(`${meta({ model: "a b c" })}\n${ctx("<script>")}\n`)).toBeNull();
    // the instructions text of session_meta (an escaped string) never yields a model
    expect(codexHeadModel(`${meta({ instructions: 'use {"model":"gpt-9"} please' })}\n`)).toBeNull();
  });
});

describe("collector: Codex model from the head", () => {
  const setup = (lines: string[]) => {
    const home = scratchHome();
    const dir = join(home, ".codex", "sessions", "2026", "10", "16");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-x.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    return { home, file, st: join(home, "st") };
  };
  const models = (bank: { daily: Array<{ source: string; model: string }> }) => [...new Set(bank.daily.filter((b) => b.source === "codex").map((b) => b.model))];

  test("a rollout whose model is only in session_meta is priced, not unknown", () => {
    const fx = setup([meta({ model: "gpt-5.5", model_provider: "openai" }), tok(100)]);
    const { bank } = collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    expect(models(bank)).toEqual(["gpt-5.5"]);
    expect(bank.daily.find((b) => b.source === "codex")?.usd).not.toBeNull();
  });

  test("token_count before the first turn_context takes that turn_context's model", () => {
    const fx = setup([meta({ model_provider: "openai" }), tok(100), ctx("gpt-5.5"), tok(200)]);
    const { bank } = collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    expect(models(bank)).toEqual(["gpt-5.5"]);
  });

  test("an incremental read of a file banked without a model (an older collector) looks at the head again", () => {
    const fx = setup([meta({ model_provider: "openai" }), ctx("gpt-5.5"), tok(100)]);
    collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    // what an older collector left behind: an offset but no model for the file
    const sf = join(fx.st, "usage-state.json");
    const state = JSON.parse(readFileSync(sf, "utf8"));
    delete state.files[fx.file].m;
    writeFileSync(sf, JSON.stringify(state));
    appendFileSync(fx.file, `${tok(300, H / 2)}\n`);
    const { bank } = collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    expect(models(bank)).toEqual(["gpt-5.5"]);
  });

  test("no model anywhere stays unknown (never guessed)", () => {
    const fx = setup([meta({ model_provider: "openai" }), tok(100)]);
    const { bank } = collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    expect(models(bank)).toEqual(["unknown"]);
  });

  test("upgrade: Codex rows banked as unknown are re-read once, never counted twice; deleted logs stay as an unknown residual", () => {
    const fx = setup([meta({ model: "gpt-5.5" }), tok(100)]);
    const dir = join(fx.home, ".codex", "sessions", "2026", "10", "16");
    writeFileSync(join(dir, "rollout-gone.jsonl"), `${[meta({ model: "gpt-5.5" }), tok(100, H)].join("\n")}\n`);
    collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    // what an older collector banked: the same spend as `unknown`, under the previous scheme
    const bf = join(fx.st, "usage.json");
    const bank = JSON.parse(readFileSync(bf, "utf8"));
    for (const b of [...bank.daily, ...bank.hourly]) if (b.source === "codex") { b.model = "unknown"; b.usd = null; }
    bank.scheme = "cwd-app-1";
    writeFileSync(bf, JSON.stringify(bank));
    const req = (bk: any) => bk.daily.filter((b: any) => b.source === "codex").reduce((n: number, b: any) => n + b.requests, 0);
    const before = req(bank);
    rmSync(join(dir, "rollout-gone.jsonl")); // its spend is only in the bank now
    const run = collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    expect(run.run.note ?? "").toContain("Codex");
    const after = run.bank;
    expect(req(after)).toBe(before);
    const by = (m: string) => after.daily.filter((b: any) => b.source === "codex" && b.model === m).reduce((n: number, b: any) => n + b.requests, 0);
    expect([by("gpt-5.5"), by("unknown")]).toEqual([1, 1]);
    expect(after.scheme).toBe("cwd-app-2");
    // once only: the next run is incremental and changes nothing
    const again = collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    expect(req(again.bank)).toBe(before);
  });

  test("a head without a model is not searched again every run (only while it is still growing under 256 KB)", () => {
    const pad = JSON.stringify({ timestamp: iso(2 * H), type: "response_item", payload: { text: "x".repeat(300 * 1024) } });
    const fx = setup([meta({ model_provider: "openai" }), pad, tok(100)]);
    collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    const ent = () => JSON.parse(readFileSync(join(fx.st, "usage-state.json"), "utf8")).files[fx.file];
    const first = ent().hm;
    expect(first).toBeGreaterThan(256 * 1024);
    appendFileSync(fx.file, `${tok(200, H / 2)}\n`);
    collectUsage({ home: fx.home, stateDir: fx.st, roots: ["/w"], tz: "UTC", now: NOW });
    expect(ent().hm).toBe(first); // not searched again: the head cannot change any more
    // a small file is searched again only after it grew
    const small = setup([meta({ model_provider: "openai" }), tok(100)]);
    collectUsage({ home: small.home, stateDir: small.st, roots: ["/w"], tz: "UTC", now: NOW });
    const s1 = JSON.parse(readFileSync(join(small.st, "usage-state.json"), "utf8")).files[small.file].hm;
    appendFileSync(small.file, `${ctx("gpt-5.5")}\n${tok(300, H / 2)}\n`);
    const { bank } = collectUsage({ home: small.home, stateDir: small.st, roots: ["/w"], tz: "UTC", now: NOW });
    const st2 = JSON.parse(readFileSync(join(small.st, "usage-state.json"), "utf8")).files[small.file];
    expect(s1).toBeGreaterThan(0);
    expect(st2.m).toBe("gpt-5.5");
    expect(bank.daily.some((b) => b.source === "codex" && b.model === "gpt-5.5")).toBe(true);
  });
});
