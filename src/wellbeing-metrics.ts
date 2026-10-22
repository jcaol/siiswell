/**
 * @file The human well-being layer, part 2: indicators, the "You" card's numbers, today's timeline and the 7 / 30-day
 * trends (migration 0007, `wb_metrics`). Rule-based only: indexed SQL over the existing tables (alerts, tasks, events,
 * usage_hourly) plus the thresholds below. No AI, no new data collected from any client.
 * @module dashboard-worker/wellbeing-metrics
 *
 * Indicators (live, on read) and their thresholds [busy, overloaded]:
 * | name        | formula                                                                         | busy | overloaded |
 * |-------------|---------------------------------------------------------------------------------|------|------------|
 * | interrupts  | alerts opened in the last 60 min that ask for the operator (INTERRUPT_RULES)    | 4    | 9 (> 8)    |
 * | concurrency | open alerts waiting for the operator now (approval-waiting, blocked)            | 3    | 5          |
 * | fanOut      | distinct projects with activity in the last 60 min (events, task updates)       | 4    | 6          |
 * | session     | minutes since the start of the current run of activity (a gap >= 45 min ends it) | 180  | 300        |
 * | offHours    | active local hours today that fall in the quiet hours                           | 1    | 2          |
 * | burn        | tokens today up to this hour / the median of the same span over the last 14 days | 2    | 3          |
 * | limit       | highest plan-limit use (5 h / weekly %) any agent reports (the page adds it)    | 70   | 90         |
 * | retry       | most BLOCKED <-> IN_PROGRESS flips of one task in 24 h                           | 3    | 5          |
 * The overall state is the worst level: 0 Calm, 1 Busy, 2 Heavy, and the page always lists why.
 *
 * Hourly metrics written by the ticker (one row per name and local hour, value = the hour's maximum so far): `active` (0/1),
 * `interrupts`, `waiting` (concurrency), `projects`. The trends are computed from them on read.
 */
import { all, stmt } from "./db";
import { hourIsQuiet, isNoTable, localTime, type WbSettings } from "./wellbeing";
import { safeLabel } from "./wellbeing-forecast";

/**
 * The apps a PERSON drives (usage_hourly `agent` labels of the siiswell collector), for the activity proxy: an exact label,
 * so a worktree agent's "claude-cli.<name>", Codex `exec` runs and SDK calls (automation) do not count.
 */
export const OPERATOR_APPS: readonly string[] = ["claude-cli", "claude-desktop", "claude-ide", "codex-cli", "codex-desktop", "codex-ide"];

export const INTERRUPT_RULES: readonly string[] = ["approval-waiting", "blocked", "overdue", "agent-stuck"];
export const WAITING_RULES: readonly string[] = ["approval-waiting", "blocked"];
const sqlList = (l: readonly string[]) => l.map((r) => `'${r}'`).join(", ");

export const THRESHOLDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  interrupts: [4, 9],
  concurrency: [3, 5],
  fanOut: [4, 6],
  session: [180, 300],
  offHours: [1, 2],
  burn: [2, 3],
  limit: [70, 90],
  retry: [3, 5],
});

/** 0 = calm, 1 = busy, 2 = overloaded; null values are calm. */
export function levelOf(name: string, v: number | null): 0 | 1 | 2 {
  const t = THRESHOLDS[name];
  if (!t || v === null || !Number.isFinite(v)) return 0;
  return v >= t[1] ? 2 : v >= t[0] ? 1 : 0;
}

/** A gap of at least this long ends a session. */
export const SESSION_GAP_MS = 45 * 60_000;

/**
 * Minutes of the current session: activity timestamps (any order) -> how long since the first one after the last gap of
 * SESSION_GAP_MS or more, if the newest is within SESSION_GAP_MS of `now`; else 0 (no session running).
 */
export function sessionMinutes(times: readonly number[], now: number, gap = SESSION_GAP_MS): { minutes: number; start: number | null } {
  const ts = times.filter((t) => Number.isFinite(t) && t <= now).sort((a, b) => b - a);
  if (!ts.length || now - (ts[0] as number) >= gap) return { minutes: 0, start: null };
  let start = ts[0] as number;
  for (let i = 1; i < ts.length; i++) {
    if (start - (ts[i] as number) >= gap) break;
    start = ts[i] as number;
  }
  return { minutes: Math.floor((now - start) / 60_000), start };
}

/** Median (0 for an empty list). */
export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Today's tokens so far against the median of the same span on each of the `days` previous days (missing days = 0); null without a baseline. */
export function burnRatio(today: number, previous: readonly number[], days = 14): number | null {
  const base = [...previous.slice(0, days)];
  while (base.length < days) base.push(0);
  const m = median(base);
  return m > 0 ? today / m : null;
}

/**
 * The most BLOCKED <-> IN_PROGRESS flips of one task: status events (oldest first or any order), grouped by `task`.
 * A flip is a change between the two statuses; DONE / other statuses do not count and do not reset.
 */
