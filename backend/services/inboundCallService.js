"use strict";

const crypto = require("crypto");
const ami = require("../config/ami");
const ws = require("../config/ws");
const db = require("../config/db");
const agentStatusService = require("./agentStatusService");

/*
==================================================
INBOUND CALL SERVICE — v2 (multi-call)
==================================================
Bypasses ViciDial's own agi-DID_route.agi / Inbound Group / IVR
routing entirely (see the dialplan changes: each inbound DID Answers +
allocates a room via the /internal/allocate-inbound-room endpoint,
then ConfBridges the caller into THAT room — never reaching ViciDial's
AGI script).

REPLACES v1's single fixed room (9700000, only one concurrent inbound
call system-wide). This version allocates a fresh room per call from a
9700XXX pool (mirrors dialerService.js's allocateRoomSuffix() pattern
for outbound), so multiple callers can wait/connect at once without
ever sharing a ConfBridge with a stranger.

UPDATED — DID-to-campaign lookup is now DB-backed, not hardcoded.
Previously this was a hardcoded DID_TO_CAMPAIGN object literal, which
meant a brand-new campaign's DID would silently fail
(allocateInboundRoom would throw "No campaign configured for DID") until
someone edited this file and redeployed the backend. Now reads
asterisk.vicidial_inbound_dids directly (did_pattern -> campaign_id) —
the same real, native ViciDial table campaignRoutes.js writes a row
into when a campaign is created. Still bypasses ViciDial's own
AGI/Ingroup routing entirely — this only reads did_pattern/campaign_id/
did_active from that table, nothing else.
==================================================
*/
async function lookupCampaignForDid(did) {
  const [rows] = await db.execute(
    `SELECT campaign_id FROM asterisk.vicidial_inbound_dids WHERE did_pattern = ? AND did_active = 'Y' LIMIT 1`,
    [did]
  );
  return rows.length > 0 ? rows[0].campaign_id : null;
}

/*
==================================================
ROOM ALLOCATION
==================================================
Mirrors dialerService.js's outbound allocator exactly — same "9700XXX,
3-digit suffix" shape, same in-memory Set, same single-Node-process
caveat (a second backend instance would not know about the other's
in-use rooms; move to a shared store if that ever changes).
==================================================
*/
const ROOM_PREFIX = "9700";
const usedRoomSuffixes = new Set();

function allocateRoomSuffix() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    if (!usedRoomSuffixes.has(suffix)) {
      usedRoomSuffixes.add(suffix);
      return suffix;
    }
  }
  throw new Error("No free inbound room numbers available (all 000-999 in use).");
}

function releaseRoomSuffix(suffix) {
  usedRoomSuffixes.delete(suffix);
}

function roomFromSuffix(suffix) {
  return `${ROOM_PREFIX}${suffix}`;
}

/*
==================================================
rekeyInboundCallRoom — new, for attended transfer (Line 2)
==================================================
inboundCalls is keyed by ROOM NUMBER, not callId (see inboundCalls.set
calls throughout this file) — unlike activeCalls in dialerService.js,
which is keyed by callId and therefore unaffected when a call's room
changes. Completing an attended transfer moves the customer (and the
call's own tracked room) from the original room into Line 2's private
room — without re-keying this Map, the call would become unreachable
under BOTH the old room (deleted) and the new one (never actually
stored there), breaking every later lookup (hold, hangup, disposition,
etc).
==================================================
*/
function rekeyInboundCallRoom(oldRoom, newRoom) {
  const call = inboundCalls.get(oldRoom);
  if (!call) return;
  inboundCalls.delete(oldRoom);
  call.room = newRoom;
  inboundCalls.set(newRoom, call);
}

