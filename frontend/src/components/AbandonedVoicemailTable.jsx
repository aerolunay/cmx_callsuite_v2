import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatDate, formatDurationHMS } from "../utils/format";
import VoicemailPlaybackModal from "../modals/VoicemailPlaybackModal";

/*
==================================================
ABANDONED / VOICEMAIL TABLE
==================================================
Combined feed for DialerPage's "Abandoned & Voicemail" tab (sits
alongside CallLogTable's own "Call Logs" tab — see DialerPage.jsx's
tab container). Abandoned and Voicemail rows are merged into ONE list,
each row tagged with its `type`, sorted together by timestamp.

REDESIGNED — per explicit request: the old New/Resolved/Unreachable/
Left VM status dropdown, and later an inline disposition picker with
no actual call, are both gone. Clicking "Callback" now places a REAL
call to that row's number/campaign — exactly like the existing Call
Log callback feature — via the onCallback prop (see DialerPage.jsx's
handleAbandonedVoicemailCallback). Whatever disposition the agent
picks on the NORMAL post-call disposition form once that call ends is
what gets recorded on this row's status server-side ("CB - <label>" —
see dialerRoutes.js's POST /dialer/disposition/:callId), not anything
decided here. Only status = 'NEW' rows are ever shown here at all —
the backend itself only returns those (see GET
/dialer/abandoned-voicemail) — so a row correctly disappears the next
time this reloads, once its callback's disposition has actually saved.

REAL BUG FIX, per explicit request: a row previously only disappeared
after a manual page refresh — this component had no way of knowing a
disposition had just been saved elsewhere (the disposition form is a
completely separate section of DialerPage). refreshKey (passed down
as DialerPage's own callLogVersion, which already increments after
every disposition save — see handleSaveDisposition/
handleSaveInboundDisposition) now triggers an automatic reload the
moment that happens.

highlightKey (optional prop) — per explicit request, supports
DialerPage's manual-dial-block flow: if an agent tries to manually
dial a number that already has a pending (status = 'NEW') entry here,
DialerPage switches to this tab and passes down a key identifying that
exact row (e.g. "voicemail-123" or "abandoned-45"), which this
component scrolls into view and highlights briefly.

Voicemail playback reuses VoicemailPlaybackModal as-is. No download
action here, matching the agent-facing playback-url route's own
restriction — agents can listen, not download.
==================================================
*/
export default function AbandonedVoicemailTable({ campaignId, highlightKey, onCallback, refreshKey }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // yyyy-MM-dd

  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState(null);
  const [modalVoicemail, setModalVoicemail] = useState(null);
  const [modalUrl, setModalUrl] = useState(null);

  const highlightRef = useRef(null);

  function rowKey(row) {
    return row.type === "voicemail" ? `voicemail-${row.voicemailLogId}` : `abandoned-${row.abandonedCallLogId}`;
  }

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
  }, [campaignId, refreshKey]);

  // Per explicit request — scrolls the highlighted row into view the
  // moment it's known (either on initial load with a highlightKey
  // already set, or if it's set slightly after rows finish loading).
  useEffect(() => {
    if (highlightKey && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightKey, rows]);

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
              <th>Callback</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const key = rowKey(row);
              const isHighlighted = highlightKey === key;
              return (
                <tr
                  key={`${key}-${row.timestamp}`}
                  ref={isHighlighted ? highlightRef : null}
                  className={isHighlighted ? "call-log-row-highlighted" : undefined}
                >
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
                    <button type="button" className="link" onClick={() => onCallback(row)}>
                      Callback
                    </button>
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
              );
            })}
          </tbody>
        </table>
      )}

      {modalVoicemail && modalUrl && (
        <VoicemailPlaybackModal voicemail={modalVoicemail} url={modalUrl} onClose={closeModal} />
      )}
    </div>
  );
}
