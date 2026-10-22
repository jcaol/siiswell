#!/usr/bin/env bun
/**
 * Fill a FRESH local siiswell database with demo data, for screenshots and trying the dashboard out.
 *
 *   # 1. start a local server on its own, empty database file (Bun mode; it creates the file and applies the migrations)
 *   PUBLIC_URL=http://127.0.0.1:18731 PORT=18731 DB_PATH=/tmp/demo/demo.sqlite \
 *     AUTH_MODE=proxy TRUSTED_PROXY_CIDRS=127.0.0.1/32 ALLOWED_EMAILS=demo@example.com bun src/server/bun.ts
 *   # 2. seed it (same file, same URL)
 *   bun scripts/demo-seed.ts --db /tmp/demo/demo.sqlite --url http://127.0.0.1:18731 [--tz UTC] [--seed 7]
 *   # 3. open the dashboard (proxy mode: send the header X-Forwarded-Email: demo@example.com, e.g. from a test browser)
 *
 * What it writes (all times relative to "now", so the dashboard always looks current):
 *  - three machines (laptop-1, studio, build-box) as host tokens and six app clients (Claude Code, Codex, Claude Desktop,
 *    Gemini CLI, an API client) as client tokens. Tokens are random, kept in memory only and never printed.
 *  - 12 months of daily usage and 90 days of hourly usage per machine / app / project / model, with a weekday rhythm,
 *    a slow growth over the year, short holidays and nightly automation on build-box (direct SQL, same tables and
 *    columns the usage ingest writes; costs from the real price table).
 *  - 90 days of the operator's hourly input counts (the hooks' numbers only), 30 days of well-being hourly metrics and a
 *    week of resolved interruptions, so the well-being view has history.
 *  - current work through the REAL MCP endpoint (report_task / update_task) and host heartbeats through the real ingest
 *    API, then the task and event times are spread over the last hours.
 *
 * Safety: it only opens the file given by --db (or DEMO_DB) and only talks to a localhost --url. It refuses a database
 * that already has tokens in it (it is meant for a fresh demo file, never for a real deployment).
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SqliteD1 } from "../src/server/d1-sqlite";
import { costOf } from "../src/shared/pricing";
import { CLIENT_HEADER } from "../src/shared/semver";
import { localTime } from "../src/wellbeing";
import { localHourStart, addDay } from "../src/wellbeing-metrics";

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: bun scripts/demo-seed.ts --db <fresh.sqlite> --url http://127.0.0.1:<port> [--tz <IANA zone>] [--seed <n>]");
  process.exit(0);
}
const dbArg = arg("db") ?? process.env.DEMO_DB;
const base = (arg("url") ?? process.env.DEMO_URL ?? "").replace(/\/+$/, "");
const TZ = arg("tz") ?? process.env.DASHBOARD_TZ ?? "UTC";
const SEED = Number(arg("seed") ?? 7);
if (!dbArg) fail("--db <path> is required: a fresh local database file (the one the local demo server uses)");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) fail(`--url must be a local http://127.0.0.1:<port> or http://localhost:<port> server, got: ${base || "(none)"}`);
const dbPath = resolve(dbArg);
if (!existsSync(dbPath)) fail(`${dbPath} does not exist: start the local server on it first (it creates the file)`);
try {
  new Intl.DateTimeFormat("en", { timeZone: TZ });
} catch {
  fail(`unknown time zone: ${TZ}`);
}

function fail(msg: string): never {
  console.error(`demo-seed: ${msg}`);
  process.exit(2);
}

// ── deterministic randomness ────────────────────────────────────────────────

let rs = (SEED >>> 0) || 1;
const rnd = (): number => {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number): number => a + (b - a) * rnd();
const int = (a: number, b: number): number => Math.floor(between(a, b + 1));
const pick = <T>(list: ReadonlyArray<readonly [T, number]>): T => {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let x = rnd() * total;
  for (const [v, w] of list) if ((x -= w) <= 0) return v;
  return list[list.length - 1]![0];
};
const noise = (spread = 0.35): number => Math.exp((rnd() - 0.5) * 2 * spread);

// ── database ─────────────────────────────────────────────────────────────────

// look first, read-only: opening the adapter applies the migrations, which must never happen to a real database
if (existsSync(dbPath)) {
  const peek = new Database(dbPath, { readonly: true });
  const hasSources = peek.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sources'").get() !== null;
  const existing = hasSources ? (peek.query("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n : 0;
  peek.close();
  if (existing > 0) fail(`${dbPath} already has ${existing} token(s): this script only seeds a fresh demo database`);
}
const adapter = new SqliteD1({ path: dbPath, migrationsDir: join(import.meta.dir, "..", "migrations") });
const db = adapter.sqlite;

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VERSION = "0.6.0";
const lt = localTime(NOW, TZ);
const TODAY = lt.day;
const NOW_HOUR = lt.hour;

async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
const newToken = (): string => "oct_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

// ── machines, apps, projects ─────────────────────────────────────────────────

const HOSTS = ["laptop-1", "studio", "build-box"] as const;
type Host = (typeof HOSTS)[number];

/** MCP clients: one token per app and machine; `agent` is the label the app reports tasks under. */
const CLIENTS = [
  { name: "laptop-1.claude-code", machine: "laptop-1", agent: "claude" },
  { name: "laptop-1.codex", machine: "laptop-1", agent: "codex" },
  { name: "studio.claude-code", machine: "studio", agent: "claude" },
  { name: "studio.claude-desktop", machine: "studio", agent: "desktop" },
  { name: "build-box.gemini-cli", machine: "build-box", agent: "gemini" },
  { name: "build-box.api-client", machine: "build-box", agent: "nightly" },
] as const;

