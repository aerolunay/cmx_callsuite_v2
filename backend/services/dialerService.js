"use strict";

const crypto = require("crypto");

const db = require("../config/db");
const ami = require("../config/ami");
const ws = require("../config/ws");
const agentStatusService = require("./agentStatusService");
const { getEasternDayBoundsForServerClock } = require("./statsService");

/*
==================================================
ROOM ALLOCATION
==================================================
Dialplan pattern confirmed working end-to-end against a real test call
ON PRODUCTION, which appears to have a genuine [default] context
(standard in stock ViciDial configs). SANDBOX's extensions.conf is a
stripped-down custom file with ONLY [trunkinbound] defined — no
[default] at all. The Context values below were changed from
"default" to "trunkinbound" specifically to fix sandbox; this has
NOT been re-validated against production, and should NOT be assumed
safe to deploy there without first confirming whether production's
[default] context still needs to be targeted instead. If both
environments ever need to diverge here, this should become an env var
rather than a hardcoded string.

  Agent leg:    PJSIP/<ext>  -> Exten 2<room>  (context "trunkinbound"
                on sandbox — see caveat above)
  Customer leg: Local/<room>@trunkinbound -> Exten <phone number>
where <room> is a 7-digit string "9600XXX" and only the last 3 digits
(000-999) actually vary — confirmed via the real ConfbridgeJoin event's
"conference": "9600000" field during testing.

So the thing we allocate/track per call is really just the 3-digit
suffix. This is an in-memory allocator scoped to a single Node process —
if you ever run more than one backend instance, this needs to move to a
shared store (DB row or Redis) instead, since two processes would not
know about each other's in-use rooms.
==================================================
*/
const usedRoomSuffixes = new Set();

function allocateRoomSuffix() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    if (!usedRoomSuffixes.has(suffix)) {
      usedRoomSuffixes.add(suffix);
      return suffix;
    }
  }
  throw new Error("No free room numbers available (all 000-999 in use).");
}

function releaseRoomSuffix(suffix) {
  usedRoomSuffixes.delete(suffix);
}

function roomFromSuffix(suffix) {
  return `9600${suffix}`; // matches dialplan's _9600XXX pattern
}

/*
==================================================
RECORDING PATH — NEW
==================================================
BSMSC-only, automatic, no agent control — per explicit scope decision.
callId-based (not room-based) since room numbers get reused across
different calls over time, while callId is stable and unique per call
— exactly what the later S3 upload step needs to find this file
deterministically.
==================================================
*/
const RECORDING_DIR = "/var/spool/asterisk/monitor";
function recordingPathForCall(callId) {
  return `${RECORDING_DIR}/${callId}.wav`;
}

/*
==================================================
IN-MEMORY CALL STATE
==================================================
Keyed by callId. Holds enough to answer getCallStatus() and to target
the right channels for endCall(). This does NOT persist across a
process restart — an in-flight call would become untrackable if the
backend restarts mid-call. Acceptable for now per spec's "keep it
simple" framing, but flag this as a real limitation before this goes
into anything resembling production use with concurrent agents.
==================================================
*/
const activeCalls = new Map();

function newCallId() {
  return crypto.randomUUID();
}

function broadcastCallStatus(call) {
  ws.broadcastToUser(call.appUserId, {
    type: "callStatus",
    callId: call.callId,
    status: call.status,
    room: call.room,
    onHold: call.onHold,
  });
}

