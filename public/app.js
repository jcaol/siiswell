// siiswell UI. Vanilla ES module, no build step, no external requests.
// SECURITY: every value from the API is written with textContent / createTextNode only
// (never innerHTML), so stored text can never become markup. There is no inline script or style either (strict CSP):
// all looks come from classes in style.css.

import { initUsage } from "/usage.js";
import { initWellbeing, refreshWellbeing } from "/wellbeing.js";
import { initHighlights, refreshHighlights } from "/glance-ui.js";
import { cliLabel, showBuildLine, updateNote } from "/version.js";
import { ORIGIN_HOST, ORIGIN_RELAY } from "/wire.js";
import { renderThreads, reporterView } from "/host-ext.js";
import { ago, cleanEventText, cleanTitle, taskKind, taskTitle, clockLabel, mcpQuietSince, dueOnVisible, dur, etaText, eventIcon, friendly, isNum, pollDelay, projectSilent, showOptionalSection, themeView } from "/format.js";

const EVENTS_MAX = 15; // the API sends the last 50; the page shows the newest 15
const FOLD = 8; // rows of recent activity / results shown before "Show more"

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: h("div", { class: "x", onclick }, "text", childNode, ...). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** A small coloured label. `tone` is one of ok | warn | crit | info | idle (see style.css). */
const chip = (label, tone, title) => h("span", { class: `chip ${tone || "idle"}`, title }, label);
const badge = (label, title) => h("span", { class: "badge", title }, label);

// ── words and tones ──────────────────────────────────────────────────────────

const SEVERITY_TONE = { critical: "crit", warn: "warn", info: "info" };
const sevTone = (s) => SEVERITY_TONE[s] || "info";

const TASK_TONE = { queued: "info", delivered: "info", acked: "info", running: "ok", blocked: "warn", done: "ok", failed: "crit", skipped: "idle", stale: "idle" };

const RULE_WORDS = {
  "approval-waiting": "Action waiting",
  blocked: "Blocked",
  "agent-stuck": "Agent stuck",
  "usage-limit": "Usage limit",
  "host-offline": "Host offline",
  "project-offline": "Reporter offline",
  overdue: "Overdue",
  "budget-exhausted": "Budget exhausted",
};

// ── time ─────────────────────────────────────────────────────────────────────

// ── state ────────────────────────────────────────────────────────────────────

const ui = {
  state: null,
  lastOk: 0,
  /** when the last fetch (successful or not) finished: the poll timer and the "back to the page" check count from it */
  lastFetchAt: 0,
  failed: false,
  /** project names that more than one host reports: only those need a `@host` to be told apart */
  ambiguous: new Set(),
  /** keys of the rows the operator expanded; the page is rebuilt every poll, so the open state lives here */
  open: new Set(),
  more: { events: false, results: false },
};

const isOpenState = (s) => !["done", "failed", "skipped", "stale"].includes(s);

/** `project` alone, or `project@host` when two hosts run a project of that name. */
function where(host, project) {
  if (!project) return host || "";
  return host && ui.ambiguous.has(project) ? `${project}@${host}` : project;
}

/** A <details> whose open state survives the rebuild that follows every poll. */
function fold(key, cls, head, body) {
  const d = h("details", { class: cls }, h("summary", null, head), body);
  if (ui.open.has(key)) d.open = true;
  d.addEventListener("toggle", () => {
    if (d.open) ui.open.add(key);
    else ui.open.delete(key);
  });
  return d;
}

function empty(text, cls) {
  return h("div", { class: `empty ${cls || ""}`.trim() }, text);
}

function setCount(id, n) {
  $(id).textContent = n ? `(${n})` : "";
}

// ── derived lists ────────────────────────────────────────────────────────────

function openTasks(s) {
  // Blocked first (they are waiting on the operator), then newest first.
  return s.tasks
    .filter((t) => isOpenState(t.state))
    .sort((a, b) => (b.state === "blocked") - (a.state === "blocked") || b.updated - a.updated);
}

function closedTasks(s) {
  return s.tasks.filter((t) => !isOpenState(t.state)).sort((a, b) => b.updated - a.updated);
}

