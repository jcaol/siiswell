/**
 * @file Per-source budgets as O(1) counters on the `sources` row: MCP mutations (client tokens), host
 * ingest writes (host tokens) and phone pushes (any source).
 * @module dashboard-worker/budget
 *
 * Every budget is claimed with ONE conditional UPDATE of the source's own row (primary-key or unique
 * `name` lookup): reset the fixed window when it has ended, else add to the count, and only while the
 * budget allows it. "Allowed" <=> the statement RETURNED its row (`UPDATE ... RETURNING id`): the logic never
 * reads `meta.changes`, which D1 (and the local runtime) may inflate with rows written by triggers or other
 * side effects. Concurrent claims cannot overshoot, and a spent budget costs one row read and no write,
 * however often the caller retries.
 */
import { stmt } from "./db";

export const DAY_MS = 86_400_000;
/** A push-budget row that is ensured again is only rewritten (its `touched` refreshed) when it is older than this. */
export const PUSH_TOUCH_EVERY_MS = 10 * 60_000;

/**
 * `?1` source id, `?2` now, `?3` window length, `?4` cap, `?5` amount to claim (n >= 1). With `withEval` (`?6` = the
 * evaluation throttle, 0 = none) the same UPDATE also stamps `eval_at` when the last stamp is older than `?6`, and
 * returns it: the request whose stamp equals `now` is the one that may run the rules (see claimHostWrites).
 */
function claimSql(win: string, cnt: string, withEval = false): string {
  return `UPDATE sources SET
    ${win} = CASE WHEN ?2 - ${win} >= ?3 THEN ?2 ELSE ${win} END,
    ${cnt} = CASE WHEN ?2 - ${win} >= ?3 THEN ?5 ELSE ${cnt} + ?5 END${
      withEval ? ",\n    eval_at = CASE WHEN ?6 > 0 AND ?2 - eval_at >= ?6 THEN ?2 ELSE eval_at END" : ""
    }
  WHERE id = ?1 AND (?2 - ${win} >= ?3 OR ${cnt} + ?5 <= ?4)
  RETURNING id${withEval ? ", eval_at" : ""}`;
}

/** Run a claim statement and say whether it took: a row came back (never `meta.changes`, see the header). */
export async function claimedRow(db: D1Database, sql: string, ...params: Array<string | number | null>): Promise<boolean> {
  const res = await stmt(db, sql, ...params).all();
  return (res.results?.length ?? 0) >= 1;
}

/** MCP report_task / update_task calls that change something (client tokens). */
export const SQL_CLAIM_MUTATIONS = claimSql("mut_window_start", "mut_count");
/** Estimated D1 row writes caused by host ingest (host tokens); also stamps the evaluation throttle. */
export const SQL_CLAIM_HOST_WRITES = claimSql("wr_window_start", "wr_count", true);
/**
 * Unconditional charge for writes that have ALREADY happened: the alerts a request OR THE CRON opened or
 * resolved are only known after the rules ran, and each is charged to the host that owns it. `?1` is a JSON
 * array of `{h: host label, n: rows}`, `?2` now, `?3` the window length. Only host tokens are charged (an MCP
 * client's alerts are inside its per-mutation budget). It can push a counter past the cap by one evaluation's
 * worth; the next claim is then refused until the window ends, so churn cannot go on for free.
 */
export const SQL_CHARGE_ALERT_OWNERS = `UPDATE sources SET
    wr_window_start = CASE WHEN ?2 - wr_window_start >= ?3 THEN ?2 ELSE wr_window_start END,
    wr_count = CASE WHEN ?2 - wr_window_start >= ?3
      THEN COALESCE((SELECT SUM(json_extract(value, '$.n')) FROM json_each(?1) WHERE json_extract(value, '$.h') = sources.name), 0)
      ELSE wr_count + COALESCE((SELECT SUM(json_extract(value, '$.n')) FROM json_each(?1) WHERE json_extract(value, '$.h') = sources.name), 0) END
  WHERE kind = 'host' AND name IN (SELECT json_extract(value, '$.h') FROM json_each(?1))`;

