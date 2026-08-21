"use strict";

const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const db = require("../config/db");
const dialerService = require("../services/dialerService");
const inboundCallService = require("../services/inboundCallService");
const statsService = require("../services/statsService");
const ws = require("../config/ws");
const ami = require("../config/ami");
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

NOTE: requires vicidialUser to already exist (picked from the
"available" list above). For creating a BRAND NEW ViciDial user at the
same time, see POST /users/full below instead — kept as a genuinely
separate endpoint rather than modifying this one, since this flow
(binding to an EXISTING vicidial_users row) is still valid and
shouldn't be disturbed.
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
CREATE USER — combined ViciDial + app_users creation
==================================================
POST /api/admin/users/full
Body: {
  email, fullName, accessLevel, campaignIds, active,       // app_users side
  vicidialUsername, phoneLogin, phonePass, userLevel, userGroup  // vicidial_users side
}

First real step of moving ViciDial's own admin.php user-creation into
this app. Writes BOTH the new asterisk.vicidial_users row AND the
cmx_dialer.app_users row in ONE transaction — either both succeed or
neither does, same principle as the existing POST /users above, just
now covering a brand new ViciDial account too instead of requiring one
to already exist.

vicidial_users.pass/pass_hash are set to a random, unusable throwaway
value — DELIBERATE, not a placeholder to fix later. admin.php's own
web login is the thing this whole project is working toward retiring;
nobody creating a user through THIS endpoint is expected to ever log
into admin.php with it. If that assumption changes, this needs real,
correctly-hashed values instead — flagging that explicitly rather than
silently leaving it half-right.

