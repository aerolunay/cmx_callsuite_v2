import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDate, formatDurationHMS } from "../utils/format";
import VoicemailPlaybackModal from "../modals/VoicemailPlaybackModal";

/*
==================================================
ABANDONED / VOICEMAIL TABLE
==================================================
Combined feed for DialerPage's new "Abandoned & Voicemail" tab (sits
alongside CallLogTable's own "Call Logs" tab — see DialerPage.jsx's
tab container). Per explicit request: Abandoned and Voicemail rows are
merged into ONE list (not two separate tables), each row tagged with
its `type` so the badge/action column can render appropriately, sorted
together by timestamp.

Defaults to today, same as CallLogTable, but — per explicit request —
also exposes a date-range filter (mirrors VoicemailsPage.jsx's own
admin-side From/To inputs) so an agent can look further back than just
today when they need to.

campaignId is passed in from DialerPage (the same statsCampaignFilter
already shared with StatsPanel/CallLogTable) — kept as one shared
filter across all three rather than a fourth, separate dropdown.

Voicemail playback reuses VoicemailPlaybackModal as-is (same waveform
player already used by the admin-side VoicemailsPage) — this table
just adapts the combined row's camelCase shape into the snake_case
shape that modal expects. No download action here, matching the
agent-facing playback-url route's own restriction (see
dialerRoutes.js's comment on that route) — agents can listen, not
download.
==================================================
*/
export default function AbandonedVoicemailTable({ campaignId }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // yyyy-MM-dd

  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState(null);
  const [modalVoicemail, setModalVoicemail] = useState(null);
  const [modalUrl, setModalUrl] = useState(null);
  // Per explicit request — tracks whether a voicemail's been attended
  // to. Keyed by voicemailLogId so only the one row's dropdown shows
  // "Saving…" while its own update is in flight, not every row at
  // once.
  const [savingStatusId, setSavingStatusId] = useState(null);

  const VOICEMAIL_STATUS_OPTIONS = [
    { value: "NEW", label: "New" },
    { value: "RESOLVED", label: "Resolved" },
    { value: "UNREACHABLE", label: "Unreachable" },
    { value: "LEFT_VM", label: "Left VM" },
  ];

  function load() {
    setLoading(true);
    setError("");
    api
      .getAbandonedVoicemail({ campaignId: campaignId || undefined, startDate, endDate })
      .then((data) => setRows(data.rows || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  function handleFilterSubmit(e) {
    e.preventDefault();
    load();
  }

  function handleResetToToday() {
    setStartDate(today);
    setEndDate(today);
    setTimeout(load, 0);
  }

  async function handlePlay(row) {
    setPlayingId(row.voicemailLogId);
    setError("");
    try {
      const data = await api.getAgentVoicemailPlaybackUrl(row.voicemailLogId);
      setModalVoicemail({
        campaign_name: row.campaignName,
        campaign_id: row.campaignId,
        caller_id_number: row.callerIdNumber,
        left_at: row.timestamp,
        is_after_hours: row.isAfterHours ? "Y" : "N",
      });
      setModalUrl(data.url);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlayingId(null);
    }
  }

  function closeModal() {
    setModalVoicemail(null);
    setModalUrl(null);
  }

  // Per explicit request — updates immediately reflect in the
  // dropdown itself (optimistic-ish: only reverts on a genuine
  // failure) rather than needing a full table reload just to see the
  // change take.
  async function handleStatusChange(row, newStatus) {
    const previousStatus = row.status;
    setRows((prev) => prev.map((r) => (r.voicemailLogId === row.voicemailLogId ? { ...r, status: newStatus } : r)));
    setSavingStatusId(row.voicemailLogId);
    setError("");
    try {
      await api.updateVoicemailStatus(row.voicemailLogId, newStatus);
    } catch (err) {
      setError(err.message);
      setRows((prev) =>
        prev.map((r) => (r.voicemailLogId === row.voicemailLogId ? { ...r, status: previousStatus } : r))
      );
    } finally {
      setSavingStatusId(null);
    }
  }

  return (
    <div className="card call-log-card">
      <h3>Abandoned & Voicemail</h3>

      <form
        onSubmit={handleFilterSubmit}
        style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}
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

      {loading && <p>Loading…</p>}

      {!loading && !error && rows.length === 0 && <p>No abandoned calls or voicemails for these filters.</p>}

      {!loading && rows.length > 0 && (
        <table className="call-log-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Campaign</th>
              <th>Date</th>
              <th>Caller</th>
              <th>Details</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.type}-${row.voicemailLogId || i}-${row.timestamp}`}>
                <td>
                  <span className={`direction-badge direction-${row.type === "voicemail" ? "callback" : "inbound"}`}>
                    {row.type === "voicemail" ? "Voicemail" : "Abandoned"}
                  </span>
                </td>
                <td>{row.campaignName || row.campaignId || "—"}</td>
                <td>{formatDate(row.timestamp)}</td>
                <td>{row.callerIdNumber || "Unknown"}</td>
                <td>
                  {row.type === "voicemail"
                    ? `${row.durationSeconds != null ? formatDurationHMS(row.durationSeconds) : "—"}${
                        row.isAfterHours ? " · After Hours" : ""
                      }`
                    : `Waited ${row.waitSeconds != null ? formatDurationHMS(row.waitSeconds) : "—"}`}
                </td>
                <td>
                  {row.type === "voicemail" ? (
                    <select
                      value={row.status || "NEW"}
                      disabled={savingStatusId === row.voicemailLogId}
                      onChange={(e) => handleStatusChange(row, e.target.value)}
                    >
                      {VOICEMAIL_STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {row.type === "voicemail" && row.hasRecording && (
                    <button
                      type="button"
                      className="link"
                      disabled={playingId === row.voicemailLogId}
                      onClick={() => handlePlay(row)}
                    >
                      {playingId === row.voicemailLogId ? "Loading…" : "Play"}
                    </button>
                  )}
                  {row.type === "voicemail" && !row.hasRecording && "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalVoicemail && modalUrl && (
        <VoicemailPlaybackModal voicemail={modalVoicemail} url={modalUrl} onClose={closeModal} />
      )}
    </div>
  );
}
