import { useEffect, useRef, useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import Header from "../components/Header";
import ContactDetailsCard from "../components/ContactDetailsCard";
import CallLogTable from "../components/CallLogTable";
import StatsPanel from "../components/StatsPanel";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useDialerSocketMessages } from "../context/DialerSocketContext";
import { MiniPhone } from "../components/MiniPhone";
import { getOutboundDispositionsForCampaign, getInboundDispositionsForCampaign } from "../constants/dispositions";
import { formatDuration, durationColorFor } from "../utils/format";


// Agent-selectable statuses. IN_CALL and AFTER_CALL_WORK are set only
// by the backend in response to real call events — never offered here.
// AUX_CB removed — JsSIP's own call-gating on the agent's registered
// extension now covers what it used to protect against; Callback
// shares READY with Dial Next Number instead of its own status.
const MANUAL_STATUSES = [
  { value: "READY", label: "Ready" },
  { value: "NOT_READY", label: "Not Ready" },
  { value: "AD_HOC", label: "Ad-Hoc" },
  { value: "LUNCH_BREAK", label: "Lunch/Break" },
  { value: "BIO_BREAK", label: "Bio-Break" },
  { value: "ADMIN", label: "Admin" },
  { value: "MEETING", label: "Meeting" },
  { value: "TRAINING", label: "Training" },
];

