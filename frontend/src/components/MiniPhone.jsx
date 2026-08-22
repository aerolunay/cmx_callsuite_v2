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
  - onManualDial(phoneNumber): places a tracked outbound call, same
    disposition-enforced path as Callback/Dial Next Number
  - onConferenceAdd(target, isExtension) / onTransferBlind(target,
    isExtension): add a participant to / hand off the live call

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

function statusLabel(phone) {
  if (phone.registrationError) return `Error — ${phone.registrationError}`;
  if (!phone.registered) return "Connecting…";
  if (phone.callState === phone.CALL_STATES.INCOMING) {
    return `Incoming — ${phone.remoteIdentity || "Unknown"}`;
  }
  if (phone.callState === phone.CALL_STATES.ACTIVE) {
    return `On call — ${phone.remoteIdentity || "Unknown"}`;
  }
  return "Ready";
}

export function MiniPhone({ agentStatus, hasActiveCall, onManualDial, onConferenceAdd, onTransferBlind }) {
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
        <span className={`phone-status-dot${phone.registered ? " phone-status-dot-on" : ""}`} />
        {statusLabel(phone)}
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
          className="phone-btn phone-btn-end"
          onClick={phone.hangup}
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
