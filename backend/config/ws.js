"use strict";

const cookie = require("cookie");
const cookieSignature = require("cookie-signature");
const WebSocket = require("ws");

const SESSION_NAME = process.env.SESSION_NAME || "cmx_dialer_session";

let wss = null;
let sessionStore = null;

// appUserId -> Set of live ws connections (an agent could have more
// than one tab/device open at once).
const connections = new Map();

/*
==================================================
attach(httpServer, store)
==================================================
Wires the WebSocket server onto the SAME HTTP server Express uses
(one port, no separate WS port to open/firewall), and identifies each
connecting client by decoding + verifying their existing session
cookie against the same session-file-store express-session already
uses — NOT by trusting a client-supplied user ID, which would let any
socket claim to be any agent.
==================================================
*/
function attach(httpServer, store) {
  sessionStore = store;
  wss = new WebSocket.Server({ server: httpServer, path: "/ws/dialer" });

  wss.on("connection", (ws, req) => {
    const cookies = cookie.parse(req.headers.cookie || "");
    const raw = cookies[SESSION_NAME];

    if (!raw) {
      ws.close(4001, "No session cookie.");
      return;
    }

    // express-session cookies are signed as "s:<sid>.<hmac>" — verify
    // and strip the signature using the same SESSION_SECRET, rather
    // than trusting whatever's in the cookie unverified.
    const decoded = decodeURIComponent(raw);
    if (!decoded.startsWith("s:")) {
      ws.close(4001, "Malformed session cookie.");
      return;
    }

    const sid = cookieSignature.unsign(decoded.slice(2), process.env.SESSION_SECRET);
    if (!sid) {
      ws.close(4001, "Invalid session signature.");
      return;
    }

    sessionStore.get(sid, (err, session) => {
      if (err || !session || !session.agent || !session.agent.appUserId) {
        ws.close(4001, "No authenticated session.");
        return;
      }

      const appUserId = session.agent.appUserId;
      registerConnection(appUserId, ws);
    });
  });
}

function registerConnection(appUserId, ws) {
  if (!connections.has(appUserId)) {
    connections.set(appUserId, new Set());
  }
  connections.get(appUserId).add(ws);

  ws.on("close", () => {
    const set = connections.get(appUserId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) connections.delete(appUserId);
    }
  });
}

/*
Sends a JSON message to every live connection for a given app_user_id.
Silently does nothing if that agent has no open socket (e.g. hasn't
loaded the DialerPage yet) — callers don't need to check first.
*/
function broadcastToUser(appUserId, message) {
  const set = connections.get(appUserId);
  if (!set) return;

  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

module.exports = {
  attach,
  broadcastToUser,
};
