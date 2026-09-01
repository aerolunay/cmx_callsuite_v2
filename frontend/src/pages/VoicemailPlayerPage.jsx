import { useEffect, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";

/*
==================================================
VOICEMAIL PLAYER PAGE — standalone, reached from the email notification
==================================================
This is the "new page" the voicemail notification email's "Listen to
Voicemail" link points at (FRONTEND_URL/voicemails/:voicemailLogId —
see emailTemplates.js's buildVoicemailNotificationEmail and
inboundCallService.js's recordVoicemail). Deliberately a real page
component, not a modal — the recipient is arriving here directly from
their email client with no prior app navigation, so there's nothing
for a modal to sit on top of.

The link itself never goes stale even though presigned S3 URLs expire
in 1 hour: this page always fetches a FRESH one on load, the same way
VoicemailsPage's own Play button does — the email just needs the
voicemailLogId, not any time-limited credential.

Still fully access-controlled. Landing here with no session at all
sends the person to /login via ProtectedRoute (same as every other
page); landing here logged in as a role/campaign that isn't actually
allowed to see this specific voicemail gets a real 403 from the
backend, same real check as the main list page — arriving via an
emailed link is not a bypass of anything.
==================================================
*/
export default function VoicemailPlayerPage() {
  const { agent } = useAuth();
  const { voicemailLogId } = useParams();

  const [voicemail, setVoicemail] = useState(null);
  const [url, setUrl] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const VOICEMAIL_ROLES = ["supervisor", "account_manager", "training_quality", "admin"];

  useEffect(() => {
    if (!agent || !VOICEMAIL_ROLES.includes(agent.accessLevel)) return;

    setLoading(true);
    setError("");
    Promise.all([api.getVoicemail(voicemailLogId), api.getVoicemailPlaybackUrl(voicemailLogId)])
      .then(([metaData, urlData]) => {
        setVoicemail(metaData.voicemail);
        setUrl(urlData.url);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, voicemailLogId]);

  if (agent && !VOICEMAIL_ROLES.includes(agent.accessLevel)) {
    return <Navigate to="/" replace />;
  }

  function formatDateTime(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString(undefined, { timeZone: "America/New_York" });
  }

  return (
    <>
      <Header />
      <div className="page-content" style={{ maxWidth: 560 }}>
        <h2 style={{ marginBottom: 20 }}>Voicemail</h2>

        {error && <div className="error">{error}</div>}

        {loading ? (
          <p>Loading…</p>
        ) : voicemail ? (
          <div className="card">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 14, marginBottom: 20 }}>
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

            {url && (
              <audio controls autoPlay style={{ width: "100%" }} src={url}>
                Your browser doesn't support inline audio playback.
              </audio>
            )}
          </div>
        ) : (
          <p>Voicemail not found.</p>
        )}
      </div>
    </>
  );
}
