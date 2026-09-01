import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

/*
==================================================
VOICEMAIL PLAYBACK MODAL
==================================================
Same wavesurfer.js waveform approach as RecordingPlaybackModal.jsx —
reused deliberately rather than building a plain <audio> player from
scratch, so voicemail playback has the same seek-by-clicking-the-
waveform experience the rest of this app's audio review already has.

Fields shown are voicemail-specific (caller, campaign, left-at,
duration, after-hours flag) rather than RecordingPlaybackModal's
call/agent/disposition set — this is a captured message, not a
disposed call, so there's no agent/disposition/callback data to show
at all.

url is the presigned S3 URL — fetched by the CALLER (VoicemailsPage or
VoicemailPlayerPage) before this modal/view ever mounts, same
contract as RecordingPlaybackModal.
==================================================
*/
export default function VoicemailPlaybackModal({ voicemail, url, onClose }) {
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
      console.error("[VoicemailPlaybackModal] wavesurfer error:", err);
      setLoadError("Could not load this voicemail's audio. The link may have expired — close and try Play again.");
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
    return new Date(value).toLocaleString(undefined, { timeZone: "America/New_York" });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ width: "min(90vw, 640px)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Voicemail</h3>
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 14, marginBottom: 16 }}>
          <div>
            <strong>Campaign:</strong> {voicemail.campaign_name || voicemail.campaign_id || "—"}
          </div>
          <div>
            <strong>Caller:</strong> {voicemail.caller_id_number || "Unknown"}
          </div>
          <div>
            <strong>Left At:</strong> {formatDateTime(voicemail.left_at)}
          </div>
          <div>
            <strong>When:</strong> {voicemail.is_after_hours === "Y" ? "After Hours" : "Business Hours"}
          </div>
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
