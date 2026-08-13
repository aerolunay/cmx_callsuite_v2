import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { formatDurationHMS, formatDate } from "../utils/format";

// Order matters — this is the display order of the tables on the page.
const STATUS_GROUPS = [
  { key: "READY", label: "Ready" },
  { key: "NOT_READY", label: "Not Ready" },
  { key: "IN_CALL", label: "On a Call" },
  { key: "ON_HOLD", label: "On Hold" },
  { key: "AFTER_CALL_WORK", label: "ACW" },
  { key: "AUX_CB", label: "Aux CB" },
  { key: "AD_HOC", label: "Ad-Hoc" },
  { key: "LOGGED_OUT", label: "Logged Out" },
];

/*
==================================================
DURATION_THRESHOLDS
==================================================
Per-status color coding for the Duration column, thresholds as
specified (not guessed) — statuses not listed here (READY, NOT_READY,
AD_HOC, LOGGED_OUT) get no special coloring at all, just the page's
normal text color, since only these four were called out.

Each entry is [orangeAtSeconds, redAtSeconds]. ACW's red threshold is
strictly ">" 60s (not ">="), matching exactly how it was specified —
the other three are ">=" at their red threshold, so this is genuinely
a one-second difference from the others, not a copy-paste slip.
==================================================
*/
const DURATION_THRESHOLDS = {
  IN_CALL: { orangeAt: 5 * 60, redAt: 8 * 60, redInclusive: true },
  ON_HOLD: { orangeAt: 90, redAt: 120, redInclusive: true },
  AFTER_CALL_WORK: { orangeAt: 20, redAt: 60, redInclusive: false },
  AUX_CB: { orangeAt: 5 * 60, redAt: 8 * 60, redInclusive: true },
};

function durationColorFor(statusKey, seconds) {
  const t = DURATION_THRESHOLDS[statusKey];
  if (!t || seconds === null || seconds === undefined) return undefined;

  const isRed = t.redInclusive ? seconds >= t.redAt : seconds > t.redAt;
  if (isRed) return "var(--cmx-danger)";
  if (seconds >= t.orangeAt) return "var(--cmx-warning)";
  return undefined; // page's normal text color
}

const REFRESH_INTERVAL_MS = 5000;

export default function LiveStatusDashboard() {
  const { agent } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState("");
  const [agents, setAgents] = useState([]);
  const [queues, setQueues] = useState([]);
  const [abandonedCalls, setAbandonedCalls] = useState([]);
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
    ])
      .then(([statusData, queueData, abandonedData]) => {
        setAgents(statusData.agents);
        setQueues(queueData.queues);
        setAbandonedCalls(abandonedData.calls);
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

  // The longest any currently-waiting call (within whatever the
  // campaign filter above already narrowed queues down to) has been
  // waiting. queues' oldestWaitingSeconds values are already plain
  // numbers computed server-side (see inboundCallService.js's
  // getQueueStatus) — just picking the largest of them here, not
  // diffing any clock ourselves.
  const oldestWaitingSeconds = queues.length
    ? Math.max(...queues.map((q) => q.oldestWaitingSeconds))
    : null;

  // Black (well, the page's normal text color) under 1 minute, orange
  // from 1-2 minutes, red past 2 minutes — thresholds as specified,
  // not guessed.
  function oldestWaitingColor(seconds) {
    if (seconds >= 120) return "var(--cmx-danger)";
    if (seconds >= 60) return "var(--cmx-warning)";
    return "var(--cmx-text-dark)";
  }

  return (
    <>
      <Header />
      <div className="page-content page-content-wide">
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

        <div className="queue-row">
          <div className="card">
            <h3>Calls in Queue</h3>
            <div className="queue-row-scroll">
              <p style={{ fontSize: 28, fontWeight: 700, color: "var(--cmx-navy)" }}>
                {queues.reduce((sum, q) => sum + q.waiting, 0)}
              </p>
              {queues.length > 0 && (
                <p style={{ fontSize: 13, color: "#888" }}>
                  {queues.map((q) => `${q.campaignId}: ${q.waiting}`).join(", ")}
                </p>
              )}
              {oldestWaitingSeconds !== null && (
                <p style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>
                  Oldest call waiting:{" "}
                  <span style={{ color: oldestWaitingColor(oldestWaitingSeconds) }}>
                    {formatDurationHMS(oldestWaitingSeconds)}
                  </span>
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <h3>Abandoned ({abandonedCalls.length})</h3>
            <div className="queue-row-scroll">
              {abandonedCalls.length === 0 ? (
                <p style={{ color: "#888" }}>No abandoned calls today.</p>
              ) : (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Phone Number</th>
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

        {error && <div className="error">{error}</div>}

        {loading ? (
          <p>Loading…</p>
        ) : (
          grouped.map((g) => (
            <div className="card call-log-card" key={g.key} style={{ marginBottom: 16 }}>
              <h3>
                {g.label} ({g.rows.length})
              </h3>
              {g.rows.length === 0 ? (
                <p style={{ color: "#888" }}>No agents currently in this state.</p>
              ) : (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>ViciDial User</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((a) => (
                      <tr key={a.appUserId}>
                        <td>{a.fullName}</td>
                        <td>{a.email}</td>
                        <td>{a.vicidialUser || "—"}</td>
                        <td style={{ color: durationColorFor(g.key, a.elapsedSeconds), fontWeight: durationColorFor(g.key, a.elapsedSeconds) ? 700 : undefined }}>
                          {a.elapsedSeconds !== null ? formatDurationHMS(a.elapsedSeconds) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
