-- ==================================================
-- Migration: "Delete Leads by Phone Number" reason
-- ==================================================
-- Run this manually against the live database when deploying the matching
-- change (Admin -> Leads/Auto-Dial -> Delete Leads by Phone Number). Until
-- it's run, that delete reports this migration is missing and deletes
-- nothing; Clean Up Leads is unaffected.
--
-- Leads an admin deletes by phone number are logged to
-- cmx_dialer.deleted_leads_log like Clean Up Leads, with reason
-- 'MANUAL_DELETE'.
-- ==================================================

ALTER TABLE cmx_dialer.deleted_leads_log
  MODIFY reason ENUM('SCREENING_COMPLETED', 'DNC', 'MANUAL_DELETE') NOT NULL;
