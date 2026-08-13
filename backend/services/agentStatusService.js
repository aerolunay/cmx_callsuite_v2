"use strict";

const EventEmitter = require("events");
const db = require("../config/db");
const ws = require("../config/ws");

// Internal event bus for other modules (inboundCallService.js) to react
// to status transitions without requiring dialerService.js/inboundCallService.js
// directly here — avoids a circular require, since those modules already
// require this one.
const statusEvents = new EventEmitter();

/*
==================================================
AGENT STATUS
==================================================
Five statuses total. Three are agent-selectable (via the dropdown on
DialerPage); two are system-controlled and should never be settable
directly through the manual-switch endpoint — they're driven entirely
by real call events (see dialerService.js).

  NOT_READY        — agent-selectable. Logged in, not taking calls.
  READY             — agent-selectable. Available for next call.
  ON_HOLD           — agent-selectable. Agent-level break/hold state
                       (distinct from putting a customer on hold mid-call
                       — no such customer-hold feature exists yet).
  IN_CALL           — system only. Set when a call starts.
  AFTER_CALL_WORK   — system only. Set automatically when a call ends,
                       cleared automatically back to READY once a
                       disposition is saved (see dialerService.js
                       saveDisposition — this is a product assumption,
                       not confirmed with anyone: that finishing a
                       disposition should always drop the agent straight
                       to READY rather than back to whatever they were
                       in before the call, e.g. NOT_READY).
==================================================
*/
const MANUAL_STATUSES = new Set(["NOT_READY", "READY", "ON_HOLD", "AUX_CB", "AD_HOC"]);
const ALL_STATUSES = new Set(["NOT_READY", "READY", "ON_HOLD", "AUX_CB", "AD_HOC", "IN_CALL", "AFTER_CALL_WORK"]);

/*
==================================================
STATUS CLASSIFICATION — for future reporting
==================================================
No occupancy% or productive-hours report exists yet, but this
classification is a real business rule established explicitly, so
it's captured here as the canonical source rather than left to be
re-derived (and possibly gotten wrong) whenever that reporting is
eventually built.

PRODUCTIVE_STATUSES: counts as productive work time. Includes AD_HOC
(admin tasks while logged in — real work, just not call-related).

OCCUPANCY_STATUSES: counts as "available for calls" time. Deliberately
EXCLUDES AD_HOC — an AD_HOC agent cannot receive a call, so counting
that time as "available" would be wrong even though it's productive.
==================================================
*/
const PRODUCTIVE_STATUSES = new Set(["READY", "AD_HOC", "IN_CALL", "AFTER_CALL_WORK", "ON_HOLD", "AUX_CB"]);
const OCCUPANCY_STATUSES = new Set(["READY", "IN_CALL", "AFTER_CALL_WORK", "ON_HOLD", "AUX_CB"]);

function isManualStatus(status) {
  return MANUAL_STATUSES.has(status);
}

async function getCurrentStatus(appUserId) {
  const [rows] = await db.execute(
    `
      SELECT status, started_at, TIMESTAMPDIFF(SECOND, started_at, NOW()) AS elapsed_seconds
      FROM cmx_dialer.agent_status_log
      WHERE app_user_id = ? AND ended_at IS NULL
      ORDER BY status_log_id DESC
      LIMIT 1
    `,
    [appUserId]
  );

  if (!rows.length) return null;

  return { status: rows[0].status, elapsedSeconds: rows[0].elapsed_seconds };
}

/*
setStatus closes whatever status period is currently open (recording
its real duration) and opens a new one. Broadcasts the change over the
WebSocket so any connected client for this agent updates live instead
of needing to poll.
*/
/*
==================================================
closeCurrentStatus
==================================================
Closes whatever status row is currently open, WITHOUT opening a new
one — leaving the agent with no open row at all. That absence is what
"Logged Out" means on the live-status dashboard. Used by logout;
without this, a status row would stay open forever after logging out,
indistinguishable from someone still genuinely active in that status.
==================================================
*/
async function closeCurrentStatus(appUserId) {
  await db.execute(
    `
      UPDATE cmx_dialer.agent_status_log
      SET ended_at = NOW(), duration_seconds = TIMESTAMPDIFF(SECOND, started_at, NOW())
      WHERE app_user_id = ? AND ended_at IS NULL
    `,
    [appUserId]
  );
}

async function setStatus(appUserId, status, options = {}) {
  if (!ALL_STATUSES.has(status)) {
    throw new Error(`Unknown agent status: ${status}`);
  }

  const { relatedCallDirection = null, relatedCampaignId = null, relatedCallId = null } = options;

  await db.execute(
    `
      UPDATE cmx_dialer.agent_status_log
      SET ended_at = NOW(), duration_seconds = TIMESTAMPDIFF(SECOND, started_at, NOW())
      WHERE app_user_id = ? AND ended_at IS NULL
    `,
    [appUserId]
  );

  await db.execute(
    `INSERT INTO cmx_dialer.agent_status_log (app_user_id, status, related_call_direction, related_campaign_id, related_call_id, started_at) VALUES (?, ?, ?, ?, ?, NOW())`,
    [appUserId, status, relatedCallDirection, relatedCampaignId, relatedCallId]
  );

  const current = await getCurrentStatus(appUserId);

  ws.broadcastToUser(appUserId, {
    type: "agentStatus",
    status: current.status,
    elapsedSeconds: current.elapsedSeconds,
  });

  statusEvents.emit("statusChanged", { appUserId, status });

  return current;
}