/** Give back claimed-but-unused mutations (a batch pre-claims one per mutating call). */
export const SQL_REFUND_MUTATIONS =
  "UPDATE sources SET mut_count = CASE WHEN mut_count >= ?2 THEN mut_count - ?2 ELSE 0 END WHERE id = ?1";

export async function claim(
  db: D1Database,
  sql: string,
  sourceId: string,
  now: number,
  windowMs: number,
  cap: number,
  n: number,
): Promise<boolean> {
  return claimedRow(db, sql, sourceId, now, windowMs, cap, n);
}

/**
 * Claim `n` estimated row writes of a host token's window. `evaluate` says whether this request may run the rule
 * evaluation: `evalEveryMs` <= 0 means the request does not want one (an unchanged snapshot) or no throttle applies
 * (the caller then decides), otherwise it is true for the one request per `evalEveryMs` that stamped `eval_at`.
 */
export async function claimHostWrites(
  db: D1Database,
  sourceId: string,
  now: number,
  cap: number,
  n: number,
  evalEveryMs: number,
): Promise<{ ok: boolean; stamped: boolean }> {
  const res = await stmt(db, SQL_CLAIM_HOST_WRITES, sourceId, now, DAY_MS, cap, n, evalEveryMs).all<{ id: string; eval_at: number }>();
  const row = res.results?.[0];
  return { ok: row !== undefined, stamped: row !== undefined && evalEveryMs > 0 && row.eval_at === now };
}

export async function refundMutations(db: D1Database, sourceId: string, n: number): Promise<void> {
  if (n > 0) await stmt(db, SQL_REFUND_MUTATIONS, sourceId, n).run();
}

/** Seconds until the source's fixed write window ends (for Retry-After); one extra read, only on refusal. */
export async function secondsUntilWindowEnds(db: D1Database, windowColumn: "mut_window_start" | "wr_window_start", sourceId: string, now: number): Promise<number> {
  const row = await stmt(db, `SELECT ${windowColumn} AS w FROM sources WHERE id = ?`, sourceId).first<{ w: number }>();
  const end = (row?.w ?? now) + DAY_MS;
  return Math.max(1, Math.min(86_400, Math.ceil((end - now) / 1000)));
}

/** Critical halt events of a host token: a separate small allowance, claimed when the write budget is spent. */
export const SQL_CLAIM_CRITICAL_HALTS = claimSql("hl_window_start", "hl_count");

/** Sets `budget_until` only when it moves forward: one write per window, however often the source retries. */
export const SQL_MARK_BUDGET_EXHAUSTED = "UPDATE sources SET budget_until = ?2 WHERE id = ?1 AND budget_until < ?2 RETURNING id";

/**
 * A request of this source was just refused for budget. Record it (once per window) so that the rules can
 * show a `budget-exhausted` alert, and answer how long the refusal lasts. A spent budget stays cheap: one
 * read of the window start and, from the second refusal on, no write at all (the `source` row read at
 * authentication already carries `budget_until`).
 */
export async function flagBudgetExhausted(
  db: D1Database,
  windowColumn: "mut_window_start" | "wr_window_start",
  source: { id: string; budget_until: number },
  now: number,
): Promise<{ retryAfter: number; until: number; newlyFlagged: boolean }> {
  const row = await stmt(db, `SELECT ${windowColumn} AS w FROM sources WHERE id = ?`, source.id).first<{ w: number }>();
  const until = (row?.w ?? now) + DAY_MS;
  const retryAfter = Math.max(1, Math.min(86_400, Math.ceil((until - now) / 1000)));
  if (until <= now || source.budget_until >= until) return { retryAfter, until, newlyFlagged: false };
  const newlyFlagged = await claimedRow(db, SQL_MARK_BUDGET_EXHAUSTED, source.id, until);
  source.budget_until = until;
  return { retryAfter, until, newlyFlagged };
}

