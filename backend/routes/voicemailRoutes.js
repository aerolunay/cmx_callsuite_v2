"use strict";

const express = require("express");
const db = require("../config/db");
const recordingUploadService = require("../services/recordingUploadService");
const { requireRoles, getAssignedCampaignIds } = require("../services/accessControlService");
const statsService = require("../services/statsService");

const router = express.Router();

/*
==================================================
VOICEMAIL REVIEW — access rule, deliberately SEPARATE from
accessControlService's shared UNRESTRICTED_CAMPAIGN_ROLES
==================================================
Per explicit request, this feature's access matrix does NOT match the
general one (see accessControlService.js's own documented matrix):
  supervisor       -> filtered to assigned campaigns
  account_manager   -> filtered to assigned campaigns
  training_quality -> filtered to assigned campaigns (same as
                        Recordings — no divergence here after all)
  admin             -> ALL campaigns
  wfm               -> NO access at all (WFM's role is queue
                        monitoring, not voicemail review, per explicit
                        request)

Reusing accessControlService's requireCampaignAccess/
UNRESTRICTED_CAMPAIGN_ROLES as-is would still get the wfm case wrong
(wfm would incorrectly gain access via requireRoles alone if included
there at all) — so this file defines its own small, self-contained
version instead, rather than changing the shared constant and risking
an unintended access change to Live Dashboard/Recordings/Reports, none
of which were asked for here.
==================================================
*/
const VOICEMAIL_ROLES = ["supervisor", "account_manager", "training_quality", "admin"];
// wfm ADDED — per explicit request, WFM can now view the Live Status
// Dashboard's own Voicemails card (see the manual role check on
// GET /voicemails below, which is the ONLY route wfm can actually
// reach — every other voicemail route below still uses
// requireRoles(...VOICEMAIL_ROLES), unchanged, which never included
// wfm and still doesn't). Adding wfm here gives it the SAME
// unrestricted, all-campaign treatment admin already gets — matches
// how wfm is already treated everywhere else in this app (e.g.
// LiveStatusDashboard.jsx's own isUnrestrictedCampaignAccess check) —
// rather than requiring wfm to have individual
// agent_campaign_assignments rows, which it was never meant to need.
const VOICEMAIL_UNRESTRICTED_ROLES = ["admin", "wfm"];

async function requireVoicemailCampaignAccess(req, res, next) {
  const { accessLevel, appUserId } = req.session.agent;

  if (VOICEMAIL_UNRESTRICTED_ROLES.includes(accessLevel)) {
    return next();
  }

  try {
    const assignedIds = await getAssignedCampaignIds(appUserId);
    req.accessibleCampaignIds = assignedIds;

    const { campaignId } = req.query;
    if (!campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId is required for this role — select one of your assigned campaigns.",
      });
    }
    if (!assignedIds.includes(campaignId)) {
      return res.status(403).json({ success: false, message: "You are not assigned to that campaign." });
    }

    return next();
  } catch (error) {
    console.error("[voicemailRoutes] requireVoicemailCampaignAccess failed:", error);
    return res.status(500).json({ success: false, message: "Failed to verify campaign access." });
  }
}

// Shared per-row ownership check for the :voicemailLogId routes below
// (playback-url, download-url, and the single-record fetch) — these
// take a path param, not a ?campaignId query param, so
// requireVoicemailCampaignAccess (built for the list route) doesn't
// apply directly; the campaign this specific voicemail belongs to has
// to come from the DB row itself first. Mirrors dialerRoutes.js's own
// manual check on its equivalent recordings routes.
async function checkVoicemailOwnership(req, res, campaignId) {
  const { accessLevel, appUserId } = req.session.agent;
  if (VOICEMAIL_UNRESTRICTED_ROLES.includes(accessLevel)) return true;

  const assignedIds = await getAssignedCampaignIds(appUserId);
  if (!assignedIds.includes(campaignId)) {
    res.status(403).json({ success: false, message: "You are not assigned to that campaign." });
    return false;
  }
  return true;
}