/*
==================================================
RECORDING PATH — NEW
==================================================
Same convention as dialerService.js's recordingPathForCall — kept as
its own small, duplicated helper here rather than a shared module,
since it's genuinely a one-line function and the two files don't
otherwise import from each other. What matters is that BOTH produce
the identical path format for the same callId, so the later S3 upload
step can find either an inbound or outbound recording the same way,
regardless of which file actually managed that call.
==================================================
*/
const RECORDING_DIR = "/var/spool/asterisk/monitor";
function recordingPathForCall(callId) {
  return `${RECORDING_DIR}/${callId}.wav`;
}

// How long a pre-allocated room is allowed to sit with no customer
// ever actually joining it (e.g. the dialplan's CURL() succeeded but a
// later step failed) before it's released back to the pool. Without
// this, a run of failed calls could slowly exhaust the 1000-room pool
// with rooms nothing will ever occupy or clean up.
const UNCLAIMED_ROOM_TIMEOUT_MS = 30000;

/*
==================================================
IN-MEMORY CALL STATE
==================================================
Keyed by room (a call's room number is fixed for its whole lifetime,
unlike callId which is also fixed but less convenient for AMI event
lookups that only carry the room/conference name). Does NOT persist
across a process restart — same acceptable-for-now limitation as
dialerService.js's activeCalls Map.

Call shape:
  { callId, room, campaignId, status, customerChannel, agentChannel,
    callerIdNumber, pendingAppUserId, pendingAgentExtension,
    connectedAppUserId, onHold, startedAt, endedAt }

status values: "awaiting_customer" (room allocated, dialplan CURL()
succeeded, caller not yet actually in the ConfBridge) ->
"waiting_for_agent" (caller joined, no agent yet) -> "ringing_agent" ->
"agent_connected" -> "ended" (stays in the Map, NOT deleted, until the
disposition is saved — same reasoning as v1: the agent still needs
caller info to fill out the intake form after the call ends).
==================================================
*/
const inboundCalls = new Map();

function findByCallId(callId) {
  for (const call of inboundCalls.values()) {
    if (call.callId === callId) return call;
  }
  return null;
}

function broadcastInboundStatus(call) {
  const targetAppUserId = call.pendingAppUserId || call.connectedAppUserId;
  if (!targetAppUserId) return;

  ws.broadcastToUser(targetAppUserId, {
    type: "inboundCall",
    callId: call.callId,
    status: call.status,
    room: call.room,
    callerIdNumber: call.callerIdNumber,
    onHold: call.onHold,
  });
}

/*
==================================================
allocateInboundRoom(did)
==================================================
Called by internalRoutes.js the instant a call arrives, BEFORE the
caller is actually put in a ConfBridge — the dialplan's CURL() needs a
room number back to build its own ConfBridge() line. Pre-registers a
Map entry in "awaiting_customer" status so the eventual ConfbridgeJoin
event (which only carries room/channel, no campaign info) has
something to attach to.

NOW ASYNC — the DID-to-campaign lookup is a real DB query (see
lookupCampaignForDid above), not an in-memory object read anymore.
internalRoutes.js already awaits this correctly since its own route
handler is async.

Throws if the DID isn't found (or isn't active) in
asterisk.vicidial_inbound_dids — internalRoutes.js turns that into a
5xx, and the dialplan should treat an empty CURL() result as "no room
allocated" (see the dialplan snippet in the handoff notes).
==================================================
*/
async function allocateInboundRoom(did) {
  const campaignId = await lookupCampaignForDid(did);
  if (!campaignId) {
    throw new Error(`No active campaign found for DID "${did}" in asterisk.vicidial_inbound_dids.`);
  }

  const suffix = allocateRoomSuffix();
  const room = roomFromSuffix(suffix);

  const call = {
    callId: crypto.randomUUID(),
    room,
    campaignId,
    status: "awaiting_customer",
    customerChannel: null,
    agentChannel: null,
    callerIdNumber: null,
    pendingAppUserId: null,
    pendingAgentExtension: null,
    connectedAppUserId: null,
    onHold: false,
    startedAt: new Date(),
    endedAt: null,
    // Same reasoning as dialerService.js's callState — channels added
    // via Conference/Transfer, tracked separately from
    // customerChannel/agentChannel so endInboundCall() below knows not
    // to end the whole room out from under a still-connected third
    // party when the original agent hangs up.
    extraParticipants: [],
    lineTwo: null, // see attendedTransferService.js
    activeLine: 1, // which room the agent's OWN channel currently sits in — 1 or 2
  };
  inboundCalls.set(room, call);

  setTimeout(() => {
    const current = inboundCalls.get(room);
    if (current && current.status === "awaiting_customer") {
      inboundCalls.delete(room);
      releaseRoomSuffix(suffix);
      console.warn(`[inboundCallService] Room ${room} never had a customer join within ${UNCLAIMED_ROOM_TIMEOUT_MS}ms — released back to the pool.`);
    }
  }, UNCLAIMED_ROOM_TIMEOUT_MS);

  return room;
}

