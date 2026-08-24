import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { formatDurationHMS, formatDate, durationColorFor, occupancyColorFor, serviceLevelColorFor } from "../utils/format";

/*
==================================================
CONSOLIDATED_STATES
==================================================
Replaces the previous 6 separate per-status cards with ONE table,
per explicit request. Order here IS the sort order (state is the
primary sort key). LOGGED_OUT is still deliberately excluded (it has
its own separate table further down). Originally AD_HOC was excluded
too, along with the 5 newer aux statuses (Lunch/Break, Bio-Break,
Admin, Meeting, Training) — both since added per explicit request, so
now every non-LOGGED_OUT manual status shows here.
"Avail" is the display label for READY (not "Ready").
==================================================
*/
const CONSOLIDATED_STATES = [
  "IN_CALL",
  "MICROSIP_OUTBOUND",
  "ON_HOLD",
  "AFTER_CALL_WORK",
  "READY",
  "AD_HOC",
  "LUNCH_BREAK",
  "BIO_BREAK",
  "ADMIN",
  "MEETING",
  "TRAINING",
  "NOT_READY",
];

const STATE_LABELS = {
  IN_CALL: "On a Call",
  MICROSIP_OUTBOUND: "MicroSIP Call",
  ON_HOLD: "On Hold",
  AFTER_CALL_WORK: "ACW",
  READY: "Avail",
  AD_HOC: "Ad-Hoc",
  LUNCH_BREAK: "Lunch/Break",
  BIO_BREAK: "Bio-Break",
  ADMIN: "Admin",
  MEETING: "Meeting",
  TRAINING: "Training",
  NOT_READY: "Not Ready",
};

