// "You" card: the human side of the dashboard (well-being layer). Vanilla ES module, loaded by app.js.
// Reads GET /api/wellbeing (behind the same Access gate as /api/state) and writes the operator's own choices with same-origin
// JSON POSTs. Everything shown is computed by rules on the server or in format helpers: no AI anywhere.
// SECURITY: text only (textContent / text nodes), no inline style attributes in markup (the CSP forbids them).

import {
  GAUGE, INDICATOR_ICONS, INDICATOR_LABEL, INDICATOR_SHORT, LEVEL_WORD, TILE_ORDER, areaPath, bandFor, contributorBars, earlyState,
  gapCell, gapWords, weekdayShort, gaugeLayout, indicatorValue, linePath, sparkPath, tileTone, trendRows, whyText,
} from "/wellbeing-format.js";
import { showBuildLine } from "/version.js";
import { LIGHTS, energyLight, lightGradientStops, lightLegend, lightOf, lightScale, lightView, sustainedRed, thresholdsOf } from "/wellbeing-light.js";
import { rangeOf, rangeRows, rangesFor } from "/glance.js";
import { bigValue, feedWellbeing, pinButton, pinnedFirst, rangeControl, savedRange } from "/glance-ui.js";

const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const wb = { data: null, error: "", busy: false, started: false, fetchedAt: 0, span: 7, saved: "" };
/** The trend range (W / M), remembered in this browser; the server keeps 30 days of daily measures, so no longer range is offered. */
const WB_RANGES = rangesFor(30);
wb.span = rangeOf(savedRange("range.you", WB_RANGES, "W")).days;

/** `14:05` local to this browser. */
const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 401 || res.status === 403) throw new Error(`access denied (${res.status}); reload to sign in again`);
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  let out = null;
  try {
    out = await res.json();
  } catch {
    out = null;
  }
  if (!res.ok) throw new Error(out && typeof out.error === "string" ? out.error : `server answered ${res.status}`);
  return out;
}

async function act(fn) {
  if (wb.busy) return;
  wb.busy = true;
  try {
    await fn();
    wb.error = "";
    await load(true);
  } catch (err) {
    wb.error = err && err.message ? err.message : "network error";
    render();
  } finally {
    wb.busy = false;
  }
}

const setFocus = (minutes) => act(() => postJson("/api/wellbeing/focus", { minutes }));

function focusControls(d, now) {
  if (d.calendarFocus && d.calendar && d.calendar.focusUntil) {
    return h("div", { class: "row wb-focus" }, h("span", { class: "chip info", title: "A busy event in your calendar" }, `Focus (calendar) until ${hhmm(d.calendar.focusUntil)}`));
  }
  const on = d.focusUntil > now;
  return h(
    "div",
    { class: "row wb-focus" },
    on
      ? [h("span", { class: "chip info" }, `Focus until ${hhmm(d.focusUntil)}`), h("button", { type: "button", onclick: () => setFocus(0) }, "End focus")]
      : h("button", { type: "button", title: "Mute every push except actions waiting for approval for 60 minutes", onclick: () => setFocus(60) }, "Focus 60 min"),
  );
}

