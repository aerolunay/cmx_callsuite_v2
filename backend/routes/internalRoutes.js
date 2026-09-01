"use strict";

const crypto = require("crypto");
const express = require("express");
const db = require("../config/db");
const inboundCallService = require("../services/inboundCallService");
const dialerService = require("../services/dialerService");

const router = express.Router();

/*
==================================================
INTERNAL ROUTES
==================================================
Called directly by Asterisk's dialplan via CURL() — NOT by the
frontend, and NOT behind session/cookie auth, since Asterisk can't
participate in that. Protected instead by a shared secret
(INTERNAL_API_SECRET in .env) compared in constant time to avoid a
timing side-channel on the comparison itself.

Deliberately mounted at /internal, not /api/internal — keeps it
visually and structurally distinct from every session-authenticated
route in dialerRoutes.js/adminRoutes.js.
==================================================
*/

function isValidSecret(provided) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected || !provided) return false;

  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(expected);

  // timingSafeEqual throws if the buffers differ in length — that's
  // still a safe "not equal" outcome, just needs a length check first
  // rather than letting it throw.
  if (providedBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/*
==================================================
GET /internal/allocate-inbound-room?secret=...&did=...
==================================================
Called the INSTANT a call arrives, from the dialplan, BEFORE the
caller is ever put in a ConfBridge — see the dialplan snippet in the
handoff notes. Returns the allocated room as a plain-text body (what
Asterisk's CURL() expects to drop straight into a channel variable) —
NOT JSON, deliberately, since there's no dialplan-side JSON parsing.

Responds with an EMPTY body (not an error page) on any failure — an
unknown DID, a missing/wrong secret, or the room pool being exhausted
all just mean "no room" as far as the dialplan is concerned, and the
dialplan should treat an empty ROOM variable as "can't take this call
right now" (see the GotoIf($["${ROOM}" = ""]?no_room) line in the
snippet) rather than trying to ConfBridge into an empty string.
==================================================
*/
router.get("/allocate-inbound-room", async (req, res) => {
  const { secret, did, campaignId } = req.query;

  if (!isValidSecret(secret)) {
    console.warn("[internalRoutes] Rejected allocate-inbound-room call with an invalid/missing secret.");
    return res.status(403).type("text/plain").send("");
  }

  if (!did) {
    console.warn("[internalRoutes] Rejected allocate-inbound-room call with no did param.");
    return res.status(400).type("text/plain").send("");
  }

  try {
    // campaignId, when present, is a fallback override for an
    // OUTBOUND campaign's DID redirecting to a BLENDED campaign's own
    // queue — see campaignRoutes.js's dialplan generation and
    // 006_add_blended_fallback_campaign.sql.
    const room = await inboundCallService.allocateInboundRoom(did, campaignId || undefined);
    return res.type("text/plain").send(room);
  } catch (err) {
    console.error(`[internalRoutes] Failed to allocate an inbound room for DID ${did}:`, err.message);
    return res.status(500).type("text/plain").send("");
  }
});

/*
==================================================
GET /internal/campaign-has-logged-in-agent?secret=...&campaignId=...
==================================================
Called from the dialplan, right after the business-hours check passes
but BEFORE room allocation, to decide whether to route into the normal
agent queue at all or forward straight to an external number instead.

"Logged in" here means ANY open (ended_at IS NULL) agent_status_log
row for an agent assigned to this campaign — regardless of WHICH
status (READY, NOT_READY, IN_CALL, etc.). This is deliberately a much
coarser, steadier signal than "currently Ready" — an agent's Ready/Not
Ready status can flip every few seconds, but whether they're logged
into the app at all doesn't, which is exactly why this check is
appropriate for a dialplan decision made once per call rather than a
real-time queue routing decision.

Returns plain text "1" or "0" — same convention as
allocate-inbound-room, since Asterisk's CURL() has no JSON parsing.
==================================================
*/
router.get("/campaign-has-logged-in-agent", async (req, res) => {
  const { secret, campaignId } = req.query;

  if (!isValidSecret(secret)) {
    console.warn("[internalRoutes] Rejected campaign-has-logged-in-agent call with an invalid/missing secret.");
    return res.status(403).type("text/plain").send("0");
  }
  if (!campaignId) {
    console.warn("[internalRoutes] Rejected campaign-has-logged-in-agent call with no campaignId param.");
    return res.status(400).type("text/plain").send("0");
  }

  try {
    const [rows] = await db.execute(
      `
        SELECT COUNT(*) AS n
        FROM cmx_dialer.agent_status_log asl
        JOIN cmx_dialer.agent_campaign_assignments aca
          ON aca.app_user_id = asl.app_user_id AND aca.active = 1
        WHERE aca.campaign_id = ? AND asl.ended_at IS NULL
          AND asl.related_campaign_id = ?
      `,
      [campaignId, campaignId]
    );
    const hasLoggedInAgent = rows[0].n > 0;
    return res.type("text/plain").send(hasLoggedInAgent ? "1" : "0");
  } catch (err) {
    console.error(`[internalRoutes] Failed to check logged-in agents for campaign ${campaignId}:`, err.message);
    // Fail OPEN here (assume an agent IS logged in) rather than
    // silently forwarding every call externally the moment this query
    // has a problem — an unnecessary queue-routed call is a much
    // smaller failure mode than accidentally forwarding everything.
    return res.status(500).type("text/plain").send("1");
  }
});

/*
==================================================
GET /internal/dial-result?secret=...&room=...&dialstatus=...&amdstatus=...
==================================================
Called from the dialplan the moment Dial() on the customer leg
returns, for EVERY outbound attempt — not just answered ones. See
dialerService.js's handleAutomaticDialOutcome for the full design
rationale (AMD Phase 1 + the data foundation for Phase 2's future
max-attempts enforcement, per explicit request).

Only three combinations of these two params actually mean anything
here; everything else (a normal human answer) is deliberately a
no-op — that call already bridged to the agent via the dialplan's own
ConfBridge() line, and its disposition is handled entirely normally,
completely unrelated to this route.
==================================================
*/
router.get("/dial-result", async (req, res) => {
  const { secret, room, dialstatus, amdstatus } = req.query;

  if (!isValidSecret(secret)) {
    console.warn("[internalRoutes] Rejected dial-result call with an invalid/missing secret.");
    return res.status(403).type("text/plain").send("");
  }
  if (!room) {
    console.warn("[internalRoutes] Rejected dial-result call with no room param.");
    return res.status(400).type("text/plain").send("");
  }

  let outcomeType = null;
  if (dialstatus === "ANSWER" && amdstatus === "MACHINE") {
    outcomeType = "machine";
  } else if (dialstatus === "BUSY") {
    outcomeType = "busy";
  } else if (dialstatus === "NOANSWER" || dialstatus === "CONGESTION" || dialstatus === "CHANUNAVAIL") {
    outcomeType = "no_answer";
  }
  // Anything else (ANSWER + HUMAN/NOTSURE/blank, or an unrecognized
  // DIALSTATUS this app hasn't seen before) — deliberately do nothing.
  // A real human connection already bridged to the agent normally;
  // an unrecognized status is safer left alone than guessed at.

  if (outcomeType) {
    try {
      await dialerService.handleAutomaticDialOutcome(room, outcomeType);
    } catch (err) {
      console.error(`[internalRoutes] handleAutomaticDialOutcome failed for room ${room} (${outcomeType}):`, err.message);
    }
  }

  return res.type("text/plain").send("");
});

/*
==================================================
GET /internal/customer-waiting?secret=...&room=...&channel=...&callerId=...
==================================================
NEW — voicemail feature. Called from the dialplan's voicemail
wait-loop, the moment the caller enters it — BEFORE they're ever in a
ConfBridge. Same "tell the backend before the real event happens" idea
as allocate-inbound-room, needed here because a voicemail-enabled
campaign's caller doesn't generate a ConfbridgeJoin event until
inboundCallService.js actively redirects them in once an agent is
found.
==================================================
*/
router.get("/customer-waiting", async (req, res) => {
  const { secret, room, channel, callerId } = req.query;

  if (!isValidSecret(secret)) {
    console.warn("[internalRoutes] Rejected customer-waiting call with an invalid/missing secret.");
    return res.status(403).type("text/plain").send("");
  }
  if (!room || !channel) {
    console.warn("[internalRoutes] Rejected customer-waiting call with missing room/channel.");
    return res.status(400).type("text/plain").send("");
  }

  try {
    inboundCallService.customerEnteredWaitLoop(room, channel, callerId || null);
  } catch (err) {
    console.error(`[internalRoutes] customerEnteredWaitLoop failed for room ${room}:`, err.message);
  }

  return res.type("text/plain").send("");
});

/*
==================================================
GET /internal/voicemail-starting?secret=...&room=...
==================================================
NEW — voicemail feature. Called right before the dialplan's Record()
step starts, business-hours path only (an after-hours voicemail never
has a room/inboundCalls entry at all — see allocateInboundRoom's usual
flow, which after-hours voicemail skips entirely). Flips the call to
"leaving_voicemail" so a Hangup mid-recording is never mistaken for an
abandoned call, and so tryConnectReadyAgentsInner's own "waiting"
filter stops considering this call at all — it's busy, not abandoned.
==================================================
*/
router.get("/voicemail-starting", async (req, res) => {
  const { secret, room } = req.query;

  if (!isValidSecret(secret)) {
    console.warn("[internalRoutes] Rejected voicemail-starting call with an invalid/missing secret.");
    return res.status(403).type("text/plain").send("");
  }
  if (!room) {
    console.warn("[internalRoutes] Rejected voicemail-starting call with no room param.");
    return res.status(400).type("text/plain").send("");
  }

  try {
    inboundCallService.markLeavingVoicemail(room);
  } catch (err) {
    console.error(`[internalRoutes] markLeavingVoicemail failed for room ${room}:`, err.message);
  }

  return res.type("text/plain").send("");
});

/*
==================================================
GET /internal/voicemail-recorded?secret=...&campaignId=...&callerId=...&isAfterHours=0|1&room=...&uniqueId=...
==================================================
NEW — voicemail feature. Called once the caller has confirmed they're
satisfied with the recording (pressed 1 at the confirmation prompt, or
timed out/pressed something unrecognized — see buildCampaignDialplanBlock's
comment on why that defaults to "save" rather than discarding the
message). room is present for the business-hours path (drives
inboundCalls Map cleanup); uniqueId is present for the after-hours path
instead (no Map entry to clean up there at all). Upload-to-S3 + a
voicemail_log insert happens inside inboundCallService.recordVoicemail.
==================================================
*/
router.get("/voicemail-recorded", async (req, res) => {
  const { secret, campaignId, callerId, isAfterHours, room, uniqueId } = req.query;

  if (!isValidSecret(secret)) {
    console.warn("[internalRoutes] Rejected voicemail-recorded call with an invalid/missing secret.");
    return res.status(403).type("text/plain").send("");
  }
  if (!campaignId || (!room && !uniqueId)) {
    console.warn("[internalRoutes] Rejected voicemail-recorded call with missing campaignId/room/uniqueId.");
    return res.status(400).type("text/plain").send("");
  }

  try {
    await inboundCallService.recordVoicemail({
      room: room || null,
      uniqueId: uniqueId || null,
      campaignId,
      callerIdNumber: callerId || null,
      isAfterHours: isAfterHours === "1",
    });
  } catch (err) {
    console.error(`[internalRoutes] recordVoicemail failed for campaign ${campaignId}:`, err.message);
  }

  return res.type("text/plain").send("");
});

module.exports = router;