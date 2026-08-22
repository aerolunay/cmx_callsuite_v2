/*
==================================================
OUTBOUND DISPOSITIONS
==================================================
*/
export const DISPOSITIONS = [
  { value: "CALL_ENDED", label: "Call Ended" },
  { value: "CX_HUNG_UP", label: "CX Hung Up" },
  { value: "NO_ANSWER", label: "No Answer" },
  { value: "VOICEMAIL", label: "Voicemail" },
  { value: "WRONG_NUMBER", label: "Wrong Number" },
  { value: "NOT_INTERESTED", label: "Not Interested" },
  { value: "DO_NOT_CALL", label: "Do Not Call (DNC)" },
  { value: "CALLBACK", label: "Callback Requested" },
];

const LABEL_BY_VALUE = Object.fromEntries(DISPOSITIONS.map((d) => [d.value, d.label]));

export function dispositionLabel(value) {
  return LABEL_BY_VALUE[value] || value;
}

/*
==================================================
INBOUND DISPOSITIONS
==================================================
Proposed set for inbound calls — NOT confirmed with anyone at CMX,
just a reasonable starting point (distinct from outbound's list above,
since things like "No Answer"/"Voicemail" don't apply to a call that's
already been answered).
==================================================
*/
export const INBOUND_DISPOSITIONS = [
  { value: "RESOLVED", label: "Resolved" },
  { value: "INFO_PROVIDED", label: "Information Provided" },
  { value: "TRANSFERRED", label: "Transferred" },
  { value: "CALLBACK_REQUESTED", label: "Callback Requested" },
  { value: "SALES_INQUIRY", label: "Sales Inquiry / New Lead" },
  { value: "COMPLAINT", label: "Complaint Logged" },
  { value: "WRONG_NUMBER", label: "Wrong Number / Misdial" },
  { value: "CALLER_HUNG_UP", label: "Caller Hung Up" },
  { value: "CALL_DISCONNECTED", label: "Call Disconnected" },
  { value: "GHOST_CALL", label: "Ghost Call" },
];

/*
==================================================
BSMSC_INBOUND_DISPOSITIONS
==================================================
BSMSC-specific override, per explicit request — this campaign shows
ONLY these 6 options, not the generic INBOUND_DISPOSITIONS list above.
"Callback Scheduled" deliberately reuses the value CALLBACK_REQUESTED
(not a new value) — DialerPage.jsx's existing check (inboundDisposition
=== "CALLBACK_REQUESTED") that shows the callback-datetime picker keeps
working automatically, no changes needed there at all. Same reasoning
for reusing CALLER_HUNG_UP and INFO_PROVIDED from the generic list —
keeps the same underlying value consistent across campaigns for
anywhere disposition values get aggregated/reported on later, even
though the two campaigns show different label sets.
==================================================
*/
export const BSMSC_INBOUND_DISPOSITIONS = [
  { value: "SCREENING_COMPLETED", label: "Screening Completed" },
  { value: "UNABLE_TO_COMPLETE_SCREENING", label: "Unable to Complete Screening" },
  { value: "CALLER_HUNG_UP", label: "Caller Hung Up" },
  { value: "CALLBACK_REQUESTED", label: "Callback Scheduled" },
  { value: "INFO_PROVIDED", label: "Information Provided" },
  { value: "MISROUTED_CALL", label: "Misrouted Call" },
  { value: "GHOST_CALL", label: "Ghost Call" },
];

/*
==================================================
getInboundDispositionsForCampaign
==================================================
Single place this campaign-scoping decision lives — DialerPage.jsx
calls this instead of referencing INBOUND_DISPOSITIONS directly, so
adding a second campaign-specific override later means touching only
this one function, not hunting through the page's JSX.
==================================================
*/
export function getInboundDispositionsForCampaign(campaignId) {
  if (campaignId === "CMXBSMSC") return BSMSC_INBOUND_DISPOSITIONS;
  return INBOUND_DISPOSITIONS;
}

// Merges BOTH inbound lists — a stored disposition value in the
// database could have come from either campaign's list, so any
// lookup-by-value (e.g. displaying past dispositions in a Call Logs
// table) needs to resolve correctly regardless of which list it was
// originally selected from.
const INBOUND_LABEL_BY_VALUE = Object.fromEntries(
  [...INBOUND_DISPOSITIONS, ...BSMSC_INBOUND_DISPOSITIONS].map((d) => [d.value, d.label])
);

export function inboundDispositionLabel(value) {
  return INBOUND_LABEL_BY_VALUE[value] || value;
}