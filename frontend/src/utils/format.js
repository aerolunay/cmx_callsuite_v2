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