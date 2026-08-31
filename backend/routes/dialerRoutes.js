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
const attendedTransferService = require("../services/attendedTransferService");
const { requireRoles, requireCampaignAccess, getAssignedCampaignIds, UNRESTRICTED_CAMPAIGN_ROLES } = require("../services/accessControlService");

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
Recordings access — now uses the shared accessControlService
(requireRoles + requireCampaignAccess) instead of the one-off
requireAdminOrSupervisor this used to be. Widened per the finished
access-level matrix: supervisor, training_quality, account_manager,
admin — deliberately NOT wfm, per the spec as given (WFM gets Live
Dashboard/Reports/Admin, not Recordings). See RECORDINGS_ROLES below,
also used directly by the playback-url route's own manual campaign
check further down (that route can't use requireCampaignAccess as-is,
since it takes a :callId path param, not a ?campaignId query param —
the campaign it belongs to has to be looked up from the DB first).
==================================================
*/
const RECORDINGS_ROLES = ["supervisor", "training_quality", "account_manager", "admin"];

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
    return {
      room: outboundCall.room,
      agentChannel: outboundCall.agentChannel,
      customerChannel: outboundCall.customerChannel,
      rawCall: outboundCall,
      callId: outboundCall.callId,
      isInbound: false,
    };
  }
  const inboundCall = inboundCallService.getInboundCallForAgent(appUserId);
  if (inboundCall) {
    return {
      room: inboundCall.room,
      agentChannel: inboundCall.agentChannel,
      customerChannel: inboundCall.customerChannel,
      rawCall: inboundCall,
      callId: inboundCall.callId,
      isInbound: true,
    };
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

    const excludeChannels = [active.agentChannel, active.customerChannel].filter(Boolean);

    // Same fix as attendedTransferService.js's own Line 2 — see that
    // function's comment for the full story on why this matters.
    const [campaignRows] = await db.execute(
      `SELECT campaign_cid FROM asterisk.vicidial_campaigns WHERE campaign_id = ? AND active = 'Y'`,
      [active.rawCall?.campaignId]
    );
    const campaignCid = campaignRows[0]?.campaign_cid;

    const result = await conferenceService.addParticipant(
      active.room,
      target,
      Boolean(isExtension),
      "Conference",
      excludeChannels,
      campaignCid
    );

    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: `${target} didn't answer or couldn't be reached.`,
        reason: result.reason,
      });
    }

    // Tracked so a later hang-up by the ORIGINAL agent knows someone
    // else is still in the room — see dialerService.js's endCall /
    // inboundCallService.js's endInboundCall, both now extras-aware.
    if (active.rawCall) {
      active.rawCall.extraParticipants = [...(active.rawCall.extraParticipants || []), result.channel];
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

    const excludeChannels = [active.agentChannel, active.customerChannel].filter(Boolean);

    // Same fix as attendedTransferService.js's own Line 2 — see that
    // function's comment for the full story on why this matters.
    const [campaignRows] = await db.execute(
      `SELECT campaign_cid FROM asterisk.vicidial_campaigns WHERE campaign_id = ? AND active = 'Y'`,
      [active.rawCall?.campaignId]
    );
    const campaignCid = campaignRows[0]?.campaign_cid;

    const result = await conferenceService.addParticipant(
      active.room,
      target,
      Boolean(isExtension),
      "Transfer",
      excludeChannels,
      campaignCid
    );

    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: `${target} didn't answer — transfer not completed, you're still on the call.`,
        reason: result.reason,
      });
    }

    // UPDATED, per explicit request — "just keep conference, but allow
    // agents to hang up": Transfer no longer auto-hangs-up the
    // original agent's own leg once the target joins. This used to
    // exist to "complete the handoff" automatically, but it bypassed
    // the app's own normal call-ending bookkeeping entirely (a raw
    // ami.hangupChannel call, not the real endCall()/onHangUp() path)
    // — confirmed live: the frontend never learned the call had ended
    // this way, leaving the agent's own UI stuck showing an active
    // call indefinitely. Transfer is now functionally identical to
    // Conference at this point — it just adds the target to the room.
    // The agent completes the handoff themselves via the NORMAL Hang
    // Up button, which already correctly notifies the frontend AND
    // (see dialerService.js's endCall / inboundCallService.js's
    // endInboundCall, both now extras-aware) correctly leaves the
    // customer connected with the target instead of also hanging up
    // on them.
    if (active.rawCall) {
      active.rawCall.extraParticipants = [...(active.rawCall.extraParticipants || []), result.channel];
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/transfer-blind failed:", error);
    return res.status(500).json({ success: false, message: "Failed to transfer call." });
  }
});

