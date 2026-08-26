"use strict";

const ami = require("../config/ami");
const dialerService = require("./dialerService");
const inboundCallService = require("./inboundCallService");
const conferenceService = require("./conferenceService");

/*
==================================================
ATTENDED TRANSFER — Line 1 / Line 2 toggle model, per explicit request
==================================================
Rebuilt to match a real 3CX-style two-line phone: Line 1 is the
original call; Line 2 is a second, private line the agent can dial
out on once Line 1 is held. The agent can freely SWITCH their own
audio between the two lines (not just once, at the start/end of Line
2 — any number of times), and can complete a handoff (Transfer,
they leave) or bring everyone together (Conference, they stay) at ANY
point — including while Line 2 is still ringing, before anyone's
answered it (a "cold" transfer/conference) or after talking to them
privately first (a "warm" one). Both are literally the SAME action,
completeLineTwo — the only difference is WHEN the agent chooses to
call it. Retrying after a failed/unanswered Line 2 attempt reuses the
same private room rather than tearing everything down and starting
over.

Still built entirely on the dialplan patterns already proven earlier
this session (confirmed directly via extensions.conf, no dialplan
changes needed):
  _9600XXX / _9700XXX   -> ConfBridge(${EXTEN}, vici_agent_bridge, cmx_inbound_customer)
                            (bare room number = join as UNMARKED)
  _29600XXX / _29700XXX -> ConfBridge(${EXTEN:1}, vici_agent_bridge, vici_agent_user)
                            ("2" + room number = join as MARKED)

KEY SIMPLIFICATION that makes switching practical: redirecting a
channel to a new dialplan location does NOT change its own channel
NAME — it's the same physical channel the whole time, just relocated.
So call.agentChannel and call.customerChannel never need to change
value at all while switching lines; only WHICH ROOM they're each
currently sitting in changes. call.room/call.customerChannel always
refer to Line 1 specifically (never repointed while merely switching)
— this is what keeps existing hold/disposition/recording logic
correct regardless of which line the agent is actively listening to.

HOLD ON THE "OTHER" LINE is implemented by explicitly redirecting
whichever party is being left behind to the same shared "cmxhold" MOH
extension already used for Line 1 (not by relying on ConfBridge's own
marked/unmarked silence-when-alone behavior) — more predictable and
consistent than mixing two different silencing mechanisms depending on
which line is involved.

KNOWN LIMITATION, flagged rather than glossed over: while Line 2 is
still ringing, Line 1's customer (once merged in) hears SILENCE, not
literal ringback tone matching Line 2's real progress — this app's
ConfBridge-based architecture has no ringback audio to pipe through
for a channel that hasn't answered yet. Achieving true ringback parity
would need a materially different call-routing design.
==================================================
*/

const CONFBRIDGE_JOIN_CONFIRM_TIMEOUT_MS = 8000;

function waitForConfbridgeJoin(room, channel, timeoutMs = CONFBRIDGE_JOIN_CONFIRM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(fn, arg) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ami.events.removeListener("ConfbridgeJoin", onJoin);
      fn(arg);
    }

    const timeout = setTimeout(() => finish(reject, new Error("Timed out waiting for ConfbridgeJoin.")), timeoutMs);

    function onJoin(evt) {
      if (evt.conference !== room || evt.channel !== channel) return;
      finish(resolve, evt);
    }

    ami.events.on("ConfbridgeJoin", onJoin);
  });
}

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

async function holdChannel(channel) {
  await ami.redirectChannel(channel, { context: "trunkinbound", exten: "cmxhold" });
}

async function unholdChannelIntoRoom(channel, room) {
  await ami.redirectChannel(channel, { context: "trunkinbound", exten: room });
}

