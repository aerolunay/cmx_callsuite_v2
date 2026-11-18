"use strict";

const db = require("../config/db");

/*
==================================================
LEAD ELIGIBILITY — shared rules for "can this lead still be dialed?"
==================================================
Used by dialerService.js (getNextLead), statsService.js (Leads Calling
Dashboard's Remaining Leads) and leadRoutes.js (lead upload), so the
dialer, the dashboard and the upload all agree on which leads are still
callable. Lives in its own module because dialerService already requires
statsService — sharing these through either one would be circular.
==================================================
*/

// Vicidial statuses that mean "never dial this lead again" — every
// terminal disposition in dialerService.js's DISPOSITION_TO_VICIDIAL_STATUS.
// REAL PERFORMANCE FIX — asterisk.vicidial_list.phone_number is utf8mb3
// but the cmx_dialer call logs' phone columns are latin1. Comparing them
// directly made MySQL convert the CALL LOG column on every row, so the
// phone-number indexes (sql/009) were never used and every per-lead check
// scanned the whole log — the Leads dashboard took 10-40s, and getNextLead
// paid the same price. Converting the lead's own number to latin1 instead
// keeps the comparison on the indexed column. Phone numbers are digits
// only, so nothing is lost in the conversion. Use LEAD_PHONE wherever a
// lead's number is compared with dialer_call_log / inbound_call_log —
// and one plain `=` per stored format (bare 10 digits, "1" + 10, "+1" +
// 10): MariaDB won't use the index for an IN (...) list of expressions.
const LEAD_PHONE = "CONVERT(l.phone_number USING latin1)";
const LEAD_PHONE_1 = `CONCAT('1', ${LEAD_PHONE})`;
const LEAD_PHONE_PLUS1 = `CONCAT('+1', ${LEAD_PHONE})`;

// CALLBK (Callback) isn't listed: per explicit request a callback lead is
// decided by its number's most recent call record — see
// CALLBACK_LEAD_REOPENED_SQL.
const TERMINAL_LEAD_STATUSES = "('DNC', 'NI', 'DC', 'PU', 'SCRN', 'NOTELG')";

// Per explicit request — a number is only ever called again when nobody
// was reached on it: never dialed yet (NEW), No Answer (NA auto / N
// manual), Busy (B), Answering Machine (AM auto) or Voicemail (A manual).
// Any other status means a person picked up.
const NOT_REACHED_LEAD_STATUSES = "('NEW', 'NA', 'N', 'B', 'AM', 'A')";

// Per explicit request — a number ever disposed as one of these is never
// dialed again, however it got that disposition. Checked against the call
// logs too, not just vicidial_list.status, because a callback or manual
// dial (lead_id 0) and an inbound call never update any lead row — so a
// number screened that way still looked fresh on its own lead.
// Indexed by sql/009_add_call_log_phone_indexes.sql. Re-uploads of these
// numbers are dropped at upload time — see findClosedOutPhoneNumbers.
// Per explicit request the campaign-specific CMXBSMOB codes below close a
// number the same way: Voicemail (Carrier Filter) is treated as closed, and
// For Follow Up Call / Eligibility Assessment Completed / Contracted
// Service Completed as resolved.
const CLOSED_OUT_DISPOSITIONS_LIST = [
  "SCREENING_COMPLETED",
  "CALL_ENDED",
  "NOT_INTERESTED",
  "DO_NOT_CALL",
  "VOICEMAIL_CARRIER_FILTER",
  "FOR_FOLLOW_UP_CALL",
  "ELIGIBILITY_ASSESSMENT_COMPLETED",
  "CONTRACTED_SERVICE_COMPLETED",
];
const CLOSED_OUT_DISPOSITIONS = `(${CLOSED_OUT_DISPOSITIONS_LIST.map((d) => `'${d}'`).join(", ")})`;

