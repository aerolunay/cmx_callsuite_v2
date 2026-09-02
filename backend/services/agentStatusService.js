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
NOT_READY, READY, ON_HOLD, LUNCH_BREAK, BIO_BREAK, ADMIN, MEETING, and
TRAINING are agent-selectable. IN_CALL and AFTER_CALL_WORK are
system-controlled and should never be settable directly through the
manual-switch endpoint — they're driven entirely by real call events
(see dialerService.js).

  NOT_READY        — agent-selectable. Logged in, not taking calls.
  READY             — agent-selectable. Available for next call. Also
                       now the ONLY status Callback can be placed from
                       (AUX_CB removed — JsSIP's own call-gating on the
                       agent's registered extension covers what AUX_CB
                       used to protect against).
  ON_HOLD           — agent-selectable. Agent-level break/hold state
                       (distinct from putting a customer on hold mid-call
                       — no such customer-hold feature exists yet).
  LUNCH_BREAK        — agent-selectable. Not productive, not occupancy —
                       same treatment as NOT_READY.
  BIO_BREAK          — agent-selectable. Same as LUNCH_BREAK.
  ADMIN              — agent-selectable. Productive (real work), but
                       NOT occupancy — same treatment as AD_HOC.
  MEETING            — agent-selectable. Same as ADMIN.
  TRAINING           — agent-selectable. Same as ADMIN.
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
const MANUAL_STATUSES = new Set([
  "NOT_READY",
  "READY",
  "ON_HOLD",
  "AD_HOC",
  "LUNCH_BREAK",
  "BIO_BREAK",
  "ADMIN",
  "MEETING",
  "TRAINING",
]);
const ALL_STATUSES = new Set([
  "NOT_READY",
  "READY",
  "ON_HOLD",
  "AD_HOC",
  "LUNCH_BREAK",
  "BIO_BREAK",
  "ADMIN",
  "MEETING",
  "TRAINING",
  "IN_CALL",
  "AFTER_CALL_WORK",
  "MICROSIP_OUTBOUND",
]);

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
and the three new non-call work statuses (ADMIN, MEETING, TRAINING) —
real work, just not call-related. LUNCH_BREAK/BIO_BREAK deliberately
excluded — personal time, not work time.

OCCUPANCY_STATUSES: counts as "available for calls" time. Deliberately
EXCLUDES AD_HOC/ADMIN/MEETING/TRAINING/LUNCH_BREAK/BIO_BREAK — none of
these agents can receive a call, so counting that time as "available"
would be wrong even for the ones that ARE productive.
==================================================
*/
const PRODUCTIVE_STATUSES = new Set(["READY", "AD_HOC", "IN_CALL", "AFTER_CALL_WORK", "ON_HOLD", "ADMIN", "MEETING", "TRAINING"]);
const OCCUPANCY_STATUSES = new Set(["READY", "IN_CALL", "AFTER_CALL_WORK", "ON_HOLD"]);

function isManualStatus(status) {
  return MANUAL_STATUSES.has(status);
}

