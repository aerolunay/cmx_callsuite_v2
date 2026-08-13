export function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return "—";

  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Always hh:mm:ss, hours zero-padded and never dropped — used where
// durations routinely run long (Live Status Dashboard) and a
// consistent fixed-width format reads better in a table than
// formatDuration's variable-width m:ss/h:mm:ss.
export function formatDurationHMS(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return "—";

  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/*
==================================================
DURATION_THRESHOLDS / durationColorFor
==================================================
Shared between LiveStatusDashboard.jsx (supervisor view) and
DialerPage.jsx (the agent's own status bar) — moved here so both apply
the EXACT same thresholds rather than two copies drifting apart over
time. Thresholds as specified, not guessed. Statuses not listed here
get no special coloring — just the page's normal text color.

Each entry is [orangeAtSeconds, redAtSeconds]. AFTER_CALL_WORK's red
threshold is strictly ">" 60s (not ">="), matching exactly how it was
specified — one second different from the others' ">=", not a
copy-paste slip.
==================================================
*/
export const DURATION_THRESHOLDS = {
  IN_CALL: { orangeAt: 5 * 60, redAt: 8 * 60, redInclusive: true },
  ON_HOLD: { orangeAt: 90, redAt: 120, redInclusive: true },
  AFTER_CALL_WORK: { orangeAt: 20, redAt: 60, redInclusive: false },
  AUX_CB: { orangeAt: 5 * 60, redAt: 8 * 60, redInclusive: true },
};

export function durationColorFor(statusKey, seconds) {
  const t = DURATION_THRESHOLDS[statusKey];
  if (!t || seconds === null || seconds === undefined) return undefined;

  const isRed = t.redInclusive ? seconds >= t.redAt : seconds > t.redAt;
  if (isRed) return "var(--cmx-danger)";
  if (seconds >= t.orangeAt) return "var(--cmx-warning)";
  return undefined; // page's normal text color
}

// Formats a fixed historical timestamp for display — NOT an elapsed-
// time calculation, so none of the clock-comparison caveats elsewhere
// in this file apply here. Moved here from CallLogTable.jsx so
// LiveStatusDashboard's abandoned-calls list renders dates the same
// way the rest of the app already does, instead of a second
// implementation drifting from this one over time.
export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}