// Per explicit request — a number whose MOST RECENT call record (outbound
// or inbound, any lead row, any campaign) is a scheduled callback is
// removed from auto-dialing and from re-uploads; the callback itself is
// worked from the Scheduled Callbacks list (dialerRoutes.js). An older
// callback followed by any later call to/from the number doesn't count.
// Matches the built-in codes — outbound CALLBACK, inbound
// CALLBACK_REQUESTED (labelled "Callback Scheduled" on CMXBSMSC) — and any
// custom code that says "scheduled callback" / "callback scheduled" (e.g.
// SCHEDULED_CALLBACK, CALLBACK_SCHEDULED, SCHEDULED_CALL_BACK).
const CALLBACK_SCHEDULED_DISPOSITIONS_LIST = ["CALLBACK", "CALLBACK_REQUESTED"];
function callbackScheduledSql(col) {
  return (
    `(${col} IN (${CALLBACK_SCHEDULED_DISPOSITIONS_LIST.map((d) => `'${d}'`).join(", ")})` +
    ` OR (${col} LIKE '%SCHEDULE%' AND (${col} LIKE '%CALLBACK%' OR ${col} LIKE '%CALL\\_BACK%')))`
  );
}
function isCallbackScheduled(disposition) {
  const d = String(disposition || "").toUpperCase();
  return CALLBACK_SCHEDULED_DISPOSITIONS_LIST.includes(d) || (d.includes("SCHEDULE") && /CALL_?BACK/.test(d));
}

// Every way a lead's number is stored in the call logs — one plain `=`
// each so the phone indexes are used (see LEAD_PHONE).
const NUMBER_LOG_SOURCES = [
  ["cmx_dialer.dialer_call_log", "phone_number", LEAD_PHONE],
  ["cmx_dialer.dialer_call_log", "phone_number", LEAD_PHONE_1],
  ["cmx_dialer.inbound_call_log", "caller_id_number", LEAD_PHONE],
  ["cmx_dialer.inbound_call_log", "caller_id_number", LEAD_PHONE_1],
  ["cmx_dialer.inbound_call_log", "caller_id_number", LEAD_PHONE_PLUS1],
];

// SQL that's true when the number's MOST RECENT call record (across every
// source above) matches: some matching record exists with no call to/from
// the number after it. outboundPred / inboundPred take a disposition
// column and return a condition. `tag` keeps aliases distinct.
function latestRecordMatchesSql(tag, outboundPred, inboundPred) {
  return (
    "(" +
    NUMBER_LOG_SOURCES.map(([table, col, num], j) => {
      const pred = table.endsWith("inbound_call_log") ? inboundPred : outboundPred;
      const cur = `${tag}${j}`;
      const noLaterRecord = NUMBER_LOG_SOURCES.map(
        ([t, c, n], k) =>
          `NOT EXISTS (SELECT 1 FROM ${t} ${cur}_${k} WHERE ${cur}_${k}.${c} = ${n} AND ${cur}_${k}.call_started_at > ${cur}.call_started_at)`
      ).join("\n              AND ");
      return `EXISTS (
          SELECT 1 FROM ${table} ${cur}
          WHERE ${cur}.${col} = ${num} AND ${pred(`${cur}.disposition`)}
              AND ${noLaterRecord}
        )`;
    }).join("\n        OR ") +
    ")"
  );
}

const LATEST_IS_CALLBACK_SQL = latestRecordMatchesSql("lcb", callbackScheduledSql, callbackScheduledSql);

// Outcomes where nobody was reached — the same not-reached outcomes the
// Scheduled Callbacks list uses (dialerRoutes.js), plus custom codes that
// say voicemail / machine / no answer / busy (the same words dialerService
// infers a not-reached lead status from). Inbound: only the ones with no
// conversation — Caller Hung Up, Ghost Call, Misrouted Call, Call
// Disconnected.
function outboundNotReachedSql(col) {
  return (
    `(${col} IN ('NO_ANSWER', 'BUSY', 'MACHINE', 'VOICEMAIL', 'VOICEMAIL_STANDARD')` +
    ` OR ${col} LIKE '%VOICEMAIL%' OR ${col} LIKE '%VOICE\\_MAIL%' OR ${col} LIKE '%MACHINE%'` +
    ` OR ${col} LIKE '%NO\\_ANSWER%' OR ${col} LIKE '%NOANSWER%' OR ${col} LIKE '%BUSY%')`
  );
}
function inboundNotReachedSql(col) {
  return `${col} IN ('CALLER_HUNG_UP', 'GHOST_CALL', 'MISROUTED_CALL', 'CALL_DISCONNECTED')`;
}

// Per explicit request — "most recent record" decides a Callback lead
// (status CALLBK): it goes back to being an ordinary not-reached lead
// (eligible, redialed by the retry cycle, doesn't block other copies of
// the number) only when the number's latest call record is a not-reached
// outcome — e.g. the callback was dialed and nobody answered. While the
// latest record is still the callback, or a person was reached, it stays
// out. Reads only the call logs, so it also works inside startRetryCycle's
// UPDATE of vicidial_list. Expects the lead row aliased `l`.
const CALLBACK_LEAD_REOPENED_SQL = latestRecordMatchesSql("lnr", outboundNotReachedSql, inboundNotReachedSql);

