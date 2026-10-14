"use strict";

const db = require("../config/db");

/*
==================================================
LEADS CLEANUP
==================================================
Shared by Admin -> Leads/Auto-Dial's "Clean Up Leads" button (see
leadRoutes.js's /leads/cleanup/preview + /confirm, and its comment for
the full rules) and, per explicit request, an automatic hourly run in
case nobody clicks the button — see startHourlyCleanup below.

Removes leads whose phone_number is on asterisk.vicidial_dnc or was
disposed SCREENING_COMPLETED in either call log. Every deleted row is
logged to cmx_dialer.deleted_leads_log first; deleted_by_app_user_id is
NULL for the automatic run.
==================================================
*/

// Computes exactly which (lead_id, phone_number, ...) rows currently
// qualify for deletion, each tagged with its reason. 'DNC' takes
// priority over 'SCREENING_COMPLETED' when a number matches both, since
// DNC is the stronger/legal reason.
//
// Logged numbers can be 10 digits, "1" + 10 or "+1" + 10 (inbound
// caller IDs especially), while leads are stored as the bare 10 digits —
// compared on their last 10 digits so a screened caller matches their lead.
async function findLeadsToClean(campaignId) {
  const params = [];
  let campaignFilter = "";
  if (campaignId) {
    campaignFilter = " AND vlt.campaign_id = ?";
    params.push(campaignId);
  }

  const [rows] = await db.execute(
    `
      SELECT
        vl.lead_id, vl.list_id, vlt.campaign_id, vl.phone_number, vl.first_name, vl.last_name,
        CASE WHEN dnc.phone_number IS NOT NULL THEN 'DNC' ELSE 'SCREENING_COMPLETED' END AS reason
      FROM asterisk.vicidial_list vl
      JOIN asterisk.vicidial_lists vlt ON vlt.list_id = vl.list_id
      LEFT JOIN asterisk.vicidial_dnc dnc ON dnc.phone_number = vl.phone_number
      LEFT JOIN (
        SELECT DISTINCT RIGHT(phone_number, 10) AS phone_number
        FROM cmx_dialer.dialer_call_log WHERE disposition = 'SCREENING_COMPLETED'
        UNION
        SELECT DISTINCT RIGHT(caller_id_number, 10) AS phone_number
        FROM cmx_dialer.inbound_call_log WHERE disposition = 'SCREENING_COMPLETED'
      ) screened ON screened.phone_number = vl.phone_number
      WHERE (dnc.phone_number IS NOT NULL OR screened.phone_number IS NOT NULL)${campaignFilter}
    `,
    params
  );
  return rows;
}

// Logs then deletes every qualifying lead in one transaction. appUserId
// is the admin who clicked the button, or null for the automatic run.
async function runLeadCleanup({ campaignId = null, appUserId = null } = {}) {
  const toClean = await findLeadsToClean(campaignId);
  if (toClean.length === 0) return { deleted: 0 };

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Log every row BEFORE deleting it — batched, not one insert per row.
    const logPlaceholders = toClean.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const logParams = [];
    for (const row of toClean) {
      logParams.push(row.lead_id, row.list_id, row.campaign_id, row.phone_number, row.first_name, row.last_name, row.reason, appUserId);
    }
    await connection.execute(
      `
        INSERT INTO cmx_dialer.deleted_leads_log
          (lead_id, list_id, campaign_id, phone_number, first_name, last_name, reason, deleted_by_app_user_id)
        VALUES ${logPlaceholders}
      `,
      logParams
    );

    const leadIds = toClean.map((r) => r.lead_id);
    const deletePlaceholders = leadIds.map(() => "?").join(",");
    await connection.execute(`DELETE FROM asterisk.vicidial_list WHERE lead_id IN (${deletePlaceholders})`, leadIds);
    // Their hopper rows too, so nothing points at a deleted lead.
    await connection.execute(`DELETE FROM asterisk.vicidial_hopper WHERE lead_id IN (${deletePlaceholders})`, leadIds);

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  return { deleted: toClean.length };
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let cleanupRunning = false;

async function runScheduledCleanup() {
  if (cleanupRunning) return; // the previous run is somehow still going — skip, never overlap
  cleanupRunning = true;
  try {
    const { deleted } = await runLeadCleanup();
    if (deleted > 0) console.log(`[leadCleanupService] Hourly cleanup removed ${deleted} lead(s).`);
  } catch (err) {
    console.error("[leadCleanupService] Hourly cleanup failed:", err.message);
  } finally {
    cleanupRunning = false;
  }
}

// Every hour, all campaigns. Not run at startup, so a backend restart
// never deletes anything by itself — the first run is an hour later.
function startHourlyCleanup() {
  setInterval(runScheduledCleanup, CLEANUP_INTERVAL_MS);
}

module.exports = {
  findLeadsToClean,
  runLeadCleanup,
  startHourlyCleanup,
};
