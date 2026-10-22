// Pure formatting helpers of the dashboard UI (no DOM, no globals), split out of app.js so they can be unit-tested.
// Everything here returns plain strings / objects; app.js turns them into text nodes (never markup).

/**
 * What an agent's reported state means for the operator. Desktop clients imply working / idle; the others come from an
 * optional host integration. "asleep" / "paused" are a host resting an idle agent, not failures.
 */
export const AGENT_STATE = {
  working: { label: "working", tone: "ok", hint: "has an open task" },
  idle: { label: "idle", tone: "idle", hint: "no open task" },
  killed: { label: "asleep", tone: "sleep", hint: "stopped by its host while idle; started again when needed" },
  frozen: { label: "paused", tone: "sleep", hint: "paused by its host while idle; resumes by itself" },
  wedged: { label: "stuck", tone: "crit", hint: "unresponsive: input sent to it was not taken" },
  benched: { label: "on hold", tone: "warn", hint: "put on hold by its host" },
  "usage-limit": { label: "limit", tone: "crit", hint: "its provider reported a usage limit that has not lifted" },
  compacting: { label: "compacting", tone: "warn", hint: "shortening its context" },
  unknown: { label: "unknown", tone: "idle", hint: "state not reported" },
};
export const friendly = (state) => AGENT_STATE[state] || AGENT_STATE.unknown;

/**
 * Optional sections fed by optional snapshot fields (threads): shown only when there is something in them. An empty
 * section renders NOTHING, not even its heading or an empty-state line, so a dashboard that only gets MCP reports and
 * usage never shows features it does not use.
 */
export const showOptionalSection = (list) => Array.isArray(list) && list.length > 0;

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** "<1 min", "12 min", "3 h", "2 d": a length of time. */
export function dur(ms) {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h`;
  return `${Math.round(hr / 24)} d`;
}

/** "5 min ago" (callers only pass a number: an unknown time is simply not shown). */
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${dur(s * 1000)} ago`;
}

/** "ETA in 12 min" / "overdue 5 min" for an open task with a stated ETA. */
export function etaText(etaAt, now) {
  return etaAt >= now ? `ETA in ${dur(etaAt - now)}` : `overdue ${dur(now - etaAt)}`;
}

// ── text cleanup ─────────────────────────────────────────────────────────────

/**
 * Chat transports whose tag (`[<Transport> from @alice] `) a forwarded message title may start with. Only these are
 * stripped: `[Report from QA] build failed` is a title, not a transport tag.
 */
const TRANSPORTS = ["Mattermost", "Slack", "Telegram", "Discord", "Matrix"];
const TRANSPORT_TAG = new RegExp(`^\\[(?:${TRANSPORTS.join("|")}) from [^\\]]*\\]\\s*`, "i");

/** Task titles may start with a transport tag (see TRANSPORTS) or `[Forwarded from X] `. */
export function cleanTitle(raw) {
  const original = String(raw ?? "").trim();
  let t = original.replace(TRANSPORT_TAG, "");
  const fwd = /^\[Forwarded from ([^\]]+)\]\s*/i.exec(t);
  if (fwd) t = `↪ ${fwd[1]}: ${t.slice(fwd[0].length)}`;
  // a leading `**` that is never closed is not Markdown emphasis (a chat command prefix, say): drop it for display
  if (/^\*\*(?=[A-Za-z])/.test(t) && !t.slice(2).includes("**")) t = t.slice(2).trim();
  return t || original || "(untitled)";
}

/** The fixed kinds a task may carry (src/shared/tasktext.ts TASK_KINDS); anything else is not shown. */
const KINDS = ["coding", "debugging", "testing", "review", "research", "docs", "deploy", "ops", "other"];
export const taskKind = (t) => (t && KINDS.includes(t.kind) ? t.kind : "");

/**
 * The title shown for a task. When the title is the generic "Task" (the client sends no text: minimal / none) the kind and the
 * project say more: "debugging · web". Otherwise the cleaned title.
 */
