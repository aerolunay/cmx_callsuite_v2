import { useEffect, useRef, useState } from "react";
import JsSIP from "jssip";
import { api } from "../api";

/*
==================================================
PHASE B — JsSIP core: register as the agent's own extension, answer
inbound RTCSessions.

WHY THIS WORKS FOR BOTH INBOUND AND OUTBOUND WITHOUT BACKEND CHANGES:
dialerService.js and inboundCallService.js both reach the agent via
AMI Originate(Channel: PJSIP/${agent.extension}) — completely agnostic
to what's actually registered there. Today that's a MicroSIP softphone;
once this hook registers JsSIP under the same extension instead, both
call directions ring the browser automatically. This hook's job is
just: register, and answer whatever RTCSession arrives.

MANUAL/AD-HOC DIALING (Phase C) will add a dial(number) path here too
— not wired into any UI yet, but the UA/session plumbing below is
already generic enough to place outgoing calls once that's ready
(session = phone.call(destination, options)).

CONFERENCE (Phase E) rides on Asterisk's ConfBridge — this hook doesn't
need special multi-party logic, since audio mixing happens server-side;
this file only ever manages ONE active RTCSession at a time, matching
how ConfBridge already presents as a single bridged leg to the agent.
==================================================
*/

const CALL_STATES = {
  IDLE: "idle",
  INCOMING: "incoming", // ringing, not yet answered by the agent
  ACTIVE: "active", // answered and connected
  ENDED: "ended",
};

export function useJsSipPhone() {
  const [registered, setRegistered] = useState(false);
  const [registrationError, setRegistrationError] = useState("");
  const [callState, setCallState] = useState(CALL_STATES.IDLE);
  const [remoteIdentity, setRemoteIdentity] = useState("");

  const uaRef = useRef(null);
  const sessionRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Real <audio> element JsSIP attaches the remote stream to. Created
  // once and reused — not rendered by the component tree; playback
  // only, no UI of its own.
  useEffect(() => {
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    remoteAudioRef.current = audioEl;
    return () => {
      audioEl.pause();
      audioEl.srcObject = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      let credentials;
      try {
        const data = await api.getWebrtcCredentials();
        credentials = data.credentials;
      } catch (err) {
        if (!cancelled) setRegistrationError(err.message);
        return;
      }
      if (cancelled) return;

      const { extension, password, wssUrl } = credentials;

      const socket = new JsSIP.WebSocketInterface(wssUrl);
      const ua = new JsSIP.UA({
        sockets: [socket],
        uri: `sip:${extension}@${new URL(wssUrl).hostname}`,
        password,
        // Matches the wizard-generated endpoint's own extension name —
        // Asterisk identifies the endpoint by the auth username, same
        // as any other PJSIP registration.
        authorization_user: extension,
        register: true,
      });

      ua.on("registered", () => {
        if (!cancelled) {
          setRegistered(true);
          setRegistrationError("");
        }
      });

      ua.on("unregistered", () => {
        if (!cancelled) setRegistered(false);
      });

      ua.on("registrationFailed", (e) => {
        if (!cancelled) {
          setRegistered(false);
          setRegistrationError(e.cause || "Registration failed.");
        }
      });

      ua.on("newRTCSession", (data) => {
        const session = data.session;

        // Only one call at a time — matches how a single ConfBridge
        // leg presents to the agent regardless of how many other
        // parties are actually in the room server-side. A second
        // incoming session while one's active gets rejected outright
        // rather than silently dropping the first.
        if (sessionRef.current) {
          if (data.originator === "remote") session.terminate();
          return;
        }

        sessionRef.current = session;
        setRemoteIdentity(session.remote_identity?.uri?.user || "");

        if (data.originator === "remote") {
          setCallState(CALL_STATES.INCOMING);
        } else {
          // Outbound (Phase C manual dial) — already "active" the
          // moment we placed it; JsSIP's own 'progress'/'confirmed'
          // events don't need a separate ringing state here since the
          // agent initiated it deliberately.
          setCallState(CALL_STATES.ACTIVE);
        }

        session.on("accepted", () => setCallState(CALL_STATES.ACTIVE));
        session.on("confirmed", () => setCallState(CALL_STATES.ACTIVE));

        session.on("ended", () => {
          setCallState(CALL_STATES.ENDED);
          sessionRef.current = null;
          if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
        });

        session.on("failed", () => {
          setCallState(CALL_STATES.ENDED);
          sessionRef.current = null;
          if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
        });

        session.on("peerconnection", (e) => {
          e.peerconnection.addEventListener("track", (event) => {
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = event.streams[0];
            }
          });
        });
      });

      ua.start();
      uaRef.current = ua;
    }

    init();

    return () => {
      cancelled = true;
      if (uaRef.current) {
        uaRef.current.stop();
        uaRef.current = null;
      }
    };
  }, []);

  function answer() {
    if (sessionRef.current && callState === CALL_STATES.INCOMING) {
      sessionRef.current.answer({
        mediaConstraints: { audio: true, video: false },
      });
    }
  }

  function hangup() {
    if (sessionRef.current) {
      sessionRef.current.terminate();
    }
  }

  function toggleMute() {
    if (!sessionRef.current) return false;
    const isMuted = sessionRef.current.isMuted().audio;
    if (isMuted) {
      sessionRef.current.unmute({ audio: true });
    } else {
      sessionRef.current.mute({ audio: true });
    }
    return !isMuted;
  }

  // Phase C hook point — not wired to any UI yet. Kept here so the
  // manual-dial work later is additive, not a rewrite of this hook.
  function dial(destination) {
    if (!uaRef.current || !registered || sessionRef.current) return;
    uaRef.current.call(destination, {
      mediaConstraints: { audio: true, video: false },
    });
  }

  return {
    registered,
    registrationError,
    callState,
    remoteIdentity,
    answer,
    hangup,
    toggleMute,
    dial,
    CALL_STATES,
  };
}
