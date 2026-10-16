import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDate } from "../utils/format";
import LoadingSpinner from "./LoadingSpinner";
import Modal from "../modals/Modal";

/*
==================================================
SCHEDULED CALLBACKS — per explicit request
==================================================
Every callback still waiting to be made across the agent's campaigns
(GET /api/dialer/scheduled-callbacks — see dialerRoutes.js for exactly
what counts as "still scheduled"). Toggle between the ones this agent
scheduled personally and everyone's. Soonest first; past-due ones are
highlighted.

Double-click a row to call that customer back (confirmation first). It
reuses DialerPage's handleCallBack, so the call and its disposition work
exactly like a Call Log callback. A callback leaves this list on its own
once a later call's disposition shows the customer was reached — a No
Answer / Voicemail / Machine / Busy outcome keeps it here.

Reloads whenever refreshKey changes (DialerPage bumps it after every
saved disposition) and every minute, so items others complete drop off.
==================================================
*/
const REFRESH_MS = 60000;

function customerName(row) {
  return `${row.first_name || ""} ${row.last_name || ""}`.trim() || "—";
}

// The number a callback actually dials — same preference as handleCallBack.
function dialNumber(row) {
  return row.callback_number || row.phone_number;
}

export default function ScheduledCallbacksTable({ refreshKey, canCallBack, onCallBack, compact }) {
  const [scope, setScope] = useState("mine"); // "mine" | "all"
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmRow, setConfirmRow] = useState(null);
  // When the list was last loaded — "past due" is judged against this
  // (it reloads every minute), not the clock at render time.
  const [loadedAt, setLoadedAt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    function load(showSpinner) {
      if (showSpinner) setLoading(true);
      api
        .getScheduledCallbacks(scope)
        .then((data) => {
          if (cancelled) return;
          setRows(data.callbacks || []);
          setLoadedAt(Date.now());
          setError("");
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    load(true);
    const interval = setInterval(() => load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [scope, refreshKey]);

  function handleRowDoubleClick(row) {
    if (!canCallBack) return;
    setConfirmRow(row);
  }

  function handleConfirm() {
    const row = confirmRow;
    setConfirmRow(null);
    if (row && onCallBack) onCallBack(row);
  }

  return (
    <div className="card call-log-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Scheduled Callbacks</h3>
        <div className="view-toggle" role="tablist" aria-label="Whose callbacks" style={{ marginBottom: 0 }}>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "mine"}
            className={`view-toggle-option${scope === "mine" ? " view-toggle-option-active" : ""}`}
            onClick={() => setScope("mine")}
          >
            My Callbacks
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "all"}
            className={`view-toggle-option${scope === "all" ? " view-toggle-option-active" : ""}`}
            onClick={() => setScope("all")}
          >
            All Callbacks
          </button>
        </div>
      </div>

      <p style={{ fontSize: 13, color: "#888", margin: "8px 0" }}>
        {canCallBack
          ? "Double-click a row to call the customer back."
          : "Set your status to Ready or Callback to call a customer back."}
      </p>

      {loading && <LoadingSpinner compact />}
      {error && <div className="error">{error}</div>}

      {!loading && !error && rows.length === 0 && (
        <p>{scope === "mine" ? "You have no scheduled callbacks." : "No scheduled callbacks."}</p>
      )}

      {!loading && rows.length > 0 && (
        <table className={`call-log-table${compact ? " call-log-table-compact" : ""}`}>
          <thead>
            <tr>
              <th>Callback At</th>
              <th>Customer</th>
              <th>Number</th>
              {!compact && <th>Campaign</th>}
              {!compact && scope === "all" && <th>Scheduled By</th>}
              {!compact && <th>Notes</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const overdue = row.callback_at && new Date(row.callback_at).getTime() < loadedAt;
              return (
                <tr
                  key={`${row.source}-${row.id}`}
                  onDoubleClick={() => handleRowDoubleClick(row)}
                  className={canCallBack ? "call-log-row" : ""}
                  style={overdue ? { background: "#fef3f2" } : undefined}
                  title={overdue ? "Past due" : undefined}
                >
                  <td style={{ whiteSpace: "nowrap", color: overdue ? "#b42318" : undefined, fontWeight: overdue ? 600 : undefined }}>
                    {formatDate(row.callback_at)}
                  </td>
                  <td>{customerName(row)}</td>
                  <td>{dialNumber(row)}</td>
                  {!compact && <td>{row.campaign_id}</td>}
                  {!compact && scope === "all" && <td>{row.agent_name || row.agent_user}</td>}
                  {!compact && <td className="admin-name-cell">{row.comments || "—"}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {confirmRow && (
        <Modal title="Call back this customer?" onClose={() => setConfirmRow(null)} width="min(90vw, 420px)">
          <p style={{ fontSize: 14 }}>
            <strong>{customerName(confirmRow)}</strong> at <strong>{dialNumber(confirmRow)}</strong>
            <br />
            Campaign {confirmRow.campaign_id} · scheduled for {formatDate(confirmRow.callback_at)}
          </p>
          {confirmRow.comments && <p style={{ fontSize: 13, color: "#667085" }}>{confirmRow.comments}</p>}
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={handleConfirm}>
              Call Back
            </button>
            <button type="button" className="link" onClick={() => setConfirmRow(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
