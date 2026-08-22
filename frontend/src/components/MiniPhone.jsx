import { useEffect, useRef, useState } from "react";
import { useJsSipPhone } from "../hooks/useJsSipPhone";

/*
==================================================
MiniPhone — self-contained softphone widget.

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

  function handleDial(e) {
    e.preventDefault();
    if (!dialNumber.trim()) return;
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

  const canDial = phone.registered && agentStatus === "READY" && !hasActiveCall;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        Softphone:{" "}
        {phone.registrationError
          ? `Error — ${phone.registrationError}`
          : phone.registered
            ? "Registered"
            : "Connecting…"}
      </div>

      {phone.callState === phone.CALL_STATES.INCOMING && (
        <div className="error" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span>
            Incoming call{phone.remoteIdentity ? ` — ${phone.remoteIdentity}` : ""}
            {isAutoAnswerStatus(agentStatus) ? " (auto-answering…)" : ""}
          </span>
          {/* Manual Answer/Decline stay available even when auto-answer
              is enabled — the effect above may not have fired yet on
              the very first render tick, and Decline is the only way
              to reject a call that auto-answer wouldn't otherwise
              cover (e.g. agent not in READY). */}
          <button type="button" className="button-primary" onClick={phone.answer}>
            Answer
          </button>
          <button type="button" className="button-secondary" onClick={phone.hangup}>
            Decline
          </button>
        </div>
      )}

      {phone.callState !== phone.CALL_STATES.ACTIVE && phone.callState !== phone.CALL_STATES.INCOMING && (
        <form onSubmit={handleDial} style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            type="tel"
            placeholder="Enter a number to dial"
            value={dialNumber}
            onChange={(e) => setDialNumber(e.target.value)}
            disabled={!canDial}
            style={{ flex: 1 }}
          />
          <button type="submit" className="button-primary" disabled={!canDial || !dialNumber.trim()}>
            Call
          </button>
        </form>
      )}
      {!canDial && phone.callState !== phone.CALL_STATES.ACTIVE && phone.callState !== phone.CALL_STATES.INCOMING && (
        <p style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
          {!phone.registered
            ? "Softphone must be registered before dialing."
            : hasActiveCall
              ? "You're already on a call."
              : "You must be Ready to place a call."}
        </p>
      )}

      {phone.callState === phone.CALL_STATES.ACTIVE && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span>On call{phone.remoteIdentity ? ` with ${phone.remoteIdentity}` : ""}</span>
            <button type="button" className="button-secondary" onClick={handleToggleMute}>
              {isMuted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="button-secondary" onClick={phone.hangup}>
              Hang Up
            </button>
          </div>

          <form onSubmit={handleAddParticipant} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Extension or number"
              value={addTarget}
              onChange={(e) => setAddTarget(e.target.value)}
              disabled={addBusy}
              style={{ flex: 1 }}
            />
            <label style={{ fontSize: 13, whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={addIsExtension}
                onChange={(e) => setAddIsExtension(e.target.checked)}
                disabled={addBusy}
              />{" "}
              Extension
            </label>
            <button type="submit" className="button-secondary" disabled={addBusy || !addTarget.trim()}>
              {addBusy ? "Adding…" : "Conference"}
            </button>
          </form>
          {addError && <div className="error" style={{ marginBottom: 8 }}>{addError}</div>}

          <form onSubmit={handleTransfer} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              placeholder="Extension or number"
              value={transferTarget}
              onChange={(e) => setTransferTarget(e.target.value)}
              disabled={transferBusy}
              style={{ flex: 1 }}
            />
            <label style={{ fontSize: 13, whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={transferIsExtension}
                onChange={(e) => setTransferIsExtension(e.target.checked)}
                disabled={transferBusy}
              />{" "}
              Extension
            </label>
            <button type="submit" className="button-secondary" disabled={transferBusy || !transferTarget.trim()}>
              {transferBusy ? "Transferring…" : "Transfer"}
            </button>
          </form>
          {transferError && <div className="error" style={{ marginTop: 8 }}>{transferError}</div>}
        </div>
      )}
    </div>
  );
}
