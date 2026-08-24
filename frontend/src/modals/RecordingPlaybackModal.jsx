import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

/*
==================================================
RECORDING PLAYBACK MODAL
==================================================
Uses wavesurfer.js to render an actual waveform from the recording
itself (decoded client-side from the presigned S3 URL) — not a static
placeholder bar. Clicking/dragging anywhere on the waveform seeks
playback to that point, which is the whole point: an admin/supervisor
listening to a long call can visually spot silence/dead air and jump
straight past it instead of scrubbing blind through a plain
audio-player timeline.

Reuses this app's existing .modal-overlay/.modal-card/.modal-actions
classes (see Setup2FAModal.jsx) rather than inventing new modal
styling.

url is the presigned S3 URL — fetched by the CALLER (RecordingsPage)
before this modal ever mounts, since generating it is itself an async
step; this component assumes it already has a valid, unexpired URL.
==================================================
*/
export default function RecordingPlaybackModal({ recording, url, onClose }) {
  const waveformContainerRef = useRef(null);
  const wavesurferRef = useRef(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const wavesurfer = WaveSurfer.create({
      container: waveformContainerRef.current,
      waveColor: "#7c869c",
      progressColor: "#1e7e34",
      cursorColor: "#ffffff",
      height: 96,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      url,
    });
    wavesurferRef.current = wavesurfer;

    wavesurfer.on("ready", () => {
      setDuration(wavesurfer.getDuration());
      setIsReady(true);
    });
    wavesurfer.on("timeupdate", (time) => setCurrentTime(time));
    wavesurfer.on("play", () => setIsPlaying(true));
    wavesurfer.on("pause", () => setIsPlaying(false));
    wavesurfer.on("finish", () => setIsPlaying(false));
    wavesurfer.on("error", (err) => {
      console.error("[RecordingPlaybackModal] wavesurfer error:", err);
      setLoadError("Could not load this recording's audio. The link may have expired — close and try Play again.");
    });

    return () => {
      wavesurfer.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  function togglePlay() {
    wavesurferRef.current?.playPause();
  }

  function skip(seconds) {
    const ws = wavesurferRef.current;
    if (!ws) return;
    const next = Math.max(0, Math.min(duration, ws.getCurrentTime() + seconds));
    ws.setTime(next);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatDateTime(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  }

  const customerName = [recording.first_name, recording.last_name].filter(Boolean).join(" ") || "—";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ width: "min(90vw, 640px)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Call Recording</h3>
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Everything tracked about this call — per explicit request */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 14, marginBottom: 16 }}>
          <div><strong>Agent:</strong> {recording.agent_name || recording.agent_user || "—"}</div>
          <div><strong>Campaign:</strong> {recording.campaign_id || "—"}</div>
          <div><strong>Direction:</strong> {recording.direction === "inbound" ? "Inbound" : "Outbound"}</div>
          <div><strong>Phone Number:</strong> {recording.phone_number || "—"}</div>
          <div><strong>Customer Name:</strong> {customerName}</div>
          <div><strong>Disposition:</strong> {recording.disposition || "—"}</div>
          <div><strong>Call Started:</strong> {formatDateTime(recording.call_started_at)}</div>
          <div><strong>Call Ended:</strong> {formatDateTime(recording.call_ended_at)}</div>
          {recording.wait_seconds !== null && recording.wait_seconds !== undefined && (
            <div><strong>Customer Wait Time:</strong> {recording.wait_seconds}s</div>
          )}
          {recording.callback_at && (
            <div><strong>Callback At:</strong> {formatDateTime(recording.callback_at)}</div>
          )}
          {recording.comments && (
            <div style={{ gridColumn: "1 / -1" }}>
              <strong>Comments:</strong> {recording.comments}
            </div>
          )}
        </div>

        {loadError && <div className="error">{loadError}</div>}

        <div ref={waveformContainerRef} style={{ marginBottom: 12 }} />

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" className="button-secondary" onClick={() => skip(-10)} disabled={!isReady}>
            « 10s
          </button>
          <button type="button" className="button-secondary" onClick={togglePlay} disabled={!isReady}>
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button type="button" className="button-secondary" onClick={() => skip(10)} disabled={!isReady}>
            10s »
          </button>
          <span style={{ fontFamily: "monospace", fontSize: 13, marginLeft: "auto" }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
      </div>
    </div>
  );
}
