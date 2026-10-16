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

const TERMINAL_LEAD_STATUSES = "('DNC', 'NI', 'DC', 'PU', 'CALLBK', 'SCRN', 'NOTELG')";

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
// Per explicit request — an inbound call from the number with any of these
// outcomes also means the person was reached, so their outbound lead isn't
// redialed (a scheduled callback is handled by its own mechanism). Caller
// Hung Up / Ghost Call / Misrouted Call still allow a redial.
const INBOUND_CLOSED_OUT_DISPOSITIONS =
  "('SCREENING_COMPLETED', 'CALL_ENDED', 'NOT_INTERESTED', 'DO_NOT_CALL', " +
  "'INFO_PROVIDED', 'CALLBACK_REQUESTED', 'XFER_CONF', 'TRANSFERRED', 'UNABLE_TO_COMPLETE_SCREENING', " +
  "'VOICEMAIL_CARRIER_FILTER', 'FOR_FOLLOW_UP_CALL', 'ELIGIBILITY_ASSESSMENT_COMPLETED', 'CONTRACTED_SERVICE_COMPLETED')";

// Appended to a WHERE clause whose lead row is aliased `l`. The rules have
// to hold for the PHONE NUMBER, not just the lead row: the same number can
// sit on several lead rows (a re-upload with "Include duplicates", or
// another list/campaign). So besides this row's own status/reset flag:
//   - skip it when any other row with the same number reached someone
//     (status outside NOT_REACHED_LEAD_STATUSES) — reached once, never
//     called again, re-upload or not;
//   - skip it when a NEWER row with the same number sits on an active
//     list — per explicit request, re-uploading not-reached numbers means
//     "call these again", so the newest copy is the one that gets dialed
//     (with its own fresh attempt counters) and the older copies retire.
//     One copy per number, so a number is never dialed twice per cycle.
// NUMBER_BLOCKS_SQL is the phone-number part alone (shared with the Leads
// dashboard's "Remaining for Redial", which looks at already-dialed rows).
const NUMBER_BLOCKS_SQL = `
        AND NOT EXISTS (SELECT 1 FROM vicidial_dnc d WHERE d.phone_number = l.phone_number)
        AND NOT EXISTS (
          SELECT 1 FROM vicidial_list o
          JOIN vicidial_lists ol ON ol.list_id = o.list_id
          WHERE o.phone_number = l.phone_number AND o.lead_id <> l.lead_id
            AND (o.status NOT IN ${NOT_REACHED_LEAD_STATUSES} OR (o.lead_id > l.lead_id AND ol.active = 'Y'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.dialer_call_log c
          WHERE c.phone_number = ${LEAD_PHONE} AND c.disposition IN ${CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.inbound_call_log i
          WHERE i.caller_id_number = ${LEAD_PHONE_1} AND i.disposition IN ${INBOUND_CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.inbound_call_log i
          WHERE i.caller_id_number = ${LEAD_PHONE} AND i.disposition IN ${INBOUND_CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.inbound_call_log i
          WHERE i.caller_id_number = ${LEAD_PHONE_PLUS1} AND i.disposition IN ${INBOUND_CLOSED_OUT_DISPOSITIONS}
        )`;

const LEAD_ELIGIBILITY_SQL = `
        AND l.called_since_last_reset = 'N'
        AND l.status NOT IN ${TERMINAL_LEAD_STATUSES}${NUMBER_BLOCKS_SQL}`;

// Statuses the dialer's retry cycle reopens for another attempt
// (dialerService.js's startRetryCycle) — No Answer (NA automatic / N
// agent-picked), Answering Machine / Voicemail (AM automatic / A
// agent-picked) and Busy. Per explicit request a lead only leaves the
// redial pool once its number reaches the campaign's daily call limit.
const RETRYABLE_LEAD_STATUSES = "('NA', 'N', 'AM', 'A', 'B')";

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
        l.status IN ${RETRYABLE_LEAD_STATUSES}${NUMBER_BLOCKS_SQL}
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
// Do Not Call, Call Ended or Screening Completed (outbound or inbound).
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
  return closedOut;
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
  CALLS_TO_NUMBER_TODAY_SQL,
  DEFAULT_MAX_CALLS_PER_NUMBER_PER_DAY,
  LEAD_ELIGIBILITY_SQL,
  REDIAL_PENDING_SQL,
  findClosedOutPhoneNumbers,
  findRedialPendingPhoneNumbers,
};