Only a practical subset of vicidial_users' 130+ columns is set here —
everything else takes ViciDial's own table defaults, which matches
what admin.php's own "Add User" form effectively does for anything the
form itself doesn't ask about.
==================================================
*/
router.post("/users/full", requireAdmin, async (req, res) => {
  const {
    email,
    fullName,
    accessLevel,
    campaignIds,
    active,
    vicidialUsername,
    phoneLogin,
    phonePass,
    userLevel,
    userGroup,
  } = req.body;

  if (!email || !fullName || !accessLevel) {
    return res.status(400).json({ success: false, message: "email, fullName, and accessLevel are required." });
  }
  if (!["agent", "supervisor", "admin"].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: "accessLevel must be agent, supervisor, or admin." });
  }
  if (!vicidialUsername) {
    return res.status(400).json({ success: false, message: "vicidialUsername is required." });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Fixed placeholder value, per explicit request — every user
    // created through this flow gets the IDENTICAL literal string
    // "CXXXXXXXXXXC" for both pass/pass_hash, rather than a random
    // throwaway. Same underlying reasoning as before (admin.php's own
    // web login is being retired, nobody created this way is expected
    // to use it) — but worth knowing this is a real tradeoff, not a
    // pure improvement: a FIXED, identical value across every account
    // is more predictable than a random one. If admin.php's login ever
    // checks the raw pass column against user input, anyone aware of
    // this convention could attempt it against ANY account created
    // this way. Acceptable given admin.php is being phased out and
    // these accounts aren't meant to use that login path at all — just
    // flagging the tradeoff explicitly rather than changing it
    // silently.
    const throwawayPass = "CXXXXXXXXXXC";

    await connection.execute(
      `
        INSERT INTO asterisk.vicidial_users
          (user, pass, full_name, user_level, user_group, phone_login, phone_pass, email, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Y')
      `,
      [
        vicidialUsername,
        throwawayPass,
        fullName,
        userLevel || 1,
        userGroup || null,
        phoneLogin || null,
        phonePass || null,
        email,
      ]
    );

    const [result] = await connection.execute(
      `INSERT INTO cmx_dialer.app_users (email, full_name, access_level, vicidial_user, active)
       VALUES (?, ?, ?, ?, ?)`,
      [email, fullName, accessLevel, vicidialUsername, active === false ? 0 : 1]
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

    // Same reasoning as POST /users above — sent after commit, never
    // awaited into the response, a slow/bounced email should never
    // make account creation itself look like it failed.
    transporter
      .sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        ...buildWelcomeEmail({ fullName, email, accessLevel }),
      })
      .catch((err) => {
        console.error(`[adminRoutes] Failed to send welcome email to ${email}:`, err.message);
      });

    return res.json({ success: true, appUserId, vicidialUsername });
  } catch (error) {
    await connection.rollback();
    console.error("POST /api/admin/users/full failed:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ success: false, message: "That ViciDial username, phone login, or email is already taken." });
    }

    return res.status(500).json({ success: false, message: "Failed to create user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
PHONES CRUD
==================================================
Second piece of the ViciDial-admin-migration project (after Users) —
see the paused-work bookmark for the full sequence.

REAL SCHEMA FINDING, worth stating plainly: phones has NO single-column
primary key at all. Its actual uniqueness guarantee is a COMPOSITE
UNIQUE KEY on (extension, server_ip) — confirmed directly via
SHOW CREATE TABLE, not assumed. Every update/delete below is scoped to
BOTH columns together, never extension alone — keying on extension
only would be a real correctness gap in any multi-server ViciDial
setup (the same extension number can legitimately exist on different
servers), even though it happens to behave fine on this single-server
deployment right now.

server_ip is NEVER an admin-editable field — it's always this server's
own fixed public IP, read from SERVER_IP in .env (same "per-environment
value lives in .env" pattern as FRONTEND_URL/AMI_HOST/MYSQL_HOST
elsewhere in this app). protocol is hardcoded to PJSIP, not the
table's own legacy default of SIP — PJSIP is what this app's actual
trunk/dialplan setup uses throughout, confirmed across tonight's own
Asterisk config work.

Only a practical subset of the 90+ real columns is exposed here —
everything else takes the table's own defaults, same reasoning as
vicidial_users' MVP field set.
==================================================
*/
const SERVER_IP = process.env.SERVER_IP;
if (!SERVER_IP) {
  console.warn(
    "[adminRoutes] SERVER_IP is not set in .env — phone creation/updates will fail until it is."
  );
}

// Fixed, constant values per explicit request — every phone created
// or updated through this app uses the SAME login password and
// registration secret, rather than an admin choosing one per phone.
// pass = "Login Password" (legacy admin.php concept), conf_secret =
// "Registration Password" (the actual SIP/PJSIP registration secret a
// softphone like MicroSIP authenticates with) — confirmed directly
// against a real, working production phone row, not assumed. These
// are documented in .env specifically so whoever is manually
// configuring a physical/soft phone's SIP client knows what to type —
// the admin UI itself never asks for or displays them, since they're
// no longer a per-phone choice at all.
const PHONE_LOGIN_PASSWORD = process.env.PHONE_LOGIN_PASSWORD;
const PHONE_REGISTRATION_PASSWORD = process.env.PHONE_REGISTRATION_PASSWORD;
if (!PHONE_LOGIN_PASSWORD || !PHONE_REGISTRATION_PASSWORD) {
  console.warn(
    "[adminRoutes] PHONE_LOGIN_PASSWORD / PHONE_REGISTRATION_PASSWORD are not set in .env — phone creation/updates will fail until they are."
  );
}

/*
==================================================
PJSIP WIZARD FILE GENERATION FOR PHONES
==================================================
Real finding from tonight's investigation: this ViciDial install
normally has phones' PJSIP config regenerated by a Perl daemon
(ADMIN_keepalive_ALL.pl) that reads the phones table and rewrites
pjsip_wizard-vicidial.conf — but that daemon isn't running continuously
on sandbox (confirmed via `ps aux`), and wasn't found running on
production either when checked. Rather than depend on starting or
scheduling that external Perl process, this app generates its OWN
separate file and triggers the reload directly here — bypassing
ViciDial's mechanism entirely, matching the same direct-PJSIP-config
approach already used for the CMXSandbox trunk earlier this session.

Kept in a SEPARATE file (not pjsip.conf, not
pjsip_wizard-vicidial.conf) specifically so this never touches or
conflicts with either the manually-built trunk config or whatever
ViciDial's own daemon might someday also try to write to the same
filename.

ONE-TIME MANUAL SETUP STEP, not done by this code: add
`#include "pjsip-phones-cmxdialer.conf"` to /etc/asterisk/pjsip.conf,
and create an empty starting file at that path so the include doesn't
fail before this ever runs for the first time.

Block format confirmed directly against a REAL, working production
phone's own generated wizard block (bsmsc901) — not guessed.
inbound_auth/password uses PHONE_REGISTRATION_PASSWORD, matching
conf_secret's confirmed role.

Regenerates the WHOLE file from scratch every time (all active phones
on this server), rather than trying to patch just the one changed
entry — simpler, and correctness-by-construction: the file can never
drift from what's actually in the database.
==================================================
*/
const PHONE_WIZARD_CONF_PATH = "/etc/asterisk/pjsip-phones-cmxdialer.conf";

/*
==================================================
PHONE PJSIP OBJECT GENERATION — endpoint/auth/aor triplet
==================================================
REAL FINDING, confirmed via direct testing tonight: type=wizard blocks
specifically fail to load from an #included file on this Asterisk
instance — a plain type=endpoint test object (testendpoint) loaded
correctly via the exact same #include mechanism, isolating the
failure specifically to the wizard config layer, not #include itself
or file permissions/encoding (all separately ruled out first).

Switched to the same verbose endpoint/auth/aor triplet pattern already
confirmed working for the CMXSandbox trunk earlier this session —
matches the standard reference pattern (same bracket name reused
across all three object types, distinguished by their own type=
field), not guessed.
==================================================
*/
function buildPhoneWizardBlock({ extension, login, fullname }) {
  const callerName = (fullname || login || extension).replace(/"/g, "");
  return [
    `[${extension}]`,
    `type = endpoint`,
    `transport = transport-udp`,
    `context = default`,
    `disallow = all`,
    `allow = ulaw`,
    `auth = ${extension}`,
    `aors = ${extension}`,
    `callerid = "${callerName}" <0000000000>`,
    `dtmf_mode = rfc4733`,
    `send_rpid = yes`,
    `trust_id_inbound = no`,
    ``,
    `[${extension}]`,
    `type = auth`,
    `auth_type = userpass`,
    `username = ${login}`,
    `password = ${PHONE_REGISTRATION_PASSWORD}`,
    ``,
    `[${extension}]`,
    `type = aor`,
    `max_contacts = 2`,
    `qualify_frequency = 15`,
    `maximum_expiration = 3600`,
    `minimum_expiration = 60`,
    `default_expiration = 120`,
    ``,
  ].join("\n");
}

async function regeneratePhoneWizardFile() {
  const [rows] = await db.execute(
    `SELECT extension, login, fullname FROM asterisk.phones WHERE server_ip = ? AND active = 'Y'`,
    [SERVER_IP]
  );

  let content =
    "; AUTO-GENERATED by cmx_dialer's own admin panel — DO NOT EDIT MANUALLY.\n" +
    "; Regenerated automatically on every phone create/update/delete via\n" +
    "; POST/PUT/DELETE /api/admin/phones. See adminRoutes.js.\n\n";

  for (const row of rows) {
    content += buildPhoneWizardBlock(row) + "\n";
  }

  fs.writeFileSync(PHONE_WIZARD_CONF_PATH, content);
  await ami.reloadPjsip();
}

router.get("/phones", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT extension, login, fullname, active, protocol, server_ip
        FROM asterisk.phones
        WHERE server_ip = ?
        ORDER BY extension ASC
      `,
      [SERVER_IP]
    );
    return res.json({ success: true, phones: rows });
  } catch (error) {
    console.error("GET /api/admin/phones failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load phones." });
  }
});

router.post("/phones", requireAdmin, async (req, res) => {
  const { extension, login, fullname, active } = req.body;

  if (!SERVER_IP) {
    return res.status(500).json({ success: false, message: "SERVER_IP is not configured on this server." });
  }
  if (!PHONE_LOGIN_PASSWORD || !PHONE_REGISTRATION_PASSWORD) {
    return res
      .status(500)
      .json({ success: false, message: "PHONE_LOGIN_PASSWORD/PHONE_REGISTRATION_PASSWORD are not configured on this server." });
  }
  if (!extension || !login) {
    return res.status(400).json({ success: false, message: "extension and login are required." });
  }

  try {
    await db.execute(
      `
        INSERT INTO asterisk.phones
          (extension, server_ip, login, pass, conf_secret, fullname, active, protocol)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PJSIP')
      `,
      [
        extension,
        SERVER_IP,
        login,
        PHONE_LOGIN_PASSWORD,
        PHONE_REGISTRATION_PASSWORD,
        fullname || null,
        active === false ? "N" : "Y",
      ]
    );

    let reloadWarning;
    try {
      await regeneratePhoneWizardFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate PJSIP wizard file after creating ${extension}:`, reloadError.message);
      reloadWarning =
        "Phone was saved, but applying it to Asterisk failed — it may not be callable yet. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    console.error("POST /api/admin/phones failed:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ success: false, message: `Extension ${extension} already exists on this server.` });
    }
    return res.status(500).json({ success: false, message: "Failed to create phone." });
  }
});

