"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const { parse: parseCsvSync } = require("csv-parse/sync");
const { stringify: stringifyCsvSync } = require("csv-stringify/sync");
const db = require("../config/db");

const router = express.Router();

/*
==================================================
LEAD UPLOAD / DNC MANAGEMENT / AUTODIAL RULES — Phase 1
==================================================
Phase 1 of the Outbound Auto-Dial feature: lead upload (CSV/XLSX +
generated template), campaign assignment (outbound campaigns only —
Blended excluded per explicit request, via campaignRoutes.js's own
GET /?type=OUTBOUND filter), DNC list management, and per-campaign
autodial rule storage. This file does NOT contain the actual
auto-dial ENGINE (Phase 2) — nothing here originates a call on its
own; it only stores data and rules for that future engine to read.

Uses the real, confirmed schemas for asterisk.vicidial_lists,
asterisk.vicidial_list, and asterisk.vicidial_dnc (via DESCRIBE, not
assumed) — see the SQL migration's own comment for the two NEW
cmx_dialer tables this introduces (campaign_autodial_rules,
lead_autodial_state).
==================================================
*/

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  if (req.session.agent.accessLevel !== "admin" && req.session.agent.accessLevel !== "wfm") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  return next();
}

const UPLOAD_STAGING_DIR = path.join(__dirname, "..", "tmp", "lead-upload-staging");
fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_STAGING_DIR,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — generous for a lead/DNC list in CSV or XLSX
});

/*
==================================================
Template generation — shared helper
==================================================
Builds a one-sheet template (headers + one example row) and streams it
back as either .xlsx or .csv.

UPDATED — originally used the `xlsx` (SheetJS) npm package. Swapped out
after a real, confirmed finding: every version of `xlsx` published to
the public npm registry has unpatched HIGH-severity advisories
(GHSA-4r6h-8v6p-xvw6, prototype pollution; GHSA-5pgg-2g8v-p4x9, ReDoS)
— SheetJS's own fixed releases are only distributed via their own CDN,
not npm, so a normal `npm install xlsx` can never actually get a
patched version. Replaced with exceljs (.xlsx) + csv-parse/csv-stringify
(.csv) — actively maintained, narrowly-scoped, no equivalent advisories
at time of writing.
==================================================
*/
async function sendTemplate(res, filenameBase, headers, exampleRow, format) {
  if (format === "csv") {
    const csvText = stringifyCsvSync([headers, exampleRow]);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
    return res.send(csvText);
  }

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Template");
  worksheet.addRow(headers);
  worksheet.addRow(exampleRow);
  const buffer = await workbook.xlsx.writeBuffer();

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
  return res.send(buffer);
}

/*
==================================================
Parses an uploaded CSV/XLSX file into an array of row objects, keyed
by whatever header row the file actually has (case/whitespace
normalized) — NOT positional.

Format is detected from the ORIGINAL filename's extension (multer's
file.originalname — the client-provided name, not the randomized
staged filename on disk). This is only ever used to pick which parser
to run, never for anything security-sensitive — worst case a
mismatched extension just fails to parse cleanly and surfaces a
friendly error, not a vulnerability.
==================================================
*/
function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = String(key).trim().toLowerCase().replace(/\s+/g, "_");
    normalized[normalizedKey] = typeof value === "string" ? value.trim() : value;
  }
  return normalized;
}

async function parseUploadedRows(file) {
  const buffer = fs.readFileSync(file.path);
  const isCsv = /\.csv$/i.test(file.originalname || "");

  if (isCsv) {
    const records = parseCsvSync(buffer.toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    return records.map(normalizeRowKeys);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];

  let headerKeys = null;
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    // exceljs's row.values is 1-INDEXED (index 0 is always empty) —
    // confirmed via its own documented API, not assumed.
    const values = row.values.slice(1);
    if (rowNumber === 1) {
      headerKeys = values.map((v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "_"));
      return;
    }
    const rowObj = {};
    headerKeys.forEach((key, i) => {
      const raw = values[i];
      rowObj[key] = raw === undefined || raw === null ? "" : String(raw).trim();
    });
    rows.push(rowObj);
  });
  return rows;
}

function cleanupStagedFile(file) {
  if (!file) return;
  fs.unlink(file.path, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error(`[leadRoutes] Failed to clean up staged upload ${file.path}:`, err.message);
    }
  });
}

/*
==================================================
LEADS — template + upload
==================================================
GET /api/admin/leads/template?format=xlsx|csv
==================================================
*/
router.get("/leads/template", requireAdmin, async (req, res) => {
  const { format } = req.query;
  await sendTemplate(
    res,
    "cmx-dialer-leads-template",
    ["phone_number", "first_name", "last_name"],
    ["6468016974", "Jane", "Doe"],
    format
  );
});

