import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDuration } from "../utils/format";

// One card per stat, laid out in a grid — reverted from the compact
// per-direction rows now that Stats lives in the wider right column
// (above Call Logs) instead of the narrower 1/3-width left column.
const STAT_ROWS = [
  { key: "totalCalls", label: "Total Calls", type: "count" },
  { key: "totalInbound", label: "Total Inbound", type: "count" },
  { key: "ahtInboundSeconds", label: "AHT Inbound", type: "duration" },
  { key: "totalOutbound", label: "Total Outbound", type: "count" },
  { key: "ahtOutboundSeconds", label: "AHT Outbound", type: "duration" },
  { key: "avgIbAcwSeconds", label: "Avg IB ACW", type: "duration" },
  { key: "avgObAcwSeconds", label: "Avg OB ACW", type: "duration" },
  { key: "avgIbHoldSeconds", label: "Avg IB Hold", type: "duration" },
  { key: "avgObHoldSeconds", label: "Avg OB Hold", type: "duration" },
];

// refreshKey is bumped by the parent whenever something happened that
// could change today's numbers (a disposition saved, an agent status
// transition over the WebSocket) — event-driven refetch, not polling.
export default function StatsPanel({ refreshKey, campaignId }) {
  const [expanded, setExpanded] = useState(true);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!campaignId) return;
    api
      .getTodayStats(campaignId)
      .then((data) => setStats(data.stats))
      .catch((err) => setError(err.message));
  }, [refreshKey, campaignId]);

  function formatValue(row) {
    if (!stats) return "—";
    const value = stats[row.key];
    if (value === null || value === undefined) return "—";
    return row.type === "duration" ? formatDuration(value) : value;
  }

  return (
    <div className="card stats-panel">
      <button className="stats-header" onClick={() => setExpanded((v) => !v)} type="button">
        <span className="stats-toggle-icon">{expanded ? "▾" : "▸"}</span>
        <strong>Today's Stats</strong>
        <span className="stats-inline-total">Total Calls: {stats ? stats.totalCalls : "—"}</span>
      </button>

      {error && <div className="error">{error}</div>}

      {expanded && (
        <div className="stats-grid">
          {STAT_ROWS.map((row) => (
            <div className="stats-cell" key={row.key}>
              <div className="stats-cell-label">{row.label}</div>
              <div className="stats-cell-value">{formatValue(row)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
