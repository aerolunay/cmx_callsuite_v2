"use strict";

const express = require("express");
const db = require("../config/db");
const inboundCallService = require("../services/inboundCallService");
const statsService = require("../services/statsService");
const { transporter } = require("../config/mailer");
const { buildWelcomeEmail } = require("../services/emailTemplates");

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  if (req.session.agent.accessLevel !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  return next();
}

/*
==================================================
AVAILABLE VICIDIAL USERS
==================================================
GET /api/admin/vicidial-users/available
Unclaimed (no matching cmx_dialer.app_users row yet), active ViciDial
users — the same query we ran by hand in Workbench, now a real
endpoint.
==================================================
*/
router.get("/vicidial-users/available", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT vu.user AS vicidial_user, vu.full_name, vu.phone_login
        FROM asterisk.vicidial_users vu
        LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = vu.user
        WHERE au.app_user_id IS NULL
          AND vu.active = 'Y'
        ORDER BY vu.user
      `
    );
    return res.json({ success: true, vicidialUsers: rows });
  } catch (error) {
    console.error("GET /api/admin/vicidial-users/available failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load available ViciDial users." });
  }
});

/*
==================================================
EXISTING APP USERS
==================================================
GET /api/admin/users
Lists every cmx_dialer.app_users row with their bound ViciDial
user/phone and assigned campaigns, for visibility before creating a
new one (and to avoid double-registering someone).
==================================================
*/
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT
          au.app_user_id,
          au.email,
          au.full_name,
          au.access_level,
          au.vicidial_user,
          au.active,
          vu.phone_login,
          GROUP_CONCAT(aca.campaign_id ORDER BY aca.campaign_id SEPARATOR ', ') AS campaigns
        FROM cmx_dialer.app_users au
        LEFT JOIN asterisk.vicidial_users vu ON vu.user = au.vicidial_user
        LEFT JOIN cmx_dialer.agent_campaign_assignments aca
          ON aca.app_user_id = au.app_user_id AND aca.active = 1
        GROUP BY au.app_user_id
        ORDER BY au.app_user_id DESC
      `
    );
    return res.json({ success: true, users: rows });
  } catch (error) {
    console.error("GET /api/admin/users failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load users." });
  }
});

