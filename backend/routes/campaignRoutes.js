"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const express = require("express");
const multer = require("multer");
const db = require("../config/db");
const ami = require("../config/ami");

const execFileAsync = util.promisify(execFile);

const router = express.Router();

/*
==================================================
CAMPAIGN MANAGEMENT — create/edit/delete campaigns, with auto-created
DID routing, audio prompts, and dialplan
==================================================
Writes to THREE places per campaign, in one DB transaction:
  1. asterisk.vicidial_campaigns   — ViciDial's own native campaign
     row. Only a practical subset of its 300+ columns is set here,
     same "MVP subset, everything else takes ViciDial's own defaults"
     approach already used for vicidial_users/phones elsewhere in this
     app.
  2. asterisk.vicidial_inbound_dids — ViciDial's own native DID-routing
     table. This app's OWN inbound call handling (inboundCallService.js)
     reads this table directly now (did_pattern -> campaign_id) — see
     that file's lookupCampaignForDid(). Writing a row here is what
     makes a brand-new campaign's DID work immediately, with zero
     backend redeploy.
  3. cmx_dialer.campaign_settings   — the pieces neither ViciDial table
     has: which audio files play, and the business-hours window that
     decides which one plays. See sql/001_create_campaign_settings.sql.

Then, OUTSIDE the DB transaction (same "commit first, apply to
Asterisk after" pattern as adminRoutes.js's phone/vicidial-user
routes): converts the two uploaded audio files to raw .ulaw, moves
them into Asterisk's sounds/custom directory (via a narrowly-scoped
sudo — see deployAudioFile()), regenerates the campaign dialplan file
from every active campaign's DB row (same "rebuild the whole file from
the DB every time" pattern as adminRoutes.js's phone wizard file), and
reloads ONLY the dialplan (never pjsip.conf) — so this can never
disrupt an in-progress call on a different campaign or on the shared
trunk.

==================================================
FIELD MAPPING — what this app's UI concept maps to on each real table
==================================================
- Caller ID (spoof DID if blank)  -> vicidial_campaigns.campaign_cid
  (if the admin leaves Caller ID blank, campaign_cid is set to the DID
  itself, not left as ViciDial's own default '0000000000')
- Outbound vs Blended             -> cmx_dialer.campaign_settings.campaign_type
  (NOT vicidial_campaigns.campaign_allow_inbound — deliberately kept
  separate; see the SQL file's own comment for why)
- Auto Dial vs Manual Dial        -> vicidial_campaigns.dial_method
  ('MANUAL' vs 'RATIO' — RATIO is the simplest real auto-dial method
  value; this app does not yet implement actual predictive/ratio
  dialing logic, so this is stored as configuration/intent for future
  use, matching the "auto-dial campaign readiness" note already in the
  Phase B addendum bookmark)
- Call Recording Enabled/Disabled -> vicidial_campaigns.campaign_recording
  ('ALLCALLS' vs 'NEVER' — dialerService.js/inboundCallService.js now
  both check this column directly instead of a hardcoded
  campaignId === "CMXBSMSC" check)
- Welcome Greeting / After Hours  -> cmx_dialer.campaign_settings
  (filenames only; the actual .ulaw files live in
  SOUNDS_CUSTOM_DIR, named deterministically from campaignId)
- Business hours                 -> cmx_dialer.campaign_settings
  (NOT explicitly requested, but functionally required — the
  after-hours audio has no meaning without a real hours/days window to
  gate on. Defaults to 09:00-18:00, mon-fri if not provided.)
==================================================
*/

const SOUNDS_CUSTOM_DIR = process.env.SOUNDS_CUSTOM_DIR || "/var/lib/asterisk/sounds/custom";
const CAMPAIGN_DIALPLAN_CONF_PATH =
  process.env.CAMPAIGN_DIALPLAN_CONF_PATH || "/etc/asterisk/extensions-campaigns-cmxdialer.conf";
const CAMPAIGN_AUDIO_STAGING_DIR = path.join(__dirname, "..", "tmp", "campaign-audio-staging");
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const INTERNAL_API_BASE_URL = process.env.INTERNAL_API_BASE_URL || "http://127.0.0.1:5060";

