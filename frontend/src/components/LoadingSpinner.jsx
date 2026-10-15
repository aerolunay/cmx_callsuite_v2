/*
Per explicit request — one rotating spinner for every loading state in the
app (pages, admin sections, tables, modals), instead of a plain
"Loading…" line. Styles: .loading-spinner* in theme.css. `compact` is the
smaller version for loading states inside a card, table or modal.
*/
export default function LoadingSpinner({ label = "Loading…", compact = false }) {
  return (
    <div className={`loading-spinner-wrap${compact ? " loading-spinner-wrap-compact" : ""}`} role="status" aria-live="polite">
      <div className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