function taskForAgent(s, host, project, agent) {
  const open = s.tasks.filter((t) => t.host === host && t.project === project && t.agent === agent.name && isOpenState(t.state));
  if (agent.currentTaskId) {
    const exact = open.find((t) => t.taskId === agent.currentTaskId);
    if (exact) return exact;
  }
  return open[0] || null;
}

// ── render: header + summary ─────────────────────────────────────────────────

function renderHeader(s) {
  $("refreshed").textContent = `updated ${new Date(ui.lastOk).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const total = s.hosts.length;
  const off = s.hosts.filter((x) => x.offline).length;
  const pill = $("health");
  pill.hidden = false;
  if (!total) {
    pill.className = "pill idle";
    pill.textContent = "No hosts yet";
  } else if (off) {
    pill.className = "pill crit";
    pill.textContent = `${off} of ${total} host${total === 1 ? "" : "s"} offline`;
  } else {
    pill.className = "pill ok";
    pill.textContent = total === 1 ? "Host online" : "All hosts online";
  }
  // The server could not read some rule inputs completely (a flood of rows, usually one noisy source): alerts
  // that depend on them are NOT being resolved, so the list below can be stale until the cause is gone.
  const truncated = Array.isArray(s.rulesTruncated) ? s.rulesTruncated : [];
  const warn = $("rules-warning");
  warn.hidden = truncated.length === 0;
  warn.textContent = truncated.length
    ? `Warning: some alert inputs are over their limit (${truncated.join(", ")}). Open alerts are kept, none of the affected kinds is being resolved, and new ones may be missing. Look for a source that is flooding the dashboard and revoke its token.`
    : "";
  // The response was cut to stay small (a flood of rows): say what is missing instead of looking complete.
  const cut = Array.isArray(s.truncated) ? s.truncated : [];
  const note = $("state-truncated");
  note.hidden = cut.length === 0;
  note.textContent = cut.length ? `Warning: this view is incomplete, the server left out: ${cut.join(", ")}. A source is probably flooding the dashboard.` : "";
  document.title = s.inbox.length ? `(${s.inbox.length}) Needs you · siiswell` : "siiswell";
}

function renderSummary(s) {
  const open = s.tasks.filter((t) => isOpenState(t.state));
  const blocked = open.filter((t) => t.state === "blocked").length;
  const working = open.length - blocked;
  const done = s.tasks.filter((t) => t.state === "done").length;
  const failed = s.tasks.filter((t) => t.state === "failed").length;
  const tiles = [
    { href: "#sec-inbox", label: "Needs you", n: s.inbox.length, tone: s.inbox.length ? "crit" : "" },
    { href: "#sec-working", label: "Working", n: working, tone: working ? "ok" : "" },
    { href: "#sec-working", label: "Blocked", n: blocked, tone: blocked ? "warn" : "" },
    { href: "#sec-results", label: "Done 24h", n: done, tone: "", extra: failed ? `✖ ${failed}` : null },
    // host integrations and MCP-reported work only: no tile (like no section) while nothing has reported a project
    showOptionalSection(s.projects) || showOptionalSection(s.mcpProjects) ? { href: "#sec-projects", label: "Projects", n: s.projects.length + (s.mcpProjects || []).length, tone: "" } : null,
  ].filter(Boolean);
  $("summary").replaceChildren(
    ...tiles.map((t) =>
      h(
        "a",
        { class: `stat ${t.tone}`.trim(), href: t.href, "aria-label": `${t.label}: ${t.n}${t.extra ? `, ${t.extra.replace("✖", "failed")}` : ""}` },
        h("span", { class: "stat-n" }, t.n, t.extra ? h("span", { class: "stat-bad", title: "failed in the last 24 h" }, t.extra) : null),
        h("span", { class: "stat-l" }, t.label),
      ),
    ),
  );
}

// ── render: needs you ────────────────────────────────────────────────────────

function renderInbox(s, now) {
  const box = $("inbox");
  box.replaceChildren();
  setCount("inbox-count", s.inbox.length);
  if (!s.inbox.length) {
    box.append(h("div", { class: "empty ok-empty" }, h("span", { class: "tick", "aria-hidden": "true" }, "✓"), "Nothing needs you right now."));
    return;
  }
  for (const a of s.inbox) {
    const scope = a.project ? `${a.project}@${a.host}` : a.host; // the project alone is ambiguous across hosts
    const body = a.text && a.text.startsWith(`${scope}: `) ? a.text.slice(scope.length + 2) : a.text; // the text repeats the scope; the line below shows it
    const foreign = a.origin && a.origin !== ORIGIN_HOST; // desktop client or relayed agent: never shown as a host-agent alert
    box.append(
      h(
        "article",
        { class: `card alert ${a.severity}`, dataset: { key: a.key } },
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "title" }, RULE_WORDS[a.rule] || a.rule),
          h(
            "span",
            { class: "row" },
            foreign ? badge(a.origin) : null,
            a.summarized_at && !a.push_count ? badge("summarised", "Not pushed on its own: only a summary push mentioned it") : null,
            chip(a.severity, sevTone(a.severity)),
          ),
        ),
        h("div", { class: "sub" }, h("b", { class: "scope" }, scope), a.agent ? ` · ${a.agent}` : null, ` · opened ${ago(a.opened, now)}`),
        body ? h("div", { class: "alert-text" }, body) : null,
      ),
    );
  }
  highlightFromHash();
}

// ── render: working now ──────────────────────────────────────────────────────

/** The project (and host) of a task; a desktop-client task has neither, so the client's name stands in. */
/** A small chip with the task's kind, only next to a real title (the generic one already shows it in the title). */
function kindChip(t) {
  const k = taskKind(t);
  if (!k || taskTitle(t).startsWith(`${k} · `) || taskTitle(t) === k) return null;
  return h("span", { class: "kind-chip" }, k);
}

function taskScope(t) {
  if (t.project) return where(t.host, t.project);
  if (t.origin === "mcp") return t.key.split("|")[1] || "desktop client";
  return t.host || "";
}

/** A host-agent project that runs in a privacy mode (dashboard.text "titles" / "none") sends no reply text: say so instead of looking empty. */
function hiddenNote(s, t) {
  if (t.origin !== ORIGIN_HOST) return null;
  const p = (s.projects || []).find((x) => x.host === t.host && x.project === t.project);
  return p && p.textMode && p.textMode !== "full" ? h("div", { class: "sub lastline" }, "details hidden (privacy mode) — see the host's chat") : null;
}

function originBadge(t) {
  if (t.origin === "mcp") return badge("desktop");
  if (t.origin === ORIGIN_RELAY) return badge("forwarded", "reported by an agent this host does not run");
  return null;
}

function renderWorking(s, now) {
  const box = $("working");
  box.replaceChildren();
  const list = openTasks(s);
  setCount("working-count", list.length);
  if (!list.length) {
    box.append(empty("No agent is working on a task right now."));
    return;
  }
  for (const t of list) {
    // a desktop client's task nobody updated long after its ETA: neutral "no update since", not "overdue"
    const quiet = mcpQuietSince(t, now);
    const eta = isNum(t.etaAt) && t.state !== "blocked" && quiet === null ? t.etaAt : null;
    const late = eta !== null && eta < now;
    box.append(
      h(
        "article",
        { class: `card wk ${quiet !== null ? "quiet" : t.state}` },
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "row" }, t.agent ? h("span", { class: "agent-tag" }, t.agent) : null, h("span", { class: "scope" }, taskScope(t)), originBadge(t)),
          quiet !== null ? chip("no update", "idle", "the agent has not reported for a while; it may have finished without calling update_task") : chip(t.state, TASK_TONE[t.state] || "idle"),
        ),
        h("div", { class: "wk-title clamp2" }, kindChip(t), taskTitle(t)),
        quiet !== null ? h("div", { class: "sub quiet-note" }, `No update since ${clockLabel(quiet, now)} (agent may have finished without reporting). It closes by itself after 24 h, or now with: siiswell update ${t.taskId} --status DONE`) : null,
        h(
          "div",
          { class: "sub wk-meta" },
          eta !== null ? h("span", { class: late ? "late" : "eta" }, etaText(eta, now)) : null,
          eta !== null ? " · " : null,
          isNum(t.startedAt) ? `started ${ago(t.startedAt, now)}` : `updated ${ago(t.updated, now)}`,
        ),
        t.lastLine ? h("div", { class: "sub lastline clamp2" }, t.lastLine) : hiddenNote(s, t),
      ),
    );
  }
}

// ── render: recent activity ──────────────────────────────────────────────────

function renderActivity(s, now) {
  const box = $("activity");
  box.replaceChildren();
  const events = (s.events || []).slice().sort((a, b) => b.at - a.at).slice(0, EVENTS_MAX);
  if (!events.length) {
    box.append(empty("No activity reported yet."));
    return;
  }
  const shown = ui.more.events ? events : events.slice(0, FOLD);
  for (const e of shown) {
    const icon = eventIcon(e);
    const who = [where(e.host, e.project), e.agent].filter(Boolean).join(" · ");
    const detail = [e.kind, e.status ? e.status.toLowerCase().replace(/_/g, " ") : null, e.scenario, e.sender ? `from ${e.sender}` : null, e.host ? `on ${e.host}` : null, new Date(e.at).toLocaleString()].filter(Boolean).join(" · ");
    box.append(
      fold(
        `evt:${e.key}`,
        `evt ${icon.tone}`,
        [
          h("span", { class: `ico ${icon.tone}`, title: icon.what, role: "img", "aria-label": icon.what }, icon.g),
          h(
            "span",
            { class: "evt-main" },
            h("span", { class: "evt-meta" }, ago(e.at, now), who ? ` · ${who}` : null, e.origin && e.origin !== ORIGIN_HOST ? [" ", badge(e.origin === ORIGIN_RELAY ? "forwarded" : e.origin)] : null),
            h("span", { class: "evt-text" }, cleanEventText(e) || "(no text)"),
          ),
        ],
        h("div", { class: "evt-more" }, detail),
      ),
    );
  }
  moreButton(box, "events", events.length);
}

/** "Show N more" / "Show fewer" under a list that is folded to its first FOLD rows. */
function moreButton(box, which, total) {
  if (total <= FOLD) return;
  box.append(
    h(
      "button",
      {
        type: "button",
        class: "more",
        onclick: () => {
          ui.more[which] = !ui.more[which];
          render();
        },
      },
      ui.more[which] ? "Show fewer" : `Show ${total - FOLD} more`,
    ),
  );
}

// ── render: recent results ───────────────────────────────────────────────────

function renderResults(s, now) {
  const box = $("results");
  box.replaceChildren();
  const list = closedTasks(s);
  if (!list.length) {
    box.append(empty("Nothing finished in the last 24 h."));
    return;
  }
  const shown = ui.more.results ? list : list.slice(0, FOLD);
  for (const t of shown) {
    const took = t.state === "done" && isNum(t.startedAt) && t.updated - t.startedAt >= 60_000 ? ` · took ${dur(t.updated - t.startedAt)}` : "";
    const glyph = t.state === "done" ? "✓" : t.state === "failed" ? "✖" : t.state === "stale" ? "?" : "–";
    const tone = TASK_TONE[t.state] || "idle";
    const detail = [t.host ? `on ${t.host}` : null, t.taskId ? `task ${t.taskId}` : null, `started ${new Date(t.startedAt || t.updated).toLocaleString()}`, `finished ${new Date(t.updated).toLocaleString()}`].filter(Boolean).join(" · ");
    box.append(
      fold(
        `res:${t.key}`,
        `res ${t.state}`,
        [
          h("span", { class: `ico ${tone}`, title: t.state, role: "img", "aria-label": t.state }, glyph),
          h(
            "span",
            { class: "evt-main" },
            h("span", { class: "res-title clamp2" }, kindChip(t), taskTitle(t)),
            t.lastLine ? h("span", { class: "res-line clamp2" }, t.lastLine) : null,
            h(
              "span",
              { class: "evt-meta" },
              t.state === "done" ? null : t.state === "stale" ? [chip("no report", "idle", "closed after 24 h without an update: the agent may have finished without reporting"), " "] : [chip(t.state, tone), " "],
              [t.agent, taskScope(t)].filter(Boolean).join(" · "),
              ` · ${ago(t.updated, now)}${took}`,
              originBadge(t) ? [" ", originBadge(t)] : null,
            ),
          ),
        ],
        h("div", { class: "evt-more" }, detail),
      ),
    );
  }
  moreButton(box, "results", list.length);
}

// ── render: projects ─────────────────────────────────────────────────────────

function agentTooltip(a, task, now) {
  const f = friendly(a.state);
  const usage = (a.usage || []).map((u) => `${u.label} ${Math.round(u.usedPercent)}% used`);
  return [
    `${a.name}: ${f.label}${isNum(a.stateSince) ? ` since ${ago(a.stateSince, now)}` : ""}`,
    isNum(a.lastReplyAt) ? `last reply ${ago(a.lastReplyAt, now)}` : null,
    ...usage,
    isNum(a.contextPercent) ? `context ${Math.round(a.contextPercent)}%` : null,
    task ? `task: ${taskTitle(task)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function pctEl(label, value, suffix = "") {
  if (!isNum(value)) return null;
  const cls = value >= 90 ? "pct hot" : value >= 70 ? "pct warm" : "pct";
  return h("span", { class: cls, title: label }, `${label} ${Math.round(value)}%${suffix}`);
}

function agentDetail(s, p, a, now) {
  const f = friendly(a.state);
  const task = taskForAgent(s, p.host, p.project, a);
  const usage = (a.usage || []).slice().sort((x, y) => y.usedPercent - x.usedPercent);
  return h(
    "div",
    { class: "agent" },
    h("div", { class: "row" }, h("span", { class: "title" }, a.name), chip(f.label, f.tone, f.hint), a.baseCli ? badge(a.baseCli) : null),
    task ? h("div", { class: "task" }, taskTitle(task)) : h("div", { class: "sub" }, f.tone === "sleep" ? "no open task · wakes on the next message" : "no open task"),
    h(
      "div",
      { class: "stats" },
      isNum(a.stateSince) ? h("span", { title: "in this state since" }, `${f.label} for ${dur(now - a.stateSince)}`) : null,
      isNum(a.lastReplyAt) ? h("span", { title: "last reply" }, `last reply ${ago(a.lastReplyAt, now)}`) : null,
      ...usage.map((u) => pctEl(u.label, u.usedPercent, " used")),
      pctEl("context", a.contextPercent),
    ),
  );
}

/** One "machine / project" card of MCP-reported work (several apps of one machine, each with its own client token, side by side). */
function mcpProjectCard(s, g, now) {
  const tasks = g.taskKeys.map((k) => s.tasks.find((t) => t.key === k)).filter(Boolean);
  const head = [
    h(
      "span",
      { class: "proj-head" },
      h("span", { class: "chev", "aria-hidden": "true" }),
      h("span", { class: "title" }, `${g.group} / ${g.project}`),
      g.blocked ? chip(`${g.blocked} waiting`, "crit", "tasks blocked on you") : null,
      h("span", { class: "grow" }),
      g.open ? chip(`${g.open} open`, "ok") : chip("idle", "idle", "no open task; finished ones are shown for 24 h"),
    ),
    h("span", { class: "snap" }, h("span", { class: "sub" }, `${g.byMachine ? `via ${g.clients.join(", ")}` : "reported by this client"} · last update ${ago(g.lastUpdate, now)}`)),
  ];
  const body = h(
    "div",
    { class: "proj-body stack tight" },
    ...tasks.map((t) => h(
      "div",
      { class: "row" },
      chip(t.state, t.state === "blocked" ? "crit" : isOpenState(t.state) ? "ok" : "idle"),
      h("span", { class: "title" }, kindChip(t), taskTitle(t)),
      h("span", { class: "sub" }, ` ${t.agent || ""} · ${ago(t.updated, now)}`),
    )),
    !tasks.length ? h("div", { class: "sub" }, "tasks not shown (the state was cut to stay small)") : null,
  );
  return fold(`mcp:${g.group}|${g.project}`, `proj${g.blocked ? " has-alert" : g.open ? " has-work" : ""}`, head, body);
}

function renderProjects(s, now) {
  const box = $("projects");
  box.replaceChildren();
  const mcp = Array.isArray(s.mcpProjects) ? s.mcpProjects : [];
  setCount("projects-count", s.projects.length + mcp.length);
  $("projects-legend").hidden = !s.projects.some((p) => p.agents.some((a) => a.state === "killed" || a.state === "frozen"));
  const show = showOptionalSection(s.projects) || showOptionalSection(mcp);
  $("sec-projects").hidden = !show; // host integrations and MCP-reported work only: nothing at all without data
  if (!show) return;
  // MCP-reported work (desktop / CLI apps) first when something waits on the operator, else after the host projects
  const waiting = mcp.filter((g) => g.blocked > 0);
  for (const g of waiting) box.append(mcpProjectCard(s, g, now));
  const rows = s.projects.map((p) => {
    const alerts = s.inbox.filter((a) => a.host === p.host && a.project === p.project).length;
    const working = p.agents.filter((a) => a.state === "working").length;
    const hostInfo = s.hosts.find((x) => x.host === p.host);
    // Liveness is host-level and comes from the Worker (`hosts.last_seen`, offline after 5 min of silence). A project's
    // snapshot age says nothing about it: an unchanged project sends heartbeats, not snapshots, so its snapshot can be
    // hours old on a healthy host. Without a host row (not seen in practice) there is nothing to call stale.
    const hostOffline = hostInfo ? hostInfo.offline : false;
    // One project's reporter can die while the host (and its other projects) keep reporting: `lastSeen` is when anything last
    // arrived for THIS project (the Worker records it for snapshots, heartbeats and events).
    const silent = !hostOffline && projectSilent(p.lastSeen, s.now, now);
    const stale = hostOffline || silent;
    return { p, alerts, working, stale, silent };
  });
  // Projects that need a look (alerts, an offline reporter, then working agents) first; the rest by name.
  rows.sort((a, b) => b.alerts - a.alerts || b.stale - a.stale || b.working - a.working || a.p.project.localeCompare(b.p.project) || a.p.host.localeCompare(b.p.host));
  for (const { p, alerts, working, stale, silent } of rows) {
    const rep = reporterView(p.poller, p.lastSeen, p.host, now);
    const status = stale ? "offline" : rep.status;
    const statusTone = stale ? "crit" : status === "running" ? "ok" : "warn";
    const chips = p.agents.map((a) => {
      const f = friendly(a.state);
      const task = taskForAgent(s, p.host, p.project, a);
      return h("span", { class: `achip ${f.tone}`, title: agentTooltip(a, task, now) }, h("i", { class: "dot", "aria-hidden": "true" }), a.name, " ", h("b", null, f.label));
    });
    const head = [
      h(
        "span",
        { class: "proj-head" },
        h("span", { class: "chev", "aria-hidden": "true" }),
        h("span", { class: "title" }, where(p.host, p.project)),
        alerts ? chip(`${alerts} alert${alerts === 1 ? "" : "s"}`, "crit") : null,
        h("span", { class: "grow" }),
        chip(stale ? "reporter offline" : `reporter ${status}`, statusTone, silent ? `nothing heard from this project's reporter for ${dur((isNum(s.now) ? s.now : now) - p.lastSeen)} (its host is online)` : "reporter status"),
      ),
      h("span", { class: "snap" }, h("span", { class: "sub", title: "time of the last change the reporter reported; an unchanged project sends heartbeats instead" }, `last change ${ago(p.receivedAt, now)}`), rep.stale ? chip("binary stale", "warn", "the reporter runs a binary that was replaced on disk") : null),
      h("span", { class: "achips" }, chips),
    ];
    const body = h(
      "div",
      { class: "proj-body" },
      h("div", { class: "sub" }, rep.line),
      h("div", { class: "agent-grid" }, p.agents.map((a) => agentDetail(s, p, a, now))),
    );
    box.append(fold(`proj:${p.host}|${p.project}`, `proj${alerts ? " has-alert" : working ? " has-work" : ""}`, head, body));
  }
  for (const g of mcp.filter((x) => x.blocked === 0)) box.append(mcpProjectCard(s, g, now));
}

// ── render: hosts ───────────────────────────────────────────────

function renderHosts(s, now) {
  const box = $("hosts");
  box.replaceChildren();
  const off = s.hosts.filter((x) => x.offline).length;
  $("hosts-brief").textContent = `${s.hosts.length} host${s.hosts.length === 1 ? "" : "s"}${off ? ` (${off} offline)` : ""} · ${s.clients.length} client${s.clients.length === 1 ? "" : "s"}`;
  if (!s.hosts.length && !s.clients.length) {
    box.append(empty("No hosts or clients yet."));
    return;
  }
  for (const x of s.hosts) {
    box.append(
      h(
        "article",
        { class: "card" },
        h("div", { class: "card-head" }, h("span", { class: "title" }, x.host), chip(x.offline ? "offline" : "online", x.offline ? "crit" : "ok")),
        h("div", { class: "sub" }, `seen ${ago(x.lastSeen, now)} · reporter ${x.binaryVersion || "?"} · ${cliLabel(x.clientVersion)} · ${x.projects.length} project${x.projects.length === 1 ? "" : "s"}${x.projects.length ? `: ${x.projects.join(", ")}` : ""}`),
        updateNote(x.clientVersion, s.serverVersion) ? h("div", { class: "sub update-note" }, updateNote(x.clientVersion, s.serverVersion)) : null,
      ),
    );
  }
  for (const c of s.clients) {
    box.append(
      h(
        "article",
        { class: "card" },
        h("div", { class: "card-head" }, h("span", { class: "title" }, c.name), badge("desktop client")),
        h("div", { class: "sub" }, `${isNum(c.lastSeen) ? `last report/heartbeat ${ago(c.lastSeen, now)}` : "no report yet"} · ${cliLabel(c.clientVersion)}`),
        updateNote(c.clientVersion, s.serverVersion) ? h("div", { class: "sub update-note" }, updateNote(c.clientVersion, s.serverVersion)) : null,
      ),
    );
  }
}

function render() {
  const s = ui.state;
  if (!s) return;
  const now = Date.now();
  const hostsOf = new Map();
  for (const p of s.projects) hostsOf.set(p.project, new Set([...(hostsOf.get(p.project) || []), p.host]));
  ui.ambiguous = new Set([...hostsOf].filter(([, hosts]) => hosts.size > 1).map(([name]) => name));
  renderHeader(s);
  renderSummary(s);
  renderInbox(s, now);
  renderWorking(s, now);
  renderActivity(s, now);
  renderResults(s, now);
  renderProjects(s, now);
  renderThreads(s, now, { $, h, chip, where }); // optional host integration: hidden without data
  renderHosts(s, now);
}

function highlightFromHash() {
  const m = /^#alert=(.+)$/.exec(location.hash);
  if (!m) return;
  let key;
  try {
    key = decodeURIComponent(m[1]);
  } catch {
    return;
  }
  for (const el of document.querySelectorAll("#inbox .card")) {
    const hit = el.dataset.key === key;
    el.classList.toggle("hl", hit);
    if (hit) el.scrollIntoView({ block: "center" });
  }
}

// ── data loop ────────────────────────────────────────────────────────────────

function showStale(message) {
  const el = $("stale");
  el.hidden = !message;
  el.textContent = message || "";
}

let inFlight = false;
let pollTimer = null;

/** The next automatic poll, one POLL_MS after the last fetch, and only while the page is visible. */
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.visibilityState !== "visible") return;
  pollTimer = setTimeout(refresh, pollDelay(ui.lastFetchAt, Date.now()));
}

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  clearTimeout(pollTimer);
  pollTimer = null;
  const btn = $("btn-refresh");
  btn.classList.add("busy");
  btn.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/state", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) throw new Error(`access denied (${res.status}); reload to sign in again`);
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    ui.state = await res.json();
    ui.lastOk = Date.now();
    ui.failed = false;
    showStale("");
    render();
    refreshWellbeing(ui.state);
    refreshHighlights();
  } catch (err) {
    ui.failed = true;
    const since = ui.lastOk ? `Showing data from ${ago(ui.lastOk)}. ` : "";
    showStale(`Could not refresh: ${err && err.message ? err.message : "network error"}. ${since}`);
    if (ui.state) render(); // keep the relative times honest
  } finally {
    ui.lastFetchAt = Date.now();
    inFlight = false;
    btn.classList.remove("busy");
    btn.removeAttribute("aria-busy");
    schedulePoll();
  }
}

