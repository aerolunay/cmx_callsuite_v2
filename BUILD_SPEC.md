# CMX Dialer — Standalone Build Specification

## Project Goal

Build a brand-new, standalone full-stack application (`cmx_dialer`) that fully
replaces ViciDial's legacy web agent interface (`vicidial.php`), while ViciDial and
Asterisk continue running underneath to handle telephony (trunk, dialplan,
conferencing). This app is intentionally simple and generic:

1. Agent logs in.
2. Agent selects which campaign they're working (multiple campaigns run on this
   system).
3. Agent clicks "Dial Next Number" — the app pulls the next lead for that campaign
   and places the call.
4. When the call ends, the agent picks a **generic final disposition** (see list
   below) and the app moves to the next lead.

This app does **not** include campaign-specific intake forms/questionnaires —
those will be built separately per account later. Keep the disposition/call-handling
core intentionally decoupled from any per-campaign logic so those forms can be added
later without touching the dialer core.

**Critical architectural decision:** Do NOT depend on any of ViciDial's own Perl/PHP
glue scripts for call-state detection (`AST_update.pl`, `conf_exten_check.php`,
`live_channels`/`live_sip_channels` tables). Those are 15+ year old scripts with
multiple confirmed bugs on this server's modern Asterisk/PJSIP setup (documented
below, under "Known Issues"). Instead, this app talks to Asterisk directly via the
**Asterisk Manager Interface (AMI)** over a persistent TCP socket, listening to real
AMI events for call state. This is the correct, modern way to build this integration
and avoids an entire category of bugs already found and fixed the hard way tonight.

ViciDial's own tables (`vicidial_list`, `vicidial_hopper`, `vicidial_campaigns`, etc.)
remain the source of truth for lead data and campaign configuration — this app reads
them directly and writes back minimal status updates, rather than duplicating
ViciDial's own campaign-configuration UI.

---

## Tech Stack

