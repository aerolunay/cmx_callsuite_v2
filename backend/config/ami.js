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
const TRACKED_EVENTS = new Set([
  "Newchannel",
  "Newstate",
  "ConfbridgeJoin",
  "ConfbridgeLeave",
  "ConfbridgeEnd",
  "Hangup",
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

connect();

module.exports = {
  events,
  originate,
  hangupChannel,
  isConnected,
};