export function maxRetryFlips(events: ReadonlyArray<{ task: string; status: string | null; at: number }>): { flips: number; task: string | null } {
  const by = new Map<string, Array<{ status: string; at: number }>>();
  for (const e of events) {
    if (e.status !== "BLOCKED" && e.status !== "IN_PROGRESS") continue;
    by.set(e.task, [...(by.get(e.task) ?? []), { status: e.status, at: e.at }]);
  }
  let best = { flips: 0, task: null as string | null };
  for (const [task, list] of by) {
    list.sort((a, b) => a.at - b.at);
    let flips = 0;
    for (let i = 1; i < list.length; i++) if ((list[i] as { status: string }).status !== (list[i - 1] as { status: string }).status) flips++;
    if (flips > best.flips) best = { flips, task };
  }
  return best;
}

/** The task an event belongs to: an MCP event's key carries its task id; others fall back to host / project / agent. */
export const taskOfEvent = (e: { key: string; host: string | null; project: string | null; agent: string | null }): string => {
  const m = /^mcp:([^:]+):/.exec(e.key);
  return m ? `mcp:${m[1]}` : `${e.host ?? ""}|${e.project ?? ""}|${e.agent ?? ""}`;
};

/** UTC ms of the start of local hour `HH` on local day `YYYY-MM-DD` in `tz` (the hour after a spring-forward gap maps forward). */
export function localHourStart(day: string, hour: number, tz: string): number {
  const guess = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour);
  const lt = localTime(guess, tz);
  const asUtc = Date.UTC(Number(lt.day.slice(0, 4)), Number(lt.day.slice(5, 7)) - 1, Number(lt.day.slice(8, 10)), lt.hour, lt.minute);
  return guess - (asUtc - guess);
}

export const addDay = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ── trends from the hourly metrics ───────────────────────────────────────────

export interface MetricRow { day: string; hour: number; name: string; value: number }
export interface DayTrend {
  day: string;
  activeHours: number;
  offHours: number;
  /** longest run of inactive hours in the day (hours; a day with no data at all is null) */
  longestRest: number | null;
  /** mean `waiting` over the day's active hours (null without active hours) */
  avgWaiting: number | null;
  interrupts: number;
}

/** Per day of the range (oldest first): active hours, off-hours, longest rest, average waiting, interrupts. Pure. */
export function dayTrends(rows: readonly MetricRow[], days: readonly string[], s: WbSettings): DayTrend[] {
  const v = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of rows) {
    v.set(`${r.day}|${r.hour}|${r.name}`, r.value);
    seen.add(r.day);
  }
  return days.map((day) => {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    let active = 0;
    let off = 0;
    let run = 0;
    let longest = 0;
    let waitSum = 0;
    let interrupts = 0;
    for (let h = 0; h < 24; h++) {
      const a = (v.get(`${day}|${h}|active`) ?? 0) > 0;
      interrupts += v.get(`${day}|${h}|interrupts`) ?? 0;
      if (a) {
        active++;
        waitSum += v.get(`${day}|${h}|waiting`) ?? 0;
        if (hourIsQuiet(h, weekday, s)) off++;
        run = 0;
      } else {
        run++;
        longest = Math.max(longest, run);
      }
    }
    return { day, activeHours: active, offHours: off, longestRest: seen.has(day) ? longest : null, avgWaiting: active ? Math.round((waitSum / active) * 10) / 10 : null, interrupts };
  });
}

// ── the ticker: this hour's metrics ──────────────────────────────────────────

/**
 * Write the current local hour's metrics (value = the hour's maximum so far) in ONE statement: four indexed counts (alerts
 * opened this hour via idx_alerts_opened, open waiting alerts via idx_alerts_resolved, distinct projects of this hour's events
 * via idx_events_at and of this hour's usage via the usage_hourly key) upserted as four rows. Never throws; a missing migration
 * is a no-op.
 */
export const SQL_RECORD_HOUR = `WITH p AS (
    SELECT COALESCE(project, host, '') AS p FROM events WHERE at >= ?3 AND at <= ?4
    UNION SELECT project FROM usage_hourly WHERE hour = ?5 AND requests > 0
  ), v(name, value) AS (
    SELECT 'active', (SELECT CASE WHEN EXISTS (SELECT 1 FROM p) THEN 1 ELSE 0 END)
    UNION ALL SELECT 'interrupts', (SELECT COUNT(*) FROM alerts WHERE opened >= ?3 AND opened <= ?4 AND rule IN (${sqlList(INTERRUPT_RULES)}))
    UNION ALL SELECT 'waiting', (SELECT COUNT(*) FROM alerts WHERE resolved IS NULL AND rule IN (${sqlList(WAITING_RULES)}))
    UNION ALL SELECT 'projects', (SELECT COUNT(*) FROM (SELECT p FROM p LIMIT 50))
  )
  INSERT INTO wb_metrics (day, hour, name, value) SELECT ?1, ?2, name, value FROM v WHERE true
  ON CONFLICT(day, hour, name) DO UPDATE SET value = MAX(value, excluded.value)`;

