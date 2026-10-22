-- One-off: last_line may hold text typed by a person or an agent's reply. The server now drops it by default (ACCEPT_LAST_LINE),
-- so rows stored before that are cleared. The fixed lines the hook and the maintenance job write carry no typed text and are
-- kept: the stale-hook rule matches on them.
UPDATE tasks SET last_line = NULL
 WHERE last_line IS NOT NULL
   AND last_line NOT IN ('reported by the siiswell hook', 'Closed — no activity after the permission prompt', 'Closed — the agent had finished; waiting for input is not a block');

-- Free text of events: relayed agents' status events keep only the fixed label, host halt events a fixed per-kind label
-- (same literals as src/shared/labels.ts). Typed text in the other kinds is not stored by the clients.
UPDATE events SET text = 'Status update' WHERE kind = 'status' AND origin IN ('relay', 'matrix-relay');
UPDATE events SET text = CASE WHEN scenario = 'usage-limit' THEN 'Usage limit reached' ELSE 'Agent may be stuck' END
 WHERE kind = 'halt' AND origin NOT IN ('relay', 'matrix-relay');

-- Open alerts built from that text ("Blocked: <task text>", stuck / limit lines) are resolved rather than rewritten: their
-- text carries a project@host prefix and a "via" suffix that SQL would have to re-create. The rules re-open them on the next
-- evaluation with the new wording (same key, within the 30 min window, so no second push).
UPDATE alerts SET resolved = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE resolved IS NULL AND rule IN ('blocked', 'agent-stuck', 'usage-limit');
