/**
 * @file Calendar Focus: a private ICS feed whose busy events switch Focus on for their duration. Rule-based ICS parsing, no AI.
 * @module dashboard-worker/wellbeing-calendar
 *
 * The URL is pasted on the page, stored server-side (`cal:url` in wb_settings) and never shown back in full (only its host).
 * The ticker fetches it at most every 15 minutes (minute CAL_TICK_MINUTE of each quarter hour, or the minute after when that
 * invocation ran the retention purge): https on port 443, a DNS name
 * (no IP literal of any kind, no special-use or single-label name), every redirect checked the same way (at most 3), a 5 s timeout
 * and a 1 MiB cap on the body. That is ONE subrequest per quarter hour (plus at most 3 for redirects), and 2 D1 statements.
 * Parsing: VEVENT blocks; DTSTART / DTEND as UTC (`Z`), with TZID (an IANA zone) or floating (the settings' zone); all-day
 * events, TRANSP:TRANSPARENT and STATUS:CANCELLED are skipped; RRULE only FREQ=DAILY / WEEKLY with INTERVAL / COUNT / UNTIL
 * (any other rule part: only the first occurrence is used). The busy intervals of the next 24 hours are kept (`rt:cal`).
 * Note: a Worker cannot resolve DNS before it fetches, so a public host name that resolves to a private address is not caught here.
 * On Cloudflare a Worker's fetch cannot reach private networks anyway; the Docker build CAN, so run it with egress restrictions
 * (no route to internal networks / metadata endpoints) if calendar feeds are used.
 */
import { localTime } from "./wellbeing";

export const CAL_TICK_MINUTE = 11;
export const CAL_TIMEOUT_MS = 5_000;
export const CAL_MAX_BYTES = 1 << 20;
export const CAL_MAX_REDIRECTS = 3;
export const CAL_WINDOW_MS = 24 * 3_600_000;
export const CAL_MAX_INTERVALS = 50;

// ── URL guard ────────────────────────────────────────────────────────────────

/** Special-use names (RFC 6761 / 6762 and common private zones): never a calendar host. */
const SPECIAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "intranet", "corp", "arpa", "test", "invalid", "example", "home.arpa"];

/** The URL's host name, normalised: lower case, without [ ] and without trailing dots. */
export function normalHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/**
 * Is this an acceptable calendar URL? https on port 443, no user name / password, and a DNS NAME: every IP literal is refused
 * (IPv4 in any spelling the URL parser accepts, e.g. 2130706433, 0x7f.1, 127.1, which it turns into dotted quads; every IPv6
 * form, including ::ffff:, 64:ff9b::, 2002:: and ::/96), as are special-use names and single-label hosts.
 */
export function calendarUrlProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 12 || raw.length > 2048) return "the calendar URL must be an https URL (at most 2048 characters)";
  let u: URL;
  try { u = new URL(raw); } catch { return "the calendar URL is not a valid URL"; }
  if (u.protocol !== "https:") return "the calendar URL must use https";
  if (u.username || u.password) return "the calendar URL must not contain a user name or password";
  if (u.port && u.port !== "443") return "the calendar URL must use port 443";
  if (u.hostname.includes(":") || u.hostname.startsWith("[")) return "the calendar host must be a DNS name, not an IP address";
  const h = normalHost(u);
  const labels = h.split(".");
  const last = labels[labels.length - 1] ?? "";
  // a numeric last label makes the WHOLE host an IPv4 address to the URL standard; dotted quads are what the parser leaves
  if (/^\d+(\.\d+){3}$/.test(h) || /^(0x[0-9a-f]*|\d+)$/.test(last)) return "the calendar host must be a DNS name, not an IP address";
  if (labels.length < 2 || labels.some((l) => l === "")) return "the calendar host must be a public DNS name";
  if (SPECIAL_SUFFIXES.some((x) => h === x || h.endsWith(`.${x}`))) return "the calendar host must be a public DNS name";
  return null;
}

/** Only the host, for the page ("calendar.example.com/…"): the rest of a private feed URL is its secret. */
export const maskCalendarUrl = (raw: string): string => {
  try { return `${new URL(raw).hostname}/…`; } catch { return "…"; }
};