export async function recordHourMetrics(db: D1Database, s: WbSettings, now: number): Promise<void> {
  try {
    const lt = localTime(now, s.tz);
    const hourStart = Math.floor(now / 60_000) * 60_000 - lt.minute * 60_000;
    await stmt(db, SQL_RECORD_HOUR, lt.day, lt.hour, hourStart, now, `${lt.day}T${String(lt.hour).padStart(2, "0")}`).run();
  } catch (err) {
    if (!isNoTable(err)) console.error("well-being metrics failed:", err instanceof Error ? err.message : String(err));
  }
}

/** wb_metrics older than this are purged (the same as the hourly usage). */
export const WB_METRICS_RETENTION_DAYS = 90;

// ── the read: live indicators, today's timeline, trends ─────────────────────

export interface Indicator { name: string; value: number | null; level: 0 | 1 | 2; text: string; detail?: string }

const fmtH = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}` : `${min}m`);

/** Indicator texts ("Concurrency 5", "Session 3h 10m", "Burn 2.4x"). Pure. */
export function indicatorText(name: string, v: number | null): string {
  if (v === null) return `${LABELS[name] ?? name} —`;
  if (name === "session") return `${LABELS.session} ${fmtH(v)}`;
  if (name === "offHours") return `${LABELS.offHours} ${v}h`;
  if (name === "burn") return `${LABELS.burn} ${Math.round(v * 10) / 10}x`;
  if (name === "limit") return `${LABELS.limit} ${Math.round(v)}%`;
  return `${LABELS[name] ?? name} ${v}`;
}
const LABELS: Record<string, string> = {
  interrupts: "Interrupts (60 min)", concurrency: "Waiting for you", fanOut: "Projects (60 min)", session: "Session", offHours: "Off-hours today", burn: "Usage vs usual", limit: "Plan limit", retry: "Retry loop",
};

export function indicator(name: string, value: number | null, detail?: string): Indicator {
  return { name, value, level: levelOf(name, value), text: indicatorText(name, value), ...(detail ? { detail } : {}) };
}

export interface WellbeingNumbers {
  indicators: Indicator[];
  session: { minutes: number; start: number | null };
  timeline: Array<{ hour: number; interrupts: number; active: boolean; quiet: boolean }>;
  trends: DayTrend[];
  today: string;
  /** the current hour (0-23) in the settings' time zone */
  hourNow: number;
  /** the stored hourly metrics of the last 30 days (no `n:*`), and the normalised indicators of the last 7 days */
  metrics: MetricRow[];
  normRows: MetricRow[];
  /** interruptions of the last 7 days per project, most first (the weekly reflection) */
  byProject: Array<{ project: string; n: number }>;
  /** the busiest project of the burn (most tokens today), for the nudge */
  burnTop: string | null;
  quietActiveToday: number;
}

/**
 * Everything the "You" card shows, from indexed reads (D1: 12 statements, each bounded by an index range and a LIMIT).
 * `limit` is not here: the page adds it from the agents' own usage windows it already has.
 */
export async function wellbeingNumbers(db: D1Database, s: WbSettings, now: number): Promise<WellbeingNumbers> {
  const lt = localTime(now, s.tz);
  const today = lt.day;
  const hh = String(lt.hour).padStart(2, "0");
  const from30 = addDay(today, -29);
  const fromBurn = addDay(today, -14);
  const day24 = now - 24 * 3_600_000;
  const [interrupts, waiting, fan, evs, taskTs, usageHours, burn, burnTop, metrics, byProject, limitRow, normRows] = await Promise.all([
    stmt(db, `SELECT COUNT(*) AS n FROM alerts WHERE opened >= ?1 AND rule IN (${sqlList(INTERRUPT_RULES)})`, now - 3_600_000).first<{ n: number }>(),
    stmt(db, `SELECT COUNT(*) AS n FROM alerts WHERE resolved IS NULL AND rule IN (${sqlList(WAITING_RULES)})`).first<{ n: number }>(),
    all<{ p: string }>(db, "SELECT DISTINCT p FROM (SELECT COALESCE(project, host, '') AS p FROM events WHERE at >= ?1 UNION SELECT COALESCE(project, host, '') FROM tasks WHERE updated >= ?1) LIMIT 50", now - 3_600_000),
    all<{ key: string; host: string | null; project: string | null; agent: string | null; status: string | null; kind: string; at: number }>(
      db, "SELECT key, host, project, agent, status, kind, at FROM events WHERE at >= ?1 ORDER BY at DESC LIMIT 3000", day24),
    all<{ updated: number }>(db, "SELECT updated FROM tasks WHERE updated >= ?1 ORDER BY updated DESC LIMIT 2000", day24),
    all<{ hour: string }>(db, "SELECT DISTINCT hour FROM usage_hourly WHERE hour >= ?1 AND requests > 0 LIMIT 100", `${addDay(today, -1)}T00`).catch(() => [] as Array<{ hour: string }>),
    all<{ d: string; t: number }>(
      db,
      "SELECT substr(hour, 1, 10) AS d, TOTAL(CAST(input AS REAL) + output + cache_read + cache_write_5m + cache_write_1h) AS t FROM usage_hourly WHERE hour >= ?1 AND hour <= ?2 AND substr(hour, 12, 2) <= ?3 GROUP BY d LIMIT 20",
      `${fromBurn}T00`, `${today}T${hh}`, hh,
    ).catch(() => [] as Array<{ d: string; t: number }>),
    stmt(db, "SELECT project, TOTAL(CAST(input AS REAL) + output + cache_read + cache_write_5m + cache_write_1h) AS t FROM usage_hourly WHERE hour BETWEEN ?1 AND ?2 GROUP BY project ORDER BY t DESC LIMIT 1", `${today}T00`, `${today}T${hh}`)
      .first<{ project: string }>().catch(() => null),
    all<MetricRow>(db, "SELECT day, hour, name, value FROM wb_metrics WHERE day >= ?1 AND day <= ?2 AND name NOT LIKE 'n:%' LIMIT 4000", from30, today).catch(() => [] as MetricRow[]),
    all<{ project: string; n: number }>(
      db, `SELECT COALESCE(project, host, '') AS project, COUNT(*) AS n FROM alerts WHERE opened >= ?1 AND rule IN (${sqlList(INTERRUPT_RULES)}) GROUP BY 1 ORDER BY n DESC, 1 LIMIT 5`, now - 7 * 86_400_000),
    limitPressure(db, now),
    // the normalised indicators of the last 7 days (radar, sparklines)
    all<MetricRow>(db, "SELECT day, hour, name, value FROM wb_metrics WHERE day >= ?1 AND day <= ?2 AND name >= 'n:' AND name < 'n;' LIMIT 1500", addDay(today, -6), today).catch(() => [] as MetricRow[]),
  ]);

  // session: events, task updates and the hours with usage (four samples each) are the activity
  const times: number[] = [...evs.map((e) => e.at), ...taskTs.map((t) => t.updated)];
  for (const u of usageHours) {
    const start = localHourStart(u.hour.slice(0, 10), Number(u.hour.slice(11, 13)), s.tz);
    for (let q = 0; q < 4; q++) times.push(Math.min(now, start + q * 15 * 60_000));
  }
  const session = sessionMinutes(times, now);

  // today's timeline from the stored hours, plus the live hour
  const mv = new Map(metrics.map((r) => [`${r.day}|${r.hour}|${r.name}`, r.value]));
  const timeline = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    interrupts: mv.get(`${today}|${h}|interrupts`) ?? 0,
    active: (mv.get(`${today}|${h}|active`) ?? 0) > 0,
    quiet: hourIsQuiet(h, lt.weekday, s),
  }));
  const quietActiveToday = timeline.filter((c) => c.hour <= lt.hour && c.active && c.quiet).length;

  const byDay = new Map(burn.map((r) => [r.d, r.t]));
  const prev = Array.from({ length: 14 }, (_, i) => byDay.get(addDay(today, -(i + 1))) ?? 0);
  const ratio = burnRatio(byDay.get(today) ?? 0, prev);

  const retry = maxRetryFlips(evs.filter((e) => e.kind === "status").map((e) => ({ task: taskOfEvent(e), status: e.status, at: e.at })));

  const days30 = Array.from({ length: 30 }, (_, i) => addDay(from30, i));
  return {
    indicators: [
      indicator("interrupts", interrupts?.n ?? 0),
      indicator("concurrency", waiting?.n ?? 0),
      indicator("fanOut", fan.length),
      indicator("session", session.minutes),
      indicator("offHours", quietActiveToday),
      indicator("burn", ratio === null ? null : Math.round(ratio * 10) / 10),
      indicator("retry", retry.flips),
      indicator("limit", limitRow),
    ],
    session,
    timeline,
    trends: dayTrends(metrics, days30, s),
    today,
    hourNow: lt.hour,
    byProject,
    metrics,
    normRows,
    burnTop: burnTop?.project ?? null,
    quietActiveToday,
  };
}

// ── W3: weekly reflection and gentle nudges (sentence templates; neutral, no scores, no streaks) ──────────────

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The weekly reflection: a few plain sentences from the last 7 days' trends and where the interruptions came from.
 * Pure. Fewer than 3 days with data -> no reflection yet (empty list).
 */
export function weeklyReflection(trends7: readonly DayTrend[], byProject: ReadonlyArray<{ project: string; n: number }>): string[] {
  const known = trends7.filter((d) => d.longestRest !== null);
  if (known.length < 3) return [];
  const out: string[] = [];
  const active = known.reduce((n, d) => n + d.activeHours, 0);
  out.push(`You were active for about ${active} hour${active === 1 ? "" : "s"} over the last ${trends7.length} days.`);
  const lateDays = known.filter((d) => d.offHours > 0).length;
  out.push(lateDays ? `On ${lateDays} of those days you were active during your quiet hours.` : "You kept your quiet hours free on every day.");
  const rest = known.reduce((best, d) => ((d.longestRest ?? -1) > (best.longestRest ?? -1) ? d : best), known[0] as DayTrend);
  if (rest.longestRest !== null) out.push(`Your longest break was ${rest.longestRest} hours, on ${WEEKDAY[new Date(`${rest.day}T12:00:00Z`).getUTCDay()]}.`);
  const total = byProject.reduce((n, p) => n + p.n, 0);
  const top = byProject[0];
  if (top && total > 0) out.push(`Most interruptions came from ${top.project || "no project"} (${Math.round((top.n / total) * 100)}% of ${total}).`);
  const waits = known.map((d) => d.avgWaiting).filter((v): v is number => v !== null);
  if (waits.length) out.push(`In active hours, about ${Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10} things were waiting for you on average.`);
  return out;
}

/**
 * Each nudge's daily cap and cooldown (a nudge is itself an interruption): at most `perDay` NEW appearances a day, and a new
 * one (another scope) only `cooldownMs` after the last. One still on screen (the same scope) stays. Counted from the page's
 * "shown" report (POST /api/wellbeing/nudge until=shown), so the read stays read-only.
 */
export const NUDGE_LIMITS: Readonly<Record<string, { perDay: number; cooldownMs: number }>> = Object.freeze({
  session: { perDay: 2, cooldownMs: 2 * 3_600_000 },
  late: { perDay: 1, cooldownMs: 6 * 3_600_000 },
  burn: { perDay: 1, cooldownMs: 6 * 3_600_000 },
  weekly: { perDay: 1, cooldownMs: 24 * 3_600_000 },
  pace: { perDay: 3, cooldownMs: 3_600_000 },
  intensity: { perDay: 1, cooldownMs: 24 * 3_600_000 },
  microbreak: { perDay: 4, cooldownMs: 2 * 3_600_000 },
  readiness: { perDay: 1, cooldownMs: 24 * 3_600_000 },
});
export type NudgeState = { never?: boolean; scope?: string; day?: string; sd?: string; sn?: number; sl?: number; ss?: string };

/** Within its cap and cooldown? (an id without limits always is) Pure. */
export function nudgeAllowed(id: string, scope: string, st: NudgeState | undefined, today: string, now: number): boolean {
  const lim = NUDGE_LIMITS[id];
  if (!lim || !st) return true;
  if (st.ss === scope) return true; // the one already on screen
  if (st.sd === today && (st.sn ?? 0) >= lim.perDay) return false;
  if (typeof st.sl === "number" && now - st.sl >= 0 && now - st.sl < lim.cooldownMs) return false;
  return true;
}

export interface Nudge { id: "session" | "late" | "burn" | "weekly" | "pace" | "intensity" | "microbreak"; title: string; text: string[]; scope: string }

/**
 * The nudges due now (each at most once per session or day: `scope` is what "not today" dismisses), in a calm voice: no
 * countdowns, no alarm words. `dismissed` maps an id to its stored dismissal. Pure.
 */
export function dueNudges(
  n: Pick<WellbeingNumbers, "session" | "quietActiveToday" | "indicators" | "burnTop" | "today"> & { quietNow?: boolean; rapidMinutes?: number; hourKey?: string; intenseDays?: string[] | null; serious?: boolean; youSessionMin?: number; microBreakMin?: number; microSlot?: string; focus?: boolean },
  reflection: readonly string[],
  dismissed: ReadonlyMap<string, NudgeState>,
  now?: number,
): Nudge[] {
  const out: Nudge[] = [];
  const burn = n.indicators.find((i) => i.name === "burn")?.value ?? null;
  const candidates: Nudge[] = [];
  if (n.session.minutes >= 180 && n.session.start !== null) {
    const h = Math.floor(n.session.minutes / 60);
    candidates.push({ id: "session", title: "A pause?", text: [`You have been at it for about ${h} hours without a long break. The agents can carry on for ten minutes without you.`], scope: `s:${n.session.start}` });
  }
  // only while the quiet hours are on: a note at the time it can help, never a reproach the next morning
  if (n.quietActiveToday >= 1 && n.quietNow !== false) {
    candidates.push({ id: "late", title: "It is your quiet time", text: ["The agents can keep working on their own; the morning digest will tell you what happened."], scope: `d:${n.today}` });
  }
  if (burn !== null && burn >= 3) {
    candidates.push({ id: "burn", title: "Usage today", text: [`Today's usage is about ${Math.round(burn)}x your usual for this time of day${n.burnTop ? `, mostly in ${n.burnTop}` : ""}.`], scope: `d:${n.today}` });
  }
  // a micro-break: only during long continuous activity of your own (not in Focus); at most once per 2 h and 4 a day (NUDGE_LIMITS)
  if (!n.focus && n.microBreakMin && (n.youSessionMin ?? 0) >= n.microBreakMin) {
    candidates.push({ id: "microbreak", title: "Worth a break", text: ["You've been at it a while — a five-minute break now? The agents keep going."], scope: `b:${n.microSlot ?? n.today}` });
  }
  // your own pace (the You line): 20 minutes or more of rapid-fire replies in the last hour; at most once per hour (scope)
  if ((n.rapidMinutes ?? 0) >= 20) {
    candidates.push({ id: "pace", title: "Your pace", text: ["Agents can wait — batch your replies every 10 min?"], scope: `h:${n.hourKey ?? n.today}` });
  }
  // three long or late days in a row (wellbeing-intensity.ts): from 18:00 on the third, a neutral suggestion
  if (n.intenseDays && n.intenseDays.length) {
    // stronger (still supportive) wording ONLY in the serious case (wellbeing-light.ts seriousCase)
    candidates.push(n.serious
      ? { id: "intensity", title: "Several heavy days in a row", text: ["Several heavy days in a row, with short rests and late nights — consider a lighter day tomorrow. The agents can carry on without you."], scope: `d:${n.today}` }
      : { id: "intensity", title: "Plan a rest day?", text: ["The last three days were long or late. A lighter day or a rest day soon may help; the agents can carry on without you."], scope: `d:${n.today}` });
  }
  if (reflection.length) candidates.push({ id: "weekly", title: "This week", text: [...reflection], scope: `d:${n.today}` });
  for (const c of candidates) {
    const d = dismissed.get(c.id);
    if (d?.never) continue;
    if (d?.scope === c.scope || d?.day === n.today) continue; // "not today": this session / day
    if (now !== undefined && !nudgeAllowed(c.id, c.scope, d, n.today, now)) continue; // its daily cap / cooldown
    out.push(c);
  }
  return out;
}