if (!INTERNAL_API_SECRET) {
  console.warn(
    "[campaignRoutes] INTERNAL_API_SECRET is not set in .env — generated dialplan CURL() calls will fail their secret check."
  );
}

// Ensure the staging directory exists at startup — this is a directory
// the app's own OS user already owns (created alongside its own code,
// not inside any Asterisk-owned tree), so no elevated privilege is
// needed for this part.
fs.mkdirSync(CAMPAIGN_AUDIO_STAGING_DIR, { recursive: true });

const upload = multer({
  dest: CAMPAIGN_AUDIO_STAGING_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — generous for a short voice prompt
});

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
AUDIO CONVERSION + DEPLOYMENT
==================================================
convertToUlaw uses execFile (never a shell string) — arguments are
passed as an array, so there is no shell-injection surface even though
the input filename technically comes from a user upload.

deployAudioFile is the ONLY place in this file that shells out via
sudo. It requires a one-time, narrowly-scoped sudoers rule on whichever
OS user runs this Node process — see the project notes for the exact
line to add. Scoped to exactly two commands (mv into
SOUNDS_CUSTOM_DIR, restorecon on a path inside SOUNDS_CUSTOM_DIR) —
nothing broader. If that sudoers rule doesn't exist yet, both
execFileAsync calls below will reject with a permission error, which
is caught and surfaced as a reloadWarning rather than silently losing
the uploaded file.
==================================================
*/
async function convertToUlaw(inputPath, outputPath) {
  await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-ar", "8000", "-ac", "1", "-f", "mulaw", outputPath]);
}

async function deployAudioFile(stagedUlawPath, finalFilename) {
  const destPath = path.join(SOUNDS_CUSTOM_DIR, finalFilename);
  await execFileAsync("sudo", ["/bin/mv", stagedUlawPath, destPath]);
  await execFileAsync("sudo", ["/sbin/restorecon", destPath]);
  return destPath;
}

// Converts one uploaded multer file (already on disk at file.path) into
// a deployed .ulaw file named deterministically from the campaign ID,
// cleaning up every intermediate staged file whether it succeeds or
// fails. Returns the final filename (not full path) to store in the DB.
async function processUploadedAudio(file, campaignId, kind) {
  const finalFilename = `cmx-campaign-${campaignId}-${kind}.ulaw`;
  const stagedUlawPath = path.join(CAMPAIGN_AUDIO_STAGING_DIR, `${path.basename(file.path)}.ulaw`);

  try {
    await convertToUlaw(file.path, stagedUlawPath);
    await deployAudioFile(stagedUlawPath, finalFilename);
    return finalFilename;
  } finally {
    // Best-effort cleanup of both staging artifacts — the original
    // multer upload (pre-conversion) and the converted .ulaw if
    // deployAudioFile's mv somehow didn't consume it (e.g. it failed
    // before the mv step). Errors here are logged, not thrown — a
    // leftover temp file is a minor annoyance, not worth failing the
    // whole request over.
    fs.unlink(file.path, (err) => {
      if (err && err.code !== "ENOENT") console.error(`[campaignRoutes] Failed to clean up staged upload ${file.path}:`, err.message);
    });
    fs.unlink(stagedUlawPath, (err) => {
      if (err && err.code !== "ENOENT") console.error(`[campaignRoutes] Failed to clean up staged ulaw ${stagedUlawPath}:`, err.message);
    });
  }
}

