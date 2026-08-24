import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN RECORDINGS SECTION
==================================================
Filters (call datetime range, campaign, agent name) all sent to the
backend — GET /api/admin/recordings does the actual filtering
server-side (a UNION of dialer_call_log + inbound_call_log, only rows
with a real recording_key), not client-side, since there could be far
more matching rows than are useful to ship to the browser unfiltered.

Playback URLs are fetched ON DEMAND (only when Play is clicked), never
eagerly for the whole list — they're time-limited presigned S3 URLs
(1 hour expiry), so generating one for every row on every load would
mostly go to waste. Rather than a full audio player UI, this opens the
presigned URL directly in a new tab — the browser's own native
audio/wav handling plays it immediately, no custom player needed for a
first pass.
==================================================
*/
export default function AdminRecordingsSection() {
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
    loadCampaigns();
    loadRecordings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFilterSubmit(e) {
    e.preventDefault();
    loadRecordings();
  }

  function handleClearFilters() {
    setStartDate("");
    setEndDate("");
    setCampaignId("");
    setAgentName("");
    // Reload immediately with cleared filters rather than waiting for
    // the next manual "Apply" click — matches what clearing a filter
    // usually means to someone using it.
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
      <h3>Recordings</h3>

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
    </>
  );
}