// ── the ticker's stress sample (every 15 min; wellbeing-stress.ts holds the formula) ─────────────────────────

/** The sampling minute of every quarter hour (UTC minute % 15), and the one after it as the catch-up when a purge ran. */
export const STRESS_TICK_MINUTE = 7;
export const STRESS_TICK_EVERY_MS = 15 * 60_000;
export const stressTickMinute = (now: number): number => Math.floor(now / 60_000) % 15;

const SEP = "\u001f";

/**
 * Everything the stress formula needs, in ONE read: the same counts and series wellbeingNumbers reads (bounded by their
 * indexes and LIMITs inside each sub-select), returned as a few numbers and separator-joined lists, plus the stored EMA state.
 */
/**
 * The operator apps' requests per hour label AND the zone the host's bank wrote that label in (usage_hosts.tz; '' when
 * unknown), so each host's hours are read in its own zone. Bound ?1 = the earliest hour label.
 */
export const SQL_ACTIVITY_BY_TZ = `SELECT u.hour AS hour, COALESCE(h.tz, '') AS tz, SUM(u.requests) AS r FROM usage_hourly u LEFT JOIN usage_hosts h ON h.host = u.host
     WHERE u.hour >= ?1 AND u.agent IN (${sqlList(OPERATOR_APPS)}) GROUP BY u.hour, tz LIMIT 400`;