/*
==================================================
DIALPLAN GENERATION
==================================================
Same "regenerate the whole file from the DB every time" pattern as
adminRoutes.js's phone wizard file — the file can never drift from
what's actually in the database, and every campaign create/update/
delete rewrites it from scratch rather than trying to patch one block
in place.

Per-DID extension/label names are all prefixed with the DID itself
(e.g. "6468016974_open", "6468016974_afterhours") — REQUIRED, not
cosmetic: Phase 9's original single-DID example used bare "open"/
"afterhours" names, which only worked because there was exactly one
DID in the context. With multiple campaigns sharing [trunkinbound],
two campaigns both defining a plain "afterhours" extension would
silently overwrite each other. Scoping every label to its own DID
avoids that collision entirely.
==================================================
*/
function buildCampaignDialplanBlock({ did, campaignId, welcomeGreetingFilename, afterhoursAudioFilename, businessHoursStart, businessHoursEnd, businessDays }) {
  const openLabel = `${did}_open`;
  const afterhoursExten = `${did}_afterhours`;
  const noRoomLabel = `${did}_no_room`;

  // Playback() takes the path MINUS the file extension — Asterisk
  // picks the actual format itself. Confirmed convention from Phase 9
  // (custom/cmxbsm-greeting, no .ulaw suffix in the dialplan line).
  const greetingSound = welcomeGreetingFilename
    ? `custom/${path.basename(welcomeGreetingFilename, path.extname(welcomeGreetingFilename))}`
    : null;
  const afterhoursSound = afterhoursAudioFilename
    ? `custom/${path.basename(afterhoursAudioFilename, path.extname(afterhoursAudioFilename))}`
    : null;

  const lines = [
    `exten => ${did},1,NoOp(CMX Campaign ${campaignId} inbound)`,
    `exten => ${did},n,GotoIfTime(${businessHoursStart}-${businessHoursEnd},${businessDays},*,*?${openLabel})`,
    `exten => ${did},n,Goto(${afterhoursExten},1)`,
    `exten => ${did},n(${openLabel}),Answer()`,
  ];

  if (greetingSound) {
    lines.push(`exten => ${did},n,Playback(${greetingSound})`);
  }

  lines.push(
    `exten => ${did},n,Set(ROOM=\${CURL(${INTERNAL_API_BASE_URL}/internal/allocate-inbound-room?secret=${INTERNAL_API_SECRET}&did=${did})})`,
    `exten => ${did},n,GotoIf($["\${ROOM}" = ""]?${noRoomLabel})`,
    `exten => ${did},n,ConfBridge(\${ROOM},vici_agent_bridge,cmx_inbound_customer)`,
    `exten => ${did},n,Hangup()`,
    `exten => ${did},n(${noRoomLabel}),Hangup()`,
    `exten => ${afterhoursExten},1,Answer()`
  );

  if (afterhoursSound) {
    lines.push(`exten => ${afterhoursExten},n,Playback(${afterhoursSound})`);
  }

  lines.push(`exten => ${afterhoursExten},n,Hangup()`, ``);

  return lines.join("\n");
}

async function regenerateCampaignDialplanFile() {
  const [rows] = await db.execute(
    `
      SELECT
        d.did_pattern AS did,
        d.campaign_id AS campaignId,
        s.welcome_greeting_filename AS welcomeGreetingFilename,
        s.afterhours_audio_filename AS afterhoursAudioFilename,
        s.business_hours_start AS businessHoursStart,
        s.business_hours_end AS businessHoursEnd,
        s.business_days AS businessDays
      FROM asterisk.vicidial_inbound_dids d
      JOIN cmx_dialer.campaign_settings s ON s.campaign_id = d.campaign_id
      JOIN asterisk.vicidial_campaigns c ON c.campaign_id = d.campaign_id
      WHERE d.did_active = 'Y' AND c.active = 'Y'
      ORDER BY d.did_pattern ASC
    `
  );

  let content =
    "; AUTO-GENERATED by cmx_dialer's own admin panel — DO NOT EDIT MANUALLY.\n" +
    "; Regenerated automatically on every campaign create/update/delete via\n" +
    "; POST/PUT/DELETE /api/admin/campaigns. See campaignRoutes.js.\n" +
    "; This file is #included INSIDE the [trunkinbound] context in\n" +
    "; extensions.conf — it must never define its own context header.\n\n";

  for (const row of rows) {
    content += buildCampaignDialplanBlock(row) + "\n";
  }

  fs.writeFileSync(CAMPAIGN_DIALPLAN_CONF_PATH, content);
  await ami.reloadDialplan();
}