export function taskTitle(t) {
  const title = cleanTitle(t && t.title);
  const generic = title === "Task" || title === "(untitled)";
  if (!generic) return title;
  const kind = taskKind(t);
  const project = t && t.project ? String(t.project) : "";
  if (kind && project) return `${kind} · ${project}`;
  return kind || title;
}

/** `STATUS: DONE（x） — text` → `（x） text`: the icon already says which status it is. */
export function cleanEventText(e) {
  const raw = String(e.text ?? "").trim();
  if (e.kind !== "status") return raw;
  const m = /^STATUS:?\s*(?:IN[ _]PROGRESS|BLOCKED|DONE)\b\s*((?:\([^)]*\)|（[^）]*）)?)\s*(?:[—–:-]\s*)?/i.exec(raw);
  if (!m) return raw;
  return [m[1], raw.slice(m[0].length).trim()].filter(Boolean).join(" ") || raw;
}

/** The round icon of an event: status DONE ✓, IN PROGRESS …, BLOCKED ⛔, halt notices by severity. */
export function eventIcon(e) {
  if (e.kind === "status") {
    const st = String(e.status || "").toUpperCase().replace(/[ ]/g, "_");
    if (st === "DONE") return { g: "✓", tone: "ok", what: "done" };
    if (st === "BLOCKED") return { g: "⛔", tone: "crit", what: "blocked" };
    return { g: "…", tone: "info", what: "in progress" };
  }
  if (e.kind === "approval") return { g: "?", tone: "warn", what: "pending action" };
  if (e.kind === "lifecycle") return { g: "↻", tone: "info", what: "lifecycle" };
  if (e.severity === "critical") return { g: "✖", tone: "crit", what: "critical notice" };
  if (e.severity === "warn") return { g: "⚠\uFE0E", tone: "warn", what: "warning notice" };
  return { g: "ℹ\uFE0E", tone: "info", what: "notice" };
}


// ── update cadence ───────────────────────────────────────────────────────────

/** While the page is visible it asks for /api/state this often (older versions: 20 s). Hosts report about every 2 minutes. */
export const POLL_MS = 60_000;
/** Coming back to the page re-fetches at once, but only when the data on screen is older than this. */
export const REFETCH_ON_VISIBLE_MS = 15_000;

/**
 * Wait before the next poll, counted from the last fetch: never less than 1 s (a clock that jumped forward must not spin)
 * and never more than POLL_MS (a clock that jumped BACKWARDS must not make the next poll wait an hour).
 */
export function pollDelay(lastFetchAt, now) {
  return Math.min(POLL_MS, Math.max(1_000, lastFetchAt + POLL_MS - now));
}

/** The page became visible again: fetch now when nothing was fetched yet, the last fetch is older than 15 s, or the clock went back past it. */
export function dueOnVisible(lastFetchAt, now) {
  return !isNum(lastFetchAt) || lastFetchAt <= 0 || lastFetchAt > now || now - lastFetchAt > REFETCH_ON_VISIBLE_MS;
}

// ── project liveness ─────────────────────────────────────────────────────────

/** A project whose reporter sent nothing for this long is "reporter offline" even when its host is online (the Worker's PROJECT_OFFLINE_AFTER_MS). */
export const PROJECT_OFFLINE_AFTER_MS = 6 * 60_000;

/**
 * Is this project's reporter silent? `lastSeen` = when anything last arrived for it (null / absent: not recorded, nothing is
 * claimed). `serverNow` is the Worker's clock (the same clock that wrote `lastSeen`), the client's is the fallback.
 */
export function projectSilent(lastSeen, serverNow, clientNow = Date.now()) {
  if (!isNum(lastSeen)) return false;
  return (isNum(serverNow) ? serverNow : clientNow) - lastSeen > PROJECT_OFFLINE_AFTER_MS;
}

// ── theme switch ─────────────────────────────────────────────────────────────

