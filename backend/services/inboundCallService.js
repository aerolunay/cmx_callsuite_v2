"use strict";

const crypto = require("crypto");
const ami = require("../config/ami");
const ws = require("../config/ws");
const agentStatusService = require("./agentStatusService");

/*
==================================================
INBOUND CALL SERVICE — v1
==================================================
Bypasses ViciDial's own agi-DID_route.agi / Inbound Group / IVR
routing entirely (see the dialplan changes: this DID now Answers +
ConfBridges directly, never reaching ViciDial's AGI script).

REAL v1 LIMITATIONS, named plainly rather than hidden:
  - Single fixed room (9700000) — only one concurrent inbound call is
    supported.
  - No caller-experience polish — no hold music, no queue position.
  - No timeout/voicemail fallback if no agent ever becomes READY.
  - Picks the FIRST ready agent found, no ranking/priority.

IMPORTANT: unlike the first version of this file, the inboundCall
record is NOT cleared the instant the call ends — a real bug found
during testing, where the record (and the caller's phone number) was
gone before the agent ever got to see it or submit the intake form.
It now stays around in an "ended" state until the disposition is
actually saved (see finalizeInboundCall below), which is the only
thing that clears it and returns the agent to READY.
==================================================
*/

const INBOUND_ROOM = "9700000";

// v1 limitation: inbound calls only ever arrive via ONE hardcoded DID.
// This is why every inbound call gets tagged with this fixed campaign
// — NOT a general multi-campaign solution. CMXBSMSC is now the
// prioritized campaign for this DID (CMXBSM is meant to be pure
// outbound going forward) — this constant is the ONLY thing that
// determines that on our side, since this bypass never reads
// ViciDial's own DID/Ingroup/closer_campaigns linkage at all. Revisit
// this constant (and the whole single-DID assumption) the moment a
// second campaign gets its own real inbound DID.
const INBOUND_CAMPAIGN_ID = "CMXBSMSC";

// null when no inbound call is in progress or awaiting disposition.
// { callId, status, customerChannel, agentChannel, callerIdNumber,
//   pendingAppUserId, pendingAgentExtension, connectedAppUserId,
//   onHold, startedAt, endedAt }
let inboundCall = null;

function broadcastInboundStatus() {
  if (!inboundCall) return;
  const targetAppUserId = inboundCall.pendingAppUserId || inboundCall.connectedAppUserId;
  if (!targetAppUserId) return;

  ws.broadcastToUser(targetAppUserId, {
    type: "inboundCall",
    status: inboundCall.status,
    room: INBOUND_ROOM,
    callerIdNumber: inboundCall.callerIdNumber,
    onHold: inboundCall.onHold,
  });
}

async function tryConnectReadyAgent() {
  if (!inboundCall || inboundCall.status !== "waiting_for_agent") return;

  let agent;
  try {
    agent = await agentStatusService.getAnyReadyAgentWithExtension();
  } catch (err) {
    console.error("[inboundCallService] Failed to look up a ready agent:", err.message);
    return;
  }

  // The call may have ended (caller hung up) while we were waiting on
  // the DB lookup above — confirmed to actually happen during testing
  // (a hangup arrived ~300ms after join, racing this async query).
  if (!inboundCall || inboundCall.status !== "waiting_for_agent") return;

  if (!agent) return; // still nobody ready — will retry on the next READY transition

  inboundCall.status = "ringing_agent";
  inboundCall.pendingAppUserId = agent.appUserId;
  inboundCall.pendingAgentExtension = agent.extension;

  try {
    await agentStatusService.setStatus(agent.appUserId, "IN_CALL", { relatedCallDirection: "inbound", relatedCampaignId: inboundCall.campaignId });
  } catch (err) {
    console.error("[inboundCallService] Failed to set IN_CALL for inbound-answering agent:", err.message);
  }

  if (!inboundCall) return;

  broadcastInboundStatus();

  try {
    await ami.originate({
      Channel: `PJSIP/${agent.extension}`,
      Context: "default",
      Exten: `2${INBOUND_ROOM}`,
      Priority: 1,
      CallerID: `"Inbound Caller" <${INBOUND_ROOM}>`,
      Async: "true",
    });
  } catch (err) {
    console.error("[inboundCallService] Failed to originate agent leg for inbound call:", err.message);

    if (!inboundCall) return;

    inboundCall.status = "waiting_for_agent";
    inboundCall.pendingAppUserId = null;
    inboundCall.pendingAgentExtension = null;
  }
}