// Ensures AFTER_CALL_WORK (and its broadcast) only fires once per call,
// since both the AMI event handlers below AND endCall() can each reach
// the "call has ended" moment — without this guard a call ended via
// endCall() after the customer already hung up would double-fire the
// status transition (harmless functionally, but noisy/confusing in the
// status_log history).
async function markCallEnded(call) {
  // Safety net for the OriginateResponse listener added in startCall()
  // (see the customer-leg-channel fix above) — if the call ends via some
  // other path (agent hangs up first, ConfbridgeLeave/Hangup fires,
  // etc.) before that listener ever gets a chance to fire on its own,
  // this stops it from leaking indefinitely on this long-running process.
  if (call._customerOriginateResponseListener) {
    ami.events.removeListener("OriginateResponse", call._customerOriginateResponseListener);
    call._customerOriginateResponseListener = null;
  }

  if (call.afterCallWorkTriggered) return;
  call.afterCallWorkTriggered = true;

  // Stop recording BEFORE marking the call ended/broadcasting —
  // guarantees the file is fully flushed and closed before any later
  // step (the S3 upload, built separately) tries to read it. Gated the
  // same way recording was started (BSMSC only) — a call that was
  // never recording has nothing to stop, and calling this on a
  // non-recording room is a harmless no-op we'd rather just skip.
  if (call.campaignId === "CMXBSMSC") {
    try {
      await ami.stopRecording(call.room);
    } catch (err) {
      console.error(`[dialerService] Failed to stop recording for call ${call.callId}:`, err.message);
    }
  }

  call.status = "ended";
  call.endedAt = call.endedAt || new Date();
  broadcastCallStatus(call);

  try {
    await agentStatusService.setStatus(call.appUserId, "AFTER_CALL_WORK", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
      relatedCallId: call.callId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to set AFTER_CALL_WORK status:", err.message);
  }
}

/*
==================================================
getNextLead
==================================================
Per spec: try vicidial_hopper first; if empty, fall back to querying
vicidial_list directly, because AST_VDhopper.pl has a known silent-fail
bug on this server and cannot be relied on to keep the hopper populated.

NOTE: l.comments below is standard ViciDial schema (a free-text notes
field on the lead) but NOT specifically confirmed to exist on this
install — if it errors, check the real column name/existence first.
==================================================
*/
async function getNextLead(campaignId) {
  const [hopperRows] = await db.execute(
    `
      SELECT h.lead_id, h.hopper_id, l.phone_number, l.list_id,
             l.first_name, l.last_name,
             l.address1, l.address2, l.address3, l.city, l.state, l.province,
             l.postal_code, l.country_code, l.gender, l.date_of_birth,
             l.alt_phone, l.email, l.comments
      FROM vicidial_hopper h
      JOIN vicidial_list l ON l.lead_id = h.lead_id
      WHERE h.campaign_id = ? AND h.status = 'READY'
      ORDER BY h.priority ASC, h.hopper_id ASC
      LIMIT 1
    `,
    [campaignId]
  );

  if (hopperRows.length) {
    return { ...hopperRows[0], source: "hopper" };
  }

  // Hopper empty (or the known AST_VDhopper.pl bug never populated it) —
  // fall back to pulling directly from vicidial_list for this campaign.
  //
  // NOTE: this join assumes campaigns are tied to lists via
  // vicidial_campaigns.campaign_id = vicidial_list.list_id indirectly
  // through vicidial_lists.campaign_id — NOT CONFIRMED against this
  // install's actual schema/config yet. Verify vicidial_lists really has
  // a campaign_id column matching this campaign before trusting this path
  // — if it doesn't, this fallback will return zero rows silently.
  const [listRows] = await db.execute(
    `
      SELECT l.lead_id, l.phone_number, l.list_id,
             l.first_name, l.last_name,
             l.address1, l.address2, l.address3, l.city, l.state, l.province,
             l.postal_code, l.country_code, l.gender, l.date_of_birth,
             l.alt_phone, l.email, l.comments
      FROM vicidial_list l
      JOIN vicidial_lists vl ON vl.list_id = l.list_id
      WHERE vl.campaign_id = ?
        AND l.called_since_last_reset = 'N'
        AND l.status NOT IN ('DNC', 'DONE')
      ORDER BY l.lead_id ASC
      LIMIT 1
    `,
    [campaignId]
  );

  if (!listRows.length) {
    return null;
  }

  return { ...listRows[0], source: "vicidial_list_fallback" };
}

/*
==================================================
startCall
==================================================
Two-Originate flow, confirmed against a real test call:
  1. Originate agent leg -> Exten 2<room>. Wait for THIS call's
     ConfbridgeJoin (matched by conference === room) before firing the
     customer leg — firing both at once risks the customer connecting
     into an empty room.
  2. Originate customer leg (Local/<room>@default) once step 1 confirms.

Returns { callId, room } immediately after step 1's Originate is sent;
callers should track status via getCallStatus()/WebSocket push rather
than blocking on the full flow.
==================================================
*/
// Real bug found: a phone number with a leading "+" can't match EITHER
// outbound dialplan pattern (_1NXXNXXXXXX or _NXXNXXXXXX — both
// require the first character to be a literal digit, never "+"),
// causing a silent no-route failure. Normalizing to a bare 10-digit
// US number here fixes this for BOTH Dial Next Number and Callback,
// since they share this same function.
function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return phoneNumber;
  let digits = String(phoneNumber).replace(/^\+/, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

function startCall({ appUserId, agentUser, agentExtension, lead, leadId, phoneNumber, campaignCid, campaignId, callType = "REGULAR" }) {
  phoneNumber = normalizePhoneNumber(phoneNumber);
  return new Promise(async (resolve, reject) => {
    let suffix;
    try {
      suffix = allocateRoomSuffix();
    } catch (err) {
      return reject(err);
    }

    const room = roomFromSuffix(suffix);
    const callId = newCallId();

    const callState = {
      callId,
      room,
      roomSuffix: suffix,
      appUserId,
      campaignId,
      lead, // full lead object — needed to restore ContactDetailsCard after a page refresh/reopen, not just leadId/phoneNumber
      leadId,
      phoneNumber,
      callType,
      agentUser,
      agentExtension,
      status: "ringing_agent",
      agentChannel: null,
      customerChannel: null,
      startedAt: new Date(),
      endedAt: null,
      afterCallWorkTriggered: false,
      onHold: false,
    };

    activeCalls.set(callId, callState);
    broadcastCallStatus(callState);

    // Agent is now committed to this call attempt the moment dialing
    // starts, not only once someone actually answers — so IN_CALL
    // begins here rather than waiting for ConfbridgeJoin.
    try {
      await agentStatusService.setStatus(appUserId, "IN_CALL", {
        relatedCallDirection: "outbound",
        relatedCampaignId: callState.campaignId,
        relatedCallId: callState.callId,
      });
    } catch (err) {
      console.error("[dialerService] Failed to set IN_CALL status:", err.message);
    }

    // Listen for this call's agent ConfbridgeJoin before firing leg 2.
    // Matched on room number only (conference numbers are unique per
    // in-flight call by construction of allocateRoomSuffix()).
    let settled = false;

    const onConfbridgeJoin = async (evt) => {
      if (evt.conference !== room) return; // not our room
      if (settled) return;

      callState.agentChannel = evt.channel;
      callState.status = "agent_connected";
      broadcastCallStatus(callState);

      settled = true;
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      clearTimeout(joinTimeout);

      try {
        await ami.originate({
          // SANDBOX-SPECIFIC FIX — was Local/${room}@default /
          // Context: "default". See ROOM ALLOCATION comment above.
          Channel: `Local/${room}@trunkinbound`,
          Context: "trunkinbound",
          Exten: phoneNumber,
          Priority: 1,
          CallerID: `"CMX Outbound" <${campaignCid}>`,
          Async: "true",
        });

        callState.status = "ringing_customer";
        broadcastCallStatus(callState);

        // REAL BUG FIXED HERE: previously, callState.customerChannel was
        // ONLY ever set inside ConfbridgeJoin's handler — which only
        // fires once the customer's phone actually ANSWERS. While still
        // ringing, customerChannel stayed null, so endCall() (see below)
        // had nothing to hang up if the agent ended the call before the
        // customer picked up — the dial-out just kept ringing on
        // Asterisk's side indefinitely, orphaned from callState entirely.
        // Confirmed via a real callback test: agent ended the call while
        // the customer's line was still ringing, and it never stopped.
        //
        // Fix: capture the channel from the customer leg's OWN
        // OriginateResponse instead, which fires immediately once
        // Asterisk accepts the dial attempt — regardless of whether it's
        // ever answered. Matched by room (via the Local channel's name
        // prefix), not by phoneNumber, since room is guaranteed unique
        // per in-flight call by construction of allocateRoomSuffix(),
        // whereas two simultaneous calls could in principle dial the
        // same number. One-shot: removes itself once it fires, or once
        // the call ends some other way first.
        const onCustomerOriginateResponse = (evt) => {
          if (!evt.channel || !evt.channel.startsWith(`Local/${room}@`)) return;
          if (!callState.customerChannel) {
            callState.customerChannel = evt.channel;
          }
          ami.events.removeListener("OriginateResponse", onCustomerOriginateResponse);
          callState._customerOriginateResponseListener = null;
        };
        callState._customerOriginateResponseListener = onCustomerOriginateResponse;
        ami.events.on("OriginateResponse", onCustomerOriginateResponse);

        resolve({ callId, room });
      } catch (err) {
        await markCallEnded(callState);
        releaseRoomSuffix(suffix);
        reject(err);
      }
    };

    // Safety valve: if the agent never joins (phone doesn't ring, agent
    // doesn't pick up, extension misconfigured), don't hang the promise
    // or the room allocation forever. 30s is a starting guess, not
    // validated against real agent answer-time distributions yet.
    const joinTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      ami.events.removeListener("OriginateResponse", onOriginateResponse);
      markCallEnded(callState);
      releaseRoomSuffix(suffix);
      reject(new Error(`Timed out waiting for agent to join room ${room}.`));
    }, 30000);

    ami.events.on("ConfbridgeJoin", onConfbridgeJoin);

    // Fail fast: Asterisk reports Originate failures (no answer, no
    // registered contact, etc.) via a near-immediate OriginateResponse
    // event, not by refusing the initial action call (Async Originate's
    // action-level ack just means "request accepted," not "call
    // succeeded"). Matched on Exten since it's unique per in-flight call
    // by construction of allocateRoomSuffix(). Confirmed necessary via a
    // real failed call that otherwise sat for the full 30s timeout
    // despite Asterisk reporting failure in under a second.
    const onOriginateResponse = (evt) => {
      if (settled) return;
      if (evt.exten !== `2${room}`) return; // not our agent leg
      if (evt.response !== "Failure") return; // Success is handled by ConfbridgeJoin instead

      settled = true;
      clearTimeout(joinTimeout);
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      ami.events.removeListener("OriginateResponse", onOriginateResponse);
      markCallEnded(callState);
      releaseRoomSuffix(suffix);
      reject(new Error(
        `Asterisk failed to originate the agent leg to ${agentExtension} (reason ${evt.reason}). ` +
        `Check whether the agent's softphone is registered.`
      ));
    };

    ami.events.on("OriginateResponse", onOriginateResponse);

    ami.originate({
      // SANDBOX-SPECIFIC FIX — was Context: "default". See ROOM
      // ALLOCATION comment above.
      Channel: `PJSIP/${agentExtension}`,
      Context: "trunkinbound",
      Exten: `2${room}`,
      Priority: 1,
      CallerID: `"${agentUser}" <${campaignCid}>`,
      Async: "true",
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(joinTimeout);
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      ami.events.removeListener("OriginateResponse", onOriginateResponse);
      markCallEnded(callState);
      releaseRoomSuffix(suffix);
      reject(err);
    });
  });
}

