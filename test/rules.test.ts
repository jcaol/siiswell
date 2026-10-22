import { ORIGIN_HOST, ORIGIN_RELAY } from "../src/shared/wire";
import { describe, expect, test } from "bun:test";
import { ALERT_DEFAULTS } from "../src/shared/schema";
import {
  BLOCKED_ALERT_TTL_MS,
  EVENT_ALERT_TTL_MS,
  PUSH_RETRY_WINDOW_MS,
  REOPEN_GRACE_MS,
  evaluateRules,
  pushDue,
  pushMessage,
  summaryPushMessage,
  type RuleAlert,
  type RuleEvent,
  type RuleInput,
  type RuleSnapshot,
  type RuleTask,
} from "../src/rules";
import { snapshot } from "./d1-shim";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function input(over: Partial<RuleInput> = {}): RuleInput {
  return { now: NOW, snapshots: [], hosts: [], tasks: [], events: [], alerts: [], ...over };
}

function snap(over: Parameters<typeof snapshot>[0] = {}, receivedAt = NOW): RuleSnapshot {
  const s = snapshot(over, NOW);
  return { host: s.host, project: s.project, receivedAt, snap: s };
}

function task(over: Partial<RuleTask> = {}): RuleTask {
  return {
    key: "hosta|proja|T-1",
    origin: ORIGIN_HOST,
    host: "hosta",
    project: "proja",
    agent: "Agent01",
    task_id: "T-1",
    title: "do the thing",
    state: "running",
    eta_at: null,
    last_line: null,
    created: NOW - 20 * MIN,
    updated: NOW - 10 * MIN,
    ...over,
  };
}

function haltEvent(over: Partial<RuleEvent> = {}): RuleEvent {
  return {
    key: "e1",
    host: "hosta",
    project: "proja",
    kind: "halt",
    agent: "Agent02",
    scenario: "benched",
    at: NOW - 30_000,
    text: "Agent02 benched from discussion",
    ...over,
  };
}

/** Apply an output the way the runner does, to feed the next evaluation. */
function applyTo(alerts: RuleAlert[], out: ReturnType<typeof evaluateRules>, now: number): RuleAlert[] {
  let next = alerts.map((a) => ({ ...a, resolved: out.resolve.includes(a.key) && a.resolved === null ? now : a.resolved }));
  for (const d of out.open) {
    // openAlertsStmt: a key resolved less than REOPEN_GRACE_MS ago re-opens as the same incident
    // (counters kept); anything older starts a fresh episode.
    const prior = next.find((x) => x.key === d.key && x.resolved !== null);
    if (prior && now - (prior.resolved as number) < REOPEN_GRACE_MS) {
      prior.resolved = null;
    } else {
      next = next.filter((x) => x.key !== d.key);
      next.push({ key: d.key, rule: d.rule, last_pushed: null, push_count: 0, opened: now, resolved: null });
    }
  }
  for (const p of out.push) {
    const a = next.find((x) => x.key === p.key && x.resolved === null);
    if (a) {
      a.push_count += 1;
      a.last_pushed = now;
    }
  }
  return next;
}