const tokens = new Map<string, string>();
const sourceIds = new Map<string, string>();
{
  const ins = db.prepare("INSERT INTO sources (id, name, kind, token_sha256, created, client_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6)");
  for (const [name, kind] of [...HOSTS.map((h) => [h, "host"] as const), ...CLIENTS.map((c) => [c.name, "client"] as const)]) {
    const t = newToken();
    const id = crypto.randomUUID();
    tokens.set(name, t);
    sourceIds.set(name, id);
    ins.run(id, name, kind, await sha256(t), NOW - 320 * DAY, VERSION);
  }
}

// ── the operator's working hours (drives the interactive apps, the input counts and the well-being history) ──

interface DayPlan { day: string; weekday: number; hours: Map<number, number>; machine: Map<number, Host> }

const DAYS = 365;
const firstDay = addDay(TODAY, -(DAYS - 1));
const weekdayOf = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();
/** Holidays: two weeks in summer, the days around the new year, a long weekend in spring (low or no activity). */
const holiday = (day: string): number => {
  const md = day.slice(5);
  if (md >= "08-04" && md <= "08-17") return 0.05;
  if (md >= "12-24" && md <= "12-31") return 0.08;
  if (md >= "04-03" && md <= "04-06") return 0.1;
  return 1;
};

function planDay(day: string, index: number): DayPlan {
  const weekday = weekdayOf(day);
  const hours = new Map<number, number>();
  const machine = new Map<number, Host>();
  const h = holiday(day);
  const isToday = day === TODAY;
  if (h < 1 && rnd() > h * 4) return { day, weekday, hours, machine };
  const weekend = weekday === 0 || weekday === 6;
  if (weekend && !isToday) {
    if (rnd() < 0.3) for (const hh of [10, 11].slice(0, int(1, 2))) hours.set(hh, between(0.2, 0.5));
  } else {
    const start = isToday ? 9 : pick([[8, 2], [9, 5], [10, 2]] as const);
    const end = isToday ? NOW_HOUR : pick([[16, 2], [17, 5], [18, 3]] as const);
    for (let hh = start; hh <= end; hh++) {
      if (hh === 12 && rnd() < 0.85) continue; // lunch
      hours.set(hh, between(0.55, 1) * (hh === start || hh === end ? 0.7 : 1));
    }
    if (isToday) {
      hours.delete(12);
      hours.delete(NOW_HOUR - 2); // a real break this afternoon: today's session reads calm
    } else if (rnd() < 0.12) hours.set(int(20, 21), between(0.2, 0.4)); // an occasional short evening hour
  }
  // studio on Tuesday and Thursday afternoons, laptop-1 otherwise (and today, so today stays on a few projects)
  for (const hh of hours.keys()) machine.set(hh, !isToday && (weekday === 2 || weekday === 4) && hh >= 13 ? "studio" : "laptop-1");
  void index;
  return { day, weekday, hours, machine };
}

