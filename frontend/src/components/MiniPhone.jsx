import { useEffect, useRef, useState } from "react";
import { useJsSipPhone } from "../hooks/useJsSipPhone";
import InternalTransferModal from "../modals/InternalTransferModal";

/*
==================================================
MiniPhone — self-contained softphone widget, styled to read like a
physical phone (status line, number display, circular action buttons)
without an actual dial-pad keypad.

Owns the useJsSipPhone hook entirely; DialerPage never touches JsSIP
directly. DialerPage supplies:
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
}) {
  const phone = useJsSipPhone();
  const autoAnsweredCallRef = useRef(null); // guards against re-answering the same ring on every re-render

  const [dialNumber, setDialNumber] = useState("");
  const [isMuted, setIsMuted] = useState(false);

  // UPDATED — per explicit request: real attended transfer, like a
  // traditional phone's Line 1/Line 2. The number field + Internal
  // Transfer picker below now START Line 2 (puts the customer on
  // hold, privately dials the target) instead of instantly adding
  // them to the live call. Once Line 2 answers, lineTwoActive flips
  // true and a separate decision row appears: Transfer (complete the
  // handoff, hang up), Conference (bring everyone together, stay on),
  // or Cancel (hang up Line 2, go back to the original customer).
  const [targetInput, setTargetInput] = useState("");
  const [targetError, setTargetError] = useState("");
  const [lineTwoActive, setLineTwoActive] = useState(false);
  const [lineTwoBusy, setLineTwoBusy] = useState(false);

  // Per explicit request — separate from the shared number field
  // entirely: "Internal Transfer" opens a picker listing real agents
  // on the same campaign.
  const [showInternalTransferModal, setShowInternalTransferModal] = useState(false);

  async function handleStartLineTwo() {
    if (!targetInput.trim()) return;
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onStartLineTwo(targetInput.trim(), false);
      setLineTwoActive(true);
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
      setLineTwoActive(true);
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
      setLineTwoActive(false);
    } catch (err) {
      if (err.reason === "customer_disconnected") {
        // The original customer already hung up while on hold —
        // Line 2's party is still genuinely connected to the agent,
        // just no longer as "Line 2" (the backend promoted it to the
        // primary call). Drop back to the normal single-call view
        // rather than showing this as a plain failure, but still
        // surface what happened.
        setLineTwoActive(false);
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
      setLineTwoActive(false);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

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
    // phone's functions are stable across renders (see useJsSipPhone —
    // answer/hangup/toggleMute/dial don't change identity), so only
    // the actual state values need to be dependencies here.
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
      setLineTwoActive(false);
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
          className="phone-btn phone-btn-mute"
          onClick={handleToggleMute}
          disabled={!isActive}
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          className="phone-btn phone-btn-mute"
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
          // Hang Up is disabled while a Line 2 action is actually in
          // flight (starting, completing, or canceling) — re-enabled
          // the instant it resolves, whether success or failure.
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

      {/* LINE 2 — real attended transfer, per explicit request. While
          not active: dial a target privately (customer goes on hold,
          hears nothing) via the number field or the Internal Transfer
          picker. Once Line 2 answers, this becomes a decision row:
          Transfer (complete the handoff, hang up), Conference (bring
          everyone together, stay on), or Cancel (hang up Line 2, go
          back to the original customer). */}
      {!lineTwoActive ? (
        <>
          <div className="phone-extra-row">
            <input
              type="text"
              placeholder="Phone number"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              disabled={!isActive || lineTwoBusy}
            />
            <button
              type="button"
              className="button-secondary"
              onClick={handleStartLineTwo}
              disabled={!isActive || lineTwoBusy || !targetInput.trim()}
            >
              {lineTwoBusy ? "Calling…" : "Call Line 2"}
            </button>
          </div>
          {targetError && <div className="error phone-extra-error">{targetError}</div>}

          {/* Separate from the number field entirely, per explicit
              request — opens a picker to choose an agent for Line 2. */}
          <button
            type="button"
            className="button-secondary"
            style={{ marginTop: 8 }}
            onClick={() => setShowInternalTransferModal(true)}
            disabled={!isActive || lineTwoBusy || !campaignId}
          >
            Internal Transfer
          </button>
        </>
      ) : (
        <div className="phone-extra-row" style={{ flexWrap: "wrap" }}>
          <span className="badge">Line 2 connected — customer is on hold</span>
          <button
            type="button"
            className="button-secondary"
            onClick={() => handleCompleteLineTwoClick("transfer")}
            disabled={lineTwoBusy}
          >
            Transfer
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => handleCompleteLineTwoClick("conference")}
            disabled={lineTwoBusy}
          >
            Conference
          </button>
          <button type="button" className="link" onClick={handleCancelLineTwoClick} disabled={lineTwoBusy}>
            Cancel — back to customer
          </button>
          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </div>
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
