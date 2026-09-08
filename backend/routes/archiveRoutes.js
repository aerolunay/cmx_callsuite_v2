"use strict";

const crypto = require("crypto");
const express = require("express");
const db = require("../config/db");
const recordingUploadService = require("../services/recordingUploadService");

const router = express.Router();

/*
==================================================
ARCHIVE ROUTES
==================================================
Called by a local script (Python, run from Spyder or a scheduled
batch file on someone's own PC — NOT this server) that copies old
call recordings and voicemails down to local storage. Same reasoning
as internalRoutes.js for why this isn't behind session/cookie auth:
a standalone script running on a different machine has no way to
participate in that. Protected the exact same way — a shared secret
(ARCHIVE_API_SECRET in .env), compared in constant time — but
deliberately a SEPARATE secret from INTERNAL_API_SECRET, not reused,
so a leaked archive-script secret can only ever hit these two
read/confirm endpoints, not fake a call-routing callback from the
dialplan, and vice versa.

Mounted at /archive, not /api/archive — same "visually and
structurally distinct from session-authenticated routes" reasoning as
internalRoutes.js's own /internal mount.

Per explicit request, this does NOT delete anything from S3 or clear
any recording_key — a recording/voicemail successfully archived
locally is just recorded in cmx_dialer.archived_recordings (see the
SQL migration alongside this file) so the SAME recording doesn't get
re-downloaded on the next run. The underlying S3 object and DB row are
left completely untouched; if a more aggressive "delete after archive"
mode is wanted later, that's a deliberate follow-up change, not
something this file does today.
==================================================
*/

