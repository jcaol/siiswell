#!/usr/bin/env bun
/**
 * Local smoke test against `wrangler dev --local`. Talks ONLY to the URL you give it (default
 * http://127.0.0.1:8787) and to the LOCAL D1 via `wrangler d1 execute --local`; it never uses
 * --remote and needs no Cloudflare account.
 *
 *   # terminal 1 (once): bunx wrangler d1 migrations apply <db-name> --local
 *   #   and a .dev.vars containing DEV_NO_ACCESS=1
 *   # terminal 1:        bunx wrangler dev --local
 *   # terminal 2:        bun scripts/smoke-local.ts [http://127.0.0.1:8787] [--persist-to <dir>]
 *
 * Mints a host and a client token (random names), registers their hashes in the local D1, then:
 * snapshot + event + heartbeat ingest -> /mcp initialize, notification, tools/list, report_task,
 * update_task -> the cron (scheduled()) -> GET /api/state (Access bypassed by DEV_NO_ACCESS) and checks the data is
 * there, then floods one more host token (12 projects x 20 approvals) to see the per-host alert caps and the per-host
 * inbox on the real local SQL engine.
 *
 * Ingest-triggered rule evaluations are throttled to one per source per minute (the cron evaluates every minute), so
 * the script runs the cron once after its writes instead of expecting every request to have evaluated.
 */
import { ORIGIN_HOST } from "../src/shared/wire";
import { join } from "node:path";
import { d1Name } from "./d1-name";

const args = process.argv.slice(2);
const persistIdx = args.indexOf("--persist-to");
const persist = persistIdx >= 0 ? args.splice(persistIdx, 2)[1] : undefined;
const base = (args[0] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
  console.error(`refusing to smoke-test a non-local URL: ${base}`);
  process.exit(2);
}

const root = join(import.meta.dir, "..");
const suffix = crypto.randomUUID().slice(0, 8);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
};