const SVGNS = "http://www.w3.org/2000/svg";
/** An SVG element (attributes only; never markup). */
function sv(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const svgTitle = (text) => sv("title", null, text);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;

/**
 * The gauge: a subtle full track, the value arc in the band's colour (round caps), a thin segmented scale of the four bands
 * outside it, a marker dot at the value, the score centred inside, and 0 / 50 / 100 ticks.
 */
function gauge(st, t, view) {
  const g = gaugeLayout(st.level, lightScale(t));
  return sv("svg", { class: "wb-gauge", viewBox: `0 0 ${GAUGE.w} ${GAUGE.h}`, role: "img", "aria-label": `${st.title}: ${st.level} of 100, ${view.light ? view.light.word : "no reading"}` },
    svgTitle(`${st.level} / 100 · ${view.light ? view.light.word : ""}`),
    ...g.scale.map((x) => sv("path", { d: x.d, class: `wb-gscale t-${x.tone}` })),
    sv("path", { d: g.track, class: "wb-gtrack" }),
    g.value ? sv("path", { d: g.value, class: `wb-gvalue t-${view.dot}` }) : null,
    sv("circle", { cx: g.marker[0], cy: g.marker[1], r: 7.5, class: `wb-gmark t-${view.dot}` }),
    sv("text", { x: GAUGE.cx, y: GAUGE.cy - 8, class: "wb-gscore", "text-anchor": "middle" }, String(st.level)),
    sv("text", { x: GAUGE.cx, y: GAUGE.cy + 9, class: "wb-gunit", "text-anchor": "middle" }, "of 100"),
    ...g.ticks.map((tk) => sv("text", { x: tk.x, y: tk.y, class: "wb-gtick", "text-anchor": "middle" }, tk.text)),
  );
}

/**
 * The hero: avatar + eyebrow + score + band pill (left), the top three contributors as bars (centre), the gauge (right). The
 * headline is "You" (your own input, when the hooks report it); the "Agents" line (everything your agents put on you) sits
 * under it. Without your input the hero is the Agents line and says how to get the You line.
 */
function stressHeader(d) {
  const you = d.stress.you || null;
  const st = you || d.stress;
  const who = you ? "You" : "Agents";
  const band = bandFor(st.level);
  // the traffic light (the user's thresholds): the dot always follows it; red text and the border only when red lasts
  const t = thresholdsOf(d.settings);
  const sustained = sustainedRed((st.day || []).filter((x) => x.hour <= d.hourNow).map((x) => x.stress), you ? [] : (d.stress.trend || []).map((x) => x.stress), t);
  const view = lightView(st.level, t, sustained);
  const tone = view.text;
  const bars = contributorBars(st.top, you ? 25 : 20, !!you);
  const changed = wb.prevLevel !== undefined && wb.prevLevel !== st.level;
  wb.prevLevel = st.level;
  return h(
    "div",
    { class: `wb-hero t-${tone}${view.border ? " wb-hero-red" : ""}` },
    h("div", { class: "wb-hero-id" },
      h("div", { class: `wb-avatar ring-${view.dot}`, role: "img", "aria-label": view.light ? view.light.word : band.label }, h("span", { "aria-hidden": "true" }, band.emoji)),
      h("div", { class: "wb-hero-score" },
        h("div", { class: "wb-eyebrow" }, `Stress (workload estimate) · ${who}`, h("span", { class: "wb-est" }, you && you.partial ? " · partial data" : " · estimated")),
        h("div", { class: "wb-score-row" }, h("span", { class: `wb-score${changed ? " chg" : ""}` }, String(st.level)), h("span", { class: "wb-of" }, "/100")),
        h("span", { class: `wb-pill t-${tone}`, title: view.light ? `${view.light.word} · ${band.label}` : band.label }, h("i", { class: `wb-dot t-${view.dot}`, "aria-hidden": "true" }), ` ${band.label}`, h("span", { class: "sr-only" }, view.light ? ` (${view.light.word})` : "")),
        view.light ? h("span", { class: "wb-light-hint muted small" }, view.light.hint) : null)),
    h("div", { class: "wb-hero-why" },
      h("div", { class: "wb-eyebrow" }, "What adds most"),
      bars.length
        ? h("ul", { class: "wb-bars", "aria-label": `Why: ${whyText(st.top)}` }, ...bars.map((x) => {
          const fill = h("i", { class: "wb-bar-fill" });
          fill.style.width = `${x.pct}%`;
          return h("li", { class: "wb-bar" },
            h("span", { class: "wb-bar-l" }, h("span", { "aria-hidden": "true" }, `${(INDICATOR_ICONS[x.name] || ["•"])[0]} `), x.label),
            h("span", { class: "wb-bar-v" }, `+${x.points}`),
            h("span", { class: "wb-bar-t", "aria-hidden": "true" }, fill));
        }))
        : h("p", { class: "wb-calm-note" }, "Nothing adds much right now."),
      h("p", { class: "wb-note" }, st.note),
      you && you.approvalsPerDay >= 10
        ? h("p", { class: "wb-agents-line" }, `✋ About ${you.approvalsPerDay} approvals a day. Run `, h("code", null, "siiswell permissions suggest"), " on your machine for allowlist ideas (it reads your local logs; nothing is sent).")
        : null,
      d.block && d.block.in ? h("p", { class: "wb-agents-line" }, `🔕 Agent-free block until ${new Date(d.block.until).toTimeString().slice(0, 5)}: questions and approvals wait for one summary.`) : null,
      d.away && d.away.away ? h("p", { class: "wb-agents-line" }, `🌙 Wind-down: agents are told you are away until ${d.settings.morning}.`) : null,
      you
        ? h("p", { class: "wb-agents-line" }, `Agents: ${d.stress.level}/100 · ${bandFor(d.stress.level).label} `, h("span", { "aria-hidden": "true" }, bandFor(d.stress.level).emoji), h("span", { class: "muted small" }, ` · ${whyText(d.stress.top)}`))
        : h("p", { class: "wb-agents-line muted small" }, "You: no data yet. Your own pace shows here once the siiswell hooks report (Claude Code hooks, docs/INSTALL-CLIENTS.md).")),
    h("div", { class: "wb-hero-gauge" }, gauge({ ...st, title: you ? "Stress (workload estimate) · You" : st.title }, t, view), battery(d)),
  );
}

/** The energy battery next to the gauge: the level, its light in words, and the note that it is an estimate. */
function battery(d) {
  const e = d.energy;
  if (!e || typeof e.level !== "number") return null;
  const l = energyLight(e.level, d.settings);
  const fill = h("i", { class: `wb-batt-fill t-${l.tone}` });
  fill.style.width = `${Math.max(2, e.level)}%`;
  return h("div", { class: "wb-batt", role: "img", "aria-label": `Energy (estimate): ${e.level} of 100, ${l.word}`, title: e.note },
    h("span", { class: "wb-batt-body", "aria-hidden": "true" }, fill),
    h("span", { class: "wb-batt-t" }, `Energy ${e.level}`),
    h("span", { class: "muted small" }, ` · ${l.word}`));
}

/** The build line at the foot of Settings (filled from /api/health once). */
function buildNote() {
  const p = h("p", { class: "muted build-line" });
  showBuildLine(p);
  return p;
}

/** Two progress rings (projects today, your active hours today) against your own limits (Settings). */
function targetRings(t) {
  const ring = (label, v, max) => {
    const pct = Math.max(0, Math.min(100, max ? (v / max) * 100 : 0));
    const r = 22, c = 2 * Math.PI * r;
    const tone = pct >= 100 ? "strained" : "calm"; // full = amber cue, never red
    return h("figure", { class: "wb-ring", role: "img", "aria-label": `${label}: ${v} of ${max}${pct >= 100 ? ", at your limit: a good moment to stop" : ""}` },
      sv("svg", { viewBox: "0 0 56 56", "aria-hidden": "true" },
        sv("circle", { cx: 28, cy: 28, r, class: "wb-ring-track" }),
        sv("circle", { cx: 28, cy: 28, r, class: `wb-ring-v t-${tone}`, "stroke-dasharray": `${((pct / 100) * c).toFixed(1)} ${c.toFixed(1)}`, transform: "rotate(-90 28 28)" }),
        sv("text", { x: 28, y: 32, "text-anchor": "middle", class: "wb-ring-t" }, `${v}/${max}`)),
      h("figcaption", { class: "muted small" }, label));
  };
  const at = t.projects >= t.maxProjects || t.activeHours >= t.maxActiveHours;
  return h("div", { class: "wb-rings" },
    ring("Projects today", t.projects, t.maxProjects),
    ring("Your active hours", t.activeHours, t.maxActiveHours),
    h("p", { class: "muted small" }, at ? "At your limit for today: worth wrapping up and letting the agents carry on." : "Within your limits for today."));
}

/** One status line: the light's dot and words, the value, and one gentle action. */
function statusLine(label, value, lightKey, action) {
  const l = lightKey ? LIGHTS[lightKey] : null;
  return h("p", { class: "wb-status" },
    h("i", { class: `wb-dot t-${l ? l.tone : "none"}`, "aria-hidden": "true" }),
    h("b", null, ` ${label}: `), value, l ? h("span", { class: "muted small" }, ` · ${l.word}`) : null,
    action ? h("span", { class: "wb-status-a" }, ` — ${action}`) : null);
}

const RATING = { 1: ["😌", "calm"], 2: ["🙂", "fine"], 3: ["😬", "tense"] };
/** One tap a day: how did today feel? One value per day (no text); shown next to the computed stress on the trend. */
function selfRating(d) {
  const today = (d.stress.trend || []).slice(-1)[0];
  const day = today ? today.day : null;
  const mine = day && d.ratings ? d.ratings[day] : undefined;
  return h("div", { class: "wb-rate", role: "group", "aria-label": "How does today feel? One tap; you can change it" },
    h("span", { class: "muted small" }, mine ? "Today you said " : "How does today feel? "),
    ...[1, 2, 3].map((v) => h("button", {
      type: "button", class: `more wb-rate-b${mine === v ? " on" : ""}`, "aria-pressed": String(mine === v), "aria-label": RATING[v][1],
      onclick: () => act(() => postJson("/api/wellbeing/rating", { value: v })),
    }, h("span", { "aria-hidden": "true" }, RATING[v][0]))));
}

/** Morning Readiness (morning time to noon): the label, the three contributors with their lights, ONE suggestion. */
function readinessCard(r) {
  return h("section", { class: "wb-sub wb-ready", "aria-label": `Morning readiness: ${r.label}` },
    h("div", { class: "wb-sub-h" }, h("h3", null, `Good morning · ${r.label}`)),
    statusLine("Last night's rest", r.rest.hours === null ? "no data" : `${r.rest.hours} h`, r.rest.light, null),
    statusLine("Yesterday", r.yesterday.stress === null ? `${r.yesterday.activeHours} active hours` : `stress ${r.yesterday.stress}, ${r.yesterday.activeHours} active hours`, r.yesterday.light, null),
    statusLine("After hours, 7 days", r.afterHours.pct === null ? "no data" : `${r.afterHours.pct} %`, r.afterHours.light, null),
    h("p", { class: "wb-ready-s" }, h("b", null, "Today: "), r.suggestion));
}

/** The rest block: the 7-day after-hours ratio (and, below, the rest gaps). */
function restLines(d) {
  const r = d.rest;
  const ah = r.afterHours;
  const g = r.lastGap;
  const cells = h("div", { class: "wb-gaps-box" },
    h("p", { class: "wb-gaps-cap muted small", id: "wb-gaps-cap" }, "Longest rest per day (hours, rest = no input from you)"),
    h("span", { class: "wb-gaps", role: "img", "aria-describedby": "wb-gaps-cap", "aria-label": `Longest rest per day, last ${r.gaps.length} days: ${r.gaps.map((x) => `${dayWords(x.day)} ${gapWords(x)}`).join(", ")}` },
      ...r.gaps.map((x) => h("i", { class: `wb-gap t-${x.light ? LIGHTS[x.light].tone : "none"}`, title: `${dayWords(x.day)}: ${x.noData ? "no data" : x.hours === null ? "not yet" : `longest rest ${x.hours} h`}` },
        h("span", { class: "wb-gap-d" }, weekdayShort(x.day)),
        h("span", { class: "wb-gap-v" }, gapCell(x))))));
  return h("div", { class: "wb-rest" },
    statusLine("After hours, last 7 days", ah.pct === null ? "no data yet" : `${ah.pct} % of ${ah.active} active hours`, ah.light, ah.action),
    statusLine("Longest rest", g ? `${g.hours} h before ${dayWords(g.day)} noon` : "no data yet", g ? g.light : null, g ? g.action : null),
    cells,
    r.kept && r.kept.days ? h("p", { class: "wb-kept" }, `${r.kept.endedEarly} of the last ${r.kept.days} days ended before ${r.kept.end} · ${r.kept.rested} of ${r.kept.days} had a rest of ${r.kept.rest} h or more.`) : null);
}

/** A 24-point sparkline (normalised 0-100), full width, in the tile's tone. */
function spark(values, tone) {
  const w = 100, ht = 18;
  const d = sparkPath(values, w, ht);
  // nothing to draw: a muted dashed baseline (never a coloured line that could read as "fine")
  return sv("svg", { class: `wb-spark t-${tone}`, viewBox: `0 0 ${w} ${ht}`, "aria-hidden": "true", preserveAspectRatio: "none" },
    d ? sv("path", { d, class: "wb-spark-l" }) : sv("line", { x1: 0, x2: w, y1: ht - 1, y2: ht - 1, class: "wb-spark-none" }));
}

/** The eight indicators as equal stat tiles (4 x 2; 2 x 4 on a phone): icon, label, value, status dot, 24 h sparkline. */
function indicatorChips(d) {
  const sp = (d.stress && d.stress.sparklines) || {};
  const by = new Map((d.indicators || []).map((i) => [i.name, i]));
  // the status dots follow the traffic light on each indicator's 0-100 value (its share of the stress formula)
  const t = thresholdsOf(d.settings);
  const norm = new Map(((d.stress && d.stress.contributions) || []).map((c) => [c.name, c.normalised]));
  wb.prevValues = wb.prevValues || {};
  return h("ul", { class: "wb-tiles", "aria-label": "Indicators" }, ...TILE_ORDER.filter((n) => by.has(n)).map((name) => {
    const i = by.get(name);
    const noData = tileTone(i) === "none";
    const tone = noData ? "none" : norm.has(name) ? lightOf(norm.get(name), t).tone : tileTone(i);
    const value = indicatorValue(name, i.value);
    const changed = wb.prevValues[name] !== undefined && wb.prevValues[name] !== value;
    wb.prevValues[name] = value;
    // not interactive: no tabindex; screen readers read the visually hidden sentence, the visible parts are decoration
    return h("li", { class: `wb-tile t-${tone}`, title: noData ? `${INDICATOR_LABEL[name] || name}: no data yet` : `${i.text} · ${LEVEL_WORD[i.level]} · the line: the last 24 hours` },
      h("span", { class: "sr-only" }, `${INDICATOR_LABEL[name] || name}: ${noData ? "no data" : `${value}, ${LEVEL_WORD[i.level]}`}`),
      h("div", { class: "wb-tile-top" },
        h("span", { class: "wb-tile-ic", "aria-hidden": "true" }, (INDICATOR_ICONS[name] || ["•"])[0]),
        h("span", { class: `wb-dot t-${tone}`, "aria-hidden": "true" })),
      h("span", { class: "wb-tile-l", "aria-hidden": "true" }, INDICATOR_LABEL[name] || name),
      h("span", { class: `wb-tile-v${changed ? " chg" : ""}`, "aria-hidden": "true" }, bigValue(value)),
      spark(noData ? [] : sp[name], tone));
  }));
}

/** A titled sub-card of the You section; with an `id` it can be pinned to the top of the card (this browser only). */
const section = (title, caption, ...kids) => sectionWith(null, title, caption, ...kids);
function sectionWith(id, title, caption, ...kids) {
  return h("section", { class: "wb-sub", "data-pin": id || null },
    h("div", { class: "wb-sub-h" }, h("h3", null, title), caption ? h("span", { class: "wb-cap-t" }, caption) : null, id ? pinButton("you", id, title, render) : null),
    ...kids);
}
const placeholder = (text) => h("div", { class: "wb-early" }, h("span", { class: "wb-early-ic", "aria-hidden": "true" }, "⏳"), h("span", null, text));

/**
 * The eight indicators (0 = calm, 100 = at the red threshold) as range bars: the shaded band is your usual range (the middle half of
 * the last 7 days), the tick your 7-day average, the dot now (in its light). Every row also says it in words, so the chart doubles
 * as its own table.
 */
function usualRange(d) {
  const st = d.stress;
  const lt = thresholdsOf(d.settings);
  const rows = rangeRows(st.radar);
  const pos = (el, v) => { el.style.left = `${v}%`; return el; };
  const list = h("ul", { class: "ur", "aria-label": "Indicators now against your usual range (0 = calm, 100 = at the red threshold)" }, ...rows.map((r) => {
    const name = INDICATOR_SHORT[r.name] || r.name;
    const track = h("span", { class: "ur-track", "aria-hidden": "true" });
    if (r.lo !== null && r.hi !== null) {
      const band = pos(h("i", { class: "ur-band" }), r.lo);
      band.style.width = `${Math.max(1.5, r.hi - r.lo)}%`;
      track.append(band);
    }
    if (r.avg !== null) track.append(pos(h("i", { class: "ur-avg" }), r.avg));
    if (r.now !== null) track.append(pos(h("i", { class: `ur-now t-${lightOf(r.now, lt).tone}` }), r.now));
    const usual = r.lo === null ? "no usual range yet" : `usual ${Math.round(r.lo)}–${Math.round(r.hi)}`;
    return h("li", { class: `ur-row ${r.place.key}`, title: `${name}: now ${r.now ?? "—"}, ${usual}, 7-day average ${r.avg === null ? "—" : Math.round(r.avg)} · ${r.place.text}` },
      h("span", { class: "ur-l" }, h("span", { "aria-hidden": "true" }, `${(INDICATOR_ICONS[r.name] || ["•"])[0]} `), name),
      track,
      h("span", { class: "ur-v" }, h("b", null, r.now === null ? "—" : String(Math.round(r.now))), h("span", { class: "muted small" }, ` · ${usual}`)),
      h("span", { class: "sr-only" }, ` · ${r.place.text}`));
  }));
  return h("figure", { class: "wb-fig ur-fig" }, list,
    h("figcaption", { class: "u-legend muted small" },
      h("span", { class: "wb-key urband" }, "usual range (middle half, 7 days)"), h("span", { class: "wb-key uravg" }, "7-day average"), h("span", { class: "wb-key urnow" }, "now")));
}

/**
 * Today's 24 hours: interrupt bars, the stress line over them, quiet hours shaded and a "now" marker. One focusable hour at a
 * time (arrows / Home / End), hover / tap / focus fills the detail line, like the usage charts.
 */
function dayCombo(d) {
  const st = d.stress;
  const W = 240, H = 80;
  const hours = st.day || [];
  const quiet = new Map((d.timeline || []).map((c) => [c.hour, c.quiet]));
  const maxI = Math.max(4, ...hours.map((x) => x.interrupts));
  const cw = W / 24;
  const detail = h("div", { class: "u-detail wb-detail", "aria-live": "polite" });
  const head = h("div", { class: "ch-head", "aria-hidden": "true" });
  const show = (x) => (head.replaceChildren(h("span", { class: "ch-k" }, "Stress"), x.stress === null ? h("span", { class: "ch-v muted" }, "—") : bigValue(`${x.stress}/100`, "ch-v"), h("span", { class: "ch-when" }, `${hh(x.hour)}–${hh((x.hour + 1) % 24)} · ${x.interrupts} interrupt${x.interrupts === 1 ? "" : "s"}`)), detail.replaceChildren(h("b", null, `${hh(x.hour)}–${hh((x.hour + 1) % 24)}`), ` · stress ${x.stress === null ? "no reading" : `${x.stress} (${lightOf(x.stress, thresholdsOf(d.settings)).word})`} · ${x.interrupts} interrupt${x.interrupts === 1 ? "" : "s"}${quiet.get(x.hour) ? " · quiet hours" : ""}`));
  const svg = sv("svg", { class: "wb-combo", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" },
    ...hours.filter((x) => quiet.get(x.hour)).map((x) => sv("rect", { x: x.hour * cw, y: 0, width: cw, height: H, class: "wb-q" })),
    ...[25, 50, 75].map((p) => sv("line", { x1: 0, x2: W, y1: H - (p / 100) * H, y2: H - (p / 100) * H, class: "wb-gridl" })),
    ...hours.map((x) => sv("rect", { x: x.hour * cw + cw * 0.18, width: cw * 0.64, y: H - (x.interrupts / maxI) * H * 0.9, height: (x.interrupts / maxI) * H * 0.9, class: "wb-ibar" })),
    sv("path", { d: linePath(hours.map((x) => x.stress), W, H), class: "wb-sline" }),
    // the energy battery (estimate): its curve over the day, rising in rest, falling under load
    d.energy ? sv("path", { d: linePath((d.energy.day || []).map((x) => x.level), W, H), class: "wb-eline" }) : null,
    // each hour's reading as a dot in its traffic-light colour (the line itself stays neutral)
    ...hours.filter((x) => typeof x.stress === "number").map((x) => sv("circle", { cx: (x.hour + 0.5) * cw, cy: H - (x.stress / 100) * H, r: 2.2, class: `wb-ldot t-${lightOf(x.stress, thresholdsOf(d.settings)).tone}` })),
    sv("line", { x1: (d.hourNow + 0.5) * cw, x2: (d.hourNow + 0.5) * cw, y1: 0, y2: H, class: "wb-nowl" }));
  const cols = [];
  const box = h("div", { class: "wb-cols", role: "group", "aria-label": "Today, per hour: stress and interrupts. Arrow keys move between hours." });
  hours.forEach((x, i) => {
    const b = h("button", { type: "button", class: `wb-col${x.hour === d.hourNow ? " now" : ""}`, tabindex: x.hour === d.hourNow ? "0" : "-1", "aria-label": `${hh(x.hour)}: stress ${x.stress === null ? "no reading" : x.stress}, ${x.interrupts} interrupts${quiet.get(x.hour) ? ", quiet hours" : ""}` });
    const sel = () => { cols.forEach((c, j) => { c.tabIndex = j === i ? 0 : -1; c.classList.toggle("sel", j === i); }); show(x); };
    b.addEventListener("mouseenter", sel);
    b.addEventListener("focus", sel);
    b.addEventListener("click", sel);
    b.addEventListener("keydown", (e) => {
      const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? 23 : -1;
      if (to < 0 || to > 23) return;
      e.preventDefault();
      cols[to].focus();
    });
    cols.push(b);
    box.append(b);
  });
  if (hours[d.hourNow]) show(hours[d.hourNow]);
  // the timeline band: blue = rest (no input from you), orange = your input, per hour of today; the dot = the hour's light
  const lt = thresholdsOf(d.settings);
  const eday = (d.energy && d.energy.day) || [];
  const band = eday.length ? h("div", { class: "wb-band", role: "img", "aria-label": `Today per hour: ${eday.filter((x) => x.kind).map((x) => `${hh(x.hour)} ${x.kind === "drain" ? "your input" : "rest"}`).join(", ")}` },
    ...eday.map((x) => {
      const st = hours[x.hour] && typeof hours[x.hour].stress === "number" ? lightOf(hours[x.hour].stress, lt) : null;
      return h("i", { class: `wb-band-c ${x.kind === "drain" ? "load" : x.kind === "charge" ? "rest" : "none"}`, title: `${hh(x.hour)}: ${x.kind === "drain" ? "your input" : x.kind === "charge" ? "rest" : "—"}${st ? ` · ${st.word}` : ""}` },
        st ? h("b", { class: `wb-band-d t-${st.tone}`, "aria-hidden": "true" }) : null);
    })) : null;
  return h("div", { class: "wb-combo-box" },
    h("div", { class: "wb-cap muted small" }, d.energy ? "Stress (line) · energy (dashed) · interrupts (bars) · per hour" : "Stress (line) · interrupts (bars) · per hour"),
    head,
    h("div", { class: "wb-plot" }, svg, box),
    band,
    band ? h("div", { class: "u-legend muted small" }, h("span", { class: "wb-key band-rest" }, "rest"), h("span", { class: "wb-key band-load" }, "your input"), h("span", null, "dot: the hour's light")) : null,
    h("div", { class: "wb-tl-x muted small", "aria-hidden": "true" }, ...["00", "06", "12", "18", "24"].map((t) => h("span", null, t))),
    detail,
    h("div", { class: "u-legend muted small" }, h("span", { class: "wb-key sline" }, "stress"), h("span", { class: "wb-key ibar" }, "interrupts"), h("span", { class: "wb-key q" }, "quiet hours"), h("span", { class: "wb-key nowl" }, "now")));
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayWords = (day) => {
  const t = new Date(`${day}T12:00:00Z`);
  return `${WD[t.getUTCDay()]} ${t.getUTCDate()} ${MON[t.getUTCMonth()]}`;
};

/**
 * The 7 / 30-day stress trend: the area under the daily average, a y-axis (0 / 50 / 100 and the band lines at 30 / 60 / 80),
 * day labels, and one focusable column per day (arrows / Home / End; hover / tap / focus fills the detail line).
 */
function stressTrendChart(d) {
  const t = (d.stress.trend || []).slice(-wb.span);
  const n = t.length;
  const W = 240, H = 60;
  const vals = t.map((x) => x.stress);
  const known = vals.filter((v) => typeof v === "number");
  if (!known.length) {
    return h("div", { class: "wb-trendchart" }, h("div", { class: "wb-cap muted small" }, `Stress (workload estimate) · daily average · ${wb.span} days`),
      h("div", { class: "muted small" }, "No stress readings yet: one is taken every 15 minutes."));
  }
  // hard stops at the band thresholds: the line and the area take the band colour of their height (like the gauge / heatmap)
  const lt = thresholdsOf(d.settings);
  const stops = lightGradientStops(lt).map((x) => sv("stop", { offset: `${x.offset}%`, class: `wb-gs-${x.tone}` }));
  const svg = sv("svg", { class: "wb-area", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" },
    sv("defs", null, sv("linearGradient", { id: "wb-band-grad", gradientUnits: "userSpaceOnUse", x1: 0, y1: H, x2: 0, y2: 0 }, ...stops)),
    ...[lt.yellow, lt.red].map((p) => sv("line", { x1: 0, x2: W, y1: H - (p / 100) * H, y2: H - (p / 100) * H, class: "wb-gridl band" })),
    sv("line", { x1: 0, x2: W, y1: H, y2: H, class: "wb-gridl" }),
    sv("path", { d: areaPath(vals, W, H), class: "wb-afill banded" }),
    sv("path", { d: linePath(vals, W, H), class: "wb-sline banded" }));
  const dots = h("div", { class: "wb-dots", "aria-hidden": "true" });
  t.forEach((x, i) => {
    if (x.stress === null) return;
    const dot = h("i", { class: `wb-dotm ${lightOf(x.stress, lt).tone}` });
    dot.style.left = `${((i + 0.5) / n) * 100}%`;
    dot.style.bottom = `${x.stress}%`;
    dots.append(dot);
  });
  // your own rating per day, above the dot of the computed value
  t.forEach((x, i) => {
    const r = d.ratings && d.ratings[x.day] ? RATING[d.ratings[x.day]] : null;
    if (!r) return;
    const e = h("i", { class: "wb-rated", "aria-hidden": "true" }, r[0]);
    e.style.left = `${((i + 0.5) / n) * 100}%`;
    dots.append(e);
  });
  const yaxis = h("div", { class: "wb-yaxis", "aria-hidden": "true" });
  for (const v of [0, 50, 100]) {
    const l = h("span", null, String(v));
    l.style.bottom = `${v}%`;
    yaxis.append(l);
  }
  const xaxis = h("div", { class: "u-xaxis", "aria-hidden": "true" });
  const step = n <= 7 ? 1 : 7;
  t.forEach((x, i) => {
    if ((n - 1 - i) % step !== 0) return;
    const l = h("span", { class: `u-xtick${i === n - 1 ? " today" : ""}` }, n <= 7 ? WD[new Date(`${x.day}T12:00:00Z`).getUTCDay()] : dayWords(x.day).slice(4));
    l.style.left = `${((i + 0.5) / n) * 100}%`;
    xaxis.append(l);
  });
  const detail = h("div", { class: "u-detail wb-detail", "aria-live": "polite" });
  const head = h("div", { class: "ch-head", "aria-hidden": "true" });
  const show = (x) => {
    const b = x.stress === null ? null : bandFor(x.stress);
    const said = d.ratings && d.ratings[x.day] ? RATING[d.ratings[x.day]] : null;
    head.replaceChildren(h("span", { class: "ch-k" }, "Average stress"), x.stress === null ? h("span", { class: "ch-v muted" }, "—") : bigValue(`${x.stress}/100`, "ch-v"), h("span", { class: "ch-when" }, dayWords(x.day)));
    // replaceChildren would print a null as "null": only the parts that exist
    detail.replaceChildren(...[h("b", null, dayWords(x.day)), x.stress === null ? " · no reading" : ` · average stress ${x.stress} · ${lightOf(x.stress, lt).word} · ${b.label} `, b ? h("span", { "aria-hidden": "true" }, b.emoji) : null, said ? ` · you said ${said[1]} ` : null, said ? h("span", { "aria-hidden": "true" }, said[0]) : null].filter((c) => c !== null));
  };
  const cols = [];
  const box = h("div", { class: "wb-cols", role: "group", "aria-label": `Stress (workload estimate), daily average, last ${n} days. Arrow keys move between days.` });
  box.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
  t.forEach((x, i) => {
    const b = h("button", { type: "button", class: "wb-col", tabindex: i === n - 1 ? "0" : "-1", "aria-label": `${dayWords(x.day)}: ${x.stress === null ? "no reading" : `average stress ${x.stress}, ${lightOf(x.stress, lt).word}`}` });
    const sel = () => { cols.forEach((c, j) => { c.tabIndex = j === i ? 0 : -1; c.classList.toggle("sel", j === i); }); show(x); };
    b.addEventListener("mouseenter", sel);
    b.addEventListener("focus", sel);
    b.addEventListener("click", sel);
    b.addEventListener("keydown", (e) => {
      const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
      if (to < 0 || to >= n) return;
      e.preventDefault();
      cols[to].focus();
    });
    cols.push(b);
    box.append(b);
  });
  show(t[n - 1]);
  // until a day is chosen, the header sums up the range: the average of the days with a reading
  const avgAll = Math.round(known.reduce((x, y) => x + y, 0) / known.length);
  head.replaceChildren(h("span", { class: "ch-k" }, "Average stress"), bigValue(`${avgAll}/100`, "ch-v"), h("span", { class: "ch-when" }, `last ${n} days`));
  return h("div", { class: "wb-trendchart" },
    h("div", { class: "wb-cap muted small" }, "Stress (workload estimate) · daily average"),
    head,
    h("div", { class: "wb-chart" }, yaxis, h("div", { class: "wb-chart-main" }, h("div", { class: "wb-plot wb-plot-trend" }, svg, dots, box), xaxis)),
    detail,
    h("div", { class: "u-legend muted small" }, h("span", null, `dashed lines: ${lt.yellow} and ${lt.red} · ${lightLegend(lt)}`)));
}

/** Weekday x hour: average stress over the last 30 days (the usage weekday x hour style). */
function weekHourStress(d) {
  const cells = new Map((d.stress.weekHour || []).map((c) => [`${c.w}:${c.h}`, c]));
  const lt = thresholdsOf(d.settings);
  const order = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
  const grid = h("div", { class: "u-wh", role: "group", "aria-label": "Average stress per weekday and hour over the last 30 days. Arrow keys move between the coloured hours." });
  // the hovered / focused hour: its rounded value drawn inside the square (wide screens) and this line (on a phone)
  const detail = h("div", { class: "u-detail wb-wh-detail", "aria-live": "polite" });
  const slots = [];
  grid.append(h("span", { class: "u-wh-corner", "aria-hidden": "true" }));
  for (let i = 0; i < 24; i++) grid.append(h("span", { class: "u-wh-hl", "aria-hidden": "true" }, i % 6 === 0 ? String(i).padStart(2, "0") : ""));
  for (const [w, label] of order) {
    grid.append(h("span", { class: "u-wh-dl", "aria-hidden": "true" }, label));
    for (let hr = 0; hr < 24; hr++) {
      const c = cells.get(`${w}:${hr}`);
      const b = c ? lightOf(c.stress, lt) : null;
      const tip = c ? `${label} ${hh(hr)} · avg ${Math.round(c.stress)} · ${bandFor(c.stress).label}` : `${label} ${hh(hr)} · no reading`;
      const el = h("i", { class: `u-wh-c ${b ? `wb-s ${b.band}` : "h0"}`, role: "img", "aria-label": c ? `${tip} · ${b.word}` : tip, title: c ? `${tip} (${c.n} reading${c.n === 1 ? "" : "s"})` : tip });
      if (c) {
        const v = h("span", { class: "u-wh-v", "aria-hidden": "true" });
        el.append(v);
        el.tabIndex = slots.length ? -1 : 0;
        const show = () => {
          slots.forEach((x) => { x.el.classList.remove("on"); x.v.textContent = ""; });
          el.classList.add("on");
          v.textContent = String(Math.round(c.stress));
          detail.replaceChildren(h("b", null, `${label} ${hh(hr)}`), ` · avg ${Math.round(c.stress)} · ${bandFor(c.stress).label} · ${b.word}`);
        };
        const hide = () => { if (document.activeElement !== el) { el.classList.remove("on"); v.textContent = ""; } };
        el.addEventListener("mouseenter", show);
        el.addEventListener("mouseleave", hide);
        el.addEventListener("focus", show);
        el.addEventListener("blur", () => { el.classList.remove("on"); v.textContent = ""; });
        const i = slots.length;
        el.addEventListener("keydown", (e) => {
          const to = e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? slots.length - 1 : -1;
          if (to < 0 || to >= slots.length) return;
          e.preventDefault();
          slots.forEach((x, j) => { x.el.tabIndex = j === to ? 0 : -1; });
          slots[to].el.focus();
        });
        slots.push({ el, v });
      }
      grid.append(el);
    }
  }
  return h("div", { class: "wb-wh" }, grid, detail,
    h("div", { class: "u-legend muted small" }, ...Object.values(LIGHTS).map((l) => h("span", { class: `wb-key s ${l.band}` }, l.word)), h("span", null, ` (${lightLegend(lt)})`)));
}

/** 7 / 30-day trends: one row of day cells per measure, like the usage calendar, with the average. */
function trends(d) {
  const rows = trendRows(d.trends || [], wb.span);
  const current = WB_RANGES.find((r) => r.days === wb.span) || WB_RANGES[0];
  const seg = rangeControl("range.you", WB_RANGES, current.key, (k) => { wb.span = rangeOf(k).days; render(); }, "Trend range");
  const table = h("div", { class: "wb-trends" });
  for (const r of rows) {
    table.append(
      h("span", { class: "wb-tr-l" }, r.label),
      h("span", { class: `wb-tr-cells n${wb.span}`, role: "img", "aria-label": `${r.label}, last ${wb.span} days: average ${r.avgText}` },
        ...r.cells.map((c) => h("i", { class: `u-hc h${c.level}`, title: `${c.day}: ${c.text}` }))),
      h("span", { class: "wb-tr-v" }, r.avgText),
    );
  }
  return h("div", { class: "wb-trend-box" }, h("div", { class: "wb-cap muted small" }, h("span", null, "Daily measures · average on the right"), seg), table);
}

function settingsPanel(d) {
  // an edit in progress survives the page's minute refresh: the same form is kept until it is saved
  if (wb.dirty && wb.settingsEl) return wb.settingsEl;
  const s = d.settings;
  const f = {
    tz: h("input", { type: "text", value: s.tz, autocomplete: "off", spellcheck: "false", "aria-describedby": "wb-tz-help" }),
    quietStart: h("input", { type: "time", value: s.quietStart, step: "60" }),
    quietEnd: h("input", { type: "time", value: s.quietEnd, step: "60" }),
    weekendsQuiet: h("input", { type: "checkbox" }),
    digestMin: h("select", null, ...[15, 30, 60, 120].map((m) => h("option", { value: String(m) }, `${m} min`))),
    nudges: h("input", { type: "checkbox" }),
    wellbeingPush: h("input", { type: "checkbox" }),
    summaryTimes: h("input", { type: "text", value: (s.summaryTimes || []).join(", "), autocomplete: "off", inputmode: "numeric" }),
    groupWaitSec: h("select", null, ...[0, 15, 30, 60].map((n) => h("option", { value: String(n) }, n ? `${n} s` : "off"))),
    microBreakMin: h("input", { type: "number", min: "15", max: "240", step: "5", value: String(s.microBreakMin ?? 90), inputmode: "numeric" }),
    maxProjects: h("input", { type: "number", min: "1", max: "30", step: "1", value: String(s.maxProjects ?? 4), inputmode: "numeric" }),
    maxActiveHours: h("input", { type: "number", min: "1", max: "24", step: "1", value: String(s.maxActiveHours ?? 10), inputmode: "numeric" }),
    switchYellow: h("input", { type: "number", min: "1", max: "49", step: "1", value: String(s.switchYellow ?? 4), inputmode: "numeric" }),
    switchRed: h("input", { type: "number", min: "2", max: "50", step: "1", value: String(s.switchRed ?? 8), inputmode: "numeric" }),
    keptEnd: h("input", { type: "time", value: s.keptEnd || "23:00", step: "60" }),
    keptRest: h("input", { type: "number", min: "1", max: "23", step: "1", value: String(s.keptRest ?? 8), inputmode: "numeric" }),
    freeBlocks: h("input", { type: "text", value: (s.freeBlocks || []).join(", "), autocomplete: "off", placeholder: "13:00-14:00" }),
    restYellow: h("input", { type: "number", min: "2", max: "23", step: "1", value: String(s.restYellow ?? 6), inputmode: "numeric" }),
    restRed: h("input", { type: "number", min: "1", max: "22", step: "1", value: String(s.restRed ?? 4), inputmode: "numeric" }),
    afterHoursYellow: h("input", { type: "number", min: "1", max: "98", step: "1", value: String(s.afterHoursYellow ?? 20), inputmode: "numeric" }),
    afterHoursRed: h("input", { type: "number", min: "2", max: "99", step: "1", value: String(s.afterHoursRed ?? 35), inputmode: "numeric" }),
    energyGreen: h("input", { type: "number", min: "2", max: "99", step: "1", value: String(s.energyGreen ?? 50), inputmode: "numeric" }),
    energyYellow: h("input", { type: "number", min: "1", max: "98", step: "1", value: String(s.energyYellow ?? 25), inputmode: "numeric" }),
    lightYellow: h("input", { type: "number", min: "1", max: "98", step: "1", value: String(s.lightYellow ?? 40), inputmode: "numeric" }),
    lightRed: h("input", { type: "number", min: "2", max: "99", step: "1", value: String(s.lightRed ?? 70), inputmode: "numeric" }),
    approvalBatchMin: h("select", null, ...[0, 15, 30].map((n) => h("option", { value: String(n) }, n ? `every ${n} min` : "off (push each one)"))),
    windDownOn: h("input", { type: "checkbox" }),
    windDown: h("input", { type: "time", value: s.windDown || "23:00", step: "60" }),
    morning: h("input", { type: "time", value: s.morning || "07:00", step: "60" }),
  };
  f.windDownOn.checked = !!s.windDown;
  f.approvalBatchMin.value = String(s.approvalBatchMin ?? 0);
  f.groupWaitSec.value = String(s.groupWaitSec ?? 30);
  f.weekendsQuiet.checked = s.weekendsQuiet;
  f.nudges.checked = s.nudges;
  f.wellbeingPush.checked = s.wellbeingPush !== false;
  f.digestMin.value = String(s.digestMin);
  const field = (label, el, help) => h("label", { class: "wb-field" }, h("span", null, label), el, help || null);
  const save = h("button", { type: "submit" }, "Save");
  const status = h("span", { class: "muted small", role: "status" }, wb.saved);
  const form = h(
    "form",
    { class: "wb-settings-form" },
    field("Time zone", f.tz, h("span", { id: "wb-tz-help", class: "muted small" }, "IANA name, e.g. Europe/London")),
    h("div", { class: "row" }, field("Quiet from", f.quietStart), field("until", f.quietEnd)),
    field("Weekends are quiet all day", f.weekendsQuiet),
    field("Scheduled Summary every", f.digestMin),
    field("Scheduled Summary times (HH:MM, comma-separated, up to 4)", f.summaryTimes),
    field("Gentle nudges", f.nudges),
    field("Send well-being reminders as push (at most 4 a day, never in Focus, quiet hours or an agent-free block)", f.wellbeingPush),
    h("fieldset", { class: "wb-grouping" },
      h("legend", null, "Traffic light"),
      h("div", { class: "row" }, field("Yellow from", f.lightYellow), field("Red from", f.lightRed)),
      h("p", { class: "muted small" }, "OK below yellow, Watch up to red, Rest from red (1-99, yellow below red)."),
      h("div", { class: "row" }, field("Energy green from", f.energyGreen), field("Energy yellow from", f.energyYellow)),
      h("div", { class: "row" }, field("After hours yellow above %", f.afterHoursYellow), field("red above %", f.afterHoursRed)),
      h("div", { class: "row" }, field("Rest yellow below (hours)", f.restYellow), field("red below", f.restRed)),
      h("div", { class: "row" }, field("A kept day ends before", f.keptEnd), field("and rests at least (hours)", f.keptRest)),
      h("div", { class: "row" }, field("Switches per hour yellow from", f.switchYellow), field("red from", f.switchRed)),
      h("div", { class: "row" }, field("Daily target: projects", f.maxProjects), field("active hours", f.maxActiveHours)),
      field("Suggest a short break after (minutes of continuous activity)", f.microBreakMin)),
    h("fieldset", { class: "wb-grouping" },
      h("legend", null, "Wind-down"),
      field("Wind down every evening", f.windDownOn),
      h("div", { class: "row" }, field("at", f.windDown), field("morning at", f.morning)),
      field("Agent-free blocks (HH:MM-HH:MM, comma-separated, up to 3)", f.freeBlocks),
      h("p", { class: "muted small" }, "During a block agents are told you are away (operator_status) and every push waits; one summary comes when it ends."),
      h("p", { class: "muted small" }, "At the wind-down time you get a \"safe to leave\" summary, and agents that ask operator_status are told you are away until the morning time: they carry on and keep their questions. The morning summary says what happened overnight.")),
    h("fieldset", { class: "wb-grouping" },
      h("legend", null, "Grouping"),
      field("Group wait (a new Time-Sensitive item waits for others of the same moment)", f.groupWaitSec),
      field("Approval inbox (approvals arrive together instead of one push each)", f.approvalBatchMin),
      h("p", { class: "muted small" }, `Group interval: the Scheduled Summary interval (${s.digestMin} min). Repeat: an action still waiting is pushed again after 15, 30, 60 and 120 min, then only the summary mentions it.`),
      h("p", { class: "muted small" }, "Inhibition: an offline host mutes its reporters' and agents' pushes (the host is the one push); a blocked task mutes its own overdue push. The items stay on this page.")),
    h("div", { class: "row" }, save, status),
    h("div", { class: "row" }, h("button", {
      type: "button", class: "more", title: "Nudges you dismissed with Not today or Never can show again",
      onclick: () => act(async () => { for (const id of ["session", "late", "burn", "weekly", "pace", "intensity", "microbreak", "readiness"]) await postJson("/api/wellbeing/nudge", { id, until: "reset" }); wb.saved = "Dismissed nudges can show again."; }),
    }, "Show dismissed nudges again")),
  );
  form.addEventListener("input", () => { wb.dirty = true; });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    wb.saved = "";
    act(async () => {
      await postJson("/api/wellbeing/settings", {
        tz: f.tz.value.trim(), quietStart: f.quietStart.value, quietEnd: f.quietEnd.value, weekendsQuiet: f.weekendsQuiet.checked,
        digestMin: Number(f.digestMin.value), nudges: f.nudges.checked, wellbeingPush: f.wellbeingPush.checked, groupWaitSec: Number(f.groupWaitSec.value),
        summaryTimes: f.summaryTimes.value.split(",").map((x) => x.trim()).filter(Boolean),
        windDown: f.windDownOn.checked ? f.windDown.value : "", morning: f.morning.value, approvalBatchMin: Number(f.approvalBatchMin.value),
        lightYellow: Number(f.lightYellow.value), lightRed: Number(f.lightRed.value),
        energyGreen: Number(f.energyGreen.value), energyYellow: Number(f.energyYellow.value),
        afterHoursYellow: Number(f.afterHoursYellow.value), afterHoursRed: Number(f.afterHoursRed.value),
        restYellow: Number(f.restYellow.value), restRed: Number(f.restRed.value),
        keptEnd: f.keptEnd.value, keptRest: Number(f.keptRest.value),
        switchYellow: Number(f.switchYellow.value), switchRed: Number(f.switchRed.value),
        maxProjects: Number(f.maxProjects.value), maxActiveHours: Number(f.maxActiveHours.value), microBreakMin: Number(f.microBreakMin.value),
        freeBlocks: f.freeBlocks.value.split(",").map((x) => x.trim()).filter(Boolean),
      });
      wb.saved = "Saved.";
      wb.dirty = false; // only now may the form show the stored values again (a refused save keeps the edits)
    });
  });
  const det = h("details", { class: "wb-settings" }, h("summary", null, h("span", { class: "chev", "aria-hidden": "true" }), "Settings"), form, calendarForm(d), buildNote());
  if (wb.settingsOpen) det.open = true;
  det.addEventListener("toggle", () => { wb.settingsOpen = det.open; });
  wb.settingsEl = det;
  return det;
}

/** The weekly card's key numbers as small chips ("Calmest day: Tue 😌"). */
function weekNumbers(w) {
  const chip = (label, value) => (value ? h("span", { class: "chip info" }, `${label}: ${value}`) : null);
  return [chip("Average stress", `${w.avgStress} ${w.emoji}`), chip("Calmest day", w.calmest), chip("Busiest day", w.busiest), chip("Busiest hour", w.busiestHour ? `${w.busiestHour} 🔔` : null)];
}

/** Calendar Focus: a private ICS URL (stored on the server, never shown back), busy events switch Focus on. */
function calendarForm(d) {
  const c = d.calendar || { configured: false };
  const input = h("input", { type: "url", inputmode: "url", autocomplete: "off", spellcheck: "false", placeholder: c.configured ? `connected: ${c.host}` : "https://…/private.ics" });
  const status = c.configured
    ? `Connected: ${c.host}${c.lastFetch ? ` · checked ${hhmm(c.lastFetch)}${c.ok ? "" : ` · ${c.error || "could not read it"}`}` : " · first check within 15 min"}`
    : "Not connected. Busy events in the calendar switch Focus on for their duration.";
  const save = h("button", { type: "submit" }, c.configured ? "Replace" : "Connect");
  const form = h("form", { class: "wb-settings-form wb-cal" },
    h("label", { class: "wb-field" }, h("span", null, "Calendar Focus (private ICS URL)"), input),
    h("p", { class: "muted small" }, status, ". The URL is kept on the server and never shown again; it is read every 15 minutes."),
    h("div", { class: "row" }, save, c.configured ? h("button", { type: "button", class: "more", onclick: () => act(() => postJson("/api/wellbeing/calendar", { url: null })) }, "Remove") : null));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    act(() => postJson("/api/wellbeing/calendar", { url }));
  });
  return form;
}

