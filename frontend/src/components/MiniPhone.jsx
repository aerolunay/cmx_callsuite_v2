import { useEffect, useRef, useState } from "react";
import { usePhone } from "../context/PhoneContext";
import InternalTransferModal from "../modals/InternalTransferModal";
import { playDtmfTone } from "../utils/audio";

/*
==================================================
MiniPhone — self-contained softphone widget, laid out like a real
softphone (3CX / MicroSIP), per explicit request: one number display,
an always-visible round keypad, then round icon call controls. Before
dialing the keypad types into the display; on a connected call it
sends tones (DTMF) instead.

Consumes the app-wide PhoneContext (see context/PhoneContext.jsx —
the actual JsSIP connection lives there now, not here, so it survives
navigating away from and back to this page); DialerPage never touches
JsSIP directly. DialerPage supplies:
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
  - onStartLineTwo(target, isExtension) / onCompleteLineTwo(action) /
    onCancelLineTwo(): real attended transfer, per explicit request —
    a traditional phone's Line 1/Line 2 model. Starting Line 2 puts
    the ORIGINAL customer on hold (they hear nothing) while the agent
    privately dials and talks to a new target on a separate line.
    Completing brings the customer in — either as a handoff (Transfer,
    agent leaves) or a true 3-way (Conference, agent stays). Canceling
    hangs up Line 2 and restores the original call exactly as it was.
    See attendedTransferService.js on the backend for the full design.
  - canSendDtmf / onSendDtmf(digits): the in-call Keypad, per explicit
    request — enters an extension / navigates an IVR on the number the
    agent dialed. Tones are played into the CUSTOMER's leg by the
    backend (AMI PlayDTMF), not sent from JsSIP: the agent's own leg
    sits in a ConfBridge room, which swallows participant DTMF.
  - onSendLineTwoDtmf(digits): the same keypad on Line 2's panel — e.g.
    dialing a company's main number to transfer to, then entering the
    person's extension at its IVR. Works whichever direction Line 1 is.
  - onManualDial(phoneNumber, dialExtension) / onStartLineTwo(target,
    isExtension, dialExtension): the display takes ONE dial string,
    phone-style — "5551234567,101" — split here into the number and
    the extension the backend auto-dials once answered (see
    sanitizeDialInput/splitDialString below). lineOneAutoExt is the one
    riding on the current Line 1 call, shown as a reminder.

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

Controls follow the call state like a real softphone, rather than
showing every button disabled: idle shows just the green Call button;
ringing shows Answer/Decline; on a call shows Mute/Hold/Transfer (or
Connect Line 1 on Line 2) plus a red Hang Up.

The dial display is digits only up to the first comma (the phone
number), then 0-9 * # and more commas (the extension / pauses).
Internal Transfer still picks this app's own named extensions (e.g.
"bsmsc901") from its modal, not from this display.
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

// Matches the backend's own limit (dialerService.normalizeAutoDtmf).
const MAX_EXT_LENGTH = 40;

// Holding the * key types a comma (pause), the same as most mobile
// dialers — the only way to enter one from the on-screen keypad.
const LONG_PRESS_MS = 600;

/*
==================================================
One dial string, phone-style — per explicit request (one input box,
not a separate Ext field): the number, then optionally a comma and an
extension the backend auto-dials once answered — "5551234567,101".
Each extra comma is another 2-second pause first ("5551234567,,101"),
see dialerService.runAutoDtmf. "x" / "ext" count as the comma too,
since that's how numbers usually get pasted ("555-123-4567 x101").
==================================================
*/
function sanitizeDialInput(raw) {
  const normalized = String(raw).replace(/\s*(?:ext\.?|x)\s*/gi, ",");
  const commaAt = normalized.indexOf(",");
  if (commaAt === -1) return normalized.replace(/\D/g, "");
  const number = normalized.slice(0, commaAt).replace(/\D/g, "");
  const ext = normalized
    .slice(commaAt + 1)
    .replace(/[^0-9*#,]/g, "")
    .slice(0, MAX_EXT_LENGTH);
  return `${number},${ext}`;
}

// { number, ext } — ext is everything after the FIRST comma (so its
// own leading commas stay as extra pauses), or "" if it has no digits.
function splitDialString(value) {
  const commaAt = value.indexOf(",");
  if (commaAt === -1) return { number: value, ext: "" };
  const ext = value.slice(commaAt + 1);
  return { number: value.slice(0, commaAt), ext: /[0-9*#]/.test(ext) ? ext : "" };
}

const KEYPAD_KEYS = [
  ["1", ""],
  ["2", "ABC"],
  ["3", "DEF"],
  ["4", "GHI"],
  ["5", "JKL"],
  ["6", "MNO"],
  ["7", "PQRS"],
  ["8", "TUV"],
  ["9", "WXYZ"],
  ["*", ","],
  ["0", ""],
  ["#", ""],
];

// Inline line icons (Feather icon set shapes, MIT) — no icon library
// is installed, and these few aren't worth adding one for.
function Icon({ children, rotate }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
    >
      {children}
    </svg>
  );
}

const PHONE_PATH =
  "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z";

const ICONS = {
  call: (
    <Icon>
      <path d={PHONE_PATH} />
    </Icon>
  ),
  hangup: (
    <Icon rotate={135}>
      <path d={PHONE_PATH} />
    </Icon>
  ),
  mic: (
    <Icon>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </Icon>
  ),
  micOff: (
    <Icon>
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </Icon>
  ),
  pause: (
    <Icon>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </Icon>
  ),
  resume: (
    <Icon>
      <polygon points="5 3 19 12 5 21 5 3" />
    </Icon>
  ),
  transfer: (
    <Icon>
      <polyline points="19 1 23 5 19 9" />
      <line x1="15" y1="5" x2="23" y2="5" />
      <path d={PHONE_PATH} />
    </Icon>
  ),
  merge: (
    <Icon>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </Icon>
  ),
  backspace: (
    <Icon>
      <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
      <line x1="18" y1="9" x2="12" y2="15" />
      <line x1="12" y1="9" x2="18" y2="15" />
    </Icon>
  ),
};

// Round softphone button with an optional caption underneath.
// variant: "neutral" (Mute/Hold/Transfer) | "call" (green) | "end" (red).
function RoundButton({ icon, label, title, onClick, disabled, variant = "neutral", active = false, large = false }) {
  const className = [
    "phone-round",
    `phone-round-${variant}`,
    active ? "phone-round-active" : "",
    large ? "phone-round-lg" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="phone-round-wrap">
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled}
        title={title || label}
        aria-label={title || label}
      >
        {icon}
      </button>
      {label && <span className="phone-round-label">{label}</span>}
    </div>
  );
}

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
  canSendDtmf,
  onSendDtmf,
  onSendLineTwoDtmf,
  lineOneAutoExt,
  onHangUp,
  onManualDial,
  onStartLineTwo,
  onCompleteLineTwo,
  onCancelLineTwo,
  onSwitchLine,
  onGetLineTwoStatus,
  onHoldLineTwo,
  onUnholdLineTwo,
}) {
  const phone = usePhone();
  const autoAnsweredCallRef = useRef(null); // guards against re-answering the same ring on every re-render

  const [dialNumber, setDialNumber] = useState("");
  const [isMuted, setIsMuted] = useState(false);

  // REBUILT (again) — per explicit request, now a genuine two-panel
  // phone widget matching a real 3CX-style two-line layout, not just
  // a supplementary section below the main dial pad. Hold and Switch
  // are now two SEPARATE agent actions (matching the described real
  // workflow: hold Line 1, THEN switch to Line 2, THEN dial) —
  // previously switching also silently held/unheld things itself.
  //
  // viewingLine (LOCAL UI state, 1 or 2) tracks which PANEL is
  // currently shown — DISTINCT from activeLine (the backend's own
  // truth of which room the agent's actual audio is routed to).
  // These two only diverge in one specific case: Line 2 hasn't been
  // dialed yet, so the agent can be VIEWING its empty "enter a
  // number" panel while their audio is still, correctly, on Line 1 —
  // nothing backend-side to do until they actually dial. The moment
  // Line 2 exists, switching tabs always means a real backend switch,
  // and the two stay in sync.
  //
  // lineTwoStatus mirrors the backend's own state: null (Line 2 never
  // started) | { active, status: "ringing"|"connected"|"failed",
  // failureReason, activeLine, line1OnHold, line2OnHold,
  // line2HasConnected }. Refreshed after every Line 2 action (not just
  // polled) so the reciprocal hold-based tab enable/disable logic
  // always reflects the real current state.
  const [targetInput, setTargetInput] = useState("");
  const [targetError, setTargetError] = useState("");
  const [lineTwoStatus, setLineTwoStatus] = useState(null);
  const [activeLine, setActiveLine] = useState(1);
  const [viewingLine, setViewingLine] = useState(1);
  const [lineTwoBusy, setLineTwoBusy] = useState(false);

  const [showInternalTransferModal, setShowInternalTransferModal] = useState(false);

  // Keypad, shared by both line panels — it always acts on the line
  // being viewed. Before that line is dialed it types into its display
  // (dialNumber / targetInput); on a call it sends tones. dtmfSent
  // holds the tones sent on each line, shown in that line's display
  // like a real phone. Presses are chained onto dtmfQueueRef so each
  // digit's request only goes out once the previous one finished —
  // firing them concurrently could let a fast "1#" reach Asterisk as
  // "#1".
  const [dtmfSent, setDtmfSent] = useState({ 1: "", 2: "" });
  const [dtmfError, setDtmfError] = useState("");
  const dtmfQueueRef = useRef(Promise.resolve());
  const longPressTimerRef = useRef(null);
  const longPressFiredRef = useRef(false);

  // Dial with extension — the part after the comma in the display,
  // auto-sent by the backend once the far end answers (see
  // dialerService.runAutoDtmf). lineTwoAutoExt remembers what went out
  // with the current Line 2 dial, purely to tell the agent it's coming
  // (Line 1's equivalent comes from DialerPage's own call object, as
  // lineOneAutoExt, so it can never outlive a dial that didn't start).
  const [lineTwoAutoExt, setLineTwoAutoExt] = useState("");

  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

  // Poll Line 2's real status while it's still ringing — this is how
  // the UI learns "no answer" and offers Try Again, since nothing
  // else currently reports that in real time.
  //
  // REAL BUG FIX, confirmed via a real test call: onGetLineTwoStatus
  // used to be in this effect's dependency array. It's a plain
  // function declared fresh on every DialerPage render (not
  // useCallback-memoized), and DialerPage re-renders frequently on
  // its own (stats/call-log polling elsewhere in this app already
  // does this every few seconds) — each of those re-renders passed
  // down a BRAND NEW function reference, which tore down and
  // recreated this effect's setInterval every single time, before it
  // ever got a real chance to fire. Line 2's status polling never
  // actually ran in practice — this is why the UI stayed stuck
  // showing "ringing" indefinitely even once the agent was already
  // genuinely connected and talking to Line 2. onGetLineTwoStatus
  // doesn't capture any state that would go stale by omitting it here
  // — it's just a stable API-call wrapper.
  useEffect(() => {
    if (!lineTwoStatus?.active || lineTwoStatus.status !== "ringing") return;

    const interval = setInterval(async () => {
      try {
        const data = await onGetLineTwoStatus();
        setLineTwoStatus(data);
        setActiveLine(data.activeLine || 1);
      } catch {
        // Transient poll failure — try again next tick rather than
        // treating one missed poll as a real state change.
      }
    }, 1500);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineTwoStatus?.active, lineTwoStatus?.status]);

  async function refreshLineTwoStatus() {
    try {
      const data = await onGetLineTwoStatus();
      setLineTwoStatus(data);
      setActiveLine(data.activeLine || 1);
      return data;
    } catch {
      return null;
    }
  }

  async function handleStartLineTwo() {
    const { number, ext } = splitDialString(targetInput);
    if (!number) return;
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onStartLineTwo(number, false, ext);
      await refreshLineTwoStatus();
      setViewingLine(2);
      setTargetInput("");
      setDtmfSent((prev) => ({ ...prev, 2: "" }));
      setLineTwoAutoExt(ext);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handlePickedExtensionStartLineTwo(extension) {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onStartLineTwo(extension, true);
      await refreshLineTwoStatus();
      setViewingLine(2);
      setShowInternalTransferModal(false);
    } catch (err) {
      setTargetError(err.message);
      throw err; // let the modal know it failed too, so its own busy state clears correctly
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleCompleteLineTwoClick(action) {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onCompleteLineTwo(action);
      setLineTwoStatus(null);
      setActiveLine(1);
      setViewingLine(1);
    } catch (err) {
      if (err.reason === "customer_disconnected") {
        // The original customer already hung up while on hold —
        // Line 2's party is still genuinely connected to the agent,
        // just no longer as "Line 2" (the backend promoted it to the
        // primary call). Drop back to the normal single-call view
        // rather than showing this as a plain failure, but still
        // surface what happened.
        setLineTwoStatus(null);
        setActiveLine(1);
        setViewingLine(1);
        setTargetError(err.message);
      } else {
        setTargetError(err.message);
      }
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleCancelLineTwoClick() {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onCancelLineTwo();
      setLineTwoStatus(null);
      setActiveLine(1);
      setViewingLine(1);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  // Clicking a tab is either a pure local view change (Line 2 hasn't
  // been dialed yet — nothing for the backend to do) or a real
  // backend switch (Line 2 already exists, audio needs to actually
  // move). See the state comment above for why these two cases exist.
  async function handleLine1TabClick() {
    if (line1TabDisabled) return;
    if (!lineTwoStatus?.active || activeLine === 1) {
      setViewingLine(1);
      return;
    }
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onSwitchLine(1);
      setActiveLine(1);
      setViewingLine(1);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleLine2TabClick() {
    if (line2TabDisabled) return;
    if (!lineTwoStatus?.active || activeLine === 2) {
      setViewingLine(2);
      return;
    }
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onSwitchLine(2);
      setActiveLine(2);
      setViewingLine(2);
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleHoldLineTwoClick() {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onHoldLineTwo();
      await refreshLineTwoStatus();
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  async function handleUnholdLineTwoClick() {
    setTargetError("");
    setLineTwoBusy(true);
    try {
      await onUnholdLineTwo();
      await refreshLineTwoStatus();
    } catch (err) {
      setTargetError(err.message);
    } finally {
      setLineTwoBusy(false);
    }
  }

  function handleHangUpLineTwoClick() {
    // "Hang Up" on Line 2's OWN panel means "I'm done with Line 2
    // specifically" — disconnect just that party and return to
    // Line 1, NOT end the agent's entire call. That's exactly what
    // Cancel already does.
    handleCancelLineTwoClick();
  }

  // Reciprocal enable/disable, per explicit request: to switch TO a
  // line, the line you're currently on must be held first (unless
  // Line 2 hasn't connected to anyone yet, in which case there's
  // nothing live to require holding).
  const line1TabDisabled =
    viewingLine === 1 ||
    lineTwoBusy ||
    (activeLine === 2 && lineTwoStatus?.line2HasConnected && !lineTwoStatus?.line2OnHold);

  const line2TabDisabled = viewingLine === 2 || lineTwoBusy || (activeLine === 1 && !onHold);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: clearing stale UI state on a call-state transition, not a data fetch, but the same "synchronize on a specific change" pattern this rule is really aimed at avoiding misuse of; this usage is the legitimate case.
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
    // phone's functions are stable across renders — actually
    // guaranteed now via useCallback in PhoneContext.jsx (previously
    // just assumed, since the old hook redeclared them every render
    // but MiniPhone simply didn't re-render often enough to expose
    // it) — so only the actual state values need to be dependencies
    // here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.callState, agentStatus, phone.remoteIdentity]);

  // Reset per-call UI state once the call actually ends, so a stale
  // "muted" indicator or leftover transfer/conference target doesn't
  // carry into the next call.
  useEffect(() => {
    if (phone.callState === phone.CALL_STATES.IDLE || phone.callState === phone.CALL_STATES.ENDED) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: resetting per-call UI state on a call-state transition, same as the effect above.
      setIsMuted(false);
      setTargetInput("");
      setTargetError("");
      setLineTwoStatus(null);
      setActiveLine(1);
      setViewingLine(1);
      setDtmfSent({ 1: "", 2: "" });
      setDtmfError("");
      setLineTwoAutoExt("");
    }
    // phone.CALL_STATES is a stable constant object (see the effect
    // above for the same reasoning re: phone's stable identity) — only
    // the actual state value needs to be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.callState]);

  // "dial" while that line's panel is still taking a number to dial
  // (Line 1 idle; Line 2 not dialed yet or needing a retry), "dtmf"
  // once it's on a call.
  function keypadMode(line) {
    if (line === 1) return isIdle ? "dial" : "dtmf";
    return lineTwoStatus?.active && lineTwoStatus.status !== "failed" ? "dtmf" : "dial";
  }

  // Mirrors the backend's own checks (dialerService.sendDtmf /
  // attendedTransferService.sendLineTwoDtmf) so keys are only enabled
  // when a press would actually go through.
  function keypadReady(line) {
    if (keypadMode(line) === "dial") return line === 1 ? isIdle : !lineTwoBusy;
    if (line === 1) return Boolean(canSendDtmf && onSendDtmf);
    return Boolean(
      lineTwoStatus?.active && lineTwoStatus.line2HasConnected && !lineTwoStatus.line2OnHold && activeLine === 2
    );
  }

  function keypadHint(line) {
    if (line === 1) return onHold ? "Unhold the call to use the keypad." : "Keypad works once the call connects.";
    if (!lineTwoStatus?.line2HasConnected) return "Keypad works once Line 2 connects.";
    if (lineTwoStatus.line2OnHold) return "Unhold Line 2 to use the keypad.";
    return "Switch to Line 2 to use the keypad.";
  }

  function dialValue(line) {
    return line === 1 ? dialNumber : targetInput;
  }

  function setDialValue(line, value) {
    (line === 1 ? setDialNumber : setTargetInput)(sanitizeDialInput(value));
  }

  function handleKeypadPress(key) {
    const line = viewingLine;
    if (!keypadReady(line)) return;

    if (keypadMode(line) === "dial") {
      const current = dialValue(line);
      const next = sanitizeDialInput(current + key);
      if (next === current) return; // e.g. * or # before the comma — not part of a phone number
      setDialValue(line, next);
      if (key !== ",") playDtmfTone(key, phone.getOutputSinkId());
      return;
    }

    if (key === ",") return; // a pause only means something in a dial string
    const send = line === 2 ? onSendLineTwoDtmf : onSendDtmf;
    setDtmfError("");
    setDtmfSent((prev) => ({ ...prev, [line]: prev[line] + key }));
    playDtmfTone(key, phone.getOutputSinkId());
    dtmfQueueRef.current = dtmfQueueRef.current
      .then(() => send(key))
      .catch((err) => setDtmfError(err.message));
  }

  function handleBackspace(line) {
    setDialValue(line, dialValue(line).slice(0, -1));
  }

  // Hold * for a comma (dial mode only); a plain click still types *.
  function handleKeyPointerDown(key) {
    longPressFiredRef.current = false;
    if (key !== "*" || keypadMode(viewingLine) !== "dial") return;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      handleKeypadPress(",");
    }, LONG_PRESS_MS);
  }

  function cancelLongPress() {
    clearTimeout(longPressTimerRef.current);
  }

  function handleKeyClick(key) {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return; // the long press already typed its comma
    }
    handleKeypadPress(key);
  }

  // Physical keyboard works too once the agent has clicked into the
  // phone (focus anywhere inside the widget) — scoped to the widget
  // rather than the whole page so typing elsewhere (notes, comments)
  // can never leak out as tones. The display input handles its own
  // typing natively, so keys aimed at an input are left alone.
  function handleWidgetKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return;
    }
    if (/^[0-9*#,]$/.test(e.key)) {
      e.preventDefault();
      handleKeypadPress(e.key);
    } else if (e.key === "Backspace" && keypadMode(viewingLine) === "dial") {
      e.preventDefault();
      handleBackspace(viewingLine);
    }
  }

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

  function handleCall() {
    const { number, ext } = splitDialString(dialNumber);
    if (!canDial || !number) return;
    onManualDial(number, ext);
    setDialNumber("");
    setDtmfSent((prev) => ({ ...prev, 1: "" }));
  }

  const isIdle = phone.callState === phone.CALL_STATES.IDLE || phone.callState === phone.CALL_STATES.ENDED;
  const isIncoming = phone.callState === phone.CALL_STATES.INCOMING;
  const isActive = phone.callState === phone.CALL_STATES.ACTIVE;
  const canDial = phone.registered && agentStatus === "READY" && !hasActiveCall && isIdle;

  function callStateText(line) {
    if (line === 1) {
      if (isIncoming) return "Incoming call";
      if (onHold) return "On hold";
      return canHold ? "Connected" : "Calling…";
    }
    if (lineTwoStatus?.status === "ringing") return "Ringing…";
    if (lineTwoStatus?.line2OnHold) return "On hold";
    return "Connected";
  }

  // The number display. Dial mode: the one editable dial string (number,
  // then optionally ",ext"), with backspace. On a call: read-only, the
  // tones sent so far, under a small call-state caption.
  function renderDisplay(line) {
    const mode = keypadMode(line);

    if (mode === "dtmf") {
      const autoExt = line === 1 ? lineOneAutoExt : lineTwoAutoExt;
      return (
        <>
          <div className="phone-call-state">{callStateText(line)}</div>
          <div className="phone-display">
            <input type="tel" className="phone-display-input" value={dtmfSent[line]} disabled readOnly />
          </div>
          {autoExt && <p className="phone-hint phone-hint-center">Ext {autoExt} dials automatically after answer.</p>}
        </>
      );
    }

    const value = dialValue(line);
    const { ext } = splitDialString(value);
    const startDial = line === 1 ? handleCall : handleStartLineTwo;
    return (
      <>
        <div className="phone-display">
          <input
            type="tel"
            className="phone-display-input"
            placeholder="Enter number"
            value={value}
            onChange={(e) => setDialValue(line, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") startDial();
            }}
            disabled={!keypadReady(line)}
          />
          {value && keypadReady(line) && (
            <button
              type="button"
              className="phone-display-backspace"
              onClick={() => handleBackspace(line)}
              title="Delete"
              aria-label="Delete"
            >
              {ICONS.backspace}
            </button>
          )}
        </div>
        <p className="phone-hint phone-hint-center">
          {ext
            ? `Ext ${ext} dials automatically after answer.`
            : "Optional: add an extension after a comma (hold ✱), e.g. 5551234567,101 — or use the keypad once connected"}
        </p>
      </>
    );
  }

  function renderKeypad(line) {
    const mode = keypadMode(line);
    const ready = keypadReady(line);
    return (
      <>
        <div className="phone-keypad">
          {KEYPAD_KEYS.map(([key, sub]) => (
            <button
              key={key}
              type="button"
              className="phone-keypad-key"
              onClick={() => handleKeyClick(key)}
              onPointerDown={() => handleKeyPointerDown(key)}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              disabled={!ready}
              title={key === "*" && mode === "dial" ? "Hold for a comma (pause before an extension)" : undefined}
            >
              <span className="phone-keypad-digit">{key === "*" ? "✱" : key}</span>
              <span className="phone-keypad-sub">{sub}</span>
            </button>
          ))}
        </div>
        {!ready && mode === "dtmf" && !(line === 1 && isIncoming) && (
          <p className="phone-hint phone-hint-center">{keypadHint(line)}</p>
        )}
        {dtmfError && <div className="error phone-extra-error">{dtmfError}</div>}
      </>
    );
  }

  return (
    <div className="phone-widget" onKeyDown={handleWidgetKeyDown}>
      <div className="phone-widget-status">
        <span className={`phone-status-dot ${statusDotClass(phone, agentStatus)}`} />
        {statusLabel(phone, agentStatus)}
      </div>

      {/* Line 1 / Line 2 tabs — ALWAYS visible, per explicit request,
          not just once Line 2 has been dialed. Line 2 starts disabled
          and only enables once Line 1 is held; switching back
          requires the SAME of Line 2 once it's actually connected to
          someone — a real reciprocal two-line phone, not just a
          supplementary section. */}
      <div className="phone-line-tabs">
        <button
          type="button"
          className={viewingLine === 1 ? "phone-line-tab phone-line-tab-active" : "phone-line-tab"}
          onClick={handleLine1TabClick}
          disabled={line1TabDisabled}
        >
          Line 1
        </button>
        <button
          type="button"
          className={viewingLine === 2 ? "phone-line-tab phone-line-tab-active" : "phone-line-tab"}
          onClick={handleLine2TabClick}
          disabled={line2TabDisabled}
        >
          Line 2{lineTwoStatus?.status === "ringing" ? " (ringing…)" : ""}
        </button>
      </div>

      {viewingLine === 1 ? (
        <>
          {renderDisplay(1)}
          {renderKeypad(1)}

          {isIdle ? (
            <div className="phone-main-actions">
              <RoundButton
                large
                variant="call"
                icon={ICONS.call}
                title="Call"
                onClick={handleCall}
                disabled={!canDial || !splitDialString(dialNumber).number}
              />
            </div>
          ) : isIncoming ? (
            <div className="phone-main-actions">
              <RoundButton large variant="call" icon={ICONS.call} label="Answer" onClick={phone.answer} />
              <RoundButton large variant="end" icon={ICONS.hangup} label="Decline" onClick={handleHangUpClick} />
            </div>
          ) : (
            <>
              <div className="phone-controls">
                <RoundButton
                  icon={isMuted ? ICONS.micOff : ICONS.mic}
                  label={isMuted ? "Unmute" : "Mute"}
                  active={isMuted}
                  onClick={handleToggleMute}
                  disabled={!isActive}
                />
                <RoundButton
                  icon={onHold ? ICONS.resume : ICONS.pause}
                  label={onHold ? "Unhold" : "Hold"}
                  active={onHold}
                  onClick={onToggleHold}
                  disabled={!canHold}
                />
                {/* Per explicit request — Internal Transfer lives only on
                    Line 1's panel, disabled once Line 2 already has a
                    live call (can't start a second Line 2 while one
                    exists). */}
                <RoundButton
                  icon={ICONS.transfer}
                  label="Transfer"
                  title="Internal Transfer"
                  onClick={() => setShowInternalTransferModal(true)}
                  disabled={!isActive || lineTwoBusy || !campaignId || Boolean(lineTwoStatus?.active)}
                />
              </div>
              <div className="phone-main-actions">
                <RoundButton
                  large
                  variant="end"
                  icon={ICONS.hangup}
                  // Hang Up is disabled while a Line 2 action is actually
                  // in flight — re-enabled the instant it resolves.
                  title={lineTwoBusy ? "Please wait for the Line 2 action to finish" : "Hang Up"}
                  onClick={handleHangUpClick}
                  disabled={!isActive || lineTwoBusy}
                />
              </div>
            </>
          )}

          {!canDial && isIdle && (
            <p className="phone-hint phone-hint-center">
              {!phone.registered
                ? "Softphone must be registered before dialing."
                : hasActiveCall
                  ? "You're already on a call."
                  : "You must be Ready to place a call."}
            </p>
          )}

          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </>
      ) : !lineTwoStatus?.active ? (
        // Line 2 tab selected, but nothing dialed yet — an empty
        // panel matching Line 1's own layout. Purely a local view
        // change to get here; nothing backend-side happens until Call
        // is actually clicked.
        <>
          {renderDisplay(2)}
          {renderKeypad(2)}
          <div className="phone-main-actions">
            <RoundButton
              large
              variant="call"
              icon={ICONS.call}
              title="Call on Line 2"
              onClick={handleStartLineTwo}
              disabled={lineTwoBusy || !splitDialString(targetInput).number}
            />
          </div>
          {lineTwoBusy && <p className="phone-hint phone-hint-center">Calling…</p>}
          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </>
      ) : lineTwoStatus.status === "failed" ? (
        // Per explicit request: if Line 2 doesn't pick up, the agent
        // must be able to try dialing again — reusing the same
        // private room, Line 1 stays held throughout.
        <>
          <div className="error phone-extra-error">Line 2 didn't answer.</div>
          {renderDisplay(2)}
          {renderKeypad(2)}
          <div className="phone-main-actions">
            <RoundButton
              large
              variant="call"
              icon={ICONS.call}
              label={lineTwoBusy ? "Calling…" : "Try Again"}
              onClick={handleStartLineTwo}
              disabled={lineTwoBusy || !splitDialString(targetInput).number}
            />
            <RoundButton
              large
              variant="end"
              icon={ICONS.hangup}
              label="Give Up"
              onClick={handleCancelLineTwoClick}
              disabled={lineTwoBusy}
            />
          </div>
          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </>
      ) : (
        // Line 2 is ringing or connected. Mute/Hang Up reuse the same
        // underlying JsSIP session state as Line 1 (isActive) — it's
        // the agent's own single audio session throughout; only WHICH
        // ASTERISK ROOM it's server-side-redirected to changes when
        // switching lines, not the session itself. Hold is genuinely
        // per-line (Line 2's own target), so it's gated on Line 2
        // actually having connected to someone.
        <>
          {renderDisplay(2)}
          {renderKeypad(2)}
          <div className="phone-controls">
            <RoundButton
              icon={isMuted ? ICONS.micOff : ICONS.mic}
              label={isMuted ? "Unmute" : "Mute"}
              active={isMuted}
              onClick={handleToggleMute}
              disabled={!isActive}
            />
            <RoundButton
              icon={lineTwoStatus.line2OnHold ? ICONS.resume : ICONS.pause}
              label={lineTwoStatus.line2OnHold ? "Unhold" : "Hold"}
              title={lineTwoStatus.line2OnHold ? "Unhold Line 2" : "Hold Line 2"}
              active={lineTwoStatus.line2OnHold}
              onClick={lineTwoStatus.line2OnHold ? handleUnholdLineTwoClick : handleHoldLineTwoClick}
              disabled={!lineTwoStatus.line2HasConnected || lineTwoBusy}
            />
            {/* Replaces Internal Transfer in this context, per explicit
                request — the merge action, agent decides afterward
                (via the normal Hang Up) whether to leave or stay on. */}
            <RoundButton
              icon={ICONS.merge}
              label="Connect Line 1"
              onClick={() => handleCompleteLineTwoClick("conference")}
              disabled={lineTwoBusy}
            />
          </div>
          <div className="phone-main-actions">
            <RoundButton
              large
              variant="end"
              icon={ICONS.hangup}
              title="Hang up Line 2, return to Line 1"
              onClick={handleHangUpLineTwoClick}
              disabled={lineTwoBusy}
            />
          </div>
          {targetError && <div className="error phone-extra-error">{targetError}</div>}
        </>
      )}

      {showInternalTransferModal && (
        <InternalTransferModal
          campaignId={campaignId}
          onClose={() => setShowInternalTransferModal(false)}
          onTransfer={handlePickedExtensionStartLineTwo}
        />
      )}
    </div>
  );
}
