import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import ContactDetailsCard from "../components/ContactDetailsCard";
import CallLogTable from "../components/CallLogTable";
import StatsPanel from "../components/StatsPanel";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useDialerSocket } from "../hooks/useDialerSocket";
import { DISPOSITIONS } from "../constants/dispositions";
import { formatDuration } from "../utils/format";

// Agent-selectable statuses. IN_CALL and AFTER_CALL_WORK are set only
// by the backend in response to real call events — never offered here.
const MANUAL_STATUSES = [
  { value: "NOT_READY", label: "Not Ready" },
  { value: "READY", label: "Ready" },
  { value: "ON_HOLD", label: "On Hold" },
];

const STATUS_LABELS = {
  NOT_READY: "Not Ready",
  READY: "Ready",
  IN_CALL: "In Call",
  AFTER_CALL_WORK: "After Call Work",
  ON_HOLD: "On Hold",
};

// Internal call-progress states from dialerService.js, mapped to
// agent-facing text. Distinct from the 5 agent statuses above — this
// tracks the two-leg Originate flow itself while a call is in progress.
const CALL_STATUS_LABELS = {
  ringing_agent: "Ringing your phone…",
  agent_connected: "Connected — dialing customer…",
  ringing_customer: "Ringing customer…",
  customer_connected: "Customer connected",
  ended: "Call ended",
};

