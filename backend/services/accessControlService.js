"use strict";

const db = require("../config/db");

/*
==================================================
ACCESS CONTROL — role gating + campaign scoping
==================================================
Centralizes the access-level matrix agreed for this app, rather than
having each route file invent its own one-off requireAdmin/
requireAdminOrSupervisor-style middleware (which is exactly what
happened before this file existed — dialerRoutes.js's
requireAdminOrSupervisor and adminRoutes.js's requireAdmin were two
separate, hand-written checks with no shared source of truth).

ROLE MATRIX (as specified):
  agent             -> Dialer Page only. Own campaign assignments.
  supervisor        -> Dialer, Live Dashboard, Recordings, Reports.
                        Filtered to assigned campaigns.
  training_quality  -> Dialer, Live Dashboard, Recordings.
                        Filtered to assigned campaigns.
  account_manager   -> Live Dashboard, Recordings, Reports.
                        Filtered to assigned campaigns.
  wfm               -> Live Dashboard, Reports, Admin. ALL campaigns.
  admin             -> Live Dashboard, Reports, Recordings, Admin.
                        ALL campaigns.

"ALL campaigns" (wfm/admin) means these two roles may omit campaignId
entirely (true "All Campaigns" view) or pass any real campaignId.
Every other role MUST pass a campaignId, and it MUST be one they're
actually assigned to — enforced here, not just hidden in the frontend
dropdown, since a request can always be sent directly regardless of
what the UI shows.
==================================================
*/

const UNRESTRICTED_CAMPAIGN_ROLES = ["admin", "wfm"];

/*
requireRoles(...roles) — generic replacement for the old one-off
requireAdmin/requireAdminOrSupervisor middlewares. Use like:
  router.get("/x", requireRoles("admin", "wfm"), handler)
*/
function requireRoles(...allowedRoles) {
  return function (req, res, next) {
    if (!req.session || !req.session.authenticated || !req.session.agent) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    if (!allowedRoles.includes(req.session.agent.accessLevel)) {
      return res.status(403).json({ success: false, message: "You don't have access to this." });
    }
    return next();
  };
}

/*
getAssignedCampaignIds(appUserId) -> string[]
Real campaign_ids this app_user is actively assigned to, via
cmx_dialer.agent_campaign_assignments. Used for BOTH the "which
campaigns does this scoped-role user see" check below, and (reused
as-is) to populate a restricted campaign dropdown on the frontend
(see GET /campaigns/mine in dialerRoutes.js, which already does
exactly this query for the agent-facing campaign picker — this is
the same underlying relationship, applied here for admin-side pages
instead).
*/
async function getAssignedCampaignIds(appUserId) {
  const [rows] = await db.execute(
    `SELECT campaign_id FROM cmx_dialer.agent_campaign_assignments WHERE app_user_id = ? AND active = 1`,
    [appUserId]
  );
  return rows.map((r) => r.campaign_id);
}

/*
requireCampaignAccess — apply AFTER requireRoles on any route that
takes a ?campaignId= query param and returns campaign-specific data
(Live Dashboard's various panels, Reports, Recordings).

admin/wfm: campaignId optional — omitted means "All Campaigns",
provided means "this one campaign" (no ownership check needed, they
have access to everything).

Every other allowed role: campaignId is REQUIRED, and must be one of
their real assignments — rejects with 400 if missing, 403 if it's a
campaign they're not assigned to. This is what actually enforces
"filtered to campaigns the user is assigned with" — not just which
campaigns show up in their dropdown, but what the backend will ever
return regardless of what's sent.

Attaches req.accessibleCampaignIds (their full assignment list) and
leaves req.query.campaignId as-is (already validated) so downstream
handlers don't need to re-derive anything.
==================================================
*/
async function requireCampaignAccess(req, res, next) {
  const { accessLevel, appUserId } = req.session.agent;

  if (UNRESTRICTED_CAMPAIGN_ROLES.includes(accessLevel)) {
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
      return res.status(403).json({
        success: false,
        message: "You are not assigned to that campaign.",
      });
    }

    return next();
  } catch (error) {
    console.error("[accessControlService] requireCampaignAccess failed:", error);
    return res.status(500).json({ success: false, message: "Failed to verify campaign access." });
  }
}

module.exports = {
  requireRoles,
  getAssignedCampaignIds,
  requireCampaignAccess,
  UNRESTRICTED_CAMPAIGN_ROLES,
};