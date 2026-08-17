// Proposed set for inbound calls — NOT confirmed with anyone at CMX,
// just a reasonable starting point (distinct from outbound's list,
// since things like "No Answer"/"Voicemail" don't apply to a call
// that's already been answered).
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

const INBOUND_LABEL_BY_VALUE = Object.fromEntries(INBOUND_DISPOSITIONS.map((d) => [d.value, d.label]));

export function inboundDispositionLabel(value) {
  return INBOUND_LABEL_BY_VALUE[value] || value;
}