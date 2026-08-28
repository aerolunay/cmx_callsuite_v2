import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import JsSIP from "jssip";
import { api } from "../api";
import { useAuth } from "./AuthContext";

/*
==================================================
PhoneProvider — REAL BUG FIX
==================================================
Replaces the old useJsSipPhone hook, which registered/tore down the
actual SIP/WebRTC connection from WITHIN MiniPhone (itself inside
DialerPage) — connect on mount, ua.stop() on unmount. Same root issue
as the WebSocket fix earlier tonight: supervisors/training_quality can
navigate away from Dialer to Reports/Live Dashboard and back, and
every round trip fully disconnected and re-registered the actual
phone from scratch (the "Connecting..." flicker seen in testing).

This matters more than it might first look: the new
InboundCallRedirector auto-redirects back to /dialer the moment a call
starts ringing, specifically so the agent can answer it — but if the
phone itself takes a few seconds to re-register after that redirect,
the call could go unanswered or fail before the SIP connection is even
back up, undermining the whole point of that fix.

Fix: same pattern as DialerSocketContext — the actual connection lives
once, at the top of the app (see main.jsx), and survives every in-app
route change. MiniPhone.jsx consumes it via usePhone() instead of
opening its own.

STABILITY, caught deliberately this time: MiniPhone.jsx's own code
already assumes answer/hangup/toggleMute/dial never change identity
across renders (see its own comment on this) — true by accident in
the old hook (declared fresh every render, but MiniPhone simply didn't
re-render often enough to expose it). Wrapped in useCallback here so
that assumption is actually guaranteed, not just lucky — same lesson
as catching the non-memoized context value earlier tonight.
==================================================
*/

const CALL_STATES = {
  IDLE: "idle",
  INCOMING: "incoming",
  ACTIVE: "active",
  ENDED: "ended",
};

const PhoneContext = createContext(null);

export function PhoneProvider({ children }) {
  const { agent } = useAuth();
  const isLoggedIn = Boolean(agent);

  const [registered, setRegistered] = useState(false);
  const [registrationError, setRegistrationError] = useState("");
  const [callState, setCallState] = useState(CALL_STATES.IDLE);
  const [remoteIdentity, setRemoteIdentity] = useState("");

  const uaRef = useRef(null);
  const sessionRef = useRef(null);
  const sessionIsIncomingRef = useRef(false);
  const registeredRef = useRef(false);
  const remoteAudioRef = useRef(null);

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
    // REAL BUG FIX, confirmed live: an agent who fully logged out (no
    // browser tab open at all, per their own confirmation) still had
    // their SIP endpoint show as Reachable after an Asterisk restart.
    // Root cause: this effect used to run once on mount with an empty
    // dependency array — connecting the instant the app loaded and
    // only disconnecting on a real page unload/full tree unmount. But
    // logging out (within this SPA) just destroys the server-side
    // session and navigates to /login WITHIN THE SAME running React
    // instance — it does NOT unmount PhoneProvider at all, since it
    // sits above the router in main.jsx. The already-established
    // JsSIP connection had no reason to know the session was gone and
    // just kept running indefinitely. Now explicitly gated on
    // AuthContext's own login state, so logging out actually tears
    // the connection down (ua.stop() below), and logging back in
    // (even as a different agent, same tab) correctly re-establishes
    // it fresh.
    if (!isLoggedIn) {
      setRegistered(false);
      setRegistrationError("");
      setCallState(CALL_STATES.IDLE);
      setRemoteIdentity("");
      return;
    }

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
        authorization_user: extension,
        register: true,
      });

      ua.on("registered", () => {
        registeredRef.current = true;
        if (!cancelled) {
          setRegistered(true);
          setRegistrationError("");
        }
      });

      ua.on("unregistered", () => {
        registeredRef.current = false;
        if (!cancelled) setRegistered(false);
      });

      ua.on("registrationFailed", (e) => {
        registeredRef.current = false;
        if (!cancelled) {
          setRegistered(false);
          setRegistrationError(e.cause || "Registration failed.");
        }
      });

      ua.on("newRTCSession", (data) => {
        const session = data.session;

        if (sessionRef.current) {
          if (data.originator === "remote") session.terminate();
          return;
        }

        sessionRef.current = session;
        sessionIsIncomingRef.current = data.originator === "remote";
        setRemoteIdentity(session.remote_identity?.uri?.user || "");

        if (data.originator === "remote") {
          setCallState(CALL_STATES.INCOMING);
        } else {
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

    // Runs on logout (isLoggedIn flips to false, re-running this
    // effect) as well as an actual full page unload/reload or the
    // whole React tree unmounting — not on ordinary in-app route
    // changes while still logged in, since isLoggedIn doesn't change
    // then and this effect doesn't re-run at all.
    return () => {
      cancelled = true;
      if (uaRef.current) {
        uaRef.current.stop();
        uaRef.current = null;
      }
    };
  }, [isLoggedIn]);

  const answer = useCallback(() => {
    if (sessionRef.current && sessionIsIncomingRef.current) {
      sessionRef.current.answer({
        mediaConstraints: { audio: true, video: false },
      });
    }
  }, []);

  const hangup = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.terminate();
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (!sessionRef.current) return false;
    const isMuted = sessionRef.current.isMuted().audio;
    if (isMuted) {
      sessionRef.current.unmute({ audio: true });
    } else {
      sessionRef.current.mute({ audio: true });
    }
    return !isMuted;
  }, []);

  const dial = useCallback((destination) => {
    if (!uaRef.current || !registeredRef.current || sessionRef.current) return;
    uaRef.current.call(destination, {
      mediaConstraints: { audio: true, video: false },
    });
  }, []);

  const contextValue = useMemo(
    () => ({
      registered,
      registrationError,
      callState,
      remoteIdentity,
      answer,
      hangup,
      toggleMute,
      dial,
      CALL_STATES,
    }),
    [registered, registrationError, callState, remoteIdentity, answer, hangup, toggleMute, dial]
  );

  return <PhoneContext.Provider value={contextValue}>{children}</PhoneContext.Provider>;
}

export function usePhone() {
  const ctx = useContext(PhoneContext);
  if (!ctx) {
    throw new Error("usePhone must be used within a PhoneProvider");
  }
  return ctx;
}
