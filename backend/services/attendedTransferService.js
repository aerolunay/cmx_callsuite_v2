"use strict";

const ami = require("../config/ami");
const dialerService = require("./dialerService");
const inboundCallService = require("./inboundCallService");
const conferenceService = require("./conferenceService");

/*
==================================================
ATTENDED TRANSFER ("Line 2") — per explicit request
==================================================
Real attended transfer, built on top of the dialplan patterns already
PROVEN by this app's own existing Hold/Unhold and agent-leg-join
logic — no dialplan changes needed at all. Confirmed via
extensions.conf directly:

  _9600XXX / _9700XXX   -> ConfBridge(${EXTEN}, vici_agent_bridge, cmx_inbound_customer)
                            (bare room number = join as the UNMARKED
                            "customer" profile)
  _29600XXX / _29700XXX -> ConfBridge(${EXTEN:1}, vici_agent_bridge, vici_agent_user)
                            ("2" + room number = join the SAME room as
                            the MARKED "agent" profile)

Line 2 works by:
  1. Put the ORIGINAL customer on hold (existing holdCall/
     holdInboundCall — they must hear nothing about Line 2 at all).
  2. Allocate a brand new, empty, PRIVATE room (always via
     dialerService's own 9600XXX allocator, regardless of whether the
     original call was inbound or outbound — Line 2 is inherently an
     "agent dialing out" action).
  3. Redirect the AGENT's own channel into that new room via the
     "2"-prefixed pattern (rejoins as a marked user, same as their
     original leg).
  4. Originate the Line 2 target into that same new room — reuses
     conferenceService.addParticipant() exactly as-is; a fresh room
     with only the agent in it needs no exclusions.
  5. Once the agent decides:
     - Transfer: redirect the customer (still on hold) straight into
       Line 2's room, then hang up the agent's own leg (now sitting in
       that room) — completing the handoff. The original room is
       released.
     - Conference: same redirect, but the agent's leg stays — a real
       3-way, with everyone having heard the private Line 2
       conversation only from the agent's side, never the customer's.
     - Cancel: redirect the agent back to the ORIGINAL room, unhold
       the customer, hang up whatever's in Line 2's room, release it.

Every failure path is written to leave the ORIGINAL call exactly as it
was before Line 2 was attempted — the customer should never be left
stranded on hold with no way back if Line 2 fails at any step.
==================================================
*/

/*
resolveRoomReleaser(isInbound) -> function(room) => void
Room1 could be either series (9600 outbound / 9700 inbound), each with
its own independent allocator — releasing it needs to go through the
SAME service that originally allocated it, or that service's own
usedRoomSuffixes tracking would never actually free it up.
*/
function releaseOriginalRoom(room, isInbound) {
  const suffix = room.slice(-3);
  if (isInbound) {
    inboundCallService.releaseRoomSuffix(suffix);
  } else {
    dialerService.releaseRoomSuffix(suffix);
  }
}

async function holdOriginalCustomer(callId, isInbound) {
  if (isInbound) {
    await inboundCallService.holdInboundCall(callId);
  } else {
    await dialerService.holdCall(callId);
  }
}

async function unholdOriginalCustomer(callId, isInbound) {
  if (isInbound) {
    await inboundCallService.unholdInboundCall(callId);
  } else {
    await dialerService.unholdCall(callId);
  }
}

/*
==================================================
startLineTwo
==================================================
active: the object returned by dialerRoutes.js's resolveActiveRoom —
{ room, agentChannel, customerChannel, rawCall, callId, isInbound }.

Resolves { success: true, room } once the Line 2 target answers, or
{ success: false, reason } if they don't/can't be reached — mirroring
conferenceService.addParticipant's own contract. On failure, the
ORIGINAL call is left exactly as it was (agent back in room1, customer
unheld) — nothing about Line 2 failing should ever strand anyone.
==================================================
*/
async function startLineTwo(active, target, isExtension) {
  const { room: room1, agentChannel, callId, isInbound, rawCall } = active;

  if (rawCall.lineTwo) {
    throw new Error("Line 2 is already in progress for this call.");
  }

  await holdOriginalCustomer(callId, isInbound);

  const room2Suffix = dialerService.allocateRoomSuffix();
  const room2 = dialerService.roomFromSuffix(room2Suffix);

  try {
    await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${room2}` });
  } catch (err) {
    dialerService.releaseRoomSuffix(room2Suffix);
    await unholdOriginalCustomer(callId, isInbound).catch(() => {});
    throw err;
  }

  const result = await conferenceService.addParticipant(room2, target, isExtension, "Line 2", []);

  if (!result.success) {
    // Target didn't answer / couldn't be reached — move the agent
    // back to room1 and unhold the customer, exactly restoring the
    // original call.
    await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${room1}` }).catch((err) => {
      console.error("[attendedTransferService] Failed to move agent back to room1 after Line 2 failure:", err.message);
    });
    await unholdOriginalCustomer(callId, isInbound).catch((err) => {
      console.error("[attendedTransferService] Failed to unhold customer after Line 2 failure:", err.message);
    });
    dialerService.releaseRoomSuffix(room2Suffix);
    return { success: false, reason: result.reason };
  }

  rawCall.lineTwo = {
    room: room2,
    roomSuffix: room2Suffix,
    targetChannel: result.channel,
  };

  return { success: true, room: room2 };
}