export const SQL_STRESS_INPUTS = `SELECT
  (SELECT COUNT(*) FROM alerts WHERE opened >= ?1 AND rule IN (${sqlList(INTERRUPT_RULES)})) AS interrupts,
  (SELECT COUNT(*) FROM alerts WHERE resolved IS NULL AND rule IN (${sqlList(WAITING_RULES)})) AS waiting,
  (SELECT COUNT(*) FROM (SELECT COALESCE(project, host, '') FROM events WHERE at >= ?1 UNION SELECT COALESCE(project, host, '') FROM tasks WHERE updated >= ?1 LIMIT 50)) AS fan,
  (SELECT group_concat(t, ',') FROM (SELECT t FROM (SELECT at AS t FROM events WHERE at >= ?2 ORDER BY at DESC LIMIT 400)
     UNION ALL SELECT t FROM (SELECT updated AS t FROM tasks WHERE updated >= ?2 ORDER BY updated DESC LIMIT 200))) AS times,
  (SELECT group_concat(hour, ',') FROM (SELECT DISTINCT hour FROM usage_hourly WHERE hour >= ?3 AND requests > 0 LIMIT 100)) AS usageHours,
  (SELECT group_concat(hour, ',') FROM (SELECT hour FROM wb_metrics WHERE day = ?4 AND name = 'active' AND value > 0 LIMIT 24)) AS activeHours,
  (SELECT group_concat(d || ':' || t, ',') FROM (SELECT substr(hour, 1, 10) AS d, TOTAL(CAST(input AS REAL) + output + cache_read + cache_write_5m + cache_write_1h) AS t
     FROM usage_hourly WHERE hour >= ?5 AND hour <= ?6 AND substr(hour, 12, 2) <= ?7 GROUP BY d LIMIT 20)) AS burn,
  (SELECT group_concat(key || '${SEP}' || COALESCE(host, '') || '${SEP}' || COALESCE(project, '') || '${SEP}' || COALESCE(agent, '') || '${SEP}' || COALESCE(status, '') || '${SEP}' || at, char(30))
     FROM (SELECT key, host, project, agent, status, at FROM events WHERE kind = 'status' AND at >= ?8 ORDER BY at DESC LIMIT 500)) AS statuses,
  (SELECT v FROM wb_settings WHERE k = 'rt:stress') AS ema,
  (SELECT v FROM wb_settings WHERE k = 'rt:stressYou') AS emaYou,
  (SELECT group_concat(hour || ':' || prompts || ':' || approvals || ':' || rapid || ':' || lat_n || ':' || COALESCE(lat_p50_ms, '') || ':' || rapid_min, ',')
     FROM (SELECT hour, prompts, approvals, rapid, rapid_min, lat_n, lat_p50_ms FROM human_hourly WHERE hour >= ?9 ORDER BY hour LIMIT 600)) AS human,
  (SELECT group_concat(hour || '=' || r || '=' || tz, ',') FROM (${SQL_ACTIVITY_BY_TZ.replace("?1", "?10")})) AS activity,
  (SELECT v FROM wb_settings WHERE k = 'rt:limits') AS limits`;