/** Gentle nudges: plain words, each with "Not today" and "Never" (they never block anything). */
function nudgeCards(d) {
  const list = Array.isArray(d.nudges) ? d.nudges : [];
  // each nudge counts against its daily cap / cooldown once it has been on screen (reported once per appearance)
  wb.shown = wb.shown || new Set();
  for (const n of list) {
    const k = `${n.id}|${n.scope}`;
    if (wb.shown.has(k)) continue;
    wb.shown.add(k);
    postJson("/api/wellbeing/nudge", { id: n.id, until: "shown", scope: n.scope }).catch(() => wb.shown.delete(k));
  }
  return list.map((n) =>
    h(
      "aside",
      { class: `card wb-nudge${n.id === "weekly" ? " weekly" : ""}`, "aria-label": n.title },
      n.id === "weekly" && d.stress && d.stress.week
        ? h("div", { class: "wb-week-head" },
          h("span", { class: "wb-week-emo", role: "img", "aria-label": `mood of the week: ${d.stress.week.mood}` }, h("span", { "aria-hidden": "true" }, d.stress.week.emoji)),
          h("b", null, n.title),
          h("span", { class: "wb-week-nums" }, ...weekNumbers(d.stress.week)))
        : h("b", null, n.title),
      ...(n.id === "weekly" ? [h("ul", { class: "wb-reflect" }, ...n.text.map((t) => h("li", null, t)))] : n.text.map((t) => h("p", { class: "sub" }, t))),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "more", onclick: () => act(() => postJson("/api/wellbeing/nudge", { id: n.id, until: "today", scope: n.scope })) }, "Not today"),
        h("button", { type: "button", class: "more", title: "Settings can bring it back", onclick: () => act(() => postJson("/api/wellbeing/nudge", { id: n.id, until: "never" })) }, "Never"),
      ),
    ));
}

