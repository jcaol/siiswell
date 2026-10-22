-- The CLI version a source last reported (header X-Siiswell-Client, "0.5.0+abc1234"). NULL = never reported (older CLI, or a host
-- integration that does not send it). Only shown as a small "update available" note on the dashboard.
ALTER TABLE sources ADD COLUMN client_version TEXT;
