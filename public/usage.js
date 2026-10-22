// "Usage & estimated cost" section of the dashboard. Vanilla ES module, loaded by app.js.
// Fetches /api/usage lazily (when the section scrolls into view, then at most every 15 minutes), through the same Access
// session as the state poll. SECURITY: every value is written with textContent / createTextNode (never as markup); the strict CSP
// allows no inline style ATTRIBUTES in markup; bar heights / tick positions are set with element.style (CSSOM), which it allows.
// Everything here is API-EQUIVALENT: what the tokens would cost at the vendors' public API prices, not a bill. No AI is called.

import {
  appOf, cacheShare, dateTicks, deltaText, fmtPct, fmtTokens, heatLevel, heatmapMonths, heatmapWeeks, heatThresholds, heatValue, hourLabel,
  hourlyCoverage, hourStampLabel, tickGap, isNum, isWeekend, kpiPeriods, lastDays, longDayLabel, niceTicks, ranking, stackSeries, sumAgg, tickLabel,
  unpricedShare, usageDayLabel, usageDue, usageFreshness, usageLabel, usageTree, usdCell, weekHourGrid,
} from "/format.js";
import { bucketRange, rangeOf, RANGES } from "/glance.js";
import { bigValue, rangeControl, savedRange } from "/glance-ui.js";

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

/** Which collector records hours (shown when a day has none). */
const HOURLY_COLLECTOR = "siiswell collector ≥ 0.1.1";

const us = {
  /** the dashboard's time zone (the server's DASHBOARD_TZ, sent with every usage answer); its days are the page's days */
  tz: "UTC",
  /** "month" | "day": the switch. Month = the overview + this and last month; Day = the 12-month calendar and the chosen day's 24 hours */
  group: "month",
  /** month: the month answer; insights: the overview's aggregates; day: the 12-month daily series (the calendar); hours: one answer per chosen day */
  cache: { month: null, insights: null, day: null, hours: new Map() },
  /** the day chosen in the calendar (null = today) and the calendar's metric */
  day: null,
  metric: "usd",
  /** the stacked chart's split ("app" | "project") and the series the operator switched off in its legend */
  split: "app",
  hidden: new Set(),
  /** the cost chart's range (W / M from the overview's 60 days; 6M / Y from the 12-month daily series), remembered in this browser */
  range: savedRange("range.usage", RANGES, "M"),
  inFlight: false,
  /** per mode: when its last load failed (retried after a minute, not on every scroll) */
  failedAt: { month: 0, day: 0 },
  error: "",
  /** project names the operator expanded (the section is rebuilt after every fetch) */
  open: new Set(),
  started: false,
};

/** In / out / cache read / cache write / requests of one aggregate, each with its own label (the labels show on a phone, the header row names them on a desktop). */
function metrics(a) {
  const m = (value, label, title) => h("span", { class: "u-m", title }, h("b", null, value), h("span", { class: "u-l" }, ` ${label}`));
  return h(
    "span",
    { class: "u-metrics" },
    m(fmtTokens(a.input), "in", "input tokens (fresh)"),
    m(fmtTokens(a.output), "out", "output tokens"),
    m(fmtTokens(a.cacheRead), "cache r", "cache read tokens"),
    m(fmtTokens(a.cacheWrite), "cache w", "cache write tokens (5 min + 1 h)"),
    m(fmtTokens(a.requests), "req", "requests"),
  );
}

function usdEl(a) {
  const c = usdCell(a);
  return h("span", { class: `u-usd${c.note ? " partial" : ""}`, title: c.note || "API-equivalent estimate" }, c.text, c.note && c.text !== "—" ? h("span", { class: "u-plus", "aria-hidden": "true" }, "+") : null);
}

function row(name, a, cls, sub) {
  return h("div", { class: `u-row ${cls || ""}`.trim() }, h("span", { class: "u-name" }, name, sub ? h("span", { class: "u-sub" }, ` ${sub}`) : null), metrics(a), usdEl(a));
}

function headerRow(first = "Project") {
  return h("div", { class: "u-row u-head", "aria-hidden": "true" }, h("span", { class: "u-name" }, first), h("span", { class: "u-metrics" }, ...["In", "Out", "Cache r", "Cache w", "Req"].map((t) => h("span", { class: "u-m" }, t))), h("span", { class: "u-usd" }, "API-equiv. $"));
}

/** value -> % of the plot height */
const pct = (v, top) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;

/** "n requests from models without a public price" (the unpriced marker's tooltip), or "" when there are none. */
function unpricedNote(a) {
  if (!a) return "";
  const req = isNum(a.unpricedRequests) ? a.unpricedRequests : 0;
  const tok = isNum(a.unpricedTokens) ? a.unpricedTokens : 0;
  if (req > 0) return `${fmtTokens(req)} request${req === 1 ? "" : "s"} from models without a public price (${fmtTokens(tok)} tokens, not in the $)`;
  return tok > 0 ? `${fmtTokens(tok)} tokens from models without a public price (not in the $)` : "";
}

/** The detail line(s) of one day (what hover / tap / focus shows under the chart). All text nodes. `parts` = the stacked series of that day. */
function dayDetail(d, a, parts) {
  const head = h("div", { class: "u-d-head" }, h("b", null, usageDayLabel(d)), " · ");
  if (!a || (!a.requests && !a.usd && !a.unpricedTokens && !a.input && !a.output)) {
    head.append("no usage reported");
    return h("div", { class: "u-detail-body" }, head);
  }
  const c = usdCell(a);
  head.append(h("b", { class: "u-d-usd" }, c.text), " ", h("span", { class: "muted" }, "API-equivalent (est.)"));
  const note = unpricedNote(a);
  if (note) head.append(" ", h("span", { class: "u-unp-note", title: note }, h("i", { class: "u-unp-dot", "aria-hidden": "true" }), `unpriced: ${fmtTokens(a.unpricedRequests || 0)} req`));
  const split = Array.isArray(parts) && parts.some((p) => p.v > 0)
    ? h("div", { class: "u-d-parts" }, ...parts.filter((p) => p.v > 0).map((p) => h("span", { class: "u-d-part" }, h("i", { class: `u-sw s${p.slot}`, "aria-hidden": "true" }), `${p.k} ${usdCell({ usd: p.v }).text}`)))
    : null;
  return h("div", { class: "u-detail-body" }, head, split, metrics(a));
}

