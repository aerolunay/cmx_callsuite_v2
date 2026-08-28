import { useEffect, useRef, useState } from "react";
import { usePhone } from "../context/PhoneContext";
import InternalTransferModal from "../modals/InternalTransferModal";

/*
==================================================
MiniPhone — self-contained softphone widget, styled to read like a
physical phone (status line, number display, circular action buttons)
without an actual dial-pad keypad.

Consumes the app-wide PhoneContext (see context/PhoneContext.jsx —
the actual JsSIP connection lives there now, not here, so it survives
navigating away from and back to this page); DialerPage never touches
JsSIP directly. DialerPage supplies:
  - agentStatus: gates auto-answer (see isAutoAnswerStatus below)
  - hasActiveCall: whether the APP's own tracked call/inboundCall is
    live right now — the authoritative "on a call" signal, distinct
    from phone.callState (which only reflects the JsSIP audio session)
  - onHold / onToggleHold: the app-level hold state and toggle — Hold
    lives here now instead of in the separate call-status cards; it
    operates on the CUSTOMER's channel (via AMI Redirect), a different
    layer than JsSIP's own answer/hangup/mute, which only ever touch
    the agent's own leg.
  - onManualDial(phoneNumber): places a tracked outbound call, same
    disposition-enforced path as Callback/Dial Next Number
  - onStartLineTwo(target, isExtension) / onCompleteLineTwo(action) /
    onCancelLineTwo(): real attended transfer, per explicit request —
    a traditional phone's Line 1/Line 2 model. Starting Line 2 puts
    the ORIGINAL customer on hold (they hear nothing) while the agent
    privately dials and talks to a new target on a separate line.
    Completing brings the customer in — either as a handoff (Transfer,
    agent leaves) or a true 3-way (Conference, agent stays). Canceling
    hangs up Line 2 and restores the original call exactly as it was.
    See attendedTransferService.js on the backend for the full design.

HANG UP correctness: initially, removing the separate End Call button
and relying solely on JsSIP's phone.hangup() (agent-leg-only) was a
REAL, CONFIRMED regression — agent-initiated hangups stopped ending
the call or triggering AFTER_CALL_WORK at all; only the customer
hanging up still worked, since that path is driven by AMI Hangup/
ConfbridgeLeave events on the CUSTOMER's channel, untouched by an
agent-only hangup. Fixed: the Hang Up button now calls
onHangUp (DialerPage's api.endCall/endInboundCall — which hangs up
BOTH channels via AMI and explicitly triggers markCallEnded) before
also calling phone.hangup() for JsSIP's own local cleanup.

ALL action buttons are always rendered (Answer, Decline, Call, Hang
Up, Mute) — none are conditionally hidden; each is individually
enabled/disabled based on current call state. Line 2's own controls
DO swap between two distinct rows (dial vs. decide) — that's a real
state machine, not just a disabled/enabled toggle.

The main dial field only accepts digits — it's a phone number field.
Line 2's target field deliberately still allows letters, since this
app's extensions are named like "bsmsc901", not purely numeric.
==================================================
*/

// Only a genuinely READY agent is ever claimed for a call in the first
// place (see agentStatusService's ready-agent lookup) — but the
// backend flips status to IN_CALL the moment it claims that agent,
// BEFORE Originate ever rings the phone (see inboundCallService.js).
// So by the time JsSIP's incoming RTCSession actually arrives here,
// agentStatus is already IN_CALL, never still READY — checking for
// READY alone meant auto-answer could never fire on a real call.
// IN_CALL at this exact moment (an incoming ring with no active
// session yet) is the normal, expected result of having just been
// READY a moment ago, not a different manual status the agent chose.
const isAutoAnswerStatus = (status) => status === "READY" || status === "IN_CALL";

// Same small label set as LiveStatusDashboard.jsx's STATE_LABELS —
// kept as its own local copy rather than a shared import, matching
// this app's existing pattern of small, genuinely duplicated helpers
// (e.g. recordingPathForCall) rather than coupling two otherwise
// unrelated components/pages together for one lookup table.
const AGENT_STATUS_LABELS = {
  READY: "Ready",
  NOT_READY: "Not Ready",
  IN_CALL: "On a Call",
  ON_HOLD: "On Hold",
  AFTER_CALL_WORK: "ACW",
  AD_HOC: "Ad-Hoc",
  LUNCH_BREAK: "Lunch/Break",
  BIO_BREAK: "Bio-Break",
  ADMIN: "Admin",
  MEETING: "Meeting",
  TRAINING: "Training",
  MICROSIP_OUTBOUND: "MicroSIP Call",
};