describe("approval-waiting", () => {
  const approval = (ageMs: number) =>
    snap({ approvals: [{ id: "ap1", summary: "rm -rf build/", requestedAt: NOW - ageMs, agent: "Agent01" }] });

  test("does not open before 5 min, exactly at 5 min, opens after", () => {
    expect(evaluateRules(input({ snapshots: [approval(4 * MIN)] })).open).toHaveLength(0);
    expect(evaluateRules(input({ snapshots: [approval(ALERT_DEFAULTS.approvalWaitingAfterMs)] })).open).toHaveLength(0);
    const out = evaluateRules(input({ snapshots: [approval(5 * MIN + 1)] }));
    expect(out.open).toHaveLength(1);
    expect(out.open[0]).toMatchObject({ key: "approval-waiting|hosta|proja|ap1", rule: "approval-waiting", project: "proja", agent: "agent01" });
    expect(out.push).toHaveLength(1);
  });

  test("an approval without requestedAt cannot age and never alerts", () => {
    const s = snap({ approvals: [{ id: "ap9", summary: "x" }] });
    expect(evaluateRules(input({ snapshots: [s] })).desired).toHaveLength(0);
  });

  test("resolves when the approval is gone", () => {
    const first = evaluateRules(input({ snapshots: [approval(6 * MIN)] }));
    const alerts = applyTo([], first, NOW);
    const out = evaluateRules(input({ snapshots: [snap()], alerts }));
    expect(out.resolve).toEqual(["approval-waiting|hosta|proja|ap1"]);
    expect(out.open).toHaveLength(0);
  });

  test("pushes on open, then after 15, 30, 60 and 120 more minutes (back-off), at most 5 times", () => {
    const sn = (now: number) => approval(6 * MIN + (now - NOW));
    let alerts: RuleAlert[] = [];
    const pushedAt: number[] = [];
    // Evaluate every minute for 5 hours.
    for (let t = NOW; t <= NOW + 300 * MIN; t += MIN) {
      const out = evaluateRules({ ...input({ snapshots: [sn(t)], alerts }), now: t });
      if (out.push.length) pushedAt.push(t);
      alerts = applyTo(alerts, out, t);
    }
    expect(pushedAt).toEqual([NOW, NOW + 15 * MIN, NOW + 45 * MIN, NOW + 105 * MIN, NOW + 225 * MIN]);
    expect(alerts.find((a) => a.resolved === null)?.push_count).toBe(ALERT_DEFAULTS.approvalMaxPushes);
  });

  test("a reminder waits 15 / 30 / 60 / 120 min after the 1st / 2nd / 3rd / 4th push, then never; flagged as a reminder", () => {
    const base = { rule: "approval-waiting", opened: NOW - 31 * MIN };
    for (const [count, wait] of [[1, 15], [2, 30], [3, 60], [4, 120]] as const) {
      expect(pushDue({ ...base, push_count: count, last_pushed: NOW - (wait - 1) * MIN }, NOW)).toBe(false);
      expect(pushDue({ ...base, push_count: count, last_pushed: NOW - wait * MIN }, NOW)).toBe(true);
    }
    expect(pushDue({ ...base, push_count: 5, last_pushed: NOW - 600 * MIN }, NOW)).toBe(false);
    const out = evaluateRules(
      input({
        snapshots: [approval(40 * MIN)],
        alerts: [{ key: "approval-waiting|hosta|proja|ap1", rule: "approval-waiting", opened: NOW - 31 * MIN, last_pushed: NOW - 31 * MIN, push_count: 1, resolved: null }],
      }),
    );
    expect(out.push).toHaveLength(1);
    expect(out.push[0]).toMatchObject({ reminder: true, pushCount: 1 });
  });
});