/** Plain-language label for screen readers: date, dollars, tokens. */
function dayAria(d, a) {
  if (!a) return `${usageDayLabel(d)}: no usage reported`;
  const c = usdCell(a);
  const note = unpricedNote(a);
  return `${usageDayLabel(d)}: ${c.text} API-equivalent, ${fmtTokens(a.input)} input, ${fmtTokens(a.output)} output, ${fmtTokens(a.cacheRead)} cache read, ${fmtTokens(a.cacheWrite)} cache write tokens, ${fmtTokens(a.requests)} requests${note ? `; ${note}` : ""}`;
}

/**
 * One column chart (the 30-day and the 24-hour one): y-axis ($ ticks from niceTicks + faint gridlines), one focusable full-height
 * column per item (the bar is inside it, so a thin bar is still an easy tap target), a stacked bar of coloured parts, a small dot
 * over a column with unpriced requests (a subtle marker with a tooltip, not a stripe), x labels, and a detail panel under the chart
 * that hover / tap / focus fills. Positions and heights are set through element.style (allowed by the CSP).
 * items: [{ label (aria), xLabel, cls, parts: [{ v, slot }], total, unp (tooltip text or ""), detail: () => Node }]
 */
function columnChart({ items, xTicks, caption, legend, groupLabel, initial, headKey = "Total", summary = null }) {
  const n = items.length;
  const max = Math.max(0, ...items.map((it) => it.total));
  const { ticks, top } = niceTicks(max);
  const detail = h("div", { class: "u-detail", "aria-live": "polite" });
  // the chosen column, large, above the plot (the detail panel under it keeps the breakdown)
  const head = h("div", { class: "ch-head", "aria-hidden": "true" });
  const cols = [];
  let current = -1;
  const headTo = (k, v, when) => head.replaceChildren(h("span", { class: "ch-k" }, k), bigValue(usdCell({ usd: v }).text, "ch-v"), h("span", { class: "ch-when" }, when || ""));
  // before a column is chosen the header sums up the range (e.g. the daily average); a chosen column replaces it
  const select = (i, chosen = true) => {
    if (i === current || i < 0 || i >= n) return;
    current = i;
    cols.forEach((c, j) => { c.classList.toggle("sel", j === i); c.tabIndex = j === i ? 0 : -1; });
    if (chosen || !summary) headTo(headKey, items[i].total, items[i].when);
    detail.replaceChildren(items[i].detail());
  };
  if (summary) headTo(summary.k, summary.v, summary.when);
  const plot = h("div", { class: "u-plot" });
  for (const t of ticks) {
    const g = h("i", { class: `u-grid${t === 0 ? " zero" : ""}`, "aria-hidden": "true" });
    g.style.bottom = pct(t, top);
    plot.append(g);
  }
  const colsBox = h("div", { class: "u-cols", role: "group", "aria-label": groupLabel });
  items.forEach((it, i) => {
    const stack = h("span", { class: "u-stack", "aria-hidden": "true" });
    if (it.total > 0) {
      stack.style.height = `max(2px, ${pct(it.total, top)})`;
      for (const p of it.parts) {
        if (!(p.v > 0)) continue;
        const seg = h("i", { class: `u-seg s${p.slot}` });
        seg.style.flexGrow = String(p.v);
        stack.append(seg);
      }
    } else {
      stack.classList.add("u0");
    }
    const col = h("button", { type: "button", class: `u-col${it.cls ? ` ${it.cls}` : ""}`, tabindex: "-1", "aria-label": it.label, title: it.unp || null },
      it.unp ? h("i", { class: "u-unp-dot", "aria-hidden": "true" }) : null, stack);
    col.addEventListener("mouseenter", () => select(i));
    col.addEventListener("focus", () => select(i));
    col.addEventListener("click", () => select(i));
    col.addEventListener("keydown", (e) => {
      const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
      if (to < 0 || to >= n) return;
      e.preventDefault();
      cols[to].focus();
    });
    cols.push(col);
    colsBox.append(col);
  });
  plot.append(colsBox);
  const labels = ticks.map(tickLabel);
  const yaxis = h("div", { class: "u-yaxis", "aria-hidden": "true" });
  yaxis.style.width = `${Math.max(...labels.map((l) => l.length)) + 0.5}ch`;
  ticks.forEach((t, i) => {
    const l = h("span", { class: "u-ytick" }, labels[i]);
    l.style.bottom = pct(t, top);
    yaxis.append(l);
  });
  const xaxis = h("div", { class: "u-xaxis", "aria-hidden": "true" });
  for (const { i, text, cls } of xTicks) {
    const l = h("span", { class: `u-xtick${cls ? ` ${cls}` : ""}` }, text);
    l.style.left = `${((i + 0.5) / n) * 100}%`;
    xaxis.append(l);
  }
  select(initial(max), false);
  return h(
    "div",
    { class: "u-bars-box" },
    h("div", { class: "u-cap muted small" }, ...caption, h("span", null, `peak ${usdCell({ usd: max }).text}`)),
    head,
    h("div", { class: "u-chart" }, yaxis, h("div", { class: "u-chart-main" }, plot, xaxis)),
    detail,
    legend,
  );
}

const unpKey = () => h("span", { class: "u-key-unp", title: "a dot over a bar: some requests that day came from models without a public price, so the $ is a lower bound" }, h("i", { class: "u-unp-dot", "aria-hidden": "true" }), "has unpriced requests");

/**
 * The 30-day cost chart. With the overview's aggregates (`ins`) the bars are stacked by app or by project (a legend that switches
 * series on and off); without them (an older server) a single series from the month answer's `bars`.
 */
