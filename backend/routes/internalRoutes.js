"use strict";

const crypto = require("crypto");
const express = require("express");
const db = require("../config/db");
const inboundCallService = require("../services/inboundCallService");

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
  const { secret, did } = req.query;

  if (!isValidSecret(secret)) {
    console.warn("[internalRoutes] Rejected allocate-inbound-room call with an invalid/missing secret.");
    return res.status(403).type("text/plain").send("");
  }

  if (!did) {
    console.warn("[internalRoutes] Rejected allocate-inbound-room call with no did param.");
    return res.status(400).type("text/plain").send("");
  }

  try {
    const room = await inboundCallService.allocateInboundRoom(did);
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
      `,
      [campaignId]
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

module.exports = router;