const THEME_WORDS = {
  auto: { label: "Auto", glyph: "\u25D0", hint: "follows your device" },
  light: { label: "Light", glyph: "\u2600\uFE0E", hint: "always light" },
  dark: { label: "Dark", glyph: "\u263E\uFE0E", hint: "always dark" },
};

/** What the header switch shows for the current choice, and what a press does (Auto -> Light -> Dark -> Auto). */
export function themeView(choice, next) {
  const cur = THEME_WORDS[choice] || THEME_WORDS.auto;
  const nxt = THEME_WORDS[next] || THEME_WORDS.auto;
  const text = `Theme: ${cur.label} (${cur.hint}). Press to switch to ${nxt.label}.`;
  return { label: cur.label, glyph: cur.glyph, aria: text, title: text };
}

// ── usage & estimated cost ───────────────────────────────────────────────────

/** `950`, `12.3k`, `1.2M`, `4.5B`: a token / request count in a few characters (non-numbers are 0). */
export function fmtTokens(n) {
  const v = isNum(n) && n > 0 ? n : 0;
  if (v < 1_000) return String(Math.round(v));
  const unit = (x, s) => `${x >= 100 ? Math.round(x) : x >= 10 ? x.toFixed(1).replace(/\.0$/, "") : x.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}${s}`;
  if (v < 1_000_000) return unit(v / 1_000, "k");
  if (v < 1_000_000_000) return unit(v / 1_000_000, "M");
  return unit(v / 1_000_000_000, "B");
}