function bars(u, ins) {
  const today = (ins && ins.today) || u.today;
  const r = rangeOf(us.range) || rangeOf("M");
  if (r.bucket !== "day") return longBars(today, r);
  const list = lastDays(today, r.days);
  const byDay = new Map((Array.isArray(u.bars) ? u.bars : []).map((d) => [d.day, d]));
  if (ins && Array.isArray(ins.daily)) for (const d of ins.daily) byDay.set(d.day, d);
  let keys = [];
  let partsOf = (d) => [{ k: "all", v: usdOf(byDay.get(d)), slot: 0 }];
  const split = us.split;
  if (ins && !ins.pending) {
    const s = stackSeries(split === "project" ? ins.byProject : ins.byApp, list, split === "project" ? { top: 6 } : { top: 7, keyOf: appOf, apps: true });
    keys = s.keys;
    const byD = new Map(s.days.map((x) => [x.day, x]));
    partsOf = (d) => (byD.get(d) ? byD.get(d).parts.map((p, i) => ({ ...p, slot: keys[i].slot })).filter((p) => !us.hidden.has(`${split}:${p.k}`)) : []);
  }
  const items = list.map((d, i) => {
    const a = byDay.get(d);
    const parts = partsOf(d);
    return {
      label: dayAria(d, a),
      cls: `${isWeekend(d) ? "we" : ""}${i === list.length - 1 ? " today" : ""}`.trim(),
      parts,
      total: parts.reduce((n, p) => n + p.v, 0),
      unp: unpricedNote(a),
      when: usageDayLabel(d),
      detail: () => dayDetail(d, a, keys.length ? parts : null),
    };
  });
  const total = items.reduce((n, it) => n + it.total, 0);
  const legend = h("div", { class: "u-legend muted small" });
  if (keys.length) {
    for (const k of keys) {
      const id = `${split}:${k.k}`;
      const on = !us.hidden.has(id);
      const b = h("button", { type: "button", class: "u-lg", "data-k": id, "aria-pressed": String(on), title: `${on ? "Hide" : "Show"} ${k.k} (${usdCell({ usd: k.total }).text} in 30 days)` },
        h("i", { class: `u-sw s${k.slot}`, "aria-hidden": "true" }), k.k === "(rest)" ? `${k.n} more` : k.k);
      b.addEventListener("click", () => { on ? us.hidden.add(id) : us.hidden.delete(id); render(); focusSel(`.u-lg[data-k="${CSS.escape(id)}"]`); });
      legend.append(b);
    }
  }
  legend.append(h("span", { class: "u-key we" }, "weekend"), unpKey());
  const splitSeg = keys.length
    ? h("div", { class: "seg u-metric", role: "group", "aria-label": "Split the bars by" }, ...[["app", "By app"], ["project", "By project"]].map(([m, label]) => {
      const b = h("button", { type: "button", "aria-pressed": String(m === split) }, label);
      b.addEventListener("click", () => { us.split = m; render(); focusSel(".u-bars-box .u-metric button[aria-pressed=\"true\"]"); });
      return b;
    }))
    : null;
  return columnChart({
    items,
    // thinned by the width the plot will get (a phone has room for fewer labels): body gutter + box padding + y axis ~ 90 px
    xTicks: dateTicks(list, tickGap(Math.min(window.innerWidth || 1280, 1280) - 90, list.length)).map((i) => ({ i, text: usageLabel(list[i]), cls: i === list.length - 1 ? "today" : "" })),
    caption: [h("span", null, `per day · last ${r.days} days${keys.length ? ` · by ${split}` : ""}`), splitSeg, rangeSeg()],
    legend,
    groupLabel: `API-equivalent cost per day, last ${r.days} days: ${usdCell({ usd: total }).text} in total${keys.length ? `, split by ${split}` : ""}. Arrow keys move between days.`,
    summary: { k: "Daily average", v: total / Math.max(1, items.length), when: `last ${r.name} · ${usdCell({ usd: total }).text} in total` },
    initial: () => list.length - 1,
  });
}
const usdOf = (a) => (a && isNum(a.usd) ? a.usd : 0);

/** The shared range control of the cost chart; 6M / Y read the 12-month daily series (fetched once when chosen). */
function rangeSeg() {
  return rangeControl("range.usage", RANGES, us.range, (k) => {
    us.range = k;
    if (rangeOf(k).bucket !== "day") loadYear();
    render();
    focusSel(".u-bars-box .range button[aria-pressed=\"true\"]");
  }, "Chart range");
}

/** 6M (per week) and Y (per month): one series, from the 12-month daily answer; a short note while it loads. */
function longBars(today, r) {
  const year = us.cache.day;
  if (!year || !Array.isArray(year.series)) {
    if (!us.yearLoading) loadYear();
    return h("div", { class: "u-bars-box" }, h("div", { class: "u-cap muted small" }, h("span", null, `last ${r.name}`), rangeSeg()), h("div", { class: "empty" }, us.yearError ? `Could not load: ${us.yearError}` : "Loading the last 12 months…"));
  }
  const byDay = new Map(year.series.map((x) => [x.k, x]));
  const buckets = bucketRange(byDay, today, r.key);
  const per = r.bucket === "week" ? "week" : "month";
  const items = buckets.map((b, i) => ({
    label: `${b.label}: ${usdCell(b).text} API-equivalent, ${fmtTokens(b.tokens)} tokens, ${fmtTokens(b.requests)} requests`,
    cls: i === buckets.length - 1 ? "today" : "",
    parts: [{ v: b.usd, slot: 0 }],
    total: b.usd,
    unp: b.unpricedTokens > 0 ? `${fmtTokens(b.unpricedTokens)} tokens from models without a public price (not in the $)` : "",
    when: b.label,
    detail: () => h("div", { class: "u-detail-body" }, h("div", { class: "u-d-head" }, h("b", null, b.from === b.to ? usageDayLabel(b.from) : `${usageDayLabel(b.from)} – ${usageDayLabel(b.to)}`), " · ", h("b", { class: "u-d-usd" }, usdCell(b).text), " ", h("span", { class: "muted" }, "API-equivalent (est.)")),
      h("div", { class: "sub" }, `${fmtTokens(b.tokens)} tokens · ${fmtTokens(b.requests)} requests`)),
  }));
  const total = buckets.reduce((n, b) => n + b.usd, 0);
  const every = r.bucket === "week" ? 4 : 1;
  return columnChart({
    items,
    xTicks: buckets.map((b, i) => ({ i, text: b.tick, cls: i === buckets.length - 1 ? "today" : "" })).filter((t) => (buckets.length - 1 - t.i) % every === 0),
    caption: [h("span", null, `per ${per} · last ${r.name}`), rangeSeg()],
    legend: h("div", { class: "u-legend muted small" }, unpKey()),
    groupLabel: `API-equivalent cost per ${per}, last ${r.name}: ${usdCell({ usd: total }).text} in total. Arrow keys move between ${per}s.`,
    summary: { k: `${per === "week" ? "Weekly" : "Monthly"} average`, v: total / Math.max(1, items.length), when: `last ${r.name} · ${usdCell({ usd: total }).text} in total` },
    initial: () => items.length - 1,
  });
}

