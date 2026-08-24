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
RECONNECT WINDOW — real fix for the "Ready resets on refresh" bug
==================================================
UPDATED — this used to close the agent's status row IMMEDIATELY on
every socket close (see the old comment this replaced, further down
in git history), remembering what status it was in a
`pendingRestoreBySid` map, then reopening a BRAND NEW row with that
same status the instant the same session reconnected. That was
believed to be purely cosmetic ("Doesn't affect current status or
inbound routing... just cosmetic history/reporting granularity") — but
that assumption was WRONG: getAnyReadyAgentWithExtension() orders
candidates by status_log_id ASC (oldest-ready-first), and a fresh row
gets a fresh, LATER status_log_id. So every disconnect/reconnect cycle
(including a plain page refresh, not just the transport-idle-timeout
case the ping/pong loop above already fixed) pushed that agent to the
back of the ready-agent queue — confirmed via real testing where an
agent noticed their own Ready duration visibly resetting on refresh,
which is exactly this. That's a genuine queue-dodging exploit: an
agent could repeatedly refresh to avoid ever surfacing as the
longest-waiting ready agent.

FIX: don't touch the status row on disconnect at all. Just start the
reconnect-window timer (below). If the same session reconnects within
RECONNECT_WINDOW_MS (the overwhelmingly common case — a refresh, a
brief network blip, the idle-timeout case), the ORIGINAL row is still
open with its ORIGINAL started_at and ORIGINAL status_log_id,
completely untouched — there is nothing left to "restore". Only if the
window genuinely elapses without reconnecting do we close the row at
that point (see the timer callback in the close handler below) — at
that point they're actually gone, not just mid-refresh.
==================================================
*/

// Sids currently being force-logged-out (admin kick, or the 12-hour
// auto-logout below) — the normal close handler checks this and skips
// its own restore-window logic entirely for these, since forceLogout()
// already closed the status and destroyed the session itself. Without
// this check, the close event that naturally fires when we forcibly
// close the socket would ALSO run the normal disconnect logic,
// re-opening a restore window for a session we just deliberately
// destroyed.
const forcedLogoutSids = new Set();

// How long a session survives after its last socket closes before its
// status row is actually closed and the session destroyed, forcing a
// real login next time. Cancelled if that same sid reconnects first —
// see registerConnection below.
const RECONNECT_WINDOW_MS = 15000;

// sid -> pending session-destroy timer. Cancelled on reconnect with the
// same sid; fires (closing status + destroying the session) if that
// never happens.
const sessionDestroyTimers = new Map();

/*
==================================================
PING/PONG KEEPALIVE
==================================================
REAL BUG FOUND AND FIXED HERE: with no traffic on an otherwise-idle
WebSocket, Apache's proxy (or any future intermediary — a load
balancer, a corporate firewall) can silently close it once it's been
quiet past its own idle timeout (confirmed: Apache's default here is
60s, unset in this vhost). Every time that happened, our own
disconnect-then-restore logic above fired for real — closing and
reopening the agent's status row — even though the agent never
actually did anything. That's what "Ready resets every minute on the
Live Status Dashboard" actually was: not a bug in the restore logic
itself, but the transport underneath it dying on a schedule neither
side controls.

Fix: send a ping frame every 30s — comfortably under any 60s idle
window — so the connection is never actually idle from any
intermediary's point of view, regardless of what's in front of it.
Standard `ws` library dead-connection pattern as a side benefit: a
socket that doesn't answer a ping with a pong before the next one goes
out is presumed dead and terminated proactively, rather than left
lingering.
==================================================
*/
const PING_INTERVAL_MS = 30000;

function startPingLoop() {
  setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.isAlive === false) {
        ws.terminate(); // no pong since the last ping — presumed dead
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS).unref();
}

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
  startPingLoop();

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

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
      registerConnection(appUserId, ws, sid);
    });
  });
}