// Marks the call ended (customer/agent left or hung up) and flips the
// agent to AFTER_CALL_WORK. Also explicitly hangs up whichever leg is
// still connected — confirmed necessary for outbound calls tonight
// (one party leaving does NOT auto-close a ConfBridge room), and even
// more important here since inbound reuses a single FIXED room: a
// lingering channel left behind by whichever side didn't initiate the
// hangup could otherwise collide with the next inbound call.
//
// Does NOT clear inboundCall — that only happens once the disposition
// is actually saved (finalizeInboundCall), so the agent still has
// access to caller info while filling out the intake form.
async function endInboundCall() {
  if (!inboundCall || inboundCall.status === "ended") return;

  const appUserId = inboundCall.connectedAppUserId || inboundCall.pendingAppUserId;
  inboundCall.status = "ended";
  inboundCall.endedAt = new Date();
  broadcastInboundStatus();

  const hangups = [];
  if (inboundCall.customerChannel) {
    hangups.push(
      ami.hangupChannel(inboundCall.customerChannel).catch((err) => {
        console.error(`[inboundCallService] Failed to hang up customer channel ${inboundCall.customerChannel}:`, err.message);
      })
    );
  }
  if (inboundCall.agentChannel) {
    hangups.push(
      ami.hangupChannel(inboundCall.agentChannel).catch((err) => {
        console.error(`[inboundCallService] Failed to hang up agent channel ${inboundCall.agentChannel}:`, err.message);
      })
    );
  }
  await Promise.all(hangups);

  if (appUserId) {
    try {
      await agentStatusService.setStatus(appUserId, "AFTER_CALL_WORK", { relatedCallDirection: "inbound", relatedCampaignId: inboundCall.campaignId });
    } catch (err) {
      console.error("[inboundCallService] Failed to set AFTER_CALL_WORK after inbound call:", err.message);
    }
  }
}

function registerInboundEventTracking() {
  ami.events.on("ConfbridgeJoin", (evt) => {
    if (evt.conference !== INBOUND_ROOM) return;

    if (!inboundCall) {
      // First join into this room with no call tracked — the customer
      // (the DID's dialplan Answers + ConfBridges them in directly).
      // calleridnum is present directly on the ConfbridgeJoin event
      // itself — confirmed from a real test call trace.
      inboundCall = {
        callId: crypto.randomUUID(),
        campaignId: INBOUND_CAMPAIGN_ID,
        status: "waiting_for_agent",
        customerChannel: evt.channel,
        agentChannel: null,
        callerIdNumber: evt.calleridnum || null,
        pendingAppUserId: null,
        pendingAgentExtension: null,
        connectedAppUserId: null,
        onHold: false,
        startedAt: new Date(),
        endedAt: null,
      };
      tryConnectReadyAgent();
      return;
    }

    if (evt.channel === inboundCall.customerChannel) return;

    if (inboundCall.status === "ringing_agent") {
      inboundCall.agentChannel = evt.channel;
      inboundCall.connectedAppUserId = inboundCall.pendingAppUserId;
      inboundCall.pendingAppUserId = null;
      inboundCall.status = "agent_connected";
      broadcastInboundStatus();
    }
  });

  ami.events.on("ConfbridgeLeave", (evt) => {
    if (!inboundCall) return;
    if (evt.conference !== INBOUND_ROOM) return;
    // If the customer is on hold, WE caused this leave (redirected them
    // to the cmxhold extension) — not a real hangup. A genuine
    // disconnect while on hold still fires a real Hangup event below,
    // which isn't suppressed by this check.
    if (inboundCall.onHold && evt.channel === inboundCall.customerChannel) return;
    if (evt.channel === inboundCall.customerChannel || evt.channel === inboundCall.agentChannel) {
      endInboundCall();
    }
  });

  ami.events.on("Hangup", (evt) => {
    if (!inboundCall) return;
    if (evt.channel === inboundCall.customerChannel || evt.channel === inboundCall.agentChannel) {
      endInboundCall();
    }
  });

  agentStatusService.statusEvents.on("statusChanged", ({ status }) => {
    if (status === "READY") {
      tryConnectReadyAgent();
    }
  });
}