/** The 12-month daily series (the Day view's calendar data) for the 6M / Y chart ranges; shared with the calendar. */
async function loadYear() {
  if (us.yearLoading || (us.cache.day && !usageDue(us.cache.day.fetchedAt, Date.now()))) return;
  us.yearLoading = true;
  try {
    us.cache.day = await getJson(`/api/usage?group=day&from=${heatmapWeeks(dashToday()).from}&to=${dashToday()}`);
    us.yearError = "";
  } catch (err) {
    us.yearError = err && err.message ? err.message : "network error";
  } finally {
    us.yearLoading = false;
  }
  render();
}

/** Re-focus an element after a re-render (keyboard users keep their place). */
function focusSel(sel) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`#usage ${sel}`);
    if (el) el.focus();
  });
}

// ── the overview: KPI tiles, rankings, "when do I work" ─────────────────────────────────────────────────────

function kpiTile(title, period) {
  const cur = period.cur;
  const d = period.cmp ? deltaText(period.cmp.usd, period.prev.usd) : { text: "", aria: "" };
  const c = usdCell(cur);
  const label = period.soFar ? `${title} so far` : title;
  return h(
    "div",
    { class: "u-kpi", role: "group", "aria-label": `${label}: ${c.text} API-equivalent, ${fmtTokens(cur.tokens)} tokens, ${fmtTokens(cur.requests)} requests${d.aria ? `; ${d.aria} (${period.vs})` : ""}` },
    h("span", { class: "u-kpi-l", "aria-hidden": "true" }, label),
    h("span", { class: "u-kpi-n", "aria-hidden": "true", title: c.note || null }, bigValue(c.text)),
    h("span", { class: "u-kpi-s", "aria-hidden": "true" }, `${fmtTokens(cur.tokens)} tok · ${fmtTokens(cur.requests)} req`),
    d.text ? h("span", { class: `u-delta ${d.tone}`, "aria-hidden": "true", title: `${usdCell(period.cmp).text} against ${usdCell(period.prev).text}, ${period.vs}` }, `${d.text} `, h("span", { class: "u-vs" }, period.vs))
      : h("span", { class: "u-delta idle", "aria-hidden": "true", title: period.soFar ? "today is not over; no hourly data to compare with yesterday at the same hour" : null }, period.soFar ? "day in progress" : "no earlier data"),
  );
}

function shareTile(title, share, sub, tone, tip) {
  return h(
    "div",
    { class: `u-kpi${tone ? ` ${tone}` : ""}`, role: "group", "aria-label": `${title}: ${fmtPct(share)} ${sub}`, title: tip || null },
    h("span", { class: "u-kpi-l", "aria-hidden": "true" }, title),
    h("span", { class: "u-kpi-n", "aria-hidden": "true" }, bigValue(fmtPct(share))),
    h("span", { class: "u-kpi-s", "aria-hidden": "true" }, sub),
    isNum(share) ? meter(share) : null,
  );
}

function meter(share) {
  const fill = h("i", { class: "u-meter-fill" });
  fill.style.width = `${Math.max(0, Math.min(100, share * 100))}%`;
  return h("span", { class: "u-meter", "aria-hidden": "true" }, fill);
}

function kpis(ins) {
  const k = kpiPeriods(ins.daily, ins.today, ins.sameTime);
  const d30 = k.d30.cur;
  const unp = unpricedShare(d30);
  return h(
    "div",
    { class: "u-kpis" },
    kpiTile("Today", k.today),
    kpiTile("7 days", k.d7),
    kpiTile("30 days", k.d30),
    shareTile("Cache hits", cacheShare(d30), "of input served from cache (30 d)", "", `${fmtTokens(d30.cacheRead)} cache-read tokens of ${fmtTokens(d30.input + d30.cacheRead + d30.cacheWrite)} input tokens. Cache reads cost about a tenth of fresh input.`),
    shareTile("Unpriced", unp, "of requests have no public price (30 d)", unp > 0.2 ? "warn" : "", unpricedNote(d30) || "every request in the last 30 days has a public price"),
  );
}

/** A ranking card: label, bar (relative to the biggest), $ and share. */
function rankCard(title, list, { slotOf, sub, empty }) {
  const box = h("div", { class: "u-rank card" }, h("h3", { class: "u-h3" }, title));
  if (!list.length) {
    box.append(h("div", { class: "muted small" }, empty));
    return box;
  }
  const ul = h("ol", { class: "u-rank-list" });
  for (const x of list) {
    const bar = h("i", { class: `u-rank-fill s${slotOf ? slotOf(x) : 0}` });
    bar.style.width = `${Math.max(1, x.len * 100)}%`;
    const c = usdCell(x.r);
    ul.append(h(
      "li",
      { class: "u-rank-row", "aria-label": `${x.name}: ${c.text}, ${fmtPct(x.share)} of the total${sub ? `, ${sub(x)}` : ""}` },
      h("span", { class: "u-rank-name", "aria-hidden": "true", title: x.name }, x.name, sub ? h("span", { class: "u-sub" }, ` ${sub(x)}`) : null),
      h("span", { class: "u-rank-v", "aria-hidden": "true", title: c.note || null }, c.text, h("span", { class: "u-sub" }, ` ${fmtPct(x.share)}`)),
      h("span", { class: "u-rank-bar", "aria-hidden": "true" }, bar),
    ));
  }
  box.append(ul);
  return box;
}