/*
==================================================
getCallStatus
==================================================
Purely reads in-memory state built up by the AMI event subscriptions
below (registerCallEventTracking) — no polling, per spec.
==================================================
*/
function getCallStatus(callId) {
  const call = activeCalls.get(callId);
  if (!call) return null;

  return {
    callId: call.callId,
    room: call.room,
    status: call.status,
    campaignId: call.campaignId,
    lead: call.lead,
    leadId: call.leadId,
    phoneNumber: call.phoneNumber,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    onHold: call.onHold,
  };
}

/*
==================================================
getActiveCallForAgent
==================================================
Used to restore state after a page refresh/reopen — the ONLY thing
that ever knew about an in-progress call was React state in the
browser, which a refresh wipes even though the backend (this Map) kept
tracking the real call the whole time. Returns null if this agent has
no active call right now.
==================================================
*/
function getActiveCallForAgent(appUserId) {
  for (const call of activeCalls.values()) {
    if (call.appUserId === appUserId && call.status !== "ended") {
      return getCallStatus(call.callId);
    }
  }
  return null;
}

// Internal-only — returns the RAW in-memory call object (including
// agentChannel, an actual Asterisk channel name) for backend use only.
// Never route this through an API response; getCallStatus() above is
// the public-facing shape and deliberately omits agentChannel. Added
// for Conference/Transfer (Phase E), which needs to hang up the
// agent's own channel after a successful blind transfer.
function getRawActiveCallForAgent(appUserId) {
  for (const call of activeCalls.values()) {
    if (call.appUserId === appUserId && call.status !== "ended") {
      return call;
    }
  }
  return null;
}