// ── phone pushes ─────────────────────────────────────────────────────────────
//
// One row of `push_budget` per BUDGET KEY (typed and escaped, see keys.ts and push.ts pushPlan). A push is charged to
// SEVERAL keys at once and must fit ALL of them: its own (a host label / MCP client name `own|owner`, or `rs|host|
// sender` for a relayed foreign agent, or `ct|host` for the host-agent's critical alerts), the aggregates that a source
// cannot dodge by inventing names (`rt|host` over all relay senders, `ca|host|agent` one critical per agent per 30
// min), and the owner's grand total per day (`all|owner`, which summary pushes count towards as well). Every row
// remembers its own limits and its OWNER, so one statement can claim all of them atomically and a summary push
// (which only knows its key) claims under the same rules.

/**
 * `?1` JSON array of {k, o: owner, w: window ms, p: per window, d: per day}, `?2` now: make sure the rows exist
 * with these limits. An existing row keeps its owner (the key spells it, see keys.ts), and is only written when a
 * limit changed or its `touched` is older than 10 minutes: a row that is used is therefore never older than the
 * purge's one-hour grace for rows nobody has claimed yet, which is what keeps the purge from deleting a row between
 * this statement and the claim that follows it.
 */
export const SQL_ENSURE_PUSH_BUDGETS = `INSERT INTO push_budget (k, owner, window_ms, per_window, day_cap, touched)
  SELECT json_extract(value, '$.k'), json_extract(value, '$.o'), json_extract(value, '$.w'), json_extract(value, '$.p'), json_extract(value, '$.d'), ?2
  FROM json_each(?1) WHERE true
  ON CONFLICT(k) DO UPDATE SET window_ms = excluded.window_ms, per_window = excluded.per_window, day_cap = excluded.day_cap, touched = excluded.touched
  WHERE push_budget.window_ms IS NOT excluded.window_ms OR push_budget.per_window IS NOT excluded.per_window
     OR push_budget.day_cap IS NOT excluded.day_cap OR excluded.touched - push_budget.touched >= ${PUSH_TOUCH_EVERY_MS}`;
/**
 * Take one slot from EVERY key of `?1` (a JSON array of key names) or none: the spent-check is a MATERIALIZED
 * sub-query, evaluated once before the first row is updated, so the rows do not see each other's increments.
 * Each key's short window and its day are fixed windows that reset when they have ended. A claim succeeded <=>
 * as many rows came back (RETURNING) as keys were asked for. `?2` now, `?3` day length.
 */
export const SQL_CLAIM_PUSH_SLOTS = `WITH spent AS MATERIALIZED (
    SELECT COUNT(*) AS n FROM push_budget b
     WHERE b.k IN (SELECT value FROM json_each(?1))
       AND ((?2 - b.window_start < b.window_ms AND b.count >= b.per_window) OR (?2 - b.day_start < ?3 AND b.day_count >= b.day_cap))
  )
  UPDATE push_budget SET
    window_start = CASE WHEN ?2 - window_start >= window_ms THEN ?2 ELSE window_start END,
    count        = CASE WHEN ?2 - window_start >= window_ms THEN 1 ELSE count + 1 END,
    day_start    = CASE WHEN ?2 - day_start >= ?3 THEN ?2 ELSE day_start END,
    day_count    = CASE WHEN ?2 - day_start >= ?3 THEN 1 ELSE day_count + 1 END,
    touched      = ?2
  WHERE k IN (SELECT value FROM json_each(?1)) AND (SELECT n FROM spent) = 0
  RETURNING k`;
/** `?2` held-back alerts (owner `?3`, now `?4`): represented by the next summary push. */
export const SQL_SUPPRESS_PUSH =
  "INSERT INTO push_budget (k, owner, suppressed, touched) VALUES (?1, ?3, ?2, ?4) ON CONFLICT(k) DO UPDATE SET suppressed = suppressed + ?2, touched = ?4";