/*
==================================================
GET /api/voicemails/campaigns
==================================================
Narrow, purpose-built helper — ONLY for populating the "All Campaigns"
filter dropdown for admin, the sole unrestricted role. Deliberately
NOT reusing GET /api/admin/campaigns — that route is gated to
admin/wfm only (see campaignRoutes.js's requireAdmin) and exposes far
more than a name/id pair, most of which is unrelated to this page.
Every other voicemail-viewing role already has GET /campaigns/mine
for their own scoped dropdown.

Registered BEFORE the /:voicemailLogId routes below — Express matches
route definitions in order, and "campaigns" would otherwise be
swallowed by :voicemailLogId as if it were an id.
==================================================
*/
router.get("/voicemails/campaigns", requireRoles(...VOICEMAIL_UNRESTRICTED_ROLES), async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT campaign_id, campaign_name FROM asterisk.vicidial_campaigns WHERE active = 'Y' ORDER BY campaign_id ASC`
    );
    return res.json({ success: true, campaigns: rows });
  } catch (error) {
    console.error("GET /api/voicemails/campaigns failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load campaigns." });
  }
});

/*
==================================================
GET /api/voicemails
==================================================
List, with optional startDate/endDate/campaignId filters — same shape
as GET /api/recordings. Does NOT return a playback URL directly (same
reasoning as recordings — presigned S3 URLs are time-limited, so
generating one per row on every list load would be wasteful); the
frontend calls the dedicated playback-url route below, on demand, only
when a row's Play button is actually clicked.
==================================================
*/
router.get(
  "/voicemails",
  (req, res, next) => {
    const { accessLevel } = req.session.agent;
    const { window } = req.query;
    // Manual role check, REPLACING requireRoles(...VOICEMAIL_ROLES)
    // directly on this ONE route — per explicit request, wfm can view
    // the Live Dashboard's own dashboard-scoped voicemail card
    // (?window=dashboard), but gains no access to anything else
    // voicemail-related: the standalone VoicemailsPage.jsx never sends
    // that flag at all, so its own request pattern is still fully
    // blocked for wfm here, and every OTHER voicemail route below
    // (playback-url, download-url, single-record fetch, the new
    // status-update route) still uses the completely untouched
    // requireRoles(...VOICEMAIL_ROLES) check, which never included wfm
    // and still doesn't.
    const isWfmDashboardRequest = accessLevel === "wfm" && window === "dashboard";
    if (!VOICEMAIL_ROLES.includes(accessLevel) && !isWfmDashboardRequest) {
      return res.status(403).json({ success: false, message: "Access denied for this role." });
    }
    return next();
  },
  requireVoicemailCampaignAccess,
  async (req, res) => {
  try {
    const { startDate, endDate, campaignId, window } = req.query;

    const params = [];
    let dateFilter = "";
    // NEW — per explicit request: the Live Status Dashboard's own
    // Voicemails card passes ?window=dashboard to get a specific
    // computed window ("5 PM yesterday through now" — see
    // statsService.getVoicemailDashboardWindowForServerClock), taking
    // priority over any explicit startDate/endDate. The standalone
    // VoicemailsPage.jsx never sends this flag at all, so its own
    // explicit-date-or-show-everything behavior is completely
    // unaffected either way.
    if (window === "dashboard") {
      const { start, end } = await statsService.getVoicemailDashboardWindowForServerClock();
      dateFilter = " AND vl.left_at >= ? AND vl.left_at <= ?";
      params.push(start, end);
    } else {
      if (startDate) {
        dateFilter += " AND vl.left_at >= ?";
        params.push(`${startDate} 00:00:00`);
      }
      if (endDate) {
        dateFilter += " AND vl.left_at <= ?";
        params.push(`${endDate} 23:59:59`);
      }
    }

    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = " AND vl.campaign_id = ?";
      params.push(campaignId);
    }

    const [rows] = await db.execute(
      `
        SELECT
          vl.voicemail_log_id, vl.campaign_id, c.campaign_name, vl.caller_id_number,
          vl.call_started_at, vl.left_at, vl.duration_seconds, vl.recording_key, vl.status,
          vl.is_after_hours, vl.reviewed, vl.reviewed_by, vl.reviewed_at, vl.created_at
        FROM cmx_dialer.voicemail_log vl
        LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = vl.campaign_id
        WHERE 1=1 ${dateFilter} ${campaignFilter}
        ORDER BY vl.left_at DESC
        LIMIT 200
      `,
      params
    );

    return res.json({ success: true, voicemails: rows });
  } catch (error) {
    console.error("GET /api/voicemails failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load voicemails." });
  }
});

/*
==================================================
GET /api/voicemails/:voicemailLogId
==================================================
Single-record fetch — used by the standalone email-linked player page
(VoicemailPlayerPage.jsx), which doesn't have a filtered list to pull
metadata from the way the main Voicemails page does. Same ownership
check as playback-url/download-url below.
==================================================
*/
router.get("/voicemails/:voicemailLogId", requireRoles(...VOICEMAIL_ROLES), async (req, res) => {
  try {
    const { voicemailLogId } = req.params;

    const [rows] = await db.execute(
      `
        SELECT
          vl.voicemail_log_id, vl.campaign_id, c.campaign_name, vl.caller_id_number,
          vl.call_started_at, vl.left_at, vl.duration_seconds, vl.is_after_hours
        FROM cmx_dialer.voicemail_log vl
        LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = vl.campaign_id
        WHERE vl.voicemail_log_id = ?
      `,
      [voicemailLogId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Voicemail not found." });
    }

    const ok = await checkVoicemailOwnership(req, res, rows[0].campaign_id);
    if (!ok) return; // response already sent by checkVoicemailOwnership

    return res.json({ success: true, voicemail: rows[0] });
  } catch (error) {
    console.error(`GET /api/voicemails/${req.params.voicemailLogId} failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to load voicemail." });
  }
});

