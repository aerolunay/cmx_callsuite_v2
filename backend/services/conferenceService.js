"use strict";

const crypto = require("crypto");
const ami = require("../config/ami");

/*
==================================================
conferenceService — Phase E (Conference / Transfer)
==================================================
REAL BUG FOUND AND FIXED HERE, confirmed via a real test call: the
external-number case (isExtension: false) used to Originate directly
as `PJSIP/${target}@CMXSandbox` — going straight to the trunk,
bypassing the dialplan entirely. The target's phone never rang. The
PROVEN, working outbound customer-leg pattern (dialerService.js's own
Originate for "Dial Next Number") never does this — it goes through
`Local/${room}@trunkinbound`, letting the dialplan's own
`_NXXNXXXXXX`/`_1NXXNXXXXXX` extension-matching handle the actual
trunk egress (CID, number formatting, whatever else that pattern does)
before the call ever reaches CMXSandbox. This function now mirrors
that exact pattern for the external-number case — same Channel
convention, same Context/Exten/Priority shape — rather than a raw
direct-to-trunk Originate.

The isExtension: true case (adding another AGENT's extension, not an
external number) is UNCHANGED — a direct `PJSIP/${target}` Originate
is correct there; a bare internal extension never needs to go through
the outbound trunk/dialplan at all, and this case wasn't reported as
broken.

addParticipant(room, target, isExtension, callerIdLabel) — Originates
a new channel directly into the SAME live ConfBridge room a call is
already in. Works identically whether the call is outbound or inbound,
since both already converge on a shared room/ConfBridge model — this
is why it lives in its own file rather than being duplicated inside
dialerService.js and inboundCallService.js separately.

- target: a bare extension (e.g. "bsmsc902") for another agent, OR a
  10-digit phone number for an outside line (routed via the same
  CMXSandbox trunk the app's own outbound Originate already uses).
- isExtension: true routes Channel as PJSIP/${target} directly; false
  routes through Local/${room}@trunkinbound with Exten=target, exactly
  like the proven outbound customer-leg pattern.
- Resolves { success: true, channel } once the target ANSWERS and
  joins the room, or { success: false, reason } if they don't answer
  within ORIGINATE_TIMEOUT_MS or the Originate itself fails outright.
==================================================
*/

const ORIGINATE_TIMEOUT_MS = 30000;

function addParticipant(room, target, isExtension, callerIdLabel) {
  return new Promise((resolve) => {
    const actionId = crypto.randomUUID();
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ami.events.removeListener("OriginateResponse", onResponse);
      resolve(result);
    }

    const timeout = setTimeout(() => {
      finish({ success: false, reason: "timeout" });
    }, ORIGINATE_TIMEOUT_MS);

    function onResponse(evt) {
      if (evt.actionid !== actionId) return;
      finish({
        success: evt.response === "Success",
        channel: evt.channel,
        reason: evt.response !== "Success" ? evt.reason : undefined,
      });
    }

    ami.events.on("OriginateResponse", onResponse);

    const originateParams = isExtension
      ? {
          ActionID: actionId,
          Channel: `PJSIP/${target}`,
          Application: "ConfBridge",
          Data: `${room},vici_agent_bridge,vici_agent_user`,
          CallerID: `"${callerIdLabel}" <${room}>`,
          Async: "true",
        }
      : {
          ActionID: actionId,
          Channel: `Local/${room}@trunkinbound`,
          Context: "trunkinbound",
          Exten: target,
          Priority: 1,
          CallerID: `"${callerIdLabel}" <${room}>`,
          Async: "true",
        };

    ami.originate(originateParams).catch(() => {
      finish({ success: false, reason: "originate_request_failed" });
    });
  });
}

module.exports = { addParticipant };