/*
==================================================
completeLineTwo
==================================================
action: "transfer" (agent leaves) or "conference" (agent stays).
Moves the customer from hold directly into Line 2's room, then either
drops the agent's leg or keeps it. Room1 is released — it's now empty.
==================================================
*/
async function completeLineTwo(active, action) {
  const { room: room1, agentChannel, customerChannel, isInbound, rawCall } = active;
  const lineTwo = rawCall.lineTwo;
  if (!lineTwo) {
    throw new Error("No Line 2 is currently active for this call.");
  }

  // REAL BUG FIX, confirmed via a real test call: the customer hung
  // up on their own while sitting on hold waiting for Line 2 — a
  // completely plausible real-world scenario this code never
  // accounted for. redirectChannel on an already-gone channel throws
  // ("Channel does not exist"), which was an UNCAUGHT exception,
  // producing a 500 and leaving the agent stuck: their own channel
  // was still correctly in Line 2's room the whole time, but neither
  // Transfer/Conference (this function) nor Cancel could complete
  // cleanly afterward, since both assumed the customer would always
  // still be there.
  //
  // Now: if the customer is confirmed gone, there's nothing left to
  // bring together — clean up Line 2's target and room, and tell the
  // caller plainly what happened, instead of throwing.
  try {
    await ami.redirectChannel(customerChannel, { context: "trunkinbound", exten: lineTwo.room });
  } catch (err) {
    console.error("[attendedTransferService] Customer channel gone when completing Line 2 (they likely hung up while on hold):", err.message);

    // The customer is gone, but the agent's Line 2 conversation is
    // still genuinely live — hanging it up too would be presumptuous
    // (they may well want to keep talking to whoever's on Line 2).
    // Instead, PROMOTE Line 2 into the primary tracked call: room2
    // becomes the tracked room, the target becomes the tracked
    // "customer" slot (so a later normal Hang Up correctly ends
    // things for both parties), room1 (now empty) is released.
    // Nothing about the agent's actual live conversation is touched.
    releaseOriginalRoom(room1, isInbound);
    rawCall.room = lineTwo.room;
    rawCall.roomSuffix = lineTwo.roomSuffix;
    rawCall.customerChannel = lineTwo.targetChannel;
    rawCall.onHold = false;
    rawCall.lineTwo = null;

    if (isInbound) {
      inboundCallService.rekeyInboundCallRoom(room1, lineTwo.room);
    }

    return { success: false, reason: "customer_disconnected" };
  }

  if (action === "transfer") {
    await ami.hangupChannel(agentChannel).catch((err) => {
      console.error("[attendedTransferService] Failed to hang up agent leg after Line 2 transfer:", err.message);
    });
    rawCall.agentChannel = lineTwo.targetChannel;
  } else {
    rawCall.extraParticipants = [...(rawCall.extraParticipants || []), lineTwo.targetChannel];
  }

  releaseOriginalRoom(room1, isInbound);

  const newRoom = lineTwo.room;
  rawCall.room = newRoom;
  rawCall.roomSuffix = lineTwo.roomSuffix;
  rawCall.onHold = false;
  rawCall.lineTwo = null;

  if (isInbound) {
    inboundCallService.rekeyInboundCallRoom(room1, newRoom);
  }

  return { success: true };
}

/*
==================================================
cancelLineTwo
==================================================
Agent changes their mind — hang up whatever's in Line 2's room, move
the agent back to the original room, unhold the customer, release
Line 2's room. Original call ends up exactly as it was before Line 2
was ever attempted.
==================================================
*/
async function cancelLineTwo(active) {
  const { room: room1, agentChannel, callId, isInbound, rawCall } = active;
  const lineTwo = rawCall.lineTwo;
  if (!lineTwo) {
    throw new Error("No Line 2 is currently active for this call.");
  }

  if (lineTwo.targetChannel) {
    await ami.hangupChannel(lineTwo.targetChannel).catch((err) => {
      console.error("[attendedTransferService] Failed to hang up Line 2 target on cancel:", err.message);
    });
  }

  await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${room1}` });

  dialerService.releaseRoomSuffix(lineTwo.roomSuffix);
  rawCall.lineTwo = null;

  try {
    await unholdOriginalCustomer(callId, isInbound);
  } catch (err) {
    // REAL BUG FIX, same root cause as completeLineTwo's own fix: the
    // customer may have hung up on their own while sitting on hold.
    // Here (unlike completeLineTwo) the agent explicitly chose to
    // cancel Line 2 too — so if the customer's also gone, there's
    // genuinely nothing left at all. End the call cleanly (normal
    // ACW/disposition path) rather than leaving the agent stuck back
    // in an empty room with no one to talk to.
    console.error("[attendedTransferService] Customer channel gone when canceling Line 2 (they likely hung up while on hold):", err.message);
    if (isInbound) {
      await inboundCallService.endInboundCall(room1).catch(() => {});
    } else {
      await dialerService.endCall(callId).catch(() => {});
    }
    return { success: true, customerAlreadyGone: true };
  }

  return { success: true };
}

module.exports = { startLineTwo, completeLineTwo, cancelLineTwo };