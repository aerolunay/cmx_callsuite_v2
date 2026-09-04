-- ==================================================
-- Migration: per-campaign custom dispositions
-- ==================================================
-- Run this manually against the live database BEFORE deploying the
-- app code that depends on it (backend/services/
-- campaignDispositionService.js and everything that calls it). The
-- app will 500 on any dispositions save/read for a campaign until
-- this has been applied — GET requests fail open (see
-- dialerRoutes.js's own comment on its /dialer/campaigns/:id/
-- dispositions route), but the admin PUT route will error until
-- these exist.
--
-- Charset/engine matches this database's existing convention (see
-- cmx_dialer.app_users: InnoDB, latin1 / latin1_swedish_ci) — kept
-- consistent rather than defaulting to utf8mb4, to avoid a mismatched
-- join/comparison collation against the other cmx_dialer tables this
-- new table sits alongside.
--
-- Safe to run more than once accidentally? No — re-running this
-- as-is against a database where it already succeeded will error on
-- the duplicate column/table (MySQL has no built-in "ADD COLUMN IF
-- NOT EXISTS" prior to 8.0.29 / MariaDB equivalents vary). Check
-- first with:
--   SHOW COLUMNS FROM cmx_dialer.campaign_settings LIKE 'custom_%';
--   SHOW TABLES FROM cmx_dialer LIKE 'campaign_dispositions';
-- before applying, if unsure whether this has already been run.
-- ==================================================

-- 1. Two on/off switches, one per direction, living in
--    campaign_settings alongside every other campaign-level toggle in
--    this app (voicemail_business_hours_enabled,
--    voicemail_afterhours_enabled, etc.) — default 'N' so every
--    existing campaign keeps using the generic list exactly as today
--    until an admin explicitly opts one in via Admin -> Campaigns ->
--    Dispositions.
ALTER TABLE cmx_dialer.campaign_settings
  ADD COLUMN custom_inbound_dispositions_enabled  ENUM('Y','N') NOT NULL DEFAULT 'N' AFTER outbound_trunk,
  ADD COLUMN custom_outbound_dispositions_enabled ENUM('Y','N') NOT NULL DEFAULT 'N' AFTER custom_inbound_dispositions_enabled;

-- 2. The actual custom rows, one per (campaign_id, direction, value).
--    Kept in its own table rather than a JSON column on
--    campaign_settings so each row has its own identity for a clean
--    delete-then-reinsert-in-order save (see
--    campaignDispositionService.js's saveCampaignDispositions).
--    UNIQUE on (campaign_id, direction, value) prevents two rows
--    silently colliding on the same stored disposition value within
--    one campaign+direction — enforced at the DB layer as a backstop
--    to the app-level de-dupe already done in
--    campaignDispositionService.js's normalizeRows.
CREATE TABLE cmx_dialer.campaign_dispositions (
  campaign_disposition_id INT NOT NULL AUTO_INCREMENT,
  campaign_id VARCHAR(50) NOT NULL,
  direction ENUM('INBOUND','OUTBOUND') NOT NULL,
  value VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_disposition_id),
  UNIQUE KEY uniq_campaign_direction_value (campaign_id, direction, value),
  KEY idx_campaign_direction (campaign_id, direction)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- Verify afterward:
--   SHOW CREATE TABLE cmx_dialer.campaign_settings\G
--   SHOW CREATE TABLE cmx_dialer.campaign_dispositions\G
-- Expect to see the two new ENUM columns on campaign_settings, and
-- the new campaign_dispositions table with the unique key above.
