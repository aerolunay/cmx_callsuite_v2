"use strict";

const express = require("express");

const db = require("../config/db");
const ami = require("../config/ami");
const dialerService = require("../services/dialerService");
const agentStatusService = require("../services/agentStatusService");
const statsService = require("../services/statsService");
const inboundCallService = require("../services/inboundCallService");
const crossAppHandoffService = require("../services/crossAppHandoffService");
const recordingUploadService = require("../services/recordingUploadService");
const conferenceService = require("../services/conferenceService");

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

// Shared registration password for every PJSIP phone endpoint — same
// value adminRoutes.js writes into every wizard-generated endpoint's
// auth block (see PHONE_REGISTRATION_PASSWORD there). Not per-agent
// secret; MicroSIP required agents to know this same value to manually
// configure their softphone, so exposing it to an authenticated
// agent's own session here is no greater an exposure than today.
const PHONE_REGISTRATION_PASSWORD = process.env.PHONE_REGISTRATION_PASSWORD;
// wss:// endpoint JsSIP connects to — Asterisk's PJSIP transport-wss,
// riding on the HTTP/HTTPS server's /ws route (see http.conf tlsbindport).
const ASTERISK_WSS_URL = process.env.ASTERISK_WSS_URL;

/*
==================================================
JSSIP/WEBRTC CREDENTIALS
==================================================
GET /api/dialer/webrtc-credentials

Returns what the frontend's JsSIP UA needs to register as THIS agent's
own extension — the same extension Originate() already targets for
both inbound and outbound agent-leg calls (PJSIP/${agent.extension}).
Once JsSIP is registered here instead of a MicroSIP softphone, both
call directions ring the browser automatically — no dialerService.js
or inboundCallService.js changes needed for that part.
==================================================
*/
router.get("/dialer/webrtc-credentials", requireAuth, async (req, res) => {
  const { extension } = req.session.agent;

  if (!extension) {
    return res.status(409).json({
      success: false,
      message: "Your agent account has no phone extension configured.",
    });
  }

  if (!PHONE_REGISTRATION_PASSWORD || !ASTERISK_WSS_URL) {
    console.error(
      "[dialerRoutes] PHONE_REGISTRATION_PASSWORD / ASTERISK_WSS_URL are not set in .env — JsSIP registration will fail until they are."
    );
    return res.status(500).json({
      success: false,
      message: "Softphone registration is not configured on this server.",
    });
  }

  return res.json({
    success: true,
    credentials: {
      extension,
      password: PHONE_REGISTRATION_PASSWORD,
      wssUrl: ASTERISK_WSS_URL,
    },
  });
});

/*
==================================================
CONFERENCE / TRANSFER (Phase E)
==================================================
NOT YET CONFIRMED against a real test call — built on a new AMI
primitive (conferenceService.addParticipant) that hasn't been
live-tested. Works identically for outbound or inbound calls, since
both already converge on the same room/ConfBridge model — this
resolveActiveRoom() helper just figures out which one is actually
live for this agent right now.

Attended transfer (talk to the target privately before completing) is
NOT implemented here — it needs either a ConfBridge DTMF-based consult
menu (confbridge.conf) or explicit AMI Bridge-manipulation actions,
meaningfully more complex than this blind-transfer/conference
primitive, and was deliberately left for a separate, carefully-tested
pass rather than guessed at.
==================================================
*/
function resolveActiveRoom(appUserId) {
  const outboundCall = dialerService.getRawActiveCallForAgent(appUserId);
  if (outboundCall) {
    return { room: outboundCall.room, agentChannel: outboundCall.agentChannel };
  }
  const inboundCall = inboundCallService.getInboundCallForAgent(appUserId);
  if (inboundCall) {
    return { room: inboundCall.room, agentChannel: inboundCall.agentChannel };
  }
  return null;
}

router.post("/dialer/conference-add", requireAuth, async (req, res) => {
  try {
    const { target, isExtension } = req.body;
    if (!target) {
      return res.status(400).json({ success: false, message: "target is required." });
    }

    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }

    const result = await conferenceService.addParticipant(
      active.room,
      target,
      Boolean(isExtension),
      "Conference"
    );

    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: `${target} didn't answer or couldn't be reached.`,
        reason: result.reason,
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/conference-add failed:", error);
    return res.status(500).json({ success: false, message: "Failed to add participant." });
  }
});