function registerConnection(appUserId, ws, sid) {
  ws.sid = sid; // needed by forceLogout() below to destroy the right session

  if (!connections.has(appUserId)) {
    connections.set(appUserId, new Set());
  }
  connections.get(appUserId).add(ws);

  // They're back within the window — the session survives, cancel its
  // pending destruction. Nothing to "restore" here — since the close
  // handler below no longer closes the status row immediately on
  // disconnect, the original row (original started_at, original
  // status_log_id) has simply been sitting open the whole time,
  // completely untouched by any of this.
  const pendingDestroy = sessionDestroyTimers.get(sid);
  if (pendingDestroy) {
    clearTimeout(pendingDestroy);
    sessionDestroyTimers.delete(sid);
  }

  ws.on("close", async () => {
    const set = connections.get(appUserId);
    if (!set) return;
    set.delete(ws);
    if (set.size > 0) return; // other tabs/devices still connected — not gone

    connections.delete(appUserId);

    // forceLogout() below already fully handled closing the status and
    // destroying the session for this sid — don't redo any of that or
    // start a restore-window timer for a session that's deliberately
    // gone for good.
    if (forcedLogoutSids.has(sid)) {
      forcedLogoutSids.delete(sid);
      return;
    }

    // Lazy-required (not at the top of this file) because
    // agentStatusService.js already requires THIS file — a top-level
    // require here would be circular. Safe inside function bodies
    // since by call time both modules are fully loaded regardless of
    // order.
    const agentStatusService = require("../services/agentStatusService");

    try {
      // Mid-call is the one exception named explicitly: don't start
      // the session-destroy timer at all if they're IN_CALL /
      // AFTER_CALL_WORK / ON_HOLD — the call's own hangup/hold
      // handling owns ending that period, and forcing a relogin
      // mid-call would break reconnecting to resume it.
      if (await agentStatusService.isCallTied(appUserId)) return;

      // REAL FIX — see the big comment block above this function for
      // the full "why": do NOT close the status row here. Only start
      // a timer that closes it (and destroys the session) if the
      // window genuinely elapses without a reconnect. A same-session
      // reconnect within the window (registerConnection, above)
      // simply cancels this timer and touches nothing else.
      const timer = setTimeout(async () => {
        sessionDestroyTimers.delete(sid);

        try {
          await agentStatusService.closeCurrentStatus(appUserId);
        } catch (err) {
          console.error(`[ws] Failed to close status for appUserId ${appUserId} after reconnect window expired:`, err.message);
        }

        if (sessionStore) {
          sessionStore.destroy(sid, (err) => {
            if (err) {
              console.error(`[ws] Failed to destroy session ${sid} for appUserId ${appUserId}:`, err.message);
            }
          });
        }
      }, RECONNECT_WINDOW_MS);

      sessionDestroyTimers.set(sid, timer);
    } catch (err) {
      console.error(`[ws] Failed to handle disconnect for appUserId ${appUserId}:`, err.message);
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

/*
Returns true only if this appUserId has at least one OPEN socket right
now. Used by agentStatusService's ready-agent lookup — a DB status row
alone (e.g. a stale READY left open by a session that never logged out
cleanly) is NOT sufficient proof anyone is actually watching the app to
take a call. Without this, inbound routing can ring a softphone that's
registered but has nobody behind the DialerPage at all.
*/
function isConnected(appUserId) {
  const set = connections.get(appUserId);
  if (!set) return false;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/*
==================================================
forceLogout(appUserId, reason)
==================================================
Used by BOTH the admin "kick" feature and the 12-hour auto-logout
check below — closes the agent's current status immediately, destroys
their server-side session outright (not the normal "wait
RECONNECT_WINDOW_MS in case they reload" path), and pushes a message
so their open tab(s) can show why and redirect to login, rather than
just going dead with no explanation.

Deliberately closes status EVEN IF they have no live connection right
now (a stale DB row with nobody behind it should still be forcibly
closed) — the loop over live sockets below only handles the
session-destroy/notify part, which naturally does nothing if they're
not currently connected at all.
==================================================
*/
async function forceLogout(appUserId, reason) {
  const agentStatusService = require("../services/agentStatusService");

  try {
    const current = await agentStatusService.getCurrentStatus(appUserId);
    if (current) {
      await agentStatusService.closeCurrentStatus(appUserId);
    }
  } catch (err) {
    console.error(`[ws] forceLogout: failed to close status for appUserId ${appUserId}:`, err.message);
  }

  const set = connections.get(appUserId);
  if (!set) return; // not currently connected — status close above is all that's needed

  for (const ws of set) {
    const sid = ws.sid;
    if (sid) {
      forcedLogoutSids.add(sid);

      const pendingDestroy = sessionDestroyTimers.get(sid);
      if (pendingDestroy) {
        clearTimeout(pendingDestroy);
        sessionDestroyTimers.delete(sid);
      }

      if (sessionStore) {
        sessionStore.destroy(sid, (err) => {
          if (err) console.error(`[ws] forceLogout: failed to destroy session ${sid}:`, err.message);
        });
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "forceLogout", reason: reason || "logged_out" }));
      ws.close(4002, "Forced logout");
    }
  }

  connections.delete(appUserId);
}

module.exports = {
  attach,
  broadcastToUser,
  isConnected,
  forceLogout,
};