const plans: DayPlan[] = [];
for (let i = 0; i < DAYS; i++) plans.push(planDay(addDay(firstDay, i), i));

// ── usage ────────────────────────────────────────────────────────────────────

interface Stream {
  host: Host;
  agent: string;
  source: "claude" | "codex";
  projects: ReadonlyArray<readonly [string, number]>;
  /** the models in use, by age of the day (days ago) */
  models: (daysAgo: number) => ReadonlyArray<readonly [string, number]>;
  /** requests per full-intensity hour */
  rate: number;
  /** interactive (follows the operator) or automation (its own schedule) */
  mode: "operator" | "nightly" | "ci";
  /** share of the operator's hours on this stream's machine it is used in */
  share: number;
}

const claudeModels = (daysAgo: number): ReadonlyArray<readonly [string, number]> =>
  daysAgo > 240 ? [["claude-opus-4-6", 5], ["claude-sonnet-4-6", 4], ["claude-haiku-4-5", 1]]
  : daysAgo > 120 ? [["claude-opus-4-8", 6], ["claude-sonnet-5", 3], ["claude-haiku-4-5", 1]]
  : daysAgo > 18 ? [["claude-opus-5", 6], ["claude-sonnet-5-5", 3], ["claude-haiku-5-5", 1]]
  : [["claude-opus-5-5", 7], ["claude-sonnet-5-5", 3], ["claude-haiku-5-5", 1]];
const codexModels = (daysAgo: number): ReadonlyArray<readonly [string, number]> =>
  daysAgo > 200 ? [["gpt-5.2", 3], ["gpt-5-mini", 1]] : daysAgo > 60 ? [["gpt-5.4", 4], ["gpt-5.4-mini", 1]] : [["gpt-6.1-sol", 4], ["gpt-5.6-luna", 1]];

const STREAMS: Stream[] = [
  { host: "laptop-1", agent: "claude-cli", source: "claude", projects: [["web-shop", 5], ["api-gateway", 4], ["mobile-app", 2]], models: claudeModels, rate: 110, mode: "operator", share: 0.9 },
  { host: "laptop-1", agent: "codex-cli", source: "codex", projects: [["web-shop", 3], ["api-gateway", 2]], models: codexModels, rate: 55, mode: "operator", share: 0.45 },
  { host: "laptop-1", agent: "claude-ide", source: "claude", projects: [["mobile-app", 3], ["web-shop", 1]], models: claudeModels, rate: 30, mode: "operator", share: 0.3 },
  { host: "studio", agent: "claude-desktop", source: "claude", projects: [["docs-site", 4], ["mobile-app", 2]], models: claudeModels, rate: 40, mode: "operator", share: 0.8 },
  { host: "studio", agent: "claude-cli", source: "claude", projects: [["mobile-app", 3], ["docs-site", 2]], models: claudeModels, rate: 80, mode: "operator", share: 0.75 },
  { host: "build-box", agent: "claude-sdk", source: "claude", projects: [["data-pipeline", 4], ["api-gateway", 1]], models: (d) => claudeModels(d).filter(([m]) => !m.includes("opus")), rate: 60, mode: "nightly", share: 1 },
  { host: "build-box", agent: "codex-exec", source: "codex", projects: [["api-gateway", 2], ["web-shop", 2]], models: codexModels, rate: 30, mode: "ci", share: 1 },
];

interface Counters { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number; requests: number; usd: number | null }
const hourly = new Map<string, Counters>(); // key: hour \t host \t project \t agent \t source \t model
const daily = new Map<string, Counters>(); // key: day \t host \t project \t agent \t source \t model

function addRow(map: Map<string, Counters>, key: string, c: Counters): void {
  const t = map.get(key);
  if (!t) map.set(key, { ...c });
  else {
    t.input += c.input; t.output += c.output; t.cacheRead += c.cacheRead; t.cw5m += c.cw5m; t.cw1h += c.cw1h; t.requests += c.requests;
    t.usd = t.usd === null || c.usd === null ? null : t.usd + c.usd;
  }
}

