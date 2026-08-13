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
const MANUAL_STATUSES = new Set(["NOT_READY", "READY", "ON_HOLD", "AUX_CB"]);
const ALL_STATUSES = new Set(["NOT_READY", "READY", "ON_HOLD", "AUX_CB", "IN_CALL", "AFTER_CALL_WORK"]);

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
async function setStatus(appUserId, status, options = {}) {
  if (!ALL_STATUSES.has(status)) {
    throw new Error(`Unknown agent status: ${status}`);
  }

  const { relatedCallDirection = null, relatedCampaignId = null } = options;

  await db.execute(
    `
      UPDATE cmx_dialer.agent_status_log
      SET ended_at = NOW(), duration_seconds = TIMESTAMPDIFF(SECOND, started_at, NOW())
      WHERE app_user_id = ? AND ended_at IS NULL
    `,
    [appUserId]
  );

  await db.execute(
    `INSERT INTO cmx_dialer.agent_status_log (app_user_id, status, related_call_direction, related_campaign_id, started_at) VALUES (?, ?, ?, ?, NOW())`,
    [appUserId, status, relatedCallDirection, relatedCampaignId]
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
is waiting. Picks the first READY agent found (no ranking/priority
logic — v1, single-agent test scope; worth revisiting before this
matters with multiple concurrent agents). Resolves their PJSIP
extension the same way authRoutes.js does at login.
==================================================
*/
async function getAnyReadyAgentWithExtension() {
  const [rows] = await db.execute(
    `
      SELECT asl.app_user_id, au.vicidial_user
      FROM cmx_dialer.agent_status_log asl
      JOIN cmx_dialer.app_users au ON au.app_user_id = asl.app_user_id
      WHERE asl.status = 'READY' AND asl.ended_at IS NULL
      LIMIT 1
    `
  );

  if (!rows.length || !rows[0].vicidial_user) return null;

  const { app_user_id: appUserId, vicidial_user: agentUser } = rows[0];

  const [extRows] = await db.execute(
    `
      SELECT p.extension
      FROM vicidial_users vu
      LEFT JOIN phones p ON p.login = vu.phone_login
      WHERE vu.user = ? AND vu.active = 'Y'
    `,
    [agentUser]
  );

  if (!extRows.length || !extRows[0].extension) return null;

  return { appUserId, agentUser, extension: extRows[0].extension };
}

module.exports = {
  isManualStatus,
  getCurrentStatus,
  setStatus,
  getAnyReadyAgentWithExtension,
  statusEvents,
};