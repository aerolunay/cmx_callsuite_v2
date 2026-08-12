"use strict";

const express = require("express");

const db = require("../config/db");
const dialerService = require("../services/dialerService");
const agentStatusService = require("../services/agentStatusService");
const statsService = require("../services/statsService");
const inboundCallService = require("../services/inboundCallService");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
  }

  return next();
}

/*
==================================================
CAMPAIGN LIST
==================================================
*/
router.get("/campaigns", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT campaign_id, campaign_name, campaign_cid
        FROM vicidial_campaigns
        WHERE active = 'Y'
        ORDER BY campaign_name ASC
      `
    );
    return res.json({ success: true, campaigns: rows });
  } catch (error) {
    console.error("GET /api/campaigns failed:", error);
    return res.status(500).json({ success: false, message: "We could not load campaigns. Please try again." });
  }
});

/*
==================================================
AGENT STATUS
==================================================
*/
router.get("/dialer/status", requireAuth, async (req, res) => {
  try {
    const current = await agentStatusService.getCurrentStatus(req.session.agent.appUserId);
    return res.json({ success: true, status: current });
  } catch (error) {
    console.error("GET /api/dialer/status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch status." });
  }
});

router.post("/dialer/status", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;

    if (!agentStatusService.isManualStatus(status)) {
      return res.status(400).json({
        success: false,
        message: `"${status}" is not a status you can set directly.`,
      });
    }

    const current = await agentStatusService.setStatus(req.session.agent.appUserId, status);
    return res.json({ success: true, status: current });
  } catch (error) {
    console.error("POST /api/dialer/status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to update status." });
  }
});

/*
==================================================
CURRENT CALL (restoration after refresh / app reopen)
==================================================
*/
router.get("/dialer/current-call", requireAuth, async (req, res) => {
  try {
    const call = dialerService.getActiveCallForAgent(req.session.agent.appUserId);
    return res.json({ success: true, call });
  } catch (error) {
    console.error("GET /api/dialer/current-call failed:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch current call." });
  }
});

router.get("/dialer/inbound/current", requireAuth, async (req, res) => {
  try {
    const current = inboundCallService.getInboundCallForAgent(req.session.agent.appUserId);
    if (!current) {
      return res.json({ success: true, call: null });
    }
    return res.json({
      success: true,
      call: {
        status: current.status,
        room: inboundCallService.INBOUND_ROOM,
        callerIdNumber: current.callerIdNumber,
        onHold: current.onHold,
      },
    });
  } catch (error) {
    console.error("GET /api/dialer/inbound/current failed:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch current inbound call." });
  }
});

/*
==================================================
NEXT LEAD
==================================================
*/
router.post("/dialer/next-lead", requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.body;

    if (!campaignId) {
      return res.status(400).json({ success: false, message: "campaignId is required." });
    }

    const lead = await dialerService.getNextLead(campaignId);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "No eligible leads found for this campaign right now.",
      });
    }

    return res.json({ success: true, lead });
  } catch (error) {
    console.error("POST /api/dialer/next-lead failed:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch next lead." });
  }
});

/*
==================================================
START CALL
==================================================
`lead` (the full object, not just leadId/phoneNumber) is now passed
through and stored on the call state — needed so a page refresh can
restore ContactDetailsCard fully, not just the lead's ID/phone number.
==================================================
*/
router.post("/dialer/start-call", requireAuth, async (req, res) => {
  try {
    const { campaignId, leadId, phoneNumber, lead } = req.body;

    if (!campaignId || !leadId || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "campaignId, leadId, and phoneNumber are all required.",
      });
    }

    const [campaignRows] = await db.execute(
      `SELECT campaign_cid FROM vicidial_campaigns WHERE campaign_id = ? AND active = 'Y'`,
      [campaignId]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ success: false, message: "Campaign not found or inactive." });
    }

    const { campaign_cid: campaignCid } = campaignRows[0];
    const { appUserId, username: agentUser, extension: agentExtension } = req.session.agent;

    if (!agentExtension) {
      return res.status(409).json({
        success: false,
        message: "Your agent account has no phone extension configured.",
      });
    }

    const result = await dialerService.startCall({
      appUserId,
      agentUser,
      agentExtension,
      lead,
      leadId,
      phoneNumber,
      campaignCid,
      campaignId,
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("POST /api/dialer/start-call failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to start call." });
  }
});

/*
==================================================
END CALL / HOLD / UNHOLD (outbound)
==================================================
*/
router.post("/dialer/end-call/:callId", requireAuth, async (req, res) => {
  try {
    const status = await dialerService.endCall(req.params.callId);
    return res.json({ success: true, status });
  } catch (error) {
    console.error("POST /api/dialer/end-call failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to end call." });
  }
});

router.post("/dialer/hold/:callId", requireAuth, async (req, res) => {
  try {
    const status = await dialerService.holdCall(req.params.callId);
    return res.json({ success: true, status });
  } catch (error) {
    console.error("POST /api/dialer/hold failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to hold call." });
  }
});

router.post("/dialer/unhold/:callId", requireAuth, async (req, res) => {
  try {
    const status = await dialerService.unholdCall(req.params.callId);
    return res.json({ success: true, status });
  } catch (error) {
    console.error("POST /api/dialer/unhold failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to unhold call." });
  }
});

/*
==================================================
INBOUND: END CALL / HOLD / UNHOLD
==================================================
*/
router.post("/dialer/inbound/end-call", requireAuth, async (req, res) => {
  try {
    await inboundCallService.endInboundCall();
    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/inbound/end-call failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to end call." });
  }
});

router.post("/dialer/inbound/hold", requireAuth, async (req, res) => {
  try {
    const status = await inboundCallService.holdInboundCall();
    return res.json({ success: true, status });
  } catch (error) {
    console.error("POST /api/dialer/inbound/hold failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to hold call." });
  }
});

router.post("/dialer/inbound/unhold", requireAuth, async (req, res) => {
  try {
    const status = await inboundCallService.unholdInboundCall();
    return res.json({ success: true, status });
  } catch (error) {
    console.error("POST /api/dialer/inbound/unhold failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to unhold call." });
  }
});

/*
==================================================
CALL LOG / STATS
==================================================
*/
router.get("/dialer/call-log", requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.query;
    if (!campaignId) {
      return res.status(400).json({ success: false, message: "campaignId query param is required." });
    }
    const rows = await dialerService.getCallLog(req.session.agent.username, campaignId);
    return res.json({ success: true, callLog: rows });
  } catch (error) {
    console.error("GET /api/dialer/call-log failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load call log." });
  }
});

router.get("/dialer/stats/today", requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.query;
    if (!campaignId) {
      return res.status(400).json({ success: false, message: "campaignId query param is required." });
    }
    const { appUserId, username: agentUser } = req.session.agent;
    const stats = await statsService.getTodayStats(appUserId, agentUser, campaignId);
    return res.json({ success: true, stats });
  } catch (error) {
    console.error("GET /api/dialer/stats/today failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load today's stats." });
  }
});

/*
==================================================
SAVE DISPOSITION (outbound)
==================================================
*/
router.post("/dialer/disposition/:callId", requireAuth, async (req, res) => {
  try {
    const { callId } = req.params;
    const { campaignId, leadId, phoneNumber, firstName, lastName, room, disposition, comments, callbackAt } = req.body;

    if (!campaignId || !leadId || !phoneNumber || !room || !disposition) {
      return res.status(400).json({
        success: false,
        message: "campaignId, leadId, phoneNumber, room, and disposition are all required.",
      });
    }

    if (!comments || !comments.trim()) {
      return res.status(400).json({ success: false, message: "Comments are required before saving a disposition." });
    }

    if (disposition === "CALLBACK" && !callbackAt) {
      return res.status(400).json({ success: false, message: "callbackAt is required when disposition is CALLBACK." });
    }

    const { appUserId, username: agentUser } = req.session.agent;

    const result = await dialerService.saveDisposition({
      callId,
      appUserId,
      agentUser,
      campaignId,
      leadId,
      phoneNumber,
      firstName,
      lastName,
      room,
      disposition,
      comments,
      callbackAt,
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("POST /api/dialer/disposition failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to save disposition." });
  }
});

/*
==================================================
INBOUND DISPOSITION
==================================================
call_id is read from inboundCallService's tracked call (the UUID
generated when the call started) — NOT regenerated here, so it
matches the same ID used throughout the call's lifecycle.
==================================================
*/
router.post("/dialer/inbound-disposition", requireAuth, async (req, res) => {
  try {
    const { callerIdNumber, firstName, lastName, comments, disposition, callbackAt } = req.body;

    if (!comments || !comments.trim()) {
      return res.status(400).json({ success: false, message: "Comments are required." });
    }

    if (!disposition) {
      return res.status(400).json({ success: false, message: "Disposition is required." });
    }

    if (disposition === "CALLBACK_REQUESTED" && !callbackAt) {
      return res.status(400).json({
        success: false,
        message: "callbackAt is required when disposition is CALLBACK_REQUESTED.",
      });
    }

    const { appUserId, username: agentUser } = req.session.agent;
    const current = inboundCallService.getInboundCallStatus();
    const startedAt = current?.startedAt || new Date();
    const endedAt = current?.endedAt || new Date();
    const inboundCallId = current?.callId || null;

    await db.execute(
      `
        INSERT INTO cmx_dialer.inbound_call_log
          (agent_user, call_id, caller_id_number, first_name, last_name, comments,
           disposition, callback_at, call_started_at, call_ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agentUser, inboundCallId, callerIdNumber || null, firstName || null, lastName || null,
        comments.trim(), disposition, callbackAt || null, startedAt, endedAt,
      ]
    );

    await inboundCallService.finalizeInboundCall(appUserId);

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/inbound-disposition failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to save inbound disposition." });
  }
});

module.exports = router;