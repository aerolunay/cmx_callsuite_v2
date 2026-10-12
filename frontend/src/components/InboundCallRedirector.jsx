import { useLocation, useNavigate } from "react-router-dom";
import { useDialerSocketMessages } from "../context/DialerSocketContext";
import { usePhone } from "../context/PhoneContext";

/*
==================================================
InboundCallRedirector — per explicit request
==================================================
Supervisors/training_quality can be on Reports, Live Status
Dashboard, or Admin while still logged in and able to take inbound
calls. Without this, a call could start ringing for them while they're
looking at a report with no way to notice at all (the ringing itself
is audio from their softphone, but there's nothing on-screen pointing
them to the Dialer page where the actual UI to answer it lives).

Listens for the SAME "inboundCall" WS message inboundCallService.js
already broadcasts (see broadcastInboundStatus) — specifically
status: "ringing_agent", the moment a specific agent's phone starts
ringing for a call, before they've answered it at all. Redirects
straight to /dialer if they're not already there. A plain agent never
leaves /dialer in the first place, so this never actually triggers for
them — nothing role-specific to check here, the WS message itself is
already scoped to whichever single agent the call is actually ringing
for.

Mounted once in App.jsx, alongside <Routes> — needs to be inside the
Router (for useNavigate/useLocation) but not tied to any single route,
since it has to work regardless of which page is currently showing.
Renders nothing itself, pure side effect.
==================================================
*/
export default function InboundCallRedirector() {
  const navigate = useNavigate();
  const location = useLocation();

  const phone = usePhone();

  useDialerSocketMessages((message) => {
    if (message.type !== "inboundCall" || message.status !== "ringing_agent") return;
    if (location.pathname === "/dialer") return; // already there, nothing to do
    // Per explicit request — supervisor/training_quality keep the Dialer
    // in its own tab, which owns the phone (see PhoneContext.jsx): the
    // call is ringing THERE, so this tab stays where it is rather than
    // turning into a second Dialer.
    if (phone.dialerOpenElsewhere) return;
    navigate("/dialer");
  });

  return null;
}