// ── Web Push ─────────────────────────────────────────────────────────────────

const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch {
      /* no body */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/** The header row (enable button + its status) is only there while there is something to show in it. */
function syncNotifyRow() {
  $("notify-row").hidden = $("btn-notify").hidden && !$("push-status").textContent;
}

function setPushStatus(text) {
  $("push-status").textContent = text || "";
  syncNotifyRow();
}

/** Subscribed: the enable button goes away; the test button lives under "Hosts & clients". */
function showSubscribed() {
  $("btn-notify").hidden = true;
  $("notify-help").hidden = true;
  $("push-box").hidden = false;
  syncNotifyRow();
}

async function enablePush() {
  setPushStatus("");
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus("Notifications are blocked for this site. Allow them in the browser or iOS settings, then try again.");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const keyRes = await fetch("/api/push/key", { credentials: "same-origin", cache: "no-store" });
    if (!keyRes.ok) throw new Error("push is not configured on the server yet");
    const { publicKey } = await keyRes.json();
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) }));
    await postJson("/api/push/subscribe", sub.toJSON());
    showSubscribed();
    setPushStatus("Notifications enabled on this device.");
    setTimeout(() => setPushStatus(""), 6000);
  } catch (err) {
    setPushStatus(`Could not enable notifications: ${err && err.message ? err.message : err}`);
  }
}