/*
==================================================
POST /api/admin/leads/upload
Body (multipart): file, campaignId
==================================================
Creates a NEW asterisk.vicidial_lists row for this upload (its own
list_id, name stamped with the campaign + a timestamp so multiple
uploads to the same campaign stay distinguishable), then bulk-inserts
every valid row into asterisk.vicidial_list with status='NEW' — the
same "new, never-called lead" status stock ViciDial itself uses, so
this plays correctly with the campaign's own dial_method/hopper
mechanics if those are ever engaged later, not just this app's own
getNextLead() fallback path.

list_id is generated here as Date.now() (milliseconds since epoch) —
confirmed via DESCRIBE that asterisk.vicidial_lists.list_id has NO
auto_increment at all on this install (it's a plain bigint PK ViciDial's
own admin UI normally assigns by hand), so this app has to pick a
value itself. A millisecond timestamp is unique enough at the rate
admins upload lead lists in practice; a genuine collision (two uploads
in the exact same millisecond) is caught below and surfaced as a clear
"try again" error rather than a cryptic constraint failure.

Rows missing a phone_number are skipped (not fatal to the whole
upload) and counted separately in the response — a single blank row in
an otherwise-good spreadsheet shouldn't block the other 500 valid
leads from importing.
==================================================
*/
router.post("/leads/upload", requireAdmin, upload.single("file"), async (req, res) => {
  const { campaignId } = req.body;
  const file = req.file;

  if (!campaignId) {
    cleanupStagedFile(file);
    return res.status(400).json({ success: false, message: "campaignId is required." });
  }
  if (!file) {
    return res.status(400).json({ success: false, message: "A CSV or XLSX file is required." });
  }

  try {
    const rows = await parseUploadedRows(file);
    const validRows = rows.filter((r) => r.phone_number);
    const skippedCount = rows.length - validRows.length;

    if (validRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows found — every row is missing a phone_number.",
      });
    }

    const listId = Date.now();
    const listName = `Upload_${campaignId}_${listId}`;

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      await connection.execute(
        `INSERT INTO asterisk.vicidial_lists (list_id, list_name, campaign_id, active) VALUES (?, ?, ?, 'Y')`,
        [listId, listName, campaignId]
      );

      // Single multi-row INSERT rather than one query per row — real
      // performance difference on a lead list with hundreds/thousands
      // of rows, not just a style choice.
      const valuePlaceholders = validRows.map(() => "(?, 'NEW', ?, ?, ?, 'N', NOW())").join(", ");
      const insertParams = [];
      for (const row of validRows) {
        insertParams.push(listId, row.phone_number, row.first_name || null, row.last_name || null);
      }
      await connection.execute(
        `
          INSERT INTO asterisk.vicidial_list
            (list_id, status, phone_number, first_name, last_name, called_since_last_reset, entry_date)
          VALUES ${valuePlaceholders}
        `,
        insertParams
      );

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          success: false,
          message: "A list with this exact upload timestamp already exists — please try uploading again.",
        });
      }
      throw err;
    } finally {
      connection.release();
    }

    return res.json({
      success: true,
      listId,
      listName,
      imported: validRows.length,
      skipped: skippedCount,
    });
  } catch (error) {
    console.error("POST /api/admin/leads/upload failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to upload leads." });
  } finally {
    cleanupStagedFile(file);
  }
});

/*
==================================================
DNC — template + upload + list
==================================================
asterisk.vicidial_dnc has exactly ONE column, phone_number, as its own
sole primary key (confirmed via DESCRIBE) — no campaign scoping, no
timestamp, no source tracking. Global and dead simple by design.
==================================================
*/
router.get("/dnc/template", requireAdmin, async (req, res) => {
  const { format } = req.query;
  await sendTemplate(res, "cmx-dialer-dnc-template", ["phone_number"], ["6468016974"], format);
});

