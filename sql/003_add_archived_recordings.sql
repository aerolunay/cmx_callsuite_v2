-- ==================================================
-- Migration: archived_recordings tracking table
-- ==================================================
-- Run this manually against the live database BEFORE deploying the
-- app code that depends on it (backend/routes/archiveRoutes.js).
--
-- This is a PURE tracking table — it does not touch, delete, or
-- modify any existing recording, voicemail, or call log row. It only
-- remembers which recording_key values the local archival script has
-- already successfully copied to local storage, so a scheduled daily
-- run doesn't re-download the same files every time. Nothing in this
-- app deletes from S3 or clears recording_key based on this table —
-- see archiveRoutes.js's own header comment.
--
-- Charset/engine matches this database's existing convention (see
-- cmx_dialer.app_users, cmx_dialer.campaign_dispositions): InnoDB,
-- latin1 / latin1_swedish_ci.
-- ==================================================

CREATE TABLE cmx_dialer.archived_recordings (
  recording_key VARCHAR(500) NOT NULL,
  archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (recording_key)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- Verify afterward:
--   SHOW CREATE TABLE cmx_dialer.archived_recordings\G
