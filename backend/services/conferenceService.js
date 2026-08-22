"use strict";

const crypto = require("crypto");
const ami = require("../config/ami");

/*
==================================================
conferenceService — Phase E (Conference / Transfer)
==================================================
NOT YET CONFIRMED against a real test call. Built by mirroring the
existing, proven Originate + AMI-event-matching pattern already used
in dialerService.js's customer-leg fix (matching ConfbridgeJoin by
room), but this specific primitive — Originate directly into
Application: "ConfBridge" with an ActionID matched via
OriginateResponse — has NOT been exercised live yet. Flagging this
explicitly rather than presenting it as tested: the AMI event field
names assumed below (evt.actionid, evt.response, evt.channel) follow
the same lowercased-field convention documented in config/ami.js for
other events, but that convention hasn't been specifically re-verified
for OriginateResponse. Expect this to need live debugging, the same
as every other Asterisk-facing change tonight did.

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
  routes as PJSIP/${target}@CMXSandbox (out through the trunk).
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

    ami
      .originate({
        ActionID: actionId,
        Channel: isExtension ? `PJSIP/${target}` : `PJSIP/${target}@CMXSandbox`,
        Application: "ConfBridge",
        Data: `${room},vici_agent_bridge,vici_agent_user`,
        CallerID: `"${callerIdLabel}" <${room}>`,
        Async: "true",
      })
      .catch(() => {
        finish({ success: false, reason: "originate_request_failed" });
      });
  });
}

module.exports = { addParticipant };
