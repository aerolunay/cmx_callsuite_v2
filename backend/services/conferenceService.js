"use strict";

const crypto = require("crypto");
const ami = require("../config/ami");

/*
==================================================
conferenceService — Phase E (Conference / Transfer)
==================================================
REAL BUG FOUND AND FIXED (round 2), confirmed via a real test call:
Conference actually worked correctly at the Asterisk level — the
target rang, answered, and joined the room — but the frontend still
reported "didn't answer or couldn't be reached." Root cause: this
function's success/failure detection relied entirely on
OriginateResponse's evt.response === "Success". That's a reasonable
signal for a DIRECT PJSIP-endpoint Originate (the isExtension: true
case, which was never broken), but NOT for the Context/Exten/Priority
style Originate now used for external numbers (see the earlier fix
above) — OriginateResponse for that kind of Originate reports success
once the LOCAL CHANNEL itself is created and dialplan execution
begins, NOT once the dialplan's own Dial() actually completes and the
far end answers. The two events are asynchronous and unrelated in
timing; the real call succeeding afterward doesn't change what
OriginateResponse already reported.

Fixed by switching detection to ConfbridgeJoin — the exact same,
proven mechanism dialerService.js's own outbound customer-leg already
relies on for exactly this reason. Listens for a NEW join on the same
room, excluding whichever channels are already known to be in it
(agentChannel/customerChannel, passed in by the caller) so this
doesn't false-positive on an EXISTING participant's already-logged
join event.

addParticipant(room, target, isExtension, callerIdLabel, excludeChannels)
Originates a new channel directly into the SAME live ConfBridge room a
call is already in. Works identically whether the call is outbound or
inbound, since both already converge on a shared room/ConfBridge
model — this is why it lives in its own file rather than being
duplicated inside dialerService.js and inboundCallService.js
separately.

- target: a bare extension (e.g. "bsmsc902") for another agent, OR a
  10-digit phone number for an outside line (routed via the same
  CMXSandbox trunk the app's own outbound Originate already uses).
- isExtension: true routes Channel as PJSIP/${target} directly; false
  routes through Local/${room}@trunkinbound with Exten=target, exactly
  like the proven outbound customer-leg pattern.
- excludeChannels: channel names ALREADY known to be in this room
  (agent + customer) — needed so the ConfbridgeJoin listener doesn't
  mistake one of THEIR (already-logged) joins for the NEW participant
  we're actually waiting on.
- Resolves { success: true, channel } once the target ANSWERS and
  joins the room, or { success: false, reason } if they don't answer
  within ORIGINATE_TIMEOUT_MS or the Originate itself fails outright.
==================================================
*/

const ORIGINATE_TIMEOUT_MS = 30000;

function addParticipant(room, target, isExtension, callerIdLabel, excludeChannels = [], campaignCid = null) {
  return new Promise((resolve) => {
    const actionId = crypto.randomUUID();
    let settled = false;

    // REAL BUG FIX, confirmed live via a real test call: this used to
    // always use the internal ConfBridge room number itself as the
    // Caller ID number — not a real, authorized DID on the account at
    // all. QuestBlue's SBC correctly rejected every such call with a
    // genuine SIP 403 Forbidden, surfaced misleadingly by Asterisk as
    // "Everyone is busy/congested" (see attendedTransferService.js's
    // own comment on this — same root cause as the regular-outbound
    // Caller ID bug, different call site, much harder to spot since
    // it looked like a trunk-concurrency issue). Falls back to room
    // only if campaignCid genuinely isn't available — better than
    // crashing, but every real caller should be passing this now.
    const callerIdNumber = campaignCid || room;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ami.events.removeListener("ConfbridgeJoin", onJoin);
      ami.events.removeListener("OriginateResponse", onOriginateFailure);
      resolve(result);
    }

    const timeout = setTimeout(() => {
      finish({ success: false, reason: "timeout" });
    }, ORIGINATE_TIMEOUT_MS);

    // Real success signal — a genuinely NEW channel joining this
    // exact room, not one already known to be in it.
    function onJoin(evt) {
      if (evt.conference !== room) return;
      if (excludeChannels.includes(evt.channel)) return;
      finish({ success: true, channel: evt.channel });
    }

    // Still worth listening for an outright Originate FAILURE (e.g.
    // invalid channel string, endpoint not found) — that genuinely
    // means nothing will ever ring, so no reason to wait out the full
    // timeout for those. A "Success" response here does NOT mean the
    // far end answered (see comment above) — only onJoin does.
    function onOriginateFailure(evt) {
      if (evt.actionid !== actionId) return;
      if (evt.response === "Success") return;
      finish({ success: false, reason: evt.reason || "originate_failed" });
    }

    ami.events.on("ConfbridgeJoin", onJoin);
    ami.events.on("OriginateResponse", onOriginateFailure);

    const originateParams = isExtension
      ? {
          ActionID: actionId,
          Channel: `PJSIP/${target}`,
          Application: "ConfBridge",
          Data: `${room},vici_agent_bridge,vici_agent_user`,
          CallerID: `"${callerIdLabel}" <${callerIdNumber}>`,
          Async: "true",
        }
      : {
          ActionID: actionId,
          Channel: `Local/${room}@trunkinbound`,
          Context: "trunkinbound",
          Exten: target,
          Priority: 1,
          CallerID: `"${callerIdLabel}" <${callerIdNumber}>`,
          Async: "true",
        };

    ami.originate(originateParams).catch(() => {
      finish({ success: false, reason: "originate_request_failed" });
    });
  });
}

module.exports = { addParticipant };