function counters(s: Stream, model: string, requests: number): Counters {
  const r = requests;
  const c: Counters = s.source === "codex"
    ? { input: Math.round(r * between(2500, 4500)), output: Math.round(r * between(500, 1100)), cacheRead: Math.round(r * between(25_000, 45_000)), cw5m: 0, cw1h: 0, requests: r, usd: 0 }
    : { input: Math.round(r * between(60, 260)), output: Math.round(r * between(450, 1200)), cacheRead: Math.round(r * between(45_000, 85_000)), cw5m: Math.round(r * between(1800, 4200)), cw1h: s.agent === "claude-sdk" ? 0 : Math.round(r * between(0, 600)), requests: r, usd: 0 };
  c.usd = costOf({ model, input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cw5m + c.cw1h, cacheWrite1h: c.cw1h, long: false });
  return c;
}

const hourKey = (day: string, h: number): string => `${day}T${String(h).padStart(2, "0")}`;
const hourlyFrom = addDay(TODAY, -89);

plans.forEach((p, i) => {
  const daysAgo = DAYS - 1 - i;
  const growth = 0.45 + 0.55 * (i / (DAYS - 1)); // adoption grows over the year
  const isToday = p.day === TODAY;
  for (const s of STREAMS) {
    const hours: Array<[number, number]> = [];
    if (s.mode === "operator") {
      // (today the main CLI is in every working hour, so the hour chart reads as one plain working day)
      for (const [h, w] of p.hours) if (p.machine.get(h) === s.host && ((isToday && s.agent === "claude-cli") || rnd() < s.share)) hours.push([h, w]);
    } else if (s.mode === "nightly") {
      if (!isToday && (holiday(p.day) === 1 || rnd() < 0.5)) for (const h of [2, 3]) hours.push([h, between(0.6, 1)]);
    } else {
      // CI: follows the working day loosely (pull requests), lighter
      for (const [h] of p.hours) if (rnd() < 0.35) hours.push([h, between(0.3, 0.8)]);
    }
    for (const [h, w] of hours) {
      if (isToday && h > NOW_HOUR) continue;
      const partial = isToday && h === NOW_HOUR ? Math.max(0.15, lt.minute / 60) : 1;
      const requests = Math.max(1, Math.round(s.rate * w * growth * noise() * partial));
      // one focus project per hour, sometimes a second one
      const projects = [pick(s.projects)];
      if (rnd() < 0.25) projects.push(pick(s.projects));
      for (const [j, project] of projects.entries()) {
        const model = pick(s.models(daysAgo));
        const part = projects.length === 1 ? requests : j === 0 ? Math.ceil(requests * 0.7) : Math.max(1, Math.floor(requests * 0.3));
        const c = counters(s, model, part);
        const tail = [s.host, project, s.agent, s.source, model].join("\t");
        addRow(daily, `${p.day}\t${tail}`, c);
        if (p.day >= hourlyFrom) addRow(hourly, `${hourKey(p.day, h)}\t${tail}`, c);
      }
    }
  }
});

{
  const insD = db.prepare(`INSERT INTO usage_daily (day, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`);
  const insH = db.prepare(`INSERT INTO usage_hourly (hour, host, project, agent, source, model, input, output, cache_read, cache_write_5m, cache_write_1h, requests, usd, updated)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`);
  const write = (stmt: typeof insD, map: Map<string, Counters>) => {
    for (const [k, c] of map) {
      const [when, host, project, agent, source, model] = k.split("\t");
      stmt.run(when!, host!, project!, agent!, source!, model!, c.input, c.output, c.cacheRead, c.cw5m, c.cw1h, c.requests, c.usd === null ? null : Math.round(c.usd * 1e6) / 1e6, NOW - 5 * 60_000);
    }
  };
  db.transaction(() => {
    write(insD, daily);
    write(insH, hourly);
    const insHost = db.prepare("INSERT INTO usage_hosts (host, pushed_at, generated_at, tz, has_full, win_start, win_count) VALUES (?1, ?2, ?3, ?4, 1, ?5, 0)");
    for (const h of HOSTS) insHost.run(h, NOW - int(2, 9) * 60_000, NOW - int(10, 14) * 60_000, TZ, NOW - HOUR);
  })();
}