describe("blocked", () => {
  test("opens for a blocked task of any origin, pushes once, resolves when unblocked", () => {
    const tasks = [
      task({ key: "k1", task_id: "T-1", state: "blocked", last_line: "STATUS: BLOCKED need credentials" }),
      task({ key: "mcp|client1|m-abc", origin: "mcp", host: "client1", project: "web", agent: "client1", task_id: "m-abc", state: "blocked" }),
      task({ key: "relay|hosta|proja|@bot:x", origin: ORIGIN_RELAY, task_id: "@bot:x", state: "blocked", agent: "OtherBot" }),
      task({ key: "k4", task_id: "T-4", state: "running" }),
    ];
    const out = evaluateRules(input({ tasks }));
    expect(out.open.map((a) => a.key).sort()).toEqual([
      "blocked|client1|web|m-abc",
      "blocked|hosta|proja|@bot:x",
      "blocked|hosta|proja|T-1",
    ]);
    expect(out.push).toHaveLength(3);

    const alerts = applyTo([], out, NOW);
    const again = evaluateRules(input({ tasks, alerts }));
    expect(again.open).toHaveLength(0);
    expect(again.push).toHaveLength(0); // once only

    const unblocked = evaluateRules(input({ tasks: [task({ key: "k1", task_id: "T-1", state: "running" })], alerts }));
    expect(unblocked.resolve.sort()).toEqual(["blocked|client1|web|m-abc", "blocked|hosta|proja|@bot:x", "blocked|hosta|proja|T-1"]);
  });

  describe("resolution by a newer dispatch (host-agent tasks: the blocked task is CLOSED in the ledger and stays in the snapshot)", () => {
    const blocked = () => task({ key: "hosta|proja|T-old", task_id: "T-old", state: "blocked", created: NOW - 60 * MIN, updated: NOW - 50 * MIN });
    const newer = (over: Partial<RuleTask> = {}) =>
      task({ key: "hosta|proja|T-new", task_id: "T-new", state: "queued", created: NOW - 5 * MIN, updated: NOW - 5 * MIN, ...over });

    test("a later dispatch to the same host+project+agent resolves the alert, whatever state the new task is in, and it stays resolved", () => {
      const open = evaluateRules(input({ tasks: [blocked()] }));
      expect(open.open.map((a) => a.key)).toEqual(["blocked|hosta|proja|T-old"]);
      let alerts = applyTo([], open, NOW - 40 * MIN);

      for (const state of ["queued", "delivered", "acked", "running", "done", "failed", "skipped"]) {
        const out = evaluateRules(input({ tasks: [blocked(), newer({ state })], alerts }));
        expect(out.resolve).toEqual(["blocked|hosta|proja|T-old"]);
        expect(out.open).toHaveLength(0);
      }
      const out = evaluateRules(input({ tasks: [blocked(), newer()], alerts }));
      alerts = applyTo(alerts, out, NOW);
      expect(alerts[0]?.resolved).toBe(NOW);
      const later = evaluateRules({ ...input({ tasks: [blocked(), newer()], alerts }), now: NOW + 5 * MIN });
      expect(later.open).toEqual([]); // no flapping: the old blocked task does not re-open
      expect(later.push).toEqual([]);
    });

    test("it must be the same host, project and agent, and strictly newer", () => {
      const open = (extra: RuleTask[]) => evaluateRules(input({ tasks: [blocked(), ...extra] })).desired.map((d) => d.key);
      expect(open([newer({ agent: "Agent02", task_id: "T-n2", key: "k2" })])).toEqual(["blocked|hosta|proja|T-old"]); // other agent
      expect(open([newer({ project: "other", task_id: "T-n3", key: "k3" })])).toEqual(["blocked|hosta|proja|T-old"]); // other project
      expect(open([newer({ host: "otherhost", task_id: "T-n4", key: "k4" })])).toEqual(["blocked|hosta|proja|T-old"]); // other host
      expect(open([newer({ created: NOW - 90 * MIN, task_id: "T-n5", key: "k5" })])).toEqual(["blocked|hosta|proja|T-old"]); // dispatched earlier
      expect(open([newer({ created: NOW - 60 * MIN, task_id: "T-n6", key: "k6" })])).toEqual(["blocked|hosta|proja|T-old"]); // same instant
      expect(open([newer()])).toEqual([]);
    });

    test("another blocked task of the same agent that is newer also supersedes the older one, and itself stays open", () => {
      const second = newer({ state: "blocked" });
      const keys = evaluateRules(input({ tasks: [blocked(), second] })).desired.map((d) => d.key);
      expect(keys).toEqual(["blocked|hosta|proja|T-new"]);
    });

    test("MCP and relay tasks are NOT resolved by newer tasks, only by their own update", () => {
      const mcp = (id: string, state: string, created: number) =>
        task({ key: `mcp|client1|${id}`, origin: "mcp", host: "client1", project: "web", agent: "client1", task_id: id, state, created, updated: created });
      const stillBlocked = evaluateRules(input({ tasks: [mcp("m-1", "blocked", NOW - 60 * MIN), mcp("m-2", "running", NOW - 5 * MIN)] }));
      expect(stillBlocked.desired.map((d) => d.key)).toEqual(["blocked|client1|web|m-1"]);
      const alerts = applyTo([], stillBlocked, NOW);
      // update_task moves it out of blocked -> resolves
      const moved = evaluateRules(input({ tasks: [mcp("m-1", "running", NOW - 60 * MIN), mcp("m-2", "running", NOW - 5 * MIN)], alerts }));
      expect(moved.resolve).toEqual(["blocked|client1|web|m-1"]);
    });
  });

  describe("6 h cap (all origins)", () => {
    const aged = (origin: string, ageMs: number) =>
      task({ key: `${origin}|k`, origin, task_id: "T-aged", state: "blocked", created: NOW - ageMs - MIN, updated: NOW - ageMs });

    test("a blocked task older than 6 h no longer alerts; just under 6 h still does", () => {
      for (const origin of [ORIGIN_HOST, "mcp", ORIGIN_RELAY]) {
        expect(evaluateRules(input({ tasks: [aged(origin, BLOCKED_ALERT_TTL_MS - 1)] })).desired).toHaveLength(1);
        expect(evaluateRules(input({ tasks: [aged(origin, BLOCKED_ALERT_TTL_MS)] })).desired).toHaveLength(0);
      }
    });

    test("an open alert is resolved when the cap is reached and does not re-open on later evaluations", () => {
      const t = aged("mcp", BLOCKED_ALERT_TTL_MS - 2 * MIN);
      let alerts = applyTo([], evaluateRules(input({ tasks: [t] })), NOW);
      expect(alerts).toHaveLength(1);
      const atCap = evaluateRules({ ...input({ tasks: [t], alerts }), now: NOW + 2 * MIN });
      expect(atCap.resolve).toEqual(["blocked|" + "hosta|proja|T-aged"]);
      alerts = applyTo(alerts, atCap, NOW + 2 * MIN);
      for (const later of [3, 30, 600]) {
        const out = evaluateRules({ ...input({ tasks: [t], alerts }), now: NOW + later * MIN });
        expect(out.open).toEqual([]);
        expect(out.push).toEqual([]);
      }
    });

    test("a task blocked again later (new update time) can alert again", () => {
      const reblocked = { ...aged("mcp", BLOCKED_ALERT_TTL_MS + 60 * MIN), updated: NOW - MIN };
      expect(evaluateRules(input({ tasks: [reblocked] })).desired).toHaveLength(1);
    });
  });

  test("blocked again within 30 min of resolving is the same incident (no second push); after 30 min it is a fresh episode that pushes again", () => {
    const blocked = (updated: number) => [task({ state: "blocked", updated, created: updated - MIN })];
    let alerts = applyTo([], evaluateRules(input({ tasks: blocked(NOW - 5 * MIN) })), NOW);
    expect(alerts[0]?.push_count).toBe(1);
    alerts = applyTo(alerts, evaluateRules({ ...input({ tasks: [task({ state: "running" })], alerts }), now: NOW + MIN }), NOW + MIN);
    expect(alerts[0]?.resolved).not.toBeNull();

    // re-blocked 29 minutes after it was resolved: same incident, nothing to push
    const soon = evaluateRules({ ...input({ tasks: blocked(NOW + 29 * MIN), alerts }), now: NOW + 30 * MIN });
    expect(soon.open).toHaveLength(1);
    expect(soon.push).toEqual([]);
    const reopened = applyTo(alerts, soon, NOW + 30 * MIN);
    expect(reopened[0]).toMatchObject({ resolved: null, push_count: 1 });

    // re-blocked more than 30 minutes after it was resolved: a new episode pushes again
    const late = evaluateRules({ ...input({ tasks: blocked(NOW + 40 * MIN), alerts }), now: NOW + 41 * MIN });
    expect(late.open).toHaveLength(1);
    expect(late.push).toHaveLength(1);
    expect(late.push[0]).toMatchObject({ pushCount: 0, reminder: false });
  });
});

