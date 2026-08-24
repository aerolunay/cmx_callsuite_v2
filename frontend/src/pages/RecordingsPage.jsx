import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";

/*
==================================================
RECORDINGS PAGE — standalone, NOT part of Admin
==================================================
Deliberately its own top-level page/route, per explicit request —
Supervisors (and, once built, Training & Quality/Account Manager) need
Recordings access without being granted access to the full Admin page
and everything else it exposes (Users, Phone Login, Campaigns, Trunk
Setup).

Access gate: admin OR supervisor for now. This will need revisiting
once the full access-level overhaul happens (Training & Quality,
Account Manager, WFM roles) — those roles should also reach this page,
campaign-scoped to their own assignments rather than seeing
everything. Not built yet; this page currently shows everything
without any campaign-based filtering of WHICH recordings a supervisor
can see, matching admin's own unrestricted view for now.

Content (filters, table, playback) is identical to what was originally
built as AdminUsersSection's sibling, components/admin/
AdminRecordingsSection.jsx — that file is no longer wired into
AdminPage.jsx and is effectively dead code now; safe to delete if you'd
rather not carry it, or leave it as an unused reference.
==================================================
*/
export default function RecordingsPage() {
  const { agent } = useAuth();

  const [recordings, setRecordings] = useState([]);
  const [campaigns, setCampaigns] = useState([]);

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [agentName, setAgentName] = useState("");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState(null);

  function loadCampaigns() {
    api
      .getAdminCampaigns()
      .then((data) => setCampaigns(data.campaigns || []))
      .catch(() => {}); // non-fatal — the campaign filter dropdown just stays empty
  }

  function loadRecordings() {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (campaignId) params.set("campaignId", campaignId);
    if (agentName) params.set("agentName", agentName);

    api
      .getRecordings(params.toString())
      .then((data) => setRecordings(data.recordings || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!agent || (agent.accessLevel !== "admin" && agent.accessLevel !== "supervisor")) return;
    loadCampaigns();
    loadRecordings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  if (agent && agent.accessLevel !== "admin" && agent.accessLevel !== "supervisor") {
    return <Navigate to="/" replace />;
  }

  function handleFilterSubmit(e) {
    e.preventDefault();
    loadRecordings();
  }

  function handleClearFilters() {
    setStartDate("");
    setEndDate("");
    setCampaignId("");
    setAgentName("");
    setTimeout(loadRecordings, 0);
  }

  async function handlePlay(recording) {
    setPlayingId(recording.call_id);
    setError("");
    try {
      const data = await api.getRecordingPlaybackUrl(recording.call_id);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err.message);
    } finally {
      setPlayingId(null);
    }
  }

  function formatDateTime(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  }

  return (
    <>
      <Header />
      <div className="page-content page-content-wide">
        <h2 style={{ marginBottom: 20 }}>Recordings</h2>

        {error && <div className="error">{error}</div>}

        <div className="card">
          <form onSubmit={handleFilterSubmit} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label className="comments-label">From</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="comments-label">To</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div>
              <label className="comments-label">Campaign</label>
              <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">All Campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.campaign_id} value={c.campaign_id}>
                    {c.campaign_name} ({c.campaign_id})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="comments-label">Agent Name</label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="e.g. Aerol"
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button-secondary" type="submit" disabled={loading}>
                {loading ? "Loading…" : "Apply"}
              </button>
              <button type="button" className="link" onClick={handleClearFilters} disabled={loading}>
                Clear
              </button>
            </div>
          </form>
        </div>

        <div className="card call-log-card" style={{ marginTop: 16 }}>
          {loading ? (
            <p>Loading…</p>
          ) : recordings.length === 0 ? (
            <p>No recordings found for these filters.</p>
          ) : (
            <table className="call-log-table">
              <thead>
                <tr>
                  <th>Date/Time</th>
                  <th>Campaign</th>
                  <th>Agent</th>
                  <th>Direction</th>
                  <th>Phone Number</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {recordings.map((r) => (
                  <tr key={r.call_id} className="call-log-row">
                    <td>{formatDateTime(r.call_started_at)}</td>
                    <td>{r.campaign_id || "—"}</td>
                    <td>{r.agent_name || r.agent_user || "—"}</td>
                    <td>{r.direction === "inbound" ? "Inbound" : "Outbound"}</td>
                    <td>{r.phone_number || "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        disabled={playingId === r.call_id}
                        onClick={() => handlePlay(r)}
                      >
                        {playingId === r.call_id ? "Loading…" : "Play"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