// Per explicit request — an inbound call from the number with any of these
// outcomes also means the person was reached, so their outbound lead isn't
// redialed (a scheduled callback is handled by its own mechanism). Caller
// Hung Up / Ghost Call / Misrouted Call still allow a redial. Also used by
// statsService.js to count inbound contacts.
const INBOUND_CLOSED_OUT_DISPOSITIONS =
  "('SCREENING_COMPLETED', 'CALL_ENDED', 'NOT_INTERESTED', 'DO_NOT_CALL', " +
  "'INFO_PROVIDED', 'CALLBACK_REQUESTED', 'XFER_CONF', 'TRANSFERRED', 'UNABLE_TO_COMPLETE_SCREENING', " +
  "'VOICEMAIL_CARRIER_FILTER', 'FOR_FOLLOW_UP_CALL', 'ELIGIBILITY_ASSESSMENT_COMPLETED', 'CONTRACTED_SERVICE_COMPLETED')";
// Same list for lead eligibility, minus CALLBACK_REQUESTED: per explicit
// request an inbound callback only blocks the number while it's the most
// recent record (LATEST_IS_CALLBACK_SQL).
const INBOUND_ELIGIBILITY_CLOSED_OUT_DISPOSITIONS = INBOUND_CLOSED_OUT_DISPOSITIONS.replace("'CALLBACK_REQUESTED', ", "");

// Appended to a WHERE clause whose lead row is aliased `l`. The rules have
// to hold for the PHONE NUMBER, not just the lead row: the same number can
// sit on several lead rows (a re-upload with "Include duplicates", or
// another list/campaign). So besides this row's own status/reset flag:
//   - skip it when any other row with the same number reached someone
//     (status outside NOT_REACHED_LEAD_STATUSES) — reached once, never
//     called again, re-upload or not. A Callback (CALLBK) row only counts
//     while CALLBACK_LEAD_REOPENED_SQL is false;
//   - skip it when a NEWER row with the same number sits on an active
//     list — per explicit request, re-uploading not-reached numbers means
//     "call these again", so the newest copy is the one that gets dialed
//     (with its own fresh attempt counters) and the older copies retire.
//     One copy per number, so a number is never dialed twice per cycle.
//   - skip it when the number's most recent call record is a scheduled
//     callback (LATEST_IS_CALLBACK_SQL).
// NUMBER_BLOCKS_SQL is the phone-number part alone (shared with the Leads
// dashboard's "Remaining for Redial", which looks at already-dialed rows).
const NUMBER_BLOCKS_SQL = `
        AND NOT EXISTS (SELECT 1 FROM vicidial_dnc d WHERE d.phone_number = l.phone_number)
        AND NOT EXISTS (
          SELECT 1 FROM vicidial_list o
          JOIN vicidial_lists ol ON ol.list_id = o.list_id
          WHERE o.phone_number = l.phone_number AND o.lead_id <> l.lead_id
            AND (
              (o.status NOT IN ${NOT_REACHED_LEAD_STATUSES} AND o.status <> 'CALLBK')
              OR (o.lead_id > l.lead_id AND ol.active = 'Y')
            )
        )
        AND NOT (
          EXISTS (
            SELECT 1 FROM vicidial_list ocb
            WHERE ocb.phone_number = l.phone_number AND ocb.lead_id <> l.lead_id AND ocb.status = 'CALLBK'
          )
          AND NOT ${CALLBACK_LEAD_REOPENED_SQL}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.dialer_call_log c
          WHERE c.phone_number = ${LEAD_PHONE} AND c.disposition IN ${CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.inbound_call_log i
          WHERE i.caller_id_number = ${LEAD_PHONE_1} AND i.disposition IN ${INBOUND_ELIGIBILITY_CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.inbound_call_log i
          WHERE i.caller_id_number = ${LEAD_PHONE} AND i.disposition IN ${INBOUND_ELIGIBILITY_CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.inbound_call_log i
          WHERE i.caller_id_number = ${LEAD_PHONE_PLUS1} AND i.disposition IN ${INBOUND_ELIGIBILITY_CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT ${LATEST_IS_CALLBACK_SQL}`;

// REAL BUG FIX — only numbers the outbound dialplan can route
// (_NXXNXXXXXX / _1NXXNXXXXXX: area code and exchange start with 2-9).
// An undialable lead fails in Asterisk before it's ever marked dialed, so
// without this it stayed first in line and every agent got it on a loop.
// Same rule as dialerService.js's isDialablePhoneNumber.
const DIALABLE_LEAD_PHONE_SQL = "l.phone_number REGEXP '^1{0,1}[2-9][0-9]{2}[2-9][0-9]{6}$'";

