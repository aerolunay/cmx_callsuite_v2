-- ==================================================
-- Migration: recording_archived_at
-- ==================================================
-- Run this manually against the live database. Adds one nullable
-- column to each of the three tables that can have a recording, so
-- the app can tell "never had a recording" apart from "had one, now
-- archived to local storage and removed from S3" — previously both
-- looked identical (recording_key simply NULL either way).
--
-- Written by the local archival script (archive_recordings.py) at
-- the exact same moment it clears recording_key — see that script's
-- own cleanup_db() function. Nothing else in this app writes to this
-- column.
--
-- Charset/engine matches this database's existing convention.
-- ==================================================

ALTER TABLE cmx_dialer.dialer_call_log
  ADD COLUMN recording_archived_at TIMESTAMP NULL DEFAULT NULL;

ALTER TABLE cmx_dialer.inbound_call_log
  ADD COLUMN recording_archived_at TIMESTAMP NULL DEFAULT NULL;

ALTER TABLE cmx_dialer.voicemail_log
  ADD COLUMN recording_archived_at TIMESTAMP NULL DEFAULT NULL;

-- Verify afterward:
--   SHOW COLUMNS FROM cmx_dialer.dialer_call_log LIKE 'recording_archived_at';
--   SHOW COLUMNS FROM cmx_dialer.inbound_call_log LIKE 'recording_archived_at';
--   SHOW COLUMNS FROM cmx_dialer.voicemail_log LIKE 'recording_archived_at';