function rankings(ins) {
  const projSlots = new Map(stackSeries(ins.byProject, lastDays(ins.today, 30), { top: 6 }).keys.map((k) => [k.k, k.slot]));
  const projTotals = new Map();
  for (const r of ins.byProject || []) projTotals.set(r.k, sumAgg([projTotals.get(r.k), r]));
  const projects = ranking([...projTotals.entries()].map(([k, a]) => ({ k, ...a })), { limit: 8 });
  const models = ranking(ins.models, { nameOf: (r) => r.model, limit: 8 });
  const hosts = ranking(ins.hosts, { nameOf: (r) => r.host, limit: 8 });
  const unpricedModels = (ins.models || []).filter((m) => !(m.usd > 0) && m.unpricedTokens > 0);
  const modelsCard = rankCard("Top models · 30 d", models, { sub: (x) => x.r.source, empty: "No priced model in the last 30 days." });
  if (unpricedModels.length) {
    modelsCard.append(h("div", { class: "u-rank-foot muted small", title: unpricedModels.map((m) => `${m.model} (${m.source}): ${unpricedNote(m)}`).join("\n") },
      h("i", { class: "u-unp-dot", "aria-hidden": "true" }), `not ranked, no public price: ${unpricedModels.map((m) => `${m.model} (${fmtTokens(m.unpricedRequests || 0)} req)`).join(", ")}`));
  }
  return h(
    "div",
    { class: "u-ranks" },
    rankCard("Top projects · 30 d", projects, { slotOf: (x) => projSlots.get(x.name) || 8, sub: (x) => `${fmtTokens(x.r.requests)} req`, empty: "No priced usage in the last 30 days." }),
    modelsCard,
    rankCard("Per host · 30 d", hosts, { sub: (x) => `cache ${fmtPct(cacheShare(x.r))}`, empty: "No host reported priced usage in the last 30 days." }),
  );
}

/** "When do I work": weekday x local hour, requests in the last 4 weeks of hourly rows. */
function weekHour(ins) {
  const box = h("div", { class: "u-wh-box card" }, h("h3", { class: "u-h3" }, `When the agents work · last ${ins.weekHourDays || 28} days`));
  if (!Array.isArray(ins.weekHour) || !ins.weekHour.length) {
    box.append(h("div", { class: "muted small" }, ins.hourlyPending ? "Hourly storage is not set up on this dashboard yet (apply migration 0005)." : `No hourly data yet: hours are recorded by ${HOURLY_COLLECTOR}.`));
    return box;
  }
  const g = weekHourGrid(ins.weekHour, "requests");
  const grid = h("div", { class: "u-wh", role: "img", "aria-label": `Requests per weekday and hour (each host's local time), last ${ins.weekHourDays || 28} days.${g.peak ? ` Busiest: ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][g.peak.w]} ${hourLabel(g.peak.h)}, ${fmtTokens(g.peak.v)} requests.` : ""}` });
  grid.append(h("span", { class: "u-wh-corner", "aria-hidden": "true" }));
  for (let i = 0; i < 24; i++) grid.append(h("span", { class: "u-wh-hl", "aria-hidden": "true" }, i % 6 === 0 ? String(i).padStart(2, "0") : ""));
  for (const r of g.rows) {
    grid.append(h("span", { class: "u-wh-dl", "aria-hidden": "true" }, r.label));
    for (const c of r.cells) {
      grid.append(h("i", { class: `u-wh-c h${heatLevel(c.v, g.thresholds)}`, "aria-hidden": "true", title: `${r.label} ${hourLabel(c.h)}: ${c.v ? `${fmtTokens(c.v)} requests, ${usdCell(c.a).text}` : "nothing"}` }));
    }
  }
  box.append(grid, heatLegend(g.thresholds, (v) => `${fmtTokens(v)} req`, "each host's local hours"));
  return box;
}

/** "less [] [] [] [] [] more" with each step's range in its tooltip. */
function heatLegend(thresholds, fmt, note) {
  const range = (l) => (l === 0 ? "none" : !thresholds.length ? "" : l === 1 ? `up to ${fmt(thresholds[0])}` : `${fmt(thresholds[l - 2])} – ${fmt(thresholds[l - 1])}`);
  return h(
    "div",
    { class: "u-legend muted small" },
    h("span", null, "less"),
    ...[0, 1, 2, 3, 4].map((l) => h("i", { class: `u-hc h${l}`, title: range(l), "aria-hidden": "true" })),
    h("span", null, "more"),
    thresholds.length ? h("span", null, `top: ${fmt(thresholds[3])}`) : null,
    note ? h("span", null, note) : null,
  );
}

function overview(ins) {
  if (!ins || ins.pending || !Array.isArray(ins.daily)) return [];
  if (!ins.daily.length) return [h("div", { class: "empty" }, "No usage reported in the last 60 days.")];
  return [kpis(ins), rankings(ins), weekHour(ins)];
}

