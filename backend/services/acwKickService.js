"use strict";

const db = require("../config/db");
const dialerService = require("./dialerService");
const inboundCallService = require("./inboundCallService");
const recordingUploadService = require("./recordingUploadService");

/*
==================================================
KICK FROM AFTER CALL WORK
==================================================
Per explicit request — an admin can kick an agent who has been in After
Call Work for 5+ minutes (adminRoutes.js's POST /users/:id/kick). That
agent is still holding a call the server keeps in memory until a
disposition is saved, and a call is only written to the call log at
that point. Left alone, it would come back on the agent's next login
and sit on their screen (blocking Auto Dial), and never be logged.

So before the kick, the pending call is saved the way the agent's own
disposition save would — call log row (disposition NO_DISPOSITION, a
system-only code), lead status, recording upload — and released. They
spoke to someone, so it counts as human answered and the lead isn't
redialed.
==================================================
*/
const KICK_COMMENT = "No disposition saved — an admin logged the agent out of After Call Work.";

async function closePendingCallsForKick(appUserId) {
  const closed = [];

  const outbound = dialerService.getCallAwaitingDisposition(appUserId);
  if (outbound) {
    await dialerService.saveDisposition({
      callId: outbound.callId,
      appUserId,
      agentUser: outbound.agentUser,
      campaignId: outbound.campaignId,
      leadId: outbound.leadId || 0,
      phoneNumber: outbound.phoneNumber,
      firstName: outbound.lead?.first_name,
      lastName: outbound.lead?.last_name,
      room: outbound.room,
      disposition: "NO_DISPOSITION",
      comments: KICK_COMMENT,
      callbackAt: null,
    });
    uploadRecording(outbound.callId, outbound.campaignId, "dialer_call_log");
    closed.push(outbound.callId);
  }

  const inbound = inboundCallService.getInboundCallForAgent(appUserId);
  if (inbound && inbound.endedAt) {
    const [userRows] = await db.execute(`SELECT vicidial_user FROM cmx_dialer.app_users WHERE app_user_id = ?`, [appUserId]);
    await db.execute(
      `
        INSERT INTO cmx_dialer.inbound_call_log
          (agent_user, campaign_id, call_id, caller_id_number, comments, disposition,
           call_started_at, call_ended_at, wait_seconds, xfer_conf, xfer_conf_target)
        VALUES (?, ?, ?, ?, ?, 'NO_DISPOSITION', ?, ?, ?, ?, ?)
      `,
      [
        userRows[0]?.vicidial_user || "", inbound.campaignId || null, inbound.callId, inbound.callerIdNumber || null,
        KICK_COMMENT, inbound.startedAt, inbound.endedAt, inbound.waitSeconds ?? null,
        inbound.xferConfTarget ? "Y" : "N", inbound.xferConfTarget || null,
      ]
    );
    // Releases the call and its room. The status it sets is closed again
    // by the kick's forceLogout right after.
    await inboundCallService.finalizeInboundCall(inbound.callId, appUserId, true);
    uploadRecording(inbound.callId, inbound.campaignId, "inbound_call_log");
    closed.push(inbound.callId);
  }

  return closed;
}

// Same best-effort upload as the disposition routes — never fails the kick.
function uploadRecording(callId, campaignId, table) {
  recordingUploadService
    .uploadRecording(callId, campaignId)
    .then((key) => db.execute(`UPDATE cmx_dialer.${table} SET recording_key = ? WHERE call_id = ?`, [key, callId]))
    .catch((err) => {
      console.error(`[acwKickService] Failed to upload recording for call ${callId}:`, err.message);
    });
}

module.exports = { closePendingCallsForKick };
