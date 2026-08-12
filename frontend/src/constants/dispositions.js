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
