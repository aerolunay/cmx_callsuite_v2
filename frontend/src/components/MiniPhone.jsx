import { useEffect, useRef, useState } from "react";
import { useJsSipPhone } from "../hooks/useJsSipPhone";
import TransferExtensionModal from "../modals/TransferExtensionModal";

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
  campaignId,
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

  // UPDATED — per explicit request: Conference and Transfer used to
  // each have their own separate input+checkbox+button row. Now one
  // shared number/extension field and one shared "Ext" checkbox feed
  // BOTH actions — the two buttons just act on whatever's currently
  // typed, rather than each button owning its own separate typed
  // value. transferAction tracks which of the two is actually in
  // flight, so only the button that was clicked shows "…ing" while
  // the other stays put, and so a failure from one doesn't get
  // mistakenly attributed to the other.
  const [targetInput, setTargetInput] = useState("");
  const [targetIsExtension, setTargetIsExtension] = useState(true);
  const [targetBusyAction, setTargetBusyAction] = useState(null); // null | "conference" | "transfer"
  const [targetError, setTargetError] = useState("");

  // Per explicit request — separate from the shared number field
  // entirely: a dedicated "Transfer to Extension" button opens a
  // picker modal listing real agents on the same campaign, instead of
  // requiring the extension to be typed blind.
  const [showExtensionPicker, setShowExtensionPicker] = useState(false);

  async function handlePickedExtensionTransfer(extension) {
    setShowExtensionPicker(false);
    setTargetError("");
    setTargetBusyAction("transfer");
    try {
      await onTransferBlind(extension, true);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setTargetBusyAction(null);
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

  async function handleConferenceAdd(e) {
    e.preventDefault();
    if (!targetInput.trim()) return;
    setTargetError("");
    setTargetBusyAction("conference");
    try {
      await onConferenceAdd(targetInput.trim(), targetIsExtension);
      setTargetInput("");
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setTargetBusyAction(null);
    }
  }

  async function handleTransfer() {
    if (!targetInput.trim()) return;
    setTargetError("");
    setTargetBusyAction("transfer");
    try {
      await onTransferBlind(targetInput.trim(), targetIsExtension);
      setTargetInput("");
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setTargetBusyAction(null);
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

      <div className="phone-extra-row">
        <input
          type="text"
          placeholder="Extension or number"
          value={targetInput}
          onChange={(e) => setTargetInput(e.target.value)}
          disabled={!isActive || targetBusyAction !== null}
        />
        <label className="phone-extra-checkbox">
          <input
            type="checkbox"
            checked={targetIsExtension}
            onChange={(e) => setTargetIsExtension(e.target.checked)}
            disabled={!isActive || targetBusyAction !== null}
          />
          Ext
        </label>
        <button
          type="button"
          className="button-secondary"
          onClick={handleTransfer}
          disabled={!isActive || targetBusyAction !== null || !targetInput.trim()}
        >
          {targetBusyAction === "transfer" ? "Transferring…" : "Transfer"}
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={handleConferenceAdd}
          disabled={!isActive || targetBusyAction !== null || !targetInput.trim()}
        >
          {targetBusyAction === "conference" ? "Adding…" : "Conference"}
        </button>
      </div>
      {targetError && <div className="error phone-extra-error">{targetError}</div>}

      {/* Separate from the number field entirely, per explicit
          request — opens a picker instead of requiring a typed
          extension. */}
      <button
        type="button"
        className="button-secondary"
        style={{ marginTop: 8 }}
        onClick={() => setShowExtensionPicker(true)}
        disabled={!isActive || targetBusyAction !== null || !campaignId}
      >
        Transfer to Extension…
      </button>

      {showExtensionPicker && (
        <TransferExtensionModal
          campaignId={campaignId}
          onClose={() => setShowExtensionPicker(false)}
          onSelect={handlePickedExtensionTransfer}
        />
      )}
    </div>
  );
}