async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * wrangler needs Node >= 22. Use SIISWELL_NODE (or the older ORCH_NODE; path to a Node 22+ binary) if set, else `node` when it is
 * new enough, else run wrangler's local-only D1 commands under `bun --bun` (fine for `d1 execute
 * --local`; `wrangler dev` itself hangs under bun, so start that one with Node 22).
 */
function wranglerCommand(): string[] {
  const script = join(root, "node_modules/wrangler/bin/wrangler.js");
  const candidate = process.env.SIISWELL_NODE ?? process.env.ORCH_NODE ?? "node";
  const v = Bun.spawnSync([candidate, "-p", "process.versions.node"], { stdout: "pipe", stderr: "ignore" });
  const major = v.exitCode === 0 ? Number(new TextDecoder().decode(v.stdout).split(".")[0]) : 0;
  return major >= 22 ? [candidate, script] : ["bun", "--bun", script];
}

async function mint(name: string, kind: "host" | "client"): Promise<string> {
  const token = "oct_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const sql = `INSERT INTO sources (id, name, kind, token_sha256, created) VALUES ('${crypto.randomUUID()}', '${name}', '${kind}', '${await sha256(token)}', ${Date.now()});`;
  const cmd = [...wranglerCommand(), "d1", "execute", d1Name(), "--local", "--command", sql];
  if (persist) cmd.push("--persist-to", persist);
  const proc = Bun.spawn(cmd, { cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`wrangler d1 execute failed:\n${out}\n${err}`);
  return token;
}

async function http(path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const hostName = `smoke-host-${suffix}`;
const clientName = `smoke-client-${suffix}`;
const hostToken = await mint(hostName, "host");
const clientToken = await mint(clientName, "client");
const now = Date.now();

// ── ingest (host token) ──────────────────────────────────────────────────────
const snapshot = {
  v: 1, host: hostName, project: "smoke", sentAt: now,
  poller: { status: "running", binaryVersion: "smoke-1", lastPoll: now, startedAt: now - 60_000 },
  agents: [{ name: "Agent01", baseCli: "claude", state: "working", lastReplyAt: now - 30_000, usage: [{ label: "5h", usedPercent: 42 }], contextPercent: 31 }, { name: "Agent02", baseCli: "codex", state: "idle" }],
  tasks: [
    { id: "Agent01-smoke", agent: "Agent01", title: "smoke task from the snapshot", state: "blocked", dispatchedAt: now - 120_000, updatedAt: now - 60_000, lastLine: "STATUS: BLOCKED waiting for the operator" },
  ],
  discussions: [{ id: "d-smoke", topic: "smoke discussion", status: "active", round: 1, maxRounds: 3, messages: 2, maxMessages: 12, participants: ["Agent01", "Agent02"], benched: [], lastSpeaker: "Agent02", updatedAt: now }],
  approvals: [{ id: "ap-smoke", summary: "approve the smoke run", requestedAt: now - 6 * 60_000, agent: "Agent01" }],
};
let r = await http("/api/ingest/snapshot", { token: hostToken, body: snapshot });
check("POST /api/ingest/snapshot", r.status === 200 && r.json?.ok === true, r.text);
r = await http("/api/ingest/events", { token: hostToken, body: { v: 1, host: hostName, project: "smoke", events: [{ kind: "halt", origin: ORIGIN_HOST, at: now, severity: "critical", key: `smoke-halt-${suffix}`, agent: "Agent02", scenario: "benched", text: "Agent02 benched (smoke)" }] } });
check("POST /api/ingest/events", r.status === 200 && r.json?.accepted === 1, r.text);
r = await http("/api/ingest/heartbeat", { token: hostToken, body: { v: 1, host: hostName, at: now, binaryVersion: "smoke-1" } });
check("POST /api/ingest/heartbeat (no budgetExhausted flag while the budget is fine)", r.status === 200 && r.json?.ok === true && !("budgetExhausted" in r.json), r.text);
r = await http("/api/ingest/snapshot", { token: clientToken, body: snapshot });
check("client token is refused on ingest (403)", r.status === 403, String(r.status));
// host binding: a second host token cannot write as the first host, but can reuse an event key under its own label
const otherName = `smoke-other-${suffix}`;
const otherToken = await mint(otherName, "host");
r = await http("/api/ingest/snapshot", { token: otherToken, body: { ...snapshot, tasks: [] } });
check("host token for another label is refused with 403 and the exact message", r.status === 403 && r.json?.error === `host label '${hostName}' does not match this token`, r.text);
r = await http("/api/ingest/events", { token: otherToken, body: { v: 1, host: otherName, project: "smoke", events: [{ kind: "halt", origin: ORIGIN_HOST, at: now, severity: "critical", key: `smoke-halt-${suffix}`, agent: "Agent02", scenario: "turn-skipped", text: "same key, other source" }] } });
check("the same event key from another source is accepted (keys are per source)", r.status === 200 && r.json?.accepted === 1, r.text);
r = await http("/api/ingest/snapshot", { body: snapshot });
check("no token is refused on ingest (401)", r.status === 401, String(r.status));
r = await http("/api/ingest/heartbeat", { token: "oct_tooshort", body: { v: 1, host: hostName, at: now } });
check("a malformed bearer value is a 401 before any lookup", r.status === 401, String(r.status));
r = await http("/api/ingest/snapshot", { token: hostToken, body: { ...snapshot, tasks: [...snapshot.tasks, { id: "bad id|", agent: "Agent01", title: "bad", state: "running", dispatchedAt: now, updatedAt: now }] } });
check("a snapshot with ONE bad task is accepted: the item is dropped and reported", r.status === 200 && r.json?.dropped === 1 && typeof r.json?.firstError === "string", r.text);

// ── MCP (client token) ───────────────────────────────────────────────────────
const mcp = (body: unknown, token = clientToken) => http("/mcp", { token, body, headers: { Accept: "application/json, text/event-stream" } });
r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
check("MCP initialize", r.status === 200 && r.json?.result?.protocolVersion === "2025-06-18" && r.json?.result?.serverInfo?.name === "siiswell", r.text);
r = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
check("MCP notification -> 202 empty", r.status === 202 && r.text === "", `${r.status} ${r.text}`);
r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
check("MCP tools/list has 3 tools", r.status === 200 && r.json?.result?.tools?.length === 3, r.text);
r = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_task", arguments: { project: "smoke", title: "smoke task over MCP", status: "IN_PROGRESS", eta_min: 20, summary: "started" } } });
const reported = r.json?.result?.content?.[0]?.text ? JSON.parse(r.json.result.content[0].text) : null;
check("MCP report_task returns an m- task id", r.status === 200 && /^m-[0-9a-z]{8}$/.test(reported?.task_id ?? ""), r.text);
r = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_task", arguments: { task_id: reported?.task_id, status: "BLOCKED", summary: "needs input" } } });
check("MCP update_task", r.status === 200 && !r.json?.result?.isError, r.text);
r = await mcp([1, 2, 3].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "heartbeat", arguments: {} } })));
check("MCP batch of 3 heartbeats answers 3 results", r.status === 200 && Array.isArray(r.json) && r.json.length === 3 && r.json.every((m: any) => m.result?.content?.[0]?.text === "ok"), r.text);
r = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/list" }, hostToken);
check("host token is refused on /mcp (403)", r.status === 403, String(r.status));
r = await http("/mcp", { method: "GET", token: clientToken });
check("GET /mcp -> 405", r.status === 405, String(r.status));

// ── the cron (best effort: the local trigger endpoint differs between wrangler versions) ──
// It evaluates the rules, which the ingest requests above may have left to it (the throttle), before the state is read.
async function runCron(): Promise<{ status: number; via: string }> {
  for (const p of ["/cdn-cgi/handler/scheduled", "/cdn-cgi/local/scheduled", "/__scheduled"]) {
    const c = await http(p);
    if (c.status === 200) return { status: 200, via: p };
  }
  return { status: 0, via: "" };
}
const cron1 = await runCron();
if (cron1.status === 200) console.log(`INFO  scheduled() triggered via ${cron1.via}`);
check("cron scheduled() runs without error", cron1.status === 200, "no local scheduled endpoint answered 200");

// ── read API (Access bypassed by DEV_NO_ACCESS=1 on localhost) ───────────────
r = await http("/api/state");
const s = r.json;
check("GET /api/state 200", r.status === 200 && s && typeof s.now === "number", `${r.status} ${r.text.slice(0, 200)}`);
check("state: rulesTruncated is an empty list on a healthy system", Array.isArray(s?.rulesTruncated) && s.rulesTruncated.length === 0, JSON.stringify(s?.rulesTruncated));
check("state: `truncated` (size cut) is an empty list on a healthy system", Array.isArray(s?.truncated) && s.truncated.length === 0, JSON.stringify(s?.truncated));
check("state: host is listed and online",!!s?.hosts?.find((h: any) => h.host === hostName && h.offline === false && h.binaryVersion === "smoke-1"));
check("state: project snapshot with agents", !!s?.projects?.find((p: any) => p.host === hostName && p.project === "smoke" && p.agents.length === 2));
check("state: snapshot task is present", !!s?.tasks?.find((t: any) => t.taskId === "Agent01-smoke" && t.origin === ORIGIN_HOST && t.state === "blocked"));
check("state: MCP task is present and blocked", !!s?.tasks?.find((t: any) => t.taskId === reported?.task_id && t.origin === "mcp" && t.state === "blocked"));
check("state: the MCP agent is namespaced <agent>@<client>", s?.tasks?.find((t: any) => t.taskId === reported?.task_id)?.agent === `agent@${clientName}`);
check("inbox: the MCP alert is labelled origin=mcp and 'via <client>'", !!s?.inbox?.find((a: any) => a.origin === "mcp" && a.host === clientName && String(a.text).endsWith(` · via ${clientName}`)));
check("inbox: a host-agent alert is scoped project@host", !!s?.inbox?.find((a: any) => a.rule === "blocked" && a.host === hostName && String(a.text).startsWith(`smoke@${hostName}: `)));
check("state: discussion is present",!!s?.discussions?.find((d: any) => d.id === "d-smoke" && d.host === hostName));
check("state: client is listed, host token is not", !!s?.clients?.find((c: any) => c.name === clientName) && !s?.clients?.find((c: any) => c.name === hostName));
check("state: halt event is listed (once per source that sent the key)", (s?.events ?? []).filter((e: any) => e.key === `smoke-halt-${suffix}`).length === 2);
check("state: the first host's snapshot task survived the other host's refused write", !!s?.tasks?.find((t: any) => t.host === hostName && t.taskId === "Agent01-smoke"));
const rules = new Set((s?.inbox ?? []).filter((a: any) => a.host === hostName || a.host === clientName).map((a: any) => a.rule));
check("inbox: approval-waiting + blocked + agent-stuck are open", rules.has("approval-waiting") && rules.has("blocked") && rules.has("agent-stuck"), JSON.stringify([...rules]));

// ── push + static assets ─────────────────────────────────────────────────────
r = await http("/api/push/key");
check("GET /api/push/key (VAPID from .dev.vars)", r.status === 200 && typeof r.json?.publicKey === "string", `${r.status} ${r.text}`);
r = await http("/api/push/subscribe", { body: { endpoint: "https://evil.example.com/x", keys: { p256dh: "x", auth: "y" } } });
check("subscribe rejects a non-push-service endpoint", r.status === 400, String(r.status));
for (const [path, type] of [["/", "text/html"], ["/app.js", "javascript"], ["/format.js", "javascript"], ["/style.css", "text/css"], ["/sw.js", "javascript"], ["/manifest.webmanifest", "json"], ["/icon.svg", "svg"]] as const) {
  const a = await http(path);
  check(`static ${path}`, a.status === 200 && (a.headers.get("content-type") ?? "").includes(type), `${a.status} ${a.headers.get("content-type")}`);
}
const idx = await http("/");
check("static / carries the CSP header from public/_headers", (idx.headers.get("content-security-policy") ?? "").includes("default-src 'none'"), String(idx.headers.get("content-security-policy")));
r = await http("/api/health");
check("GET /api/health", r.status === 200 && r.json?.ok === true);

// ── identifiers and limits ───────────────────────────────────────────────────
r = await http("/api/ingest/heartbeat", { token: hostToken, body: { v: 1, host: "not a host label", at: now } });
check("an invalid identifier is rejected with 400 (not rewritten)", r.status === 400 && /^host must match /.test(r.json?.error ?? ""), r.text);
r = await mcp({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "report_task", arguments: { project: "has space", title: "x", status: "DONE" } } });
check("MCP: an invalid project is an isError result", r.status === 200 && r.json?.result?.isError === true, r.text);
{
  // Per-token rate limit (Workers Rate Limiting binding, 60/min for clients): spend the budget from a burst.
  const burst = await Promise.all(Array.from({ length: 90 }, () => http("/mcp", { token: clientToken, body: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { Accept: "application/json, text/event-stream" } })));
  const limited = burst.filter((x) => x.status === 429).length;
  if (limited > 0) check(`rate limit enforced locally (${limited} of 90 burst requests got 429)`, true);
  else console.log("INFO  no 429 in a 90-request burst: the local runtime does not enforce [[ratelimits]] here (the binding is enforced on Cloudflare)");
}

// ── per-host alert caps and the per-host inbox, on the real local SQL engine ─────
{
  const floodName = `smoke-flood-${suffix}`;
  const floodToken = await mint(floodName, "host");
  let okSnapshots = 0;
  for (let p = 0; p < 12; p++) {
    const approvals = Array.from({ length: 20 }, (_, i) => ({ id: `fa${p}-${i}`, summary: "flood", requestedAt: now - 10 * 60_000 }));
    const res = await http("/api/ingest/snapshot", { token: floodToken, body: { v: 1, host: floodName, project: `fp${p}`, sentAt: now, poller: { status: "running" }, agents: [], tasks: [], discussions: [], approvals } });
    if (res.status === 200) okSnapshots++;
  }
  check("flood host: 12 snapshots with 20 old approvals each are accepted", okSnapshots === 12, String(okSnapshots));
  const cron2 = await runCron();
  check("flood host: the cron evaluates", cron2.status === 200);
  r = await http("/api/state");
  const inbox: any[] = r.json?.inbox ?? [];
  const floodAlerts = inbox.filter((a) => a.host === floodName);
  check("flood host: its inbox share is capped per host (100 of its 200+ open alerts)", floodAlerts.length === 100, String(floodAlerts.length));
  check("flood host: the cut is announced (state.truncated has `inbox`)", (r.json?.truncated ?? []).includes("inbox"), JSON.stringify(r.json?.truncated));
  check("flood host: the first host's alerts are still in the inbox", inbox.some((a) => a.host === hostName && a.rule === "approval-waiting"), JSON.stringify(inbox.map((a) => a.host)));
  check("flood host: the rules read nothing cut off (rulesTruncated empty)", (r.json?.rulesTruncated ?? []).length === 0, JSON.stringify(r.json?.rulesTruncated));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
