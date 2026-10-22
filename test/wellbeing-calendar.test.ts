/** Calendar Focus: URL guard (SSRF), the guarded fetch (redirects, timeout, size cap), ICS parsing, Focus from busy events, budget. */
import { describe, expect, test } from "bun:test";
import { route, runCron } from "../src/index";
import { applyPushPolicy, loadWbState, refreshCalendarIfDue, WB_DEFAULTS } from "../src/wellbeing";
import { CAL_MAX_BYTES, busyIntervals, calendarFocusUntil, calendarUrlProblem, fetchCalendar, maskCalendarUrl } from "../src/wellbeing-calendar";
import { makeCtx, makeEnv, request } from "./d1-shim";

const MIN = 60_000;
const H = 3_600_000;
const NOW = Date.parse("2027-01-15T10:11:00Z"); // a quarter hour's minute 11, London = UTC in January
const URL_OK = "https://calendar.example.com/private/abc123/basic.ics";

describe("URL guard", () => {
  test("https only, public hosts only, default port, no credentials", () => {
    expect(calendarUrlProblem(URL_OK)).toBeNull();
    for (const bad of ["", 42, null, "not a url at all"]) {
      expect([bad, calendarUrlProblem(bad) !== null]).toEqual([bad, true]);
    }
    expect(maskCalendarUrl(URL_OK)).toBe("calendar.example.com/…");
  });
});

describe("SSRF guard: table of bypass forms (all refused)", () => {
  const refused: Array<[string, string]> = [
    // IPv4 in every spelling the URL parser accepts (it turns them into dotted quads)
    ["https://127.0.0.1/c.ics", "dotted loopback"], ["https://2130706433/c.ics", "decimal"], ["https://0x7f.1/c.ics", "hex + short"],
    ["https://0x7f000001/c.ics", "hex"], ["https://017700000001/c.ics", "octal"], ["https://127.1/c.ics", "short form"], ["https://0177.0.0.1/c.ics", "octal octet"],
    ["https://10.0.0.1/c.ics", "private"], ["https://8.8.8.8/c.ics", "public IPv4 too: a DNS name is required"], ["https://169.254.169.254/latest", "metadata"],
    ["https://calendar.example.com.0x7f/c.ics", "numeric last label"], ["https://1.2.3.4./c.ics", "trailing dot"],
    // IPv6, every form
    ["https://[::1]/c.ics", "loopback"], ["https://[::ffff:127.0.0.1]/c.ics", "IPv4-mapped"], ["https://[::ffff:7f00:1]/c.ics", "IPv4-mapped hex"],
    ["https://[64:ff9b::7f00:1]/c.ics", "NAT64"], ["https://[2002:7f00:1::]/c.ics", "6to4"], ["https://[::7f00:1]/c.ics", "IPv4-compatible ::/96"],
    ["https://[fd00::1]/c.ics", "unique local"], ["https://[fe80::1]/c.ics", "link local"], ["https://[2606:4700::1111]/c.ics", "public IPv6 too"],
    // special-use and local names
    ["https://localhost/c.ics", "localhost"], ["https://localhost./c.ics", "localhost + dot"], ["https://LOCALHOST/c.ics", "upper case"],
    ["https://cal.localhost/c.ics", "*.localhost"], ["https://nas.local/c.ics", ".local"], ["https://svc.internal/c.ics", ".internal"],
    ["https://box.lan/c.ics", ".lan"], ["https://box.home/c.ics", ".home"], ["https://wiki.intranet/c.ics", ".intranet"], ["https://x.corp/c.ics", ".corp"],
    ["https://1.0.0.127.in-addr.arpa/c.ics", ".arpa"], ["https://x.home.arpa/c.ics", "home.arpa"], ["https://calendar.test/c.ics", ".test"],
    ["https://calendar.invalid/c.ics", ".invalid"], ["https://calendar.example/c.ics", ".example"], ["https://intranet/c.ics", "single label"],
    // scheme, port, user info
    ["http://calendar.example.com/c.ics", "http"], ["https://calendar.example.com:8443/c.ics", "port"], ["https://u:p@calendar.example.com/c.ics", "user info"],
    ["https://u@calendar.example.com/c.ics", "user name"], ["file:///etc/passwd", "file"], ["ftp://calendar.example.com/c.ics", "ftp"],
  ];
  for (const [url, why] of refused) test(`${why}: ${url}`, () => expect(calendarUrlProblem(url)).not.toBeNull());
  test("a public DNS name on https / 443 is accepted (also with :443 and a trailing dot)", () => {
    for (const ok of [URL_OK, "https://calendar.example.com:443/x.ics", "https://calendar.google.com./calendar/ical/x/basic.ics", "https://p01-caldav.icloud.com/x.ics"]) expect([ok, calendarUrlProblem(ok)]).toEqual([ok, null]);
  });
  test("every redirect hop is checked the same way (an IP literal or a special-use name in Location is refused)", async () => {
    for (const loc of ["https://2130706433/x", "https://[::ffff:127.0.0.1]/x", "https://svc.internal/x", "http://calendar.example.com/x"]) {
      await expect(fetchCalendar(URL_OK, async () => new Response(null, { status: 302, headers: { location: loc } }))).rejects.toThrow();
    }
  });
});

