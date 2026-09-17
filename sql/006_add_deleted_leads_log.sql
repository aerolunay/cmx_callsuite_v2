-- ==================================================
-- 006_add_deleted_leads_log.sql
-- ==================================================
-- Supports the new "Clean Up Leads" admin action (leadRoutes.js) —
-- automatically removes leads whose phone_number is either:
--   (a) tagged SCREENING_COMPLETED in cmx_dialer.dialer_call_log OR
--       cmx_dialer.inbound_call_log, or
--   (b) present in asterisk.vicidial_dnc
--
-- A PERMANENT audit table, not a one-off timestamped backup like the
-- manual SQL scripts used earlier for the CMXBSCSR/CMXBSMOB merge —
-- this cleanup is meant to run repeatedly over time (an admin can
-- click it whenever), so every run appends here rather than each run
-- needing its own uniquely-named backup table. Gives a lasting,
-- queryable "what got removed and why" trail, and is the one place to
-- look if a lead's disappearance is ever questioned later.
-- ==================================================

CREATE TABLE IF NOT EXISTS cmx_dialer.deleted_leads_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  lead_id BIGINT NOT NULL,
  list_id BIGINT NOT NULL,
  campaign_id VARCHAR(20) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  first_name VARCHAR(100) DEFAULT NULL,
  last_name VARCHAR(100) DEFAULT NULL,
  -- 'DNC' takes priority when a number matches both reasons — see
  -- leadRoutes.js's own comment on why.
  reason ENUM('SCREENING_COMPLETED', 'DNC') NOT NULL,
  deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_by_app_user_id INT DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_phone_number (phone_number),
  KEY idx_campaign_id (campaign_id),
  KEY idx_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
