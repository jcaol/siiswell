/**
 * @file Push-budget keys: ONE namespace shared by every source, so a key must say what it is and whose it is
 * without any chance that two different (kind, owner, ...) tuples spell the same string.
 * @module dashboard-worker/keys
 *
 * A key is `<kind>|<part>|<part>...` where `kind` is one of the literals below, the number of parts is fixed per
 * kind, and every part is ESCAPED (`%` -> `%25`, `|` -> `%7C`) so that no part can contain the separator. Splitting
 * on `|` therefore gives back exactly the kind and its parts whatever the host label, client name, relay sender or
 * agent name contains, and two different tuples can never produce the same key (the escape is injective, the first
 * segment is always a kind and never a name). The old keys (`host`, `host|sender`, `relay|host`, `crit|host`,
 * `all|owner`) were bare concatenations: a host called `all` with a relay sender `victim` spelled the daily-total
 * key of the client `victim`, and a host called `crit` with the relay sender `relay` spelled the critical budget of
 * the host `relay`, so one source could spend another one's budget.
 *
 * The OWNER (the host label or MCP client name that pays for a key) is stored in its own column and is what the
 * code trusts; the key is never parsed to find it. `decodeBudgetKey` exists only to word a notification.
 */

/** The kinds of budget key. */
export type BudgetKind =
  | "own" // an owner's ordinary pushes (host label or MCP client name)
  | "rs" // one relayed foreign agent (host, sender)
  | "rt" // all relayed senders of a host together
  | "ct" // host-agent critical alerts of a host together
  | "ca" // one critical alert per agent (host, agent)
  | "all" // everything one owner may push per day, summaries included
  | "grp" // round-robin group of an owner's ordinary alerts (not stored)
  | "grc"; // round-robin group of a host's critical alerts (not stored)

/** `%` and `|` escaped: the result contains no `|`, and distinct inputs give distinct outputs. */
export function escapeKeyPart(part: string): string {
  return part.replace(/%/g, "%25").replace(/\|/g, "%7C");
}

export function unescapeKeyPart(part: string): string {
  return part.replace(/%7C/g, "|").replace(/%25/g, "%");
}

/** The key of `kind` for these parts. */
export function budgetKey(kind: BudgetKind, ...parts: string[]): string {
  return [kind, ...parts.map(escapeKeyPart)].join("|");
}

/** How many parts each kind has (the arity that makes the encoding unambiguous). */
const ARITY: Record<BudgetKind, number> = { own: 1, rs: 2, rt: 1, ct: 1, ca: 2, all: 1, grp: 1, grc: 1 };

/** A key taken apart, or null when it is not one of ours. For wording notifications only, never for authorisation. */
export function decodeBudgetKey(key: string): { kind: BudgetKind; parts: string[] } | null {
  const [kind, ...rest] = key.split("|");
  if (kind === undefined || !Object.hasOwn(ARITY, kind) || rest.length !== ARITY[kind as BudgetKind]) return null;
  return { kind: kind as BudgetKind, parts: rest.map(unescapeKeyPart) };
}