describe("guarded fetch", () => {
  const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
  test("follows a checked redirect; refuses one to a private address; too many redirects", async () => {
    const seen: string[] = [];
    const f = async (u: string) => {
      seen.push(u);
      if (u === URL_OK) return new Response(null, { status: 302, headers: { location: "https://cdn.example.net/feed.ics" } });
      return new Response(ics, { status: 200 });
    };
    expect(await fetchCalendar(URL_OK, f)).toBe(ics);
    expect(seen).toEqual([URL_OK, "https://cdn.example.net/feed.ics"]);
    const evil = async () => new Response(null, { status: 301, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    await expect(fetchCalendar(URL_OK, evil)).rejects.toThrow("refused URL");
    const loop = async (u: string) => new Response(null, { status: 302, headers: { location: `${u}x` } });
    await expect(fetchCalendar(URL_OK, loop)).rejects.toThrow("too many redirects");
  });
  test("1 MiB cap (by header and while reading); errors; the request uses redirect: manual and a signal", async () => {
    let init: RequestInit | undefined;
    await fetchCalendar(URL_OK, async (_u, i) => { init = i; return new Response(ics); });
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(fetchCalendar(URL_OK, async () => new Response("x", { headers: { "content-length": String(CAL_MAX_BYTES + 1) } }))).rejects.toThrow("too large");
    await expect(fetchCalendar(URL_OK, async () => new Response("x".repeat(CAL_MAX_BYTES + 10)))).rejects.toThrow("too large");
    await expect(fetchCalendar(URL_OK, async () => new Response("no", { status: 404 }))).rejects.toThrow("HTTP 4xx");
  });
});

describe("ICS parsing", () => {
  const cal = (...events: string[]) => ["BEGIN:VCALENDAR", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e.split("\n"), "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
  const from = Date.parse("2027-01-15T00:00:00Z");
  const to = from + 24 * H;
  test("UTC, TZID and floating times; folded lines; all-day, transparent and cancelled events skipped", () => {
    const b = busyIntervals(cal(
      "DTSTART:20270115T090000Z\nDTEND:20270115T100000Z\nSUMMARY:Standup",
      "DTSTART;TZID=Asia/Hong_Kong:20270115T200000\nDTEND;TZID=Asia/Hong_Kong:20270115T210000",
      "DTSTART:20270115T140000\nDTEND:20270115T15\n 0000",
      "DTSTART;VALUE=DATE:20270115\nDTEND;VALUE=DATE:20270116",
      "DTSTART:20270115T160000Z\nDTEND:20270115T170000Z\nTRANSP:TRANSPARENT",
      "DTSTART:20270115T180000Z\nDTEND:20270115T190000Z\nSTATUS:CANCELLED",
    ), from, to, "Europe/London");
    expect(b.map(([s, e]) => [new Date(s).toISOString().slice(11, 16), new Date(e).toISOString().slice(11, 16)])).toEqual([["09:00", "10:00"], ["12:00", "13:00"], ["14:00", "15:00"]]);
  });
  test("RRULE DAILY / WEEKLY with INTERVAL, COUNT, UNTIL; any other rule part = the first occurrence only", () => {
    const at = (d: string) => Date.parse(d);
    const daily = busyIntervals(cal("DTSTART:20270101T100000Z\nDTEND:20270101T103000Z\nRRULE:FREQ=DAILY"), from, to, "UTC");
    expect(daily).toEqual([[at("2027-01-15T10:00:00Z"), at("2027-01-15T10:30:00Z")]]);
    expect(busyIntervals(cal("DTSTART:20270101T100000Z\nDTEND:20270101T103000Z\nRRULE:FREQ=DAILY;COUNT=5"), from, to, "UTC")).toEqual([]);
    expect(busyIntervals(cal("DTSTART:20270101T100000Z\nDTEND:20270101T103000Z\nRRULE:FREQ=DAILY;UNTIL=20270110T000000Z"), from, to, "UTC")).toEqual([]);
    expect(busyIntervals(cal("DTSTART:20270108T120000Z\nDTEND:20270108T130000Z\nRRULE:FREQ=WEEKLY"), from, to, "UTC")).toEqual([[at("2027-01-15T12:00:00Z"), at("2027-01-15T13:00:00Z")]]);
    expect(busyIntervals(cal("DTSTART:20270101T120000Z\nDTEND:20270101T130000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2"), from, to, "UTC")).toEqual([[at("2027-01-15T12:00:00Z"), at("2027-01-15T13:00:00Z")]]);
    expect(busyIntervals(cal("DTSTART:20270101T120000Z\nDTEND:20270101T130000Z\nRRULE:FREQ=DAILY;BYDAY=MO"), from, to, "UTC")).toEqual([]);
    expect(busyIntervals(cal("DTSTART:20270101T120000Z\nDTEND:20270101T130000Z\nRRULE:FREQ=MONTHLY"), from, to, "UTC")).toEqual([]);
  });
  test("the busy interval on now is the Focus end", () => {
    expect(calendarFocusUntil([[NOW - MIN, NOW + 20 * MIN], [NOW + H, NOW + 2 * H]], NOW)).toBe(NOW + 20 * MIN);
    expect(calendarFocusUntil([[NOW + H, NOW + 2 * H]], NOW)).toBe(0);
  });
});

describe("end to end", () => {
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20270115T100000Z", "DTEND:20270115T110000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  test("POST stores the URL (never shown back); the tick reads it every 15 min (1 fetch, 2 statements); a busy event is Focus", async () => {
    const t = makeEnv();
    const ctx = makeCtx();
    const post = (body: unknown) => route(request("/api/wellbeing/calendar", { body }), t.env, ctx, { now: NOW });
    expect((await post({ url: "http://calendar.example.com/x.ics" })).status).toBe(400);
    expect((await post({ url: URL_OK })).status).toBe(200);
    const get = async (now: number) => (await (await route(request("/api/wellbeing"), t.env, ctx, { now })).json()) as any;
    const before = await get(NOW);
    expect(before.calendar).toMatchObject({ configured: true, host: "calendar.example.com/…" });
    expect(JSON.stringify(before)).not.toContain("abc123");
    let fetches = 0;
    const f = async () => { fetches++; return new Response(ics); };
    t.db.recordStatements = true;
    const n0 = t.db.statements.length;
    expect(await refreshCalendarIfDue(t.env.DB, NOW - MIN, f)).toBe(false); // minute 10: not its minute
    expect(await refreshCalendarIfDue(t.env.DB, NOW, f)).toBe(true);
    expect(fetches).toBe(1);
    expect(t.db.statements.length - n0).toBe(2);
    const after = await get(NOW + MIN);
    expect(after).toMatchObject({ focus: true, calendarFocus: true, calendar: { ok: true, focusUntil: Date.parse("2027-01-15T11:00:00Z") } });
    const st = await loadWbState(t.env.DB, NOW + MIN);
    expect(st?.focusUntil).toBe(Date.parse("2027-01-15T11:00:00Z"));
    // the policy: only approval-waiting goes out during the busy event
    const item = (key: string, rule: string) => ({ key, rule, severity: "warn", opened: NOW - H, origin: "host", host: "h", project: "p", agent: null, pushCount: 0, lastPushed: null, reminder: false }) as any;
    const p = applyPushPolicy([item("a", "approval-waiting"), item("b", "blocked")], { now: NOW + MIN, settings: { ...WB_DEFAULTS, groupWaitSec: 0 }, focusUntil: st!.focusUntil, quietLast: new Map() });
    expect([p.send.map((x) => x.key), p.hold.map((x) => x.key)]).toEqual([["a"], ["b"]]);
    // removing it clears the busy times too
    expect((await post({ url: null })).status).toBe(200);
    expect((await get(NOW + 2 * MIN)).calendar).toEqual({ configured: false });
  });
  test("a failing feed keeps the known busy times and says why (no URL in the message); the cron runs it at minute 11", async () => {
    const t = makeEnv();
    await route(request("/api/wellbeing/calendar", { body: { url: URL_OK } }), t.env, makeCtx(), { now: NOW });
    let calls = 0;
    const f = async (u: string) => { if (u.includes("calendar")) calls++; return new Response(ics); };
    await runCron(t.env, makeCtx(), NOW, { fetch: f }); // minute 11, but the first cron runs the purge: skipped
    expect(calls).toBe(0);
    t.db.sqlite.run("DELETE FROM meta WHERE k = 'last_tick'");
    await runCron(t.env, makeCtx(), NOW + MIN, { fetch: f }); // minute 12: the catch-up
    expect(calls).toBe(1);
    t.db.sqlite.run("DELETE FROM meta WHERE k = 'last_tick'");
    await runCron(t.env, makeCtx(), NOW + 2 * MIN, { fetch: f }); // minute 13: nothing
    expect(calls).toBe(1);
    await refreshCalendarIfDue(t.env.DB, NOW + 15 * MIN, async () => new Response("down", { status: 503 }));
    // minute 12 does not fetch again when minute 11 already did
    let again = 0;
    expect(await refreshCalendarIfDue(t.env.DB, NOW + 16 * MIN, async () => { again++; return new Response(ics); })).toBe(false);
    expect(again).toBe(0);
    const cal = JSON.parse(t.db.rows<{ v: string }>("SELECT v FROM wb_settings WHERE k = 'rt:cal'")[0]?.v as string);
    expect(cal).toMatchObject({ ok: false, error: "HTTP 5xx" });
    expect(cal.busy.length).toBe(1);
    expect(JSON.stringify(cal)).not.toContain("abc123");
  });
});

import { CAL_ERR, calendarError } from "../src/wellbeing-calendar";
describe("fixed failure texts", () => {
  test("only the fixed set reaches the page: never a URL, a host or an exception message", async () => {
    const fail = async (f: (u: string, i: RequestInit) => Promise<Response>) => { try { await fetchCalendar(URL_OK, f); return "ok"; } catch (e) { return calendarError(e); } };
    expect(await fail(async () => new Response("x", { status: 404 }))).toBe("HTTP 4xx");
    expect(await fail(async () => new Response("x", { status: 502 }))).toBe("HTTP 5xx");
    expect(await fail(async () => { throw new TypeError("getaddrinfo ENOTFOUND calendar.example.com"); })).toBe(CAL_ERR.failed);
    expect(await fail(async () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/x" } }))).toBe("refused URL");
    expect(await fail(async () => new Response("x".repeat(CAL_MAX_BYTES + 1)))).toBe("too large");
    expect(await fail(async (_u, i) => { await new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); return new Response(""); })).toBe("timeout");
    expect(calendarError(new Error("https://calendar.example.com/private/abc123 failed"))).toBe("fetch failed");
  }, 10_000);
});