/*
==================================================
CREATE USER
==================================================
POST /api/admin/users
Body: { email, fullName, accessLevel, vicidialUser, campaignIds: [] }

Creates the app_users row AND its campaign assignments in one
transaction — either both succeed or neither does, so a user is never
left half-bound to a ViciDial login with no campaign access (or vice
versa).
==================================================
*/
router.post("/users", requireAdmin, async (req, res) => {
  const { email, fullName, accessLevel, vicidialUser, campaignIds, active } = req.body;

  if (!email || !fullName || !accessLevel) {
    return res.status(400).json({ success: false, message: "email, fullName, and accessLevel are required." });
  }

  if (!["agent", "supervisor", "admin"].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: "accessLevel must be agent, supervisor, or admin." });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `INSERT INTO cmx_dialer.app_users (email, full_name, access_level, vicidial_user, active)
       VALUES (?, ?, ?, ?, ?)`,
      [email, fullName, accessLevel, vicidialUser || null, active === false ? 0 : 1]
    );

    const appUserId = result.insertId;

    if (Array.isArray(campaignIds) && campaignIds.length > 0) {
      for (const campaignId of campaignIds) {
        await connection.execute(
          `INSERT INTO cmx_dialer.agent_campaign_assignments (app_user_id, campaign_id) VALUES (?, ?)`,
          [appUserId, campaignId]
        );
      }
    }

    await connection.commit();

    // Sent AFTER commit, deliberately outside the transaction and not
    // awaited into the response's success/failure — a bounced or
    // slow-to-send welcome email should never make account creation
    // itself look like it failed. Logged, not surfaced to the admin
    // who just clicked "Create".
    transporter
      .sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        ...buildWelcomeEmail({ fullName, email, accessLevel }),
      })
      .catch((err) => {
        console.error(`[adminRoutes] Failed to send welcome email to ${email}:`, err.message);
      });

    return res.json({ success: true, appUserId });
  } catch (error) {
    await connection.rollback();
    console.error("POST /api/admin/users failed:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "That email is already registered." });
    }

    return res.status(500).json({ success: false, message: "Failed to create user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
LIVE AGENT STATUS
==================================================
GET /api/admin/live-status?campaignId=optional

Returns every active agent's CURRENT status and how long they've been
in it. "LOGGED_OUT" isn't a real status_log value — it's derived as
"this agent has no open status row at all", using the most recent
CLOSED row's ended_at as their logout time (requires logout to
actually close the row — see authRoutes.js's fix).

Campaign filtering is done via agent_campaign_assignments (who's
ASSIGNED to a campaign), not via agent_status_log's
related_campaign_id (which is only ever set for IN_CALL/
AFTER_CALL_WORK/ON_HOLD — NOT_READY/READY/AUX_CB have no call to tag
at all, so filtering by that column would hide those agents entirely
under any specific campaign filter). "All Campaigns" (no campaignId)
shows every active agent regardless of assignment.
==================================================
*/
router.get("/live-status", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.query;

    // REAL BUG FIXED HERE: this used to return raw started_at/
    // last_ended_at timestamps and let the frontend diff them against
    // Date.now() in the browser — the EXACT same class of bug already
    // found and fixed once for DialerPage's own elapsed-time counter
    // (see agentStatusService.js/DialerPage.jsx comments on that), just
    // never applied here when this second dashboard was built
    // separately. Symptom was identical: a bogus multi-hour reading
    // from a timezone mismatch between the MySQL server and the app.
    // Fix is the same one already established elsewhere in this
    // codebase: let MySQL compute elapsed seconds itself via
    // TIMESTAMPDIFF, never comparing clocks across the two machines.
    const [rows] = await db.execute(
      `
        SELECT
          au.app_user_id,
          au.full_name,
          au.email,
          au.vicidial_user,
          au.last_login_at,
          open_row.status AS open_status,
          open_row.elapsed_seconds AS open_elapsed_seconds,
          open_row.related_call_id AS open_related_call_id,
          open_row.related_campaign_id AS open_related_campaign_id,
          last_closed.logged_out_elapsed_seconds,
          (
            SELECT aca.campaign_id FROM cmx_dialer.agent_campaign_assignments aca
            WHERE aca.app_user_id = au.app_user_id AND aca.active = 1
            ORDER BY aca.campaign_id LIMIT 1
          ) AS assigned_campaign_id
        FROM cmx_dialer.app_users au
        LEFT JOIN (
          SELECT app_user_id, status, related_call_id, related_campaign_id, TIMESTAMPDIFF(SECOND, started_at, NOW()) AS elapsed_seconds
          FROM cmx_dialer.agent_status_log
          WHERE ended_at IS NULL
        ) open_row ON open_row.app_user_id = au.app_user_id
        LEFT JOIN (
          SELECT app_user_id, TIMESTAMPDIFF(SECOND, MAX(ended_at), NOW()) AS logged_out_elapsed_seconds
          FROM cmx_dialer.agent_status_log
          WHERE ended_at IS NOT NULL
          GROUP BY app_user_id
        ) last_closed ON last_closed.app_user_id = au.app_user_id
        WHERE au.active = 1
          AND au.access_level != 'admin'
          AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM cmx_dialer.agent_campaign_assignments aca
              WHERE aca.app_user_id = au.app_user_id
                AND aca.campaign_id = ?
                AND aca.active = 1
            )
          )
      `,
      [campaignId || null, campaignId || null]
    );

    /*
    ==================================================
    TOTAL CALL HANDLING TIME (real bug fixed here)
    ==================================================
    Previously, an agent's "On a Call" duration reset to 0 the moment
    they put the customer on hold — because holding/unholding closes
    the IN_CALL row and opens a fresh ON_HOLD (then a fresh IN_CALL)
    row, each with its own started_at. open_elapsed_seconds above only
    ever reflects time since the CURRENT segment started, not the
    whole call.

    Fix: related_call_id (new column — see add_related_call_id.sql)
    tags every IN_CALL/ON_HOLD/AFTER_CALL_WORK row with which call it
    belongs to, REGARDLESS of how many hold/unhold segments that call
    has been split into. For any agent currently IN_CALL or ON_HOLD,
    sum every segment (closed ones via their stored duration_seconds,
    the current open one via TIMESTAMPDIFF) that shares that call_id —
    giving the TRUE total handling time for that specific call, not
    just the current segment.
    ==================================================
    */
    const callIdsNeedingTotal = rows
      .filter((r) => (r.open_status === "IN_CALL" || r.open_status === "ON_HOLD") && r.open_related_call_id)
      .map((r) => r.open_related_call_id);

    const totalsByCallId = new Map();
    if (callIdsNeedingTotal.length > 0) {
      const [totalRows] = await db.execute(
        `
          SELECT
            related_call_id,
            SUM(
              CASE
                WHEN ended_at IS NOT NULL THEN duration_seconds
                ELSE TIMESTAMPDIFF(SECOND, started_at, NOW())
              END
            ) AS total_seconds
          FROM cmx_dialer.agent_status_log
          WHERE related_call_id IN (?)
          GROUP BY related_call_id
        `,
        [callIdsNeedingTotal]
      );
      for (const t of totalRows) {
        totalsByCallId.set(t.related_call_id, t.total_seconds);
      }
    }

    const agents = rows.map((r) => {
      // Displayed Campaign: for a call-tied status, the campaign that
      // SPECIFIC call belongs to (open_related_campaign_id) — an agent
      // assigned to multiple campaigns could be on a call for any of
      // them, so the call's own campaign is more accurate than their
      // general assignment. For every other status, there's no call to
      // derive it from, so fall back to their (first) campaign
      // assignment instead.
      const displayCampaignId = r.open_related_campaign_id || r.assigned_campaign_id || null;

      if (r.open_status) {
        const isCallTied = r.open_status === "IN_CALL" || r.open_status === "ON_HOLD";
        const totalHandlingSeconds = isCallTied ? totalsByCallId.get(r.open_related_call_id) : undefined;

        return {
          appUserId: r.app_user_id,
          fullName: r.full_name,
          email: r.email,
          vicidialUser: r.vicidial_user,
          campaignId: displayCampaignId,
          status: r.open_status,
          // Falls back to the single-segment value whenever there's no
          // related_call_id to aggregate by (pre-migration rows, or a
          // status genuinely unrelated to any call) — never silently
          // shows nothing.
          elapsedSeconds: totalHandlingSeconds !== undefined ? totalHandlingSeconds : r.open_elapsed_seconds,
          lastLoginAt: r.last_login_at,
        };
      }
      return {
        appUserId: r.app_user_id,
        fullName: r.full_name,
        email: r.email,
        vicidialUser: r.vicidial_user,
        campaignId: displayCampaignId,
        status: "LOGGED_OUT",
        elapsedSeconds: r.logged_out_elapsed_seconds, // null if they've never logged any status at all
        lastLoginAt: r.last_login_at, // null if this account has never logged in at all (pre-migration)
      };
    });

    return res.json({ success: true, agents });
  } catch (error) {
    console.error("GET /api/admin/live-status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load live status." });
  }
});

