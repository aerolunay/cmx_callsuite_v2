-- ==================================================
-- Migration: abandon_reason
-- ==================================================
-- Run this manually against the live database. Adds one column that
-- distinguishes two previously-identical-looking scenarios in
-- abandoned_call_log:
--   - NEVER_MATCHED: the caller hung up before ANY agent was ever
--     paged. Genuinely nobody available.
--   - AGENT_RINGING_NO_ANSWER: a real agent WAS matched and their
--     phone WAS actively ringing when the caller hung up. Someone was
--     right there, about to answer — not a staffing failure.
--
-- Existing rows will have NULL here (there's no way to reconstruct
-- which one happened after the fact — the distinguishing signal,
-- previousStatus, only ever existed in memory at the moment each call
-- was originally recorded). Only rows recorded AFTER this migration
-- + the matching code deploy will have a real value.
--
-- Written by backend/services/inboundCallService.js's own
-- recordAbandonedCall — nothing else in this app writes to this
-- column.
-- ==================================================

ALTER TABLE cmx_dialer.abandoned_call_log
  ADD COLUMN abandon_reason ENUM('NEVER_MATCHED', 'AGENT_RINGING_NO_ANSWER') NULL DEFAULT NULL;

-- Verify afterward:
--   SHOW COLUMNS FROM cmx_dialer.abandoned_call_log LIKE 'abandon_reason';