/*
==================================================
GET /api/voicemails/:voicemailLogId/playback-url
==================================================
Generates a fresh, 1-hour presigned URL on demand — same mechanism as
recordings' own playback-url route. Used by BOTH the main Voicemails
list page (Play button) and the standalone email-linked player page —
the latter calling this on every page load is exactly why the emailed
link itself never goes stale even though the presigned URL underneath
it does.
==================================================
*/
router.get("/voicemails/:voicemailLogId/playback-url", requireRoles(...VOICEMAIL_ROLES), async (req, res) => {
  try {
    const { voicemailLogId } = req.params;

    const [rows] = await db.execute(
      `SELECT recording_key, campaign_id FROM cmx_dialer.voicemail_log WHERE voicemail_log_id = ?`,
      [voicemailLogId]
    );

    if (!rows.length || !rows[0].recording_key) {
      return res.status(404).json({ success: false, message: "No recording found for this voicemail." });
    }

    const ok = await checkVoicemailOwnership(req, res, rows[0].campaign_id);
    if (!ok) return;

    const url = await recordingUploadService.getPlaybackUrl(rows[0].recording_key);
    return res.json({ success: true, url });
  } catch (error) {
    console.error(`GET /api/voicemails/${req.params.voicemailLogId}/playback-url failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to generate playback URL." });
  }
});

/*
==================================================
PATCH /api/voicemails/:voicemailLogId/status
==================================================
NEW — per explicit request: show (and let supervisor/account_manager/
training_quality/admin actually update) whether a voicemail's been
attended to, directly from this standalone page AND the Live Status
Dashboard's own Voicemails card. This is the SAME New/Resolved/
Unreachable/Left VM status already tracked via dialerRoutes.js's own
agent-facing PATCH /dialer/voicemail/:id/status (DialerPage's
Abandoned & Voicemail tab) — same column, same allowed values — just
a second, separately-scoped route for these non-agent roles, using
THIS file's own existing checkVoicemailOwnership helper (campaign-
scoped for supervisor/account_manager/training_quality, unrestricted
for admin) instead of dialerRoutes.js's agent-assignment-based check,
which doesn't apply to these roles at all.

Deliberately uses the UNCHANGED requireRoles(...VOICEMAIL_ROLES) here
— wfm does NOT get this. Per explicit request, wfm can only VIEW the
dashboard's voicemail card; updating status is a step further than
"view calls," so it stays out of scope for wfm specifically.
==================================================
*/
const VOICEMAIL_STATUSES = ["NEW", "RESOLVED", "UNREACHABLE", "LEFT_VM"];

router.patch("/voicemails/:voicemailLogId/status", requireRoles(...VOICEMAIL_ROLES), async (req, res) => {
  try {
    const { voicemailLogId } = req.params;
    const { status } = req.body;

    if (!VOICEMAIL_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${VOICEMAIL_STATUSES.join(", ")}.` });
    }

    const [rows] = await db.execute(`SELECT campaign_id FROM cmx_dialer.voicemail_log WHERE voicemail_log_id = ?`, [
      voicemailLogId,
    ]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Voicemail not found." });
    }

    const ok = await checkVoicemailOwnership(req, res, rows[0].campaign_id);
    if (!ok) return; // response already sent by checkVoicemailOwnership

    await db.execute(`UPDATE cmx_dialer.voicemail_log SET status = ? WHERE voicemail_log_id = ?`, [
      status,
      voicemailLogId,
    ]);

    return res.json({ success: true, status });
  } catch (error) {
    console.error(`PATCH /api/voicemails/${req.params.voicemailLogId}/status failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to update voicemail status." });
  }
});

/*
==================================================
GET /api/voicemails/:voicemailLogId/download-url
==================================================
Admin-only, per explicit request — mirrors recordings' own
download-url route exactly, including the same admin-only narrowing
(every other voicemail-viewing role can still play, just not download).
==================================================
*/
router.get("/voicemails/:voicemailLogId/download-url", requireRoles("admin"), async (req, res) => {
  try {
    const { voicemailLogId } = req.params;

    const [rows] = await db.execute(
      `SELECT recording_key, campaign_id, caller_id_number FROM cmx_dialer.voicemail_log WHERE voicemail_log_id = ?`,
      [voicemailLogId]
    );

    if (!rows.length || !rows[0].recording_key) {
      return res.status(404).json({ success: false, message: "No recording found for this voicemail." });
    }

    const filename = `voicemail-${voicemailLogId}-${rows[0].caller_id_number || "unknown"}.wav`;
    const url = await recordingUploadService.getDownloadUrl(rows[0].recording_key, filename);
    return res.json({ success: true, url });
  } catch (error) {
    console.error(`GET /api/voicemails/${req.params.voicemailLogId}/download-url failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to generate download URL." });
  }
});

module.exports = router;