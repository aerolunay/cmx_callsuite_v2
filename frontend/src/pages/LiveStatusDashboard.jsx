import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { formatDurationHMS, formatDate, durationColorFor } from "../utils/format";

/*
==================================================
STATUS_GROUPS
==================================================
The 7 agent-status tables, split 3-left / 4-right per the requested
layout. Each has a shared column shape EXCEPT:
  - showCallerId: only the 3 call-tied statuses have an actual call to
    show a Caller ID for at all (Ready/Not Ready/Aux CB/Logged Out
    have no call attached).
  - lastColumn: "duration" for everything except Logged Out, which
    shows Last Login Date instead — there's no "duration" concept for
    someone who isn't currently in any status at all.
AD_HOC intentionally excluded — not part of this dashboard's display.
==================================================
*/
const STATUS_GROUPS = [
  { key: "IN_CALL", label: "On a Call", side: "left", showCallerId: true, lastColumn: "duration" },
  { key: "ON_HOLD", label: "On Hold", side: "left", showCallerId: true, lastColumn: "duration" },
  { key: "AFTER_CALL_WORK", label: "ACW", side: "left", showCallerId: true, lastColumn: "duration" },
  { key: "READY", label: "Ready", side: "right", showCallerId: false, lastColumn: "duration" },
  { key: "NOT_READY", label: "Not Ready", side: "right", showCallerId: false, lastColumn: "duration" },
  { key: "AUX_CB", label: "Aux CB", side: "right", showCallerId: false, lastColumn: "duration" },
  { key: "LOGGED_OUT", label: "Logged Out", side: "right", showCallerId: false, lastColumn: "lastLogin" },
];

const REFRESH_INTERVAL_MS = 5000;

function fmtSeconds(seconds) {
  return seconds !== null && seconds !== undefined ? formatDurationHMS(Math.round(seconds)) : "—";
}

function fmtPercent(pct) {
  return pct !== null && pct !== undefined ? `${pct.toFixed(1)}%` : "—";
}

// "FullName (vicidialUser)" — the combined Name column format used by
// every agent-status table on this page.
function nameWithVicidialUser(a) {
  return `${a.fullName} (${a.vicidialUser || "—"})`;
}