export interface StressInputsRow {
  interrupts: number; waiting: number; fan: number; times: string | null; usageHours: string | null; activeHours: string | null;
  burn: string | null; statuses: string | null; ema: string | null; emaYou?: string | null; human?: string | null; activity?: string | null; limits?: string | null;
}

/** The row of SQL_STRESS_INPUTS -> the eight indicators (the same formulas as wellbeingNumbers). Pure. */
export function indicatorsFromRow(r: StressInputsRow, s: WbSettings, now: number, limit: number | null = null): Indicator[] {
  const lt = localTime(now, s.tz);
  const times = (r.times ?? "").split(",").filter(Boolean).map(Number);
  for (const h of (r.usageHours ?? "").split(",").filter(Boolean)) {
    const start = localHourStart(h.slice(0, 10), Number(h.slice(11, 13)), s.tz);
    for (let q = 0; q < 4; q++) times.push(Math.min(now, start + q * 15 * 60_000));
  }
  const active = new Set((r.activeHours ?? "").split(",").filter(Boolean).map(Number));
  const off = [...active].filter((h) => h <= lt.hour && hourIsQuiet(h, lt.weekday, s)).length;
  const byDay = new Map((r.burn ?? "").split(",").filter(Boolean).map((x) => { const i = x.lastIndexOf(":"); return [x.slice(0, i), Number(x.slice(i + 1))] as const; }));
  const ratio = burnRatio(byDay.get(lt.day) ?? 0, Array.from({ length: 14 }, (_, i) => byDay.get(addDay(lt.day, -(i + 1))) ?? 0));
  const evs = (r.statuses ?? "").split("\u001e").filter(Boolean).map((line) => {
    const [key, host, project, agent, status, at] = line.split(SEP);
    return { task: taskOfEvent({ key: key ?? "", host: host || null, project: project || null, agent: agent || null }), status: status || null, at: Number(at) };
  });
  return [
    indicator("interrupts", r.interrupts ?? 0),
    indicator("concurrency", r.waiting ?? 0),
    indicator("fanOut", r.fan ?? 0),
    indicator("session", sessionMinutes(times, now).minutes),
    indicator("offHours", off),
    indicator("burn", ratio === null ? null : Math.round(ratio * 10) / 10),
    indicator("retry", maxRetryFlips(evs).flips),
    indicator("limit", limit),
  ];
}