function render() {
  const box = $("you");
  if (!box) return;
  const d = wb.data;
  box.replaceChildren();
  if (!d) {
    box.append(h("div", { class: "empty" }, wb.error ? `Could not load: ${wb.error}` : "Loading…"));
    return;
  }
  const now = Date.now();
  const card = h("article", { class: "card wb-you" });
  let line;
  if (d.pending) line = "Well-being storage is not set up yet (apply migration 0007): defaults apply, nothing can be changed.";
  else if (d.focus) line = "Focus is on: only actions waiting for approval are pushed.";
  else if (d.quietNow) line = `Quiet hours (${d.settings.quietStart}–${d.settings.quietEnd}): only Time-Sensitive items are pushed, the first per project in an hour; the rest comes in the morning Scheduled Summary.`;
  else line = `Time-Sensitive items are pushed at once; the rest arrive in a Scheduled Summary every ${d.settings.digestMin} min${(d.settings.summaryTimes || []).length ? ` and at ${d.settings.summaryTimes.join(", ")}` : ""}.`;
  if (!d.pending && d.stress) card.append(stressHeader(d));
  if (!d.pending && d.readiness) card.append(readinessCard(d.readiness));
  if (!d.pending && d.stress) card.append(selfRating(d));
  // the rest of the card in its usual order; a sub-section the viewer pinned moves up, under the headline (pins: this browser only)
  const subs = [];
  const add = (id, make) => subs.push([id, make]);
  if (!d.pending && d.rest) add("rest", () => sectionWith("rest", "Rest", "from your own input", restLines(d)));
  if (!d.pending && d.target) add("target", () => sectionWith("target", "Today's load target", "your own limits; a full ring is a cue to stop, not a goal", targetRings(d.target)));
  if (!d.pending && d.switches) {
    const x = d.switches;
    add("switches", () => sectionWith("switches", "Context switches", "project / app changes per hour, from the usage",
      statusLine("This hour", `${x.now} switch${x.now === 1 ? "" : "es"}${x.maxHour !== null ? ` · today's most: ${x.max} at ${hh(x.maxHour)}` : ""}`, x.light, x.action)));
  }
  if (!d.pending && Array.isArray(d.indicators)) add(null, () => indicatorChips(d));
  // plan-limit forecast: a plain sentence, no countdown; only when the server found it believable
  if (!d.pending && Array.isArray(d.limitForecasts) && d.limitForecasts.length) {
    add(null, () => h("ul", { class: "wb-forecast" }, ...d.limitForecasts.map((f) => h("li", null, h("span", { "aria-hidden": "true" }, "📊 "), f.text))));
  }
  add(null, () => h("div", { class: "row wb-policy" }, h("span", { class: "sub grow" }, line), d.pending ? null : focusControls(d, now)));
  if (!d.pending && d.stress) {
    const early = earlyState(d.stress).early;
    add("today", () => sectionWith("today", "Today", "stress and interrupts per hour; the indicators against your usual range", h("div", { class: "wb-charts" }, dayCombo(d), usualRange(d))));
    // the daily measures read from day one; only the stress trend and the patterns wait for a day of readings
    add("trends", () => sectionWith("trends", "Trends", `daily, last ${wb.span} days`, early ? placeholder("Collecting data — the stress trend appears after a day.") : stressTrendChart(d), Array.isArray(d.trends) ? trends(d) : null));
    add("patterns", () => sectionWith("patterns", "Patterns", "average stress per weekday and hour, last 30 days", early ? placeholder("Collecting data — patterns appear after a day.") : weekHourStress(d)));
  } else if (!d.pending && Array.isArray(d.trends)) add(null, () => trends(d));
  const ids = subs.map(([id], i) => id || `#${i}`);
  const order = pinnedFirst("you", ids);
  const byId = new Map(subs.map(([, make], i) => [ids[i], make]));
  for (const id of order) card.append(byId.get(id)());
  if (!d.pending) card.append(settingsPanel(d));
  if (wb.error) card.append(h("div", { class: "banner warn", role: "status" }, wb.error));
  box.append(card, ...nudgeCards(d));
}

async function load(force) {
  if (!force && wb.data && Date.now() - wb.fetchedAt < 60_000) return;
  try {
    wb.data = await getJson("/api/wellbeing");
    wb.fetchedAt = Date.now();
    feedWellbeing(wb.data);
    if (!wb.busy) wb.error = "";
  } catch (err) {
    wb.error = err && err.message ? err.message : "network error";
  }
  render();
}

/** Start once; the page's poll calls `refreshWellbeing` (at most once a minute does it fetch). */
export function initWellbeing() {
  if (wb.started || !$("you")) return;
  wb.started = true;
  render();
  load(true);
}
/** Called after every /api/state poll (at most once a minute does it fetch). */
export const refreshWellbeing = () => load(false);
