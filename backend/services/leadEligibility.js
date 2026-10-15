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
const CLOSED_OUT_DISPOSITIONS_LIST = ["SCREENING_COMPLETED", "CALL_ENDED", "NOT_INTERESTED", "DO_NOT_CALL"];
const CLOSED_OUT_DISPOSITIONS = `(${CLOSED_OUT_DISPOSITIONS_LIST.map((d) => `'${d}'`).join(", ")})`;
// Per explicit request — an inbound call from the number with any of these
// outcomes also means the person was reached, so their outbound lead isn't
// redialed (a scheduled callback is handled by its own mechanism). Caller
// Hung Up / Ghost Call / Misrouted Call still allow a redial.
const INBOUND_CLOSED_OUT_DISPOSITIONS =
  "('SCREENING_COMPLETED', 'CALL_ENDED', 'NOT_INTERESTED', 'DO_NOT_CALL', " +
  "'INFO_PROVIDED', 'CALLBACK_REQUESTED', 'XFER_CONF', 'TRANSFERRED', 'UNABLE_TO_COMPLETE_SCREENING')";

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
const LEAD_ELIGIBILITY_SQL = `
        AND l.called_since_last_reset = 'N'
        AND l.status NOT IN ${TERMINAL_LEAD_STATUSES}
        AND NOT EXISTS (SELECT 1 FROM vicidial_dnc d WHERE d.phone_number = l.phone_number)
        AND NOT EXISTS (
          SELECT 1 FROM vicidial_list o
          JOIN vicidial_lists ol ON ol.list_id = o.list_id
          WHERE o.phone_number = l.phone_number AND o.lead_id <> l.lead_id
            AND (o.status NOT IN ${NOT_REACHED_LEAD_STATUSES} OR (o.lead_id > l.lead_id AND ol.active = 'Y'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.dialer_call_log c
          WHERE c.phone_number = l.phone_number AND c.disposition IN ${CLOSED_OUT_DISPOSITIONS}
        )
        AND NOT EXISTS (
          SELECT 1 FROM cmx_dialer.inbound_call_log i
          WHERE i.caller_id_number IN (l.phone_number, CONCAT('1', l.phone_number), CONCAT('+1', l.phone_number))
            AND i.disposition IN ${INBOUND_CLOSED_OUT_DISPOSITIONS}
        )`;

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

module.exports = {
  TERMINAL_LEAD_STATUSES,
  NOT_REACHED_LEAD_STATUSES,
  CLOSED_OUT_DISPOSITIONS,
  INBOUND_CLOSED_OUT_DISPOSITIONS,
  LEAD_ELIGIBILITY_SQL,
  findClosedOutPhoneNumbers,
};
