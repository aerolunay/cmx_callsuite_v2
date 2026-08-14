import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import ContactDetailsCard from "../components/ContactDetailsCard";
import CallLogTable from "../components/CallLogTable";
import StatsPanel from "../components/StatsPanel";
import AggregateStatsPanel from "../components/AggregateStatsPanel";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useDialerSocket } from "../hooks/useDialerSocket";
import { DISPOSITIONS } from "../constants/dispositions";
import { INBOUND_DISPOSITIONS } from "../constants/inboundDispositions";
import { formatDuration, durationColorFor } from "../utils/format";

// Agent-selectable statuses. IN_CALL and AFTER_CALL_WORK are set only
// by the backend in response to real call events — never offered here.
const MANUAL_STATUSES = [
  { value: "READY", label: "Ready" },
  { value: "NOT_READY", label: "Not Ready" },
  { value: "AUX_CB", label: "Aux CB" },
  { value: "AD_HOC", label: "Ad-Hoc" },
];

const STATUS_LABELS = {
  NOT_READY: "Not Ready",
  READY: "Ready",
  AUX_CB: "Aux CB",
  AD_HOC: "Ad-Hoc",
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
  const [inboundCall, setInboundCall] = useState(null); // { status, room, callerIdNumber }
  const [inboundFirstName, setInboundFirstName] = useState("");
  const [inboundLastName, setInboundLastName] = useState("");
  const [inboundComments, setInboundComments] = useState("");
  const [inboundDisposition, setInboundDisposition] = useState("");
  const [inboundCallbackAt, setInboundCallbackAt] = useState("");
  const [inboundSetNotReady, setInboundSetNotReady] = useState(false);

  const [disposition, setDisposition] = useState("");
  const [comments, setComments] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [setNotReadyAfterSave, setSetNotReadyAfterSave] = useState(false);
  const [callLogVersion, setCallLogVersion] = useState(0);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasLeads, setHasLeads] = useState(true); // optimistic default — avoids a flash of "no leads" before the check resolves
  const [allCampaigns, setAllCampaigns] = useState([]); // full campaign list, only needed for AggregateStatsPanel's filter (admin/supervisor)

  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    const stored = localStorage.getItem("cmx_dialer_campaign");
    if (!stored) {
      navigate("/select-campaign");
      return;
    }
    setCampaign(JSON.parse(stored));
  }, [navigate]);

  // Hide "Dial Next Number" entirely for campaigns with no leads at
  // all (e.g. CMXBSMSC, which is inbound-only and relies on the
  // Callback feature instead) — checked once campaign is known.
  useEffect(() => {
    if (agent?.accessLevel === "admin" || agent?.accessLevel === "supervisor") {
      api.getCampaigns().then((data) => setAllCampaigns(data.campaigns)).catch(() => {});
    }
  }, [agent]);

  useEffect(() => {
    if (!campaign) return;
    api
      .hasLeads(campaign.campaign_id)
      .then((data) => setHasLeads(data.hasLead))
      .catch(() => setHasLeads(true)); // fail open — don't hide the button just because this check errored
  }, [campaign]);

  // Restore an in-progress call after a page refresh or the app being
  // fully closed and reopened. The backend (dialerService.js's
  // activeCalls Map / inboundCallService.js's singleton) kept tracking
  // the real call the whole time — only the React state here was ever
  // wiped. Runs once on mount, alongside the existing status fetch.
  useEffect(() => {
    api
      .getCurrentCall()
      .then((data) => {
        if (data.call) {
          setCall(data.call);
          setLead(data.call.lead || null);
        }
      })
      .catch(() => {});

    api
      .getCurrentInboundCall()
      .then((data) => {
        if (data.call) {
          setInboundCall(data.call);
        }
      })
      .catch(() => {});
  }, []);

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
        return { ...prev, status: message.status, onHold: message.onHold };
      });
    }

    if (message.type === "inboundCall") {
      setInboundCall((prev) => {
        // A brand new call starting (no previous call, previous one was
        // already fully finalized, OR this message is for a DIFFERENT
        // callId than whatever we were tracking — v2's multi-call
        // rebuild means an agent could in principle see a stale "ended"
        // message for a just-finalized call arrive right as a new one
        // starts) — reset the intake form fields.
        if (!prev || prev.callId !== message.callId) {
          setInboundFirstName("");
          setInboundLastName("");
          setInboundComments("");
          setInboundDisposition("");
          setInboundCallbackAt("");
        }
        return {
          callId: message.callId,
          status: message.status,
          room: message.room,
          callerIdNumber: message.callerIdNumber,
          onHold: message.onHold,
        };
      });
    }
  });

  // IN_CALL and ON_HOLD always lock the switcher (a call is genuinely
  // active either way — ON_HOLD can now ONLY be reached via the Hold
  // button on a live call, since it's been removed from the manual
  // dropdown options). AFTER_CALL_WORK only locks it when there's an
  // outbound disposition actually pending (call + lead both set) —
  // inbound calls have no disposition step at all, so an
  // inbound-triggered AFTER_CALL_WORK must NOT lock the agent out of
  // manually returning to READY, or there'd be no way out of it.
  const outboundDispositionPending = agentStatus?.status === "AFTER_CALL_WORK" && call && lead;
  const isSystemStatus =
    agentStatus?.status === "IN_CALL" || agentStatus?.status === "ON_HOLD" || outboundDispositionPending;
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
        leadData.lead.phone_number,
        leadData.lead
      );
      setCall({ callId: callData.callId, room: callData.room, status: "ringing_agent", callType: "REGULAR" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Callback: reuses the same startCall path as "Dial Next Number" but
  // skips getNextLead entirely — the row from Call Logs already has
  // everything needed. Outbound-sourced rows carry a real lead_id
  // (added to getCallLog specifically for this), so their disposition
  // still updates vicidial_list correctly; inbound-sourced rows have
  // no real lead at all, so lead_id falls back to 0 (a harmless no-op
  // for that UPDATE).
  async function handleCallBack(row) {
    if (agentStatus?.status !== "AUX_CB") {
      setError("You must be in Aux CB status to place a callback.");
      return;
    }
    if (call || inboundCall) {
      setError("You're already on a call.");
      return;
    }

    setError("");
    setBusy(true);
    try {
      const callbackLead = {
        lead_id: row.lead_id || 0,
        first_name: row.first_name,
        last_name: row.last_name,
        phone_number: row.phone_number,
      };
      setLead(callbackLead);

      const callData = await api.startCall(
        campaign.campaign_id,
        callbackLead.lead_id,
        callbackLead.phone_number,
        callbackLead,
        "CALLBACK"
      );
      setCall({ callId: callData.callId, room: callData.room, status: "ringing_agent", callType: "CALLBACK" });
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

  async function handleToggleHold() {
    if (!call) return;
    setError("");
    setBusy(true);
    try {
      const data = call.onHold ? await api.unholdCall(call.callId) : await api.holdCall(call.callId);
      setCall((prev) => ({ ...prev, onHold: data.status.onHold }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleInboundHold() {
    if (!inboundCall) return;
    setError("");
    setBusy(true);
    try {
      const data = inboundCall.onHold
        ? await api.unholdInbound(inboundCall.callId)
        : await api.holdInbound(inboundCall.callId);
      setInboundCall((prev) => ({ ...prev, onHold: data.status.onHold }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleEndInboundCall() {
    if (!inboundCall) return;
    setError("");
    setBusy(true);
    try {
      await api.endInboundCall(inboundCall.callId);
      // The 'ended' status arrives over the WS broadcast that
      // endInboundCall() triggers server-side — nothing else to do
      // here but wait for it.
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
        setNotReady: setNotReadyAfterSave,
      });

      setLead(null);
      setCall(null);
      setDisposition("");
      setComments("");
      setCallbackAt("");
      setSetNotReadyAfterSave(false);
      setCallLogVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const inboundCommentsMissing = !inboundComments.trim();
  const inboundCallbackMissing = inboundDisposition === "CALLBACK_REQUESTED" && !inboundCallbackAt;
  const inboundSaveDisabled =
    !inboundDisposition || inboundCommentsMissing || inboundCallbackMissing || busy;

  async function handleSaveInboundDisposition(e) {
    e.preventDefault();
    if (inboundSaveDisabled) return;

    setError("");
    setBusy(true);
    try {
      await api.saveInboundDisposition({
        callId: inboundCall?.callId,
        callerIdNumber: inboundCall?.callerIdNumber,
        firstName: inboundFirstName,
        lastName: inboundLastName,
        comments: inboundComments.trim(),
        disposition: inboundDisposition,
        callbackAt: inboundDisposition === "CALLBACK_REQUESTED" ? inboundCallbackAt : undefined,
        setNotReady: inboundSetNotReady,
      });

      setInboundCall(null);
      setInboundFirstName("");
      setInboundLastName("");
      setInboundComments("");
      setInboundDisposition("");
      setInboundCallbackAt("");
      setInboundSetNotReady(false);
      setCallLogVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleChangeCampaign() {
    localStorage.removeItem("cmx_dialer_campaign");
    navigate("/select-campaign");
  }

  // Cross-app handoff to cmx_scn_suite's inbound screening form —
  // BSMSC-campaign-specific, so this generates a fresh, single-use
  // code and opens the screening app in a new tab with it, rather than
  // requiring the agent to log into a second app. See
  // crossAppHandoffService.js/crossAppRoutes.js for the actual
  // exchange this code enables on the other end.
  const SCREENING_APP_URL = "https://scnsuite.cmxinnovations.com";

  async function handleOpenScreeningForm() {
    setError("");
    try {
      const data = await api.getScreeningHandoffCode();
      window.open(`${SCREENING_APP_URL}/inbound-screening?code=${data.code}`, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err.message);
    }
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
      <Header agentStatus={agentStatus?.status} />
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
            {campaign?.campaign_id === "CMXBSMSC" && (
              <button
                type="button"
                className="button-secondary"
                style={{ marginLeft: 12 }}
                onClick={handleOpenScreeningForm}
              >
                Open Screening Form
              </button>
            )}
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card status-bar">
              <div>
                <span className="badge">{statusLabel}</span>
                <span
                  className="status-elapsed"
                  style={{
                    color: durationColorFor(agentStatus?.status, elapsedSeconds),
                    fontWeight: durationColorFor(agentStatus?.status, elapsedSeconds) ? 700 : undefined,
                  }}
                >
                  {formatDuration(elapsedSeconds)}
                </span>
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

            <StatsPanel refreshKey={callLogVersion} campaignId={campaign?.campaign_id} />

            {(agent.accessLevel === "admin" || agent.accessLevel === "supervisor") && (
              <AggregateStatsPanel campaigns={allCampaigns} />
            )}

        {inboundCall && (
          <div className="card">
            <p>
              <strong>
                {inboundCall.status === "waiting_for_agent" && "Incoming call — waiting for an available agent…"}
                {inboundCall.status === "ringing_agent" && "Incoming call — ringing your phone…"}
                {inboundCall.status === "agent_connected" && "Incoming call connected"}
                {inboundCall.status === "ended" && "Call ended — please complete the details below"}
                {inboundCall.onHold && <span className="badge" style={{ marginLeft: 10 }}>ON HOLD</span>}
              </strong>
            </p>

            {(inboundCall.status === "ringing_agent" || inboundCall.status === "agent_connected") && (
              <>
                {inboundCall.status === "agent_connected" && (
                  <button
                    className="button-secondary"
                    onClick={handleToggleInboundHold}
                    disabled={busy}
                    style={{ marginBottom: 10, marginRight: 8 }}
                  >
                    {inboundCall.onHold ? "Unhold" : "Hold"}
                  </button>
                )}
                <button
                  className="button-secondary"
                  onClick={handleEndInboundCall}
                  disabled={busy || inboundCall.onHold}
                  style={{ marginBottom: 10 }}
                >
                  End Call
                </button>
              </>
            )}

            {/* Shown immediately, editable throughout the call so the
                agent can take notes live — not gated behind the call
                having ended. */}
            <div style={{ marginTop: 12 }}>
              <label className="comments-label">Caller ID</label>
              <input type="text" value={inboundCall.callerIdNumber || "Unknown"} readOnly />

              <label className="comments-label">First Name</label>
              <input
                type="text"
                value={inboundFirstName}
                onChange={(e) => setInboundFirstName(e.target.value)}
              />

              <label className="comments-label">Last Name</label>
              <input
                type="text"
                value={inboundLastName}
                onChange={(e) => setInboundLastName(e.target.value)}
              />

              <label className="comments-label">Comments (required)</label>
              <textarea
                className="comments-textarea"
                value={inboundComments}
                onChange={(e) => setInboundComments(e.target.value)}
                placeholder="What did the caller need?"
                rows={3}
              />
            </div>

            {/* Disposition only appears once the call has actually
                ended — matches outbound's pattern of dispositioning
                after the call, not mid-call. */}
            {inboundCall.status === "ended" && (
              <form onSubmit={handleSaveInboundDisposition} style={{ marginTop: 14 }}>
                <h3 style={{ marginBottom: 8 }}>Disposition</h3>
                {INBOUND_DISPOSITIONS.map((d) => (
                  <label key={d.value} className="disposition-row">
                    <input
                      type="radio"
                      name="inboundDisposition"
                      value={d.value}
                      checked={inboundDisposition === d.value}
                      onChange={() => setInboundDisposition(d.value)}
                    />
                    {d.label}
                  </label>
                ))}

                {inboundDisposition === "CALLBACK_REQUESTED" && (
                  <input
                    type="datetime-local"
                    value={inboundCallbackAt}
                    onChange={(e) => setInboundCallbackAt(e.target.value)}
                    required
                    style={{ marginTop: 10 }}
                  />
                )}

                <label className="disposition-row" style={{ marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={inboundSetNotReady}
                    onChange={(e) => setInboundSetNotReady(e.target.checked)}
                  />
                  Set my status to Not Ready after saving
                </label>

                <button
                  className="button-secondary"
                  type="submit"
                  style={{ marginTop: 14 }}
                  disabled={inboundSaveDisabled}
                >
                  {busy ? "Saving…" : "Save Disposition"}
                </button>
              </form>
            )}
          </div>
        )}

            {agentStatus?.status === "READY" && !call && hasLeads && (
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
                  {call.onHold && <span className="badge" style={{ marginLeft: 10 }}>ON HOLD</span>}
                </p>
                {isCallActive && (
                  <>
                    {call.status === "customer_connected" && (
                      <button
                        className="button-secondary"
                        onClick={handleToggleHold}
                        disabled={busy}
                        style={{ marginRight: 8 }}
                      >
                        {call.onHold ? "Unhold" : "Hold"}
                      </button>
                    )}
                    <button className="button-secondary" onClick={handleEndCall} disabled={busy || call.onHold}>
                      End Call
                    </button>
                  </>
                )}

                {/* Callback-only, shown immediately (not gated on the
                    call ending) and pre-filled from the Call Logs row
                    that started it — mirrors inbound's "shown
                    immediately, editable throughout the call" intake
                    panel, since a callback's "lead" is often just
                    reconstructed from a call log row (no real address/
                    etc. to show), same reasoning inbound already has no
                    real lead at all. First/Last Name write straight into
                    the SAME `lead` state handleSaveDisposition already
                    reads firstName/lastName from — editing them here
                    needs no backend changes at all, since that payload
                    already existed. Comments reuses the EXACT same
                    `comments` state the post-call disposition form
                    below uses, so anything typed early is still there
                    (not a second, disconnected comments box) once the
                    call ends and that form appears. */}
                {call.callType === "CALLBACK" && isCallActive && (
                  <div style={{ marginTop: 12 }}>
                    <label className="comments-label">Caller ID</label>
                    <input type="text" value={lead?.phone_number || ""} readOnly />

                    <label className="comments-label">First Name</label>
                    <input
                      type="text"
                      value={lead?.first_name || ""}
                      onChange={(e) => setLead((prev) => ({ ...prev, first_name: e.target.value }))}
                    />

                    <label className="comments-label">Last Name</label>
                    <input
                      type="text"
                      value={lead?.last_name || ""}
                      onChange={(e) => setLead((prev) => ({ ...prev, last_name: e.target.value }))}
                    />

                    <label className="comments-label">Comments (required)</label>
                    <textarea
                      className="comments-textarea"
                      value={comments}
                      onChange={(e) => setComments(e.target.value)}
                      placeholder="What's this callback about?"
                      rows={3}
                    />
                  </div>
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

                  <label className="disposition-row" style={{ marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={setNotReadyAfterSave}
                      onChange={(e) => setSetNotReadyAfterSave(e.target.checked)}
                    />
                    Set my status to Not Ready after saving
                  </label>

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

            <CallLogTable
              refreshKey={callLogVersion}
              campaignId={campaign?.campaign_id}
              onCallBack={handleCallBack}
              canCallBack={agentStatus?.status === "AUX_CB"}
            />
          </div>
        </div>
      </div>
    </>
  );
}