async function sendTest() {
  const out = $("test-status");
  out.textContent = "Sending…";
  try {
    const r = await postJson("/api/push/test", {});
    out.textContent = `Test push sent to ${r.sent} of ${r.subscriptions} device${r.subscriptions === 1 ? "" : "s"}${r.removed ? `, ${r.removed} expired removed` : ""}.`;
  } catch (err) {
    out.textContent = `Test failed: ${err && err.message ? err.message : err}`;
  }
}

async function initPush() {
  const notify = $("btn-notify");
  const help = $("notify-help");
  notify.addEventListener("click", enablePush);
  $("btn-test").addEventListener("click", sendTest);

  if (isIOS && !standalone) {
    help.hidden = false;
    help.textContent = "On iPhone/iPad, notifications only work from the Home Screen: tap Share, then “Add to Home Screen”, open siiswell from there, and tap “Enable notifications”.";
    return;
  }
  if (!pushSupported) {
    help.hidden = false;
    help.textContent = "This browser does not support Web Push.";
    return;
  }
  try {
    await navigator.serviceWorker.register("/sw.js");
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing && Notification.permission === "granted") {
      // Keep the server's copy in sync (idempotent upsert); there is nothing to enable any more.
      postJson("/api/push/subscribe", existing.toJSON()).catch(() => undefined);
      showSubscribed();
      return;
    }
    notify.hidden = false;
    if (Notification.permission === "denied") setPushStatus("Notifications are blocked for this site.");
    syncNotifyRow();
  } catch (err) {
    setPushStatus(`Service worker unavailable: ${err && err.message ? err.message : err}`);
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

/** The header switch: Auto -> Light -> Dark. theme.js (loaded in <head>) owns the choice and applies it. */
function initTheme() {
  const api = window.OrchTheme;
  const btn = $("btn-theme");
  if (!api) return; // theme.js did not load: the page keeps following the device, and there is no switch to show
  const paint = () => {
    const choice = api.get();
    const v = themeView(choice, api.next(choice));
    $("theme-glyph").textContent = v.glyph;
    $("theme-label").textContent = v.label;
    btn.setAttribute("aria-label", v.aria);
    btn.title = v.title;
  };
  btn.hidden = false;
  btn.addEventListener("click", () => {
    api.set(api.next(api.get()));
    paint();
  });
  paint();
}

window.addEventListener("hashchange", highlightFromHash);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    // Nothing is fetched (or scheduled) while the page is hidden.
    clearTimeout(pollTimer);
    pollTimer = null;
    return;
  }
  if (dueOnVisible(ui.lastFetchAt, Date.now())) refresh();
  else {
    if (ui.state) render(); // relative times
    schedulePoll();
  }
});
window.addEventListener("online", refresh);
$("btn-refresh").addEventListener("click", refresh);

initTheme();
refresh();
initPush();
initUsage();
initWellbeing();
initHighlights();
showBuildLine(document.getElementById("build-line"));