describe("flapping never pushes twice (stale-snapshot sequence)", () => {
  test("a snapshot built before the halt but sent after it resolves the alert, the next one re-opens it: ONE push in total", () => {
    const T = NOW;
    const halt = haltEvent({ agent: "Agent02", scenario: "benched", at: T });
    const staleSnapshot = snap({ sentAt: T + 5_000, agents: [{ name: "agent02", state: "idle" }] }); // state from before the halt
    const freshSnapshot = snap({ sentAt: T + 65_000, agents: [{ name: "agent02", state: "benched" }] });
    let alerts: RuleAlert[] = [];
    let pushes = 0;
    const step = (now: number, snapshots: RuleSnapshot[]) => {
      const out = evaluateRules({ ...input({ events: [halt], snapshots, alerts }), now });
      pushes += out.push.length;
      alerts = applyTo(alerts, out, now);
      return out;
    };
    expect(step(T + 1_000, []).open).toHaveLength(1); // the halt event arrives: opened + pushed
    expect(pushes).toBe(1);
    expect(step(T + 6_000, [staleSnapshot]).resolve).toHaveLength(1); // stale snapshot resolves it
    const again = step(T + 66_000, [freshSnapshot]); // fresh snapshot: the condition holds again
    expect(again.open).toHaveLength(1); // re-opened ...
    expect(again.push).toEqual([]); // ... without a second push
    expect(pushes).toBe(1);
    expect(alerts.filter((a) => a.resolved === null)).toHaveLength(1);
    expect(alerts[0]?.push_count).toBe(1);
    // and it stays quiet from then on
    expect(step(T + 130_000, [freshSnapshot]).push).toEqual([]);
    expect(pushes).toBe(1);
  });

  test("approval reminders keep their cadence across a flap", () => {
    const approval = (now: number) => snap({ approvals: [{ id: "ap1", summary: "x", requestedAt: NOW - 6 * MIN }], sentAt: now });
    let alerts = applyTo([], evaluateRules(input({ snapshots: [approval(NOW)] })), NOW); // pushed once at NOW
    alerts = applyTo(alerts, evaluateRules({ ...input({ snapshots: [snap()], alerts }), now: NOW + 10 * MIN }), NOW + 10 * MIN); // approval vanished
    const back = evaluateRules({ ...input({ snapshots: [approval(NOW)], alerts }), now: NOW + 12 * MIN });
    expect(back.open).toHaveLength(1);
    expect(back.push).toEqual([]); // last push was 12 min ago: next reminder not due
    alerts = applyTo(alerts, back, NOW + 12 * MIN);
    const reminder = evaluateRules({ ...input({ snapshots: [approval(NOW)], alerts }), now: NOW + 31 * MIN });
    expect(reminder.push).toHaveLength(1);
    expect(reminder.push[0]).toMatchObject({ reminder: true, pushCount: 1 });
  });
});

