// Optional advanced host integration: the parts of the page fed only by a host's reporter (snapshot fields `poller` and
// `discussions`). Desktop clients never send them, and every section here renders nothing without data.
// DOM is built by the caller's `h()` (text nodes only, never markup): this file only decides what to show.

import { ago, dur, isNum, showOptionalSection } from "/format.js";

/** The reporter of a host project: the chip status and the detail line. */
export function reporterView(poller, lastSeen, host, now) {
  const p = poller || {};
  return {
    status: p.status || "unknown",
    stale: !!p.exeStale,
    line:
      `${host} · reporter ${p.binaryVersion || "?"}` +
      (isNum(p.startedAt) ? ` · up ${dur(now - p.startedAt)}` : "") +
      (isNum(lastSeen) ? ` · last heard ${ago(lastSeen, now)}` : isNum(p.lastPoll) ? ` · last check ${ago(p.lastPoll, now)}` : ""),
  };
}

/** Threads (multi-agent conversations a host reports). The section, heading included, stays hidden without data. */
export function renderThreads(state, now, ui) {
  const { $, h, chip, where } = ui;
  const box = $("discussions");
  box.replaceChildren();
  const list = state.discussions || [];
  const show = showOptionalSection(list);
  $("sec-discussions").hidden = !show;
  if (!show) return;
  for (const d of list) {
    box.append(
      h(
        "article",
        { class: "card" },
        h("div", { class: "card-head" }, h("span", { class: "title" }, d.topic || d.id), chip(d.status || "unknown", d.status === "active" ? "ok" : "idle")),
        h(
          "div",
          { class: "sub" },
          `${where(d.host, d.project)} · turn ${d.round}/${d.maxRounds} · ${d.messages}/${d.maxMessages} messages` + (d.lastSpeaker ? ` · last: ${d.lastSpeaker}` : "") + ` · ${ago(d.updatedAt, now)}`,
        ),
        h("div", { class: "sub" }, `participants: ${(d.participants || []).join(", ") || "-"}`),
        d.benched && d.benched.length ? h("div", { class: "row" }, h("span", { class: "sub" }, "on hold:"), ...d.benched.map((b) => chip(b, "warn"))) : null,
      ),
    );
  }
}