// extension is treated as immutable once created — matching how the
// rest of this app already treats vicidial_users.user (no rename path
// exists there either). Changing which extension number a phone
// answers to is rare enough, and risky enough (an active user binding
// could be pointing at the old value), that "delete and recreate" is
// the safer, simpler path for now rather than building a rename flow.
//
// pass/conf_secret are ALWAYS reset to the current PHONE_LOGIN_PASSWORD/
// PHONE_REGISTRATION_PASSWORD on every save, not left untouched — a
// deliberate choice, not an oversight: if those fixed values are ever
// rotated in .env, saving an existing phone brings it back in sync
// with the current standard rather than silently drifting on an old one.
router.put("/phones/:extension", requireAdmin, async (req, res) => {
  const { extension } = req.params;
  const { login, fullname, active } = req.body;

  if (!SERVER_IP) {
    return res.status(500).json({ success: false, message: "SERVER_IP is not configured on this server." });
  }
  if (!PHONE_LOGIN_PASSWORD || !PHONE_REGISTRATION_PASSWORD) {
    return res
      .status(500)
      .json({ success: false, message: "PHONE_LOGIN_PASSWORD/PHONE_REGISTRATION_PASSWORD are not configured on this server." });
  }
  if (!login) {
    return res.status(400).json({ success: false, message: "login is required." });
  }

  try {
    const [result] = await db.execute(
      `
        UPDATE asterisk.phones
        SET login = ?, pass = ?, conf_secret = ?, fullname = ?, active = ?
        WHERE extension = ? AND server_ip = ?
      `,
      [login, PHONE_LOGIN_PASSWORD, PHONE_REGISTRATION_PASSWORD, fullname || null, active === false ? "N" : "Y", extension, SERVER_IP]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Phone not found on this server." });
    }

    let reloadWarning;
    try {
      await regeneratePhoneWizardFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate PJSIP wizard file after updating ${extension}:`, reloadError.message);
      reloadWarning =
        "Phone was saved, but applying it to Asterisk failed — changes may not be live yet. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    console.error("PUT /api/admin/phones/:extension failed:", error);
    return res.status(500).json({ success: false, message: "Failed to update phone." });
  }
});

router.delete("/phones/:extension", requireAdmin, async (req, res) => {
  const { extension } = req.params;

  if (!SERVER_IP) {
    return res.status(500).json({ success: false, message: "SERVER_IP is not configured on this server." });
  }

  try {
    const [result] = await db.execute(
      `DELETE FROM asterisk.phones WHERE extension = ? AND server_ip = ?`,
      [extension, SERVER_IP]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Phone not found on this server." });
    }

    let reloadWarning;
    try {
      await regeneratePhoneWizardFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate PJSIP wizard file after deleting ${extension}:`, reloadError.message);
      reloadWarning = "Phone was deleted from the database, but Asterisk wasn't reloaded. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    console.error("DELETE /api/admin/phones/:extension failed:", error);
    return res.status(500).json({ success: false, message: "Failed to delete phone." });
  }
});

