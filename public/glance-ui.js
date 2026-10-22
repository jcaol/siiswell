// Shared pieces of the "at a glance" layer (DOM): the range control used by every chart, the big-number style, pin buttons,
// small sparklines, and the Highlights section. Vanilla ES module. SECURITY: text only through textContent / text nodes; sizes
// through element.style (CSSOM, allowed by the CSP). The viewer's choices (range, pins) stay in this browser only.

import { highlights, loadPref, parsePins, pinOrder, savePref, togglePin, valueParts } from "/glance.js";
import { isNum } from "/format.js";

const $ = (id) => document.getElementById(id);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/** This browser's storage, or null (private mode, blocked site data, previews): every caller copes with null. */
export function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// ── the range control ────────────────────────────────────────────────────────

/**
 * One segmented control for every chart's time range (W / M / 6M / Y), remembered per chart in this browser. `ranges`: the
 * entries of RANGES the data can fill. Returns the element; `onChange(key)` runs after the choice is saved.
 */
export function rangeControl(prefKey, ranges, value, onChange, label = "Range") {
  return h("div", { class: "seg range", role: "group", "aria-label": label }, ...ranges.map((r) => h("button", {
    type: "button", "aria-pressed": String(r.key === value), title: `Last ${r.name}`, "aria-label": `${r.label}: last ${r.name}`,
    onclick: () => { savePref(store(), prefKey, r.key); onChange(r.key); },
  }, r.label)));
}

/** The saved range of a chart, or `fallback` when none of `ranges` was saved. */
export const savedRange = (prefKey, ranges, fallback) => loadPref(store(), prefKey, ranges.map((r) => r.key), fallback);

// ── the big-number style ─────────────────────────────────────────────────────

/** A value in the big-number style: digits large, units small and muted (`$` `h` `M` `%` `/100`). */
export function bigValue(text, cls = "") {
  return h("span", { class: `bv${cls ? ` ${cls}` : ""}` }, ...valueParts(text).map((p) => h("span", { class: p.unit ? "bv-u" : "bv-n" }, p.text)));
}

// ── pins ─────────────────────────────────────────────────────────────────────

const pinKey = (scope) => `pins.${scope}`;
export const pinsOf = (scope) => parsePins(loadPref(store(), pinKey(scope), null, "[]"));

/** Order `ids` with the pinned ones first. */
export const pinnedFirst = (scope, ids) => pinOrder(ids, pinsOf(scope));

/** A pin toggle for a card (keyboard: it is a button; state in aria-pressed). `rerender` runs after the change. */
export function pinButton(scope, id, label, rerender) {
  const on = pinsOf(scope).includes(id);
  return h("button", {
    type: "button", class: `pin${on ? " on" : ""}`, "aria-pressed": String(on), "aria-label": `${on ? "Unpin" : "Pin"} ${label}`,
    title: on ? "Pinned to the top in this browser. Click to unpin." : "Pin to the top (this browser only)",
    onclick: () => { savePref(store(), pinKey(scope), JSON.stringify(togglePin(pinsOf(scope), id))); rerender(); },
  }, h("span", { "aria-hidden": "true" }, on ? "★" : "☆"));
}

// ── sparkline ────────────────────────────────────────────────────────────────

/** A small line in the card's category colour; the last value gets a dot. Decorative: the card's sentence says what it shows. */
export function sparkline(values, cat) {
  const v = (Array.isArray(values) ? values : []).map((x) => (isNum(x) ? x : null));
  const known = v.filter((x) => x !== null);
  if (known.length < 2) return null;
  const W = 120, H = 32, pad = 3;
  const max = Math.max(...known), min = Math.min(0, ...known);
  const x = (i) => pad + (i / Math.max(1, v.length - 1)) * (W - 2 * pad);
  const y = (val) => H - pad - ((val - min) / Math.max(1e-9, max - min)) * (H - 2 * pad);
  let d = "";
  let pen = false;
  v.forEach((val, i) => {
    if (val === null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(val).toFixed(1)}`;
    pen = true;
  });
  const li = v.length - 1 - [...v].reverse().findIndex((val) => val !== null);
  return sv("svg", { class: `hl-spark c-${cat}`, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", preserveAspectRatio: "none" },
    sv("path", { d, class: "hl-spark-l" }),
    // the end dot: a zero-length round-capped stroke, so it stays round when the line stretches to the card's width
    sv("path", { d: `M${x(li).toFixed(1)} ${y(v[li]).toFixed(1)}h0`, class: "hl-spark-d" }));
}

// ── Highlights ───────────────────────────────────────────────────────────────

const hl = { wb: null, ins: null, insAt: 0, started: false };
const INSIGHTS_EVERY_MS = 10 * 60_000;

function renderHighlights() {
  const box = $("highlights");
  const sec = $("sec-highlights");
  if (!box || !sec) return;
  const list = highlights({ wb: hl.wb, ins: hl.ins });
  sec.hidden = !list.length;
  if (!list.length) return;
  const byId = new Map(list.map((x) => [x.id, x]));
  const pins = pinsOf("hl");
  box.replaceChildren(...pinnedFirst("hl", list.map((x) => x.id)).map((id) => {
    const x = byId.get(id);
    return h("article", { class: `card hlc c-${x.cat}${pins.includes(id) ? " pinned" : ""}`, "aria-label": `${x.title}: ${x.value} ${x.unit}. ${x.text}` },
      h("div", { class: "hl-head" },
        h("span", { class: `cat-dot c-${x.cat}`, "aria-hidden": "true" }),
        h("span", { class: "hl-t" }, x.title),
        pinButton("hl", id, x.title, renderHighlights)),
      h("div", { class: "hl-v", "aria-hidden": "true" }, bigValue(x.value), h("span", { class: "hl-unit" }, ` ${x.unit}`)),
      h("p", { class: "hl-text", "aria-hidden": "true" }, x.text),
      sparkline(x.spark, x.cat));
  }));
}

/** The You section's data (after each /api/wellbeing load). */
export function feedWellbeing(d) {
  hl.wb = d;
  renderHighlights();
}

async function loadInsights() {
  if (Date.now() - hl.insAt < INSIGHTS_EVERY_MS) return;
  hl.insAt = Date.now();
  try {
    const res = await fetch("/api/usage?group=insights", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    if (res.ok) hl.ins = await res.json();
  } catch { /* the usage card is simply left out */ }
  renderHighlights();
}

/** Start once; `refreshHighlights` is called after every page poll (the usage figures are fetched at most every 10 minutes). */
export function initHighlights() {
  if (hl.started || !$("highlights")) return;
  hl.started = true;
  loadInsights();
}
export const refreshHighlights = () => loadInsights();
