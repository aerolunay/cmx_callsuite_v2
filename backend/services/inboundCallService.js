"use strict";

const ami = require("../config/ami");
const ws = require("../config/ws");
const agentStatusService = require("./agentStatusService");

/*
==================================================
INBOUND CALL SERVICE — v1
==================================================
Bypasses ViciDial's own agi-DID_route.agi / Inbound Group / IVR
routing entirely (see the dialplan changes: this DID now Answers +
ConfBridges directly, never reaching ViciDial's AGI script). Built
because ViciDial's own inbound engine depends on vicidial_live_agents,
a legacy status table this session found to be stale/unreliable — the
same class of problem BUILD_SPEC.md already documented for other
legacy tooling on this server.

REAL v1 LIMITATIONS, named plainly rather than hidden:
  - Single fixed room (9700000) — only one concurrent inbound call is
    supported. A second caller while one is already in progress will
    join the SAME ConfBridge room as the first, which is wrong. Do not
    treat this as production-ready for multi-agent or multi-call
    scenarios without revisiting the room-allocation strategy (mirror
    dialerService.js's allocateRoomSuffix() approach instead).
  - No caller-experience polish — no hold music, no queue position, no
    "please wait" message. A caller arriving with no agent READY just
    sits in the ConfBridge in silence until one becomes available.
  - No timeout/voicemail fallback if no agent ever becomes READY.
  - Picks the FIRST ready agent found, no ranking/priority/skill-based
    routing.
==================================================
*/

const INBOUND_ROOM = "9700000";

// null when no inbound call is in progress. Otherwise:
// { status, customerChannel, agentChannel, pendingAppUserId,
//   pendingAgentExtension, startedAt, endedAt }
let inboundCall = null;

function broadcastInboundStatus() {
  if (!inboundCall) return;
  const targetAppUserId = inboundCall.pendingAppUserId || inboundCall.connectedAppUserId;
  if (!targetAppUserId) return;

  ws.broadcastToUser(targetAppUserId, {
    type: "inboundCall",
    status: inboundCall.status,
    room: INBOUND_ROOM,
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

  if (!agent) return; // still nobody ready — will retry on the next READY transition

  inboundCall.status = "ringing_agent";
  inboundCall.pendingAppUserId = agent.appUserId;
  inboundCall.pendingAgentExtension = agent.extension;

  try {
    await agentStatusService.setStatus(agent.appUserId, "IN_CALL");
  } catch (err) {
    console.error("[inboundCallService] Failed to set IN_CALL for inbound-answering agent:", err.message);
  }

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
    // Fall back to waiting — a different agent might become ready, or
    // this same one could still pick up on a retry. Not auto-retrying
    // immediately to avoid a tight loop if this agent's phone is
    // simply unregistered.
    inboundCall.status = "waiting_for_agent";
    inboundCall.pendingAppUserId = null;
    inboundCall.pendingAgentExtension = null;
  }
}

async function endInboundCall() {
  if (!inboundCall) return;

  const appUserId = inboundCall.connectedAppUserId || inboundCall.pendingAppUserId;
  inboundCall.status = "ended";
  inboundCall.endedAt = new Date();
  broadcastInboundStatus();

  if (appUserId) {
    try {
      await agentStatusService.setStatus(appUserId, "AFTER_CALL_WORK");
    } catch (err) {
      console.error("[inboundCallService] Failed to set AFTER_CALL_WORK after inbound call:", err.message);
    }
  }

  inboundCall = null;
}

function registerInboundEventTracking() {
  ami.events.on("ConfbridgeJoin", (evt) => {
    if (evt.conference !== INBOUND_ROOM) return;

    if (!inboundCall) {
      // First join into this room with no call tracked yet — this is
      // the customer (the DID's dialplan Answers + ConfBridges them in
      // directly; no agent leg has been originated yet at this point).
      inboundCall = {
        status: "waiting_for_agent",
        customerChannel: evt.channel,
        agentChannel: null,
        pendingAppUserId: null,
        pendingAgentExtension: null,
        connectedAppUserId: null,
        startedAt: new Date(),
        endedAt: null,
      };
      tryConnectReadyAgent();
      return;
    }

    if (evt.channel === inboundCall.customerChannel) return; // duplicate/already tracked

    // A second join into the same room while we have a pending agent
    // is that agent actually connecting.
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

  // Retry connecting whenever ANY agent transitions to READY — covers
  // the case where a customer is waiting and no one was ready yet.
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

module.exports = {
  getInboundCallStatus,
};