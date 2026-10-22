-- siiswell D1 schema, migration 0007: the human well-being layer (additive).
--
-- wb_settings: small key/value rows. `settings` holds the operator's choices as JSON (time zone, quiet hours, digest interval,
-- nudges on/off), `focus_until` the end of a Focus period, `nudge:<id>` a nudge dismissal ("not today" / "never"), and keys
-- starting with `rt:` the push policy's own bookkeeping (the last digest, the last quiet-hours push per project). Numbers and
-- fixed labels only; no free text from any client is stored here.
--
-- wb_metrics: one generic metric per local hour (`hour` 0-23) or per day (`hour` -1), written by the ticker from the existing
-- tables (alerts, tasks, events, usage_hourly): `active`, `interrupts`, `waiting`, `projects`. WITHOUT ROWID with `day` first:
-- the 7 / 30-day trend is one range seek; the trigger below keeps 90 days.
--
-- alerts.wb_digested: when an alert was folded into a digest push (NULL = not yet). idx_alerts_opened: "alerts opened in the
-- last hour / week" (interrupt load, weekly reflection) is a seek, not a scan.
--
-- DEPLOY: additive. A Worker without it ignores the tables; a Worker with it treats a missing table as "defaults, no policy"
-- (every push behaves as before) until this is applied.
CREATE TABLE wb_settings (
  k        TEXT PRIMARY KEY,
  v        TEXT NOT NULL,
  updated  INTEGER NOT NULL
);

CREATE TABLE wb_metrics (
  day    TEXT NOT NULL,
  hour   INTEGER NOT NULL,
  name   TEXT NOT NULL,
  value  REAL NOT NULL,
  PRIMARY KEY (day, hour, name)
) WITHOUT ROWID;

-- Retention without an extra statement: the first metric row of a new hour (`active` is always written first) removes up to 50
-- rows older than 90 days (the same as usage_hourly), oldest day first.
CREATE TRIGGER wb_metrics_retention AFTER INSERT ON wb_metrics WHEN NEW.name = 'active'
BEGIN
  DELETE FROM wb_metrics WHERE (day, hour, name) IN (SELECT day, hour, name FROM wb_metrics WHERE day < date(NEW.day, '-90 days') ORDER BY day LIMIT 50);
END;

ALTER TABLE alerts ADD COLUMN wb_digested INTEGER;
CREATE INDEX idx_alerts_opened ON alerts (opened);
