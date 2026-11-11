-- ==================================================
-- Migration: widen the call logs' disposition columns
-- ==================================================
-- REAL BUG FIX, confirmed live — dialer_call_log.disposition and
-- inbound_call_log.disposition were VARCHAR(30), but a campaign's custom
-- disposition codes (cmx_dialer.campaign_dispositions.value) can be up to
-- 100 characters. CMXBSMOB's "Eligibility Assessment Completed"
-- (ELIGIBILITY_ASSESSMENT_COMPLETED, 32 characters) failed every time with
-- "Data too long for column 'disposition'" and was never saved.
--
-- Widened to VARCHAR(100), the same as campaign_dispositions.value, so any
-- code an admin can create also fits in the call logs. Existing values and
-- indexes are unchanged; the character set stays latin1 (the indexed
-- comparisons elsewhere depend on it — see leadEligibility.js). Run
-- manually when deploying; it takes seconds.
-- ==================================================

ALTER TABLE cmx_dialer.dialer_call_log
  MODIFY disposition VARCHAR(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL;
ALTER TABLE cmx_dialer.inbound_call_log
  MODIFY disposition VARCHAR(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL;