function render() {
  const box = $("usage");
  if (!box) return;
  const u = us.cache[us.group];
  box.replaceChildren();
  for (const b of document.querySelectorAll("#usage-switch button")) b.setAttribute("aria-pressed", String(b.dataset.group === us.group));
  if (us.group === "day" && u && !u.pending) {
    renderDay(box, u);
    return;
  }
  if (!u) {
    box.append(h("div", { class: "empty" }, us.error ? `Could not load usage: ${us.error}` : "Loading usage…"));
    $("usage-brief").textContent = "";
    return;
  }
  const now = Date.now();
  const fresh = usageFreshness(u.hosts, now);
  $("usage-brief").textContent = `${usageLabel(u.from)} – ${usageLabel(u.to)}`;
  if (u.pending) {
    box.append(h("div", { class: "empty" }, "Usage storage is not set up on this dashboard yet (apply migration 0003, then hosts start reporting)."));
    return;
  }
  const ins = us.cache.insights;
  if (!u.projects.length && !(u.total && u.total.requests) && !(ins && ins.daily && ins.daily.length)) {
    box.append(h("div", { class: "empty" }, `No usage reported for this period yet. ${fresh.text}.`));
    box.append(foot());
    return;
  }
  const ov = overview(ins);
  if (ov.length) box.append(ov[0]);
  box.append(bars(u, ins));
  box.append(...ov.slice(1));

  const t = u.total;
  const unp = unpricedShare(t);
  box.append(h("h3", { class: "u-h3 u-sec" }, "This month and last month"));
  box.append(
    h(
      "article",
      { class: "card u-total" },
      h("div", { class: "card-head" }, h("span", { class: "u-big" }, bigValue(usdCell(t).text), usdCell(t).note && usdCell(t).text !== "—" ? h("span", { class: "u-plus", title: usdCell(t).note }, "+") : null), h("span", { class: "badge", title: "what these tokens would cost at the vendors' public API prices; not your bill" }, "API-equivalent (est.)")),
      h("div", { class: "sub" }, `${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out · ${fmtTokens(t.cacheRead)} cache read · ${fmtTokens(t.cacheWrite)} cache write · ${fmtTokens(t.requests)} requests`),
      h("div", { class: "sub" }, h("span", { class: `chip ${fresh.tone}` }, fresh.text)),
      t.unpricedTokens > 0 ? h("div", { class: "sub" }, h("i", { class: "u-unp-dot", "aria-hidden": "true" }), ` Unpriced: ${isNum(unp) ? `${fmtPct(unp)} of requests` : `${fmtTokens(t.unpricedTokens)} tokens`} came from models without a public price (— in the table), so the dollar figures are a lower bound.`) : null,
    ),
  );

  // per month
  const series = Array.isArray(u.series) ? u.series : [];
  if (u.group === "month" && series.length) {
    box.append(h("div", { class: "u-periods" }, ...series.map((s) => h("span", { class: "chip info", title: `${fmtTokens(s.requests)} requests` }, `${usageLabel(s.k)} ${usdCell(s).text}`))));
  }

  if (Array.isArray(u.hostBreakdown)) {
    box.append(hostTable(u.hostBreakdown, t));
    if (Array.isArray(u.truncated) && u.truncated.length) box.append(h("div", { class: "banner warn" }, `Some rows were left out to keep this small (${u.truncated.join(", ")}); the totals are complete.`));
    box.append(foot());
    return;
  }
  // an older server (no per-host breakdown): the per-project table
  const list = h("div", { class: "u-table stack tight" }, headerRow());
  const breakdown = Array.isArray(u.breakdown) ? u.breakdown : [];
  for (const p of u.projects) {
    const rows = breakdown.filter((r) => r.project === p.project);
    const key = `usage:${p.project}`;
    const body = h("div", { class: "u-sub-rows" }, ...rows.map((r) => row(r.agent, r, "u-agent", `${r.model}${r.source ? ` · ${r.source}` : ""}`)), !rows.length ? h("div", { class: "sub" }, "no breakdown (cut off)") : null);
    const d = h("details", { class: "proj u-proj" }, h("summary", null, h("span", { class: "chev", "aria-hidden": "true" }), row(p.project, p, "u-main")), body);
    if (us.open.has(key)) d.open = true;
    d.addEventListener("toggle", () => (d.open ? us.open.add(key) : us.open.delete(key)));
    list.append(d);
  }
  list.append(row("Total", t, "u-total-row"));
  box.append(list);
  if (Array.isArray(u.truncated) && u.truncated.length) box.append(h("div", { class: "banner warn" }, `Some rows were left out to keep this small (${u.truncated.join(", ")}); the totals are complete.`));
  box.append(foot());
}

function foot() {
  return h("p", { class: "u-foot muted small" }, `API-equivalent (est.): what these tokens would cost at the vendors' public API prices (Anthropic, OpenAI; retrieved 2026-10-14). Claude Max / ChatGPT plans are flat-rate, so this is not your bill. Days in ${us.tz}.`);
}

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 401 || res.status === 403) throw new Error(`access denied (${res.status}); reload to sign in again`);
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  const u = await res.json();
  u.fetchedAt = Date.now();
  if (typeof u.tz === "string" && u.tz) us.tz = u.tz;
  return u;
}

/** Today in the dashboard's zone (its days), from this browser's clock. */
function dashToday() {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: us.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function load(force) {
  const group = us.group;
  const cached = us.cache[group];
  if (us.inFlight) return;
  if (!force && cached && !usageDue(cached.fetchedAt, Date.now())) {
    if (group === "day") loadHours(false);
    return;
  }
  if (us.failedAt[group] && Date.now() - us.failedAt[group] < 60_000 && !force) return; // a failed load is retried after a minute, not on every scroll
  us.inFlight = true;
  try {
    if (group === "day") {
      // Day: the calendar's whole range (53 Monday-first weeks up to today) in one bounded daily read
      us.cache.day = await getJson(`/api/usage?group=day&from=${heatmapWeeks(dashToday()).from}&to=${dashToday()}`);
    } else {
      // Month: the month answer and the overview's aggregates together; an older server without `insights` (400) shows the month only
      const [m, ins] = await Promise.all([getJson("/api/usage?group=month"), getJson("/api/usage?group=insights").catch(() => null)]);
      us.cache.month = m;
      us.cache.insights = ins;
    }
    us.error = "";
    us.failedAt[group] = 0;
  } catch (err) {
    us.error = err && err.message ? err.message : "network error";
    us.failedAt[group] = Date.now();
  } finally {
    us.inFlight = false;
  }
  // the operator switched modes while this was loading: load the mode now on screen (it was skipped as in flight)
  if (us.group !== group) {
    load(false);
    return;
  }
  render();
  if (group === "day" && !us.error) loadHours(false);
}

/** The chosen day's 24 hours (each day is cached; today's is refetched with the rest). */
async function loadHours(force) {
  const u = us.cache.day;
  if (!u) return;
  const day = us.day || u.today;
  const cached = us.cache.hours.get(day);
  if (!force && cached && (cached.loading || !usageDue(cached.fetchedAt, Date.now()))) return;
  us.cache.hours.set(day, { loading: true, fetchedAt: Date.now() });
  try {
    us.cache.hours.set(day, await getJson(`/api/usage?group=hour&day=${day}`));
  } catch (err) {
    us.cache.hours.set(day, { error: err && err.message ? err.message : "network error", fetchedAt: 0 });
  }
  if (us.group === "day") {
    // the re-render rebuilds the calendar: keep the keyboard where it was
    const inHeat = document.activeElement && document.activeElement.closest && document.activeElement.closest(".u-heat");
    const focusedDay = inHeat ? document.activeElement.dataset.day : null;
    render();
    if (focusedDay) focusSel(`.u-heat .u-hc[data-day="${focusedDay}"]`);
  }
}

/** Start once: the first time the section comes near the viewport it loads; the Day / Month switch loads its own mode. */
export function initUsage() {
  const sec = $("sec-usage");
  if (!sec || us.started) return;
  us.started = true;
  for (const b of document.querySelectorAll("#usage-switch button")) {
    b.addEventListener("click", () => {
      us.group = b.dataset.group === "day" ? "day" : "month";
      render();
      load(false);
    });
  }
  render();
  const go = () => load(false);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) go(); }, { rootMargin: "300px 0px" }).observe(sec);
  } else {
    go();
  }
  // back on the page after a while: refresh when the section is on screen and its data is due
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const r = sec.getBoundingClientRect();
    if (r.top < window.innerHeight + 300 && r.bottom > -300) go();
  });
}