/*
==================================================
GET /api/admin/campaigns
==================================================
*/
router.get("/", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT
          c.campaign_id, c.campaign_name, c.active, c.campaign_cid, c.dial_method, c.campaign_recording,
          d.did_pattern AS did, d.record_call,
          s.campaign_type, s.welcome_greeting_filename, s.afterhours_audio_filename,
          s.business_hours_start, s.business_hours_end, s.business_days
        FROM asterisk.vicidial_campaigns c
        LEFT JOIN asterisk.vicidial_inbound_dids d ON d.campaign_id = c.campaign_id
        LEFT JOIN cmx_dialer.campaign_settings s ON s.campaign_id = c.campaign_id
        ORDER BY c.campaign_id ASC
      `
    );
    return res.json({ success: true, campaigns: rows });
  } catch (error) {
    console.error("GET /api/admin/campaigns failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load campaigns." });
  }
});

/*
==================================================
POST /api/admin/campaigns
==================================================
multipart/form-data. Text fields: campaignId, campaignName, did,
callerId (optional — blank means spoof the DID as CID), campaignType
("OUTBOUND" | "BLENDED"), dialMethod ("AUTO" | "MANUAL", only really
meaningful for OUTBOUND), recordingEnabled ("true" | "false"),
businessHoursStart, businessHoursEnd, businessDays.
Files: welcomeGreeting, afterhoursAudio (both optional at the DB-write
stage, but a campaign with no greeting/no DID at all is a degenerate
case worth allowing for pure-manual/no-inbound campaigns).
==================================================
*/
router.post(
  "/",
  requireAdmin,
  upload.fields([
    { name: "welcomeGreeting", maxCount: 1 },
    { name: "afterhoursAudio", maxCount: 1 },
  ]),
  async (req, res) => {
    const {
      campaignId,
      campaignName,
      did,
      callerId,
      campaignType,
      dialMethod,
      recordingEnabled,
      businessHoursStart,
      businessHoursEnd,
      businessDays,
    } = req.body;

    if (!campaignId || !campaignName) {
      return res.status(400).json({ success: false, message: "campaignId and campaignName are required." });
    }
    if (!["OUTBOUND", "BLENDED"].includes(campaignType)) {
      return res.status(400).json({ success: false, message: "campaignType must be OUTBOUND or BLENDED." });
    }

    // Spoofing rule, per explicit request: blank Caller ID means "use
    // the DID itself" — NOT ViciDial's own campaign_cid default of
    // '0000000000'. If there's no DID either, falls through to
    // ViciDial's own default, since there's nothing to spoof from.
    const resolvedCallerId = (callerId || "").trim() || (did || "").trim() || "0000000000";

    const resolvedDialMethod = dialMethod === "AUTO" ? "RATIO" : "MANUAL";
    const resolvedRecording = recordingEnabled === "false" ? "NEVER" : "ALLCALLS";

    const resolvedBusinessHoursStart = businessHoursStart || "09:00";
    const resolvedBusinessHoursEnd = businessHoursEnd || "18:00";
    const resolvedBusinessDays = businessDays || "mon-fri";

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      await connection.execute(
        `
          INSERT INTO asterisk.vicidial_campaigns
            (campaign_id, campaign_name, active, campaign_cid, dial_method, campaign_recording, campaign_allow_inbound)
          VALUES (?, ?, 'Y', ?, ?, ?, ?)
        `,
        [campaignId, campaignName, resolvedCallerId, resolvedDialMethod, resolvedRecording, campaignType === "BLENDED" ? "Y" : "N"]
      );

      if (did) {
        await connection.execute(
          `
            INSERT INTO asterisk.vicidial_inbound_dids
              (did_pattern, did_description, did_active, extension, exten_context, campaign_id, record_call)
            VALUES (?, ?, 'Y', ?, 'trunkinbound', ?, ?)
          `,
          [did, campaignName, did, campaignId, resolvedRecording === "NEVER" ? "N" : "Y"]
        );
      }

      await connection.execute(
        `
          INSERT INTO cmx_dialer.campaign_settings
            (campaign_id, campaign_type, business_hours_start, business_hours_end, business_days)
          VALUES (?, ?, ?, ?, ?)
        `,
        [campaignId, campaignType, resolvedBusinessHoursStart, resolvedBusinessHoursEnd, resolvedBusinessDays]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      console.error("POST /api/admin/campaigns failed:", error);
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ success: false, message: `Campaign ${campaignId} (or its DID) already exists.` });
      }
      return res.status(500).json({ success: false, message: "Failed to create campaign." });
    } finally {
      connection.release();
    }

    // Audio processing + dialplan generation happen AFTER commit — same
    // reasoning as adminRoutes.js's phone/vicidial-user routes: a slow
    // or failed Asterisk-side step should never make the
    // already-committed DB rows look like they failed to save.
    let reloadWarning;
    try {
      const welcomeFile = req.files?.welcomeGreeting?.[0];
      const afterhoursFile = req.files?.afterhoursAudio?.[0];

      let welcomeGreetingFilename = null;
      let afterhoursAudioFilename = null;

      if (welcomeFile) welcomeGreetingFilename = await processUploadedAudio(welcomeFile, campaignId, "greeting");
      if (afterhoursFile) afterhoursAudioFilename = await processUploadedAudio(afterhoursFile, campaignId, "afterhours");

      if (welcomeGreetingFilename || afterhoursAudioFilename) {
        await db.execute(
          `
            UPDATE cmx_dialer.campaign_settings
            SET welcome_greeting_filename = COALESCE(?, welcome_greeting_filename),
                afterhours_audio_filename = COALESCE(?, afterhours_audio_filename)
            WHERE campaign_id = ?
          `,
          [welcomeGreetingFilename, afterhoursAudioFilename, campaignId]
        );
      }

      if (did) {
        await regenerateCampaignDialplanFile();
      }
    } catch (error) {
      console.error(`[campaignRoutes] Failed to process audio/dialplan for campaign ${campaignId}:`, error.message);
      reloadWarning =
        "Campaign was saved, but applying its audio/dialplan to Asterisk failed — it may not take calls correctly yet. Check server logs (this often means the sudoers rule for audio deployment isn't set up on this server yet).";
    }

    return res.json({ success: true, campaignId, reloadWarning });
  }
);

/*
==================================================
PUT /api/admin/campaigns/:campaignId
==================================================
Same field set as create; DID is treated as immutable once set (same
"delete + recreate" philosophy as extension/username elsewhere in this
app) — this route does NOT change the DID. Audio files are optional on
update — omit either field entirely to keep the existing file.
==================================================
*/
router.put(
  "/:campaignId",
  requireAdmin,
  upload.fields([
    { name: "welcomeGreeting", maxCount: 1 },
    { name: "afterhoursAudio", maxCount: 1 },
  ]),
  async (req, res) => {
    const { campaignId } = req.params;
    const {
      campaignName,
      callerId,
      campaignType,
      dialMethod,
      recordingEnabled,
      businessHoursStart,
      businessHoursEnd,
      businessDays,
      active,
    } = req.body;

    if (!["OUTBOUND", "BLENDED"].includes(campaignType)) {
      return res.status(400).json({ success: false, message: "campaignType must be OUTBOUND or BLENDED." });
    }

    const [didRows] = await db.execute(
      `SELECT did_pattern FROM asterisk.vicidial_inbound_dids WHERE campaign_id = ? LIMIT 1`,
      [campaignId]
    );
    const did = didRows[0]?.did_pattern || null;

    const resolvedCallerId = (callerId || "").trim() || did || "0000000000";
    const resolvedDialMethod = dialMethod === "AUTO" ? "RATIO" : "MANUAL";
    const resolvedRecording = recordingEnabled === "false" ? "NEVER" : "ALLCALLS";

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [result] = await connection.execute(
        `
          UPDATE asterisk.vicidial_campaigns
          SET campaign_name = ?, active = ?, campaign_cid = ?, dial_method = ?, campaign_recording = ?, campaign_allow_inbound = ?
          WHERE campaign_id = ?
        `,
        [
          campaignName,
          active === false ? "N" : "Y",
          resolvedCallerId,
          resolvedDialMethod,
          resolvedRecording,
          campaignType === "BLENDED" ? "Y" : "N",
          campaignId,
        ]
      );

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: "Campaign not found." });
      }

      if (did) {
        await connection.execute(
          `UPDATE asterisk.vicidial_inbound_dids SET record_call = ? WHERE campaign_id = ?`,
          [resolvedRecording === "NEVER" ? "N" : "Y", campaignId]
        );
      }

      // UPSERT, not a plain UPDATE — REAL BUG FIX: any campaign that
      // existed BEFORE this feature was built (CMXBSMSC, CMXBLND,
      // CMXBSM, CMXOUTB — everything predating campaignRoutes.js) has
      // NO row at all in cmx_dialer.campaign_settings yet, since it
      // was never created through POST /api/admin/campaigns. A plain
      // UPDATE against a nonexistent row silently affects 0 rows —
      // no error, no warning — so campaign_type/business-hours edits
      // on any legacy campaign appeared to save successfully but
      // never actually took effect. Confirmed via a real edit attempt
      // on CMXBSMSC (set to BLENDED, table kept showing OUTBOUND).
      await connection.execute(
        `
          INSERT INTO cmx_dialer.campaign_settings
            (campaign_id, campaign_type, business_hours_start, business_hours_end, business_days)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            campaign_type = VALUES(campaign_type),
            business_hours_start = VALUES(business_hours_start),
            business_hours_end = VALUES(business_hours_end),
            business_days = VALUES(business_days)
        `,
        [campaignId, campaignType, businessHoursStart || "09:00", businessHoursEnd || "18:00", businessDays || "mon-fri"]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      console.error(`PUT /api/admin/campaigns/${campaignId} failed:`, error);
      return res.status(500).json({ success: false, message: "Failed to update campaign." });
    } finally {
      connection.release();
    }

    let reloadWarning;
    try {
      const welcomeFile = req.files?.welcomeGreeting?.[0];
      const afterhoursFile = req.files?.afterhoursAudio?.[0];

      let welcomeGreetingFilename = null;
      let afterhoursAudioFilename = null;

      if (welcomeFile) welcomeGreetingFilename = await processUploadedAudio(welcomeFile, campaignId, "greeting");
      if (afterhoursFile) afterhoursAudioFilename = await processUploadedAudio(afterhoursFile, campaignId, "afterhours");

      if (welcomeGreetingFilename || afterhoursAudioFilename) {
        await db.execute(
          `
            UPDATE cmx_dialer.campaign_settings
            SET welcome_greeting_filename = COALESCE(?, welcome_greeting_filename),
                afterhours_audio_filename = COALESCE(?, afterhours_audio_filename)
            WHERE campaign_id = ?
          `,
          [welcomeGreetingFilename, afterhoursAudioFilename, campaignId]
        );
      }

      if (did) {
        await regenerateCampaignDialplanFile();
      }
    } catch (error) {
      console.error(`[campaignRoutes] Failed to process audio/dialplan for campaign ${campaignId}:`, error.message);
      reloadWarning =
        "Campaign was updated, but applying its audio/dialplan to Asterisk failed. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  }
);

/*
==================================================
DELETE /api/admin/campaigns/:campaignId
==================================================
Deletes the campaign_settings row and the vicidial_inbound_dids row
(freeing that DID), deactivates (does NOT hard-delete) the
vicidial_campaigns row itself — ViciDial's own campaign_id is
referenced from lead/call-log history all over its schema, so a hard
delete risks orphaning historical data. "active = N" matches how this
app already treats similar cases (e.g. app_users soft-delete via
`active`) more safely than a real DELETE.
==================================================
*/
router.delete("/:campaignId", requireAdmin, async (req, res) => {
  const { campaignId } = req.params;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(`UPDATE asterisk.vicidial_campaigns SET active = 'N' WHERE campaign_id = ?`, [campaignId]);
    await connection.execute(`DELETE FROM asterisk.vicidial_inbound_dids WHERE campaign_id = ?`, [campaignId]);
    await connection.execute(`DELETE FROM cmx_dialer.campaign_settings WHERE campaign_id = ?`, [campaignId]);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error(`DELETE /api/admin/campaigns/${campaignId} failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to delete campaign." });
  } finally {
    connection.release();
  }

  let reloadWarning;
  try {
    await regenerateCampaignDialplanFile();
  } catch (error) {
    console.error(`[campaignRoutes] Failed to regenerate dialplan after deleting ${campaignId}:`, error.message);
    reloadWarning = "Campaign was deleted, but Asterisk wasn't reloaded. Check server logs.";
  }

  return res.json({ success: true, reloadWarning });
});

module.exports = router;