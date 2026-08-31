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
  MICROSIP_OUTBOUND: { orangeAt: 5 * 60, redAt: 8 * 60, redInclusive: true },
  ON_HOLD: { orangeAt: 90, redAt: 120, redInclusive: true },
  AFTER_CALL_WORK: { orangeAt: 20, redAt: 60, redInclusive: false },
  NOT_READY: { orangeAt: 90, redAt: 180, redInclusive: true },
  // 50-60 min = warning, >60 min = red. Explicitly NOT applied to
  // ADMIN or AD_HOC — excluded per request, unlike the other 4 new
  // aux statuses added alongside them this session.
  LUNCH_BREAK: { orangeAt: 50 * 60, redAt: 60 * 60, redInclusive: false },
  BIO_BREAK: { orangeAt: 50 * 60, redAt: 60 * 60, redInclusive: false },
  MEETING: { orangeAt: 50 * 60, redAt: 60 * 60, redInclusive: false },
  TRAINING: { orangeAt: 50 * 60, redAt: 60 * 60, redInclusive: false },
};

export function durationColorFor(statusKey, seconds) {
  const t = DURATION_THRESHOLDS[statusKey];
  if (!t || seconds === null || seconds === undefined) return undefined;

  const isRed = t.redInclusive ? seconds >= t.redAt : seconds > t.redAt;
  if (isRed) return "var(--cmx-danger)";
  if (seconds >= t.orangeAt) return "var(--cmx-warning)";
  return undefined; // page's normal text color
}

/*
==================================================
occupancyColorFor / serviceLevelColorFor
==================================================
Thresholds as specified, not guessed. One boundary resolution needed
in each — the ranges as literally given leave a single-point gap where
neither condition technically matches (e.g. Occupancy exactly 60%:
"below 60%" is exclusive-Red, ">60%" is exclusive-Orange, so 60% itself
matched neither). Resolved by assigning that exact boundary value to
the adjacent range stated with ">"/">=" rather than leaving it
uncolored — every other boundary in both specs already has no gap as
given. Low real-world impact either way, since a computed percentage
landing on an exact whole number is uncommon.
==================================================
*/
export function occupancyColorFor(pct) {
  if (pct === null || pct === undefined) return undefined;
  if (pct < 60 || pct >= 90) return "var(--cmx-danger)";
  if (pct >= 70 && pct <= 80) return "var(--cmx-success)";
  return "var(--cmx-warning)"; // 60–70% or 80–90%
}

export function serviceLevelColorFor(pct) {
  if (pct === null || pct === undefined) return undefined;
  if (pct >= 97) return "var(--cmx-success)";
  if (pct >= 90) return "var(--cmx-warning)";
  return "var(--cmx-danger)";
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
  // REAL BUG FIX, confirmed live: toLocaleString's locale/timezone
  // argument was `undefined`, meaning "use the browser's own local
  // timezone" — but this app is meant to always show Eastern time
  // (see statsService.js's own "Eastern-day-boundary" logic and every
  // other timestamp in this app), regardless of which timezone the
  // viewer's own computer happens to be set to. The underlying data
  // was actually correct the whole time (confirmed directly against
  // the database) — only the DISPLAY was wrong, silently reformatting
  // an already-correct moment into whatever timezone the viewing
  // browser's OS happened to be configured for.
  return d.toLocaleString(undefined, {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}