/** `$12.34` (`$1,234` from $1000 up, `<$0.01` for a trace); the API-equivalent estimate, never a bill. */
export function fmtUsd(n) {
  const v = isNum(n) && n > 0 ? n : 0;
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(2)}`;
}

/**
 * The dollar cell of an aggregate: priced -> `$x`; nothing priced but tokens exist (unknown model) -> `—`;
 * priced AND some unpriced tokens -> `$x` plus a note that it is a lower bound.
 */
export function usdCell(a) {
  const unpriced = isNum(a && a.unpricedTokens) ? a.unpricedTokens : 0;
  const usd = isNum(a && a.usd) ? a.usd : 0;
  if (unpriced > 0 && usd === 0) return { text: "—", note: `${fmtTokens(unpriced)} tokens have no public price (unpriced)` };
  if (unpriced > 0) return { text: fmtUsd(usd), note: `at least: ${fmtTokens(unpriced)} more tokens have no public price (unpriced)` };
  return { text: fmtUsd(usd), note: "" };
}

/** Month `2026-10` -> `Oct 2026`; day `2026-10-14` -> `14 Oct`. Anything else is shown as it is. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function usageLabel(k) {
  const s = String(k ?? "");
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m && MONTHS[Number(m[2]) - 1]) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  m = /^\d{4}-(\d{2})-(\d{2})$/.exec(s);
  if (m && MONTHS[Number(m[1]) - 1]) return `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}`;
  return s;
}

/**
 * "Nice" y-axis for the cost chart: a step of 1 / 2 / 5 x 10^k with 3..5 ticks from 0 up to `top` (>= max, so the highest bar
 * fits). No data (0, NaN, negative) -> $0 and $1 so the grid still draws. Pure; tested for 0, tiny and huge maxima.
 */
export function niceTicks(max) {
  if (!isNum(max) || max <= 0) return { ticks: [0, 1], top: 1, step: 1 };
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
  const n = Math.max(1, Math.ceil(max / step - 1e-9));
  const ticks = [];
  for (let i = 0; i <= n; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { ticks, top: ticks[n], step };
}

/** A y-axis label: short and exact for the steps niceTicks makes ($0, $50, $1.5k, $2M, $0.002). */
export function tickLabel(v) {
  if (!isNum(v) || v <= 0) return "$0";
  const t = (x) => String(Number(x.toPrecision(3)));
  if (v >= 1e9) return `$${t(v / 1e9)}B`;
  if (v >= 1e6) return `$${t(v / 1e6)}M`;
  if (v >= 1e4) return `$${t(v / 1e3)}k`;
  if (v >= 1) return `$${Number.isInteger(v) ? v.toLocaleString("en-US") : String(Number(v.toFixed(2)))}`;
  return `$${t(v)}`;
}

/** 0 = Sunday .. 6 = Saturday of a `YYYY-MM-DD` day (calendar arithmetic in UTC, no time zone involved); -1 for junk. */
export function dayOfWeek(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ""))) return -1;
  const t = Date.parse(`${day}T00:00:00Z`);
  return isNum(t) ? new Date(t).getUTCDay() : -1;
}

/** Saturday or Sunday. */
export function isWeekend(day) {
  const w = dayOfWeek(day);
  return w === 0 || w === 6;
}

/**
 * Which of the (oldest first) `days` get an x-axis label: every Monday plus the last day (today). A Monday closer than
 * `minGap` columns to today (today wins) or to the previous label is dropped, so labels never collide. Ascending indices.
 */
export function dateTicks(days, minGap = 4) {
  const n = Array.isArray(days) ? days.length : 0;
  if (!n) return [];
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    if (dayOfWeek(days[i]) !== 1) continue;
    if (n - 1 - i < minGap) continue;
    if (out.length && i - out[out.length - 1] < minGap) continue;
    out.push(i);
  }
  out.push(n - 1);
  return out;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** `2026-10-11` -> `Sat 11 Oct` */
export function usageDayLabel(day) {
  const w = dayOfWeek(day);
  return w < 0 ? String(day ?? "") : `${WEEKDAYS[w]} ${usageLabel(day)}`;
}

/** The usage figures are refetched at most this often (the hosts push after a rollup, about every 15 min). */
export const USAGE_REFRESH_MS = 15 * 60_000;
/** Usage older than this (no host pushed since) gets a warning tone. */
export const USAGE_STALE_MS = 6 * 3_600_000;

/** One line about how fresh the figures are, from the Worker's `hosts` (`pushedAt` of each host): newest wins. */
export function usageFreshness(hosts, now) {
  const times = (Array.isArray(hosts) ? hosts : []).map((h) => h && h.pushedAt).filter(isNum);
  if (!times.length) return { text: "no host has reported usage yet", tone: "idle" };
  const newest = Math.max(...times);
  const age = Math.max(0, now - newest);
  return { text: `updated ${ago(newest, now)}`, tone: age > USAGE_STALE_MS ? "warn" : "ok" };
}

/** Is a fetched usage answer due again? (never fetched, older than the refresh time, or the clock went back) */
export function usageDue(fetchedAt, now) {
  return !isNum(fetchedAt) || fetchedAt <= 0 || fetchedAt > now || now - fetchedAt >= USAGE_REFRESH_MS;
}

// ── calendar heatmap, hourly view, host / app / project / model tree ───────────

const addDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The heatmap grid ending at `today` (a London calendar day): `weeks` columns of 7 days, Monday first, the last column holding the
 * week of today. Days after today are null (empty cells). Pure calendar arithmetic on `YYYY-MM-DD` (no clock, no time zone: BST
 * changes cannot shift a day). Returns { cols: [[day|null x7]...], from, to }.
 */
export function heatmapWeeks(today, weeks = 53) {
  if (dayOfWeek(today) < 0) return { cols: [], from: "", to: "" };
  const mondayOffset = (dayOfWeek(today) + 6) % 7; // days since Monday
  const lastMonday = addDay(today, -mondayOffset);
  const firstMonday = addDay(lastMonday, -7 * (weeks - 1));
  const cols = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const day = addDay(firstMonday, w * 7 + d);
      col.push(day > today ? null : day);
    }
    cols.push(col);
  }
  return { cols, from: firstMonday, to: today };
}

/** Month labels over the heatmap: the column index where each month's first Monday-week starts, at least `minGap` columns apart. */
export function heatmapMonths(cols, minGap = 3) {
  const out = [];
  let last = -minGap;
  cols.forEach((col, i) => {
    const first = col.find((d) => d && Number(d.slice(8, 10)) <= 7 && dayOfWeek(d) === 1);
    if (!first || i - last < minGap) return;
    out.push({ i, label: usageLabel(first.slice(0, 7)).slice(0, 3) });
    last = i;
  });
  return out;
}

/** The heatmap metric of an aggregate: `usd` (API-equivalent $), `tokens` (all five kinds) or `requests`. */
export function heatValue(a, metric) {
  if (!a) return 0;
  if (metric === "tokens") return [a.input, a.output, a.cacheRead, a.cacheWrite].reduce((n, v) => n + (isNum(v) ? v : 0), 0);
  if (metric === "requests") return isNum(a.requests) ? a.requests : 0;
  return isNum(a.usd) ? a.usd : 0;
}

/** Four thresholds splitting the non-zero values into quartiles (level 1..4); all-zero -> no thresholds. */
export function heatThresholds(values) {
  const nz = values.filter((v) => isNum(v) && v > 0).sort((a, b) => a - b);
  if (!nz.length) return [];
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))];
  return [q(0.25), q(0.5), q(0.75), nz[nz.length - 1]];
}

/** 0 (nothing) .. 4 (the top quartile). */
export function heatLevel(v, thresholds) {
  if (!isNum(v) || v <= 0 || !thresholds.length) return 0;
  for (let i = 0; i < 3; i++) if (v <= thresholds[i]) return i + 1;
  return 4;
}

/** `Mon 14 Oct 2026` in full words for screen readers. */
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function longDayLabel(day) {
  const w = dayOfWeek(day);
  if (w < 0) return String(day ?? "");
  return `${LONG_DAYS[w]} ${Number(day.slice(8, 10))} ${LONG_MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** The app of a usage row's `agent` label (`claude-cli.dev` -> `claude-cli`); a label from before apps were recorded -> `(other app)`. */
const APP_RE = /^(claude-(cli|desktop|ide|sdk)|codex-(cli|exec|desktop|ide)|unknown)(\.|$)/;
export function appOf(agent) {
  const m = APP_RE.exec(String(agent ?? ""));
  return m ? m[1] : "(other app)";
}

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, usd: 0, unpricedTokens: 0 });
function addAgg(t, r) {
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "requests", "usd", "unpricedTokens"]) t[k] += isNum(r[k]) ? r[k] : 0;
  return t;
}