// ── the operator's input (hourly counts of the hooks: numbers only) ─────────

{
  const ins = db.prepare(`INSERT INTO human_hourly (source_id, hour, prompts, approvals, rapid, rapid_min, lat_n, lat_p50_ms, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`);
  const from = addDay(TODAY, -89);
  db.transaction(() => {
    for (const p of plans) {
      if (p.day < from) continue;
      for (const [h, w] of p.hours) {
        if (p.day === TODAY && h > NOW_HOUR) continue;
        const client = p.machine.get(h) === "studio" ? "studio.claude-code" : "laptop-1.claude-code";
        const prompts = Math.max(1, Math.round(between(5, 14) * w));
        const approvals = Math.round(between(2, 8) * w);
        const rapid = rnd() < 0.08 ? 1 : 0;
        ins.run(sourceIds.get(client)!, localHourStart(p.day, h, TZ), prompts, approvals, rapid, rapid ? int(2, 6) : 0, approvals, approvals ? Math.round(between(28_000, 75_000)) : null, NOW);
      }
    }
  })();
}

// ── well-being history: hourly metrics (30 days), a week of resolved interruptions, a few self-ratings ──────

const PROJECT_OF_MACHINE: Record<string, string[]> = { "laptop-1": ["web-shop", "api-gateway", "mobile-app"], studio: ["docs-site", "mobile-app"] };
{
  const insM = db.prepare("INSERT INTO wb_metrics (day, hour, name, value) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(day, hour, name) DO UPDATE SET value = excluded.value");
  const insA = db.prepare(`INSERT INTO alerts (key, rule, severity, origin, host, project, agent, text, opened, last_pushed, push_count, resolved, since)
    VALUES (?1, ?2, 'warn', 'mcp', ?3, ?4, ?5, ?6, ?7, ?7, 1, ?8, ?7)`);
  const from = addDay(TODAY, -29);
  let n = 0;
  db.transaction(() => {
    for (const p of plans) {
      if (p.day < from) continue;
      for (let h = 0; h < 24; h++) {
        if (p.day === TODAY && h >= NOW_HOUR) break; // the server's own ticker writes the current hour
        const w = p.hours.get(h);
        const active = w !== undefined;
        let interrupts = 0;
        if (active && rnd() < 0.35 * w) {
          interrupts = rnd() < 0.8 ? 1 : 2;
          if (p.day >= addDay(TODAY, -6)) {
            const machine = p.machine.get(h)!;
            const client = machine === "studio" ? "studio.claude-code" : "laptop-1.claude-code";
            for (let k = 0; k < interrupts; k++) {
              const opened = localHourStart(p.day, h, TZ) + int(2, 50) * 60_000;
              const rule = rnd() < 0.6 ? "approval-waiting" : "blocked";
              insA.run(`demo:${rule}:${++n}`, rule, client, pick((PROJECT_OF_MACHINE[machine] ?? ["web-shop"]).map((x) => [x, 1] as const)), "claude", rule === "blocked" ? "Blocked: task" : "Approval pending", opened, Math.min(NOW - 60_000, opened + int(3, 25) * 60_000));
            }
          }
        }
        // build-box's nightly runs are automation, not the operator: they never count as active hours here
        insM.run(p.day, h, "active", active ? 1 : 0);
        insM.run(p.day, h, "interrupts", interrupts);
        insM.run(p.day, h, "waiting", active && rnd() < 0.2 ? 1 : 0);
        insM.run(p.day, h, "projects", active ? int(1, 3) : 0);
        if (active) {
          insM.run(p.day, h, "stress", Math.round(between(14, 38) * (0.6 + 0.4 * w)));
          insM.run(p.day, h, "stressYou", Math.round(between(16, 40) * (0.6 + 0.4 * w)));
          // the indicators behind the stress reading (normalised 0-100), for the radar's 7-day average
          if (p.day >= addDay(TODAY, -6)) {
            for (const [name, lo, hi] of [["interrupts", 0, 30], ["concurrency", 0, 35], ["fanOut", 10, 45], ["session", 5, 50], ["offHours", 0, 0], ["burn", 15, 45], ["limit", 10, 40], ["retry", 0, 15]] as const) {
              insM.run(p.day, h, `n:${name}`, Math.round(between(lo, hi)));
            }
          }
        }
      }
      // one-tap self-ratings (1 calm, 2 fine, 3 tense) on some days, and today's
      if (p.day === TODAY) insM.run(p.day, -1, "rating", 1);
      else if (p.hours.size && rnd() < 0.55) insM.run(p.day, -1, "rating", rnd() < 0.55 ? 1 : rnd() < 0.85 ? 2 : 3);
    }
  })();
}