/** The only failure texts the page ever shows (never a URL, a host or an exception's own message). */
export const CAL_ERR = {
  refused: "refused URL",
  timeout: "timeout",
  tooLarge: "too large",
  redirects: "too many redirects",
  parse: "parse error",
  failed: "fetch failed",
  http: (status: number) => `HTTP ${status >= 500 ? "5xx" : status >= 400 ? "4xx" : status >= 300 ? "3xx" : String(status)}`,
} as const;
const KNOWN_ERRORS = new Set([CAL_ERR.refused, CAL_ERR.timeout, CAL_ERR.tooLarge, CAL_ERR.redirects, CAL_ERR.parse, CAL_ERR.failed, "HTTP 3xx", "HTTP 4xx", "HTTP 5xx"]);
/** Any error -> one of the fixed texts. */
export const calendarError = (err: unknown): string => (err instanceof Error && KNOWN_ERRORS.has(err.message) ? err.message : CAL_ERR.failed);

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Fetch the feed: redirects followed by hand (each one checked), a timeout and a body cap. Throws a short message on failure. */
export async function fetchCalendar(url: string, fetchImpl: Fetcher): Promise<string> {
  let target = url;
  for (let hop = 0; hop <= CAL_MAX_REDIRECTS; hop++) {
    if (calendarUrlProblem(target)) throw new Error(CAL_ERR.refused);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CAL_TIMEOUT_MS);
    try {
      const res = await fetchImpl(target, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { Accept: "text/calendar, */*;q=0.1" } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(CAL_ERR.http(res.status));
        target = new URL(loc, target).toString();
        continue;
      }
      if (!res.ok) throw new Error(CAL_ERR.http(res.status));
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > CAL_MAX_BYTES) throw new Error(CAL_ERR.tooLarge);
      if (!res.body) return "";
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CAL_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error(CAL_ERR.tooLarge);
        }
        chunks.push(value);
      }
      const all = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.byteLength; }
      return new TextDecoder().decode(all);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(CAL_ERR.timeout);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(CAL_ERR.redirects);
}

// ── ICS parsing ──────────────────────────────────────────────────────────────

interface Prop { name: string; params: Record<string, string>; value: string }

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function prop(line: string): Prop | null {
  const i = line.indexOf(":");
  if (i < 1) return null;
  const [name, ...ps] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of ps) {
    const j = p.indexOf("=");
    if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value: line.slice(i + 1).trim() };
}

function validZone(tz: string | undefined): string | null {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return tz; } catch { return null; }
}

/** An ICS date-time -> UTC ms; null for a date-only value (all-day) or anything unreadable. */
export function icsTime(p: Prop, fallbackTz: string): number | null {
  if (p.params.VALUE === "DATE") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(p.value);
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const utc = Date.UTC(y, mo - 1, d, hh, mi, ss);
  if (m[7] === "Z") return utc;
  const tz = validZone(p.params.TZID) ?? fallbackTz;
  const lt = localTime(utc, tz);
  const asUtc = Date.UTC(Number(lt.day.slice(0, 4)), Number(lt.day.slice(5, 7)) - 1, Number(lt.day.slice(8, 10)), lt.hour, lt.minute, ss);
  return utc - (asUtc - utc);
}

/** The busy intervals [start, end] that overlap [from, to], from the feed's VEVENTs (see the file header). Sorted, capped. */
export function busyIntervals(ics: string, from: number, to: number, fallbackTz: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let ev: Prop[] | null = null;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") { ev = []; continue; }
    if (line === "END:VEVENT") {
      if (ev) out.push(...occurrences(ev, from, to, fallbackTz));
      ev = null;
      continue;
    }
    if (ev) { const p = prop(line); if (p) ev.push(p); }
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, CAL_MAX_INTERVALS);
}

function occurrences(ev: Prop[], from: number, to: number, tz: string): Array<[number, number]> {
  const get = (n: string) => ev.find((p) => p.name === n);
  if (get("TRANSP")?.value.toUpperCase() === "TRANSPARENT" || get("STATUS")?.value.toUpperCase() === "CANCELLED") return [];
  const ds = get("DTSTART");
  const de = get("DTEND");
  if (!ds || !de) return [];
  const start = icsTime(ds, tz);
  const end = icsTime(de, tz);
  if (start === null || end === null || end <= start || end - start > CAL_WINDOW_MS) return [];
  const len = end - start;
  const starts: number[] = [start];
  const rr = get("RRULE");
  if (rr) {
    const parts = Object.fromEntries(rr.value.split(";").map((x) => x.split("=")).filter((x) => x.length === 2).map(([k, v]) => [(k as string).toUpperCase(), v as string]));
    const known = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL"]);
    const simple = (parts.FREQ === "DAILY" || parts.FREQ === "WEEKLY") && Object.keys(parts).every((k) => known.has(k));
    if (simple) {
      const step = (parts.FREQ === "DAILY" ? 1 : 7) * Math.max(1, Math.min(365, Number(parts.INTERVAL ?? "1") || 1)) * 86_400_000;
      const count = parts.COUNT ? Math.max(1, Math.min(10_000, Number(parts.COUNT) || 1)) : Infinity;
      const until = parts.UNTIL ? icsTime({ name: "UNTIL", params: {}, value: parts.UNTIL.length === 8 ? `${parts.UNTIL}T235959Z` : parts.UNTIL }, tz) ?? Infinity : Infinity;
      // jump close to the window, then walk (bounded)
      const skip = Math.max(0, Math.floor((from - len - start) / step));
      for (let k = skip, n = 0; k < count && n < 400; k++, n++) {
        const s = start + k * step; // fixed UTC steps: an event across a DST change keeps its UTC time (documented simplification)
        if (s > to || s > until) break;
        if (k > 0) starts.push(s);
      }
    }
  }
  return starts.filter((s) => s < to && s + len > from).map((s) => [s, s + len] as [number, number]);
}

/** The end of the busy interval that contains `now` (the Focus end), or 0. */
export function calendarFocusUntil(busy: ReadonlyArray<[number, number]>, now: number): number {
  let until = 0;
  for (const [s, e] of busy) if (s <= now && now < e) until = Math.max(until, e);
  return until;
}
