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
RECONNECT-RESTORE (sid -> last status)
==================================================
When an agent's last socket closes and they're not mid-call, their
status gets closed IMMEDIATELY (see registerConnection's "close"
handler below) — no waiting to guess whether this is a real close or
just a page reload, since the browser gives no reliable way to tell
those apart at the JS level (beforeunload/pagehide fire for both).

Instead, correctness comes from session identity, not timing: a page
reload reconnects using the SAME session id (the cookie survives a
reload). A fresh login, by contrast, ALWAYS gets a brand-new session
id — authRoutes.js calls req.session.regenerate() on every login, so
there's no risk of this mechanism ever firing for a genuine fresh
login and stepping on its own NOT_READY-on-login behavior.

So: on close, remember what status this exact sid was in. If that
exact sid reconnects within RECONNECT_WINDOW_MS, restore that status
as a fresh row AND the session survives. If it doesn't come back in
time, the session gets destroyed — reopening the app after that goes
through a real login (new sid via req.session.regenerate(), which
can never collide with this map — see below), landing in NOT_READY
like any fresh login. If a different sid shows up instead of the one
we were waiting for, this map simply has nothing for it — the login
flow's own NOT_READY stands untouched.

Known, accepted trade-off: this closes and reopens a status row on
EVERY reload, fragmenting what was really one continuous period into
several shorter rows in agent_status_log (started_at resets each
time). Doesn't affect current status or inbound routing (isConnected()
below is what actually gates that) — just cosmetic history/reporting
granularity. Not solved here; flagging it rather than hiding it.

Bounded but not actively cleaned up: an entry only lingers if a sid is
abandoned WITHOUT ever reconnecting (real app-close) — harmless at
realistic agent-count scale, and naturally moot once that session
expires anyway.
==================================================
*/
const pendingRestoreBySid = new Map();

// How long a session survives after its last socket closes (and status
// got closed/non-call-tied) before it's destroyed server-side, forcing
// a real login next time. Cancelled if that same sid reconnects first —
// see registerConnection below. Deliberately separate from
// pendingRestoreBySid's restore logic: restoring the STATUS on
// reconnect has no time limit (works whenever they come back, as long
// as the session itself is still alive) — this timer only controls
// whether the SESSION itself is still alive to come back to.
const RECONNECT_WINDOW_MS = 15000;

// sid -> pending session-destroy timer. Cancelled on reconnect with the
// same sid; fires (destroying the session) if that never happens.
const sessionDestroyTimers = new Map();

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
      registerConnection(appUserId, ws, sid);
    });
  });
}

function registerConnection(appUserId, ws, sid) {
  if (!connections.has(appUserId)) {
    connections.set(appUserId, new Set());
  }
  connections.get(appUserId).add(ws);

  // Lazy-required (not at the top of this file) because
  // agentStatusService.js already requires THIS file — a top-level
  // require here would be circular. Safe inside function bodies since
  // by call time both modules are fully loaded regardless of order.
  const agentStatusService = require("../services/agentStatusService");

  // This exact session just reconnected — if we closed a status for
  // it on a previous disconnect, restore it now as a fresh row.
  if (pendingRestoreBySid.has(sid)) {
    const statusToRestore = pendingRestoreBySid.get(sid);
    pendingRestoreBySid.delete(sid);

    agentStatusService.setStatus(appUserId, statusToRestore).catch((err) => {
      console.error(`[ws] Failed to restore status "${statusToRestore}" for appUserId ${appUserId} on reconnect:`, err.message);
    });
  }

  // They're back within the window — the session survives, cancel its
  // pending destruction.
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

    try {
      // Mid-call is the one exception named explicitly: don't touch
      // status OR start the session-destroy timer at all if they're
      // IN_CALL / AFTER_CALL_WORK / ON_HOLD — the call's own
      // hangup/hold handling owns ending that period, and forcing a
      // relogin mid-call would break reconnecting to resume it.
      if (await agentStatusService.isCallTied(appUserId)) return;

      const current = await agentStatusService.getCurrentStatus(appUserId);
      if (!current) return; // nothing open to close

      await agentStatusService.closeCurrentStatus(appUserId);
      pendingRestoreBySid.set(sid, current.status);

      // If they don't come back with this SAME session within
      // RECONNECT_WINDOW_MS, destroy it — reopening the app after that
      // requires a real login again, which sets NOT_READY on its own.
      const timer = setTimeout(() => {
        sessionDestroyTimers.delete(sid);
        pendingRestoreBySid.delete(sid); // nothing left to restore into

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
      console.error(`[ws] Failed to close status for appUserId ${appUserId} on disconnect:`, err.message);
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

module.exports = {
  attach,
  broadcastToUser,
  isConnected,
};