/*
==================================================
statusLabel / statusDotClass — REAL BUG FIX
==================================================
Previously this always showed "Ready" (green dot) whenever the phone
was registered and not actively ringing/on a call — completely
ignoring the agent's actual selected status. An agent set to
NOT_READY, LUNCH_BREAK, etc. still saw a green "Ready" indicator on
the phone widget itself the moment they weren't literally mid-call,
which is exactly backwards from what the dropdown elsewhere on the
page said — a real source of confusion/arguable ambiguity for agents
("the phone says I'm Ready"). Now reads the real `agentStatus` prop
(already passed down from DialerPage, previously unused here) whenever
the phone itself is idle, and only shows a green dot / "Ready" text
when the agent is ACTUALLY in READY status — any other status shows
its own real label with a distinct (non-green) dot color.
==================================================
*/
function statusLabel(phone, agentStatus) {
  if (phone.registrationError) return `Error — ${phone.registrationError}`;
  if (!phone.registered) return "Connecting…";
  if (phone.callState === phone.CALL_STATES.INCOMING) {
    return `Incoming — ${phone.remoteIdentity || "Unknown"}`;
  }
  if (phone.callState === phone.CALL_STATES.ACTIVE) {
    return `On call — ${phone.remoteIdentity || "Unknown"}`;
  }
  return AGENT_STATUS_LABELS[agentStatus] || "Not Ready";
}

function statusDotClass(phone, agentStatus) {
  if (!phone.registered) return "";
  if (phone.callState === phone.CALL_STATES.INCOMING || phone.callState === phone.CALL_STATES.ACTIVE) {
    return "phone-status-dot-on"; // mid-call is always the "good/active" green state regardless of dropdown status
  }
  return agentStatus === "READY" ? "phone-status-dot-on" : "phone-status-dot-away";
}