- Backend: Node.js + Express, MySQL via `mysql2`, session-based auth
  (`express-session` + `session-file-store`, matching the pattern already used in
  the CMX org's other Node apps).
- Frontend: React + Vite.
- Real-time updates: WebSocket (`ws` package) for pushing live call-state to the
  frontend — **do not implement this via polling**, which is the exact anti-pattern
  that caused most of tonight's ViciDial bugs.

---

## Infrastructure (put real values in `.env`, never hardcode)

- Asterisk/ViciDial server: `dialer.cmxinnovations.com`
- MySQL database: `asterisk` (ViciDial's own schema)
- Asterisk AMI: TCP port `5038` on the Asterisk server, defined in
  `/etc/asterisk/manager.conf`. **Create a new, dedicated manager user for this app**
  rather than reusing ViciDial's existing `sendcron`/`listencron`/`cron` accounts:
  ```
  [cmxdialer]
  secret = <choose a strong secret, put in .env, not in manager.conf docs>
  read = system,call,log,verbose,command,agent,user,originate
  write = system,call,log,verbose,command,agent,user,originate
  ```
- Agent phone naming convention: `ccNNN` (e.g. `cc100`), PJSIP protocol, defined in
  ViciDial's `phones` table. Agents currently use a real SIP softphone client
  (MicroSIP) registered to their `ccNNN` PJSIP endpoint for audio — see "Known
  Issues" below for why browser WebRTC audio isn't ready yet.
- Outbound trunk PJSIP endpoint name: `QUESTBLUE` (static IP peer, no registration
  needed to reach it).

---

## ViciDial Database Schema Reference (database `asterisk`)

- **`vicidial_campaigns`** — list of campaigns. Key columns used here:
  `campaign_id`, `campaign_name`, `campaign_cid` (outbound caller ID to use),
  `active` (only show `active='Y'` campaigns in the campaign picker).
- **`vicidial_list`** — leads. Key columns: `lead_id`, `list_id`, `phone_number`,
  `status`, `called_since_last_reset`, first/last name, address fields.
- **`vicidial_hopper`** — the "ready to dial" queue per campaign. Columns:
  `hopper_id`, `lead_id`, `campaign_id`, `status` (`READY`), `list_id`,
  `gmt_offset_now`, `state`, `alt_dial`, `priority`, `source`, `vendor_lead_code`.
  **Known issue:** ViciDial's own `AST_VDhopper.pl` script has a silent-fail bug on
  this server and does not reliably auto-populate this table. This app's backend
  must be able to pull the next lead directly from `vicidial_list` (filtered by
  campaign's associated `list_id`(s), `status`, and `called_since_last_reset`) when
  the hopper is empty, rather than depending on that script ever running correctly.
- **`phones`** — agent phone records (`extension`, `login`, `pass`, `protocol`,
  `server_ip`). Used to know which PJSIP endpoint (`ccNNN`) an agent should be
  originated to.
- **`vicidial_users`** — ViciDial's existing agent user table. Recommended: reuse
  this table for authentication (so account creation/management stays in one place
  via ViciDial's admin, or via a shared admin tool later) rather than creating a
  parallel user table. Confirm password hashing scheme in use
  (`vicidial_users.pass`) before wiring auth — ViciDial supports both plaintext and
  bcrypt depending on system settings; check `system_settings` for the relevant
  flag before assuming one or the other.
- Do **not** use `vicidial_manager` (the old async AMI-action queue table) or
  `live_channels`/`live_sip_channels` — see Known Issues.

---

## Asterisk Dialplan Context (already built and confirmed working — do not recreate)

The following dialplan already exists in `/etc/asterisk/extensions.conf` on the
Asterisk server, context `[default]`. This app originates calls against these
existing extensions — do not add new dialplan from the app side.

```
; Outbound calling via QuestBlue trunk
exten => _1NXXNXXXXXX,1,NoOp(Outbound call via QuestBlue: ${EXTEN})
exten => _1NXXNXXXXXX,n,Set(CALLERID(all)="CMX Outbound" <CAMPAIGN_CID>)
exten => _1NXXNXXXXXX,n,Dial(PJSIP/${EXTEN:1}@QUESTBLUE,,tTo)
exten => _1NXXNXXXXXX,n,Hangup()

; Agent joins conference room via extension 2<room>
exten => _29600XXX,1,Answer()
exten => _29600XXX,n,Playback(sip-silence)
exten => _29600XXX,n,ConfBridge(${EXTEN:1},vici_agent_bridge,vici_agent_user)
exten => _29600XXX,n,Hangup()

; Customer/trunk leg joins the same room via extension <room>
exten => _9600XXX,1,Answer()
exten => _9600XXX,n,Playback(sip-silence)
exten => _9600XXX,n,ConfBridge(${EXTEN},vici_agent_bridge,vici_customer_user)
exten => _9600XXX,n,Hangup()
```

### Call flow this app must implement (two AMI Originate actions per call)

Pick a unique 7-digit room number per concurrent call, matching pattern `9600XXX`
(e.g. maintain an in-memory or DB-backed counter of currently-in-use room numbers
per server instance, wrapping 000–999, and skip any still marked in-use).

1. **Agent leg** — Originate to the agent's registered phone, landing on the
   agent-join extension:
   ```
   Action: Originate
   Channel: PJSIP/<agent_extension>     (e.g. PJSIP/cc100)
   Context: default
   Exten: 2<room>                        (e.g. 29600000)
   Priority: 1
   CallerID: "<agent display name>" <CAMPAIGN_CID>
   Async: true
   ```
2. Wait for a `ConfbridgeJoin` AMI event confirming the agent's channel actually
   joined room `<room>` before firing the second leg — do not fire both
   simultaneously, or the customer may connect into an empty room with nobody there.
3. **Customer leg** — Originate a Local channel that both rings the customer and
   joins them into the same room:
   ```
   Action: Originate
   Channel: Local/<room>@default
   Context: default
   Exten: <the actual phone number to dial, e.g. 13473088552>
   Priority: 1
   CallerID: "<agent display name>" <CAMPAIGN_CID>
   Async: true
   ```
   The dialplan's `_1NXXNXXXXXX` pattern picks up the dialed number from the
   `Local/<room>@default` channel's second half automatically — this mirrors
   exactly how ViciDial's own manual-dial flow works (confirmed working tonight).

### AMI events to listen for (replaces all broken PHP/Perl polling)

Connect once at app startup, keep the socket open, auto-reconnect on drop. Listen
for:

- `Newchannel` — correlate channel names to your internal call/room IDs.
- `Newstate` with `ChannelStateDesc: Up` — a leg has connected/answered.
- `ConfbridgeJoin` — a channel joined the ConfBridge room (`Conference` field =
  the room number). **This is the definitive "agent/customer is actually
  connected" signal.**
- `ConfbridgeLeave` — a channel left the room (hangup/disconnect signal).
- `Hangup` — a channel ended, with `Cause`/`Cause-txt` for the reason. Use this to
  auto-trigger the disposition screen if the agent didn't manually hang up first
  (e.g. customer hung up — pre-select "CX Hung Up" as a default, agent confirms).

---

## Generic Final Dispositions

Fixed list, same across all campaigns (per product decision — no per-campaign
config needed for v1, but store as a simple DB table `dispositions` so it can be
edited via a future admin screen without a code change):

| Code | Label |
|---|---|
| `CALL_ENDED` | Call Ended |
| `CX_HUNG_UP` | CX Hung Up |
| `NO_ANSWER` | No Answer |
| `VOICEMAIL` | Voicemail |
| `WRONG_NUMBER` | Wrong Number |
| `NOT_INTERESTED` | Not Interested |
| `DO_NOT_CALL` | Do Not Call (DNC) |
| `CALLBACK` | Callback Requested |

Confirm this exact set (and ordering) with the product owner before building the UI
buttons — treat this table as a sensible starting default, easy to adjust in the
`dispositions` table without a redeploy.

`CALLBACK` should prompt for a simple date/time before saving (reuse a plain HTML
date+time input — no need for anything fancier in v1).

### What happens on disposition save

1. Insert a row into a new, simple **`dialer_call_log`** table owned by this app
   (see schema below) — this is the primary record of what happened, and is not
   dependent on fully replicating ViciDial's own `vicidial_log`/`vicidial_agent_log`
   schemas (which have many fields not relevant here).
2. Update `vicidial_list.status` for the lead to a reasonable equivalent ViciDial
   status code (e.g. map `NO_ANSWER` → `'NA'`, `VOICEMAIL` → `'AM'`, `DO_NOT_CALL` →
   `'DNC'`, etc. — check ViciDial's existing status codes in
   `vicidial_campaigns`/`vicidial_statuses_available`-type reference tables for the
   exact codes already configured, and map to the closest match) so ViciDial's own
   admin/reporting screens stay reasonably in sync even though agents never touch
   `vicidial.php`.
3. Set `called_since_last_reset = 'Y'` on the lead.

### Suggested `dialer_call_log` schema (new table, own database or a new schema —
### do not add to ViciDial's `asterisk` schema)

```sql
CREATE TABLE dialer_call_log (
  call_log_id     BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_user      VARCHAR(50) NOT NULL,
  campaign_id     VARCHAR(50) NOT NULL,
  lead_id         BIGINT NOT NULL,
  phone_number    VARCHAR(20) NOT NULL,
  room_number     VARCHAR(10) NOT NULL,
  call_started_at DATETIME NOT NULL,
  call_ended_at   DATETIME NULL,
  disposition     VARCHAR(30) NOT NULL,
  callback_at     DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Known Issues From Tonight's Debugging (context for Claude Code — do not repeat)

1. `AST_update.pl` (ViciDial's channel-state poller) has at least 8 confirmed bugs on
   this server's Asterisk 20.x/PJSIP setup: didn't recognize PJSIP channels at all
   (only chan_sip), used a dead legacy AMI command for its Asterisk-version range,
   had a broken self-check that made it exit immediately every run, used a SIP
   terminator pattern that doesn't exist in modern AMI output, read the wrong field
   index after parsing, had a header-validation check that never passes on modern
   output, and never stripped the `"Output: "` AMI field prefix before pattern-
   matching channel names. **This app must not use this script or its output
   tables (`live_channels`, `live_sip_channels`) for anything.** Use AMI events
   directly.
2. `chan_sip` is not available on this Asterisk build — only `chan_pjsip`. Any
   config referencing `SIP/xxx` (vs `PJSIP/xxx`) will silently fail.
3. WebRTC (browser-based softphone audio) is not yet working end-to-end on this
   server — signaling completes but audio (RTP/ICE) does not reliably flow.
   **Do not build a browser-based softphone into this app's frontend for v1.**
   Agents use a real SIP softphone (MicroSIP) registered to their `ccNNN` PJSIP
   endpoint for audio. This app's frontend only triggers/monitors calls; it does
   not carry audio.
4. `vicidial.php`'s own dial-timeout detection (a separate, unrelated JS timer from
   the `live_channels` issue above) shows a false "Dial timed out" alert to agents
   even on fully successful calls, because it also depends on fragile legacy
   detection. This app's own AMI-event-driven status tracking avoids this whole
   class of problem by construction — no separate fix needed, just don't copy that
   pattern.

---

## Backend Modules to Build

### `backend/config/ami.js`
Persistent AMI connection manager using a maintained npm package (evaluate current
options — e.g. `asterisk-manager` — for AMI protocol handling rather than hand-
rolling it). Responsibilities:
- Connect on startup with the dedicated `cmxdialer` manager user, auto-reconnect on
  drop.
- Expose a promise-based `originate(options)` function.
- Expose an event emitter other modules subscribe to for `ConfbridgeJoin`,
  `ConfbridgeLeave`, `Hangup`, `Newstate`.

### `backend/services/dialerService.js`
- `getNextLead(campaignId)` — query `vicidial_hopper` first; if empty, fall back to
  querying `vicidial_list` directly for the next eligible lead in that campaign.
- `startCall({ agentUser, agentExtension, leadId, phoneNumber, campaignCid })` —
  allocates a room number, sends the agent-leg Originate, waits for that agent's
  `ConfbridgeJoin` event, then sends the customer-leg Originate. Returns a
  `callId`/`room` for the frontend to track.
- `getCallStatus(callId)` — internal state derived from AMI events received so far
  (`ringing_agent`, `agent_connected`, `ringing_customer`, `customer_connected`,
  `ended`) — push this via WebSocket, don't require polling.
- `saveDisposition({ callId, disposition, callbackAt })` — writes
  `dialer_call_log`, updates `vicidial_list`, as described above.
- `endCall(callId)` — sends AMI `Hangup` for both legs.

### `backend/routes/dialerRoutes.js`
- `GET /api/campaigns` — active campaigns from `vicidial_campaigns`, for the
  campaign picker screen.
- `POST /api/dialer/next-lead` — `{ campaignId }` → lead info.
- `POST /api/dialer/start-call` — `{ campaignId, leadId }` → `{ callId, room }`.
- `POST /api/dialer/end-call/:callId`
- `POST /api/dialer/disposition/:callId` — `{ disposition, callbackAt? }`.
- WebSocket endpoint (e.g. `/ws/dialer`) pushing `{ callId, status }` updates.

### `backend/routes/authRoutes.js`
- `POST /api/auth/login` — validate against `vicidial_users` (confirm hashing
  scheme first, see schema notes above).
- `POST /api/auth/logout`
- `GET /api/auth/me`

---

## Frontend Pages/Components

- **LoginPage** — username/password.
- **CampaignSelectPage** — list of active campaigns (from `GET /api/campaigns`),
  agent picks one to start working.
- **DialerPage** (the main working screen):
  - "Dial Next Number" button (disabled while a call is active).
  - Live call status area (Idle / Ringing Agent / Agent Connected / Ringing
    Customer / Customer Connected / Ended) — driven by the WebSocket, not polling.
  - Lead info display (name, phone, address) once a lead is loaded.
  - Disposition button bar (the 8 generic options above) — shown once a call ends
    or the agent manually ends it. `CALLBACK` opens a small date/time picker
    inline before submitting.
  - "Change Campaign" link/button to go back to CampaignSelectPage.

---

## Build Order (suggested phases)

1. **Scaffold**: new Express + React app, MySQL connection, basic login against
   `vicidial_users` (confirm password check works against a real test account
   first).
2. **Campaign picker**: `GET /api/campaigns` + `CampaignSelectPage`.
3. **AMI connectivity**: build `ami.js`, confirm you can see live AMI events firing
   when a test call happens via ViciDial's existing agent flow (proves your
   listener works before you build origination on top of it).
4. **Dialer service + routes**: `getNextLead`, `startCall`, event-driven status.
   Test manually with one agent extension end-to-end (agent leg rings real phone,
   customer leg rings a real number, both join the same room).
5. **WebSocket push + DialerPage UI**: live status without polling.
6. **Disposition save**: `dialer_call_log` table, `vicidial_list` status sync,
   disposition button UI, callback date/time picker.
7. **Polish**: reconnect logic, room-number collision avoidance for concurrent
   agents, error handling, basic logging.

---

## What NOT to Do

- Do not use `vicidial.php`, `conf_exten_check.php`, or any other ViciDial PHP
  script as an API — they are session/cookie-coupled to ViciDial's own login flow.
- Do not poll `live_channels`/`live_sip_channels` tables, or poll any status
  endpoint from the frontend at all — use the WebSocket push.
- Do not depend on `AST_VDhopper.pl`, `AST_manager_send.pl`, or
  `AST_manager_listen.pl` continuing to run — this app is self-sufficient for its
  own dialing needs via direct AMI.
- Do not build browser WebRTC audio in v1 (see Known Issue #3).
- Do not build per-campaign intake forms/questionnaires in this app — that's
  explicitly out of scope, to be added separately per account later.