/*
==================================================
ATTENDED TRANSFER ("Line 2") — per explicit request
==================================================
Real attended transfer: the customer is put on hold (hears nothing)
while the agent privately talks to a new target on a separate,
private line, then either completes a handoff (Transfer) or brings
everyone together (Conference) — or cancels and returns to the
original call. See attendedTransferService.js for the full design
rationale and exact dialplan patterns this relies on.
==================================================
*/
router.post("/dialer/line-two/start", requireAuth, async (req, res) => {
  try {
    const { target, isExtension } = req.body;
    if (!target) {
      return res.status(400).json({ success: false, message: "target is required." });
    }

    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }

    const result = await attendedTransferService.startLineTwo(active, target, Boolean(isExtension));

    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: `${target} didn't answer — you're back with your original call.`,
        reason: result.reason,
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/line-two/start failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to start Line 2." });
  }
});

router.post("/dialer/line-two/complete", requireAuth, async (req, res) => {
  try {
    const { action } = req.body;
    if (action !== "transfer" && action !== "conference") {
      return res.status(400).json({ success: false, message: 'action must be "transfer" or "conference".' });
    }

    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }

    const result = await attendedTransferService.completeLineTwo(active, action);

    if (!result.success && result.reason === "customer_disconnected") {
      return res.status(409).json({
        success: false,
        message:
          "The original customer disconnected while Line 2 was in progress. You're still connected on Line 2 — you can keep talking or hang up normally.",
        reason: "customer_disconnected",
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/line-two/complete failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to complete Line 2." });
  }
});

router.post("/dialer/line-two/cancel", requireAuth, async (req, res) => {
  try {
    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }

    const result = await attendedTransferService.cancelLineTwo(active);

    if (result.customerAlreadyGone) {
      return res.json({
        success: true,
        message: "Line 2 was canceled. The original customer had already disconnected, so this call has ended.",
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/line-two/cancel failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to cancel Line 2." });
  }
});

/*
==================================================
Line 1 / Line 2 toggle + status polling — per explicit request
==================================================
*/
router.post("/dialer/line-two/switch", requireAuth, async (req, res) => {
  try {
    const { line } = req.body;
    if (line !== 1 && line !== 2) {
      return res.status(400).json({ success: false, message: "line must be 1 or 2." });
    }

    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }

    if (line === 1) {
      await attendedTransferService.switchToLineOne(active);
    } else {
      await attendedTransferService.switchToLineTwo(active);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/line-two/switch failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to switch lines." });
  }
});

router.get("/dialer/line-two/status", requireAuth, async (req, res) => {
  try {
    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }

    const status = attendedTransferService.getLineTwoStatus(active);
    return res.json({ success: true, ...status });
  } catch (error) {
    console.error("GET /api/dialer/line-two/status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load Line 2 status." });
  }
});

router.post("/dialer/line-two/hold", requireAuth, async (req, res) => {
  try {
    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }
    await attendedTransferService.holdLineTwo(active);
    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/line-two/hold failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to hold Line 2." });
  }
});

router.post("/dialer/line-two/unhold", requireAuth, async (req, res) => {
  try {
    const active = resolveActiveRoom(req.session.agent.appUserId);
    if (!active) {
      return res.status(409).json({ success: false, message: "You're not currently on a call." });
    }
    await attendedTransferService.unholdLineTwo(active);
    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/dialer/line-two/unhold failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to unhold Line 2." });
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
        SELECT campaign_id, campaign_name, campaign_cid, dial_method
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
CAMPAIGN LIST — scoped to the logged-in agent's own assignments
==================================================
GET /api/campaigns/mine

NEW — deliberately a SEPARATE endpoint from GET /campaigns above, not a
change to it. GET /campaigns returns every active campaign system-wide
and is relied on by several admin/supervisor-only screens
(AdminUsersSection's assignment checkboxes, LiveStatusDashboard's
filter, ReportsPage's filter, DialerPage's own AggregateStatsPanel
filter) that all genuinely need the FULL list, not just what the
logged-in user happens to be assigned to. Scoping the existing route
would have silently broken all of those.

This one powers the "does this agent have 1 or 2+ campaigns" decision
in CampaignSelectPage.jsx/DialerPage.jsx (auto-skip the picker, hide
"Change campaign" when there's only one) — genuinely needs to be
scoped to just this agent's own active
cmx_dialer.agent_campaign_assignments rows.
==================================================
*/
router.get("/campaigns/mine", requireAuth, async (req, res) => {
  try {
    const { appUserId } = req.session.agent;
    const [rows] = await db.execute(
      `
        SELECT c.campaign_id, c.campaign_name, c.campaign_cid, c.dial_method, s.campaign_type
        FROM asterisk.vicidial_campaigns c
        JOIN cmx_dialer.agent_campaign_assignments aca ON aca.campaign_id = c.campaign_id
        LEFT JOIN cmx_dialer.campaign_settings s ON s.campaign_id = c.campaign_id
        WHERE aca.app_user_id = ? AND aca.active = 1 AND c.active = 'Y'
        ORDER BY c.campaign_name ASC
      `,
      [appUserId]
    );
    return res.json({ success: true, campaigns: rows });
  } catch (error) {
    console.error("GET /api/campaigns/mine failed:", error);
    return res.status(500).json({ success: false, message: "We could not load your campaigns. Please try again." });
  }
});

/*
==================================================
GET /api/dialer/campaign-agents?campaignId=X
==================================================
New, per explicit request — powers the "Transfer to Extension" picker
in MiniPhone: instead of blindly typing an extension number, shows
real agents assigned to the SAME campaign as the active call, with
their live status, so the transferring agent can see who's actually
around before picking someone.

Excludes: the requesting agent themselves (can't transfer to your own
line), any agent with no extension at all (vicidial_user IS NULL —
nothing to dial), and inactive assignments/accounts.

Deliberately does NOT filter to READY-only — showing NOT_READY/IN_CALL
agents too (with their real status visible) is more useful than
silently hiding them; the picker shows status precisely so the agent
can make an informed choice, not to pre-filter it for them.
==================================================
*/
router.get("/dialer/campaign-agents", requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.query;
    if (!campaignId) {
      return res.status(400).json({ success: false, message: "campaignId is required." });
    }

    const [rows] = await db.execute(
      `
        SELECT au.app_user_id, au.full_name, au.vicidial_user AS extension, asl.status
        FROM cmx_dialer.agent_campaign_assignments aca
        JOIN cmx_dialer.app_users au ON au.app_user_id = aca.app_user_id
        LEFT JOIN cmx_dialer.agent_status_log asl ON asl.app_user_id = au.app_user_id AND asl.ended_at IS NULL
        WHERE aca.campaign_id = ?
          AND aca.active = 1
          AND au.active = 1
          AND au.vicidial_user IS NOT NULL
          AND au.app_user_id != ?
        ORDER BY au.full_name ASC
      `,
      [campaignId, req.session.agent.appUserId]
    );

    const agents = rows.map((r) => ({
      appUserId: r.app_user_id,
      fullName: r.full_name,
      extension: r.extension,
      status: r.status || "LOGGED_OUT",
    }));

    return res.json({ success: true, agents });
  } catch (error) {
    console.error("GET /api/dialer/campaign-agents failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load campaign agents." });
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
    const { status, campaignId } = req.body;

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

    // REAL BUG FIX: this never passed a campaignId at all, even though
    // setStatus() already supports relatedCampaignId as an option —
    // meaning every manual status change (READY/NOT_READY/etc.) wrote
    // a status_log row with related_campaign_id = NULL. The Live
    // Dashboard's fallback logic then had no way to know which
    // campaign a multi-assignment agent was actually working, and
    // guessed by picking whichever assigned campaign sorted first
    // alphabetically — confirmed live: an agent working CMXRNYBL
    // showed as CMXBSMSC simply because "B" < "R". Now records the
    // agent's actual currently-selected campaign on every status
    // change, not just call-tied ones.
    const current = await agentStatusService.setStatus(req.session.agent.appUserId, status, {
      relatedCampaignId: campaignId || null,
    });
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
    if (error.code === "OUTSIDE_CALLING_HOURS") {
      // Not a real error — this endpoint is a plain existence check,
      // reusing getNextLead()'s own logic (including its calling-hours
      // enforcement) rather than duplicating it. Outside calling
      // hours correctly means "no, don't show as dialable right now,"
      // same as genuinely having zero leads — not a 500.
      return res.json({ success: true, hasLead: false, code: "OUTSIDE_CALLING_HOURS" });
    }
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
    if (error.code === "OUTSIDE_CALLING_HOURS") {
      return res.status(403).json({ success: false, message: error.message, code: "OUTSIDE_CALLING_HOURS" });
    }
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
      `
        SELECT c.campaign_cid, s.campaign_type
        FROM asterisk.vicidial_campaigns c
        LEFT JOIN cmx_dialer.campaign_settings s ON s.campaign_id = c.campaign_id
        WHERE c.campaign_id = ? AND c.active = 'Y'
      `,
      [campaignId]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ success: false, message: "Campaign not found or inactive." });
    }

    const { campaign_cid: campaignCid, campaign_type: campaignType } = campaignRows[0];
    const { appUserId, username: agentUser, extension: agentExtension } = req.session.agent;

    // Per explicit request — AMD must only run on OUTBOUND campaigns
    // dialing a real lead from the hopper. Two things exclude it:
    // BLENDED campaigns entirely, and manual dial specifically — the
    // frontend's own manual-dial path (DialerPage.jsx) sends
    // leadId=0 as its sentinel value precisely because there's no
    // real lead row backing it (see handleManualDial), so that's the
    // correct, existing signal to check here rather than inventing a
    // new one.
    const shouldRunAmd = campaignType === "OUTBOUND" && Number(leadId) !== 0;

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
      shouldRunAmd,
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
    //
    // REAL BUG FIX, confirmed live: this call didn't pass
    // relatedCampaignId at all. dialerService.js's own saveDisposition
    // ALSO independently called setStatus("READY", {relatedCampaignId})
    // right before this ran — meaning every disposition save created
    // TWO status rows within the same request, milliseconds apart: one
    // correctly tagged, immediately overwritten by this one without a
    // tag. Net effect: the agent's real, final status row always ended
    // up with related_campaign_id = NULL, making them permanently
    // unmatchable for that campaign's inbound calls despite showing
    // Ready. Fixed by making THIS call (the original, authoritative
    // one — it's what supports setNotReady) correctly tag the
    // campaign, and removing the now-redundant duplicate from
    // saveDisposition() itself (see that function's own comment).
    try {
      await agentStatusService.setStatus(appUserId, setNotReady ? "NOT_READY" : "READY", {
        relatedCampaignId: campaignId,
      });
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

    // Server-side enforcement — the frontend already restricts this
    // field to digits-only/10-max as the person types, but that's a
    // UX nicety, not a guarantee; this is the actual enforcement point
    // for anything hitting this endpoint directly. Requires a plain
    // 10-digit US number, no country code, no formatting characters —
    // matches what the dialplan/Originate flow elsewhere in this app
    // already expects a callback number to look like.
    if (callbackNumber && !/^\d{10}$/.test(callbackNumber)) {
      return res.status(400).json({
        success: false,
        message: "callbackNumber must be exactly 10 digits (US number, no country code).",
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
           disposition, callback_at, callback_number, call_started_at, call_ended_at, wait_seconds,
           xfer_conf, xfer_conf_target)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agentUser, inboundCampaignId, callId, callerIdNumber || null, firstName || null, lastName || null,
        comments.trim(), disposition, callbackAt || null, callbackNumber || null, startedAt, endedAt, waitSeconds,
        current && current.xferConfTarget ? "Y" : "N", (current && current.xferConfTarget) || null,
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

/*
==================================================
RECORDINGS — list (filtered) + on-demand playback URL
==================================================

Same "UNION dialer_call_log + inbound_call_log, wrap in a subquery,
filter the outer query" pattern already used by GET /total-calls above
— only rows with a real recording_key are included at all (a call that
was never recorded has nothing to list here). agentName filters on
app_users.full_name via LIKE, not an exact match — lets an admin type
a partial name rather than needing the exact ViciDial username.

Does NOT return a playback URL directly — S3 URLs are time-limited
presigned links (1 hour expiry, see recordingUploadService.js), so
generating one for every row on every list load would be wasteful and
mostly expire unused. The frontend calls the second route below,
on-demand, only when an admin actually clicks Play on a specific row.
==================================================
*/
router.get("/recordings", requireRoles(...RECORDINGS_ROLES), requireCampaignAccess, async (req, res) => {
  try {
    const { startDate, endDate, campaignId, agentName } = req.query;

    const params = [];
    let dateFilter = "";
    if (startDate) {
      dateFilter += " AND combined.call_started_at >= ?";
      params.push(`${startDate} 00:00:00`);
    }
    if (endDate) {
      dateFilter += " AND combined.call_started_at <= ?";
      params.push(`${endDate} 23:59:59`);
    }

    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = " AND combined.campaign_id = ?";
      params.push(campaignId);
    }

    let agentFilter = "";
    if (agentName) {
      agentFilter = " AND combined.agent_name LIKE ?";
      params.push(`%${agentName}%`);
    }

    const [rows] = await db.execute(
      `
        SELECT combined.call_id, combined.campaign_id, combined.agent_user, combined.agent_name,
               combined.phone_number, combined.call_started_at, combined.call_ended_at,
               combined.direction, combined.recording_key, combined.disposition, combined.comments,
               combined.first_name, combined.last_name, combined.callback_at, combined.wait_seconds
        FROM (
          SELECT
            d.call_id, d.campaign_id, d.agent_user, au.full_name AS agent_name,
            d.phone_number, d.call_started_at, d.call_ended_at, d.recording_key, 'outbound' AS direction,
            d.disposition, d.comments, d.first_name, d.last_name, d.callback_at, NULL AS wait_seconds
          FROM cmx_dialer.dialer_call_log d
          LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = d.agent_user
          WHERE d.recording_key IS NOT NULL

          UNION ALL

          SELECT
            i.call_id, i.campaign_id, i.agent_user, au.full_name AS agent_name,
            i.caller_id_number AS phone_number, i.call_started_at, i.call_ended_at, i.recording_key, 'inbound' AS direction,
            i.disposition, i.comments, i.first_name, i.last_name, i.callback_at, i.wait_seconds
          FROM cmx_dialer.inbound_call_log i
          LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = i.agent_user
          WHERE i.recording_key IS NOT NULL
        ) combined
        WHERE 1=1 ${dateFilter} ${campaignFilter} ${agentFilter}
        ORDER BY combined.call_started_at DESC
        LIMIT 200
      `,
      params
    );

    return res.json({ success: true, recordings: rows });
  } catch (error) {
    console.error("GET /api/recordings failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load recordings." });
  }
});

/*
==================================================
GET /api/recordings/:callId/playback-url
==================================================
Generates a fresh, 1-hour presigned URL on demand — the callId is
looked up against BOTH tables (a callId is a UUID, unique regardless
of which table it came from) since the caller doesn't know/care which
direction it was.
==================================================
*/
router.get("/recordings/:callId/playback-url", requireRoles(...RECORDINGS_ROLES), async (req, res) => {
  try {
    const { callId } = req.params;

    // Now also selects campaign_id — needed for the ownership check
    // below. Can't use requireCampaignAccess middleware here the way
    // the list route does: this route takes a :callId path param, not
    // a ?campaignId query param, so which campaign this specific call
    // belongs to has to come from the DB lookup itself, not the
    // request.
    const [rows] = await db.execute(
      `
        SELECT recording_key, campaign_id FROM cmx_dialer.dialer_call_log WHERE call_id = ? AND recording_key IS NOT NULL
        UNION ALL
        SELECT recording_key, campaign_id FROM cmx_dialer.inbound_call_log WHERE call_id = ? AND recording_key IS NOT NULL
        LIMIT 1
      `,
      [callId, callId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "No recording found for this call." });
    }

    const { accessLevel, appUserId } = req.session.agent;
    if (!UNRESTRICTED_CAMPAIGN_ROLES.includes(accessLevel)) {
      const assignedIds = await getAssignedCampaignIds(appUserId);
      if (!assignedIds.includes(rows[0].campaign_id)) {
        return res.status(403).json({ success: false, message: "You are not assigned to that campaign." });
      }
    }

    const url = await recordingUploadService.getPlaybackUrl(rows[0].recording_key);
    return res.json({ success: true, url });
  } catch (error) {
    console.error(`GET /api/recordings/${req.params.callId}/playback-url failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to generate playback URL." });
  }
});

/*
==================================================
GET /api/recordings/:callId/download-url
==================================================
Per explicit request — admin-only. Mirrors playback-url's own lookup
and campaign-ownership check exactly, but requireRoles here is
narrowed to just "admin" (not the full RECORDINGS_ROLES list) — every
other role can still play recordings via the route above, just not
download them.
==================================================
*/
router.get("/recordings/:callId/download-url", requireRoles("admin"), async (req, res) => {
  try {
    const { callId } = req.params;

    const [rows] = await db.execute(
      `
        SELECT recording_key, campaign_id FROM cmx_dialer.dialer_call_log WHERE call_id = ? AND recording_key IS NOT NULL
        UNION ALL
        SELECT recording_key, campaign_id FROM cmx_dialer.inbound_call_log WHERE call_id = ? AND recording_key IS NOT NULL
        LIMIT 1
      `,
      [callId, callId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "No recording found for this call." });
    }

    const { accessLevel, appUserId } = req.session.agent;
    if (!UNRESTRICTED_CAMPAIGN_ROLES.includes(accessLevel)) {
      const assignedIds = await getAssignedCampaignIds(appUserId);
      if (!assignedIds.includes(rows[0].campaign_id)) {
        return res.status(403).json({ success: false, message: "You are not assigned to that campaign." });
      }
    }

    const url = await recordingUploadService.getDownloadUrl(rows[0].recording_key, `${callId}.wav`);
    return res.json({ success: true, url });
  } catch (error) {
    console.error(`GET /api/recordings/${req.params.callId}/download-url failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to generate download URL." });
  }
});

module.exports = router;