const STATUS_LABELS = {
  NOT_READY: "Not Ready",
  READY: "Ready",
  AD_HOC: "Ad-Hoc",
  LUNCH_BREAK: "Lunch/Break",
  BIO_BREAK: "Bio-Break",
  ADMIN: "Admin",
  MEETING: "Meeting",
  TRAINING: "Training",
  IN_CALL: "In Call",
  AFTER_CALL_WORK: "After Call Work",
  ON_HOLD: "On Hold",
  MICROSIP_OUTBOUND: "On a MicroSIP Call",
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
  // Trunk-line calls show the TRUNK's own Caller ID, not the actual
  // customer's — this lets the agent manually record the real number
  // to call back, separate from (and preferred over) the unreliable
  // auto-populated Caller ID for this scenario.
  const [inboundCallbackNumber, setInboundCallbackNumber] = useState("");
  const [inboundDisposition, setInboundDisposition] = useState("");
  const [inboundCallbackAt, setInboundCallbackAt] = useState("");
  const [inboundSetNotReady, setInboundSetNotReady] = useState(false);

  const [disposition, setDisposition] = useState("");
  const [comments, setComments] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [setNotReadyAfterSave, setSetNotReadyAfterSave] = useState(false);
  const [callLogVersion, setCallLogVersion] = useState(0);

  const [error, setError] = useState("");
  // Per explicit request — AMD/Busy/No Answer end the call
  // automatically, with no disposition form at all (the agent never
  // spoke to anyone). This shows a brief, dismissible notice instead,
  // driven by the "callAutoResolved" WS message.
  const [autoResolvedNotice, setAutoResolvedNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasLeads, setHasLeads] = useState(true); // optimistic default — avoids a flash of "no leads" before the check resolves
  // How many campaigns THIS agent is actually assigned to. Used purely
  // to decide whether "Change campaign" should even be shown — an
  // agent with only one assignment has nothing to change TO, so the
  // control is just noise. Defaults to 2 (not 0/1) so the button
  // doesn't flash-hide before this resolves — fails open toward
  // showing it, never toward hiding a control someone might actually
  // need.
  const [myCampaignCount, setMyCampaignCount] = useState(2);

  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    if (!autoResolvedNotice) return;
    const timeout = setTimeout(() => setAutoResolvedNotice(""), 6000);
    return () => clearTimeout(timeout);
  }, [autoResolvedNotice]);

  useEffect(() => {
    const stored = localStorage.getItem("cmx_dialer_campaign");
    if (!stored) {
      navigate("/select-campaign");
      return;
    }
    setCampaign(JSON.parse(stored));
  }, [navigate]);

  useEffect(() => {
    api
      .getMyCampaigns()
      .then((data) => setMyCampaignCount((data.campaigns || []).length))
      .catch(() => {}); // fail open — keeps the default of 2, so "Change campaign" stays visible rather than silently vanishing on an error
  }, []);

  // Hide "Dial Next Number" entirely for campaigns with no leads at
  // all (e.g. CMXBSMSC, which is inbound-only and relies on the
  // Callback feature instead). Also re-checks every time the agent
  // goes READY, not just once when the campaign first loads — REAL
  // BUG FIX: this used to only run on campaign change, so once
  // hasLeads flipped to false (a real "no leads found" during
  // dialing), the only way back was refreshing the page or switching
  // campaigns and back — even after new leads were added or old ones
  // reset. Re-running it right as the agent becomes able to dial
  // again makes this self-healing with no manual refresh needed.
  useEffect(() => {
    if (!campaign) return;
    if (agentStatus?.status !== "READY") return;
    api
      .hasLeads(campaign.campaign_id)
      .then((data) => setHasLeads(data.hasLead))
      .catch(() => setHasLeads(true)); // fail open — don't hide the button just because this check errored
  }, [campaign, agentStatus?.status]);

  // Per explicit request — agents shouldn't need to switch auxes
  // (toggle their own status) at all to recover once leads are
  // replenished. While hasLeads is false, keep quietly re-checking in
  // the background every 20s; stops on its own the moment it comes
  // back true (this effect re-runs and its own cleanup clears the
  // interval, since hasLeads is in the dependency array). No interval
  // runs at all once hasLeads is true — nothing to recover from.
  useEffect(() => {
    if (!campaign) return;
    if (hasLeads) return;

    const interval = setInterval(() => {
      api
        .hasLeads(campaign.campaign_id)
        .then((data) => setHasLeads(data.hasLead))
        .catch(() => {}); // transient poll failure — just try again next tick
    }, 20000);

    return () => clearInterval(interval);
  }, [campaign, hasLeads]);

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

  // Tracks whether the initial GET /dialer/status fetch has actually
  // RESOLVED (regardless of whether it found an open row) — needed
  // because agentStatus itself starts as null and stays null both
  // while "still loading" AND when "confirmed no open row exists yet"
  // (a genuinely fresh login, before the agent's first-ever status
  // row is created). Without this, those two very different states
  // were indistinguishable, and the stamping effect below could never
  // tell "wait for the fetch" apart from "there's really nothing
  // here, go create it."
  const [statusCheckDone, setStatusCheckDone] = useState(false);

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
      .catch((err) => setError(err.message))
      .finally(() => setStatusCheckDone(true));
  }, []);

  // REAL BUG FIX — per explicit request: right after a genuinely
  // fresh login, the agent has NO open status row at all yet — one is
  // only ever created the moment they manually pick something from
  // the dropdown for the first time. Confirmed directly via the
  // Network tab: no automatic POST /dialer/status ever fired, only
  // the initial GET (which correctly came back with no status). That
  // meant this effect's OWN earlier version — which only handled "an
  // EXISTING row has the wrong/missing campaign" — never had anything
  // to act on, since agentStatus stayed null the whole time. Now
  // handles BOTH real cases: no row at all (create one, defaulting to
  // NOT_READY, correctly tagged from the start) and an existing row
  // with a mismatched campaign (stamp it, as before).
  //
  // campaignStampedRef guards this to run AT MOST ONCE per mount, and
  // the relatedCampaignId comparison (for the "existing row" case)
  // means it's a genuine no-op on every ordinary page refresh AFTER
  // the first correct stamp — critical to not resurrect the earlier
  // "status resets on every refresh" bug (see ws.js's own fix for
  // that), since setStatus() always closes and reopens the row, which
  // must only ever happen when something has actually changed.
  const campaignStampedRef = useRef(false);

  useEffect(() => {
    if (!campaign) return;
    if (!statusCheckDone) return; // still waiting to know whether a row already exists
    if (campaignStampedRef.current) return;

    if (!agentStatus) {
      // Confirmed: no status row exists at all — create the very
      // first one now, correctly tagged, instead of leaving the agent
      // with no status (and invisible on the Live Dashboard) until
      // they happen to touch the dropdown themselves.
      campaignStampedRef.current = true;
      api
        .setStatus("NOT_READY", campaign.campaign_id)
        .then((data) => {
          setAgentStatus(data.status);
          setStatusDraft(data.status.status);
          baseElapsedRef.current = data.status.elapsedSeconds;
          baseAtRef.current = Date.now();
        })
        .catch(() => {
          campaignStampedRef.current = false;
        });
      return;
    }

    if (agentStatus.relatedCampaignId === campaign.campaign_id) {
      campaignStampedRef.current = true;
      return;
    }

    campaignStampedRef.current = true;
    api
      .setStatus(agentStatus.status, campaign.campaign_id)
      .then((data) => {
        setAgentStatus(data.status);
        baseElapsedRef.current = data.status.elapsedSeconds;
        baseAtRef.current = Date.now();
      })
      .catch(() => {
        campaignStampedRef.current = false; // allow a retry on the next render if this failed
      });
  }, [campaign, agentStatus, statusCheckDone]);

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

  useDialerSocketMessages((message) => {
    if (message.type === "forceLogout") {
      const reasonText =
        message.reason === "kicked_by_admin"
          ? "An administrator has logged you out."
          : message.reason === "session_timeout_12h"
            ? "You've been automatically logged out after 12 hours. Please log back in."
            : "You've been logged out.";
      window.alert(reasonText);
      navigate("/login");
      return;
    }

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

    // Per explicit request — AMD/Busy/No Answer end the call
    // automatically on the backend, with no disposition form (the
    // agent never spoke to anyone). Mirrors handleSaveDisposition's
    // own cleanup below, since there's no form submission here to
    // react to locally — this WS message is the ONLY signal the
    // frontend gets that the call is over.
    if (message.type === "callAutoResolved") {
      setCall((prev) => (prev && prev.callId === message.callId ? null : prev));
      setLead((prev) => (prev ? null : prev));
      setDisposition("");
      setComments("");
      setCallbackAt("");
      setSetNotReadyAfterSave(false);
      setCallLogVersion((v) => v + 1);

      const label =
        message.outcome === "machine"
          ? "Answering machine detected — moved to the next lead."
          : message.outcome === "busy"
            ? "Line was busy — moved to the next lead."
            : "No answer — moved to the next lead.";
      setAutoResolvedNotice(label);
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
  // dropdown options).
  //
  // AFTER_CALL_WORK previously only locked the dropdown when call+lead
  // were both set (outbound-only) — the reasoning at the time claimed
  // "inbound calls have no disposition step at all," which is simply
  // wrong: inbound has its own full disposition form (see
  // getInboundDispositionsForCampaign/handleSaveInboundDisposition
  // below), and inboundCallService.js genuinely does set
  // AFTER_CALL_WORK too. The old narrow condition was a real bug,
  // confirmed live: whenever call/lead happened to be null while
  // status was still genuinely AFTER_CALL_WORK, the dropdown
  // incorrectly unlocked, letting an agent switch status without ever
  // saving a disposition — exactly what the backend's own POST
  // /dialer/status guard (added the same session) was built to
  // prevent, but the frontend wasn't matching that same simple rule.
  const isSystemStatus =
    agentStatus?.status === "IN_CALL" ||
    agentStatus?.status === "ON_HOLD" ||
    agentStatus?.status === "MICROSIP_OUTBOUND" ||
    agentStatus?.status === "AFTER_CALL_WORK";
  const isCallActive = call && call.status !== "ended";

  async function handleStatusSwitch() {
    setError("");
    setBusy(true);
    try {
      const data = await api.setStatus(statusDraft, campaign?.campaign_id);
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
      // REAL BUG FIX: when the lead pool is genuinely exhausted, the
      // backend correctly returns 404 ("No eligible leads found for
      // this campaign right now") — but nothing here used to update
      // `hasLeads`, so the auto-dial effect (which gates on hasLeads)
      // kept seeing it as still true and immediately retried the exact
      // same failing call, forever, in a tight loop — confirmed live:
      // hundreds of identical 404s per second flooding the console.
      // Now explicitly detects this case (status 404) and flips
      // hasLeads to false, which the auto-dial effect's own guard
      // (`if (!hasLeads) return;`) then correctly respects — stopping
      // the loop and showing a calm, expected message instead of a
      // scary red error banner.
      if (err.status === 404) {
        setHasLeads(false);
      } else if (err.status === 403) {
        // Outside this campaign's configured calling hours — same
        // "stop cleanly, don't retry in a loop" treatment as the
        // no-leads case, just a different underlying reason.
        setHasLeads(false);
        setError(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  // AUTO-DIAL TRIGGER — per explicit request: campaigns set to Auto
  // Dial (campaign.dial_method === "RATIO", see campaignRoutes.js's
  // AUTO -> RATIO mapping) should dial automatically the moment the
  // agent is READY, rather than requiring a manual "Dial Next Number"
  // click. Deliberately reuses the EXACT same condition that already
  // governs whether that button renders at all (READY, no active
  // call, hasLeads) — see the JSX below — so this can never fire in a
  // state where the button itself wouldn't have been clickable.
  //
  // This is NOT the full auto-dial engine (no ratio/pacing across
  // multiple agents, no dialing ahead of agent availability) — it's
  // the simpler "auto-advance instead of manual click" behavior this
  // specific request describes. Calling hours / max-attempt caps from
  // the Autodial Rules admin section aren't enforced here yet either —
  // those still require the actual engine (a separate, future build)
  // to read and apply them; this only removes the manual button click.
  //
  // autoDialInFlightRef guards against any brief double-fire from
  // React re-running this effect while handleDialNext's own async work
  // is still settling — busy alone isn't quite enough since state
  // updates aren't synchronous.
  const autoDialInFlightRef = useRef(false);

  useEffect(() => {
    const isAutoDialCampaign = campaign?.dial_method === "RATIO";
    if (!isAutoDialCampaign) return;
    if (campaign?.campaign_type === "BLENDED") return; // Blended campaigns never have leads by design
    if (agentStatus?.status !== "READY") return;
    if (call) return;
    if (!hasLeads) return;
    if (busy) return;
    if (autoDialInFlightRef.current) return;

    autoDialInFlightRef.current = true;
    handleDialNext().finally(() => {
      autoDialInFlightRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign, agentStatus, call, hasLeads, busy]);

  // Callback: reuses the same startCall path as "Dial Next Number" but
  // skips getNextLead entirely — the row from Call Logs already has
  // everything needed. Outbound-sourced rows carry a real lead_id
  // (added to getCallLog specifically for this), so their disposition
  // still updates vicidial_list correctly; inbound-sourced rows have
  // no real lead at all, so lead_id falls back to 0 (a harmless no-op
  // for that UPDATE).
  async function handleCallBack(row) {
    if (agentStatus?.status !== "READY") {
      setError("You must be Ready to place a callback.");
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
        // Prefers callback_number when present — trunk-line calls show
        // the TRUNK's own Caller ID in phone_number, not the actual
        // customer's, so callback_number (manually entered by the
        // agent during disposition) is the reliable one to actually
        // dial for a callback. Falls back to phone_number for rows
        // that never had a callback_number recorded (outbound-sourced
        // rows, or calls predating this field).
        phone_number: row.callback_number || row.phone_number,
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

  // Manual dial (from MiniPhone's number field): identical tracked-call
  // path as Callback — same disposition enforcement, same Call Logs
  // entry — just no source row, so lead_id is always 0 (matches
  // inbound-sourced Callback rows, which have no real lead either).
  async function handleManualDial(phoneNumber) {
    if (agentStatus?.status !== "READY") {
      setError("You must be Ready to place a call.");
      return;
    }
    if (call || inboundCall) {
      setError("You're already on a call.");
      return;
    }

    setError("");
    setBusy(true);
    try {
      const manualLead = { lead_id: 0, first_name: "", last_name: "", phone_number: phoneNumber };
      setLead(manualLead);

      const callData = await api.startCall(campaign.campaign_id, 0, phoneNumber, manualLead, "REGULAR");
      setCall({ callId: callData.callId, room: callData.room, status: "ringing_agent", callType: "REGULAR" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Conference / Blind Transfer — both act on whichever call (outbound
  // or inbound) is currently live; the backend figures out which one
  // via resolveActiveRoom(), so nothing here needs to know or care
  // which direction the active call is. Errors are intentionally NOT
  // caught here — MiniPhone owns its own busy/error state for these
  // two actions and needs the rejection to reach it.
  function handleConferenceAdd(target, isExtension) {
    return api.conferenceAdd(target, isExtension);
  }

  function handleTransferBlind(target, isExtension) {
    return api.transferBlind(target, isExtension);
  }

  // Same pass-through pattern as Conference/Transfer above — MiniPhone
  // owns its own busy/error state for these, errors intentionally
  // reach it uncaught.
  function handleStartLineTwo(target, isExtension) {
    return api.startLineTwo(target, isExtension);
  }

  function handleCompleteLineTwo(action) {
    return api.completeLineTwo(action);
  }

  function handleCancelLineTwo() {
    return api.cancelLineTwo();
  }

  function handleSwitchLine(line) {
    return api.switchLine(line);
  }

  function handleGetLineTwoStatus() {
    return api.getLineTwoStatus();
  }

  function handleHoldLineTwo() {
    return api.holdLineTwo();
  }

  function handleUnholdLineTwo() {
    return api.unholdLineTwo();
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

  // Unified hold toggle for MiniPhone — picks whichever call (outbound
  // or inbound) is actually active, same "MiniPhone doesn't need to
  // know which direction" pattern already used for Conference/Transfer.
  function handlePhoneToggleHold() {
    if (call) return handleToggleHold();
    if (inboundCall) return handleToggleInboundHold();
  }

  // Unified hang-up for MiniPhone — calling api.endCall/endInboundCall
  // (not just JsSIP's own phone.hangup()) is REQUIRED, not optional:
  // those backend functions hang up BOTH the customer's and the
  // agent's channel via AMI AND explicitly trigger markCallEnded (the
  // thing that actually sets AFTER_CALL_WORK). JsSIP's hangup() alone
  // only ever touches the agent's own leg locally — it never reaches
  // any of that. This was a real, confirmed regression from removing
  // the old explicit End Call button: agent-initiated hangups stopped
  // ending the call/triggering disposition at all, only the far end
  // hanging up still worked (since THAT path is driven by AMI Hangup/
  // ConfbridgeLeave events on the customer channel, untouched by this
  // bug). MiniPhone's own phone.hangup() still runs too, right after —
  // harmless once the channel's already being torn down by AMI, and
  // keeps JsSIP's local session state consistent immediately rather
  // than waiting on the round-trip.
  function handlePhoneHangUp() {
    if (call) {
      api.endCall(call.callId).catch((err) => setError(err.message));
    } else if (inboundCall) {
      api.endInboundCall(inboundCall.callId).catch((err) => setError(err.message));
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
        callbackNumber: inboundCallbackNumber.trim() || undefined,
        setNotReady: inboundSetNotReady,
      });

      setInboundCall(null);
      setInboundFirstName("");
      setInboundLastName("");
      setInboundComments("");
      setInboundCallbackNumber("");
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
    // Defense-in-depth, per explicit request — mirrors the button's
    // own disabled condition below. The button itself is the primary
    // guard; this just prevents the same action if somehow triggered
    // another way (e.g. dev tools) while not actually Not Ready.
    if (isCallActive || agentStatus?.status !== "NOT_READY") return;
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

  // UPDATED — Dialer Page is now restricted to agent/supervisor/
  // training_quality per the finished access-level matrix.
  // account_manager/wfm/admin no longer land here at all, even if
  // they happen to have a phone extension bound — those three roles
  // don't include Dialer Page access per the spec as given. Placed
  // after all hooks above (React rules — hooks must run unconditionally
  // every render) but before the phone-extension check below, same
  // pattern as LiveStatusDashboard.jsx's own role guard.
  if (agent && !["agent", "supervisor", "training_quality"].includes(agent.accessLevel)) {
    return <Navigate to="/" replace />;
  }

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
            {myCampaignCount >= 2 && (
              <button
                type="button"
                className="link"
                style={{ padding: 0 }}
                onClick={handleChangeCampaign}
                // Per explicit request — only allow switching campaigns
                // while specifically Not Ready, not just "no active
                // call." Ready/on-hold/ACW/break-type statuses are all
                // still "in service" states; switching mid-shift risks
                // exactly the class of stale-campaign-assignment bug
                // fixed earlier tonight (an agent's related_campaign_id
                // needs to correctly reflect which campaign they're
                // ACTIVELY working, not just what they were last on).
                disabled={isCallActive || agentStatus?.status !== "NOT_READY"}
                title={
                  agentStatus?.status !== "NOT_READY"
                    ? "Set your status to Not Ready before switching campaigns"
                    : undefined
                }
              >
                Change campaign
              </button>
            )}
            {/* TEMPORARILY DISABLED — cmx_scn_suite's cross-app auth
                config isn't correct yet on their end (ORIGIN_APP_VERIFY_URL
                pointing at the wrong server/path, secret needs
                confirming). Re-enable once that's fixed — see Phase 7
                doc, targeted for Monday.
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
            */}
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {autoResolvedNotice && <div className="badge">{autoResolvedNotice}</div>}

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

            {/* All phone/JsSIP logic now lives in MiniPhone — DialerPage
                supplies agent status (for auto-answer gating) and the
                handlers for manual dial / conference / transfer, which
                all need campaign/call context that lives here, not in
                MiniPhone. Moved here from the top of the page, where
                Stats used to be — swapped per redesign request. */}
            <MiniPhone
              agentStatus={agentStatus?.status}
              hasActiveCall={Boolean(call || inboundCall)}
              campaignId={campaign?.campaign_id}
              canHold={Boolean(
                (call && call.status === "customer_connected") ||
                  (inboundCall && inboundCall.status === "agent_connected")
              )}
              onHold={Boolean(call?.onHold || inboundCall?.onHold)}
              onToggleHold={handlePhoneToggleHold}
              onHangUp={handlePhoneHangUp}
              onManualDial={handleManualDial}
              onTransferBlind={handleTransferBlind}
              onStartLineTwo={handleStartLineTwo}
              onCompleteLineTwo={handleCompleteLineTwo}
              onCancelLineTwo={handleCancelLineTwo}
              onSwitchLine={handleSwitchLine}
              onGetLineTwoStatus={handleGetLineTwoStatus}
              onHoldLineTwo={handleHoldLineTwo}
              onUnholdLineTwo={handleUnholdLineTwo}
            />

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

            {/* Hold moved into MiniPhone (see phone-widget) — End Call
                removed entirely; JsSIP's own Hang Up already tears down
                the agent's leg, which the backend's existing Hangup/
                ConfbridgeLeave handlers already treat identically to
                the old explicit End Call action. */}

            {/* Shown immediately, editable throughout the call so the
                agent can take notes live — not gated behind the call
                having ended. */}
            <div style={{ marginTop: 12 }}>
              <label className="comments-label">Caller ID</label>
              <input type="text" value={inboundCall.callerIdNumber || "Unknown"} readOnly />

              <label className="comments-label">Callback Number</label>
              <input
                type="tel"
                value={inboundCallbackNumber}
                onChange={(e) => setInboundCallbackNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
                placeholder="10-digit US number, no country code (e.g. 6468016974)"
                maxLength={10}
                inputMode="numeric"
              />

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
                {getInboundDispositionsForCampaign(campaign?.campaign_id).map((d) => (
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

            {/* Blended campaigns (e.g. CMXBSMSC) never have leads by
                design — they're inbound + Callback only, per explicit
                confirmation. Excluding campaign_type === "BLENDED"
                here so this whole area (button/badge/no-leads message)
                stays hidden for them entirely, rather than showing a
                technically-true-but-meaningless "No leads to dial"
                message on a campaign that was never supposed to have
                any. */}
            {(() => {
              const isBlendedCampaign = campaign?.campaign_type === "BLENDED";
              return (
                <>
                  {agentStatus?.status === "READY" &&
                    !call &&
                    hasLeads &&
                    !isBlendedCampaign &&
                    campaign?.dial_method !== "RATIO" && (
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

                  {agentStatus?.status === "READY" &&
                    !call &&
                    hasLeads &&
                    !isBlendedCampaign &&
                    campaign?.dial_method === "RATIO" && (
                      <div className="card">
                        <span className="badge">{busy ? "Dialing…" : "Auto Dial Active"}</span>
                      </div>
                    )}

                  {/* Shown once the lead pool is confirmed exhausted (a
                      real 404 from /dialer/next-lead, not a transient
                      error) — without this, the button/badge above
                      would just vanish with no explanation once
                      hasLeads flips to false. */}
                  {agentStatus?.status === "READY" && !call && !hasLeads && !isBlendedCampaign && (
                    <div className="card">
                      <span className="badge">No leads to dial — the lead list for this campaign is complete.</span>
                    </div>
                  )}
                </>
              );
            })()}

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
                {/* Hold moved into MiniPhone (see phone-widget) — End
                    Call removed entirely; JsSIP's own Hang Up already
                    tears down the agent's leg, which the backend's
                    existing Hangup/ConfbridgeLeave handlers already
                    treat identically to the old explicit End Call
                    action (same as how ending a call via any physical
                    phone hangup has always worked). */}

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
                  {getOutboundDispositionsForCampaign(campaign?.campaign_id).map((d) => (
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

            {/* Stats moved here per redesign request — right column,
                above Call Logs, each stat as its own card. */}
            <StatsPanel refreshKey={callLogVersion} campaignId={campaign?.campaign_id} />

            <CallLogTable
              refreshKey={callLogVersion}
              campaignId={campaign?.campaign_id}
              onCallBack={handleCallBack}
              canCallBack={agentStatus?.status === "READY"}
            />
          </div>
        </div>
      </div>
    </>
  );
}
