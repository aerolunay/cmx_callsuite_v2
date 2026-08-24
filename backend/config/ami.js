"use strict";

const EventEmitter = require("events");
const AsteriskManager = require("asterisk-manager");

const AMI_HOST = process.env.AMI_HOST;
const AMI_PORT = Number(process.env.AMI_PORT || 5038);
const AMI_USER = process.env.AMI_USER;
const AMI_SECRET = process.env.AMI_SECRET;
const AMI_DEBUG = process.env.AMI_DEBUG === "true";

if (!AMI_HOST || !AMI_USER || !AMI_SECRET) {
  throw new Error(
    "Missing AMI configuration. Set AMI_HOST, AMI_USER, and AMI_SECRET in backend/.env."
  );
}

// Everything else in the app talks to THIS emitter, not to the
// asterisk-manager instance directly — keeps the raw AMI event shape
// (and whichever npm package we're using) out of dialerService.js.
//
// CONFIRMED against a real test call on this server (Asterisk 20.x/PJSIP,
// asterisk-manager npm package) on 2026-08-10:
//   - The package's own per-event listeners (ami.on("confbridgejoin", ...))
//     do NOT reliably fire — its instance "emit" is a locked/read-only
//     property, and lowercase event names are wrong anyway.
//   - The ONLY reliable hook is the "managerevent" catch-all. Every real
//     AMI event arrives there with evt.event as the real PascalCase name
//     exactly as Asterisk sends it (e.g. "ConfbridgeJoin", "Hangup").
//   - All other fields are lowercased by the package, INCLUDING hyphenated
//     ones — e.g. evt["cause-txt"], evt.conference (not evt.Conference).
const events = new EventEmitter();

let ami = null;
let connected = false;

// Real, confirmed event names this app cares about (PascalCase, exactly
// as Asterisk emits them — verified against a live test call transcript).
// OriginateResponse added for Conference/Transfer (Phase E) — needed to
// know whether an Originate'd participant actually answered, matched
// via a caller-supplied ActionID. NOT yet confirmed against a real
// test call the way the others above were — same lowercased-field
// caveat applies (evt.actionid, evt.response, evt.channel), but the
// exact shape hasn't been verified live yet.
const TRACKED_EVENTS = new Set([
  "Newchannel",
  "Newstate",
  "ConfbridgeJoin",
  "ConfbridgeLeave",
  "ConfbridgeEnd",
  "Hangup",
  "OriginateResponse",
]);

function connect() {
  ami = new AsteriskManager(AMI_PORT, AMI_HOST, AMI_USER, AMI_SECRET, true);

  // Auto-reconnect on drop, per spec.
  ami.keepConnected();

  ami.on("connect", () => {
    connected = true;
    console.log(`[AMI] Connected to ${AMI_HOST}:${AMI_PORT} as ${AMI_USER}`);
    events.emit("ami:connected");
  });

  ami.on("close", () => {
    connected = false;
    console.warn("[AMI] Connection closed. asterisk-manager will retry via keepConnected().");
    events.emit("ami:disconnected");
  });

  ami.on("error", (err) => {
    console.error("[AMI] Socket error:", err && err.message ? err.message : err);
    events.emit("ami:error", err);
  });

  // The one reliable hook (see comment above). Dispatch by the real
  // evt.event value rather than trusting the package's own named events.
  ami.on("managerevent", (evt) => {
    if (AMI_DEBUG) {
      console.log("[AMI:raw]", evt.event, evt);
    }

    if (TRACKED_EVENTS.has(evt.event)) {
      events.emit(evt.event, evt);
    }
  });
}

function isConnected() {
  return connected;
}

// Promise-based wrapper around AMI actions (Originate, Hangup, etc.)
function sendAction(action) {
  return new Promise((resolve, reject) => {
    if (!connected) {
      return reject(new Error("AMI is not connected."));
    }

    ami.action(action, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

function originate(options) {
  return sendAction({ action: "Originate", ...options });
}

// Needed for endCall() per spec — force-hangup a channel (e.g. the agent's
// leg) rather than relying on the agent to hang up their softphone.
// Confirmed necessary: a customer hanging up does NOT close the ConfBridge
// room on its own — the agent's channel stays in it until explicitly ended.
function hangupChannel(channel) {
  return sendAction({ action: "Hangup", channel });
}

// Needed for Hold/Unhold — moves a channel to a different
// context/extension without hanging it up (e.g. out of a ConfBridge
// room into a MOH loop, and back again).
function redirectChannel(channel, { context, exten, priority = 1 }) {
  return sendAction({
    action: "Redirect",
    channel,
    context,
    exten,
    priority,
  });
}

/*
==================================================
startRecording / stopRecording — NEW
==================================================
ConfbridgeStartRecord/StopRecord record the FULL conference mix (both
legs together) — the whole point, since the recording needs to
capture the actual conversation, not just one side. `recordfile`
should be an ABSOLUTE path with an explicit .wav extension — recording
naming/location is the CALLER's decision (see inboundCallService.js/
dialerService.js), not something baked in here; this function is
deliberately just a thin, dumb wrapper matching the same pattern as
originate()/hangupChannel()/redirectChannel() above.

No stopRecording call is strictly required before a room closes —
Asterisk stops recording automatically when the ConfBridge itself
ends — but calling it explicitly, right when a call is marked ended
(before the room is torn down), guarantees the file is fully flushed
and closed before anything downstream (the S3 upload) tries to read
it, rather than racing a teardown that might still be finishing a
write.
==================================================
*/
function startRecording(conference, recordfile) {
  return sendAction({
    action: "ConfbridgeStartRecord",
    conference,
    recordfile,
  });
}

function stopRecording(conference) {
  return sendAction({
    action: "ConfbridgeStopRecord",
    conference,
  });
}

/*
==================================================
reloadPjsip — NEW
==================================================
Needed for the Phones admin feature — after our own backend regenerates
the phone-wizard PJSIP file (see adminRoutes.js), this actually applies
it. Uses the "Command" action to run the exact same CLI command we've
been running by hand all session ("pjsip reload"), just from Node
instead of an SSH session.
==================================================
*/
function reloadPjsip() {
  return sendAction({ action: "Command", command: "pjsip reload" });
}

/*
==================================================
reloadDialplan — NEW, for Campaigns
==================================================
Same reasoning/pattern as reloadPjsip() above — after our own backend
regenerates the campaign-DID dialplan file (see campaignRoutes.js),
this applies it. "dialplan reload" ONLY reloads extensions.conf (and
anything it #includes) — it does NOT touch pjsip.conf/endpoints/
transports at all, which is exactly why campaign create/update/delete
is safe to do live: it can never disrupt an in-progress call on a
DIFFERENT campaign, or on the shared trunk, the way a pjsip reload
theoretically could if trunk config itself were ever being changed
(which campaign management never does).
==================================================
*/
function reloadDialplan() {
  return sendAction({ action: "Command", command: "dialplan reload" });
}

connect();

module.exports = {
  events,
  originate,
  hangupChannel,
  redirectChannel,
  isConnected,
  startRecording,
  stopRecording,
  reloadPjsip,
  reloadDialplan,
};