describe("agent names are compared case-insensitively", () => {
  test("agent-stuck: a halt for 'Agent02' is matched with snapshot agent 'agent02' in both directions", () => {
    const ev = haltEvent({ agent: "Agent02", at: NOW - 60_000 });
    const healthy = snap({ sentAt: NOW, agents: [{ name: "AGENT02", state: "idle" }] });
    const benched = snap({ sentAt: NOW, agents: [{ name: "agent02", state: "benched" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [healthy] })).desired).toHaveLength(0);
    expect(evaluateRules(input({ events: [ev], snapshots: [benched] })).desired).toHaveLength(1);
  });

  test("keys and the newest-halt-per-agent logic ignore case", () => {
    const e1 = haltEvent({ key: "a", agent: "Agent02", at: NOW - 20 * MIN });
    const e2 = haltEvent({ key: "b", agent: "agent02", scenario: "restart-failed", at: NOW - 5 * MIN });
    const out = evaluateRules(input({ events: [e1, e2] }));
    expect(out.desired).toHaveLength(1);
    expect(out.desired[0]?.key).toBe(`agent-stuck|hosta|proja|agent02|restart-failed`);
  });

  test("usage-limit from a snapshot and from an event collapse regardless of case; blocked newer-dispatch check too", () => {
    const limited = snap({ sentAt: NOW - 60_000, agents: [{ name: "Agent01", state: "usage-limit" }] });
    const ev = haltEvent({ scenario: "usage-limit", agent: "AGENT01", at: NOW - 30_000 });
    expect(evaluateRules(input({ events: [ev], snapshots: [limited] })).desired.map((d) => d.key)).toEqual(["usage-limit|hosta|proja|agent01"]);
    const blocked = task({ key: "k1", task_id: "T-old", agent: "Agent01", state: "blocked", created: NOW - 60 * MIN, updated: NOW - 50 * MIN });
    const newer = task({ key: "k2", task_id: "T-new", agent: "agent01", state: "queued", created: NOW - 5 * MIN, updated: NOW - 5 * MIN });
    expect(evaluateRules(input({ tasks: [blocked, newer] })).desired).toEqual([]);
  });
});

describe("alerts that do not come from host agent say so", () => {
  const mcpBlocked = task({ key: "mcp|codex-a|m-1", origin: "mcp", host: "codex-a", project: "proja", agent: "claude@codex-a", task_id: "m-1", state: "blocked", title: "deploy", created: NOW - MIN, updated: NOW - MIN });

  test("inbox text and push body of an MCP or relayed alert end with ' · via <client or host>'", () => {
    const out = evaluateRules(input({ tasks: [mcpBlocked, task({ key: "relay|hosta|proja|@bot:srv", origin: ORIGIN_RELAY, agent: "claude@bot", task_id: "@bot:srv", state: "blocked", last_line: "STATUS: BLOCKED", updated: NOW - MIN })] }));
    const byOrigin = Object.fromEntries(out.desired.map((d) => [d.origin, d]));
    expect(byOrigin.mcp?.text).toBe("proja@codex-a: Blocked: deploy · via codex-a");
    expect(byOrigin[ORIGIN_RELAY]?.text).toBe("proja@hosta: Blocked: STATUS: BLOCKED · via hosta");
    const msg = pushMessage(out.push.find((p) => p.origin === "mcp") as never, "https://x");
    expect(msg.body).toBe("proja@codex-a: claude@codex-a blocked · via codex-a");
    expect(msg.body).not.toContain("deploy");
  });

  test("host-agent alerts carry no suffix, and the suffix survives a long text", () => {
    const own = evaluateRules(input({ tasks: [task({ state: "blocked", last_line: "STATUS: BLOCKED x" })] }));
    expect(own.desired[0]?.text).toBe("proja@hosta: Blocked: STATUS: BLOCKED x");
    expect(pushMessage(own.push[0] as never, "https://x").body).toBe("proja@hosta: agent01 blocked");
    const long = evaluateRules(input({ tasks: [{ ...mcpBlocked, title: "t".repeat(400) }] }));
    expect(long.desired[0]?.text.length).toBeLessThanOrEqual(300);
    expect(long.desired[0]?.text.endsWith(" · via codex-a")).toBe(true);
  });

  test("relayed halt events are labelled too; events default to host agent", () => {
    const relayHalt = haltEvent({ origin: ORIGIN_RELAY, host: "hosta" });
    expect(evaluateRules(input({ events: [relayHalt] })).desired[0]?.text.endsWith(" · via hosta")).toBe(true);
    expect(evaluateRules(input({ events: [haltEvent()] })).desired[0]?.text.endsWith("via hosta")).toBe(false);
  });
});

describe("loader-supplied latest dispatch", () => {
  test("latest_dispatch on the row decides the newer-dispatch rule without the other tasks being listed", () => {
    const blocked = (latest: number | null) => task({ state: "blocked", created: NOW - 60 * MIN, updated: NOW - 50 * MIN, latest_dispatch: latest });
    expect(evaluateRules(input({ tasks: [blocked(NOW - 5 * MIN)] })).desired).toEqual([]);
    expect(evaluateRules(input({ tasks: [blocked(NOW - 60 * MIN)] })).desired).toHaveLength(1);
    expect(evaluateRules(input({ tasks: [blocked(null)] })).desired).toHaveLength(1);
  });
});