/*
==================================================
Ongoing event tracking (customer connect / hangup / room close)
==================================================
Confirmed from the real test call transcript:
  - Newstate with channelstatedesc === "Up" on the CUSTOMER's channel
    (PJSIP/QUESTBLUE-... in this test) is the real "customer answered"
    signal on the trunk side.
  - ConfbridgeLeave / Hangup on the customer's Local channel half is the
    real "customer disconnected" signal — the agent's channel stays in
    the room afterward and does NOT close it automatically. This is why
    endCall() below explicitly hangs up the agent leg too.
==================================================
*/
function registerCallEventTracking() {
  ami.events.on("ConfbridgeJoin", async (evt) => {
    for (const call of activeCalls.values()) {
      if (evt.conference !== call.room) continue;
      // Second join into an already-agent_connected room is the customer.
      if (call.status === "ringing_customer") {
        call.customerChannel = evt.channel;
        call.status = "customer_connected";
        broadcastCallStatus(call);

        // UPDATED — was hardcoded to `call.campaignId === "CMXBSMSC"`
        // only. Now checks the real campaign_recording column on
        // asterisk.vicidial_campaigns (set at campaign creation via
        // campaignRoutes.js) so every campaign's own recording toggle
        // is actually honored. Starts HERE (not at agent_connected) so
        // the recording captures the actual conversation, not just the
        // agent sitting alone waiting for the customer to pick up.
        try {
          const [recRows] = await db.execute(
            `SELECT campaign_recording FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`,
            [call.campaignId]
          );
          const recordingSetting = recRows[0]?.campaign_recording;
          if (recordingSetting && recordingSetting !== "NEVER") {
            ami.startRecording(call.room, recordingPathForCall(call.callId)).catch((err) => {
              console.error(`[dialerService] Failed to start recording for call ${call.callId}:`, err.message);
            });
          }
        } catch (err) {
          console.error(`[dialerService] Failed to check campaign_recording for ${call.campaignId}:`, err.message);
        }
      }
    }
  });

  ami.events.on("ConfbridgeLeave", (evt) => {
    for (const call of activeCalls.values()) {
      if (evt.conference !== call.room) continue;
      // If this call is on hold, WE caused this leave (redirected the
      // customer to the cmxhold extension) — not a real hangup.
      if (call.onHold && evt.channel === call.customerChannel) continue;
      if (evt.channel === call.customerChannel) {
        markCallEnded(call);
      }
    }
  });

  ami.events.on("Hangup", (evt) => {
    for (const call of activeCalls.values()) {
      if (evt.channel === call.customerChannel) {
        markCallEnded(call);
      }
    }
  });
}