export default function LiveStatusDashboard() {
  const { agent } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState("");
  const [agents, setAgents] = useState([]);
  const [queues, setQueues] = useState([]);
  const [abandonedCalls, setAbandonedCalls] = useState([]);
  const [totalCalls, setTotalCalls] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (agent?.accessLevel === "admin") {
      api.getCampaigns().then((data) => setCampaigns(data.campaigns)).catch(() => {});
    }
  }, [agent]);

  function load() {
    Promise.all([
      api.getLiveStatus(campaignId || undefined),
      api.getQueueStatus(campaignId || undefined),
      api.getAbandonedCalls(campaignId || undefined),
      api.getTotalCalls(campaignId || undefined),
      api.getReportingSummary(campaignId || undefined),
    ])
      .then(([statusData, queueData, abandonedData, totalCallsData, summaryData]) => {
        setAgents(statusData.agents);
        setQueues(queueData.queues);
        setAbandonedCalls(abandonedData.calls);
        setTotalCalls(totalCallsData.calls);
        setSummary(summaryData.summary);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  // Polling, not push — a real, honest tradeoff. Building a proper
  // broadcast-to-everyone WS message (the existing one only targets a
  // SPECIFIC agent) was out of scope for this pass. 5s is "close to
  // real-time" for a supervisor-facing dashboard, not truly instant.
  useEffect(() => {
    if (agent?.accessLevel !== "admin") return;
    setLoading(true);
    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, campaignId]);

  if (agent && agent.accessLevel !== "admin") {
    return <Navigate to="/" replace />;
  }

  const grouped = STATUS_GROUPS.map((g) => ({
    ...g,
    rows: agents
      .filter((a) => a.status === g.key)
      .slice()
      .sort((a, b) => (b.elapsedSeconds ?? -1) - (a.elapsedSeconds ?? -1)),
  }));

  const leftStatusGroups = grouped.filter((g) => g.side === "left");
  const rightStatusGroups = grouped.filter((g) => g.side === "right");

  // Black (well, the page's normal text color) under 1 minute, orange
  // from 1-2 minutes, red past 2 minutes — thresholds as specified,
  // not guessed. Applied per-campaign row (each queue entry shows its
  // OWN oldest-wait time).
  function oldestWaitingColor(seconds) {
    if (seconds >= 120) return "var(--cmx-danger)";
    if (seconds >= 60) return "var(--cmx-warning)";
    return "var(--cmx-text-dark)";
  }

  function renderStatusCard(g) {
    return (
      <div className="card live-status-card" key={g.key}>
        <h3>
          {g.label} ({g.rows.length})
        </h3>
        <div className="live-status-scroll">
          {g.rows.length === 0 ? (
            <p style={{ color: "#888" }}>No agents currently in this state.</p>
          ) : (
            <table className="call-log-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  {g.showCallerId && <th>Caller ID</th>}
                  <th>Name</th>
                  <th>{g.lastColumn === "lastLogin" ? "Last Login Date" : "Duration"}</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((a) => (
                  <tr key={a.appUserId}>
                    <td>{a.campaignId || "—"}</td>
                    {g.showCallerId && <td>{a.callerId || "—"}</td>}
                    <td>{nameWithVicidialUser(a)}</td>
                    {g.lastColumn === "lastLogin" ? (
                      <td>{formatDate(a.lastLoginAt)}</td>
                    ) : (
                      <td
                        style={{
                          color: durationColorFor(g.key, a.elapsedSeconds),
                          fontWeight: durationColorFor(g.key, a.elapsedSeconds) ? 700 : undefined,
                        }}
                      >
                        {a.elapsedSeconds !== null ? formatDurationHMS(a.elapsedSeconds) : "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <Header />
      <div className="page-content page-content-wide live-status-page">
        <h2>Live Agent Status</h2>

        <div className="card" style={{ marginBottom: 20 }}>
          <label className="comments-label">Campaign</label>
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">— All Campaigns —</option>
            {campaigns.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>
                {c.campaign_name} ({c.campaign_id})
              </option>
            ))}
          </select>
        </div>

        {error && <div className="error">{error}</div>}

        {/* KPI summary cards — "today", respecting the campaign filter
            above. Occupancy/Service Level are inbound-only concepts,
            outbound's card is deliberately simpler, matching what was
            actually asked for rather than padding it out to match. */}
        {summary && (
          <div className="reporting-summary-grid">
            <div className="card">
              <h3>Inbound</h3>
              <dl className="kpi-list">
                <div><dt>Total Calls</dt><dd>{summary.inbound.totalCalls}</dd></div>
                <div><dt>Total Abandoned</dt><dd>{summary.inbound.totalAbandoned}</dd></div>
                <div><dt>Average Wait Time</dt><dd>{fmtSeconds(summary.inbound.avgWaitSeconds)}</dd></div>
                <div><dt>Average Call Time</dt><dd>{fmtSeconds(summary.inbound.avgCallSeconds)}</dd></div>
                <div><dt>Average Hold Time</dt><dd>{fmtSeconds(summary.inbound.avgHoldSeconds)}</dd></div>
                <div><dt>Average ACW Time</dt><dd>{fmtSeconds(summary.inbound.avgAcwSeconds)}</dd></div>
                <div><dt>AHT</dt><dd>{fmtSeconds(summary.inbound.ahtSeconds)}</dd></div>
                <div><dt>Average Avail Time (Ready)</dt><dd>{fmtSeconds(summary.inbound.avgReadySeconds)}</dd></div>
                <div><dt>Average Not Ready Time</dt><dd>{fmtSeconds(summary.inbound.avgNotReadySeconds)}</dd></div>
                <div><dt>Occupancy %</dt><dd>{fmtPercent(summary.inbound.occupancyPct)}</dd></div>
                <div><dt>Service Level %</dt><dd>{fmtPercent(summary.inbound.serviceLevelPct)}</dd></div>
              </dl>
            </div>

            <div className="card">
              <h3>Outbound</h3>
              <dl className="kpi-list">
                <div><dt>Total Calls</dt><dd>{summary.outbound.totalCalls}</dd></div>
                <div><dt>Average Call Time</dt><dd>{fmtSeconds(summary.outbound.avgCallSeconds)}</dd></div>
                <div><dt>Average Hold Time</dt><dd>{fmtSeconds(summary.outbound.avgHoldSeconds)}</dd></div>
                <div><dt>Average ACW</dt><dd>{fmtSeconds(summary.outbound.avgAcwSeconds)}</dd></div>
              </dl>
            </div>
          </div>
        )}

        <div className="live-status-grid">
          {/* LEFT: Calls in Queue, On a Call, On Hold, ACW, Total Calls */}
          <div className="live-status-column">
            <div className="card live-status-card">
              <h3>Calls in Queue ({queues.reduce((sum, q) => sum + q.waiting, 0)})</h3>
              <div className="live-status-scroll">
                {queues.length === 0 ? (
                  <p style={{ color: "#888" }}>No calls waiting.</p>
                ) : (
                  <table className="call-log-table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Calls Waiting</th>
                        <th>Oldest Call Wait Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {queues.map((q) => (
                        <tr key={q.campaignId}>
                          <td>{q.campaignId}</td>
                          <td>{q.waiting}</td>
                          <td style={{ color: oldestWaitingColor(q.oldestWaitingSeconds) }}>
                            {formatDurationHMS(q.oldestWaitingSeconds)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {loading ? <p>Loading…</p> : leftStatusGroups.map(renderStatusCard)}

            <div className="card live-status-card">
              <h3>Total Calls ({totalCalls.length})</h3>
              <div className="live-status-scroll">
                {totalCalls.length === 0 ? (
                  <p style={{ color: "#888" }}>No calls today.</p>
                ) : (
                  <table className="call-log-table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Caller ID</th>
                        <th>Call DateTime</th>
                        <th>Handle Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {totalCalls.map((c, i) => (
                        <tr key={i}>
                          <td>{c.campaignId || "—"}</td>
                          <td>{c.phoneNumber || "—"}</td>
                          <td>{formatDate(c.callStartedAt)}</td>
                          <td>{formatDurationHMS(c.handleTimeSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: Ready, Not Ready, Aux CB, Logged Out, Abandoned */}
          <div className="live-status-column">
            {loading ? <p>Loading…</p> : rightStatusGroups.map(renderStatusCard)}

            <div className="card live-status-card">
              <h3>Abandoned ({abandonedCalls.length})</h3>
              <div className="live-status-scroll">
                {abandonedCalls.length === 0 ? (
                  <p style={{ color: "#888" }}>No abandoned calls today.</p>
                ) : (
                  <table className="call-log-table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Caller ID</th>
                        <th>Call DateTime</th>
                        <th>Wait Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {abandonedCalls.map((c, i) => (
                        <tr key={i}>
                          <td>{c.campaignId || "—"}</td>
                          <td>{c.callerIdNumber || "—"}</td>
                          <td>{formatDate(c.callStartedAt)}</td>
                          <td>{formatDurationHMS(c.waitSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