async function getCurrentStatus(appUserId) {
  const [rows] = await db.execute(
    `
      SELECT status, started_at, related_campaign_id, TIMESTAMPDIFF(SECOND, started_at, NOW()) AS elapsed_seconds
      FROM cmx_dialer.agent_status_log
      WHERE app_user_id = ? AND ended_at IS NULL
      ORDER BY status_log_id DESC
      LIMIT 1
    `,
    [appUserId]
  );

  if (!rows.length) return null;

  return { status: rows[0].status, elapsedSeconds: rows[0].elapsed_seconds, relatedCampaignId: rows[0].related_campaign_id };
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

  // REAL BUG FIX, confirmed live via a real foreign-key violation
  // (an agent's app_users row was deleted while their session was
  // still active — the insert below failed every time afterward,
  // even though the earlier UPDATE had already committed and closed
  // their previous status row). These two statements used to run as
  // separate, independently-committed calls — if the insert failed
  // for ANY reason, the close was already permanent, leaving the
  // agent with literally zero status rows and invisible to every
  // query that depends on one existing (Live Dashboard,
  // getAnyReadyAgentWithExtension, etc.). Now atomic: either both
  // succeed, or neither does — a failed insert correctly rolls back
  // the close too, leaving their last known status intact instead of
  // nothing at all.
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(
      `
        UPDATE cmx_dialer.agent_status_log
        SET ended_at = NOW(), duration_seconds = TIMESTAMPDIFF(SECOND, started_at, NOW())
        WHERE app_user_id = ? AND ended_at IS NULL
      `,
      [appUserId]
    );

    await connection.execute(
      `INSERT INTO cmx_dialer.agent_status_log (app_user_id, status, related_call_direction, related_campaign_id, related_call_id, started_at) VALUES (?, ?, ?, ?, ?, NOW())`,
      [appUserId, status, relatedCallDirection, relatedCampaignId, relatedCallId]
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

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
getAnyReadyAgentWithExtension — now PRIORITY-AWARE
==================================================
Used by inboundCallService.js to find someone to ring when a customer
is waiting. Resolves candidates' PJSIP extension the same way
authRoutes.js does at login.

Scoped to cmx_dialer.agent_campaign_assignments for the call's own
campaign (see the campaign-scoping fix above this in git history —
this function used to have no campaign filter at all).

REAL BUG FIX, confirmed via real multi-campaign-assignment testing: an
earlier fix (see dialerRoutes.js's POST /dialer/status — "Live
Dashboard's fallback logic... guessed by picking whichever assigned
campaign sorted first alphabetically") added
`related_campaign_id = ?` to this query's own WHERE clause, for a
completely different reason: making the Live Dashboard show the right
campaign NAME for an agent assigned to more than one. That field only
ever reflects whichever ONE campaign was selected in the agent's UI
the moment they last changed status — it was never meant to gate
actual call-routing eligibility. But bolted onto THIS query, it did
exactly that: an agent assigned to Campaigns A and B, currently READY
with related_campaign_id = A (just because A was selected in their
dropdown when they clicked Ready), would never be matched to an
incoming call for Campaign B — even though agent_campaign_assignments
(joined right above) correctly says they're eligible for it. Confirmed
live: a multi-campaign agent stopped receiving calls for whichever
campaign wasn't their currently-selected one. Removed — the
agent_campaign_assignments join alone is the correct, complete source
of truth for "is this agent assigned to this campaign"; 
related_campaign_id remains purely a display field for the dashboard,
untouched everywhere else it's used.

Requires ws.isConnected(appUserId) — an actual live socket — as well
as the DB status, since a READY row alone isn't proof anyone is
actually present in the app (browser close/crash/sleep leaves rows
open indefinitely; see the comment on this originally).

PRIORITY LOGIC (updated per explicit request): priority 1 (default) is
strict FIFO — always selected immediately when it's their turn.
Priority 2 is skipped up to 5 times in a row when it would otherwise
be their turn. Priority 3 is skipped UNCONDITIONALLY — Infinity as its
threshold means the "skipCount < threshold" check below is always
true, so a priority 3 agent is never selected through the normal loop
at all, no matter how many times they're skipped. In both cases, ONLY
when a lower-skip-tier candidate is actually available to take the
call instead. If a priority 2/3 agent is the ONLY eligible candidate
at all, or every eligible candidate is currently under its own skip
threshold (which, for priority 3, is permanently true — this is what
makes "unless no one else is available" the ONLY way they're ever
selected), the "unless no other agents are available" carve-out always
wins — someone gets selected rather than letting the call wait
indefinitely for a priority tier that never comes due.

Priority 4 (per explicit request) is a HARD exclusion, categorically
different from 1/2/3 above: it opts an agent OUT of inbound call
routing entirely, with no "unless no one else is available" carve-out
at all. Priority 3 agents can still be selected as a last resort if
they're genuinely the only one around — priority 4 agents never are,
even if they're the sole READY agent for the campaign. Enforced by
filtering priority-4 rows out of the eligible pool itself (below),
before the "only one real candidate" fallback even gets a chance to
see them — so they're invisible to this whole matching function, not
just heavily deprioritized within it.

priority_skip_count lives on cmx_dialer.app_users (not
agent_status_log) — it's a running counter tied to the agent, meant to
persist across status changes within a shift, not reset every time
they cycle READY/NOT_READY. Incremented here for each real skip
(happens once per genuinely-waiting call this function is asked to
match, not a background poll), reset to 0 the moment that agent is
actually selected for a call OR their priority is changed via
setPriority() below.

excludeAppUserIds — lets a caller (inboundCallService.js's multi-call
FIFO matcher) rule out agents already claimed by A DIFFERENT waiting
call in the same matching pass, so two simultaneously-waiting callers
can never be matched to the same agent before either Originate
finishes.
==================================================
*/
const SKIP_THRESHOLDS = { 1: 0, 2: 5, 3: Infinity };

async function incrementSkipCount(appUserId) {
  await db.execute(
    `UPDATE cmx_dialer.app_users SET priority_skip_count = priority_skip_count + 1 WHERE app_user_id = ?`,
    [appUserId]
  );
}

async function resetSkipCount(appUserId) {
  await db.execute(`UPDATE cmx_dialer.app_users SET priority_skip_count = 0 WHERE app_user_id = ?`, [appUserId]);
}

async function getAnyReadyAgentWithExtension(campaignId, excludeAppUserIds = []) {
  const excludeSet = new Set(excludeAppUserIds);

  // UPDATED — multi-campaign agent selection, per explicit request.
  // Eligibility now requires BOTH a real permanent assignment
  // (agent_campaign_assignments — unchanged, the original safety net)
  // AND this campaign being one the agent has actively SELECTED to
  // work right now (agent_working_campaigns — new table; see
  // dialerRoutes.js's POST /dialer/working-campaigns for how it gets
  // populated, including the server-side rule that an OUTBOUND
  // selection is always exclusive). An agent permanently assigned to
  // 3 blended campaigns but only currently WORKING 2 of them should
  // not receive calls routed from the third until they actively
  // select it — this join is what enforces that.
  //
  // SAFE ROLLOUT FALLBACK, deliberate: an agent with ZERO rows in
  // agent_working_campaigns at all (never been through the new
  // campaign-selection flow — true for every agent the moment this
  // deploys, until they next select a campaign) falls back to the
  // OLD behavior (eligible for every campaign they're assigned to).
  // Without this, deploying this change would have instantly stopped
  // EVERY ready agent from receiving ANY call at all, rather than
  // degrading gracefully until each agent naturally re-selects.
  const [rows] = await db.execute(
    `
      SELECT asl.app_user_id, au.vicidial_user, au.priority, au.priority_skip_count
      FROM cmx_dialer.agent_status_log asl
      JOIN cmx_dialer.app_users au ON au.app_user_id = asl.app_user_id
      JOIN cmx_dialer.agent_campaign_assignments aca
        ON aca.app_user_id = asl.app_user_id AND aca.active = 1 AND aca.campaign_id = ?
      WHERE asl.status = 'READY' AND asl.ended_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM cmx_dialer.agent_working_campaigns awc
            WHERE awc.app_user_id = asl.app_user_id AND awc.campaign_id = ?
          )
          OR NOT EXISTS (
            SELECT 1 FROM cmx_dialer.agent_working_campaigns awc2
            WHERE awc2.app_user_id = asl.app_user_id
          )
        )
      ORDER BY asl.status_log_id ASC
    `,
    [campaignId, campaignId]
  );

  // Build the full FIFO-ordered pool of genuinely eligible candidates
  // (connected + has a real extension) BEFORE applying any priority
  // logic — priority selection needs to see the whole eligible pool
  // at once to know whether "no other agents are available" actually
  // applies, not just stop at the first candidate the way a plain
  // FIFO pick would.
  const eligible = [];
  for (const row of rows) {
    const { app_user_id: appUserId, vicidial_user: agentUser, priority, priority_skip_count: skipCount } = row;
    if (!agentUser) continue;
    if (excludeSet.has(appUserId)) continue;
    if (!ws.isConnected(appUserId)) continue;
    // Priority 4 — hard exclusion, see this function's own comment
    // above. Filtered out here, before eligible.length is even
    // computed, so a lone priority-4 agent can never trigger the
    // "only one real candidate" fallback either.
    if (priority === 4) continue;

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

    eligible.push({ appUserId, agentUser, extension: extRows[0].extension, priority, skipCount });
  }

  if (eligible.length === 0) return null;

  // Only one real candidate — the "unless no other agents are
  // available" carve-out always wins regardless of priority/skip
  // state. Select outright and reset their skip counter.
  if (eligible.length === 1) {
    const only = eligible[0];
    await resetSkipCount(only.appUserId);
    return { appUserId: only.appUserId, agentUser: only.agentUser, extension: only.extension };
  }

  for (const candidate of eligible) {
    const threshold = SKIP_THRESHOLDS[candidate.priority] ?? 0;

    if (candidate.skipCount < threshold) {
      // Skip this candidate for now — someone else (further down the
      // FIFO order, or a lower skip-tier) gets this call instead. Bump
      // their counter so they're one step closer to their next
      // guaranteed turn — except for priority 3 (threshold Infinity),
      // where that count can never matter to any future decision at
      // all, so incrementing it forever would just be a wasted write
      // on every single call this function is ever asked to match.
      if (Number.isFinite(threshold)) {
        await incrementSkipCount(candidate.appUserId);
      }
      continue;
    }

    // Either priority 1 (threshold 0, always eligible immediately) or
    // a priority 2/3 agent who has already been skipped enough times —
    // select them now and reset their counter.
    await resetSkipCount(candidate.appUserId);
    return { appUserId: candidate.appUserId, agentUser: candidate.agentUser, extension: candidate.extension };
  }

  // Everyone eligible was priority 2/3 and still under their own skip
  // threshold — "no other agents are available" applies to the whole
  // pool at this point, so pick the oldest-ready candidate outright
  // rather than let the call wait indefinitely for a priority tier
  // that never comes due.
  const fallback = eligible[0];
  await resetSkipCount(fallback.appUserId);
  return { appUserId: fallback.appUserId, agentUser: fallback.agentUser, extension: fallback.extension };
}

/*
==================================================
setPriority — admin/WFM control, also used at user create/update
==================================================
Always resets priority_skip_count to 0 alongside the change — a fresh
priority tier should start its own skip cycle clean, not inherit
however many skips accumulated under whatever priority the agent had
before.
==================================================
*/
async function setPriority(appUserId, priority) {
  const numericPriority = Number(priority);
  if (![1, 2, 3, 4].includes(numericPriority)) {
    throw new Error("priority must be 1, 2, 3, or 4.");
  }
  await db.execute(
    `UPDATE cmx_dialer.app_users SET priority = ?, priority_skip_count = 0 WHERE app_user_id = ?`,
    [numericPriority, appUserId]
  );
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
const CALL_TIED_STATUSES = new Set(["IN_CALL", "AFTER_CALL_WORK", "ON_HOLD", "MICROSIP_OUTBOUND"]);
// MICROSIP_OUTBOUND included here for the same reason as the other
// three: microsipOutboundService.js's own Hangup listener is what
// should end this period (restoring the agent's prior status), NOT a
// dropped socket in the meantime.

async function isCallTied(appUserId) {
  const current = await getCurrentStatus(appUserId);
  return !!(current && CALL_TIED_STATUSES.has(current.status));
}

/*
==================================================
12-HOUR AUTO-LOGOUT
==================================================
Any non-admin agent still logged in (has an open agent_status_log row,
any status) more than 12 hours after their last real login gets force-
logged-out automatically. Admins are exempt entirely — this is aimed
at agents who left the app open overnight/across shifts, not at
supervisors who may legitimately stay logged in longer while
monitoring.

Measured from app_users.last_login_at (set once per real login), not
from the CURRENT status row's own started_at — an agent's status can
change many times across a long shift, and each change would
reset a naive "time since status started" check, defeating the whole
point of catching someone who's simply been logged in too long overall.
==================================================
*/
const AUTO_LOGOUT_HOURS = 12;
const AUTO_LOGOUT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

async function checkAndForceLogoutExpiredSessions() {
  try {
    const [rows] = await db.execute(
      `
        SELECT au.app_user_id
        FROM cmx_dialer.app_users au
        JOIN cmx_dialer.agent_status_log asl
          ON asl.app_user_id = au.app_user_id AND asl.ended_at IS NULL
        WHERE au.access_level != 'admin'
          AND au.last_login_at IS NOT NULL
          AND au.last_login_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
      `,
      [AUTO_LOGOUT_HOURS]
    );

    for (const row of rows) {
      await ws.forceLogout(row.app_user_id, "session_timeout_12h");
    }
  } catch (err) {
    console.error("[agentStatusService] 12-hour auto-logout check failed:", err.message);
  }
}

// .unref() so this timer never keeps the Node process alive on its
// own, same reasoning as the WS ping loop's interval.
setInterval(checkAndForceLogoutExpiredSessions, AUTO_LOGOUT_CHECK_INTERVAL_MS).unref();

module.exports = {
  isManualStatus,
  getCurrentStatus,
  setStatus,
  closeCurrentStatus,
  getAnyReadyAgentWithExtension,
  setPriority,
  isCallTied,
  statusEvents,
  PRODUCTIVE_STATUSES,
  OCCUPANCY_STATUSES,
  checkAndForceLogoutExpiredSessions,
};