/*
==================================================
getAnyReadyAgentWithExtension
==================================================
Used by inboundCallService.js to find someone to ring when a customer
is waiting. Resolves candidates' PJSIP extension the same way
authRoutes.js does at login.

REAL BUG FIXED HERE (confirmed via code inspection, not guessed): a
DB status row of READY is NOT proof anyone is actually present in the
app. agent_status_log rows are only ever closed by the explicit
/logout route (see authRoutes.js) — a browser close, crash, laptop
sleep, or session expiry leaves the row open indefinitely. Meanwhile
MicroSIP's PJSIP registration is completely independent of the app
session — it stays registered to Asterisk regardless of whether the
web app is even open. Without this check, inbound routing could (and
did) ring a softphone that's registered but has nobody behind the
DialerPage at all — no incoming-call UI, no caller ID, no way to
answer or disposition it.

Fix: require ws.isConnected(appUserId) — an actual live socket — as
well as the DB status. Loops over ALL READY candidates (not just the
first row) since the first candidate by DB order might be exactly the
stale/disconnected one, or one already excluded; falls through to the
next real candidate instead of returning null outright.

excludeAppUserIds (NEW): lets a caller — specifically
inboundCallService.js's multi-call FIFO matcher — rule out agents
already claimed by A DIFFERENT waiting call in the same matching pass.
Without this, two simultaneously-waiting callers could both get
matched to the SAME ready agent before either Originate finished.
==================================================
*/
async function getAnyReadyAgentWithExtension(excludeAppUserIds = []) {
  const excludeSet = new Set(excludeAppUserIds);

  const [rows] = await db.execute(
    `
      SELECT asl.app_user_id, au.vicidial_user
      FROM cmx_dialer.agent_status_log asl
      JOIN cmx_dialer.app_users au ON au.app_user_id = asl.app_user_id
      WHERE asl.status = 'READY' AND asl.ended_at IS NULL
      ORDER BY asl.status_log_id ASC
    `
  );

  for (const row of rows) {
    const { app_user_id: appUserId, vicidial_user: agentUser } = row;
    if (!agentUser) continue;
    if (excludeSet.has(appUserId)) continue;

    if (!ws.isConnected(appUserId)) {
      // Stale/disconnected READY row — not a real candidate. Leaving
      // the DB row alone here deliberately: closing it automatically
      // is a separate decision (would need to distinguish "gone for
      // good" from "brief network blip / page reload"), out of scope
      // for this fix. This just stops it from being treated as an
      // eligible agent for routing purposes.
      continue;
    }

    const [extRows] = await db.execute(
      `
        SELECT p.extension
        FROM vicidial_users vu
        LEFT JOIN phones p ON p.login = vu.phone_login
        WHERE vu.user = ? AND vu.active = 'Y'
      `,
      [agentUser]
    );

    if (!extRows.length || !extRows[0].extension) continue;

    return { appUserId, agentUser, extension: extRows[0].extension };
  }

  return null;
}

/*
==================================================
CALL_TIED_STATUSES / isCallTied()
==================================================
Single source of truth for "is this agent mid-call right now" — used
by ws.js (lazy-required there to avoid a circular top-level require,
since this file already requires ws.js) to decide whether a dropped
socket should touch the agent's status at all. If they're IN_CALL,
AFTER_CALL_WORK, or ON_HOLD, ws.js leaves the status completely alone
on disconnect — the call's own hangup/hold handling in
dialerService.js/inboundCallService.js is what should end that period,
not a dropped socket. This is the explicit exception: every OTHER
status gets closed immediately on disconnect and restored on
reconnect (see ws.js's pendingRestoreBySid).

KNOWN GAP, named rather than solved here: if an agent's app truly never
comes back while mid-call (not just a blip), status just sits at
whatever call-tied state it's in — there's no later re-check once the
call itself ends via AMI hangup detection. Same class of "agent
vanished with an open AFTER_CALL_WORK nobody ever dispositions" gap
that already exists independent of this fix.
==================================================
*/
const CALL_TIED_STATUSES = new Set(["IN_CALL", "AFTER_CALL_WORK", "ON_HOLD"]);

async function isCallTied(appUserId) {
  const current = await getCurrentStatus(appUserId);
  return !!(current && CALL_TIED_STATUSES.has(current.status));
}

module.exports = {
  isManualStatus,
  getCurrentStatus,
  setStatus,
  closeCurrentStatus,
  getAnyReadyAgentWithExtension,
  isCallTied,
  statusEvents,
  PRODUCTIVE_STATUSES,
  OCCUPANCY_STATUSES,
};