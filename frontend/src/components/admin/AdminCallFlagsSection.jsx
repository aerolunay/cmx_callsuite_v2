import { useEffect, useState } from "react";
import { api } from "../../api";
import { formatDate, formatDurationHMS } from "../../utils/format";

/*
==================================================
ADMIN CALL FLAGS SECTION — "Calls Flagged"
==================================================
NEW — call avoidance tracking, per explicit request. Every row here
represents a real, raw event: an agent clicked Hang Up while the
customer was still actively connected in the conference room — across
both inbound and outbound calls (see dialerService.js's endCall() and
dialerRoutes.js's inbound end-call route, the two places that actually
write these rows). This page only surfaces the data for review —
judgment about whether any given row represents genuine call avoidance
(vs. a normal, deliberate early end) happens on the human review side,
not in any detection logic.

Read-only — no actions, no editing. AdminPage.jsx's own top-level
guard already restricts this whole page to admin/wfm only, so nothing
further is needed here for that.
==================================================
*/
export default function AdminCallFlagsSection() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // yyyy-MM-dd

  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [flags, setFlags] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError("");
    api
      .getCallFlags(startDate, endDate)
      .then((data) => setFlags(data.flags || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFilterSubmit(e) {
    e.preventDefault();
    load();
  }

  function handleResetToToday() {
    setStartDate(today);
    setEndDate(today);
    setTimeout(load, 0);
  }

  return (
    <>
      <h3 style={{ marginTop: 0 }}>Calls Flagged</h3>
      <p style={{ fontSize: 13, color: "#888" }}>
        Every row here is an agent clicking Hang Up while the customer was still actively connected —
        a raw signal for investigating possible call avoidance, not a conclusion. Review duration and
        pattern to judge each case.
      </p>

      <form
        onSubmit={handleFilterSubmit}
        style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}
      >
        <div>
          <label className="comments-label">From</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="comments-label">To</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button-secondary" type="submit" disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </button>
          <button type="button" className="link" onClick={handleResetToToday} disabled={loading}>
            Reset to Today
          </button>
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : flags.length === 0 ? (
        <p>No flagged calls for these filters.</p>
      ) : (
        <div className="card call-log-card">
          <table className="call-log-table">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Agent</th>
                <th>Campaign</th>
                <th>Phone</th>
                <th>Call Started</th>
                <th>Duration</th>
                <th>Flagged At</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.flagId}>
                  <td>
                    <span className={`direction-badge direction-${f.direction}`}>
                      {f.direction === "inbound" ? "Inbound" : "Outbound"}
                    </span>
                  </td>
                  <td>{f.agentName}</td>
                  <td>{f.campaignName}</td>
                  <td>{f.phoneNumber || "—"}</td>
                  <td>{formatDate(f.callStartedAt)}</td>
                  <td>{f.callDurationSeconds != null ? formatDurationHMS(f.callDurationSeconds) : "—"}</td>
                  <td>{formatDate(f.flaggedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