export default function DialerPage() {
  const { agent } = useAuth();
  const navigate = useNavigate();

  const [campaign, setCampaign] = useState(null);
  const [agentStatus, setAgentStatus] = useState(null); // { status, elapsedSeconds }
  const [statusDraft, setStatusDraft] = useState("NOT_READY");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Baseline + wall-clock counting instead of diffing server
  // timestamps against the browser's clock (see agentStatusService.js
  // comments — that comparison is what caused a bogus multi-hour
  // reading when server/client clocks or timezones disagreed).
  const baseElapsedRef = useRef(0);
  const baseAtRef = useRef(Date.now());

  const [lead, setLead] = useState(null);
  const [call, setCall] = useState(null); // { callId, room, status }
  const [inboundCall, setInboundCall] = useState(null); // { status, room } — pushed, not requested

  const [disposition, setDisposition] = useState("");
  const [comments, setComments] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [callLogVersion, setCallLogVersion] = useState(0);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("cmx_dialer_campaign");
    if (!stored) {
      navigate("/select-campaign");
      return;
    }
    setCampaign(JSON.parse(stored));
  }, [navigate]);

  useEffect(() => {
    api
      .getStatus()
      .then((data) => {
        if (data.status) {
          setAgentStatus(data.status);
          setStatusDraft(data.status.status);
          baseElapsedRef.current = data.status.elapsedSeconds;
          baseAtRef.current = Date.now();
        }
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    clearInterval(elapsedTimerRef.current);
    if (!agentStatus) return;

    function tick() {
      const realElapsed = Math.floor((Date.now() - baseAtRef.current) / 1000);
      setElapsedSeconds(baseElapsedRef.current + realElapsed);
    }

    tick();
    elapsedTimerRef.current = setInterval(tick, 1000);
    return () => clearInterval(elapsedTimerRef.current);
  }, [agentStatus]);

  useDialerSocket((message) => {
    if (message.type === "agentStatus") {
      setAgentStatus({ status: message.status, elapsedSeconds: message.elapsedSeconds });
      setStatusDraft(message.status);
      baseElapsedRef.current = message.elapsedSeconds;
      baseAtRef.current = Date.now();
      // A status transition means the PREVIOUS period just closed with
      // a final duration_seconds — worth refreshing stats now rather
      // than waiting for the next disposition save.
      setCallLogVersion((v) => v + 1);
    }

    if (message.type === "callStatus") {
      setCall((prev) => {
        if (!prev || prev.callId !== message.callId) return prev;
        return { ...prev, status: message.status };
      });
    }

    if (message.type === "inboundCall") {
      if (message.status === "ended") {
        setInboundCall(null);
      } else {
        setInboundCall({ status: message.status, room: message.room });
      }
    }
  });

  const isSystemStatus = agentStatus?.status === "IN_CALL" || agentStatus?.status === "AFTER_CALL_WORK";
  const isCallActive = call && call.status !== "ended";

  async function handleStatusSwitch() {
    setError("");
    setBusy(true);
    try {
      const data = await api.setStatus(statusDraft);
      setAgentStatus(data.status);
      baseElapsedRef.current = data.status.elapsedSeconds;
      baseAtRef.current = Date.now();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDialNext() {
    setError("");
    setBusy(true);
    try {
      const leadData = await api.nextLead(campaign.campaign_id);
      setLead(leadData.lead);

      const callData = await api.startCall(
        campaign.campaign_id,
        leadData.lead.lead_id,
        leadData.lead.phone_number
      );
      setCall({ callId: callData.callId, room: callData.room, status: "ringing_agent" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleEndCall() {
    if (!call) return;
    setError("");
    setBusy(true);
    try {
      await api.endCall(call.callId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const commentsMissing = !comments.trim();
  const callbackMissing = disposition === "CALLBACK" && !callbackAt;
  const saveDisabled = !disposition || commentsMissing || callbackMissing || busy;

  async function handleSaveDisposition(e) {
    e.preventDefault();
    if (saveDisabled || !call || !lead) return;

    setError("");
    setBusy(true);
    try {
      await api.saveDisposition(call.callId, {
        campaignId: campaign.campaign_id,
        leadId: lead.lead_id,
        phoneNumber: lead.phone_number,
        firstName: lead.first_name,
        lastName: lead.last_name,
        room: call.room,
        disposition,
        comments: comments.trim(),
        callbackAt: disposition === "CALLBACK" ? callbackAt : undefined,
      });

      setLead(null);
      setCall(null);
      setDisposition("");
      setComments("");
      setCallbackAt("");
      setCallLogVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleChangeCampaign() {
    sessionStorage.removeItem("cmx_dialer_campaign");
    navigate("/select-campaign");
  }

  const statusLabel = agentStatus ? STATUS_LABELS[agentStatus.status] : "—";

  if (!agent.extension) {
    return (
      <>
        <Header />
        <div className="page-content">
          <div className="card">
            <p>Your account has no phone extension assigned — the dialer isn't available for this account.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="page-content page-content-wide">
        <div className="dialer-topbar">
          <div>
            <h2 style={{ marginBottom: 4 }}>{campaign ? campaign.campaign_name : "…"}</h2>
            <button
              type="button"
              className="link"
              style={{ padding: 0 }}
              onClick={handleChangeCampaign}
              disabled={isCallActive}
            >
              Change campaign
            </button>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card status-bar">
              <div>
                <span className="badge">{statusLabel}</span>
                <span className="status-elapsed">{formatDuration(elapsedSeconds)}</span>
              </div>

              <div className="status-switcher">
                <select
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value)}
                  disabled={isSystemStatus || busy}
                >
                  {MANUAL_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  className="button-secondary"
                  onClick={handleStatusSwitch}
                  disabled={isSystemStatus || busy || statusDraft === agentStatus?.status}
                >
                  →
                </button>
              </div>
            </div>

            <StatsPanel refreshKey={callLogVersion} />

        {inboundCall && (
          <div className="card inbound-banner">
            <p>
              <strong>
                {inboundCall.status === "ringing_agent" && "Incoming call — ringing your phone…"}
                {inboundCall.status === "agent_connected" && "Incoming call connected"}
              </strong>
            </p>
          </div>
        )}

            {agentStatus?.status === "READY" && !call && (
              <div className="card">
                <button
                  className="primary"
                  style={{ width: "auto", padding: "10px 24px" }}
                  onClick={handleDialNext}
                  disabled={busy}
                >
                  {busy ? "Dialing…" : "Dial Next Number"}
                </button>
              </div>
            )}

            {/* Mobile-only placement: contact details right after the
                dial button, matching the previous single-column order.
                Hidden on wide screens in favor of the sidebar copy
                below (see .contact-mobile-only in theme.css). */}
            {lead && (
              <div className="contact-mobile-only">
                <ContactDetailsCard lead={lead} />
              </div>
            )}

            {call && (
              <div className="card">
                <p>
                  <strong>{CALL_STATUS_LABELS[call.status] || call.status}</strong>
                </p>
                {isCallActive && (
                  <button className="button-secondary" onClick={handleEndCall} disabled={busy}>
                    End Call
                  </button>
                )}
              </div>
            )}

            {agentStatus?.status === "AFTER_CALL_WORK" && call && lead && (
              <div className="card">
                <h3>Disposition</h3>
                <form onSubmit={handleSaveDisposition}>
                  {DISPOSITIONS.map((d) => (
                    <label key={d.value} className="disposition-row">
                      <input
                        type="radio"
                        name="disposition"
                        value={d.value}
                        checked={disposition === d.value}
                        onChange={() => setDisposition(d.value)}
                      />
                      {d.label}
                    </label>
                  ))}

                  <label className="comments-label">Comments (required)</label>
                  <textarea
                    className="comments-textarea"
                    value={comments}
                    onChange={(e) => setComments(e.target.value)}
                    placeholder="What happened on this call?"
                    rows={3}
                  />

                  {disposition === "CALLBACK" && (
                    <input
                      type="datetime-local"
                      value={callbackAt}
                      onChange={(e) => setCallbackAt(e.target.value)}
                      required
                      style={{ marginTop: 10 }}
                    />
                  )}

                  <button
                    className="button-secondary"
                    type="submit"
                    style={{ marginTop: 14 }}
                    disabled={saveDisabled}
                  >
                    {busy ? "Saving…" : "Save Disposition"}
                  </button>
                </form>
              </div>
            )}
          </div>

          <div className="dialer-side">
            {/* Desktop-only placement: top-right. See .contact-desktop-only
                in theme.css — hidden on narrow screens since the mobile
                copy above already covers that case. */}
            {lead && (
              <div className="contact-desktop-only">
                <ContactDetailsCard lead={lead} />
              </div>
            )}

            <CallLogTable refreshKey={callLogVersion} />
          </div>
        </div>
      </div>
    </>
  );
}