/**
 * `hostBreakdown` rows -> host > app > project > leaf rows, each level with its summed aggregate, every level sorted by $ (then name).
 * Leaves keep the row (model, source, and the worktree after the dot of the agent label).
 */
export function usageTree(rows) {
  const hosts = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const app = appOf(r.agent);
    let hn = hosts.get(r.host);
    if (!hn) hosts.set(r.host, (hn = { name: r.host, agg: ZERO(), kids: new Map() }));
    let an = hn.kids.get(app);
    if (!an) hn.kids.set(app, (an = { name: app, agg: ZERO(), kids: new Map() }));
    let pn = an.kids.get(r.project);
    if (!pn) an.kids.set(r.project, (pn = { name: r.project, agg: ZERO(), rows: [] }));
    addAgg(hn.agg, r); addAgg(an.agg, r); addAgg(pn.agg, r);
    const dot = String(r.agent ?? "").indexOf(".");
    pn.rows.push({ ...r, worktree: app !== "(other app)" && dot > 0 ? r.agent.slice(dot + 1) : app === "(other app)" ? r.agent : "" });
  }
  const order = (a, b) => b.agg.usd - a.agg.usd || a.name.localeCompare(b.name);
  return [...hosts.values()].sort(order).map((h) => ({
    name: h.name, agg: h.agg,
    apps: [...h.kids.values()].sort(order).map((a) => ({
      name: a.name, agg: a.agg,
      projects: [...a.kids.values()].sort(order).map((p) => ({ name: p.name, agg: p.agg, rows: p.rows.sort((x, y) => (y.usd || 0) - (x.usd || 0) || String(x.model).localeCompare(String(y.model))) })),
    })),
  }));
}