const LEAD_ELIGIBILITY_SQL = `
        AND ${DIALABLE_LEAD_PHONE_SQL}
        AND l.called_since_last_reset = 'N'
        AND l.status NOT IN ${TERMINAL_LEAD_STATUSES}
        AND (l.status <> 'CALLBK' OR ${CALLBACK_LEAD_REOPENED_SQL})${NUMBER_BLOCKS_SQL}`;

// Statuses the dialer's retry cycle reopens for another attempt
// (dialerService.js's startRetryCycle) — No Answer (NA automatic / N
// agent-picked), Answering Machine / Voicemail (AM automatic / A
// agent-picked) and Busy. Per explicit request a lead only leaves the
// redial pool once its number reaches the campaign's daily call limit.
const RETRYABLE_LEAD_STATUSES = "('NA', 'N', 'AM', 'A', 'B')";
// The retry pool's status test: a retryable status, or a Callback lead
// whose number's latest record shows nobody was reached
// (CALLBACK_LEAD_REOPENED_SQL). Expects the lead row aliased `l`.
const RETRYABLE_LEAD_SQL = `(l.status IN ${RETRYABLE_LEAD_STATUSES} OR (l.status = 'CALLBK' AND ${CALLBACK_LEAD_REOPENED_SQL}))`;

// Per explicit request — ONE daily limit per phone number: every outbound
// call to the number today counts (any campaign, any outcome, callbacks
// and manual dials included), compared on the bare 10 digits or "1" + 10.
// Expects the lead row aliased `l` and TWO `?`s, both the start of today
// (Eastern — statsService.getEasternDayBoundsForServerClock) — one per
// stored number format, see LEAD_PHONE. The limit
// itself is campaign_autodial_rules.max_attempts_no_answer: the rules
// screen saves the single "Max calls per number per day" setting into all
// three of the old per-outcome columns, so no schema change was needed.
const CALLS_TO_NUMBER_TODAY_SQL = `(
          (SELECT COUNT(*) FROM cmx_dialer.dialer_call_log dc WHERE dc.phone_number = ${LEAD_PHONE} AND dc.call_started_at >= ?)
          + (SELECT COUNT(*) FROM cmx_dialer.dialer_call_log dc WHERE dc.phone_number = ${LEAD_PHONE_1} AND dc.call_started_at >= ?)
        )`;
const DEFAULT_MAX_CALLS_PER_NUMBER_PER_DAY = 3;

// A lead still due a redial: a retryable outcome, the number not blocked,
// and calls to the number today still under the campaign's daily limit
// (Admin -> Leads/Auto-Dial). Expects the lead row aliased `l`,
// cmx_dialer.campaign_autodial_rules LEFT JOINed as `r`, and TWO `?`s,
// both the start of today (see CALLS_TO_NUMBER_TODAY_SQL).
const REDIAL_PENDING_SQL = `
        ${RETRYABLE_LEAD_SQL}${NUMBER_BLOCKS_SQL}
        AND ${CALLS_TO_NUMBER_TODAY_SQL} < COALESCE(r.max_attempts_no_answer, ${DEFAULT_MAX_CALLS_PER_NUMBER_PER_DAY})`;

// Start of today (Eastern), for the `?` in REDIAL_PENDING_SQL /
// CALLS_TO_NUMBER_TODAY_SQL. Required lazily: statsService itself
// requires this module.
async function startOfTodayForServerClock() {
  const { start } = await require("./statsService").getEasternDayBoundsForServerClock();
  return start;
}

