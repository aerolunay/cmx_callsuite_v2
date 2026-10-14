-- ==================================================
-- Migration: call log phone-number indexes
-- ==================================================
-- Run this manually against the live database BEFORE deploying the
-- matching backend change. getNextLead (backend/services/dialerService.js)
-- now skips any lead whose phone number was ever disposed as Screening
-- Completed, Call Ended, Not Interested or DNC in either call log. That
-- check runs on every "next lead" pull, so both logs need an index on
-- (phone number, disposition) or it scans the whole table each time.
--
-- If MySQL reports "Duplicate key name", that index already exists —
-- skip that statement.
-- ==================================================

CREATE INDEX idx_phone_disposition ON cmx_dialer.dialer_call_log (phone_number, disposition);

CREATE INDEX idx_caller_disposition ON cmx_dialer.inbound_call_log (caller_id_number, disposition);

-- Verify afterward:
--   SHOW INDEX FROM cmx_dialer.dialer_call_log WHERE Key_name = 'idx_phone_disposition';
--   SHOW INDEX FROM cmx_dialer.inbound_call_log WHERE Key_name = 'idx_caller_disposition';