const DIRECTION_LABELS = { inbound: "Inbound", outbound: "Outbound" };

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
  const [kickingId, setKickingId] = useState(null);
  const [priorityUpdatingId, setPriorityUpdatingId] = useState(null);
  const [loading, setLoading] = useState(true);

  /*
  ==================================================
  COLUMN HEIGHT MATCHING (exact, not guessed)
  ==================================================
  Same technique used earlier for the previous layout: a sibling's
  height can't be pixel-matched to another's NATURAL content height
  with CSS alone — measuring is the only way to actually guarantee it,
  rather than hardcoding a px value that only happens to look right
  for today's row counts/fonts and drifts the moment either changes.

  Measures the RIGHT column's real rendered height, then gives the
  LEFT column that exact height too (flex column). Inbound Stats and
  Logged Out keep their natural/fixed sizes; the Combined States card
  in between is the one that flexes to absorb whatever space is left —
  so Logged Out's bottom edge always lands exactly where the right
  column's last card (Abandoned) ends, regardless of how many KPI rows
  either stats card has or any future font/padding tweak.
  */
  const rightColumnRef = useRef(null);
  const [leftColumnHeight, setLeftColumnHeight] = useState(null);

  useEffect(() => {
    if (!rightColumnRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setLeftColumnHeight(entry.contentRect.height);
      }
    });
    observer.observe(rightColumnRef.current);
    return () => observer.disconnect();
  }, []);

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

  async function handleKickAgent(agentRow) {
    const confirmed = window.confirm(
      `Force-logout ${agentRow.fullName}? They'll be logged out immediately and shown a notice.`
    );
    if (!confirmed) return;

    setKickingId(agentRow.appUserId);
    setError("");
    try {
      await api.kickAgent(agentRow.appUserId);
      load(); // refresh immediately rather than waiting for the next 5s poll
    } catch (err) {
      setError(err.message);
    } finally {
      setKickingId(null);
    }
  }

  // "Set Prio" — real-time control, per explicit request. Takes effect
  // on the very next inbound-call matching pass (no caching anywhere
  // in that path — see agentStatusService.js's
  // getAnyReadyAgentWithExtension, which reads priority live from the
  // DB every time). Fires immediately on dropdown change, no separate
  // save step, matching the "must reflect immediately" requirement.
  async function handleSetPriority(agentRow, newPriority) {
    setPriorityUpdatingId(agentRow.appUserId);
    setError("");
    try {
      await api.updateAgentPriority(agentRow.appUserId, Number(newPriority));
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setPriorityUpdatingId(null);
    }
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

  // Single consolidated list, sorted exactly per spec: State (fixed
  // order above) -> Direction (Inbound before Outbound; "--"/null only
  // ever occurs within non-call-tied states, where it's a no-op tie
  // since every row in that group shares it) -> Duration highest to
  // lowest -> Campaign A-Z.
  const consolidatedRows = agents
    .filter((a) => CONSOLIDATED_STATES.includes(a.status))
    .slice()
    .sort((a, b) => {
      const stateDiff = CONSOLIDATED_STATES.indexOf(a.status) - CONSOLIDATED_STATES.indexOf(b.status);
      if (stateDiff !== 0) return stateDiff;

      const dirOrder = { inbound: 0, outbound: 1 };
      const dirDiff = (dirOrder[a.direction] ?? 2) - (dirOrder[b.direction] ?? 2);
      if (dirDiff !== 0) return dirDiff;

      const durationDiff = (b.elapsedSeconds ?? -1) - (a.elapsedSeconds ?? -1);
      if (durationDiff !== 0) return durationDiff;

      return (a.campaignId || "").localeCompare(b.campaignId || "");
    });

  const stateCounts = CONSOLIDATED_STATES.reduce((acc, key) => {
    acc[key] = agents.filter((a) => a.status === key).length;
    return acc;
  }, {});

  const activeInboundCount = agents.filter(
    (a) => ["IN_CALL", "ON_HOLD", "AFTER_CALL_WORK"].includes(a.status) && a.direction === "inbound"
  ).length;
  const activeOutboundCount = agents.filter(
    (a) => ["IN_CALL", "ON_HOLD", "AFTER_CALL_WORK"].includes(a.status) && a.direction === "outbound"
  ).length;

  // "Logged Out" now gets its own container (previously excluded from
  // the consolidated table entirely) — sorted most-recently-logged-out
  // first, since that's the most useful order for an ops view; no
  // explicit sort was specified for this one.
  const loggedOutRows = agents
    .filter((a) => a.status === "LOGGED_OUT")
    .slice()
    .sort((a, b) => new Date(b.lastLoginAt || 0) - new Date(a.lastLoginAt || 0));

  // Total Calls split into two separate lists per explicit request —
  // the backend now tags each row with direction (added specifically
  // for this split), so no second API call is needed.
  const inboundCallsList = totalCalls.filter((c) => c.direction === "inbound");
  const outboundCallsList = totalCalls.filter((c) => c.direction === "outbound");

  // Black (well, the page's normal text color) under 1 minute, orange
  // from 1-2 minutes, red past 2 minutes — thresholds as specified,
  // not guessed. Applied per-campaign row (each queue entry shows its
  // OWN oldest-wait time).
  function oldestWaitingColor(seconds) {
    if (seconds >= 120) return "var(--cmx-danger)";
    if (seconds >= 60) return "var(--cmx-warning)";
    return "var(--cmx-text-dark)";
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

        <div className="live-status-grid">
          {/* LEFT: Inbound Stats, Combined States, Logged Out. Height
              matches the right column exactly (measured, not guessed —
              see rightColumnRef/leftColumnHeight above) — Combined
              States is the flexible one that absorbs whatever space is
              left after Inbound Stats and Logged Out take their own
              natural/fixed sizes, so Logged Out's bottom always lines
              up with the right column's last card. */}
          <div
            className="live-status-column"
            style={{
              height: leftColumnHeight ? `${leftColumnHeight}px` : undefined,
            }}
          >
            {summary && (
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
                  <div>
                    <dt>Occupancy %</dt>
                    <dd
                      style={{
                        color: occupancyColorFor(summary.inbound.occupancyPct),
                        fontWeight: occupancyColorFor(summary.inbound.occupancyPct) ? 600 : undefined,
                      }}
                    >
                      {fmtPercent(summary.inbound.occupancyPct)}
                    </dd>
                  </div>
                  <div>
                    <dt>Service Level %</dt>
                    <dd
                      style={{
                        color: serviceLevelColorFor(summary.inbound.serviceLevelPct),
                        fontWeight: serviceLevelColorFor(summary.inbound.serviceLevelPct) ? 600 : undefined,
                      }}
                    >
                      {fmtPercent(summary.inbound.serviceLevelPct)}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            {/* Consolidated agent-status table — one container, per
                explicit request, replacing 6 separate per-status
                cards. flex: 1 here (not a fixed height) is what lets
                this card absorb exactly the leftover space once
                Inbound Stats + Logged Out take theirs — see the
                height-matching comment above. */}
            <div className="card" style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 0 }}>
              <h3>Agent State</h3>
              <div className="live-status-summary-row">
                <dl className="kpi-list">
                  <div><dt>On a Call</dt><dd>{stateCounts.IN_CALL}</dd></div>
                  <div><dt>On Hold</dt><dd>{stateCounts.ON_HOLD}</dd></div>
                  <div><dt>ACW</dt><dd>{stateCounts.AFTER_CALL_WORK}</dd></div>
                  <div><dt>Avail</dt><dd>{stateCounts.READY}</dd></div>
                </dl>
                <dl className="kpi-list">
                  <div><dt>Active Inbound</dt><dd>{activeInboundCount}</dd></div>
                  <div><dt>Active Outbound</dt><dd>{activeOutboundCount}</dd></div>
                  <div><dt>Not Ready</dt><dd>{stateCounts.NOT_READY}</dd></div>
                </dl>
              </div>

              <div className="live-status-consolidated-scroll" style={{ flex: "1 1 auto", minHeight: 0 }}>
                {loading ? (
                  <p>Loading…</p>
                ) : (
                  <table className="call-log-table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Name</th>
                        <th>State</th>
                        <th>Direction</th>
                        <th>Duration</th>
                        <th>Priority</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {consolidatedRows.length === 0 ? (
                        <tr>
                          <td colSpan={7} style={{ color: "#888" }}>
                            No agents currently in a tracked state.
                          </td>
                        </tr>
                      ) : (
                        consolidatedRows.map((a) => (
                          <tr key={a.appUserId}>
                            <td>{a.campaignId || "—"}</td>
                            <td>{nameWithVicidialUser(a)}</td>
                            <td>{STATE_LABELS[a.status]}</td>
                            <td>{DIRECTION_LABELS[a.direction] || "--"}</td>
                            <td
                              style={{
                                color: durationColorFor(a.status, a.elapsedSeconds),
                                fontWeight: durationColorFor(a.status, a.elapsedSeconds) ? 600 : undefined,
                              }}
                            >
                              {a.elapsedSeconds !== null ? formatDurationHMS(a.elapsedSeconds) : "—"}
                            </td>
                            <td>
                              {/* "Set Prio" — real-time, per explicit
                                  request. TODO: gate this to
                                  admin/WFM once the WFM role exists —
                                  currently this whole page is
                                  admin-only already (see the
                                  accessLevel Navigate guard above), so
                                  no separate check is needed yet. */}
                              <select
                                value={a.priority ?? 1}
                                disabled={priorityUpdatingId === a.appUserId}
                                onChange={(e) => handleSetPriority(a, e.target.value)}
                                style={{ fontSize: 13 }}
                              >
                                <option value={1}>1</option>
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                              </select>
                            </td>
                            <td>
                              {/* Matches the backend's own restriction
                                  exactly (POST /users/:id/kick's
                                  KICKABLE_STATUSES) — never shows an
                                  action that would just fail. */}
                              {["NOT_READY", "LUNCH_BREAK", "BIO_BREAK", "ADMIN", "MEETING", "TRAINING"].includes(
                                a.status
                              ) && (
                                <button
                                  type="button"
                                  className="link"
                                  disabled={kickingId === a.appUserId}
                                  onClick={() => handleKickAgent(a)}
                                >
                                  {kickingId === a.appUserId ? "Kicking…" : "Kick"}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="card live-status-card">
              <h3>Logged Out ({loggedOutRows.length})</h3>
              <div className="live-status-scroll">
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Name</th>
                      <th>Last Login Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loggedOutRows.length === 0 ? (
                      <tr>
                        <td colSpan={3} style={{ color: "#888" }}>
                          No logged-out agents.
                        </td>
                      </tr>
                    ) : (
                      loggedOutRows.map((a) => (
                        <tr key={a.appUserId}>
                          <td>{a.campaignId || "—"}</td>
                          <td>{nameWithVicidialUser(a)}</td>
                          <td>{formatDate(a.lastLoginAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* RIGHT: Outbound Stats, Calls in Queue, Inbound Calls List,
              Outbound Calls List, Abandoned. ref used by the
              ResizeObserver above to measure this column's real
              rendered height, which the left column then matches
              exactly. */}
          <div className="live-status-column" ref={rightColumnRef}>
            {summary && (
              <div className="card">
                <h3>Outbound</h3>
                <dl className="kpi-list">
                  <div><dt>Total Calls</dt><dd>{summary.outbound.totalCalls}</dd></div>
                  <div><dt>Average Call Time</dt><dd>{fmtSeconds(summary.outbound.avgCallSeconds)}</dd></div>
                  <div><dt>Average Hold Time</dt><dd>{fmtSeconds(summary.outbound.avgHoldSeconds)}</dd></div>
                  <div><dt>Average ACW</dt><dd>{fmtSeconds(summary.outbound.avgAcwSeconds)}</dd></div>
                </dl>
              </div>
            )}

            <div className="card live-status-card">
              <h3>Calls in Queue ({queues.reduce((sum, q) => sum + q.waiting, 0)})</h3>
              <div className="live-status-scroll">
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Calls Waiting</th>
                      <th>Oldest Call Wait Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queues.length === 0 ? (
                      <tr>
                        <td colSpan={3} style={{ color: "#888" }}>
                          No calls waiting.
                        </td>
                      </tr>
                    ) : (
                      queues.map((q) => (
                        <tr key={q.campaignId}>
                          <td>{q.campaignId}</td>
                          <td>{q.waiting}</td>
                          <td
                            style={{
                              color: oldestWaitingColor(q.oldestWaitingSeconds),
                              fontWeight: q.oldestWaitingSeconds >= 60 ? 600 : undefined,
                            }}
                          >
                            {formatDurationHMS(q.oldestWaitingSeconds)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card live-status-card">
              <h3>Inbound Calls ({inboundCallsList.length})</h3>
              <div className="live-status-scroll">
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
                    {inboundCallsList.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ color: "#888" }}>
                          No inbound calls today.
                        </td>
                      </tr>
                    ) : (
                      inboundCallsList.map((c, i) => (
                        <tr key={i}>
                          <td>{c.campaignId || "—"}</td>
                          <td>{c.phoneNumber || "—"}</td>
                          <td>{formatDate(c.callStartedAt)}</td>
                          <td>{formatDurationHMS(c.handleTimeSeconds)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card live-status-card">
              <h3>Outbound Calls ({outboundCallsList.length})</h3>
              <div className="live-status-scroll">
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
                    {outboundCallsList.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ color: "#888" }}>
                          No outbound calls today.
                        </td>
                      </tr>
                    ) : (
                      outboundCallsList.map((c, i) => (
                        <tr key={i}>
                          <td>{c.campaignId || "—"}</td>
                          <td>{c.phoneNumber || "—"}</td>
                          <td>{formatDate(c.callStartedAt)}</td>
                          <td>{formatDurationHMS(c.handleTimeSeconds)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card live-status-card">
              <h3>Abandoned ({abandonedCalls.length})</h3>
              <div className="live-status-scroll">
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
                    {abandonedCalls.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ color: "#888" }}>
                          No abandoned calls today.
                        </td>
                      </tr>
                    ) : (
                      abandonedCalls.map((c, i) => (
                        <tr key={i}>
                          <td>{c.campaignId || "—"}</td>
                          <td>{c.callerIdNumber || "—"}</td>
                          <td>{formatDate(c.callStartedAt)}</td>
                          <td>{formatDurationHMS(c.waitSeconds)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
