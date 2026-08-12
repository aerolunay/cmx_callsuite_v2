import { useEffect, useState } from "react";
import { api } from "../api";
import { dispositionLabel } from "../constants/dispositions";
import { inboundDispositionLabel } from "../constants/inboundDispositions";

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// refreshKey is bumped by the parent (DialerPage) after a disposition
// is saved, so this table picks up the new row without polling on an
// interval — it only refetches when something actually changed.
export default function CallLogTable({ refreshKey, campaignId }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!campaignId) return;
    setLoading(true);
    api
      .getCallLog(campaignId)
      .then((data) => setRows(data.callLog))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refreshKey, campaignId]);

  function resolveDispositionLabel(row) {
    return row.direction === "inbound"
      ? inboundDispositionLabel(row.disposition)
      : dispositionLabel(row.disposition);
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
              <th>Call Date</th>
              <th>Name</th>
              <th>Phone Number</th>
              <th>Disposition</th>
              <th>Call ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.direction}-${row.call_log_id}`}>
                <td>
                  <span className={`direction-badge direction-${row.direction}`}>
                    {row.direction === "inbound" ? "Inbound" : "Outbound"}
                  </span>
                </td>
                <td>{formatDate(row.call_started_at)}</td>
                <td>
                  {row.first_name} {row.last_name}
                </td>
                <td>{row.phone_number}</td>
                <td>{resolveDispositionLabel(row)}</td>
                <td className="call-id-cell" title={row.call_id || undefined}>
                  {row.call_id ? row.call_id.slice(0, 8) : `#${row.call_log_id}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