/** Give back one slot of every key of `?1` (a JSON array of key names). */
export const SQL_REFUND_PUSH_SLOTS =
  "UPDATE push_budget SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END, day_count = CASE WHEN day_count > 0 THEN day_count - 1 ELSE 0 END WHERE k IN (SELECT value FROM json_each(?1))";
/**
 * Give back the slot a summary push took AND, when that claim is what started the current window
 * (`?3` = the claim's `now`, count back to 0), restore the previous window start `?2`, so the next
 * cron minute finds the summary due again instead of waiting out a whole new window.
 */
export const SQL_REFUND_SUMMARY_SLOT = `UPDATE push_budget SET
    window_start = CASE WHEN window_start = ?3 AND count <= 1 THEN ?2 ELSE window_start END,
    count        = CASE WHEN count > 0 THEN count - 1 ELSE 0 END,
    day_count    = CASE WHEN day_count > 0 THEN day_count - 1 ELSE 0 END
  WHERE k = ?1`;
/** Take the held-back count for a summary; guarded so two evaluators cannot both send it. */
export const SQL_TAKE_SUPPRESSED = "UPDATE push_budget SET suppressed = 0 WHERE k = ?1 AND suppressed = ?2 RETURNING k";
export const SQL_RESTORE_SUPPRESSED = "UPDATE push_budget SET suppressed = suppressed + ?2 WHERE k = ?1";
/** The budget state of the keys a list of alerts is charged to (primary-key seeks). */
export const SQL_PUSH_BUDGETS =
  "SELECT k, window_start, count, day_start, day_count, touched FROM push_budget WHERE k IN (SELECT value FROM json_each(?1))";
/** Keys owed a summary push: held-back alerts and the key's own window over (partial index idx_push_budget_suppressed). */
export const SQL_PUSH_SUMMARIES_DUE =
  "SELECT k, owner, suppressed, window_start FROM push_budget WHERE suppressed > 0 AND ?1 - window_start >= window_ms ORDER BY window_start LIMIT 10";

/** The limits of one budget key. */
export interface PushLimits {
  windowMs: number;
  perWindow: number;
  dayMs: number;
  perDay: number;
}

/** One budget key of a push: its name, the host label (or client name) that owns it, its limits. */
export interface PushBudgetKey {
  key: string;
  owner: string;
  limits: PushLimits;
}

/** Make sure the rows of `keys` exist (carrying their limits). A row that is already right and recently touched is not written. */
export async function ensurePushBudgets(db: D1Database, keys: PushBudgetKey[], now: number): Promise<void> {
  if (!keys.length) return;
  await stmt(db, SQL_ENSURE_PUSH_BUDGETS, JSON.stringify(keys.map((b) => ({ k: b.key, o: b.owner, w: b.limits.windowMs, p: b.limits.perWindow, d: b.limits.perDay }))), now).run();
}

/**
 * Claim one slot of EVERY key (all or nothing, ONE statement, see SQL_CLAIM_PUSH_SLOTS). The rows must exist
 * (ensurePushBudgets). Returns false when any key is spent; a claim that took only some rows (a row purged in
 * between) gives those back.
 */
export async function claimPushSlots(db: D1Database, keys: string[], now: number): Promise<boolean> {
  const res = await stmt(db, SQL_CLAIM_PUSH_SLOTS, JSON.stringify(keys), now, DAY_MS).all<{ k: string }>();
  const got = res.results?.map((r) => r.k) ?? [];
  if (got.length === keys.length) return true;
  if (got.length) await stmt(db, SQL_REFUND_PUSH_SLOTS, JSON.stringify(got)).run();
  return false;
}

/** A budget row says the key is spent right now (window still open and used up, or the day cap reached). */
export function pushBudgetSpent(row: { window_start: number; count: number; day_start: number; day_count: number }, now: number, l: PushLimits): boolean {
  return (now - row.window_start < l.windowMs && row.count >= l.perWindow) || (now - row.day_start < l.dayMs && row.day_count >= l.perDay);
}