// ── Day view: 12-month calendar heatmap + the chosen day's 24 hours ──────────────────────────────────────────

const METRICS = [["usd", "$"], ["tokens", "Tokens"], ["requests", "Requests"]];
const metricText = (v, metric) => (metric === "usd" ? usdCell({ usd: v }).text : fmtTokens(v));

function renderDay(box, u) {
  const now = Date.now();
  const fresh = usageFreshness(u.hosts, now);
  const today = u.today || dashToday();
  const day = us.day || today;
  $("usage-brief").textContent = `${usageLabel(heatmapWeeks(today).from.slice(0, 7))} – ${usageLabel(today.slice(0, 7))}`;
  box.append(heatmap(u, today, day));
  const hu = us.cache.hours.get(day);
  if (!hu || hu.loading) box.append(h("div", { class: "empty" }, `Loading ${usageDayLabel(day)}…`));
  else if (hu.error) box.append(h("div", { class: "empty" }, `Could not load ${usageDayLabel(day)}: ${hu.error}`));
  else box.append(...dayHours(hu));
  box.append(h("div", { class: "sub" }, h("span", { class: `chip ${fresh.tone}` }, fresh.text)));
  box.append(foot());
}

/**
 * GitHub-style calendar: 53 Monday-first week columns x 7 day rows, ending today (calendar days of the dashboard's zone, so a DST change never
 * shifts a cell). Colour = the chosen metric in quartiles of the non-zero days. One focusable cell at a time (roving tabindex):
 * arrows move by a day (up / down) or a week (left / right), Home / End go to the first / last day, Enter / Space / click choose.
 */
function heatmap(u, today, chosen) {
  const series = new Map((Array.isArray(u.series) ? u.series : []).map((s) => [s.k, s]));
  const { cols } = heatmapWeeks(today);
  const days = cols.flat().filter(Boolean);
  const metric = us.metric;
  const thresholds = heatThresholds(days.map((d) => heatValue(series.get(d), metric)));
  const total = days.reduce((n, d) => n + heatValue(series.get(d), metric), 0);
  const active = days.filter((d) => heatValue(series.get(d), metric) > 0).length;
  const metricLabel = METRICS.find((m) => m[0] === metric)[1];

  const switcher = h("div", { class: "seg u-metric", role: "group", "aria-label": "Calendar colour" }, ...METRICS.map(([m, label]) => {
    const b = h("button", { type: "button", "aria-pressed": String(m === metric) }, label);
    b.addEventListener("click", () => { us.metric = m; render(); focusSel(".u-heat-box .u-metric button[aria-pressed=\"true\"]"); });
    return b;
  }));

  const cells = [];
  const grid = h("div", { class: "u-heat", role: "group", "aria-label": `Usage per day for the last 12 months, coloured by ${metricLabel === "$" ? "API-equivalent dollars" : metricLabel.toLowerCase()} (${metricText(total, metric)} in total). Arrow keys move between days, Enter shows a day's hours.` });
  const focusDay = (d) => {
    const c = cells.find((x) => x.day === d);
    if (c) c.el.focus();
  };
  for (const col of cols) {
    for (const d of col) {
      if (!d) {
        grid.append(h("i", { class: "u-hc u-none", "aria-hidden": "true" }));
        continue;
      }
      const a = series.get(d);
      const v = heatValue(a, metric);
      const lvl = heatLevel(v, thresholds);
      const label = `${longDayLabel(d)}: ${a ? `${metricText(heatValue(a, "usd"), "usd")} API-equivalent, ${fmtTokens(heatValue(a, "tokens"))} tokens, ${fmtTokens(heatValue(a, "requests"))} requests` : "no usage reported"}${d === today ? " (today)" : ""}`;
      const el = h("button", { type: "button", class: `u-hc h${lvl}${d === chosen ? " sel" : ""}${d === today ? " today" : ""}`, tabindex: d === chosen ? "0" : "-1", "aria-label": label, "aria-pressed": String(d === chosen), title: label, "data-day": d });
      el.addEventListener("click", () => choose(d));
      el.addEventListener("keydown", (e) => {
        const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[e.key];
        if (step !== undefined) {
          e.preventDefault();
          const to = new Date(Date.parse(`${d}T00:00:00Z`) + step * 86_400_000).toISOString().slice(0, 10);
          if (to >= days[0] && to <= today) focusDay(to);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          focusDay(e.key === "Home" ? days[0] : today);
        }
      });
      el.addEventListener("focus", () => { for (const c of cells) c.el.tabIndex = c.el === el ? 0 : -1; });
      cells.push({ day: d, el });
      grid.append(el);
    }
  }
  const months = h("div", { class: "u-heat-months", "aria-hidden": "true" });
  for (const m of heatmapMonths(cols)) {
    const l = h("span", null, m.label);
    l.style.gridColumnStart = String(m.i + 1);
    months.append(l);
  }
  const wd = h("div", { class: "u-heat-days", "aria-hidden": "true" }, ...["Mon", "", "Wed", "", "Fri", "", "Sun"].map((t) => h("span", null, t)));
  const scroller = h("div", { class: "u-heat-scroll" }, h("div", { class: "u-heat-wrap" }, months, h("div", { class: "u-heat-body" }, wd, grid)));
  // a phone shows the newest weeks first (the calendar scrolls inside its box, never the page)
  requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
  const legend = heatLegend(thresholds, (v) => metricText(v, metric), `weeks start on Monday · ${us.tz} days`);
  return h("div", { class: "u-heat-box" }, h("div", { class: "u-cap muted small" }, h("span", null, `per day · last 12 months · ${metricText(total, metric)} · ${active} active day${active === 1 ? "" : "s"}`), switcher), scroller, legend);
}

function choose(d) {
  us.day = d;
  render();
  loadHours(false);
  // keep the keyboard on the chosen cell after the re-render
  focusSel(".u-heat .u-hc.sel");
}