registerCallEventTracking();

/*
==================================================
endCall
==================================================
Explicitly hangs up BOTH legs, per spec — confirmed necessary because
a customer hangup alone does not close the ConfBridge room; the agent's
channel otherwise sits in it until the agent manually hangs up MicroSIP.
==================================================
*/
async function endCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) {
    throw new Error(`No active call found for callId ${callId}.`);
  }

  const hangups = [];

  if (call.customerChannel) {
    hangups.push(ami.hangupChannel(call.customerChannel).catch((err) => {
      console.error(`[dialerService] Failed to hang up customer channel ${call.customerChannel}:`, err.message);
    }));
  }

  if (call.agentChannel) {
    hangups.push(ami.hangupChannel(call.agentChannel).catch((err) => {
      console.error(`[dialerService] Failed to hang up agent channel ${call.agentChannel}:`, err.message);
    }));
  }

  await Promise.all(hangups);

  await markCallEnded(call);
  releaseRoomSuffix(call.roomSuffix);

  return getCallStatus(callId);
}

/*
==================================================
holdCall / unholdCall (outbound)
==================================================
Redirects the CUSTOMER's channel out of the ConfBridge room into the
shared "cmxhold" MOH loop, and back again. Only valid once the
customer has actually joined (customer_connected) — can't hold a call
that hasn't connected yet.

This is also what finally makes ON_HOLD attributable to a real call —
tagging the transition with relatedCallDirection is what makes Avg
IB/OB Hold in Today's Stats computable, instead of structurally
impossible as it was before this feature existed.

NOTE ON RECORDING: deliberately does NOT pause/resume recording during
hold — ConfbridgeStartRecord keeps recording the whole room regardless
of who's in it at any given moment, so a hold segment just captures MOH
audio rather than conversation. Acceptable for a first version; revisit
only if silence/hold-music-heavy recordings turn out to be a real
problem worth solving.
==================================================
*/
async function holdCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) {
    throw new Error(`No active call found for callId ${callId}.`);
  }
  if (call.status !== "customer_connected") {
    throw new Error("Can only hold a call once the customer has connected.");
  }
  if (call.onHold) {
    throw new Error("Call is already on hold.");
  }

  // Set BEFORE issuing the redirect, not after awaiting it — a real
  // bug found during testing: the ConfbridgeLeave event this redirect
  // triggers (as a side effect of the customer actually leaving the
  // ConfBridge room) can arrive before the AMI action's own
  // acknowledgment resolves, meaning the "onHold" guard in
  // registerCallEventTracking() wasn't armed yet and the call was
  // incorrectly treated as hung up.
  call.onHold = true;

  try {
    // Was context: "default" — same class of bug as the earlier
    // inboundCallService.js Originate fix: [default] doesn't exist
    // anywhere in extensions.conf, only [trunkinbound] does. This was
    // never exercised by the earlier fix since that only touched the
    // agent-leg Originate, not hold/unhold's Redirect calls.
    await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: "cmxhold" });
  } catch (err) {
    call.onHold = false; // redirect itself failed — revert
    throw err;
  }

  broadcastCallStatus(call);

  try {
    await agentStatusService.setStatus(call.appUserId, "ON_HOLD", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
      relatedCallId: call.callId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to set ON_HOLD status:", err.message);
  }

  return getCallStatus(callId);
}