/*
==================================================
tryConnectReadyAgents (plural) — mutex wrapper
==================================================
REAL BUG FIXED HERE: this function has FOUR separate, uncoordinated
call sites (customer join, agent goes READY, call ends, abandonment
cleanup) with no serialization between them. Two overlapping passes
could each read a stale "who's ready" snapshot before an earlier
pass's IN_CALL status write for an agent had actually committed,
letting BOTH independently claim the SAME agent for two different
waiting calls. Only one Originate() would actually land; the other
left an agent's phone ringing into nothing and the caller stuck on
hold music — exactly the "only one agent connects properly" symptom
reported with multiple simultaneous callers and agents.

Fix: a synchronous guard checked BEFORE any await, so two overlapping
invocations can never interleave — the second one just flags that
another pass is needed once the current one finishes, rather than
running concurrently or being silently dropped. The 4 existing call
sites are UNCHANGED — they still just call tryConnectReadyAgents();
this wrapper handles serialization transparently underneath them.
==================================================
*/
let isProcessingReadyAgents = false;
let rerunReadyAgentsRequested = false;

async function tryConnectReadyAgents() {
  if (isProcessingReadyAgents) {
    rerunReadyAgentsRequested = true;
    return;
  }

  isProcessingReadyAgents = true;
  try {
    await tryConnectReadyAgentsInner();
  } finally {
    isProcessingReadyAgents = false;
    if (rerunReadyAgentsRequested) {
      rerunReadyAgentsRequested = false;
      tryConnectReadyAgents();
    }
  }
}

