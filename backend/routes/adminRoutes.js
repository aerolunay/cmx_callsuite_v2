"use strict";

const express = require("express");
const db = require("../config/db");
const inboundCallService = require("../services/inboundCallService");
const statsService = require("../services/statsService");

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
          open_row.status AS open_status,
          open_row.elapsed_seconds AS open_elapsed_seconds,
          last_closed.logged_out_elapsed_seconds
        FROM cmx_dialer.app_users au
        LEFT JOIN (
          SELECT app_user_id, status, TIMESTAMPDIFF(SECOND, started_at, NOW()) AS elapsed_seconds
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

    const agents = rows.map((r) => {
      if (r.open_status) {
        return {
          appUserId: r.app_user_id,
          fullName: r.full_name,
          email: r.email,
          vicidialUser: r.vicidial_user,
          status: r.open_status,
          elapsedSeconds: r.open_elapsed_seconds,
        };
      }
      return {
        appUserId: r.app_user_id,
        fullName: r.full_name,
        email: r.email,
        vicidialUser: r.vicidial_user,
        status: "LOGGED_OUT",
        elapsedSeconds: r.logged_out_elapsed_seconds, // null if they've never logged any status at all
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
GET /api/admin/queue-status

Honest about current capability: this app supports exactly ONE
inbound room/DID system-wide today (a real, already-flagged v1
limitation), so this can only ever report 0 or 1 right now — there is
no true multi-call queue yet. Shaped as an array (one entry per
campaign) so this doesn't need reworking once each campaign gets its
own DID and a real per-campaign queue becomes meaningful.
==================================================
*/
router.get("/queue-status", requireAdmin, async (req, res) => {
  try {
    const current = inboundCallService.getInboundCallStatus();
    const queues = [];

    if (current && current.status === "waiting_for_agent") {
      queues.push({ campaignId: current.campaignId, waiting: 1 });
    }

    return res.json({ success: true, queues });
  } catch (error) {
    console.error("GET /api/admin/queue-status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load queue status." });
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