async function unholdCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) {
    throw new Error(`No active call found for callId ${callId}.`);
  }
  if (!call.onHold) {
    throw new Error("Call is not currently on hold.");
  }

  await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: call.room });

  call.onHold = false;
  broadcastCallStatus(call);

  try {
    await agentStatusService.setStatus(call.appUserId, "IN_CALL", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
      relatedCallId: call.callId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to set IN_CALL status after unhold:", err.message);
  }

  return getCallStatus(callId);
}

/*
==================================================
saveDisposition
==================================================
Per spec:
  1. Insert into cmx_dialer.dialer_call_log (own schema, NOT asterisk).
  2. Update vicidial_list.status to the closest matching ViciDial status
     code.
  3. Set called_since_last_reset = 'Y'.

STATUS CODE MAPPING BELOW IS CONFIRMED against this install's real
`vicidial_statuses` table (queried directly, 2026-08-10) EXCEPT for
CALL_ENDED, CX_HUNG_UP, and WRONG_NUMBER — this install has no status
that actually matches those three concepts. They're mapped to the
closest available code (all falling back to "PU"/"DC") as a stopgap.
This loses real information in ViciDial's own reporting (e.g. "customer
hung up" and "call completed cleanly" become indistinguishable). Flag
this to whoever owns campaign config — cheap fix is adding 2-3 custom
statuses to vicidial_statuses so these have honest equivalents.
==================================================
*/
const DISPOSITION_TO_VICIDIAL_STATUS = {
  CALL_ENDED: "PU", // no real equivalent — "Call Picked Up" is closest
  CX_HUNG_UP: "PU", // no real equivalent — loses the "hung up" distinction
  NO_ANSWER: "N", // confirmed — "N" (manual), NOT "NA" (autodial-specific)
  VOICEMAIL: "A", // confirmed — "A" (manual), NOT "AM"/"AL"/"AA" (auto variants)
  WRONG_NUMBER: "DC", // no real equivalent — "Disconnected Number" is closest, not the same thing
  NOT_INTERESTED: "NI", // confirmed exact match
  DO_NOT_CALL: "DNC", // confirmed exact match
  CALLBACK: "CALLBK", // confirmed exact match
};