describe("agent-stuck", () => {
  test("opens for benched / restart-failed / cli-gone halts and pushes on open", () => {
    for (const scenario of ["benched", "restart-failed", "cli-gone"]) {
      const out = evaluateRules(input({ events: [haltEvent({ scenario })] }));
      expect(out.open).toHaveLength(1);
      expect(out.open[0]).toMatchObject({ rule: "agent-stuck", severity: "critical", agent: "agent02" });
      expect(out.push).toHaveLength(1);
    }
  });

  test("ignores warn-level halts and non-halt events", () => {
    const events = [haltEvent({ scenario: "turn-not-submitted" }), haltEvent({ key: "e2", kind: "status", scenario: "benched" })];
    expect(evaluateRules(input({ events })).desired).toHaveLength(0);
  });

  test("stays open while no newer snapshot exists or the newer one still shows wedged/benched", () => {
    const ev = haltEvent({ at: NOW - 60_000 });
    const older = snap({ sentAt: NOW - 120_000, agents: [{ name: "Agent02", state: "idle" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [older] })).desired).toHaveLength(1);
    const stillBenched = snap({ sentAt: NOW, agents: [{ name: "Agent02", state: "benched" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [stillBenched] })).desired).toHaveLength(1);
    const wedged = snap({ sentAt: NOW, agents: [{ name: "Agent02", state: "wedged" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [wedged] })).desired).toHaveLength(1);
  });

  test("resolves when a newer snapshot shows the agent neither wedged nor benched, and stays resolved", () => {
    const ev = haltEvent({ at: NOW - 60_000 });
    let alerts = applyTo([], evaluateRules(input({ events: [ev] })), NOW - 50_000);
    const healthy = snap({ sentAt: NOW, agents: [{ name: "Agent02", state: "idle" }] });
    const out = evaluateRules(input({ events: [ev], snapshots: [healthy], alerts }));
    expect(out.resolve).toHaveLength(1);
    alerts = applyTo(alerts, out, NOW);
    const again = evaluateRules({ ...input({ events: [ev], snapshots: [healthy], alerts }), now: NOW + MIN });
    expect(again.open).toHaveLength(0); // does not flap back open on the same halt event
  });

  test("an agent missing from the newer snapshot counts as recovered", () => {
    const ev = haltEvent({ at: NOW - 60_000 });
    const s = snap({ sentAt: NOW, agents: [{ name: "Agent01", state: "working" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [s] })).desired).toHaveLength(0);
  });

  test("expires after 6 h", () => {
    const ev = haltEvent({ at: NOW - EVENT_ALERT_TTL_MS - 1 });
    expect(evaluateRules(input({ events: [ev] })).desired).toHaveLength(0);
    const alerts = [{ key: "agent-stuck|hosta|proja|agent02|benched", rule: "agent-stuck", opened: NOW - 6 * 60 * MIN, last_pushed: NOW - 6 * 60 * MIN, push_count: 1, resolved: null }];
    expect(evaluateRules(input({ events: [ev], alerts })).resolve).toHaveLength(1);
  });

  test("a newer halt for the same agent supersedes the older alert", () => {
    const e1 = haltEvent({ key: "e1", scenario: "benched", at: NOW - 20 * MIN });
    const e2 = haltEvent({ key: "e2", scenario: "restart-failed", at: NOW - 5 * MIN });
    const out = evaluateRules(input({ events: [e1, e2] }));
    expect(out.desired).toHaveLength(1);
    expect(out.desired[0]?.key).toContain("restart-failed");
  });
});

describe("usage-limit", () => {
  test("opens from an agent in state usage-limit and resolves when the state clears", () => {
    const limited = snap({ agents: [{ name: "Agent01", state: "usage-limit" }] });
    const out = evaluateRules(input({ snapshots: [limited] }));
    expect(out.open[0]).toMatchObject({ key: "usage-limit|hosta|proja|agent01", rule: "usage-limit" });
    expect(out.push).toHaveLength(1);
    const alerts = applyTo([], out, NOW);
    const cleared = evaluateRules(input({ snapshots: [snap()], alerts }));
    expect(cleared.resolve).toEqual(["usage-limit|hosta|proja|agent01"]);
  });

  test("opens from a usage-limit halt event until a newer snapshot says otherwise", () => {
    const ev = haltEvent({ scenario: "usage-limit", agent: "Agent01", at: NOW - 30_000 });
    const out = evaluateRules(input({ events: [ev] }));
    expect(out.open[0]?.key).toBe("usage-limit|hosta|proja|agent01");
    const newer = snap({ sentAt: NOW, agents: [{ name: "Agent01", state: "working" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [newer] })).desired).toHaveLength(0);
    const stillLimited = snap({ sentAt: NOW, agents: [{ name: "Agent01", state: "usage-limit" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [stillLimited] })).desired).toHaveLength(1);
  });

  test("snapshot state and halt event for the same agent collapse into one alert", () => {
    const ev = haltEvent({ scenario: "usage-limit", agent: "Agent01", at: NOW - 30_000 });
    const s = snap({ sentAt: NOW - 60_000, agents: [{ name: "Agent01", state: "usage-limit" }] });
    expect(evaluateRules(input({ events: [ev], snapshots: [s] })).desired).toHaveLength(1);
  });
});

