"use strict";

const express = require("express");

const db = require("../config/db");
const dialerService = require("../services/dialerService");
const agentStatusService = require("../services/agentStatusService");

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
GET /api/campaigns
Active campaigns for the campaign-picker screen.

NOTE: this does not yet filter by the agent's user_group against
whatever access-control ViciDial itself uses to restrict which
campaigns a given agent may work — every logged-in agent currently
sees every active campaign. Flagged as a known gap, not yet confirmed
how this install actually models that restriction.
==================================================
*/
router.get("/campaigns", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT
          campaign_id,
          campaign_name,
          campaign_cid
        FROM vicidial_campaigns
        WHERE active = 'Y'
        ORDER BY campaign_name ASC
      `
    );

    return res.json({
      success: true,
      campaigns: rows,
    });
  } catch (error) {
    console.error("GET /api/campaigns failed:", error);

    return res.status(500).json({
      success: false,
      message: "We could not load campaigns. Please try again.",
    });
  }
});

/*
==================================================
AGENT STATUS
==================================================
GET /api/dialer/status — current status + how long they've been in it.
  Fetched once on DialerPage mount; live updates after that come over
  the WebSocket, not polling.

POST /api/dialer/status — manual switch. Body: { status }
  Only NOT_READY, READY, ON_HOLD are accepted here — IN_CALL and
  AFTER_CALL_WORK are system-only (see agentStatusService.js) and
  rejected if a client tries to set them directly.
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
NEXT LEAD
==================================================
POST /api/dialer/next-lead
Body: { campaignId }
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
POST /api/dialer/start-call
Body: { campaignId, leadId, phoneNumber }

campaignCid is looked up server-side from vicidial_campaigns rather than
trusted from the client, since it drives the outbound CallerID sent to
the trunk — no reason to let the frontend supply that directly.
==================================================
*/
router.post("/dialer/start-call", requireAuth, async (req, res) => {
  try {
    const { campaignId, leadId, phoneNumber } = req.body;

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
      leadId,
      phoneNumber,
      campaignCid,
      campaignId,
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("POST /api/dialer/start-call failed:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to start call.",
    });
  }
});

/*
==================================================
END CALL
==================================================
POST /api/dialer/end-call/:callId
==================================================
*/
router.post("/dialer/end-call/:callId", requireAuth, async (req, res) => {
  try {
    const { callId } = req.params;
    const status = await dialerService.endCall(callId);
    return res.json({ success: true, status });
  } catch (error) {
    console.error("POST /api/dialer/end-call failed:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to end call.",
    });
  }
});

/*
==================================================
CALL LOG
==================================================
GET /api/dialer/call-log — this agent's own recent call history, for
the DialerPage's "Call Logs" table.
==================================================
*/
router.get("/dialer/call-log", requireAuth, async (req, res) => {
  try {
    const rows = await dialerService.getCallLog(req.session.agent.username);
    return res.json({ success: true, callLog: rows });
  } catch (error) {
    console.error("GET /api/dialer/call-log failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load call log." });
  }
});

/*
==================================================
SAVE DISPOSITION
==================================================
POST /api/dialer/disposition/:callId
Body: { campaignId, leadId, phoneNumber, firstName, lastName, room,
        disposition, comments, callbackAt? }

comments is required — enforced both here and again inside
dialerService.saveDisposition (defense in depth, since a direct API
call could otherwise bypass the frontend's disabled-button check).
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
      return res.status(400).json({
        success: false,
        message: "Comments are required before saving a disposition.",
      });
    }

    if (disposition === "CALLBACK" && !callbackAt) {
      return res.status(400).json({
        success: false,
        message: "callbackAt is required when disposition is CALLBACK.",
      });
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
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to save disposition.",
    });
  }
});

module.exports = router;