/*
==================================================
UPDATE USER
==================================================
PUT /api/admin/users/:appUserId
Body: { email, fullName, accessLevel, vicidialUser (nullable), campaignIds: [] }

Changing vicidialUser to a different value, or to null, immediately
releases whatever it was bound to before — the "available ViciDial
users" query above is computed dynamically (no matching app_users
row), so there's nothing extra to clean up on release; the old
binding just stops being referenced.

Campaign assignments are replaced wholesale (delete all, re-insert the
new set) rather than diffed — simpler and correct for this size of
list.
==================================================
*/
router.put("/users/:appUserId", requireAdmin, async (req, res) => {
  const { appUserId } = req.params;
  const { email, fullName, accessLevel, vicidialUser, campaignIds, active } = req.body;

  if (!email || !fullName || !accessLevel) {
    return res.status(400).json({ success: false, message: "email, fullName, and accessLevel are required." });
  }

  if (!["agent", "supervisor", "admin"].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: "accessLevel must be agent, supervisor, or admin." });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `UPDATE cmx_dialer.app_users
       SET email = ?, full_name = ?, access_level = ?, vicidial_user = ?, active = ?
       WHERE app_user_id = ?`,
      [email, fullName, accessLevel, vicidialUser || null, active ? 1 : 0, appUserId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "User not found." });
    }

    await connection.execute(
      `DELETE FROM cmx_dialer.agent_campaign_assignments WHERE app_user_id = ?`,
      [appUserId]
    );

    if (Array.isArray(campaignIds) && campaignIds.length > 0) {
      for (const campaignId of campaignIds) {
        await connection.execute(
          `INSERT INTO cmx_dialer.agent_campaign_assignments (app_user_id, campaign_id) VALUES (?, ?)`,
          [appUserId, campaignId]
        );
      }
    }

    await connection.commit();
    return res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error("PUT /api/admin/users/:appUserId failed:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "That email is already registered." });
    }

    return res.status(500).json({ success: false, message: "Failed to update user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
DELETE USER
==================================================
DELETE /api/admin/users/:appUserId

A real, permanent deletion — not a deactivate flag. Removes the
campaign assignments first (the FK would otherwise block deleting the
user row), then the user itself. Their vicidial_user binding, if any,
becomes immediately available for a new/different app user, since the
"available" query only ever checks whether a referencing row exists
at all.
==================================================
*/
router.delete("/users/:appUserId", requireAdmin, async (req, res) => {
  const { appUserId } = req.params;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(
      `DELETE FROM cmx_dialer.agent_campaign_assignments WHERE app_user_id = ?`,
      [appUserId]
    );

    const [result] = await connection.execute(
      `DELETE FROM cmx_dialer.app_users WHERE app_user_id = ?`,
      [appUserId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "User not found." });
    }

    await connection.commit();
    return res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error("DELETE /api/admin/users/:appUserId failed:", error);
    return res.status(500).json({ success: false, message: "Failed to delete user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
QUEUE STATUS
==================================================
GET /api/admin/queue-status?campaignId=optional

Real aggregation across every currently-tracked inbound call, grouped
by campaign (via inboundCallService's DID_TO_CAMPAIGN mapping) —
replaces the old hardcoded 0-or-1 guess from when only one fixed room
existed system-wide.

campaignId filtering added here (not inside getQueueStatus() itself)
— the service function stays a simple "give me everything, grouped"
primitive; this route decides whether to narrow that down, matching
how the Live Status Dashboard's agent-table filtering already works
via the campaignId query param above.
==================================================
*/
router.get("/queue-status", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.query;
    let queues = inboundCallService.getQueueStatus();

    if (campaignId) {
      queues = queues.filter((q) => q.campaignId === campaignId);
    }

    return res.json({ success: true, queues });
  } catch (error) {
    console.error("GET /api/admin/queue-status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load queue status." });
  }
});

/*
==================================================
ABANDONED CALLS
==================================================
GET /api/admin/abandoned-calls?campaignId=optional

"Today" boundary reuses the SAME self-calibrating Eastern-day logic
Today's Stats already uses (see statsService.js) — not a separate,
possibly-inconsistent definition of "today". Respects the campaign
filter the same way queue-status does.
==================================================
*/
router.get("/abandoned-calls", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.query;
    const calls = await inboundCallService.getAbandonedCallsToday(campaignId || null);
    return res.json({ success: true, calls });
  } catch (error) {
    console.error("GET /api/admin/abandoned-calls failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load abandoned calls." });
  }
});