/** The human rows of SQL_STRESS_INPUTS (`hour:prompts:approvals:rapid:lat_n:lat_p50`, one per source and hour). */
export function humanRowsOf(r: Pick<StressInputsRow, "human">): Array<{ hour: number; prompts: number; approvals: number; rapid: number; rapid_min: number; lat_n: number; lat_p50_ms: number | null }> {
  return (r.human ?? "").split(",").filter(Boolean).map((x) => {
    const [hour, prompts, approvals, rapid, latN, p50, rmin] = x.split(":");
    return { hour: Number(hour), prompts: Number(prompts), approvals: Number(approvals), rapid: Number(rapid), rapid_min: Number(rmin) || 0, lat_n: Number(latN), lat_p50_ms: p50 ? Number(p50) : null };
  });
}

/**
 * The activity rows of SQL_STRESS_INPUTS (`<local hour label>=<requests>[=<host zone>]`) -> UTC hour start -> requests. Each label
 * is read in the zone of the host that wrote it; `tz` (the dashboard's) only when that zone is missing or unknown.
 */
export function activityOf(r: Pick<StressInputsRow, "activity">, tz: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const x of (r.activity ?? "").split(",").filter(Boolean)) {
    const [hour, n, hostTz] = x.split("=");
    if (!hour || hour.length < 13) continue;
    const zone = hostTz && validZone(hostTz) ? hostTz : tz;
    const at = localHourStart(hour.slice(0, 10), Number(hour.slice(11, 13)), zone);
    out.set(at, (out.get(at) ?? 0) + (Number(n) || 0));
  }
  return out;
}