export function MiniPhone({
  agentStatus,
  hasActiveCall,
  campaignId,
  canHold,
  onHold,
  onToggleHold,
  onHangUp,
  onManualDial,
  onStartLineTwo,
  onCompleteLineTwo,
  onCancelLineTwo,
  onSwitchLine,
  onGetLineTwoStatus,
  onHoldLineTwo,
  onUnholdLineTwo,
}) {
  const phone = usePhone();
  const autoAnsweredCallRef = useRef(null); // guards against re-answering the same ring on every re-render

  const [dialNumber, setDialNumber] = useState("");
  const [isMuted, setIsMuted] = useState(false);

  // REBUILT (again) — per explicit request, now a genuine two-panel
  // phone widget matching a real 3CX-style two-line layout, not just
  // a supplementary section below the main dial pad. Hold and Switch
  // are now two SEPARATE agent actions (matching the described real
  // workflow: hold Line 1, THEN switch to Line 2, THEN dial) —
  // previously switching also silently held/unheld things itself.
  //
  // viewingLine (LOCAL UI state, 1 or 2) tracks which PANEL is
  // currently shown — DISTINCT from activeLine (the backend's own
  // truth of which room the agent's actual audio is routed to).
  // These two only diverge in one specific case: Line 2 hasn't been
  // dialed yet, so the agent can be VIEWING its empty "enter a
  // number" panel while their audio is still, correctly, on Line 1 —
  // nothing backend-side to do until they actually dial. The moment
  // Line 2 exists, switching tabs always means a real backend switch,
  // and the two stay in sync.
  //
  // lineTwoStatus mirrors the backend's own state: null (Line 2 never
  // started) | { active, status: "ringing"|"connected"|"failed",
  // failureReason, activeLine, line1OnHold, line2OnHold,
  // line2HasConnected }. Refreshed after every Line 2 action (not just
  // polled) so the reciprocal hold-based tab enable/disable logic
  // always reflects the real current state.
  const [targetInput, setTargetInput] = useState("");
  const [targetError, setTargetError] = useState("");
  const [lineTwoStatus, setLineTwoStatus] = useState(null);
  const [activeLine, setActiveLine] = useState(1);
  const [viewingLine, setViewingLine] = useState(1);
  const [lineTwoBusy, setLineTwoBusy] = useState(false);

  const [showInternalTransferModal, setShowInternalTransferModal] = useState(false);

  // Poll Line 2's real status while it's still ringing — this is how
  // the UI learns "no answer" and offers Try Again, since nothing
  // else currently reports that in real time.
  //
  // REAL BUG FIX, confirmed via a real test call: onGetLineTwoStatus
  // used to be in this effect's dependency array. It's a plain
  // function declared fresh on every DialerPage render (not
  // useCallback-memoized), and DialerPage re-renders frequently on
  // its own (stats/call-log polling elsewhere in this app already
  // does this every few seconds) — each of those re-renders passed
  // down a BRAND NEW function reference, which tore down and
  // recreated this effect's setInterval every single time, before it
  // ever got a real chance to fire. Line 2's status polling never
  // actually ran in practice — this is why the UI stayed stuck
  // showing "ringing" indefinitely even once the agent was already
  // genuinely connected and talking to Line 2. onGetLineTwoStatus
  // doesn't capture any state that would go stale by omitting it here
  // — it's just a stable API-call wrapper.
  useEffect(() => {
    if (!lineTwoStatus?.active || lineTwoStatus.status !== "ringing") return;

    const interval = setInterval(async () => {
      try {
        const data = await onGetLineTwoStatus();
        setLineTwoStatus(data);
        setActiveLine(data.activeLine || 1);
      } catch {
        // Transient poll failure — try again next tick rather than
        // treating one missed poll as a real state change.
      }
    }, 1500);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineTwoStatus?.active, lineTwoStatus?.status]);

  async function refreshLineTwoStatus() {
    try {
      const data = await onGetLineTwoStatus();
      setLineTwoStatus(data);
      setActiveLine(data.activeLine || 1);
      return data;
    } catch {
      return null;
    }
  }

  async function handleStartLineTwo() {
    if (!targetInput.trim()) return;
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onStartLineTwo(targetInput.trim(), false);
      await refreshLineTwoStatus();
      setViewingLine(2);
      setTargetInput("");
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handlePickedExtensionStartLineTwo(extension) {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onStartLineTwo(extension, true);
      await refreshLineTwoStatus();
      setViewingLine(2);
      setShowInternalTransferModal(false);
    } catch (err) {
      setTargetError(err.message);
      throw err; // let the modal know it failed too, so its own busy state clears correctly
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleCompleteLineTwoClick(action) {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onCompleteLineTwo(action);
      setLineTwoStatus(null);
      setActiveLine(1);
      setViewingLine(1);
    } catch (err) {
      if (err.reason === "customer_disconnected") {
        // The original customer already hung up while on hold —
        // Line 2's party is still genuinely connected to the agent,
        // just no longer as "Line 2" (the backend promoted it to the
        // primary call). Drop back to the normal single-call view
        // rather than showing this as a plain failure, but still
        // surface what happened.
        setLineTwoStatus(null);
        setActiveLine(1);
        setViewingLine(1);
        setTargetError(err.message);
      } else {
        setTargetError(err.message);
      }
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleCancelLineTwoClick() {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onCancelLineTwo();
      setLineTwoStatus(null);
      setActiveLine(1);
      setViewingLine(1);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  // Clicking a tab is either a pure local view change (Line 2 hasn't
  // been dialed yet — nothing for the backend to do) or a real
  // backend switch (Line 2 already exists, audio needs to actually
  // move). See the state comment above for why these two cases exist.
  async function handleLine1TabClick() {
    if (line1TabDisabled) return;
    if (!lineTwoStatus?.active || activeLine === 1) {
      setViewingLine(1);
      return;
    }
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onSwitchLine(1);
      setActiveLine(1);
      setViewingLine(1);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleLine2TabClick() {
    if (line2TabDisabled) return;
    if (!lineTwoStatus?.active || activeLine === 2) {
      setViewingLine(2);
      return;
    }
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onSwitchLine(2);
      setActiveLine(2);
      setViewingLine(2);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleHoldLineTwoClick() {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onHoldLineTwo();
      await refreshLineTwoStatus();
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleUnholdLineTwoClick() {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onUnholdLineTwo();
      await refreshLineTwoStatus();
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  function handleHangUpLineTwoClick() {
    // "Hang Up" on Line 2's OWN panel means "I'm done with Line 2
    // specifically" — disconnect just that party and return to
    // Line 1, NOT end the agent's entire call. That's exactly what
    // Cancel already does.
    handleCancelLineTwoClick();
  }

  // Reciprocal enable/disable, per explicit request: to switch TO a
  // line, the line you're currently on must be held first (unless
  // Line 2 hasn't connected to anyone yet, in which case there's
  // nothing live to require holding).
  const line1TabDisabled =
    viewingLine === 1 ||
    lineTwoBusy ||
    (activeLine === 2 && lineTwoStatus?.line2HasConnected && !lineTwoStatus?.line2OnHold);

  const line2TabDisabled = viewingLine === 2 || lineTwoBusy || (activeLine === 1 && !onHold);

  // REAL BUG FIX, per explicit request: this error never got cleared
  // once set — confirmed live, a failed (or even a
  // successful-but-misreported, see conferenceService.js's own fix)
  // Conference/Transfer attempt left its error message showing
  // indefinitely, even once the agent moved on to a brand new call
  // entirely. hasActiveCall transitions false->true exactly when a
  // new call actually starts, so clearing it here on that transition
  // means old messages never bleed into a new, unrelated call.
  useEffect(() => {
    if (hasActiveCall) {
      setTargetError("");
    }
  }, [hasActiveCall]);

  useEffect(() => {
    if (
      phone.callState === phone.CALL_STATES.INCOMING &&
      isAutoAnswerStatus(agentStatus) &&
      autoAnsweredCallRef.current !== phone.remoteIdentity
    ) {
      autoAnsweredCallRef.current = phone.remoteIdentity;
      phone.answer();
    }
    if (phone.callState !== phone.CALL_STATES.INCOMING) {
      autoAnsweredCallRef.current = null;
    }
    // phone's functions are stable across renders — actually
    // guaranteed now via useCallback in PhoneContext.jsx (previously
    // just assumed, since the old hook redeclared them every render
    // but MiniPhone simply didn't re-render often enough to expose
    // it) — so only the actual state values need to be dependencies
    // here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.callState, agentStatus, phone.remoteIdentity]);

  // Reset per-call UI state once the call actually ends, so a stale
  // "muted" indicator or leftover transfer/conference target doesn't
  // carry into the next call.
  useEffect(() => {
    if (phone.callState === phone.CALL_STATES.IDLE || phone.callState === phone.CALL_STATES.ENDED) {
      setIsMuted(false);
      setTargetInput("");
      setTargetError("");
      setLineTwoStatus(null);
      setActiveLine(1);
      setViewingLine(1);
    }
  }, [phone.callState]);

  function handleToggleMute() {
    setIsMuted(phone.toggleMute());
  }

  function handleHangUpClick() {
    if (isIncoming) {
      // Declining an incoming ring doesn't end the call for the
      // customer — they're still waiting in the room, and the backend
      // will offer this call to the next ready agent. Only the agent's
      // own not-yet-answered leg needs to go away.
      phone.hangup();
      return;
    }
    // Active call — the REAL hang-up has to go through the backend
    // (see handlePhoneHangUp in DialerPage.jsx for why phone.hangup()
    // alone isn't enough). phone.hangup() still runs too, right after,
    // to keep JsSIP's own local session state consistent immediately.
    onHangUp();
    phone.hangup();
  }

  function handleDialNumberChange(e) {
    // Digits only — this field is a phone number, not an extension
    // (Conference/Transfer targets below deliberately stay free-text,
    // since this app's own extensions are named like "bsmsc901").
    setDialNumber(e.target.value.replace(/\D/g, ""));
  }

  function handleCall() {
    if (!canDial || !dialNumber.trim()) return;
    onManualDial(dialNumber.trim());
    setDialNumber("");
  }

  const isIdle = phone.callState === phone.CALL_STATES.IDLE || phone.callState === phone.CALL_STATES.ENDED;
  const isIncoming = phone.callState === phone.CALL_STATES.INCOMING;
  const isActive = phone.callState === phone.CALL_STATES.ACTIVE;
  const canDial = phone.registered && agentStatus === "READY" && !hasActiveCall && isIdle;

  return (
    <div className="phone-widget">
      <div className="phone-widget-status">
        <span className={`phone-status-dot ${statusDotClass(phone, agentStatus)}`} />
        {statusLabel(phone, agentStatus)}
      </div>

      {/* Line 1 / Line 2 tabs — ALWAYS visible, per explicit request,
          not just once Line 2 has been dialed. Line 2 starts disabled
          and only enables once Line 1 is held; switching back
          requires the SAME of Line 2 once it's actually connected to
          someone — a real reciprocal two-line phone, not just a
          supplementary section. */}
      <div className="phone-line-tabs">
        <button
          type="button"
          className={viewingLine === 1 ? "phone-line-tab phone-line-tab-active" : "phone-line-tab"}
          onClick={handleLine1TabClick}
          disabled={line1TabDisabled}
        >
          Line 1
        </button>
        <button
          type="button"
          className={viewingLine === 2 ? "phone-line-tab phone-line-tab-active" : "phone-line-tab"}
          onClick={handleLine2TabClick}
          disabled={line2TabDisabled}
        >
          Line 2{lineTwoStatus?.status === "ringing" ? " (ringing…)" : ""}
        </button>
      </div>

      {viewingLine === 1 ? (
        <>
          <input
            type="tel"
            className="phone-display-input"
            placeholder="Enter a number"
            value={dialNumber}
            onChange={handleDialNumberChange}
            disabled={!isIdle}
          />

          <div className="phone-actions">
            <button
              type="button"
              className="phone-btn phone-btn-call"
              onClick={isIncoming ? phone.answer : handleCall}
              disabled={isIncoming ? false : !canDial || !dialNumber.trim()}
              title={isIncoming ? "Answer" : "Call"}
            >
              {isIncoming ? "Answer" : "Call"}
            </button>
            <button
              type="button"
              className={`phone-btn phone-btn-mute${isMuted ? " phone-btn-active" : ""}`}
              onClick={handleToggleMute}
              disabled={!isActive}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              className={`phone-btn phone-btn-mute${onHold ? " phone-btn-active" : ""}`}
              onClick={onToggleHold}
              disabled={!canHold}
              title={onHold ? "Unhold" : "Hold"}
            >
              {onHold ? "Unhold" : "Hold"}
            </button>
            <button
              type="button"
              className="phone-btn phone-btn-end"
              onClick={handleHangUpClick}
              // Hang Up is disabled while a Line 2 action is actually
              // in flight — re-enabled the instant it resolves.
              disabled={(!isIncoming && !isActive) || lineTwoBusy}
              title={
                lineTwoBusy
                  ? "Please wait for the Line 2 action to finish"
                  : isIncoming
                    ? "Decline"
                    : "Hang Up"
              }
            >
              {isIncoming ? "Decline" : "Hang Up"}
            </button>
          </div>

          {!canDial && isIdle && (
            <p className="phone-hint">
              {!phone.registered
                ? "Softphone must be registered before dialing."
                : hasActiveCall
                  ? "You're already on a call."
                  : "You must be Ready to place a call."}
            </p>
          )}

          {/* Per explicit request — Internal Transfer lives only on
              Line 1's panel, disabled once Line 2 already has a live
              call (can't start a second Line 2 while one exists). */}
          <button
            type="button"
            className="button-secondary"
            style={{ marginTop: 8, width: "100%" }}
            onClick={() => setShowInternalTransferModal(true)}
            disabled={!isActive || lineTwoBusy || !campaignId || Boolean(lineTwoStatus?.active)}
          >
            Internal Transfer
          </button>

          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </>
      ) : !lineTwoStatus?.active ? (
        // Line 2 tab selected, but nothing dialed yet — an empty
        // panel matching Line 1's own layout. Purely a local view
        // change to get here; nothing backend-side happens until Call
        // is actually clicked.
        <>
          <input
            type="tel"
            className="phone-display-input"
            placeholder="Enter a number"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value.replace(/\D/g, ""))}
            disabled={lineTwoBusy}
          />
          <div className="phone-actions">
            <button
              type="button"
              className="phone-btn phone-btn-call"
              onClick={handleStartLineTwo}
              disabled={lineTwoBusy || !targetInput.trim()}
            >
              {lineTwoBusy ? "Calling…" : "Call"}
            </button>
            <button type="button" className="phone-btn phone-btn-mute" disabled>
              Mute
            </button>
            <button type="button" className="phone-btn phone-btn-mute" disabled>
              Hold
            </button>
            <button type="button" className="phone-btn phone-btn-end" disabled>
              Hang Up
            </button>
          </div>
          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </>
      ) : lineTwoStatus.status === "failed" ? (
        // Per explicit request: if Line 2 doesn't pick up, the agent
        // must be able to try dialing again — reusing the same
        // private room, Line 1 stays held throughout.
        <>
          <div className="error phone-extra-error">Line 2 didn't answer.</div>
          <input
            type="tel"
            className="phone-display-input"
            placeholder="Enter a number"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value.replace(/\D/g, ""))}
            disabled={lineTwoBusy}
          />
          <div className="phone-actions">
            <button
              type="button"
              className="phone-btn phone-btn-call"
              onClick={handleStartLineTwo}
              disabled={lineTwoBusy || !targetInput.trim()}
            >
              {lineTwoBusy ? "Calling…" : "Try Again"}
            </button>
            <button type="button" className="phone-btn phone-btn-mute" disabled>
              Mute
            </button>
            <button type="button" className="phone-btn phone-btn-mute" disabled>
              Hold
            </button>
            <button
              type="button"
              className="phone-btn phone-btn-end"
              onClick={handleCancelLineTwoClick}
              disabled={lineTwoBusy}
            >
              Give Up
            </button>
          </div>
        </>
      ) : (
        // Line 2 is ringing or connected. Mute/Hang Up reuse the same
        // underlying JsSIP session state as Line 1 (isActive) — it's
        // the agent's own single audio session throughout; only WHICH
        // ASTERISK ROOM it's server-side-redirected to changes when
        // switching lines, not the session itself. Hold is genuinely
        // per-line (Line 2's own target), so it's gated on Line 2
        // actually having connected to someone.
        <>
          <input type="tel" className="phone-display-input" value="" disabled placeholder="" />
          <div className="phone-actions">
            <button type="button" className="phone-btn phone-btn-call" disabled>
              {lineTwoStatus.status === "ringing" ? "Ringing…" : "Connected"}
            </button>
            <button
              type="button"
              className={`phone-btn phone-btn-mute${isMuted ? " phone-btn-active" : ""}`}
              onClick={handleToggleMute}
              disabled={!isActive}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              className={`phone-btn phone-btn-mute${lineTwoStatus.line2OnHold ? " phone-btn-active" : ""}`}
              onClick={lineTwoStatus.line2OnHold ? handleUnholdLineTwoClick : handleHoldLineTwoClick}
              disabled={!lineTwoStatus.line2HasConnected || lineTwoBusy}
              title={lineTwoStatus.line2OnHold ? "Unhold Line 2" : "Hold Line 2"}
            >
              {lineTwoStatus.line2OnHold ? "Unhold" : "Hold"}
            </button>
            <button
              type="button"
              className="phone-btn phone-btn-end"
              onClick={handleHangUpLineTwoClick}
              disabled={lineTwoBusy}
              title="Hang up Line 2, return to Line 1"
            >
              Hang Up
            </button>
          </div>

          {/* Replaces Internal Transfer in this context, per explicit
              request — the merge action, agent decides afterward
              (via the normal Hang Up) whether to leave or stay on. */}
          <button
            type="button"
            className="button-secondary"
            style={{ marginTop: 8, width: "100%" }}
            onClick={() => handleCompleteLineTwoClick("conference")}
            disabled={lineTwoBusy}
          >
            Connect Line 1
          </button>

          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </>
      )}

      {showInternalTransferModal && (
        <InternalTransferModal
          campaignId={campaignId}
          onClose={() => setShowInternalTransferModal(false)}
          onTransfer={handlePickedExtensionStartLineTwo}
        />
      )}
    </div>
  );
}
