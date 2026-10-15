"use strict";

const db = require("../config/db");
const ws = require("../config/ws");

/*
==================================================
LEAD DIALING PAUSE — per campaign
==================================================
Per explicit request — an admin can pause / start lead dialing for a
campaign from Admin -> Leads/Auto-Dial. While paused, getNextLead hands
out no leads (so Dial Next Number and Auto Dial stop, even with leads
left), but manual dials and callbacks still work — they never go through
getNextLead. Calls already in progress are untouched.

Stored in cmx_dialer.campaign_lead_dialing (sql/010_add_campaign_lead_dialing.sql).
If that migration hasn't been run yet, every campaign counts as NOT paused
— dialing must never break because of a missing table — and only the
admin's Pause/Start action reports the problem.
==================================================
*/

function isMissingTable(err) {
  return err && err.code === "ER_NO_SUCH_TABLE";
}

async function isLeadDialingPaused(campaignId) {
  try {
    const [rows] = await db.execute(`SELECT paused FROM cmx_dialer.campaign_lead_dialing WHERE campaign_id = ?`, [
      campaignId,
    ]);
    return Boolean(rows[0] && rows[0].paused);
  } catch (err) {
    if (isMissingTable(err)) return false;
    throw err;
  }
}

// campaignId -> true for every paused campaign.
async function getPausedCampaignIds() {
  try {
    const [rows] = await db.execute(`SELECT campaign_id FROM cmx_dialer.campaign_lead_dialing WHERE paused = 1`);
    return new Set(rows.map((r) => r.campaign_id));
  } catch (err) {
    if (isMissingTable(err)) return new Set();
    throw err;
  }
}

async function setLeadDialingPaused(campaignId, paused, appUserId) {
  try {
    await db.execute(
      `
        INSERT INTO cmx_dialer.campaign_lead_dialing (campaign_id, paused, updated_by_app_user_id)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE paused = VALUES(paused), updated_by_app_user_id = VALUES(updated_by_app_user_id)
      `,
      [campaignId, paused ? 1 : 0, appUserId || null]
    );
  } catch (err) {
    if (isMissingTable(err)) {
      const missing = new Error(
        "Lead dialing pause isn't set up on this server yet — run sql/010_add_campaign_lead_dialing.sql first."
      );
      missing.code = "MIGRATION_MISSING";
      throw missing;
    }
    throw err;
  }

  // Tell every open Dialer to re-check right away, rather than waiting for
  // its own periodic no-leads check — so Start resumes Auto Dial promptly.
  ws.broadcastToAll({ type: "leadDialingChanged", campaignId, paused: Boolean(paused) });
}

module.exports = {
  isLeadDialingPaused,
  getPausedCampaignIds,
  setLeadDialingPaused,
};