// ── live state through the real API: host heartbeats, MCP tasks ─────────────

async function post(path: string, token: string, body: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", [CLIENT_HEADER]: VERSION },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

for (const h of HOSTS) await post("/api/ingest/heartbeat", tokens.get(h)!, { v: 1, host: h, at: Date.now(), binaryVersion: `siiswell-cli ${VERSION}` });

let rpc = 0;
async function tool(client: string, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await post("/mcp", tokens.get(client)!, { jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } });
  const out = r?.result;
  if (!out || out.isError) throw new Error(`${name} failed: ${JSON.stringify(r).slice(0, 300)}`);
  const text = String(out.content?.[0]?.text ?? "");
  return text.startsWith("{") ? JSON.parse(text) : text;
}

type Status = "IN_PROGRESS" | "BLOCKED" | "DONE";
interface DemoTask { client: (typeof CLIENTS)[number]["name"]; project: string; title: string; kind: string; status: Status; startedMin: number; atMin?: number; etaMin?: number; summary?: string }

/**
 * Times in minutes before now. `atMin` is the last update (blocked / finished). Everything is either in the last hour or
 * more than 200 minutes ago, so today's activity has a real break in it (the session and fan-out read calm).
 */
const TASKS: DemoTask[] = [
  // working now
  { client: "laptop-1.claude-code", project: "api-gateway", title: "Add pagination to orders API", kind: "coding", status: "IN_PROGRESS", startedMin: 38, etaMin: 20 },
  { client: "laptop-1.codex", project: "web-shop", title: "Move checkout form to the new validation", kind: "coding", status: "IN_PROGRESS", startedMin: 51, etaMin: 35 },
  { client: "laptop-1.claude-code", project: "mobile-app", title: "Fix flaky login test", kind: "debugging", status: "IN_PROGRESS", startedMin: 17, etaMin: 12 },
  { client: "build-box.gemini-cli", project: "web-shop", title: "Review this week's dependency updates", kind: "review", status: "IN_PROGRESS", startedMin: 9, etaMin: 15 },
  { client: "studio.claude-desktop", project: "docs-site", title: "Draft the upgrade guide for v2", kind: "docs", status: "IN_PROGRESS", startedMin: 236, etaMin: 40 },
  { client: "build-box.api-client", project: "data-pipeline", title: "Backfill the daily revenue table", kind: "ops", status: "IN_PROGRESS", startedMin: 262, etaMin: 55 },
  // waiting for the operator
  { client: "laptop-1.claude-code", project: "mobile-app", title: "Confirm the profile table migration", kind: "ops", status: "BLOCKED", startedMin: 33, atMin: 21, summary: "Migration is ready and tested on a copy; needs an OK to run." },
  { client: "laptop-1.claude-code", project: "api-gateway", title: "Choose the default rate limit for public routes", kind: "research", status: "BLOCKED", startedMin: 286, atMin: 248, summary: "Two options are written up; waiting for a decision." },
  // finished in the last 24 h
  { client: "laptop-1.codex", project: "mobile-app", title: "Update app icons for dark mode", kind: "coding", status: "DONE", startedMin: 56, atMin: 31 },
  { client: "build-box.gemini-cli", project: "api-gateway", title: "Summarise open pull requests", kind: "review", status: "DONE", startedMin: 222, atMin: 211 },
  { client: "laptop-1.claude-code", project: "web-shop", title: "Speed up product image loading", kind: "coding", status: "DONE", startedMin: 312, atMin: 268 },
  { client: "laptop-1.codex", project: "api-gateway", title: "Add tests for token refresh", kind: "testing", status: "DONE", startedMin: 355, atMin: 318 },
  { client: "studio.claude-desktop", project: "docs-site", title: "Fix broken links in the API reference", kind: "docs", status: "DONE", startedMin: 410, atMin: 384 },
  { client: "laptop-1.claude-code", project: "web-shop", title: "Look into slow search queries", kind: "research", status: "DONE", startedMin: 470, atMin: 422 },
  { client: "build-box.api-client", project: "data-pipeline", title: "Add retries to the nightly export", kind: "coding", status: "DONE", startedMin: 15 * 60, atMin: 15 * 60 - 40 },
];

