import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDuration } from "../utils/format";

// One row per direction instead of a flat grid of 9 cells — much more
// compact, and reads more naturally ("here's everything about inbound,
// here's everything about outbound") than a 3-column grid mixing both.
const DIRECTIONS = [
  {
    key: "inbound",
    label: "Inbound",
    metrics: [
      { key: "totalInbound", label: "Calls", type: "count" },
      { key: "ahtInboundSeconds", label: "AHT", type: "duration" },
      { key: "avgIbAcwSeconds", label: "ACW", type: "duration" },
      { key: "avgIbHoldSeconds", label: "Hold", type: "duration" },
    ],
  },
  {
    key: "outbound",
    label: "Outbound",
    metrics: [
      { key: "totalOutbound", label: "Calls", type: "count" },
      { key: "ahtOutboundSeconds", label: "AHT", type: "duration" },
      { key: "avgObAcwSeconds", label: "ACW", type: "duration" },
      { key: "avgObHoldSeconds", label: "Hold", type: "duration" },
    ],
  },
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

  function formatValue(key, type) {
    if (!stats) return "—";
    const value = stats[key];
    if (value === null || value === undefined) return "—";
    return type === "duration" ? formatDuration(value) : value;
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
        <div className="stats-direction-rows">
          {DIRECTIONS.map((dir) => (
            <div className="stats-direction-row" key={dir.key}>
              <span className="stats-direction-label">{dir.label}</span>
              <div className="stats-direction-metrics">
                {dir.metrics.map((m) => (
                  <div className="stats-metric" key={m.key}>
                    <div className="stats-metric-label">{m.label}</div>
                    <div className="stats-metric-value">{formatValue(m.key, m.type)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}