/*
==================================================
TOTAL CALLS (Live Status Dashboard's "Total Calls" widget)
==================================================
GET /api/admin/total-calls?campaignId=optional

Every call today, outbound and inbound combined (dialer_call_log +
inbound_call_log, matching how the DialerPage's own Call Logs table
already unions the two). "Today" reuses the SAME Eastern-day-boundary
helper Today's Stats and Abandoned Calls already use — one definition
of "today" everywhere in this app, not several.

Handle Time aggregates via related_call_id — the SAME technique
already used for the live per-status Duration column above, just as a
plain historical SUM here (every segment for a completed call is
already closed, so no TIMESTAMPDIFF-on-the-open-row branch is needed
the way the live version needs one). Deliberately sums ALL segments
tied to a call — IN_CALL + ON_HOLD + AFTER_CALL_WORK — not just talk
time, matching how "Handle Time" is normally defined in call center
reporting (talk + hold + wrap-up).
==================================================
*/
router.get("/total-calls", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.query;
    const { start, end } = await statsService.getEasternDayBoundsForServerClock();

    const params = [start, end];
    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = "AND combined.campaign_id = ?";
      params.push(campaignId);
    }

    const [rows] = await db.execute(
      `
        SELECT
          combined.campaign_id,
          combined.phone_number,
          combined.call_started_at,
          agg.handle_time_seconds
        FROM (
          SELECT campaign_id, phone_number, call_id, call_started_at
          FROM cmx_dialer.dialer_call_log
          UNION ALL
          SELECT campaign_id, caller_id_number AS phone_number, call_id, call_started_at
          FROM cmx_dialer.inbound_call_log
        ) combined
        LEFT JOIN (
          SELECT related_call_id, SUM(duration_seconds) AS handle_time_seconds
          FROM cmx_dialer.agent_status_log
          WHERE related_call_id IS NOT NULL AND ended_at IS NOT NULL
          GROUP BY related_call_id
        ) agg ON agg.related_call_id = combined.call_id
        WHERE combined.call_started_at >= ? AND combined.call_started_at <= ?
        ${campaignFilter}
        ORDER BY combined.call_started_at DESC
        LIMIT 200
      `,
      params
    );

    const calls = rows.map((r) => ({
      campaignId: r.campaign_id,
      phoneNumber: r.phone_number,
      callStartedAt: r.call_started_at,
      handleTimeSeconds: r.handle_time_seconds, // null if no agent_status_log segments were ever tagged with this call_id (pre-migration calls)
    }));

    return res.json({ success: true, calls });
  } catch (error) {
    console.error("GET /api/admin/total-calls failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load total calls." });
  }
});

/*
==================================================
AGGREGATE STATS (everyone, optionally filtered by campaign)
==================================================
GET /api/admin/stats/today?campaignId=optional
==================================================
*/
router.get("/stats/today", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.query;
    const stats = await statsService.getTodayStatsAggregate(campaignId || null);
    return res.json({ success: true, stats });
  } catch (error) {
    console.error("GET /api/admin/stats/today failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load aggregate stats." });
  }
});

module.exports = router;