const machineOf = (client: string) => CLIENTS.find((c) => c.name === client)!;
const done: Array<{ task: DemoTask; id: string }> = [];
for (const t of TASKS) {
  const c = machineOf(t.client);
  const first: Status = t.status === "DONE" ? "IN_PROGRESS" : t.status;
  const r = await tool(t.client, "report_task", {
    project: t.project, title: t.title, kind: t.kind, status: first, agent: c.agent, machine: c.machine,
    ...(first === "IN_PROGRESS" && t.etaMin ? { eta_min: t.etaMin } : {}), ...(t.summary ? { summary: t.summary } : {}),
  });
  if (t.status === "DONE") await tool(t.client, "update_task", { task_id: r.task_id, status: "DONE" });
  done.push({ task: t, id: r.task_id });
}
for (const c of CLIENTS) await tool(c.name, "heartbeat", {});

// spread the times: started N minutes ago, finished M minutes ago, ETA still ahead
{
  const upTask = db.prepare("UPDATE tasks SET created = ?1, updated = ?2, eta_at = ?3 WHERE task_id = ?4 AND origin = 'mcp'");
  const evs = db.prepare("SELECT key FROM events WHERE key LIKE ?1 ORDER BY at, key");
  const upEv = db.prepare("UPDATE events SET at = ?1, received_at = ?1 WHERE key = ?2");
  db.transaction(() => {
    for (const { task: t, id } of done) {
      const started = NOW - t.startedMin * 60_000;
      const ended = t.atMin !== undefined ? NOW - t.atMin * 60_000 : started;
      const eta = t.status === "IN_PROGRESS" && t.etaMin ? NOW + t.etaMin * 60_000 : null;
      upTask.run(started, ended, eta, id);
      const keys = (evs.all(`mcp:${id}:%`) as Array<{ key: string }>).map((e) => e.key);
      keys.forEach((k, i) => upEv.run(i === 0 ? started : ended, k));
    }
  })();
}

// The rules open an alert for each blocked task (at once, or at the server's next minute tick): date those from when
// the task became blocked too. Waits at most ~2.5 minutes for the tick.
{
  const blocked = done.filter((d) => d.task.status === "BLOCKED").map((d) => ({ key: `blocked|${d.task.client}|${d.task.project}|${d.id}`, at: NOW - (d.task.atMin ?? 0) * 60_000 }));
  const has = db.prepare("SELECT 1 FROM alerts WHERE key = ?1");
  const up = db.prepare("UPDATE alerts SET opened = ?1, since = ?1, last_pushed = ?1 WHERE key = ?2");
  for (let i = 0; i < 32 && !blocked.every((b) => has.get(b.key)); i++) await Bun.sleep(5000);
  for (const b of blocked) up.run(b.at, b.key);
  if (!blocked.every((b) => has.get(b.key))) console.warn("demo-seed: the blocked alerts were not opened yet; they will show as just opened");
}

adapter.close();
const usd = [...daily.values()].reduce((s, c) => s + (c.usd ?? 0), 0);
console.log(`demo-seed: ${HOSTS.length} hosts, ${CLIENTS.length} clients, ${daily.size} daily + ${hourly.size} hourly usage rows (~$${Math.round(usd)} over ${DAYS} days), ${TASKS.length} tasks via MCP. Time zone ${TZ}.`);
