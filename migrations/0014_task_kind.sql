-- A task's kind: one word from a fixed list (coding, debugging, testing, review, research, docs, deploy, ops, other). No free text,
-- so it is kept whatever the text policy says. NULL = the client sent none.
ALTER TABLE tasks ADD COLUMN kind TEXT;
-- Per-client ceiling for task text: none | minimal | brief | full. NULL = use the server default (ACCEPT_TASK_TEXT).
-- Set it with: UPDATE sources SET task_text = 'full' WHERE name = '<client name>';
ALTER TABLE sources ADD COLUMN task_text TEXT;