router.post("/dialer/transfer-blind", requireAuth, async (req, res) => {
  try {
    const { target, isExtension } = req.body;
    if (!target) {
      return res.status(400).json({ success: false, message: "target is required." });
    }

    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }

    const result = await conferenceService.addParticipant(
      active.room,
      target,
      Boolean(isExtension),
      "Transfer"
    );

    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: `${target} didn't answer — transfer not completed, you're still on the call.`,
        reason: result.reason,
      });
    }

    // Target answered and joined the room — now drop the agent's OWN
    // leg, completing the handoff. If this hangup itself fails, the
    // target is still correctly in the room with the customer; the
    // agent is just stuck there too rather than the transfer having
    // silently not happened at all.
    if (active.agentChannel) {
      try {
        await ami.hangupChannel(active.agentChannel);
      } catch (hangupErr) {
        console.error("[dialerRoutes] Transfer succeeded but failed to hang up agent leg:", hangupErr.message);
      }
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/transfer-blind failed:", error);
    return res.status(500).json({ success: false, message: "Failed to transfer call." });
  }
});

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

    /*
    ==================================================
    ACW DISPOSITION-PENDING BLOCK
    ==================================================
    REAL GAP: the frontend already disables the status dropdown while
    AFTER_CALL_WORK is showing (see DialerPage.jsx's isSystemStatus),
    but nothing backend-side stopped a direct POST here from switching
    straight to READY/anything else without ever saving a disposition.
    The ONLY legitimate way out of AFTER_CALL_WORK is
    POST /dialer/disposition/:callId (saveDisposition), which calls
    agentStatusService.setStatus directly — NOT through this route —
    so blocking every manual switch attempt here while AFTER_CALL_WORK
    is open can never interfere with that real exit path.
    ==================================================
    */
    const currentStatus = await agentStatusService.getCurrentStatus(req.session.agent.appUserId);
    if (currentStatus && currentStatus.status === "AFTER_CALL_WORK") {
      return res.status(409).json({
        success: false,
        message: "You must save a disposition for your last call before changing your status.",
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

    /*
    ==================================================
    DISPOSITION-PENDING BLOCK (from production, Phase 8)
    ==================================================
    REAL GAP FIXED HERE: this route previously trusted the frontend
    entirely — "Dial Next Number"/"Callback" only being SHOWN while
    READY was the sole protection. A direct POST here (or a stale
    button click, or a race between a disposition save and a dial
    click) could start a new call while a real outbound call's
    disposition was still genuinely pending (AFTER_CALL_WORK). Note:
    MicroSIP-direct calls (MICROSIP_OUTBOUND) do NOT require a
    disposition at all — explicit product decision — so they're not
    part of what this block guards against; MICROSIP_OUTBOUND already
    isn't READY anyway, so it's naturally excluded below too.

    AUX_CB removed entirely (JsSIP's own call-gating on the agent's
    registered extension covers what it used to protect against) —
    Callback now shares the same single legitimate state as Dial Next
    Number: READY. Everything else is rejected here regardless of what
    the frontend allowed through.
    ==================================================
    */
    const currentStatus = await agentStatusService.getCurrentStatus(appUserId);
    const allowedToDial = currentStatus && currentStatus.status === "READY";
    if (!allowedToDial) {
      return res.status(409).json({
        success: false,
        message:
          currentStatus && currentStatus.status === "AFTER_CALL_WORK"
            ? "You must save a disposition for your last call before dialing again."
            : "You can't start a new call from your current status.",
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

    // BSMSC-only, fire-and-forget — the dialer_call_log row for this
    // call already committed above (via saveDisposition), so an upload
    // failure here can never leave the disposition itself half-saved.
    // Never awaited into the response — same non-blocking pattern
    // already used for the welcome email in adminRoutes.js. Updates
    // recording_key on the SAME row once the upload actually completes,
    // which could be anywhere from under a second to a while later
    // depending on file size/network — the Call Logs page (built next)
    // should treat a null recording_key as "still uploading or was
    // never recorded," not as an error.
    if (campaignId === "CMXBSMSC") {
      recordingUploadService
        .uploadRecording(callId, campaignId)
        .then((key) =>
          db.execute(`UPDATE cmx_dialer.dialer_call_log SET recording_key = ? WHERE call_id = ?`, [key, callId])
        )
        .catch((err) => {
          console.error(`[dialerRoutes] Failed to upload recording for call ${callId}:`, err.message);
        });
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
    const { callId, callerIdNumber, firstName, lastName, comments, disposition, callbackAt, callbackNumber, setNotReady } = req.body;

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
           disposition, callback_at, callback_number, call_started_at, call_ended_at, wait_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agentUser, inboundCampaignId, callId, callerIdNumber || null, firstName || null, lastName || null,
        comments.trim(), disposition, callbackAt || null, callbackNumber || null, startedAt, endedAt, waitSeconds,
      ]
    );

    await inboundCallService.finalizeInboundCall(callId, appUserId, setNotReady);

    // BSMSC-only, fire-and-forget — same reasoning as outbound above.
    // The inbound_call_log row already committed by the time this
    // runs, so an upload failure here never affects the disposition
    // save itself.
    if (inboundCampaignId === "CMXBSMSC") {
      recordingUploadService
        .uploadRecording(callId, inboundCampaignId)
        .then((key) =>
          db.execute(`UPDATE cmx_dialer.inbound_call_log SET recording_key = ? WHERE call_id = ?`, [key, callId])
        )
        .catch((err) => {
          console.error(`[dialerRoutes] Failed to upload recording for call ${callId}:`, err.message);
        });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/inbound-disposition failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to save inbound disposition." });
  }
});

/*
==================================================
SCREENING APP HANDOFF (cross-app auth)
==================================================
POST /api/dialer/screening-handoff-code

Generates a short-lived, single-use code the DialerPage's "Open
Screening Form" link appends to cmx_scn_suite's URL as ?code=...
That app's own backend then calls OUR POST /api/auth/cross-app/verify
(see crossAppRoutes.js) to redeem it — see crossAppHandoffService.js
for why this is deliberately not a real session/token.
==================================================
*/
router.post("/dialer/screening-handoff-code", requireAuth, (req, res) => {
  try {
    const code = crossAppHandoffService.generateHandoffCode(req.session.agent);
    return res.json({ success: true, code });
  } catch (error) {
    console.error("POST /api/dialer/screening-handoff-code failed:", error);
    return res.status(500).json({ success: false, message: "Failed to generate handoff code." });
  }
});

module.exports = router;