async function startLineTwo(active, target, isExtension) {
  const { room: room1, agentChannel, callId, isInbound, rawCall } = active;

  const existing = rawCall.lineTwo;
  const isRetry = existing && existing.status === "failed";

  if (existing && !isRetry) {
    throw new Error("Line 2 is already in progress for this call.");
  }

  let room2, room2Suffix;

  if (isRetry) {
    room2 = existing.room;
    room2Suffix = existing.roomSuffix;
    // rawCall.lineTwo (the "failed" one) is already set, already
    // arming the ConfbridgeLeave/Hangup guards below — nothing further
    // needed here for the retry case.
  } else {
    room2Suffix = dialerService.allocateRoomSuffix();
    room2 = dialerService.roomFromSuffix(room2Suffix);

    // REAL BUG FIX, confirmed via a real test call: this used to get
    // set only AFTER the agent's redirect (and waitForConfbridgeJoin)
    // had already succeeded — leaving a real window where the
    // ConfbridgeLeave/Hangup guards in inboundCallService.js weren't
    // armed yet when the agent's own channel actually left room1 (an
    // expected, intentional side effect of THIS redirect). Without the
    // guard active in time, that leave looked exactly like the agent
    // hanging up, ending the whole call immediately — customer
    // disconnected, agent sent to ACW, right as Line 2 was only just
    // starting. Same fix pattern already proven in holdInboundCall's
    // own onHold flag: arm the marker BEFORE issuing the redirect that
    // triggers the event it needs to suppress, not after.
    rawCall.lineTwo = { room: room2, roomSuffix: room2Suffix, targetChannel: null, status: "starting", settled: null };

    try {
      await holdOriginalCustomer(callId, isInbound);
      await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${room2}` });
    } catch (err) {
      rawCall.lineTwo = null; // roll back the marker — setup itself failed, guards should NOT stay armed
      dialerService.releaseRoomSuffix(room2Suffix);
      await unholdOriginalCustomer(callId, isInbound).catch(() => {});
      throw err;
    }

    try {
      await waitForConfbridgeJoin(room2, agentChannel);
    } catch (err) {
      console.error("[attendedTransferService] Never confirmed agent joined room2 — proceeding anyway:", err.message);
    }
  }

  const lineTwoState = {
    room: room2,
    roomSuffix: room2Suffix,
    targetChannel: null,
    status: "ringing",
    settled: null,
  };
  rawCall.lineTwo = lineTwoState;
  rawCall.activeLine = 2;

  conferenceService
    .addParticipant(room2, target, isExtension, "Line 2", [])
    .then((result) => {
      if (lineTwoState.settled === "canceled") {
        if (result.success) {
          ami.hangupChannel(result.channel).catch(() => {});
        }
        return;
      }
      if (rawCall.lineTwo !== lineTwoState) return;
      if (result.success) {
        lineTwoState.targetChannel = result.channel;
        lineTwoState.status = "connected";
      } else {
        lineTwoState.status = "failed";
        lineTwoState.failureReason = result.reason;
      }
    })
    .catch((err) => {
      console.error("[attendedTransferService] Line 2 dial promise rejected unexpectedly:", err.message);
    });

  return { success: true, room: room2 };
}

function getLineTwoStatus(active) {
  const { rawCall } = active;
  if (!rawCall.lineTwo) {
    return { active: false, activeLine: rawCall.activeLine || 1 };
  }
  return {
    active: true,
    activeLine: rawCall.activeLine,
    status: rawCall.lineTwo.status,
    failureReason: rawCall.lineTwo.failureReason,
  };
}

async function switchToLineOne(active) {
  const { room: room1, agentChannel, callId, isInbound, rawCall } = active;
  const lineTwo = rawCall.lineTwo;
  if (!lineTwo) {
    throw new Error("Line 2 is not active for this call.");
  }
  if (rawCall.activeLine === 1) {
    return { success: true };
  }

  if (lineTwo.targetChannel) {
    await holdChannel(lineTwo.targetChannel).catch((err) => {
      console.error("[attendedTransferService] Failed to hold Line 2 target when switching to Line 1:", err.message);
    });
  }

  await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${room1}` });
  await unholdOriginalCustomer(callId, isInbound);

  rawCall.activeLine = 1;
  return { success: true };
}

