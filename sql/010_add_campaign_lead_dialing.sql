-- ==================================================
-- Migration: pause / start lead dialing per campaign
-- ==================================================
-- Run this manually against the live database when deploying the matching
-- change (Admin -> Leads/Auto-Dial -> Lead Dialing). Until it's run, every
-- campaign simply counts as "not paused" (dialing works as before) and the
-- Pause button reports that this migration is missing.
--
-- One row per campaign that has ever been paused or started from the admin
-- screen; no row = not paused. Pausing only stops leads being handed out
-- (Dial Next Number / Auto Dial) — manual dials and callbacks still work.
-- ==================================================

CREATE TABLE IF NOT EXISTS cmx_dialer.campaign_lead_dialing (
  campaign_id VARCHAR(20) NOT NULL,
  paused TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by_app_user_id INT DEFAULT NULL,
  PRIMARY KEY (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verify afterward:
--   SHOW CREATE TABLE cmx_dialer.campaign_lead_dialing;