// Per explicit request — which of these bare 10-digit numbers must never
// be uploaded again: on the DNC list, or ever disposed Not Interested,
// Do Not Call, Call Ended or Screening Completed (outbound or inbound),
// or whose most recent call record is a scheduled callback (see
// findLatestCallbackPhoneNumbers).
// Logged numbers can be 10 digits, "1" + 10 or "+1" + 10 (inbound caller
// IDs especially), so they're compared on their last 10 digits.
async function findClosedOutPhoneNumbers(phoneNumbers) {
  if (phoneNumbers.length === 0) return new Set();
  const placeholders = phoneNumbers.map(() => "?").join(",");
  const dispositionPlaceholders = CLOSED_OUT_DISPOSITIONS_LIST.map(() => "?").join(",");

  const [dncRows] = await db.execute(
    `SELECT phone_number FROM asterisk.vicidial_dnc WHERE phone_number IN (${placeholders})`,
    phoneNumbers
  );
  const [loggedRows] = await db.execute(
    `
      SELECT DISTINCT RIGHT(phone_number, 10) AS phone_number
      FROM cmx_dialer.dialer_call_log WHERE disposition IN (${dispositionPlaceholders})
      UNION
      SELECT DISTINCT RIGHT(caller_id_number, 10) AS phone_number
      FROM cmx_dialer.inbound_call_log WHERE disposition IN (${dispositionPlaceholders})
    `,
    [...CLOSED_OUT_DISPOSITIONS_LIST, ...CLOSED_OUT_DISPOSITIONS_LIST]
  );

  const wanted = new Set(phoneNumbers);
  const closedOut = new Set(dncRows.map((r) => r.phone_number));
  for (const row of loggedRows) {
    if (wanted.has(row.phone_number)) closedOut.add(row.phone_number);
  }
  for (const phone of await findLatestCallbackPhoneNumbers(phoneNumbers)) closedOut.add(phone);
  return closedOut;
}

// Per explicit request — which of these bare 10-digit numbers have a
// scheduled callback as their MOST RECENT call record, outbound or inbound
// (same rule as LATEST_IS_CALLBACK_BLOCK_SQL). Looks up only these numbers,
// in every stored format, so the phone indexes are used; chunked to keep
// the IN lists reasonable on large uploads.
async function findLatestCallbackPhoneNumbers(phoneNumbers) {
  const latest = new Map(); // 10 digits -> { at, disposition }
  const CHUNK = 1000;
  for (let i = 0; i < phoneNumbers.length; i += CHUNK) {
    const chunk = phoneNumbers.slice(i, i + CHUNK);
    const forms = chunk.flatMap((p) => [p, `1${p}`, `+1${p}`]);
    const placeholders = forms.map(() => "?").join(",");
    const [rows] = await db.execute(
      `
        SELECT RIGHT(phone_number, 10) AS phone, call_started_at AS at, disposition
        FROM cmx_dialer.dialer_call_log WHERE phone_number IN (${placeholders})
        UNION ALL
        SELECT RIGHT(caller_id_number, 10), call_started_at, disposition
        FROM cmx_dialer.inbound_call_log WHERE caller_id_number IN (${placeholders})
      `,
      [...forms, ...forms]
    );
    for (const row of rows) {
      const prev = latest.get(row.phone);
      if (!prev || new Date(row.at) > new Date(prev.at)) latest.set(row.phone, row);
    }
  }
  const result = new Set();
  for (const [phone, row] of latest) {
    if (isCallbackScheduled(row.disposition)) result.add(phone);
  }
  return result;
}

// Per explicit request — which of these bare 10-digit numbers are already
// waiting for a redial (see REDIAL_PENDING_SQL). Uploading them again
// would only duplicate a call the dialer is going to make anyway, so the
// upload leaves them out.
async function findRedialPendingPhoneNumbers(phoneNumbers) {
  if (phoneNumbers.length === 0) return new Set();
  const todayStart = await startOfTodayForServerClock();
  const placeholders = phoneNumbers.map(() => "?").join(",");
  const [rows] = await db.execute(
    `
      SELECT DISTINCT l.phone_number
      FROM asterisk.vicidial_list l
      JOIN asterisk.vicidial_lists vlt ON vlt.list_id = l.list_id
      LEFT JOIN cmx_dialer.campaign_autodial_rules r ON r.campaign_id = vlt.campaign_id
      WHERE l.phone_number IN (${placeholders}) AND ${REDIAL_PENDING_SQL}
    `,
    [...phoneNumbers, todayStart, todayStart]
  );
  return new Set(rows.map((r) => r.phone_number));
}

module.exports = {
  LEAD_PHONE,
  TERMINAL_LEAD_STATUSES,
  NOT_REACHED_LEAD_STATUSES,
  CLOSED_OUT_DISPOSITIONS,
  INBOUND_CLOSED_OUT_DISPOSITIONS,
  RETRYABLE_LEAD_STATUSES,
  RETRYABLE_LEAD_SQL,
  CALLS_TO_NUMBER_TODAY_SQL,
  DEFAULT_MAX_CALLS_PER_NUMBER_PER_DAY,
  LEAD_ELIGIBILITY_SQL,
  REDIAL_PENDING_SQL,
  findClosedOutPhoneNumbers,
  findRedialPendingPhoneNumbers,
};
