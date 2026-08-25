import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";
import RecordingPlaybackModal from "../modals/RecordingPlaybackModal";

/*
==================================================
RECORDINGS PAGE — standalone, NOT part of Admin
==================================================
Deliberately its own top-level page/route — Supervisors, Training &
Quality, and Account Manager need Recordings access without being
granted the full Admin page and everything else it exposes (Users,
Phone Login, Campaigns, Trunk Setup). WFM deliberately does NOT get
Recordings, per the finished access-level matrix.

Campaign scoping: admin gets the full unscoped campaign list and can
browse "All Campaigns." supervisor/training_quality/account_manager
get ONLY their own assigned campaigns (getMyCampaigns(), NOT
getAdminCampaigns() — that endpoint is admin/wfm-only and would 403
for these roles) and must always pick one specific campaign — the
backend's requireCampaignAccess rejects an empty/unassigned campaignId
from these roles regardless of what this page sends.

Content (filters, table, playback) is identical to what was originally
built as AdminUsersSection's sibling, components/admin/
AdminRecordingsSection.jsx — that file is no longer wired into
AdminPage.jsx and is effectively dead code now; safe to delete if you'd
rather not carry it, or leave it as an unused reference.
==================================================
*/
const RECORDINGS_ROLES = ["supervisor", "training_quality", "account_manager", "admin"];

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
  const [modalRecording, setModalRecording] = useState(null);
  const [modalUrl, setModalUrl] = useState(null);

  const isUnrestrictedCampaignAccess = agent?.accessLevel === "admin";

  function loadCampaigns() {
    if (isUnrestrictedCampaignAccess) {
      api
        .getAdminCampaigns()
        .then((data) => setCampaigns(data.campaigns || []))
        .catch(() => {});
    } else {
      api
        .getMyCampaigns()
        .then((data) => {
          const list = data.campaigns || [];
          setCampaigns(list);
          if (list.length > 0) setCampaignId((prev) => prev || list[0].campaign_id);
        })
        .catch(() => {});
    }
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
    if (!agent || !RECORDINGS_ROLES.includes(agent.accessLevel)) return;
    loadCampaigns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  useEffect(() => {
    if (!agent || !RECORDINGS_ROLES.includes(agent.accessLevel)) return;
    // Scoped roles must have a real campaignId selected before this can
    // run — avoids firing a request that's certain to 400 while the
    // auto-select from loadCampaigns() above is still in flight.
    if (!isUnrestrictedCampaignAccess && !campaignId) return;
    loadRecordings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, campaignId]);

  if (agent && !RECORDINGS_ROLES.includes(agent.accessLevel)) {
    return <Navigate to="/" replace />;
  }

  function handleFilterSubmit(e) {
    e.preventDefault();
    loadRecordings();
  }

  function handleClearFilters() {
    setStartDate("");
    setEndDate("");
    setAgentName("");
    // Scoped roles can't clear campaignId to empty — that's not a
    // valid selection for them (the backend requires a real one) —
    // so this only actually resets it for admin's unrestricted view.
    if (isUnrestrictedCampaignAccess) setCampaignId("");
    setTimeout(loadRecordings, 0);
  }

  async function handlePlay(recording) {
    setPlayingId(recording.call_id);
    setError("");
    try {
      const data = await api.getRecordingPlaybackUrl(recording.call_id);
      setModalRecording(recording);
      setModalUrl(data.url);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlayingId(null);
    }
  }

  function closeModal() {
    setModalRecording(null);
    setModalUrl(null);
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
                {isUnrestrictedCampaignAccess && <option value="">All Campaigns</option>}
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

      {modalRecording && modalUrl && (
        <RecordingPlaybackModal recording={modalRecording} url={modalUrl} onClose={closeModal} />
      )}
    </>
  );
}
