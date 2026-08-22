import { useEffect, useRef } from "react";
import { useJsSipPhone } from "../hooks/useJsSipPhone";

/*
==================================================
MiniPhone — self-contained softphone widget.

Owns the useJsSipPhone hook entirely; DialerPage no longer touches
JsSIP directly at all. Only needs to know the agent's current status
string, purely to gate auto-answer — everything else about the call
(registration, RTCSession lifecycle, audio) lives in here.

AUTO-ANSWER: only fires when agentStatus === "READY" at the moment a
call starts ringing. This deliberately does NOT cover AUX_CB
(callback) calls yet — Originate can also ring the agent during a
manual Callback, but the request that drove this was specifically
"auto answer when set to Ready", so AUX_CB is left requiring a manual
click for now. Extend the check below (`isAutoAnswerStatus`) if that
turns out to be wanted too.
==================================================
*/

const isAutoAnswerStatus = (status) => status === "READY";

export function MiniPhone({ agentStatus }) {
  const phone = useJsSipPhone();
  const autoAnsweredCallRef = useRef(null); // guards against re-answering the same ring on every re-render

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

  return (
    <div>
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

      {phone.callState === phone.CALL_STATES.ACTIVE && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span>On call{phone.remoteIdentity ? ` with ${phone.remoteIdentity}` : ""}</span>
          <button type="button" className="button-secondary" onClick={phone.toggleMute}>
            Mute
          </button>
          <button type="button" className="button-secondary" onClick={phone.hangup}>
            Hang Up
          </button>
        </div>
      )}
    </div>
  );
}