/*
==================================================
VICIDIAL USERS — standalone CRUD
==================================================
Separated out per explicit request — creating a ViciDial user is now
its own, independent action (matching admin.php's own separation of
concerns), not something that only happens bundled inside app-user
creation. This is the SAME resource pool GET /vicidial-users/available
already draws from for the "bind to an existing ViciDial user"
dropdown — a user created here becomes immediately bindable to any app
user afterward, no different from a pre-existing account.

POST /users/full (further up this file) still exists and still works —
left in place rather than removed, since it's tested and functional,
just no longer the primary path the frontend uses for this. If a
future need for "create both together in one step" comes back, it's
already there.

Same practical MVP field subset and fixed-placeholder-password
reasoning as POST /users/full above.
==================================================
*/
router.get("/vicidial-users", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT user, full_name, user_level, user_group, phone_login, email, active
        FROM asterisk.vicidial_users
        ORDER BY user ASC
      `
    );
    return res.json({ success: true, vicidialUsers: rows });
  } catch (error) {
    console.error("GET /api/admin/vicidial-users failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load ViciDial users." });
  }
});

router.post("/vicidial-users", requireAdmin, async (req, res) => {
  const { username, fullName, phoneLogin, phonePass, userLevel, userGroup, email, active } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, message: "username is required." });
  }

  try {
    await db.execute(
      `
        INSERT INTO asterisk.vicidial_users
          (user, pass, full_name, user_level, user_group, phone_login, phone_pass, email, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        username,
        "CXXXXXXXXXXC",
        fullName || null,
        userLevel || 1,
        userGroup || null,
        phoneLogin || null,
        phonePass || null,
        email || null,
        active === false ? "N" : "Y",
      ]
    );
    return res.json({ success: true, username });
  } catch (error) {
    console.error("POST /api/admin/vicidial-users failed:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: `ViciDial username ${username} already exists.` });
    }
    return res.status(500).json({ success: false, message: "Failed to create ViciDial user." });
  }
});

