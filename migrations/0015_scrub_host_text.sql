-- One-off: the server now limits the free text of host snapshots and events (ACCEPT_HOST_TEXT, default minimal). A host's task
-- titles can be the operator's own request text, so rows stored before are replaced by the same neutral labels the server now
-- writes (literals match src/shared/labels.ts and src/shared/hosttext.ts). Tasks reported through the MCP endpoint (client
-- tasks, origin 'mcp') and relayed agents are not touched: their text is already governed by ACCEPT_TASK_TEXT / ACCEPT_LAST_LINE.
-- Ids, states, ETAs, agents and projects are kept. Idempotent. A deployment that chooses ACCEPT_HOST_TEXT=full or brief simply
-- receives new text again from the next snapshot. The legacy origin value is spelled in pieces (see 0004).
UPDATE tasks
   SET title = CASE WHEN agent IS NULL OR agent = '' THEN 'Task' ELSE 'Task for ' || substr(agent, 1, 32) END
 WHERE origin IN ('host', 't' || 'mux-orch');

UPDATE tasks SET last_line = NULL
 WHERE origin IN ('host', 't' || 'mux-orch')
   AND last_line IS NOT NULL
   AND last_line NOT IN ('reported by the siiswell hook', 'Closed — no activity after the permission prompt', 'Closed — the agent had finished; waiting for input is not a block');

UPDATE events SET text = 'Approval pending'  WHERE kind = 'approval'  AND origin IN ('host', 't' || 'mux-orch');
UPDATE events SET text = 'Lifecycle update'  WHERE kind = 'lifecycle' AND origin IN ('host', 't' || 'mux-orch');
UPDATE events SET text = 'Status update'    WHERE kind = 'status'    AND origin IN ('host', 't' || 'mux-orch');

-- Approval summaries and discussion topics live in the stored snapshot JSON (tasks are rows of the tasks table).
UPDATE snapshots
   SET json = json_set(json, '$.approvals', json((SELECT json_group_array(json_set(value, '$.summary', 'Approval pending')) FROM json_each(snapshots.json, '$.approvals'))))
 WHERE json_valid(json) AND json_type(json, '$.approvals') = 'array';
UPDATE snapshots
   SET json = json_set(json, '$.discussions', json((SELECT json_group_array(json_set(value, '$.topic', '')) FROM json_each(snapshots.json, '$.discussions'))))
 WHERE json_valid(json) AND json_type(json, '$.discussions') = 'array';

-- Open alerts built from that text ("Blocked: <title>", "Overdue: <title>", "Action waiting: <summary>") are resolved rather than
-- rewritten; the rules re-open them with the new wording on the next evaluation (same key, so no second push).
UPDATE alerts SET resolved = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE resolved IS NULL AND rule IN ('blocked', 'overdue', 'approval-waiting') AND origin IN ('host', 't' || 'mux-orch');

-- Host halt events keep only the fixed per-scenario label (as 0012 did for events stored at the time; later rows may differ).
UPDATE events SET text = CASE WHEN scenario = 'usage-limit' THEN 'Usage limit reached' ELSE 'Agent may be stuck' END
 WHERE kind = 'halt' AND origin IN ('host', 't' || 'mux-orch');

-- Stored alert text (open AND resolved) of the rules built from host task / approval text becomes a fixed per-rule text.
-- The structural rules (host-offline, project-offline, budget-exhausted, ...) are built from identifiers only and are kept.
UPDATE alerts SET text = CASE rule
    WHEN 'blocked' THEN 'Blocked: task'
    WHEN 'overdue' THEN 'Overdue: task'
    WHEN 'approval-waiting' THEN 'Approval pending'
    WHEN 'agent-stuck' THEN 'Agent may be stuck'
    ELSE 'Usage limit reached' END
 WHERE rule IN ('blocked', 'overdue', 'approval-waiting', 'agent-stuck', 'usage-limit') AND origin IN ('host', 't' || 'mux-orch');