/** `09:00` label of an hour `09`. */
export const hourLabel = (h) => `${String(h).padStart(2, "0")}:00`;

// ── overview (GET /api/usage?group=insights): KPI tiles, stacked series, rankings, weekday x hour, coverage ─────────

/** Sum of usage aggregates (non-numbers count as 0); `tokens` = all four kinds. */
export function sumAgg(list) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, usd: 0, unpricedTokens: 0, unpricedRequests: 0 };
  for (const a of Array.isArray(list) ? list : []) {
    if (!a) continue;
    for (const k of Object.keys(t)) t[k] += isNum(a[k]) ? a[k] : 0;
  }
  t.tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  return t;
}

/**
 * KPI periods from `daily` ({day, ...agg}, London days) ending at `today`. `cur` is what the tile shows (today included); the delta
 * compares like with like: today so far against yesterday up to the same hour (`sameTime` from the hourly rows; without it there is
 * no delta: `soFar`), and the last 7 / 30 COMPLETE days (ending yesterday) against the 7 / 30 before them. Each period:
 * { cur, cmp, prev, vs, soFar }. Pure calendar arithmetic on `YYYY-MM-DD`.
 */
export function kpiPeriods(daily, today, sameTime) {
  const by = new Map((Array.isArray(daily) ? daily : []).map((d) => [d.day, d]));
  const span = (endOffset, n) => sumAgg(Array.from({ length: n }, (_, i) => by.get(addDay(today, endOffset - i))));
  const st = sameTime && sameTime.yesterday && sameTime.yesterday.requests > 0 ? sameTime : null;
  const hour = st ? hourLabel(Number(st.hour) + 1 === 24 ? 0 : Number(st.hour) + 1) : "";
  return {
    today: st
      ? { cur: span(0, 1), cmp: sumAgg([st.today]), prev: sumAgg([st.yesterday]), vs: `vs yesterday by ${hour}`, soFar: false }
      : { cur: span(0, 1), cmp: null, prev: null, vs: "", soFar: true },
    d7: { cur: span(0, 7), cmp: span(-1, 7), prev: span(-8, 7), vs: "vs prev 7 d (full days)", soFar: false },
    d30: { cur: span(0, 30), cmp: span(-1, 30), prev: span(-31, 30), vs: "vs prev 30 d (full days)", soFar: false },
  };
}