router.put("/vicidial-users/:username", requireAdmin, async (req, res) => {
  const { username } = req.params;
  const { fullName, phoneLogin, phonePass, userLevel, userGroup, email, active } = req.body;

  try {
    const params = [
      fullName || null,
      userLevel || 1,
      userGroup || null,
      phoneLogin || null,
      email || null,
      active === false ? "N" : "Y",
    ];
    let setClause = "full_name = ?, user_level = ?, user_group = ?, phone_login = ?, email = ?, active = ?";

    // phonePass optional on update, same reasoning as the phones
    // section — an admin editing other fields shouldn't be forced to
    // re-type/reset the SIP password every time.
    if (phonePass) {
      setClause += ", phone_pass = ?";
      params.push(phonePass);
    }

    params.push(username);

    const [result] = await db.execute(
      `UPDATE asterisk.vicidial_users SET ${setClause} WHERE user = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "ViciDial user not found." });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("PUT /api/admin/vicidial-users/:username failed:", error);
    return res.status(500).json({ success: false, message: "Failed to update ViciDial user." });
  }
});

router.delete("/vicidial-users/:username", requireAdmin, async (req, res) => {
  const { username } = req.params;

  try {
    // Guard: refuse to delete a ViciDial user still bound to an app
    // user — that would leave app_users.vicidial_user pointing at a
    // row that no longer exists. The admin needs to release the
    // binding first (edit that app user, set ViciDial User to
    // None/Release) before deleting the ViciDial account itself.
    const [boundCheck] = await db.execute(
      `SELECT app_user_id FROM cmx_dialer.app_users WHERE vicidial_user = ?`,
      [username]
    );
    if (boundCheck.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "This ViciDial user is still bound to an app account. Unbind it first (edit that app user, set ViciDial User to None/Release).",
      });
    }

    const [result] = await db.execute(`DELETE FROM asterisk.vicidial_users WHERE user = ?`, [username]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "ViciDial user not found." });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/admin/vicidial-users/:username failed:", error);
    return res.status(500).json({ success: false, message: "Failed to delete ViciDial user." });
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
          open_row.related_call_direction AS open_related_call_direction,
          last_closed.logged_out_elapsed_seconds,
          (
            SELECT aca.campaign_id FROM cmx_dialer.agent_campaign_assignments aca
            WHERE aca.app_user_id = au.app_user_id AND aca.active = 1
            ORDER BY aca.campaign_id LIMIT 1
          ) AS assigned_campaign_id
        FROM cmx_dialer.app_users au
        LEFT JOIN (
          SELECT app_user_id, status, related_call_id, related_campaign_id, related_call_direction, TIMESTAMPDIFF(SECOND, started_at, NOW()) AS elapsed_seconds
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

    const callIdsNeedingTotal = rows
      .filter((r) => r.open_status === "IN_CALL" && r.open_related_call_id)
      .map((r) => r.open_related_call_id);

    const totalsByCallId = new Map();
    if (callIdsNeedingTotal.length > 0) {
      const placeholders = callIdsNeedingTotal.map(() => "?").join(",");
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
          WHERE related_call_id IN (${placeholders})
          GROUP BY related_call_id
        `,
        callIdsNeedingTotal
      );
      for (const t of totalRows) {
        totalsByCallId.set(t.related_call_id, Number(t.total_seconds) || 0);
      }
    }

    const callerIdsByCallId = { ...dialerService.getActiveCallPhoneNumbers() };
    for (const call of inboundCallService.getAllInboundCalls()) {
      callerIdsByCallId[call.callId] = call.callerIdNumber;
    }

    const agents = rows.map((r) => {
      const displayCampaignId = r.open_related_campaign_id || r.assigned_campaign_id || null;

      if (r.open_status) {
        const isCallRelated =
          r.open_status === "IN_CALL" || r.open_status === "ON_HOLD" || r.open_status === "AFTER_CALL_WORK";
        const useAggregatedDuration = r.open_status === "IN_CALL";
        const totalHandlingSeconds = useAggregatedDuration ? totalsByCallId.get(r.open_related_call_id) : undefined;

        return {
          appUserId: r.app_user_id,
          fullName: r.full_name,
          email: r.email,
          vicidialUser: r.vicidial_user,
          campaignId: displayCampaignId,
          status: r.open_status,
          direction: isCallRelated ? r.open_related_call_direction || null : null,
          callerId: isCallRelated ? callerIdsByCallId[r.open_related_call_id] || null : null,
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
        direction: null,
        elapsedSeconds: r.logged_out_elapsed_seconds,
        lastLoginAt: r.last_login_at,
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

REAL BUG FOUND AND FIXED HERE: THREE separate tables have actual
enforced foreign keys on app_user_id, confirmed via information_schema
(not assumed) — agent_campaign_assignments, agent_status_log,
otp_codes, and phone_assignments. This delete previously only cleared
agent_campaign_assignments, meaning any user who had ever actually
logged in, requested an OTP, or had a phone_assignments row at all
could never be deleted, failing with a raw FK constraint error
surfaced to the admin as a generic 500. Confirmed via multiple real
failed delete attempts, not theoretical. Fixed by clearing all four
referencing tables in the same transaction before deleting app_users
itself.

NOTE: phone_assignments appears to be an audit-trail table (assigned_at/
unassigned_at/active columns) for phone-binding history — but none of
this file's own user-creation/update endpoints currently write to it
at all. Either it's populated by something outside this file, or it's
unused by the current code paths. Worth investigating separately;
cleared here regardless since it still blocks deletion via its FK.
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

    await connection.execute(
      `DELETE FROM cmx_dialer.agent_status_log WHERE app_user_id = ?`,
      [appUserId]
    );

    await connection.execute(
      `DELETE FROM cmx_dialer.otp_codes WHERE app_user_id = ?`,
      [appUserId]
    );

    await connection.execute(
      `DELETE FROM cmx_dialer.phone_assignments WHERE app_user_id = ?`,
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
POST /users/:appUserId/kick
==================================================
*/
router.post("/users/:appUserId/kick", requireAdmin, async (req, res) => {
  try {
    const { appUserId } = req.params;

    const [rows] = await db.execute(
      `SELECT status FROM cmx_dialer.agent_status_log WHERE app_user_id = ? AND ended_at IS NULL LIMIT 1`,
      [appUserId]
    );
    const currentStatus = rows[0]?.status;

    if (!currentStatus) {
      return res.status(400).json({ success: false, message: "This agent isn't currently logged in." });
    }
    if (!["NOT_READY", "AUX_CB"].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: `Can't kick an agent who is currently ${currentStatus} — only Not Ready or Aux CB agents can be force-logged-out.`,
      });
    }

    await ws.forceLogout(appUserId, "kicked_by_admin");

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/admin/users/:appUserId/kick failed:", error);
    return res.status(500).json({ success: false, message: "Failed to kick this agent." });
  }
});

/*
==================================================
QUEUE STATUS
==================================================
GET /api/admin/queue-status?campaignId=optional
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
          combined.direction,
          agg.handle_time_seconds
        FROM (
          SELECT campaign_id, phone_number, call_id, call_started_at, 'outbound' AS direction
          FROM cmx_dialer.dialer_call_log
          UNION ALL
          SELECT campaign_id, caller_id_number AS phone_number, call_id, call_started_at, 'inbound' AS direction
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
      direction: r.direction,
      handleTimeSeconds: r.handle_time_seconds,
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

/*
==================================================
REPORTING SUMMARY (Inbound / Outbound KPI cards)
==================================================
GET /api/admin/reporting-summary?campaignId=optional
==================================================
*/
router.get("/reporting-summary", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.query;
    const summary = await statsService.getReportingSummary(campaignId || null);
    return res.json({ success: true, summary });
  } catch (error) {
    console.error("GET /api/admin/reporting-summary failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load reporting summary." });
  }
});

module.exports = router;