/*
==================================================
tryConnectReadyAgentsInner
==================================================
Drains as many waiting calls as possible per pass, FIFO by arrival
time (startedAt) — not just "the one call" like v1. Builds up an
exclusion set of appUserIds already claimed WITHIN THIS SAME PASS (plus
anyone already pending/connected on a different call from an earlier
pass) so two waiting calls can never be matched to the same agent —
agentStatusService.getAnyReadyAgentWithExtension() skips anyone in that
set entirely, moving on to the next real candidate. Now guaranteed to
only ever run one pass at a time — see the tryConnectReadyAgents()
wrapper above — so this exclusion set can no longer be undermined by a
second, concurrently-running pass.
==================================================
*/
async function tryConnectReadyAgentsInner() {
  const waiting = Array.from(inboundCalls.values())
    .filter((call) => call.status === "waiting_for_agent")
    .sort((a, b) => a.startedAt - b.startedAt);

  if (!waiting.length) return;

  const claimedThisPass = new Set();
  for (const call of inboundCalls.values()) {
    if (call.pendingAppUserId) claimedThisPass.add(call.pendingAppUserId);
    if (call.connectedAppUserId) claimedThisPass.add(call.connectedAppUserId);
  }

  for (const call of waiting) {
    // Re-check at this point in the loop, not just at collection time —
    // an earlier iteration's originate() could theoretically finish an
    // agent onto ANOTHER call synchronously enough to matter, or this
    // call could have ended while we were mid-loop on a previous one.
    if (call.status !== "waiting_for_agent") continue;

    let agent;
    try {
      agent = await agentStatusService.getAnyReadyAgentWithExtension(call.campaignId, Array.from(claimedThisPass));
    } catch (err) {
      console.error("[inboundCallService] Failed to look up a ready agent:", err.message);
      continue;
    }

    if (!agent) continue; // no (more) ready+connected agents this pass

    claimedThisPass.add(agent.appUserId);

    call.status = "ringing_agent";
    call.pendingAppUserId = agent.appUserId;
    call.pendingAgentExtension = agent.extension;

    try {
      await agentStatusService.setStatus(agent.appUserId, "IN_CALL", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set IN_CALL for inbound-answering agent:", err.message);
    }

    // The call may have ended (caller hung up) while we were mid-loop
    // above — re-check before broadcasting/originating.
    if (call.status !== "ringing_agent") continue;

    broadcastInboundStatus(call);

    try {
      await ami.originate({
        Channel: `PJSIP/${agent.extension}`,
        // Was "default" — that context doesn't exist in extensions.conf
        // at all (confirmed via `grep "^\[" extensions.conf` on sandbox,
        // Aug 22 JsSIP rollout session). Every _29700XXX/_9700XXX/etc.
        // agent-leg pattern actually lives in [trunkinbound], so that's
        // the only context this Originate can ever reach.
        Context: "trunkinbound",
        Exten: `2${call.room}`,
        Priority: 1,
        CallerID: `"Inbound Caller" <${call.room}>`,
        Async: "true",
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to originate agent leg for inbound call:", err.message);

      if (call.status === "ringing_agent") {
        call.status = "waiting_for_agent";
        call.pendingAppUserId = null;
        call.pendingAgentExtension = null;
        claimedThisPass.delete(agent.appUserId);
      }
    }
  }
}

/*
==================================================
recordAbandonedCall
==================================================
Writes one row to cmx_dialer.abandoned_call_log — see
abandoned_call_log.sql in the handoff notes for the CREATE TABLE.
wait_seconds is computed HERE, once, from call.startedAt/endedAt (both
set via new Date() in this same Node process) — a fixed historical
value at the moment of writing, not something recomputed later, so
there's no live-ticking clock concern for this one at all.
==================================================
*/
async function recordAbandonedCall(call) {
  const waitSeconds = Math.floor((call.endedAt.getTime() - call.startedAt.getTime()) / 1000);
  await db.execute(
    `
      INSERT INTO cmx_dialer.abandoned_call_log
        (campaign_id, caller_id_number, call_started_at, call_ended_at, wait_seconds)
      VALUES (?, ?, ?, ?, ?)
    `,
    [call.campaignId, call.callerIdNumber, call.startedAt, call.endedAt, waitSeconds]
  );
}

/*
==================================================
endInboundCall(room)
==================================================
Marks the call at this room ended. Explicitly hangs up whichever leg
is still connected — same reasoning as v1 and as outbound: one party
leaving does NOT auto-close a ConfBridge room, and a lingering channel
could otherwise collide with a FUTURE call into this same room number
once it's reallocated.

TWO DIFFERENT OUTCOMES depending on how far the call got:

1. ABANDONED — the call ends while still "waiting_for_agent" (nobody
   ever assigned) or "ringing_agent" (an agent's phone was ringing but
   the caller left before they answered). Recorded to
   abandoned_call_log and cleaned up IMMEDIATELY — deleted from the Map,
   room released — since there's no agent who ever actually took this
   call, so there's nothing for anyone to disposition. If an agent WAS
   mid-ring (ringing_agent), they're returned straight to READY, not
   AFTER_CALL_WORK — they never actually connected to anything, so
   wrap-up time doesn't apply; same "auto-READY" assumption already
   used elsewhere in this file, not a new one. NOTE: never reaches
   recording start/stop at all — an abandoned call never had an agent
   join, so nothing was ever recording in the first place.

2. NORMAL — the call had reached "agent_connected" before ending. Same
   as before: agent flips to AFTER_CALL_WORK, and the call stays in the
   Map (NOT deleted) until the disposition is saved (finalizeInboundCall)
   — the agent still needs caller info to fill out the intake form.
   Recording (if it was started — BSMSC only) is stopped here, BEFORE
   the AFTER_CALL_WORK transition, guaranteeing the file is flushed and
   closed before the later S3 upload step (triggered wherever the
   inbound disposition actually gets saved) tries to read it.
==================================================
*/
async function endInboundCall(room) {
  const call = inboundCalls.get(room);
  if (!call || call.status === "ended") return;

  const previousStatus = call.status;
  const appUserId = call.connectedAppUserId || call.pendingAppUserId;

  call.status = "ended";
  call.endedAt = new Date();
  broadcastInboundStatus(call);

  // REAL FIX, per explicit request — "just keep conference, but allow
  // agents to hang up": when a Conference/Transfer participant is
  // still in the room, the ORIGINAL agent's own leg ending must NOT
  // also end the call for everyone — only their own leg drops,
  // leaving the customer connected with whoever else is in the room.
  // Previously this unconditionally hung up customerChannel too,
  // whether the agent's OWN hangup triggered this or the customer's
  // own hangup did — either way disconnecting everyone regardless of
  // a still-active third party.
  const hasExtraParticipants = call.extraParticipants && call.extraParticipants.length > 0;

  const hangups = [];
  if (!hasExtraParticipants && call.customerChannel) {
    hangups.push(
      ami.hangupChannel(call.customerChannel).catch((err) => {
        console.error(`[inboundCallService] Failed to hang up customer channel ${call.customerChannel}:`, err.message);
      })
    );
  }
  if (call.agentChannel) {
    hangups.push(
      ami.hangupChannel(call.agentChannel).catch((err) => {
        console.error(`[inboundCallService] Failed to hang up agent channel ${call.agentChannel}:`, err.message);
      })
    );
  }
  await Promise.all(hangups);

  const wasAbandoned = previousStatus === "waiting_for_agent" || previousStatus === "ringing_agent";

  if (wasAbandoned) {
    try {
      await recordAbandonedCall(call);
    } catch (err) {
      console.error("[inboundCallService] Failed to record abandoned call:", err.message);
    }

    if (appUserId && previousStatus === "ringing_agent") {
      try {
        await agentStatusService.setStatus(appUserId, "READY");
      } catch (err) {
        console.error("[inboundCallService] Failed to return ringing agent to READY after abandonment:", err.message);
      }
    }

    inboundCalls.delete(room);
    const suffix = room.slice(ROOM_PREFIX.length);
    releaseRoomSuffix(suffix);
    tryConnectReadyAgents();
    return;
  }

  // UPDATED — was hardcoded to `call.campaignId === "CMXBSMSC"` only,
  // same class of bug as the recording-START gate fixed earlier this
  // session. Now checks the real campaign_recording column, so a
  // campaign with recording enabled has its recording correctly
  // stopped/flushed here regardless of which campaign it is.
  try {
    const [recRows] = await db.execute(
      `SELECT campaign_recording FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`,
      [call.campaignId]
    );
    const recordingSetting = recRows[0]?.campaign_recording;
    if (recordingSetting && recordingSetting !== "NEVER") {
      try {
        await ami.stopRecording(call.room);
      } catch (err) {
        console.error(`[inboundCallService] Failed to stop recording for call ${call.callId}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[inboundCallService] Failed to check campaign_recording for ${call.campaignId}:`, err.message);
  }

  if (appUserId) {
    try {
      await agentStatusService.setStatus(appUserId, "AFTER_CALL_WORK", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set AFTER_CALL_WORK after inbound call:", err.message);
    }
  }

  // A slot just freed up — see if anyone still waiting can connect now.
  tryConnectReadyAgents();
}

// Hangup events don't carry a conference/room field, unlike
// ConfbridgeJoin/Leave — so ending a call by channel means scanning
// for whichever call currently owns that channel.
function findByChannel(channel) {
  for (const call of inboundCalls.values()) {
    if (call.customerChannel === channel || call.agentChannel === channel) return call;
  }
  return null;
}

function registerInboundEventTracking() {
  ami.events.on("ConfbridgeJoin", async (evt) => {
    const call = inboundCalls.get(evt.conference);
    if (!call) return; // not one of our rooms, or a room nobody pre-registered

    if (call.status === "awaiting_customer") {
      // First (and only) join expected before an agent is ever
      // originated — this is the customer. calleridnum is present
      // directly on the ConfbridgeJoin event itself — confirmed from a
      // real test call trace on the v1 build.
      call.customerChannel = evt.channel;
      call.callerIdNumber = evt.calleridnum || null;
      call.status = "waiting_for_agent";
      tryConnectReadyAgents();
      return;
    }

    if (evt.channel === call.customerChannel) return; // duplicate/already tracked

    if (call.status === "ringing_agent") {
      call.agentChannel = evt.channel;
      call.connectedAppUserId = call.pendingAppUserId;
      call.pendingAppUserId = null;
      call.status = "agent_connected";
      // How long the caller actually waited before reaching a real
      // agent — measured from the moment the room was allocated
      // (before the greeting even plays) to right now. Stored on the
      // call itself so it can be persisted into inbound_call_log at
      // disposition time; used for both the new "Average Wait Time"
      // KPI and Service Level's "answered within 20 seconds" count.
      call.waitSeconds = Math.floor((new Date() - call.startedAt) / 1000);
      broadcastInboundStatus(call);

      // UPDATED — was hardcoded to `call.campaignId === "CMXBSMSC"` only
      // (per an earlier explicit scope decision, never generalized).
      // Now checks the real, native campaign_recording column on
      // asterisk.vicidial_campaigns instead, so every campaign's own
      // recording toggle (set at creation via campaignRoutes.js) is
      // actually honored, not just the one campaign this was first
      // built for. NEVER = off, everything else (ONDEMAND/ALLCALLS/
      // ALLFORCE) = on for this always-record-the-whole-room
      // mechanism — ONDEMAND doesn't have a separate "on demand"
      // trigger built anywhere in this app, so it's treated as "on"
      // here rather than silently never recording; revisit if a real
      // on-demand toggle is ever built.
      try {
        const [recRows] = await db.execute(
          `SELECT campaign_recording FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`,
          [call.campaignId]
        );
        const recordingSetting = recRows[0]?.campaign_recording;
        if (recordingSetting && recordingSetting !== "NEVER") {
          ami.startRecording(call.room, recordingPathForCall(call.callId)).catch((err) => {
            console.error(`[inboundCallService] Failed to start recording for call ${call.callId}:`, err.message);
          });
        }
      } catch (err) {
        console.error(`[inboundCallService] Failed to check campaign_recording for ${call.campaignId}:`, err.message);
      }
    }
  });

  ami.events.on("ConfbridgeLeave", (evt) => {
    const call = inboundCalls.get(evt.conference);
    if (!call) return;

    // If the customer is on hold, WE caused this leave (redirected them
    // to the cmxhold extension) — not a real hangup. A genuine
    // disconnect while on hold still fires a real Hangup event below,
    // which isn't suppressed by this check.
    if (call.onHold && evt.channel === call.customerChannel) return;

    if (evt.channel === call.customerChannel || evt.channel === call.agentChannel) {
      endInboundCall(call.room);
    }
  });

  ami.events.on("Hangup", (evt) => {
    const call = findByChannel(evt.channel);
    if (!call) return;
    // Same reasoning as dialerService.js's own fix — defer entirely to
    // attendedTransferService while Line 2 is active, rather than
    // disrupting the agent's still-live private conversation the
    // instant the original customer (or, in principle, the agent's own
    // relocated channel) triggers a Hangup event here.
    if (call.lineTwo) return;
    endInboundCall(call.room);
  });

  agentStatusService.statusEvents.on("statusChanged", ({ status }) => {
    if (status === "READY") {
      tryConnectReadyAgents();
    }
  });
}

registerInboundEventTracking();

/*
==================================================
getInboundCallForAgent
==================================================
Used to restore state after a page refresh/reopen, and to render the
DialerPage's inbound panel at all. Scans all calls for one where this
agent is pending or connected — at most one per agent at a time, since
tryConnectReadyAgents()'s per-pass exclusion set prevents the same
agent ever being claimed by two calls simultaneously.
==================================================
*/
function getInboundCallForAgent(appUserId) {
  for (const call of inboundCalls.values()) {
    if (call.pendingAppUserId === appUserId || call.connectedAppUserId === appUserId) {
      return call;
    }
  }
  return null;
}

// Called once the agent actually saves the intake/disposition form —
// this is the ONLY thing that deletes the call from inboundCalls and
// releases its room back to the pool, returning the agent to READY (or
// NOT_READY, if the agent checked the "set me Not Ready after this"
// checkbox). Until this runs, the call record (and caller ID) stays
// available for the frontend to read.
async function finalizeInboundCall(callId, appUserId, setNotReady = false) {
  const call = findByCallId(callId);
  if (call) {
    inboundCalls.delete(call.room);
    const suffix = call.room.slice(ROOM_PREFIX.length);
    releaseRoomSuffix(suffix);
  }
  return agentStatusService.setStatus(appUserId, setNotReady ? "NOT_READY" : "READY");
}

/*
==================================================
holdInboundCall / unholdInboundCall
==================================================
Redirects the customer out of THIS call's ConfBridge room into the
shared "cmxhold" MOH loop, and back again via the room's own
_9700XXX customer-rejoin extension. Only valid once the agent has
actually connected — matches outbound's equivalent guard. Keyed by
callId now (v1 had exactly one call, so no ambiguity — v2 needs to
know WHICH call).

NOTE ON RECORDING: same as outbound's holdCall() — deliberately does
NOT pause/resume recording during hold. ConfbridgeStartRecord keeps
recording the whole room regardless of who's in it, so a hold segment
just captures MOH audio. Acceptable for a first version.
==================================================
*/
async function holdInboundCall(callId) {
  const call = findByCallId(callId);
  if (!call) {
    throw new Error("No active inbound call with that ID.");
  }
  if (call.status !== "agent_connected") {
    throw new Error("Can only hold once the agent has connected.");
  }
  if (call.onHold) {
    throw new Error("Call is already on hold.");
  }

  // Same fix as outbound's holdCall() — set BEFORE issuing the
  // redirect so the ConfbridgeLeave guard is armed before the event it
  // needs to suppress can possibly arrive.
  call.onHold = true;

  try {
    // Same class of bug as outbound's holdCall() and the earlier
    // agent-leg Originate fix — [default] doesn't exist in
    // extensions.conf, only [trunkinbound] does.
    await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: "cmxhold" });
  } catch (err) {
    call.onHold = false;
    throw err;
  }

  broadcastInboundStatus(call);

  if (call.connectedAppUserId) {
    try {
      await agentStatusService.setStatus(call.connectedAppUserId, "ON_HOLD", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set ON_HOLD status:", err.message);
    }
  }

  return call;
}

async function unholdInboundCall(callId) {
  const call = findByCallId(callId);
  if (!call) {
    throw new Error("No active inbound call with that ID.");
  }
  if (!call.onHold) {
    throw new Error("Call is not currently on hold.");
  }

  await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: call.room });

  call.onHold = false;
  broadcastInboundStatus(call);

  if (call.connectedAppUserId) {
    try {
      await agentStatusService.setStatus(call.connectedAppUserId, "IN_CALL", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set IN_CALL status after unhold:", err.message);
    }
  }

  return call;
}

/*
==================================================
getQueueStatus
==================================================
Real aggregation across every currently-waiting call, grouped by
campaign — replaces v1's hardcoded 0-or-1 guess. Only counts calls
genuinely waiting for an agent (not yet ringing/connected/ended) —
that's what "in queue" means on the Live Status Dashboard.

oldestWaitingSeconds: how long the LONGEST-waiting call in that
campaign has been waiting. Computed here, in Node, against Node's OWN
Date.now() — call.startedAt was ALSO set via new Date() in this same
process (see allocateInboundRoom), so this is one clock measuring
against itself, not the MySQL-timestamp-vs-browser-clock mismatch that
caused the two earlier timezone bugs tonight. Still returning a plain
number rather than a raw timestamp, to keep this file consistent with
the "let the source compute elapsed time, never make the frontend diff
a timestamp itself" rule the rest of this codebase now follows.
==================================================
*/
function getQueueStatus() {
  const buckets = new Map(); // campaignId -> { waiting, oldestStartedAt }

  for (const call of inboundCalls.values()) {
    if (call.status !== "waiting_for_agent") continue;

    const bucket = buckets.get(call.campaignId) || { waiting: 0, oldestStartedAt: null };
    bucket.waiting += 1;
    if (!bucket.oldestStartedAt || call.startedAt < bucket.oldestStartedAt) {
      bucket.oldestStartedAt = call.startedAt;
    }
    buckets.set(call.campaignId, bucket);
  }

  const now = Date.now();
  return Array.from(buckets.entries()).map(([campaignId, b]) => ({
    campaignId,
    waiting: b.waiting,
    oldestWaitingSeconds: Math.floor((now - b.oldestStartedAt.getTime()) / 1000),
  }));
}

function getAllInboundCalls() {
  return Array.from(inboundCalls.values());
}

/*
==================================================
getAbandonedCallsToday
==================================================
Reuses statsService.js's own Eastern-day-boundary helper (same
self-calibrating logic used for Today's Stats) rather than duplicating
it — "today" should mean the same thing everywhere in this app.
Requiring statsService.js here (not at the top of the file) avoids a
circular require, since statsService.js doesn't require this file back
so it's not strictly necessary, but keeps this one lazy/local to where
it's actually used, matching the pattern already used for ws.js's
lazy requires elsewhere in this codebase.
==================================================
*/
async function getAbandonedCallsToday(campaignId) {
  const statsService = require("./statsService");
  const { start, end } = await statsService.getEasternDayBoundsForServerClock();

  const params = [start, end];
  let campaignFilter = "";
  if (campaignId) {
    campaignFilter = "AND campaign_id = ?";
    params.push(campaignId);
  }

  const [rows] = await db.execute(
    `
      SELECT campaign_id, caller_id_number, call_started_at, wait_seconds
      FROM cmx_dialer.abandoned_call_log
      WHERE call_started_at >= ? AND call_started_at <= ?
      ${campaignFilter}
      ORDER BY call_started_at DESC
      LIMIT 200
    `,
    params
  );

  return rows.map((r) => ({
    campaignId: r.campaign_id,
    callerIdNumber: r.caller_id_number,
    callStartedAt: r.call_started_at,
    waitSeconds: r.wait_seconds,
  }));
}

module.exports = {
  allocateInboundRoom,
  getInboundCallForAgent,
  finalizeInboundCall,
  holdInboundCall,
  unholdInboundCall,
  endInboundCall,
  getQueueStatus,
  getAllInboundCalls,
  getAbandonedCallsToday,
  findByCallId,
  recordingPathForCall,
  releaseRoomSuffix,
  rekeyInboundCallRoom,
};