/** Change of `cur` against `prev` in whole percent; null when there is nothing to compare with (prev 0). */
export function deltaPct(cur, prev) {
  if (!isNum(cur) || !isNum(prev) || prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** `▲ 12%` / `▼ 8%` / `± 0%` / `new` (nothing before) / `` (nothing at all), with a tone for the chip. More spend is not "bad": neutral tones. */
export function deltaText(cur, prev) {
  const d = deltaPct(cur, prev);
  if (d === null) return isNum(cur) && cur > 0 ? { text: "new", tone: "info", aria: "nothing in the period before" } : { text: "", tone: "idle", aria: "" };
  if (d === 0) return { text: "± 0%", tone: "idle", aria: "unchanged from the period before" };
  return { text: `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}%`, tone: d > 0 ? "up" : "down", aria: `${Math.abs(d)} percent ${d > 0 ? "more" : "less"} than the period before` };
}

/** Share of the prompt served from the cache: cache read / (fresh input + cache read + cache write); null without input. */
export function cacheShare(a) {
  const inp = (isNum(a && a.input) ? a.input : 0) + (isNum(a && a.cacheRead) ? a.cacheRead : 0) + (isNum(a && a.cacheWrite) ? a.cacheWrite : 0);
  return inp > 0 ? (isNum(a.cacheRead) ? a.cacheRead : 0) / inp : null;
}

/** Share of the requests whose model has no public price; null without requests. */
export function unpricedShare(a) {
  const r = isNum(a && a.requests) ? a.requests : 0;
  return r > 0 ? Math.min(1, (isNum(a.unpricedRequests) ? a.unpricedRequests : 0) / r) : null;
}

/** `62%`, `<1%` for a trace, `0%`, `—` for null. */
export function fmtPct(share) {
  if (!isNum(share)) return "—";
  if (share > 0 && share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** The fixed colour slot (1..9) of each app, so an app keeps its colour in every chart and theme; anything else is 8 (neutral). */
const APP_SLOT = { "claude-cli": 1, "claude-ide": 2, "codex-cli": 3, "claude-desktop": 4, "codex-desktop": 5, "claude-sdk": 6, "codex-exec": 7, "codex-ide": 9 };
export function appSlot(app) {
  return APP_SLOT[app] || 8;
}

/**
 * Stacked per-day series: rows {day, k, ...agg} -> the `top` keys by the metric over the whole range (the rest folded into
 * `(rest)`), and per day the parts in key order. `keyOf` maps a row's key first (e.g. appOf). Keys are sorted by total, biggest first.
 * Returns { keys: [{ k, total, slot }], days: [{ day, total, parts: [{ k, v }] }] }; slot = appSlot for apps, else the rank (1..6) and 8 for the rest.
 */
export function stackSeries(rows, days, { metric = "usd", top = 6, keyOf = (k) => k, apps = false } = {}) {
  const totals = new Map();
  const per = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = keyOf(r.k);
    const v = heatValue(r, metric);
    totals.set(k, (totals.get(k) || 0) + v);
    const key = `${r.day}\t${k}`;
    per.set(key, (per.get(key) || 0) + v);
  }
  const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const kept = ranked.slice(0, ranked.length > top ? top - 1 : top);
  const restKeys = new Set(ranked.slice(kept.length).map(([k]) => k));
  const keys = kept.map(([k, total], i) => ({ k, total, slot: apps ? appSlot(k) : i + 1 }));
  if (restKeys.size) keys.push({ k: "(rest)", total: [...restKeys].reduce((n, k) => n + totals.get(k), 0), slot: 8, n: restKeys.size });
  const out = (Array.isArray(days) ? days : []).map((day) => {
    const parts = keys.map(({ k }) => ({ k, v: k === "(rest)" ? [...restKeys].reduce((n, rk) => n + (per.get(`${day}\t${rk}`) || 0), 0) : per.get(`${day}\t${k}`) || 0 }));
    return { day, parts, total: parts.reduce((n, p) => n + p.v, 0) };
  });
  return { keys, days: out };
}

/** The `n` calendar days ending at `today`, oldest first. */
export function lastDays(today, n) {
  if (dayOfWeek(today) < 0) return [];
  return Array.from({ length: n }, (_, i) => addDay(today, i - n + 1));
}

/**
 * Ranking rows (biggest first) with each one's share of the whole and its bar length relative to the biggest (0..1).
 * `nameOf` gives the label. Rows with nothing (0 by the metric) are left out.
 */
export function ranking(rows, { metric = "usd", nameOf = (r) => r.k, limit = 8 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({ name: nameOf(r), v: heatValue(r, metric), r })).filter((x) => x.v > 0);
  list.sort((a, b) => b.v - a.v || String(a.name).localeCompare(String(b.name)));
  const total = list.reduce((n, x) => n + x.v, 0);
  const max = list.length ? list[0].v : 0;
  return list.slice(0, limit).map((x) => ({ ...x, share: total > 0 ? x.v / total : 0, len: max > 0 ? x.v / max : 0 }));
}

/**
 * The weekday x hour grid (Monday first, 24 hours) from `weekHour` cells ({w: 0 = Sunday .. 6, h: "00".."23", ...agg}):
 * rows [{ w, label, cells: [{ h, v, a }] }], plus quartile thresholds of the non-zero cells and the busiest cell.
 */
export function weekHourGrid(cells, metric = "requests") {
  const by = new Map((Array.isArray(cells) ? cells : []).map((c) => [`${c.w}:${String(c.h).padStart(2, "0")}`, c]));
  const order = [1, 2, 3, 4, 5, 6, 0];
  let peak = null;
  const rows = order.map((w) => ({
    w,
    label: WEEKDAYS[w],
    cells: Array.from({ length: 24 }, (_, i) => {
      const h = String(i).padStart(2, "0");
      const a = by.get(`${w}:${h}`) || null;
      const v = heatValue(a, metric);
      if (v > 0 && (!peak || v > peak.v)) peak = { w, h, v };
      return { h, v, a };
    }),
  }));
  const thresholds = heatThresholds(rows.flatMap((r) => r.cells.map((c) => c.v)));
  return { rows, thresholds, peak };
}

/**
 * What the chosen day's hours cover, from the hour answer's `coverage` ([{host, requests, hourly}]) and the totals:
 * kind "none" (no host sent hours for the day), "partial" (some requests are in the daily total only) or "full", the covered
 * share of the day's requests, and the hosts without hours.
 */
export function hourlyCoverage(hu) {
  const cov = Array.isArray(hu && hu.coverage) ? hu.coverage : null;
  const dayReq = isNum(hu && hu.dayTotal && hu.dayTotal.requests) ? hu.dayTotal.requests : 0;
  const hourReq = isNum(hu && hu.total && hu.total.requests) ? hu.total.requests : 0;
  const missing = cov ? cov.filter((c) => (c.hourly || 0) <= 0 && (c.requests || 0) > 0).map((c) => c.host) : [];
  if (dayReq <= 0 && hourReq <= 0) return { kind: "empty", share: null, missing };
  if (hourReq <= 0) return { kind: "none", share: 0, missing };
  const share = dayReq > 0 ? Math.min(1, hourReq / dayReq) : 1;
  return { kind: share >= 0.995 && !missing.length ? "full" : "partial", share, missing };
}

/** `2026-10-14T09` -> `14 Oct 09:00`; anything else as it is. */
export function hourStampLabel(hour) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/.exec(String(hour ?? ""));
  return m ? `${usageLabel(m[1])} ${m[1].slice(0, 4)} ${hourLabel(m[2])}` : String(hour ?? "");
}

/** Columns between x labels so labels of `labelPx` never touch on a plot `plotPx` wide with `n` columns (at least 4). */
export function tickGap(plotPx, n, labelPx = 46) {
  if (!isNum(plotPx) || plotPx <= 0 || !n) return 4;
  return Math.max(4, Math.ceil(labelPx / (plotPx / n)));
}

// ── MCP tasks that went quiet ───────────────────────────────────────────────

/** Grace after a stated ETA, and the silence that counts without one, before an MCP task shows as "no update since". */
export const MCP_QUIET_AFTER_ETA_MS = 30 * 60_000;
export const MCP_QUIET_NO_ETA_MS = 2 * 3_600_000;

/**
 * An open MCP task (desktop client) that has not been updated for its ETA + 30 min (2 h without an ETA): the agent has probably
 * finished without calling update_task. Neutral, never an alert. Blocked tasks are excluded (they wait on the operator).
 * Returns the `updated` time it has been quiet since, or null.
 */
export function mcpQuietSince(t, now) {
  if (!t || t.origin !== "mcp" || !["queued", "delivered", "acked", "running"].includes(t.state) || !isNum(t.updated)) return null;
  const limit = isNum(t.etaAt) ? Math.max(t.etaAt, t.updated) + MCP_QUIET_AFTER_ETA_MS : t.updated + MCP_QUIET_NO_ETA_MS;
  return now > limit ? t.updated : null;
}

/** `14:05` today, else `Fri 14:05` (local time of this browser). */
export function clockLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
}