registerInboundEventTracking();

function getInboundCallStatus() {
  return inboundCall;
}

/*
==================================================
getInboundCallForAgent
==================================================
Used to restore state after a page refresh/reopen. Deliberately only
returns the call if it actually belongs to THIS agent (pending or
connected) — inboundCall is a system-wide singleton (v1 limitation),
so without this guard a different agent refreshing their page could
see someone else's in-progress call.
==================================================
*/
function getInboundCallForAgent(appUserId) {
  if (!inboundCall) return null;
  if (inboundCall.pendingAppUserId !== appUserId && inboundCall.connectedAppUserId !== appUserId) {
    return null;
  }
  return inboundCall;
}

// Called once the agent actually saves the intake/disposition form —
// this is the ONLY thing that clears inboundCall and returns the
// agent to READY (or NOT_READY, if the agent checked the "set me Not
// Ready after this" checkbox on the disposition form). Until this
// runs, the call record (and caller ID) stays available for the
// frontend to read.
async function finalizeInboundCall(appUserId, setNotReady = false) {
  inboundCall = null;
  return agentStatusService.setStatus(appUserId, setNotReady ? "NOT_READY" : "READY");
}

/*
==================================================
holdInboundCall / unholdInboundCall
==================================================
Redirects the customer out of the ConfBridge room into the shared
"cmxhold" MOH loop, and back again via the _9700XXX customer-rejoin
extension (same room number). Only valid once the agent has actually
connected — matches outbound's equivalent guard.
==================================================
*/
async function holdInboundCall() {
  if (!inboundCall) {
    throw new Error("No active inbound call.");
  }
  if (inboundCall.status !== "agent_connected") {
    throw new Error("Can only hold once the agent has connected.");
  }
  if (inboundCall.onHold) {
    throw new Error("Call is already on hold.");
  }

  // Same fix as outbound's holdCall() — set BEFORE issuing the
  // redirect so the ConfbridgeLeave guard is armed before the event it
  // needs to suppress can possibly arrive.
  inboundCall.onHold = true;

  try {
    await ami.redirectChannel(inboundCall.customerChannel, { context: "default", exten: "cmxhold" });
  } catch (err) {
    inboundCall.onHold = false;
    throw err;
  }

  broadcastInboundStatus();

  if (inboundCall.connectedAppUserId) {
    try {
      await agentStatusService.setStatus(inboundCall.connectedAppUserId, "ON_HOLD", { relatedCallDirection: "inbound", relatedCampaignId: inboundCall.campaignId });
    } catch (err) {
      console.error("[inboundCallService] Failed to set ON_HOLD status:", err.message);
    }
  }

  return inboundCall;
}

async function unholdInboundCall() {
  if (!inboundCall) {
    throw new Error("No active inbound call.");
  }
  if (!inboundCall.onHold) {
    throw new Error("Call is not currently on hold.");
  }

  await ami.redirectChannel(inboundCall.customerChannel, { context: "default", exten: INBOUND_ROOM });

  inboundCall.onHold = false;
  broadcastInboundStatus();

  if (inboundCall.connectedAppUserId) {
    try {
      await agentStatusService.setStatus(inboundCall.connectedAppUserId, "IN_CALL", { relatedCallDirection: "inbound", relatedCampaignId: inboundCall.campaignId });
    } catch (err) {
      console.error("[inboundCallService] Failed to set IN_CALL status after unhold:", err.message);
    }
  }

  return inboundCall;
}

module.exports = {
  INBOUND_ROOM,
  getInboundCallStatus,
  getInboundCallForAgent,
  finalizeInboundCall,
  holdInboundCall,
  unholdInboundCall,
  endInboundCall,
};