const zoneOk = new Map<string, boolean>();
function validZone(tz: string): boolean {
  let ok = zoneOk.get(tz);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); ok = true; } catch { ok = false; }
    if (zoneOk.size < 100) zoneOk.set(tz, ok);
  }
  return ok;
}

/** The read of SQL_STRESS_INPUTS for `now` (one statement). */
export async function readStressInputs(db: D1Database, s: WbSettings, now: number): Promise<StressInputsRow | null> {
  // one read per tick: the well-being pushes and the stress sample of the same tick (same `now`, same zone) share it
  const memo = inputsMemo.get(db as object);
  if (memo && memo.now === now && memo.tz === s.tz) return memo.row;
  const row = readStressInputsUncached(db, s, now);
  inputsMemo.set(db as object, { now, tz: s.tz, row });
  row.catch(() => inputsMemo.delete(db as object));
  return row;
}
const inputsMemo = new WeakMap<object, { now: number; tz: string; row: Promise<StressInputsRow | null> }>();

async function readStressInputsUncached(db: D1Database, s: WbSettings, now: number): Promise<StressInputsRow | null> {
  const lt = localTime(now, s.tz);
  const hh = String(lt.hour).padStart(2, "0");
  const binds = [now - 3_600_000, now - 24 * 3_600_000, `${addDay(lt.day, -1)}T00`, lt.day, `${addDay(lt.day, -14)}T00`, `${lt.day}T${hh}`, hh, now - 24 * 3_600_000, now - 26 * 3_600_000, `${addDay(lt.day, -14)}T00`] as const;
  try {
    return await stmt(db, SQL_STRESS_INPUTS, ...binds).first<StressInputsRow>();
  } catch (err) {
    // before migration 0011 there is no human_hourly: the same read without the "You" input
    if (!/no such table: human_hourly/i.test(err instanceof Error ? err.message : String(err))) throw err;
    return stmt(db, SQL_STRESS_INPUTS.replace(/\(SELECT group_concat\(hour \|\|[\s\S]*?LIMIT 600\)\) AS human,/, "NULL AS human,"), ...binds).first<StressInputsRow>();
  }
}

// ── plan-limit pressure (cached per isolate) ─────────────────────────────────

/** Snapshots older than this do not count for the plan limit. */
export const LIMIT_WINDOW_MS = 6 * 3_600_000;
export const LIMIT_CACHE_MS = 60_000;
export interface LimitWindow { label: string; pct: number; resetsAt: number | null }
const limitCache = new WeakMap<object, { at: number; windows: LimitWindow[] }>();

/**
 * The plan-limit windows (`5h`, `weekly`, ...) any agent reports, each with its highest use and the latest reset time, from the
 * snapshot of each host / project (the table keeps only the latest one per host and project: its primary key) received in the
 * last 6 hours. Cached per database binding for LIMIT_CACHE_MS, shared by the page's read and the ticker.
 */
export async function limitWindows(db: D1Database, now: number): Promise<LimitWindow[]> {
  const hit = limitCache.get(db as object);
  if (hit && now >= hit.at && now - hit.at < LIMIT_CACHE_MS) return hit.windows;
  let windows: LimitWindow[] = [];
  try {
    windows = (await all<{ l: string; p: number | null; r: number | null }>(db,
      `SELECT json_extract(u.value, '$.label') AS l, MAX(CAST(json_extract(u.value, '$.usedPercent') AS REAL)) AS p, MAX(CAST(json_extract(u.value, '$.resetsAt') AS INTEGER)) AS r
       FROM snapshots s, json_each(s.json, '$.agents') a, json_each(a.value, '$.usage') u
       WHERE s.received_at >= ?1 GROUP BY l LIMIT 10`, now - LIMIT_WINDOW_MS))
      .filter((w) => safeLabel(w.l) && typeof w.p === "number")
      .map((w) => ({ label: w.l, pct: Math.round((w.p as number) * 10) / 10, resetsAt: typeof w.r === "number" && w.r > 0 ? w.r : null }));
  } catch {
    windows = [];
  }
  limitCache.set(db as object, { at: now, windows });
  return windows;
}

/** The highest plan-limit use of any window (null = none reported). */
export async function limitPressure(db: D1Database, now: number): Promise<number | null> {
  const w = await limitWindows(db, now);
  return w.length ? Math.round(Math.max(...w.map((x) => x.pct))) : null;
}