/** The chosen day: its total, 24 hourly bars (or why there are none), and the host / app / project / model table. */
function dayHours(hu) {
  const out = [];
  const t = hu.total || {};
  const dt = hu.dayTotal || t;
  const cov = hourlyCoverage(hu);
  const since = hu.hourlySince ? ` from ${hourStampLabel(hu.hourlySince)}` : "";
  let note = null;
  if (hu.pending) note = "Hourly storage is not set up on this dashboard yet (apply migration 0005).";
  else if (!hu.retained) note = `Hours are kept for ${hu.retentionDays || 90} days; this day only has its daily total.`;
  else if (cov.kind === "partial") note = `Hourly covers ${fmtPct(cov.share)} of this day's requests${cov.missing.length ? `; no hours from ${cov.missing.join(", ")} (an older collector: daily totals only)` : ""}.`;
  out.push(h(
    "article",
    { class: "card u-total" },
    h("div", { class: "card-head" }, h("b", null, longDayLabel(hu.day)), h("span", { class: "grow" }), h("span", { class: "u-big" }, usdCell(dt).text), h("span", { class: "badge", title: "what these tokens would cost at the vendors' public API prices; not your bill" }, "API-equivalent (est.)")),
    h("div", { class: "sub" }, `${fmtTokens(dt.input)} in · ${fmtTokens(dt.output)} out · ${fmtTokens(dt.cacheRead)} cache read · ${fmtTokens(dt.cacheWrite)} cache write · ${fmtTokens(dt.requests)} requests`),
    note ? h("div", { class: "sub" }, note) : null,
  ));
  if (hu.pending || !hu.retained) return out;
  if (cov.kind === "empty") {
    out.push(h("div", { class: "empty" }, `No usage reported on ${usageDayLabel(hu.day)}.`));
    return out;
  }
  if (cov.kind === "none") {
    out.push(h("div", { class: "empty u-nohours", role: "note" },
      h("b", null, "No hourly data for this day"),
      ` — hourly usage is recorded by ${HOURLY_COLLECTOR}${since || " (no host has sent hours yet)"}. ${cov.missing.length ? `This day came from ${cov.missing.join(", ")} as a daily total only.` : "This day only has its daily total."}`));
    return out;
  }
  out.push(hourChart(hu));
  if (Array.isArray(hu.hostBreakdown) && hu.hostBreakdown.length) out.push(hostTable(hu.hostBreakdown, t));
  return out;
}

/** 24 hourly bars of the chosen day (the same chart as the 30-day one). */
function hourChart(hu) {
  const hours = Array.isArray(hu.hours) && hu.hours.length === 24 ? hu.hours : Array.from({ length: 24 }, (_, i) => ({ h: String(i).padStart(2, "0") }));
  const items = hours.map((a) => {
    const v = usdOf(a);
    const range = `${hourLabel(a.h)}–${hourLabel((Number(a.h) + 1) % 24)}`;
    const unp = unpricedNote(a);
    return {
      label: `${hourLabel(a.h)}: ${a.requests ? `${usdCell(a).text} API-equivalent, ${fmtTokens(heatValue(a, "tokens"))} tokens, ${fmtTokens(a.requests)} requests${unp ? `; ${unp}` : ""}` : "no usage reported"}`,
      cls: "",
      parts: [{ v, slot: 0 }],
      total: v,
      unp,
      when: range,
      detail: () => {
        const head = h("div", { class: "u-d-head" }, h("b", null, range), " · ");
        if (!a.requests && !a.usd && !a.input) head.append("no usage reported");
        else head.append(h("b", { class: "u-d-usd" }, usdCell(a).text), " ", h("span", { class: "muted" }, "API-equivalent (est.)"));
        if (unp) head.append(" ", h("span", { class: "u-unp-note", title: unp }, h("i", { class: "u-unp-dot", "aria-hidden": "true" }), `unpriced: ${fmtTokens(a.unpricedRequests || 0)} req`));
        return h("div", { class: "u-detail-body" }, head, a.requests ? metrics(a) : null);
      },
    };
  });
  return columnChart({
    items,
    xTicks: [0, 6, 12, 18, 23].map((i) => ({ i, text: hourLabel(i) })),
    caption: [h("span", null, `per hour · ${usageDayLabel(hu.day)} · each host's local hours`)],
    legend: h("div", { class: "u-legend muted small" }, unpKey(), h("span", null, "a BST change day has 23 or 25 hours: the missing hour stays empty, the repeated one is counted once")),
    groupLabel: `API-equivalent cost per hour on ${longDayLabel(hu.day)}. Arrow keys move between hours.`,
    summary: { k: "Day total", v: items.reduce((n, it) => n + it.total, 0), when: usageDayLabel(hu.day) },
    initial: () => {
      let peak = 0;
      hours.forEach((a, i) => { if (usdOf(a) > usdOf(hours[peak])) peak = i; });
      return peak;
    },
  });
}

/** The per host > app > project > model table (expandable at every level). */
function hostTable(rows, total) {
  const list = h("div", { class: "u-table stack tight" }, headerRow("Host › app › project › model"));
  const tree = usageTree(rows);
  const fold2 = (key, cls, summaryRow, kids) => {
    const d = h("details", { class: `proj u-proj ${cls}` }, h("summary", null, h("span", { class: "chev", "aria-hidden": "true" }), summaryRow), h("div", { class: "u-sub-rows" }, ...kids));
    if (us.open.has(key)) d.open = true;
    d.addEventListener("toggle", () => (d.open ? us.open.add(key) : us.open.delete(key)));
    return d;
  };
  for (const hn of tree) {
    list.append(fold2(`uh:${hn.name}`, "u-lvl-host", row(hn.name, hn.agg, "u-main", "host"), hn.apps.map((an) =>
      fold2(`uh:${hn.name}|${an.name}`, "u-lvl-app", row(an.name, an.agg, "u-main", appOf(an.name) === "(other app)" ? "labels from before apps were recorded" : "app"), an.projects.map((pn) =>
        fold2(`uh:${hn.name}|${an.name}|${pn.name}`, "u-lvl-proj", row(pn.name, pn.agg, "u-main", "project"), pn.rows.map((r) =>
          row(r.model, r, "u-agent", [r.source, r.worktree ? `worktree ${r.worktree}` : ""].filter(Boolean).join(" · ")))))))));
  }
  list.append(row("Total", total, "u-total-row"));
  return list;
}