describe("host-offline", () => {
  test("opens strictly after 6 min without data, pushes once, resolves when the host is seen again", () => {
    expect(evaluateRules(input({ hosts: [{ host: "hosta", last_seen: NOW - 6 * MIN }] })).desired).toHaveLength(0);
    const out = evaluateRules(input({ hosts: [{ host: "hosta", last_seen: NOW - 6 * MIN - 1 }] }));
    expect(out.open[0]).toMatchObject({ key: "host-offline|hosta", rule: "host-offline", project: null, agent: null });
    expect(out.push).toHaveLength(1);

    let alerts = applyTo([], out, NOW);
    const stillOff = evaluateRules({ ...input({ hosts: [{ host: "hosta", last_seen: NOW - 6 * MIN - 1 }], alerts }), now: NOW + 40 * MIN });
    expect(stillOff.push).toHaveLength(0); // on open only
    expect(stillOff.open).toHaveLength(0);

    const back = evaluateRules(input({ hosts: [{ host: "hosta", last_seen: NOW - 1000 }], alerts }));
    expect(back.resolve).toEqual(["host-offline|hosta"]);
    expect(back.push).toHaveLength(0); // resolves silently
    alerts = applyTo(alerts, back, NOW);
    expect(alerts[0]?.resolved).toBe(NOW);
  });
});

describe("overdue", () => {
  const running = (over: Partial<RuleTask> = {}) => task({ updated: NOW - 100 * MIN, eta_at: NOW - 100 * MIN + 60 * MIN, ...over });

  test("opens only after 1.5 x the stated ETA", () => {
    // stated: 60 min at T-100 min. 1.5 x 60 = 90 min after the report -> overdue since T-10 min.
    expect(evaluateRules(input({ tasks: [running()] })).open).toHaveLength(1);
    expect(evaluateRules(input({ tasks: [running({ updated: NOW - 89 * MIN, eta_at: NOW - 89 * MIN + 60 * MIN })] })).open).toHaveLength(0);
    const exactly = running({ updated: NOW - 90 * MIN, eta_at: NOW - 90 * MIN + 60 * MIN });
    expect(evaluateRules(input({ tasks: [exactly] })).open).toHaveLength(0);
  });

  test("ignores tasks that are not running or have no ETA", () => {
    expect(evaluateRules(input({ tasks: [running({ state: "blocked" })] })).desired.filter((d) => d.rule === "overdue")).toHaveLength(0);
    expect(evaluateRules(input({ tasks: [running({ eta_at: null })] })).desired).toHaveLength(0);
    expect(evaluateRules(input({ tasks: [running({ eta_at: NOW - 200 * MIN })] })).desired).toHaveLength(0); // non-positive span
  });

  test("resolves when no longer running; a new ETA resolves the old alert (new key)", () => {
    const t = running();
    const out = evaluateRules(input({ tasks: [t] }));
    const alerts = applyTo([], out, NOW);
    expect(out.push).toHaveLength(1);
    expect(evaluateRules(input({ tasks: [{ ...t, state: "done" }], alerts })).resolve).toHaveLength(1);
    const renewed = { ...t, updated: NOW, eta_at: NOW + 30 * MIN };
    const re = evaluateRules(input({ tasks: [renewed], alerts }));
    expect(re.resolve).toEqual([out.open[0]?.key as string]);
    expect(re.open).toHaveLength(0);
  });
});

describe("idempotence and determinism", () => {
  const busy = () =>
    input({
      snapshots: [
        snap({
          approvals: [{ id: "a", summary: "s", requestedAt: NOW - 10 * MIN }],
          agents: [{ name: "Agent01", state: "usage-limit" }, { name: "Agent02", state: "benched" }],
        }),
      ],
      hosts: [{ host: "gone", last_seen: NOW - 20 * MIN }],
      tasks: [task({ state: "blocked" }), task({ key: "k2", task_id: "T-2", updated: NOW - 100 * MIN, eta_at: NOW - 40 * MIN })],
      events: [haltEvent()],
    });

  test("re-evaluating after applying the output changes nothing", () => {
    const first = evaluateRules(busy());
    expect(first.open.length).toBeGreaterThanOrEqual(6);
    const alerts = applyTo([], first, NOW);
    const second = evaluateRules({ ...busy(), alerts });
    expect(second.open).toEqual([]);
    expect(second.resolve).toEqual([]);
    expect(second.push).toEqual([]);
    expect(second.desired).toEqual(first.desired);
  });

  test("keys follow rule|host|project|agent-or-task and output order is stable", () => {
    const keys = evaluateRules(busy()).desired.map((d) => d.key);
    expect(keys).toEqual([...keys].sort());
    for (const k of keys) expect(k.split("|").length).toBeGreaterThanOrEqual(2);
    expect(keys.some((k) => k.startsWith("approval-waiting|hosta|proja|"))).toBe(true);
    expect(keys.some((k) => k.startsWith("host-offline|gone"))).toBe(true);
  });

  test("resolved rows are ignored when deciding what is open", () => {
    const resolvedRow: RuleAlert = { key: "host-offline|gone", rule: "host-offline", opened: NOW - 1000, last_pushed: NOW - 1000, push_count: 1, resolved: NOW - 500 };
    const out = evaluateRules({ ...busy(), alerts: [resolvedRow] });
    expect(out.open.map((a) => a.key)).toContain("host-offline|gone");
  });
});