function isValidSecret(provided) {
  const expected = process.env.ARCHIVE_API_SECRET;
  if (!expected || !provided) return false;

  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function requireSecret(req, res, next) {
  const provided = req.query.secret || req.body?.secret;
  if (!isValidSecret(provided)) {
    return res.status(403).json({ success: false, message: "Invalid or missing secret." });
  }
  next();
}

// Mirrors the exact <campaign>_<direction>_<agent name>_<yyyymmdd>
// naming convention requested for the local files — built here
// (not left to the script) so the script can just use this value
// as-is; the script still handles ITS OWN local collision-avoidance
// (e.g. two calls same campaign/direction/agent/day), since only it
// knows what's already sitting on disk.
function sanitizeForFilename(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function buildSuggestedFilename({ campaignId, direction, agentName, callStartedAt }) {
  const yyyymmdd = new Date(callStartedAt).toISOString().slice(0, 10).replace(/-/g, "");
  return [sanitizeForFilename(campaignId), sanitizeForFilename(direction), sanitizeForFilename(agentName), yyyymmdd].join("_");
}

/*
==================================================
GET /archive/eligible?secret=...&olderThanDate=YYYY-MM-DD
==================================================
Returns every call recording and voicemail with a call/left date
strictly before olderThanDate, that hasn't already been archived (not
present in cmx_dialer.archived_recordings), across all three sources
(outbound calls, inbound calls, voicemails). Each item includes a
ready-to-use presigned downloadUrl (1 hour expiry, same as
getPlaybackUrl elsewhere) — the script downloads directly from S3
using this URL, no second authenticated round-trip needed per file.

olderThanDate is REQUIRED and taken as-is from the caller (the Python
script computes it from its own PROD/TEST reference-date toggle) —
this route deliberately does not compute "5 days ago" itself, so the
script's testing mode can ask for any historical cutoff without this
endpoint needing a matching test mode of its own.
==================================================
*/
router.get("/eligible", requireSecret, async (req, res) => {
  try {
    const { olderThanDate } = req.query;
    if (!olderThanDate) {
      return res.status(400).json({ success: false, message: "olderThanDate query param is required (YYYY-MM-DD)." });
    }
    const cutoff = `${olderThanDate} 00:00:00`;

    const [outboundRows] = await db.execute(
      `
        SELECT
          d.recording_key, d.campaign_id, c.campaign_name, d.call_started_at,
          au.full_name AS agent_name, 'outbound' AS direction
        FROM cmx_dialer.dialer_call_log d
        LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = d.campaign_id
        LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = d.agent_user
        LEFT JOIN cmx_dialer.archived_recordings ar ON ar.recording_key = d.recording_key
        WHERE d.recording_key IS NOT NULL
          AND d.call_started_at < ?
          AND ar.recording_key IS NULL
      `,
      [cutoff]
    );

    const [inboundRows] = await db.execute(
      `
        SELECT
          i.recording_key, i.campaign_id, c.campaign_name, i.call_started_at,
          au.full_name AS agent_name, 'inbound' AS direction
        FROM cmx_dialer.inbound_call_log i
        LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = i.campaign_id
        LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = i.agent_user
        LEFT JOIN cmx_dialer.archived_recordings ar ON ar.recording_key = i.recording_key
        WHERE i.recording_key IS NOT NULL
          AND i.call_started_at < ?
          AND ar.recording_key IS NULL
      `,
      [cutoff]
    );

    const [voicemailRows] = await db.execute(
      `
        SELECT
          v.recording_key, v.campaign_id, c.campaign_name, v.left_at AS call_started_at,
          NULL AS agent_name, 'voicemail' AS direction
        FROM cmx_dialer.voicemail_log v
        LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = v.campaign_id
        LEFT JOIN cmx_dialer.archived_recordings ar ON ar.recording_key = v.recording_key
        WHERE v.recording_key IS NOT NULL
          AND v.left_at < ?
          AND ar.recording_key IS NULL
      `,
      [cutoff]
    );

    const allRows = [...outboundRows, ...inboundRows, ...voicemailRows];

    const items = await Promise.all(
      allRows.map(async (row) => {
        // Per explicit request — voicemails have no agent at all
        // (nobody ever answered them), so "voicemail" fills that
        // segment of the filename instead of leaving it blank or
        // guessing at one.
        const agentName = row.direction === "voicemail" ? "voicemail" : row.agent_name || "unassigned";
        const suggestedFilename = buildSuggestedFilename({
          campaignId: row.campaign_name || row.campaign_id,
          direction: row.direction,
          agentName,
          callStartedAt: row.call_started_at,
        });
        const downloadUrl = await recordingUploadService.getDownloadUrl(row.recording_key, `${suggestedFilename}.wav`);
        return {
          recordingKey: row.recording_key,
          campaignId: row.campaign_id,
          campaignName: row.campaign_name,
          direction: row.direction,
          agentName,
          callStartedAt: row.call_started_at,
          suggestedFilename,
          downloadUrl,
        };
      })
    );

    return res.json({ success: true, count: items.length, items });
  } catch (error) {
    console.error("GET /archive/eligible failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load eligible recordings." });
  }
});

/*
==================================================
POST /archive/confirm
==================================================
Body: { secret, recordingKeys: [...] }. Called by the script ONLY
after each file has actually finished downloading successfully to
local disk — marks it archived so it drops out of future /eligible
calls. INSERT ... ON DUPLICATE KEY avoids erroring on a key that
somehow gets confirmed twice (e.g. the script re-running after a
partial failure on a previous pass).
==================================================
*/
router.post("/confirm", requireSecret, async (req, res) => {
  try {
    const { recordingKeys } = req.body;
    if (!Array.isArray(recordingKeys) || recordingKeys.length === 0) {
      return res.status(400).json({ success: false, message: "recordingKeys must be a non-empty array." });
    }

    for (const key of recordingKeys) {
      await db.execute(
        `INSERT INTO cmx_dialer.archived_recordings (recording_key) VALUES (?)
         ON DUPLICATE KEY UPDATE archived_at = archived_at`,
        [key]
      );
    }

    return res.json({ success: true, confirmed: recordingKeys.length });
  } catch (error) {
    console.error("POST /archive/confirm failed:", error);
    return res.status(500).json({ success: false, message: "Failed to confirm archived recordings." });
  }
});

module.exports = router;
