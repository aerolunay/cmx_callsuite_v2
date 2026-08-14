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
        callId: current.callId,
        status: current.status,
        room: current.room,
        callerIdNumber: current.callerIdNumber,
        onHold: current.onHold,
      },
    });
  } catch (error) {
    console.error("GET /api/dialer/inbound/current failed:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch current inbound call." });
  }
});

router.get("/dialer/has-leads", requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.query;
    if (!campaignId) {
      return res.status(400).json({ success: false, message: "campaignId query param is required." });
    }
    const lead = await dialerService.getNextLead(campaignId);
    return res.json({ success: true, hasLead: Boolean(lead) });
  } catch (error) {
    console.error("GET /api/dialer/has-leads failed:", error);
    return res.status(500).json({ success: false, message: "Failed to check for leads." });
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
    const { campaignId, leadId, phoneNumber, lead, callType } = req.body;

    if (!campaignId || leadId === undefined || leadId === null || !phoneNumber) {
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
      callType,
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
    const { callId } = req.body;
    if (!callId) {
      return res.status(400).json({ success: false, message: "callId is required." });
    }
    const call = inboundCallService.findByCallId(callId);
    if (!call) {
      return res.status(404).json({ success: false, message: "No inbound call with that ID." });
    }
    await inboundCallService.endInboundCall(call.room);
    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/inbound/end-call failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to end call." });
  }
});

router.post("/dialer/inbound/hold", requireAuth, async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) {
      return res.status(400).json({ success: false, message: "callId is required." });
    }
    const status = await inboundCallService.holdInboundCall(callId);
    return res.json({ success: true, status });
  } catch (error) {
    console.error("POST /api/dialer/inbound/hold failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to hold call." });
  }
});

router.post("/dialer/inbound/unhold", requireAuth, async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) {
      return res.status(400).json({ success: false, message: "callId is required." });
    }
    const status = await inboundCallService.unholdInboundCall(callId);
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
    const { campaignId, leadId, phoneNumber, firstName, lastName, room, disposition, comments, callbackAt, setNotReady } = req.body;

    if (!campaignId || leadId === undefined || leadId === null || !phoneNumber || !room || !disposition) {
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

    // NOTE: this used to be a real gap — outbound disposition never
    // touched agent status at all, unlike inbound's finalizeInboundCall
    // which always auto-set READY. Fixed here to match, and to support
    // the "set me Not Ready after this" checkbox.
    try {
      await agentStatusService.setStatus(appUserId, setNotReady ? "NOT_READY" : "READY");
    } catch (statusErr) {
      console.error("Failed to update agent status after disposition:", statusErr.message);
    }

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
    const { callId, callerIdNumber, firstName, lastName, comments, disposition, callbackAt, setNotReady } = req.body;

    if (!callId) {
      return res.status(400).json({ success: false, message: "callId is required." });
    }

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

    // Read BEFORE finalizeInboundCall() below, which deletes this call
    // from inboundCallService's Map — this is the last point at which
    // its campaignId/startedAt/endedAt/waitSeconds are still readable.
    const current = inboundCallService.findByCallId(callId);
    const startedAt = current?.startedAt || new Date();
    const endedAt = current?.endedAt || new Date();
    const inboundCampaignId = current?.campaignId || null;
    // null if the call never actually reached an agent (shouldn't
    // happen for a call reaching disposition at all, but guarding
    // rather than assuming).
    const waitSeconds = current?.waitSeconds ?? null;

    await db.execute(
      `
        INSERT INTO cmx_dialer.inbound_call_log
          (agent_user, campaign_id, call_id, caller_id_number, first_name, last_name, comments,
           disposition, callback_at, call_started_at, call_ended_at, wait_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agentUser, inboundCampaignId, callId, callerIdNumber || null, firstName || null, lastName || null,
        comments.trim(), disposition, callbackAt || null, startedAt, endedAt, waitSeconds,
      ]
    );

    await inboundCallService.finalizeInboundCall(callId, appUserId, setNotReady);

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/inbound-disposition failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to save inbound disposition." });
  }
});

module.exports = router;