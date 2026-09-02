import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { dispositionLabel, inboundDispositionLabel } from "../constants/dispositions";
import { formatDate } from "../utils/format";

// refreshKey is bumped by the parent (DialerPage) after a disposition
// is saved, so this table picks up the new row without polling on an
// interval — it only refetches when something actually changed.
// onCallBack is called with the raw row when the agent confirms the
// "Call Back" popup for it.
export default function CallLogTable({ refreshKey, campaignId, onCallBack, canCallBack }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [popup, setPopup] = useState(null); // { row, x, y } | null

  const popupRef = useRef(null);

  useEffect(() => {
    // UPDATED — campaignId is now genuinely optional (empty/undefined
    // means "all campaigns," not "not ready to fetch yet") — the old
    // `if (!campaignId) return;` guard used to treat those as the same
    // thing, which was correct back when this ALWAYS needed a single
    // "Main Campaign" to even make a request. Now always fetches;
    // DialerPage.jsx controls whether/when this component renders at
    // all, so there's no "too early" state left to guard against here.
    setLoading(true);
    api
      .getCallLog(campaignId)
      .then((data) => setRows(data.callLog))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refreshKey, campaignId]);

  // Dismiss the popup on any click outside it.
  useEffect(() => {
    if (!popup) return;

    function handleOutsideClick(e) {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        setPopup(null);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [popup]);

  function resolveDispositionLabel(row) {
    return row.direction === "inbound"
      ? inboundDispositionLabel(row.disposition)
      : dispositionLabel(row.disposition);
  }

  function handleRowDoubleClick(row, e) {
    if (!canCallBack) return;
    setPopup({ row, x: e.clientX, y: e.clientY });
  }

  function handleConfirmCallBack() {
    if (popup && onCallBack) {
      onCallBack(popup.row);
    }
    setPopup(null);
  }

  return (
    <div className="card call-log-card">
      <h3>Call Logs</h3>

      {loading && <p>Loading…</p>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && rows.length === 0 && <p>No calls logged today.</p>}

      {!loading && rows.length > 0 && (
        <table className="call-log-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Campaign</th>
              <th>Call Date</th>
              <th>Name</th>
              <th>Phone Number</th>
              <th>Disposition</th>
              <th>Xfer/Conf</th>
              <th>Call ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.direction}-${row.call_log_id}`}
                onDoubleClick={(e) => handleRowDoubleClick(row, e)}
                className={canCallBack ? "call-log-row" : ""}
              >
                <td>
                  <span className={`direction-badge direction-${row.direction}`}>
                    {row.direction === "inbound" ? "Inbound" : "Outbound"}
                  </span>
                  {row.call_type === "CALLBACK" && (
                    <span className="direction-badge direction-callback" style={{ marginLeft: 4 }}>
                      Callback
                    </span>
                  )}
                </td>
                <td>{row.campaign_name || row.campaign_id || "—"}</td>
                <td>{formatDate(row.call_started_at)}</td>
                <td>
                  {row.first_name} {row.last_name}
                </td>
                <td>{row.phone_number}</td>
                <td>{resolveDispositionLabel(row)}</td>
                <td>{row.xfer_conf === "Y" ? `Yes — ${row.xfer_conf_target}` : "No"}</td>
                <td className="call-id-cell" title={row.call_id || undefined}>
                  {row.call_id ? row.call_id.slice(0, 8) : `#${row.call_log_id}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {popup && (
        <div
          ref={popupRef}
          className="callback-popup"
          style={{ top: popup.y + 8, left: popup.x + 8 }}
        >
          <button className="button-secondary" onClick={handleConfirmCallBack}>
            Call Back {popup.row.phone_number}
          </button>
        </div>
      )}
    </div>
  );
}
