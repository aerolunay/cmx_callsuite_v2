import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDuration } from "../utils/format";

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

// Admin/supervisor-only panel showing TODAY'S stats across every
// agent, with its own independent campaign filter — deliberately
// separate from the personal StatsPanel above it and its filter,
// since a supervisor might want to check a different campaign's
// aggregate numbers than whatever they personally have selected for
// their own dialing.
export default function AggregateStatsPanel({ campaigns }) {
  const [expanded, setExpanded] = useState(true);
  const [filterCampaignId, setFilterCampaignId] = useState("");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getAggregateStats(filterCampaignId || undefined)
      .then((data) => setStats(data.stats))
      .catch((err) => setError(err.message));
  }, [filterCampaignId]);

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
        <strong>Today's Stats — All Agents</strong>
        {!expanded && (
          <span className="stats-inline-total">Total Calls: {stats ? stats.totalCalls : "—"}</span>
        )}
      </button>

      {expanded && (
        <select
          value={filterCampaignId}
          onChange={(e) => setFilterCampaignId(e.target.value)}
          style={{ marginBottom: 12 }}
        >
          <option value="">— All Campaigns —</option>
          {campaigns.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>
              {c.campaign_name} ({c.campaign_id})
            </option>
          ))}
        </select>
      )}

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
