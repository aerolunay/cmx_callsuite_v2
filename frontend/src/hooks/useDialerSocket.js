import { useEffect, useRef } from "react";

/*
Connects to /ws/dialer (same host/port as the API, proxied by Vite in
dev — see vite.config.js). The server identifies which agent this
socket belongs to via the existing session cookie (see backend
config/ws.js) — no token/ID is sent from the client, so there's nothing
here to authenticate with beyond already being logged in.

Auto-reconnects on drop with a simple fixed delay. Not exponential
backoff — fine for a handful of agents on one internal tool; would be
worth revisiting if this ever needs to gracefully handle a server
restart affecting many concurrent connections at once.
*/
export function useDialerSocket(onMessage) {
  const wsRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let reconnectTimer = null;
    let closedByEffect = false;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws/dialer`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessageRef.current(data);
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

    return () => {
      closedByEffect = true;
      clearTimeout(reconnectTimer);
      wsRef.current && wsRef.current.close();
    };
  }, []);
}
