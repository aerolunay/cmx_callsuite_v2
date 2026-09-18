import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";

/*
==================================================
DialerSocketProvider — REAL BUG FIX
==================================================
Replaces the old useDialerSocket hook, which opened its WebSocket
connection from WITHIN DialerPage itself (empty dependency array,
connect on mount, close on unmount) — meaning the connection only
existed while a user was actually ON the Dialer page.

Confirmed as the real root cause of an intermittent "Authentication
required" bug, traced precisely: the backend (config/ws.js) starts a
15-second timer the moment a WebSocket closes — if the SAME session
doesn't reconnect within that window, the backend deliberately
DESTROYS the session entirely (this is intentional, correct behavior
for a genuine disconnect — a network blip, a page refresh — where no
reconnection within 15s means the user really is gone). But
supervisors/training_quality can navigate to Reports or Live Status
Dashboard — pages that never had this hook mounted at all — so the
WebSocket closed the moment DialerPage unmounted, and nothing
reconnected until they navigated back. Any visit longer than 15
seconds (extremely normal for actually reading a report) meant the
session was already destroyed by the time they returned, explaining
every symptom: the intermittency (depends how long they stayed away),
why it was specific to roles that can navigate elsewhere at all (a
plain agent never leaves Dialer, so this never triggered for them),
and the "why does it say authentication required when nothing was
actually wrong" confusion (nothing WAS wrong — the backend was doing
exactly what it was designed to do, just against a connection that
should never have closed for this reason in the first place).

Fix: mount the actual connection ONCE, at the top of the app (see
main.jsx), alongside AuthProvider — so it survives every in-app route
change and only ever closes on a genuine tab close/reload or logout.
Components that need to react to messages (currently only DialerPage)
subscribe via useDialerSocketMessages below instead of opening their
own connection.
==================================================
*/

const DialerSocketContext = createContext(null);

export function DialerSocketProvider({ children }) {
  const listenersRef = useRef(new Set());

  useEffect(() => {
    let reconnectTimer = null;
    let closedByEffect = false;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws/dialer`);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          listenersRef.current.forEach((listener) => listener(data));
        } catch (err) {
          console.error("Failed to parse WS message:", err);
        }
      };

      ws.onclose = () => {
        if (closedByEffect) return;
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    // Only runs on an actual full page unload/reload or the whole
    // React tree unmounting — NOT on ordinary in-app route changes,
    // since this provider lives above the router in main.jsx.
    return () => {
      closedByEffect = true;
      clearTimeout(reconnectTimer);
    };
  }, []);

  // REAL BUG FIX, caught before shipping — same class of issue as the
  // earlier hasLeads polling bug tonight: subscribe was a plain
  // function declared fresh every render, and { subscribe } was a new
  // object literal every render too — meaning every consumer's own
  // useEffect([ctx]) would tear down and resubscribe on every single
  // re-render of this provider (which happens often, since it sits
  // near the top of the whole app). useCallback with an empty
  // dependency array gives subscribe the exact same stable identity
  // across renders that the original useRef version did — but without
  // ever reading .current during render, which React's own rules
  // flag as unsafe (a ref read during render isn't guaranteed to
  // reflect the latest value the way a real dependency would).
  const subscribe = useCallback((listener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  const contextValue = useMemo(() => ({ subscribe }), [subscribe]);

  return <DialerSocketContext.Provider value={contextValue}>{children}</DialerSocketContext.Provider>;
}

/*
Drop-in replacement for the old useDialerSocket(onMessage) hook — same
calling convention, so DialerPage.jsx barely needs to change at all.
Subscribes to the SHARED, app-wide connection's messages rather than
opening its own.
*/
// eslint-disable-next-line react-refresh/only-export-components -- useDialerSocketMessages deliberately lives alongside DialerSocketProvider (same pattern as every other context in this app); splitting it into its own file would mean updating every import site across the whole codebase for a dev-only hot-reload warning with no production impact.
export function useDialerSocketMessages(onMessage) {
  const ctx = useContext(DialerSocketContext);
  if (!ctx) {
    throw new Error("useDialerSocketMessages must be used within a DialerSocketProvider");
  }

  // REAL BUG FIX — assigning onMessageRef.current directly during
  // render is exactly the pattern React's own rules flag: a ref write
  // during render isn't guaranteed to happen before every consumer
  // that might read it has already rendered with the OLD value.
  // Moving it into its own effect is the standard fix for "keep a ref
  // in sync with the latest callback prop, without changing the
  // subscription's own identity/timing" — it still updates before the
  // subscribe effect below ever fires, since effects in the same
  // component run in declaration order.
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    return ctx.subscribe((data) => onMessageRef.current(data));
  }, [ctx]);
}