describe("push policy + message", () => {
  test("a failed first push is retried only inside the retry window", () => {
    const a = { rule: "blocked", push_count: 0, last_pushed: null, opened: NOW - PUSH_RETRY_WINDOW_MS + 1 };
    expect(pushDue(a, NOW)).toBe(true);
    expect(pushDue({ ...a, opened: NOW - PUSH_RETRY_WINDOW_MS - 1 }, NOW)).toBe(false);
    expect(pushDue({ ...a, push_count: 1 }, NOW)).toBe(false);
  });

  test("body is '<project>@<host>: <agent> <rule words>', never task text; url anchors the alert", () => {
    const m = pushMessage({ key: "blocked|hosta|proja|T-1", rule: "blocked", host: "hosta", project: "proja", agent: "Agent01" }, "https://dash.example.com/");
    expect(m).toEqual({
      title: "Needs you",
      body: "proja@hosta: Agent01 blocked",
      tag: "blocked|hosta|proja|T-1",
      renotify: false, // only critical alerts buzz again when they replace a notification with the same tag
      url: "https://dash.example.com/#alert=blocked%7Chosta%7Cproja%7CT-1",
    });
    expect(pushMessage({ key: "host-offline|hosta", rule: "host-offline", host: "hosta", project: null, agent: null }, "https://x").body).toBe("hosta: host offline");
    expect(pushMessage({ key: "k", rule: "approval-waiting", host: "h", project: "p", agent: null }, "https://x").body).toBe("p@h: action waiting");
  });

  test("the alert text never reaches a push, even when it holds task text", () => {
    const secretish = "STATUS: BLOCKED waiting for the production database password";
    const out = evaluateRules(input({ tasks: [task({ state: "blocked", last_line: secretish })] }));
    expect(out.open[0]?.text).toContain("production database");
    const msg = pushMessage(out.push[0] as never, "https://x");
    expect(JSON.stringify(msg)).not.toContain("database");
  });
});

describe("one notification slot per foreign source (tag) and the summary push", () => {
  test("alerts that do not come from host agent share the tag src:own|<host>; host-agent alerts keep their own key as tag", () => {
    const base = { rule: "blocked" as const, host: "client1", project: "p", agent: "a" };
    const a = pushMessage({ ...base, key: "blocked|client1|p|m-1", origin: "mcp" }, "https://x");
    const b = pushMessage({ ...base, key: "blocked|client1|p|m-2", origin: "mcp" }, "https://x");
    const c = pushMessage({ ...base, key: "blocked|client1|p|m-3", origin: ORIGIN_RELAY }, "https://x");
    expect([a.tag, b.tag, c.tag]).toEqual(["src:own|client1", "src:own|client1", "src:own|client1"]);
    expect(pushMessage({ ...base, host: "hosta", key: "blocked|hosta|p|T-1", origin: ORIGIN_HOST }, "https://x").tag).toBe("blocked|hosta|p|T-1");
    expect(pushMessage({ ...base, host: "hosta", key: "blocked|hosta|p|T-2" }, "https://x").tag).toBe("blocked|hosta|p|T-2");
  });

  test("summary: 'N more items via <source>', singular for one, never any task text, opens the inbox", () => {
    expect(summaryPushMessage("own|client1", 7, "https://dash.example.com/")).toEqual({ title: "Needs you", body: "7 more items via client1", tag: "src:own|client1", renotify: false, url: "https://dash.example.com/" });
    expect(summaryPushMessage("own|hosta", 1, "https://x").body).toBe("1 more item via hosta");
    // the label is worded from the key's kind: critical, relay aggregate, per sender (names with odd characters read back as they were)
    expect(summaryPushMessage("ct|hosta", 2, "https://x").body).toBe("2 more items via hosta (critical)");
    expect(summaryPushMessage("rt|hosta", 2, "https://x").body).toBe("2 more items via hosta / relay");
    expect(summaryPushMessage("rs|hosta|@bot:srv", 2, "https://x").body).toBe("2 more items via hosta / @bot:srv");
  });
});