async function saveDisposition({
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
  callbackAt,
  comments,
}) {
  const vicidialStatus = DISPOSITION_TO_VICIDIAL_STATUS[disposition];
  if (!vicidialStatus) {
    throw new Error(`Unknown disposition code: ${disposition}`);
  }

  // Required at the application layer, not just via the frontend's
  // disabled-button check — a direct API call shouldn't be able to
  // skip this by bypassing the UI.
  if (!comments || !comments.trim()) {
    throw new Error("Comments are required to save a disposition.");
  }

  const call = activeCalls.get(callId);
  const startedAt = call ? call.startedAt : new Date();
  const endedAt = (call && call.endedAt) || new Date();
  const callType = (call && call.callType) || "REGULAR";

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(
      `
        INSERT INTO cmx_dialer.dialer_call_log
          (agent_user, campaign_id, lead_id, phone_number, first_name, last_name,
           room_number, call_id, call_type, call_started_at, call_ended_at, disposition,
           comments, callback_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agentUser, campaignId, leadId, phoneNumber, firstName || null, lastName || null,
        room, callId, callType, startedAt, endedAt, disposition, comments.trim(), callbackAt || null,
      ]
    );

    await connection.execute(
      `
        UPDATE vicidial_list
        SET status = ?, called_since_last_reset = 'Y'
        WHERE lead_id = ?
      `,
      [vicidialStatus, leadId]
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  if (call) {
    activeCalls.delete(callId);
  }

  // TODO (next step, not yet built): if campaignId === "CMXBSMSC" and a
  // recording file exists at recordingPathForCall(callId), kick off the
  // S3 upload here — fire-and-forget, same pattern as the welcome email
  // elsewhere in this codebase, never blocking this function's return
  // on the upload finishing.

  // Finishing a disposition always drops the agent back to READY —
  // a product assumption, not confirmed with anyone. The alternative
  // would be returning them to whatever they were in before the call
  // (e.g. NOT_READY), which ViciDial itself doesn't do by default
  // either, so READY seemed the safer default to start with.
  try {
    await agentStatusService.setStatus(appUserId, "READY");
  } catch (err) {
    console.error("[dialerService] Failed to set READY status after disposition:", err.message);
  }

  return { disposition, vicidialStatus };
}

/*
==================================================
getCallLog
==================================================
Call history for the current agent — used by the DialerPage's
"Call Logs" table. Combines BOTH outbound (dialer_call_log) and
inbound (inbound_call_log) — separate tables by design, since inbound
has genuinely different fields (caller_id_number, no lead/campaign) —
tagging each row with its direction so the UI can show which is which.

Filtered to "today" using the same self-calibrating EST/EDT boundary
as statsService.js. NOTE: this filter was missing entirely until now —
a real bug, not a timezone-math issue — which is why "yesterday's"
calls were showing: there was no date filter applied at all before.
==================================================
*/
async function getCallLog(agentUser, campaignId, limit = 50) {
  const { start, end } = await getEasternDayBoundsForServerClock();

  const [rows] = await db.execute(
    `
      (
        SELECT
          'outbound' AS direction,
          call_log_id,
          call_id,
          lead_id,
          call_type,
          call_started_at,
          first_name,
          last_name,
          phone_number,
          NULL AS callback_number,
          disposition
        FROM cmx_dialer.dialer_call_log
        WHERE agent_user = ?
          AND campaign_id = ?
          AND call_started_at BETWEEN ? AND ?
      )
      UNION ALL
      (
        SELECT
          'inbound' AS direction,
          call_log_id,
          call_id,
          NULL AS lead_id,
          NULL AS call_type,
          call_started_at,
          first_name,
          last_name,
          caller_id_number AS phone_number,
          callback_number,
          disposition
        FROM cmx_dialer.inbound_call_log
        WHERE agent_user = ?
          AND campaign_id = ?
          AND call_started_at BETWEEN ? AND ?
      )
      ORDER BY call_started_at DESC
      LIMIT ?
    `,
    [agentUser, campaignId, start, end, agentUser, campaignId, start, end, limit]
  );

  return rows;
}

/*
==================================================
getActiveCallPhoneNumbers
==================================================
Used by adminRoutes.js's /live-status to show the customer's phone
number ("Caller ID" column) for agents currently IN_CALL/ON_HOLD/ACW —
NOT available from any database table for a still-in-progress call,
since dialer_call_log only gets a row once the disposition is SAVED
(i.e. the call has already ended). This is the one place that phone
number actually lives while the call is still live: right here, in
this in-memory Map. Returns a plain { [callId]: phoneNumber } object,
not the full call objects, since that's all reporting needs.
==================================================
*/
function getActiveCallPhoneNumbers() {
  const result = {};
  for (const call of activeCalls.values()) {
    if (call.status !== "ended") {
      result[call.callId] = call.phoneNumber;
    }
  }
  return result;
}

module.exports = {
  getNextLead,
  startCall,
  getCallStatus,
  getActiveCallForAgent,
  getRawActiveCallForAgent,
  getActiveCallPhoneNumbers,
  endCall,
  holdCall,
  unholdCall,
  saveDisposition,
  getCallLog,
  recordingPathForCall,
};