async function switchToLineTwo(active) {
  const { agentChannel, callId, isInbound, rawCall } = active;
  const lineTwo = rawCall.lineTwo;
  if (!lineTwo) {
    throw new Error("Line 2 is not active for this call.");
  }
  if (rawCall.activeLine === 2) {
    return { success: true };
  }

  await holdOriginalCustomer(callId, isInbound);
  await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${lineTwo.room}` });

  if (lineTwo.targetChannel) {
    await unholdChannelIntoRoom(lineTwo.targetChannel, lineTwo.room).catch((err) => {
      console.error("[attendedTransferService] Failed to unhold Line 2 target when switching to Line 2:", err.message);
    });
  }

  rawCall.activeLine = 2;
  return { success: true };
}

async function completeLineTwo(active, action) {
  const { room: room1, agentChannel, customerChannel, callId, isInbound, rawCall } = active;
  const lineTwo = rawCall.lineTwo;
  if (!lineTwo) {
    throw new Error("No Line 2 is currently active for this call.");
  }

  try {
    await ami.redirectChannel(customerChannel, { context: "trunkinbound", exten: lineTwo.room });
  } catch (err) {
    console.error("[attendedTransferService] Customer channel gone when completing Line 2 (they likely hung up while on hold):", err.message);

    releaseOriginalRoom(room1, isInbound);
    rawCall.room = lineTwo.room;
    rawCall.roomSuffix = lineTwo.roomSuffix;
    rawCall.customerChannel = lineTwo.targetChannel;
    rawCall.onHold = false;
    rawCall.activeLine = 2;
    rawCall.lineTwo = null;

    if (isInbound) {
      inboundCallService.rekeyInboundCallRoom(room1, lineTwo.room);
    }

    return { success: false, reason: "customer_disconnected" };
  }

  if (rawCall.activeLine !== 2) {
    await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${lineTwo.room}` }).catch((err) => {
      console.error("[attendedTransferService] Failed to move agent into Line 2's room when completing:", err.message);
    });
  }

  rawCall.extraParticipants = [...(rawCall.extraParticipants || []), lineTwo.targetChannel || "line-two-pending"];
  rawCall.room = lineTwo.room;
  rawCall.roomSuffix = lineTwo.roomSuffix;
  rawCall.onHold = false;
  rawCall.activeLine = 2;
  rawCall.lineTwo = null;

  if (isInbound) {
    inboundCallService.rekeyInboundCallRoom(room1, lineTwo.room);
  }

  releaseOriginalRoom(room1, isInbound);

  if (action === "transfer") {
    if (isInbound) {
      await inboundCallService.endInboundCall(lineTwo.room).catch((err) => {
        console.error("[attendedTransferService] endInboundCall failed after Line 2 transfer:", err.message);
      });
    } else {
      await dialerService.endCall(callId).catch((err) => {
        console.error("[attendedTransferService] endCall failed after Line 2 transfer:", err.message);
      });
    }
  }

  return { success: true };
}

async function cancelLineTwo(active) {
  const { room: room1, agentChannel, callId, isInbound, rawCall } = active;
  const lineTwo = rawCall.lineTwo;
  if (!lineTwo) {
    throw new Error("No Line 2 is currently active for this call.");
  }

  lineTwo.settled = "canceled";

  if (lineTwo.targetChannel) {
    await ami.hangupChannel(lineTwo.targetChannel).catch((err) => {
      console.error("[attendedTransferService] Failed to hang up Line 2 target on cancel:", err.message);
    });
  }

  await ami.redirectChannel(agentChannel, { context: "trunkinbound", exten: `2${room1}` });

  dialerService.releaseRoomSuffix(lineTwo.roomSuffix);
  rawCall.lineTwo = null;
  rawCall.activeLine = 1;

  try {
    await unholdOriginalCustomer(callId, isInbound);
  } catch (err) {
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

module.exports = {
  startLineTwo,
  getLineTwoStatus,
  switchToLineOne,
  switchToLineTwo,
  completeLineTwo,
  cancelLineTwo,
};