router.get("/dnc", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT phone_number FROM asterisk.vicidial_dnc ORDER BY phone_number ASC LIMIT 5000`);
    return res.json({ success: true, entries: rows, count: rows.length });
  } catch (error) {
    console.error("GET /api/admin/dnc failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load DNC list." });
  }
});

router.post("/dnc/upload", requireAdmin, upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ success: false, message: "A CSV or XLSX file is required." });
  }

  try {
    const rows = await parseUploadedRows(file);
    const validRows = rows.filter((r) => r.phone_number);
    const skippedCount = rows.length - validRows.length;

    if (validRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows found — every row is missing a phone_number.",
      });
    }

    // INSERT IGNORE — phone_number is the table's own PK, so a number
    // already on the list is a harmless no-op, not an error, exactly
    // like the automatic DNC-on-disposition insert in
    // dialerService.js's saveDisposition().
    const valuePlaceholders = validRows.map(() => "(?)").join(", ");
    const params = validRows.map((r) => r.phone_number);
    const [result] = await db.execute(
      `INSERT IGNORE INTO asterisk.vicidial_dnc (phone_number) VALUES ${valuePlaceholders}`,
      params
    );

    return res.json({
      success: true,
      imported: result.affectedRows,
      duplicates: validRows.length - result.affectedRows,
      skipped: skippedCount,
    });
  } catch (error) {
    console.error("POST /api/admin/dnc/upload failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to upload DNC list." });
  } finally {
    cleanupStagedFile(file);
  }
});

/*
==================================================
AUTODIAL RULES — per campaign
==================================================
GET returns the stored rules, or the SQL table's own defaults if this
campaign has never had rules saved yet (rather than a 404 — every
outbound campaign implicitly HAS default rules, they just haven't been
customized). PUT upserts.
==================================================
*/
const AUTODIAL_RULE_DEFAULTS = {
  maxAttemptsBusy: 3,
  maxAttemptsNoAnswer: 3,
  maxAttemptsMachine: 3,
  attemptIntervalMinutes: 60,
  callingDays: "mon-fri",
  callingStartTime: "09:00",
  callingEndTime: "18:00",
};

router.get("/campaigns/:campaignId/autodial-rules", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const [rows] = await db.execute(
      `SELECT max_attempts_busy, max_attempts_no_answer, max_attempts_machine,
              attempt_interval_minutes, calling_days, calling_start_time, calling_end_time
       FROM cmx_dialer.campaign_autodial_rules WHERE campaign_id = ?`,
      [campaignId]
    );

    if (rows.length === 0) {
      return res.json({ success: true, rules: AUTODIAL_RULE_DEFAULTS, isDefault: true });
    }

    const r = rows[0];
    return res.json({
      success: true,
      rules: {
        maxAttemptsBusy: r.max_attempts_busy,
        maxAttemptsNoAnswer: r.max_attempts_no_answer,
        maxAttemptsMachine: r.max_attempts_machine,
        attemptIntervalMinutes: r.attempt_interval_minutes,
        callingDays: r.calling_days,
        callingStartTime: r.calling_start_time,
        callingEndTime: r.calling_end_time,
      },
      isDefault: false,
    });
  } catch (error) {
    console.error(`GET /api/admin/campaigns/${req.params.campaignId}/autodial-rules failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to load autodial rules." });
  }
});

router.put("/campaigns/:campaignId/autodial-rules", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const {
      maxAttemptsBusy,
      maxAttemptsNoAnswer,
      maxAttemptsMachine,
      attemptIntervalMinutes,
      callingDays,
      callingStartTime,
      callingEndTime,
    } = req.body;

    await db.execute(
      `
        INSERT INTO cmx_dialer.campaign_autodial_rules
          (campaign_id, max_attempts_busy, max_attempts_no_answer, max_attempts_machine,
           attempt_interval_minutes, calling_days, calling_start_time, calling_end_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          max_attempts_busy = VALUES(max_attempts_busy),
          max_attempts_no_answer = VALUES(max_attempts_no_answer),
          max_attempts_machine = VALUES(max_attempts_machine),
          attempt_interval_minutes = VALUES(attempt_interval_minutes),
          calling_days = VALUES(calling_days),
          calling_start_time = VALUES(calling_start_time),
          calling_end_time = VALUES(calling_end_time)
      `,
      [
        campaignId,
        maxAttemptsBusy ?? AUTODIAL_RULE_DEFAULTS.maxAttemptsBusy,
        maxAttemptsNoAnswer ?? AUTODIAL_RULE_DEFAULTS.maxAttemptsNoAnswer,
        maxAttemptsMachine ?? AUTODIAL_RULE_DEFAULTS.maxAttemptsMachine,
        attemptIntervalMinutes ?? AUTODIAL_RULE_DEFAULTS.attemptIntervalMinutes,
        callingDays || AUTODIAL_RULE_DEFAULTS.callingDays,
        callingStartTime || AUTODIAL_RULE_DEFAULTS.callingStartTime,
        callingEndTime || AUTODIAL_RULE_DEFAULTS.callingEndTime,
      ]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error(`PUT /api/admin/campaigns/${req.params.campaignId}/autodial-rules failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to save autodial rules." });
  }
});

module.exports = router;