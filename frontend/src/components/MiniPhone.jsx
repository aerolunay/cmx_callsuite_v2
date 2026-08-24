import { useEffect, useRef, useState } from "react";
import { useJsSipPhone } from "../hooks/useJsSipPhone";

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
  - onConferenceAdd(target, isExtension) / onTransferBlind(target,
    isExtension): add a participant to / hand off the live call

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
Up, Mute, Conference, Transfer) — none are conditionally hidden;
each is individually enabled/disabled based on current call state.

The main dial field only accepts digits — it's a phone number field.
The Conference/Transfer "target" fields deliberately still allow
letters, since this app's extensions are named like "bsmsc901", not
purely numeric.

CONFERENCE AND TRANSFER ARE NOT YET CONFIRMED against a real test
call — the backend primitive they call (conferenceService.js) is new
tonight and hasn't been exercised live. Expect this to need debugging
the same way every other Asterisk-facing change has tonight.

ATTENDED TRANSFER IS NOT IMPLEMENTED — only blind transfer (hand off
and immediately leave) exists right now. Attended (talk to the target
privately first) needs real ConfBridge/AMI bridge-manipulation work
deliberately left for a separate pass rather than guessed at here.
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
  canHold,
  onHold,
  onToggleHold,
  onHangUp,
  onManualDial,
  onConferenceAdd,
  onTransferBlind,
}) {
  const phone = useJsSipPhone();
  const autoAnsweredCallRef = useRef(null); // guards against re-answering the same ring on every re-render

  const [dialNumber, setDialNumber] = useState("");
  const [isMuted, setIsMuted] = useState(false);

  const [addTarget, setAddTarget] = useState("");
  const [addIsExtension, setAddIsExtension] = useState(true);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const [transferTarget, setTransferTarget] = useState("");
  const [transferIsExtension, setTransferIsExtension] = useState(true);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState("");

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
      setAddTarget("");
      setAddError("");
      setTransferTarget("");
      setTransferError("");
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

  async function handleAddParticipant(e) {
    e.preventDefault();
    if (!addTarget.trim()) return;
    setAddError("");
    setAddBusy(true);
    try {
      await onConferenceAdd(addTarget.trim(), addIsExtension);
      setAddTarget("");
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddBusy(false);
    }
  }

  async function handleTransfer(e) {
    e.preventDefault();
    if (!transferTarget.trim()) return;
    setTransferError("");
    setTransferBusy(true);
    try {
      await onTransferBlind(transferTarget.trim(), transferIsExtension);
      setTransferTarget("");
    } catch (err) {
      setTransferError(err.message);
    } finally {
      setTransferBusy(false);
    }
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
          disabled={!isIncoming && !isActive}
          title={isIncoming ? "Decline" : "Hang Up"}
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

      <form onSubmit={handleAddParticipant} className="phone-extra-row">
        <input
          type="text"
          placeholder="Extension or number"
          value={addTarget}
          onChange={(e) => setAddTarget(e.target.value)}
          disabled={!isActive || addBusy}
        />
        <label className="phone-extra-checkbox">
          <input
            type="checkbox"
            checked={addIsExtension}
            onChange={(e) => setAddIsExtension(e.target.checked)}
            disabled={!isActive || addBusy}
          />
          Ext
        </label>
        <button type="submit" className="button-secondary" disabled={!isActive || addBusy || !addTarget.trim()}>
          {addBusy ? "Adding…" : "Conference"}
        </button>
      </form>
      {addError && <div className="error phone-extra-error">{addError}</div>}

      <form onSubmit={handleTransfer} className="phone-extra-row">
        <input
          type="text"
          placeholder="Extension or number"
          value={transferTarget}
          onChange={(e) => setTransferTarget(e.target.value)}
          disabled={!isActive || transferBusy}
        />
        <label className="phone-extra-checkbox">
          <input
            type="checkbox"
            checked={transferIsExtension}
            onChange={(e) => setTransferIsExtension(e.target.checked)}
            disabled={!isActive || transferBusy}
          />
          Ext
        </label>
        <button type="submit" className="button-secondary" disabled={!isActive || transferBusy || !transferTarget.trim()}>
          {transferBusy ? "Transferring…" : "Transfer"}
        </button>
      </form>
      {transferError && <div className="error phone-extra-error">{transferError}</div>}
    </div>
  );
}
