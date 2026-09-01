"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const express = require("express");
const multer = require("multer");
const db = require("../config/db");
const ami = require("../config/ami");

const execFileAsync = util.promisify(execFile);

const router = express.Router();

/*
==================================================
CAMPAIGN MANAGEMENT — create/edit/delete campaigns, with auto-created
DID routing, audio prompts, and dialplan
==================================================
Writes to THREE places per campaign, in one DB transaction:
  1. asterisk.vicidial_campaigns   — ViciDial's own native campaign
     row. Only a practical subset of its 300+ columns is set here,
     same "MVP subset, everything else takes ViciDial's own defaults"
     approach already used for vicidial_users/phones elsewhere in this
     app.
  2. asterisk.vicidial_inbound_dids — ViciDial's own native DID-routing
     table. This app's OWN inbound call handling (inboundCallService.js)
     reads this table directly now (did_pattern -> campaign_id) — see
     that file's lookupCampaignForDid(). Writing a row here is what
     makes a brand-new campaign's DID work immediately, with zero
     backend redeploy.
  3. cmx_dialer.campaign_settings   — the pieces neither ViciDial table
     has: which audio files play, and the business-hours window that
     decides which one plays. See sql/001_create_campaign_settings.sql.

Then, OUTSIDE the DB transaction (same "commit first, apply to
Asterisk after" pattern as adminRoutes.js's phone/vicidial-user
routes): converts the uploaded audio files to raw .ulaw, moves
them into Asterisk's sounds/custom directory (via a narrowly-scoped
sudo — see deployAudioFile()), regenerates the campaign dialplan file
from every active campaign's DB row (same "rebuild the whole file from
the DB every time" pattern as adminRoutes.js's phone wizard file), and
reloads ONLY the dialplan (never pjsip.conf) — so this can never
disrupt an in-progress call on a different campaign or on the shared
trunk.

==================================================
FIELD MAPPING — what this app's UI concept maps to on each real table
==================================================
- Caller ID (spoof DID if blank)  -> vicidial_campaigns.campaign_cid
  (if the admin leaves Caller ID blank, campaign_cid is set to the DID
  itself, not left as ViciDial's own default '0000000000')
- Outbound vs Blended             -> cmx_dialer.campaign_settings.campaign_type
  (NOT vicidial_campaigns.campaign_allow_inbound — deliberately kept
  separate; see the SQL file's own comment for why)
- Auto Dial vs Manual Dial        -> vicidial_campaigns.dial_method
  ('MANUAL' vs 'RATIO' — RATIO is the simplest real auto-dial method
  value; this app does not yet implement actual predictive/ratio
  dialing logic, so this is stored as configuration/intent for future
  use, matching the "auto-dial campaign readiness" note already in the
  Phase B addendum bookmark)
- Call Recording Enabled/Disabled -> vicidial_campaigns.campaign_recording
  ('ALLCALLS' vs 'NEVER' — dialerService.js/inboundCallService.js now
  both check this column directly instead of a hardcoded
  campaignId === "CMXBSMSC" check)
- Welcome Greeting / After Hours  -> cmx_dialer.campaign_settings
  (filenames only; the actual .ulaw files live in
  SOUNDS_CUSTOM_DIR, named deterministically from campaignId)
- Business hours                 -> cmx_dialer.campaign_settings
  (NOT explicitly requested, but functionally required — the
  after-hours audio has no meaning without a real hours/days window to
  gate on. Defaults to 09:00-18:00, mon-fri if not provided.)
- Voicemail Capture Enabled       -> cmx_dialer.campaign_settings.voicemail_enabled
  (single toggle, covers BOTH business-hours and after-hours voicemail
  offer — see buildCampaignDialplanBlock's own comments for exactly
  what changes in the generated dialplan when this is 'Y')
- Business/After Hours IVR Prompts,
  Invalid Option Prompt           -> cmx_dialer.campaign_settings
  (three separate per-campaign uploads — see processUploadedAudio call
  sites below. The actual "leave a message after the beep" prompt is
  NOT per-campaign; it's a single hardcoded sound file, shared by
  every campaign's voicemail capture — see
  VOICEMAIL_LEAVE_MESSAGE_SOUND. The beep itself is Asterisk's own
  core "beep" sound file, played via Playback(beep) — NOT the Beep()
  application, which isn't loaded on every Asterisk install; confirmed
  the hard way via a real test call's "No application 'Beep'" error.)
==================================================
*/

const SOUNDS_CUSTOM_DIR = process.env.SOUNDS_CUSTOM_DIR || "/var/lib/asterisk/sounds/custom";
const CAMPAIGN_DIALPLAN_CONF_PATH =
  process.env.CAMPAIGN_DIALPLAN_CONF_PATH || "/etc/asterisk/extensions-campaigns-cmxdialer.conf";
const CAMPAIGN_AUDIO_STAGING_DIR = path.join(__dirname, "..", "tmp", "campaign-audio-staging");
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const INTERNAL_API_BASE_URL = process.env.INTERNAL_API_BASE_URL || "http://127.0.0.1:5060";

// VOICEMAIL — global, hardcoded, NOT campaign-specific and NOT
// admin-uploaded through this file's usual audio pipeline. Deployed
// once, directly, to SOUNDS_CUSTOM_DIR — see the project notes for the
// deploy steps. Its script already includes the full instructions
// ("please leave a message after the beep, to send press 1, otherwise
// press 2 to create a new message"), so nothing else needs to play
// before Record() starts, and nothing needs to play after it either
// unless the caller's input is missing/invalid — see
// buildCampaignDialplanBlock's vmRecordLabel block.
const VOICEMAIL_LEAVE_MESSAGE_SOUND = "custom/cmx-voicemail-leave-message";

// Separate spool dir from call recordings (RECORDING_DIR in
// inboundCallService.js) — Record() writes here, not MixMonitor, so a
// voicemail capture is never confused with an in-progress call
// recording during cleanup/inspection. Must be created on the server
// with Asterisk-writable permissions before this ships — NOT done by
// any of the migration/setup scripts so far.
const VOICEMAIL_SPOOL_DIR = "/var/spool/asterisk/monitor/voicemail";

if (!INTERNAL_API_SECRET) {
  console.warn(
    "[campaignRoutes] INTERNAL_API_SECRET is not set in .env — generated dialplan CURL() calls will fail their secret check."
  );
}

// Ensure the staging directory exists at startup — this is a directory
// the app's own OS user already owns (created alongside its own code,
// not inside any Asterisk-owned tree), so no elevated privilege is
// needed for this part.
fs.mkdirSync(CAMPAIGN_AUDIO_STAGING_DIR, { recursive: true });

const upload = multer({
  dest: CAMPAIGN_AUDIO_STAGING_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — generous for a short voice prompt
});

// REAL BUG FIX: this local copy was never updated when WFM got full
// Admin page access — only adminRoutes.js's own separate requireAdmin
// was fixed for that. Since Campaigns is part of the Admin page, WFM
// couldn't actually manage campaigns despite the access-level spec
// saying they should be able to.
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  if (req.session.agent.accessLevel !== "admin" && req.session.agent.accessLevel !== "wfm") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  return next();
}

/*
==================================================
AUDIO CONVERSION + DEPLOYMENT
==================================================
convertToUlaw uses execFile (never a shell string) — arguments are
passed as an array, so there is no shell-injection surface even though
the input filename technically comes from a user upload.

deployAudioFile is the ONLY place in this file that shells out via
sudo. It requires a one-time, narrowly-scoped sudoers rule on whichever
OS user runs this Node process — see the project notes for the exact
line to add. Scoped to exactly two commands (mv into
SOUNDS_CUSTOM_DIR, restorecon on a path inside SOUNDS_CUSTOM_DIR) —
nothing broader. If that sudoers rule doesn't exist yet, both
execFileAsync calls below will reject with a permission error, which
is caught and surfaced as a reloadWarning rather than silently losing
the uploaded file.
==================================================
*/
async function convertToUlaw(inputPath, outputPath) {
  await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-ar", "8000", "-ac", "1", "-f", "mulaw", outputPath]);
}

async function deployAudioFile(stagedUlawPath, finalFilename) {
  const destPath = path.join(SOUNDS_CUSTOM_DIR, finalFilename);
  await execFileAsync("sudo", ["/bin/mv", stagedUlawPath, destPath]);
  await execFileAsync("sudo", ["/sbin/restorecon", destPath]);
  return destPath;
}

// Converts one uploaded multer file (already on disk at file.path) into
// a deployed .ulaw file named deterministically from the campaign ID,
// cleaning up every intermediate staged file whether it succeeds or
// fails. Returns the final filename (not full path) to store in the DB.
async function processUploadedAudio(file, campaignId, kind) {
  const finalFilename = `cmx-campaign-${campaignId}-${kind}.ulaw`;
  const stagedUlawPath = path.join(CAMPAIGN_AUDIO_STAGING_DIR, `${path.basename(file.path)}.ulaw`);

  try {
    await convertToUlaw(file.path, stagedUlawPath);
    await deployAudioFile(stagedUlawPath, finalFilename);
    return finalFilename;
  } finally {
    // Best-effort cleanup of both staging artifacts — the original
    // multer upload (pre-conversion) and the converted .ulaw if
    // deployAudioFile's mv somehow didn't consume it (e.g. it failed
    // before the mv step). Errors here are logged, not thrown — a
    // leftover temp file is a minor annoyance, not worth failing the
    // whole request over.
    fs.unlink(file.path, (err) => {
      if (err && err.code !== "ENOENT") console.error(`[campaignRoutes] Failed to clean up staged upload ${file.path}:`, err.message);
    });
    fs.unlink(stagedUlawPath, (err) => {
      if (err && err.code !== "ENOENT") console.error(`[campaignRoutes] Failed to clean up staged ulaw ${stagedUlawPath}:`, err.message);
    });
  }
}

/*
==================================================
DIALPLAN GENERATION
==================================================
Same "regenerate the whole file from the DB every time" pattern as
adminRoutes.js's phone wizard file — the file can never drift from
what's actually in the database, and every campaign create/update/
delete rewrites it from scratch rather than trying to patch one block
in place.

Per-DID extension/label names are all prefixed with the DID itself
(e.g. "6468016974_open", "6468016974_afterhours") — REQUIRED, not
cosmetic: Phase 9's original single-DID example used bare "open"/
"afterhours" names, which only worked because there was exactly one
DID in the context. With multiple campaigns sharing [trunkinbound],
two campaigns both defining a plain "afterhours" extension would
silently overwrite each other. Scoping every label to its own DID
avoids that collision entirely.

==================================================
VOICEMAIL — what changes when voicemailEnabled is 'Y'
==================================================
Business hours: instead of going straight into ConfBridge (which just
plays cmxwait's own MOH class — hold music, then a generic "please
continue holding" announcement, on a loop — with no way to capture a
DTMF press), the caller is held in a dialplan-level loop instead:
MusicOnHold(cmxvmwait, waitSeconds) [hold music ONLY, no generic
announcement — see the cmxvmwait MOH class, deliberately separate from
cmxwait] followed by Read() with this campaign's own voicemail-offer
prompt. Read() is what actually captures the "press 1" — MOH alone
can't. Not in the ConfBridge yet, so inboundCallService.js's
customerEnteredWaitLoop()/tryConnectReadyAgentsInner() handle pulling
the caller INTO the ConfBridge the moment an agent is actually found,
via an AMI redirect — see that file's own comments.

After hours: the voicemail offer is immediate (no wait loop — there's
no agent to wait for at all after hours), with one retry on an invalid
keypress before giving up and hanging up.

Recording (both paths, shared logic): Playback the single hardcoded
VOICEMAIL_LEAVE_MESSAGE_SOUND (already includes the full spoken
instructions) -> Playback(beep) [Asterisk's own core "beep" sound
file — NOT the Beep() application, which isn't loaded on every
Asterisk install, confirmed via a real test call] -> Record() ->
silently Read() a single digit
(no audio — the caller was already told what to press) for up to 45
seconds. "1" saves and hangs up. "2" loops back to record again, no
error message (a deliberate, valid choice). Anything else — silence
for the full 45s, or a genuinely invalid digit — plays this campaign's
shared invalid-option prompt (if uploaded) and THEN loops back to
record again, same as "2" — a real caller's in-progress message should
never be silently discarded on ambiguous input.
==================================================
*/
function buildCampaignDialplanBlock({
  did,
  campaignId,
  campaignType,
  blendedFallbackCampaignId,
  welcomeGreetingFilename,
  afterhoursAudioFilename,
  businessHoursStart,
  businessHoursEnd,
  businessDays,
  voicemailEnabled,
  voicemailPromptAudioFilename,
  afterhoursVoicemailPromptAudioFilename,
  voicemailInvalidOptionAudioFilename,
  voicemailWaitSeconds,
}) {
  // Per explicit request, confirmed as a real gap via a live test
  // call: an OUTBOUND campaign's own DID was routing inbound calls
  // straight to its own agents, which must never happen — outbound
  // campaigns have no inbound queue of their own at all. If this DID
  // is also used as that campaign's outbound Caller ID ("spoofed
  // number") and a customer calls it back, blendedFallbackCampaignId
  // (admin-configured, see AdminCampaignsSection.jsx) says which
  // BLENDED campaign's queue should receive it instead. No fallback
  // configured -> generate NOTHING for this DID at all, the safest
  // default: Asterisk's own "no matching extension" behavior applies,
  // rather than ever connecting to the outbound campaign's own agents.
  if (campaignType === "OUTBOUND") {
    if (!blendedFallbackCampaignId) {
      return "";
    }

    // Deliberately minimal — no business-hours/greeting/voicemail
    // logic of its own here (this DID isn't really "a campaign's
    // front door", it's just a redirect for an outbound Caller ID's
    // own callbacks). The BLENDED campaign's own DID/queue already
    // has all of that, for calls that reach it directly.
    return [
      `exten => ${did},1,NoOp(CMX Campaign ${campaignId} (OUTBOUND) inbound callback -> redirecting to blended campaign ${blendedFallbackCampaignId})`,
      `exten => ${did},n,Answer()`,
      `exten => ${did},n,Set(ROOM=\${CURL(${INTERNAL_API_BASE_URL}/internal/allocate-inbound-room?secret=${INTERNAL_API_SECRET}&did=${did}&campaignId=${blendedFallbackCampaignId})})`,
      `exten => ${did},n,GotoIf($["\${ROOM}" = ""]?${did}_no_room)`,
      `exten => ${did},n,ConfBridge(\${ROOM},vici_agent_bridge,cmx_inbound_customer)`,
      `exten => ${did},n,Hangup()`,
      `exten => ${did},n(${did}_no_room),Hangup()`,
      ``,
    ].join("\n");
  }

  const openLabel = `${did}_open`;
  const afterhoursExten = `${did}_afterhours`;
  const afterhoursEndLabel = `${did}_afterhours_end`;
  const noRoomLabel = `${did}_no_room`;
  const vmWaitLabel = `${did}_vm_wait`;
  const vmRecordLabel = `${did}_vm_record`;
  const vmRecordStartLabel = `${did}_vm_record_start`;
  const vmRecordSaveLabel = `${did}_vm_record_save`;
  const afterhoursVmRecordLabel = `${did}_afterhours_vm_record`;
  const afterhoursVmRecordStartLabel = `${did}_afterhours_vm_record_start`;
  const afterhoursVmRecordSaveLabel = `${did}_afterhours_vm_record_save`;

  // Playback() takes the path MINUS the file extension — Asterisk
  // picks the actual format itself. Confirmed convention from Phase 9
  // (custom/cmxbsm-greeting, no .ulaw suffix in the dialplan line).
  const greetingSound = welcomeGreetingFilename
    ? `custom/${path.basename(welcomeGreetingFilename, path.extname(welcomeGreetingFilename))}`
    : null;
  const afterhoursSound = afterhoursAudioFilename
    ? `custom/${path.basename(afterhoursAudioFilename, path.extname(afterhoursAudioFilename))}`
    : null;
  // Voicemail-related sounds — each optional even when voicemailEnabled
  // is 'Y' (an admin can flip the toggle on before every prompt is
  // uploaded). Read()'s filename argument accepts an empty string (no
  // playback, just waits for a digit), so a missing upload degrades to
  // a silent prompt rather than breaking the call; Playback() is simply
  // skipped for a missing invalid-option sound.
  const voicemailPromptSound = voicemailPromptAudioFilename
    ? `custom/${path.basename(voicemailPromptAudioFilename, path.extname(voicemailPromptAudioFilename))}`
    : "";
  const afterhoursVoicemailPromptSound = afterhoursVoicemailPromptAudioFilename
    ? `custom/${path.basename(afterhoursVoicemailPromptAudioFilename, path.extname(afterhoursVoicemailPromptAudioFilename))}`
    : "";
  const voicemailInvalidOptionSound = voicemailInvalidOptionAudioFilename
    ? `custom/${path.basename(voicemailInvalidOptionAudioFilename, path.extname(voicemailInvalidOptionAudioFilename))}`
    : "";
  // 60s floor enforced here too, not just in the admin routes below —
  // this function is the last line of defense before it's baked into
  // a static dialplan file, so a bad/missing value can't slip through
  // some other future call site of this function.
  const waitSeconds = Math.max(60, Number(voicemailWaitSeconds) || 60);
  const isVoicemailEnabled = voicemailEnabled === "Y";

  const lines = [
    `exten => ${did},1,NoOp(CMX Campaign ${campaignId} inbound)`,
    `exten => ${did},n,GotoIfTime(${businessHoursStart}-${businessHoursEnd},${businessDays},*,*?${openLabel})`,
    `exten => ${did},n,Goto(${afterhoursExten},1)`,
    `exten => ${did},n(${openLabel}),Answer()`,
  ];

  if (greetingSound) {
    lines.push(`exten => ${did},n,Playback(${greetingSound})`);
  }

  lines.push(
    `exten => ${did},n,Set(ROOM=\${CURL(${INTERNAL_API_BASE_URL}/internal/allocate-inbound-room?secret=${INTERNAL_API_SECRET}&did=${did})})`,
    `exten => ${did},n,GotoIf($["\${ROOM}" = ""]?${noRoomLabel})`
  );

  if (isVoicemailEnabled) {
    // Caller is deliberately NOT put in the ConfBridge yet — see this
    // function's own header comment for the full "why". Read() (not
    // WaitExten/bare-digit-extension matching) captures the digit, to
    // avoid ever adding a shared "1" extension into [trunkinbound],
    // which every OTHER campaign's block also lives inside.
    lines.push(
      // REAL BUG FIX, confirmed via a real test call: Set(CURL(url)=)
      // — the "write" pattern — never actually fired the request at
      // all. allocate-inbound-room above works because it uses the
      // "read" pattern (Set(VAR=${CURL(url)})), which genuinely
      // performs the HTTP call; these three fire-and-forget calls
      // used the write pattern instead, since no return value is
      // needed — but CURL() apparently has no real write handler for
      // an arbitrary URL like this, so the call silently never
      // happened. Confirmed directly: a manual curl to this same
      // endpoint showed up in the backend's access log immediately;
      // the dialplan's own Set(CURL(...)=) version never did, for an
      // hours-long real test call. Fixed by switching to the same
      // read pattern, discarding into a throwaway variable instead of
      // a real one.
      `exten => ${did},n,Set(CMXDISCARD=\${CURL(${INTERNAL_API_BASE_URL}/internal/customer-waiting?secret=${INTERNAL_API_SECRET}&room=\${ROOM}&channel=\${CHANNEL}&callerId=\${CALLERID(num)})})`,
      `exten => ${did},n(${vmWaitLabel}),MusicOnHold(cmxvmwait,${waitSeconds})`,
      `exten => ${did},n,Read(CMXVMCHOICE,${voicemailPromptSound},1,,,6)`,
      `exten => ${did},n,GotoIf($["\${CMXVMCHOICE}" = "1"]?${vmRecordLabel},1)`,
      `exten => ${did},n,GotoIf($["\${CMXVMCHOICE}" = ""]?${vmWaitLabel})`
    );
    if (voicemailInvalidOptionSound) {
      lines.push(`exten => ${did},n,Playback(${voicemailInvalidOptionSound})`);
    }
    lines.push(`exten => ${did},n,Goto(${vmWaitLabel})`);
  } else {
    lines.push(`exten => ${did},n,ConfBridge(\${ROOM},vici_agent_bridge,cmx_inbound_customer)`, `exten => ${did},n,Hangup()`);
  }

  lines.push(`exten => ${did},n(${noRoomLabel}),Hangup()`);

  if (isVoicemailEnabled) {
    lines.push(
      `exten => ${vmRecordLabel},1,NoOp(CMX Campaign ${campaignId} inbound voicemail - business hours)`,
      `exten => ${vmRecordLabel},n,Set(CMXDISCARD=\${CURL(${INTERNAL_API_BASE_URL}/internal/voicemail-starting?secret=${INTERNAL_API_SECRET}&room=\${ROOM})})`,
      `exten => ${vmRecordLabel},n(${vmRecordStartLabel}),Playback(${VOICEMAIL_LEAVE_MESSAGE_SOUND})`,
      `exten => ${vmRecordLabel},n,Playback(beep)`,
      // REAL BUG FIX, confirmed via a real test call: Record()'s
      // syntax is filename:format — it appends ".format" itself.
      // Writing "${ROOM}.wav:wav" produced an actual file named
      // "${ROOM}.wav.wav" on disk, never matching what
      // voicemailRecordingPath(key) in inboundCallService.js expected
      // ("${ROOM}.wav") — every voicemail's S3 upload would have
      // silently failed (best-effort, so the call itself wouldn't
      // have dropped, but the recording would never have reached S3).
      `exten => ${vmRecordLabel},n,Record(${VOICEMAIL_SPOOL_DIR}/\${ROOM}:wav,3,300,k)`,
      `exten => ${vmRecordLabel},n,Read(CMXVMCONFIRM,,1,,,45)`,
      `exten => ${vmRecordLabel},n,GotoIf($["\${CMXVMCONFIRM}" = "1"]?${vmRecordSaveLabel},1)`,
      `exten => ${vmRecordLabel},n,GotoIf($["\${CMXVMCONFIRM}" = "2"]?${vmRecordStartLabel})`
    );
    if (voicemailInvalidOptionSound) {
      lines.push(`exten => ${vmRecordLabel},n,Playback(${voicemailInvalidOptionSound})`);
    }
    lines.push(
      `exten => ${vmRecordLabel},n,Goto(${vmRecordStartLabel})`,
      `exten => ${vmRecordLabel},n(${vmRecordSaveLabel}),Set(CMXDISCARD=\${CURL(${INTERNAL_API_BASE_URL}/internal/voicemail-recorded?secret=${INTERNAL_API_SECRET}&room=\${ROOM}&campaignId=${campaignId}&callerId=\${CALLERID(num)}&isAfterHours=0)})`,
      `exten => ${vmRecordLabel},n,Hangup()`
    );
  }

  lines.push(`exten => ${afterhoursExten},1,Answer()`);

  if (afterhoursSound) {
    lines.push(`exten => ${afterhoursExten},n,Playback(${afterhoursSound})`);
  }

  if (isVoicemailEnabled) {
    // No wait loop after hours — offered immediately, once, per
    // explicit requirement. One retry after an invalid keypress; a
    // second miss (or no keypress at all) just hangs up, same as this
    // block's previous, simpler behavior when voicemail isn't enabled.
    lines.push(
      `exten => ${afterhoursExten},n,Read(CMXVMCHOICE,${afterhoursVoicemailPromptSound},1,,,6)`,
      `exten => ${afterhoursExten},n,GotoIf($["\${CMXVMCHOICE}" = "1"]?${afterhoursVmRecordLabel},1)`,
      `exten => ${afterhoursExten},n,GotoIf($["\${CMXVMCHOICE}" = "0"]?${afterhoursEndLabel})`,
      `exten => ${afterhoursExten},n,GotoIf($["\${CMXVMCHOICE}" = ""]?${afterhoursEndLabel})`
    );
    if (voicemailInvalidOptionSound) {
      lines.push(`exten => ${afterhoursExten},n,Playback(${voicemailInvalidOptionSound})`);
    }
    lines.push(
      `exten => ${afterhoursExten},n,Read(CMXVMCHOICE,${afterhoursVoicemailPromptSound},1,,,6)`,
      `exten => ${afterhoursExten},n,GotoIf($["\${CMXVMCHOICE}" = "1"]?${afterhoursVmRecordLabel},1)`,
      `exten => ${afterhoursExten},n(${afterhoursEndLabel}),Hangup()`,
      `exten => ${afterhoursVmRecordLabel},1,NoOp(CMX Campaign ${campaignId} inbound voicemail - after hours)`,
      `exten => ${afterhoursVmRecordLabel},n(${afterhoursVmRecordStartLabel}),Playback(${VOICEMAIL_LEAVE_MESSAGE_SOUND})`,
      `exten => ${afterhoursVmRecordLabel},n,Playback(beep)`,
      `exten => ${afterhoursVmRecordLabel},n,Record(${VOICEMAIL_SPOOL_DIR}/\${UNIQUEID}:wav,3,300,k)`,
      `exten => ${afterhoursVmRecordLabel},n,Read(CMXVMCONFIRM,,1,,,45)`,
      `exten => ${afterhoursVmRecordLabel},n,GotoIf($["\${CMXVMCONFIRM}" = "1"]?${afterhoursVmRecordSaveLabel},1)`,
      `exten => ${afterhoursVmRecordLabel},n,GotoIf($["\${CMXVMCONFIRM}" = "2"]?${afterhoursVmRecordStartLabel})`
    );
    if (voicemailInvalidOptionSound) {
      lines.push(`exten => ${afterhoursVmRecordLabel},n,Playback(${voicemailInvalidOptionSound})`);
    }
    lines.push(
      `exten => ${afterhoursVmRecordLabel},n,Goto(${afterhoursVmRecordStartLabel})`,
      `exten => ${afterhoursVmRecordLabel},n(${afterhoursVmRecordSaveLabel}),Set(CMXDISCARD=\${CURL(${INTERNAL_API_BASE_URL}/internal/voicemail-recorded?secret=${INTERNAL_API_SECRET}&campaignId=${campaignId}&callerId=\${CALLERID(num)}&isAfterHours=1&uniqueId=\${UNIQUEID})})`,
      `exten => ${afterhoursVmRecordLabel},n,Hangup()`
    );
  } else {
    lines.push(`exten => ${afterhoursExten},n,Hangup()`, ``);
  }

  return lines.join("\n");
}

async function regenerateCampaignDialplanFile() {
  const [rows] = await db.execute(
    `
      SELECT
        d.did_pattern AS did,
        d.campaign_id AS campaignId,
        s.campaign_type AS campaignType,
        s.blended_fallback_campaign_id AS blendedFallbackCampaignId,
        s.welcome_greeting_filename AS welcomeGreetingFilename,
        s.afterhours_audio_filename AS afterhoursAudioFilename,
        s.business_hours_start AS businessHoursStart,
        s.business_hours_end AS businessHoursEnd,
        s.business_days AS businessDays,
        s.voicemail_enabled AS voicemailEnabled,
        s.voicemail_prompt_audio_filename AS voicemailPromptAudioFilename,
        s.afterhours_voicemail_prompt_audio_filename AS afterhoursVoicemailPromptAudioFilename,
        s.voicemail_invalid_option_audio_filename AS voicemailInvalidOptionAudioFilename,
        s.voicemail_wait_seconds AS voicemailWaitSeconds
      FROM asterisk.vicidial_inbound_dids d
      JOIN cmx_dialer.campaign_settings s ON s.campaign_id = d.campaign_id
      JOIN asterisk.vicidial_campaigns c ON c.campaign_id = d.campaign_id
      WHERE d.did_active = 'Y' AND c.active = 'Y'
      ORDER BY d.did_pattern ASC
    `
  );

  let content =
    "; AUTO-GENERATED by cmx_dialer's own admin panel — DO NOT EDIT MANUALLY.\n" +
    "; Regenerated automatically on every campaign create/update/delete via\n" +
    "; POST/PUT/DELETE /api/admin/campaigns. See campaignRoutes.js.\n" +
    "; This file is #included INSIDE the [trunkinbound] context in\n" +
    "; extensions.conf — it must never define its own context header.\n\n";

  for (const row of rows) {
    const block = buildCampaignDialplanBlock(row);
    if (block) content += block + "\n";
  }

  fs.writeFileSync(CAMPAIGN_DIALPLAN_CONF_PATH, content);
  await ami.reloadDialplan();
}

/*
==================================================
GET /api/admin/campaigns?includeInactive=true (optional)
==================================================
REAL BUG FIX: this previously returned every campaign regardless of
`active`, so a deleted campaign (DELETE sets active='N', it does not
hard-delete the row — see that route's own comment) never actually
disappeared from the admin table, just showed "Active: No" forever.
Confirmed via a real delete attempt where the row stayed listed and it
looked like the delete had silently failed, even though the DID/
settings rows WERE correctly removed underneath.

Defaults to active-only now, matching what an admin actually expects
from "the list of campaigns." Pass ?includeInactive=true to see
deactivated ones too (e.g. to confirm a delete actually took effect,
or to review history) — not exposed in the UI yet, but available if
needed later.
==================================================
*/
router.get("/", requireAdmin, async (req, res) => {
  try {
    const { includeInactive, type } = req.query;
    // type=OUTBOUND — added for the Lead Upload feature, per explicit
    // request to exclude Blended campaigns from that assignment
    // dropdown. Filters on cmx_dialer.campaign_settings.campaign_type,
    // NOT a native ViciDial column — see that table's own comment for
    // why this exists as a separate, explicit field rather than
    // overloading campaign_allow_inbound.
    const filters = [];
    if (includeInactive !== "true") filters.push("c.active = 'Y'");
    if (type) filters.push("s.campaign_type = ?");
    const params = type ? [type] : [];

    const [rows] = await db.execute(
      `
        SELECT
          c.campaign_id, c.campaign_name, c.active, c.campaign_cid, c.dial_method, c.campaign_recording,
          d.did_pattern AS did, d.record_call,
          s.campaign_type, s.welcome_greeting_filename, s.afterhours_audio_filename,
          s.business_hours_start, s.business_hours_end, s.business_days, s.blended_fallback_campaign_id,
          s.voicemail_enabled, s.voicemail_prompt_audio_filename, s.afterhours_voicemail_prompt_audio_filename,
          s.voicemail_invalid_option_audio_filename, s.voicemail_wait_seconds
        FROM asterisk.vicidial_campaigns c
        LEFT JOIN asterisk.vicidial_inbound_dids d ON d.campaign_id = c.campaign_id
        LEFT JOIN cmx_dialer.campaign_settings s ON s.campaign_id = c.campaign_id
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY c.campaign_id ASC
      `,
      params
    );
    return res.json({ success: true, campaigns: rows });
  } catch (error) {
    console.error("GET /api/admin/campaigns failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load campaigns." });
  }
});

/*
==================================================
POST /api/admin/campaigns
==================================================
multipart/form-data. Text fields: campaignId, campaignName, did,
callerId (optional — blank means spoof the DID as CID), campaignType
("OUTBOUND" | "BLENDED"), dialMethod ("AUTO" | "MANUAL", only really
meaningful for OUTBOUND), recordingEnabled ("true" | "false"),
businessHoursStart, businessHoursEnd, businessDays, voicemailEnabled
("true" | "false"), voicemailWaitSeconds.
Files: welcomeGreeting, afterhoursAudio, voicemailPromptAudio,
afterhoursVoicemailPromptAudio, voicemailInvalidOptionAudio (all
optional at the DB-write stage, but a campaign with no greeting/no DID
at all is a degenerate case worth allowing for pure-manual/no-inbound
campaigns).
==================================================
*/
router.post(
  "/",
  requireAdmin,
  upload.fields([
    { name: "welcomeGreeting", maxCount: 1 },
    { name: "afterhoursAudio", maxCount: 1 },
    { name: "voicemailPromptAudio", maxCount: 1 },
    { name: "afterhoursVoicemailPromptAudio", maxCount: 1 },
    { name: "voicemailInvalidOptionAudio", maxCount: 1 },
  ]),
  async (req, res) => {
    const {
      campaignId,
      campaignName,
      did,
      callerId,
      campaignType,
      dialMethod,
      recordingEnabled,
      businessHoursStart,
      businessHoursEnd,
      businessDays,
      blendedFallbackCampaignId,
      voicemailEnabled,
      voicemailWaitSeconds,
    } = req.body;

    if (!campaignId || !campaignName) {
      return res.status(400).json({ success: false, message: "campaignId and campaignName are required." });
    }
    if (!["OUTBOUND", "BLENDED"].includes(campaignType)) {
      return res.status(400).json({ success: false, message: "campaignType must be OUTBOUND or BLENDED." });
    }

    // Spoofing rule, per explicit request: blank Caller ID means "use
    // the DID itself" — NOT ViciDial's own campaign_cid default of
    // '0000000000'. If there's no DID either, falls through to
    // ViciDial's own default, since there's nothing to spoof from.
    const resolvedCallerId = (callerId || "").trim() || (did || "").trim() || "0000000000";

    const resolvedDialMethod = dialMethod === "AUTO" ? "RATIO" : "MANUAL";
    const resolvedRecording = recordingEnabled === "false" ? "NEVER" : "ALLCALLS";

    const resolvedBusinessHoursStart = businessHoursStart || "09:00";
    const resolvedBusinessHoursEnd = businessHoursEnd || "18:00";
    const resolvedBusinessDays = businessDays || "mon-fri";

    // VOICEMAIL — 'Y'/'N' single toggle, covers business hours AND
    // after hours together. 60s floor enforced here (same floor
    // re-checked in buildCampaignDialplanBlock as a last line of
    // defense before it's baked into the static dialplan file).
    const resolvedVoicemailEnabled = voicemailEnabled === "true" ? "Y" : "N";
    const resolvedVoicemailWaitSeconds = Math.max(60, parseInt(voicemailWaitSeconds, 10) || 60);

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      await connection.execute(
        `
          INSERT INTO asterisk.vicidial_campaigns
            (campaign_id, campaign_name, active, campaign_cid, dial_method, campaign_recording, campaign_allow_inbound)
          VALUES (?, ?, 'Y', ?, ?, ?, ?)
        `,
        [campaignId, campaignName, resolvedCallerId, resolvedDialMethod, resolvedRecording, campaignType === "BLENDED" ? "Y" : "N"]
      );

      if (did) {
        await connection.execute(
          `
            INSERT INTO asterisk.vicidial_inbound_dids
              (did_pattern, did_description, did_active, extension, exten_context, campaign_id, record_call)
            VALUES (?, ?, 'Y', ?, 'trunkinbound', ?, ?)
          `,
          [did, campaignName, did, campaignId, resolvedRecording === "NEVER" ? "N" : "Y"]
        );
      }

      await connection.execute(
        `
          INSERT INTO cmx_dialer.campaign_settings
            (campaign_id, campaign_type, business_hours_start, business_hours_end, business_days, blended_fallback_campaign_id, voicemail_enabled, voicemail_wait_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          campaignId,
          campaignType,
          resolvedBusinessHoursStart,
          resolvedBusinessHoursEnd,
          resolvedBusinessDays,
          blendedFallbackCampaignId || null,
          resolvedVoicemailEnabled,
          resolvedVoicemailWaitSeconds,
        ]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      console.error("POST /api/admin/campaigns failed:", error);
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ success: false, message: `Campaign ${campaignId} (or its DID) already exists.` });
      }
      return res.status(500).json({ success: false, message: "Failed to create campaign." });
    } finally {
      connection.release();
    }

    // Audio processing + dialplan generation happen AFTER commit — same
    // reasoning as adminRoutes.js's phone/vicidial-user routes: a slow
    // or failed Asterisk-side step should never make the
    // already-committed DB rows look like they failed to save.
    let reloadWarning;
    try {
      const welcomeFile = req.files?.welcomeGreeting?.[0];
      const afterhoursFile = req.files?.afterhoursAudio?.[0];
      const voicemailPromptFile = req.files?.voicemailPromptAudio?.[0];
      const afterhoursVoicemailPromptFile = req.files?.afterhoursVoicemailPromptAudio?.[0];
      const voicemailInvalidOptionFile = req.files?.voicemailInvalidOptionAudio?.[0];

      let welcomeGreetingFilename = null;
      let afterhoursAudioFilename = null;
      let voicemailPromptAudioFilename = null;
      let afterhoursVoicemailPromptAudioFilename = null;
      let voicemailInvalidOptionAudioFilename = null;

      if (welcomeFile) welcomeGreetingFilename = await processUploadedAudio(welcomeFile, campaignId, "greeting");
      if (afterhoursFile) afterhoursAudioFilename = await processUploadedAudio(afterhoursFile, campaignId, "afterhours");
      if (voicemailPromptFile) voicemailPromptAudioFilename = await processUploadedAudio(voicemailPromptFile, campaignId, "voicemail-prompt");
      if (afterhoursVoicemailPromptFile)
        afterhoursVoicemailPromptAudioFilename = await processUploadedAudio(afterhoursVoicemailPromptFile, campaignId, "afterhours-voicemail-prompt");
      if (voicemailInvalidOptionFile)
        voicemailInvalidOptionAudioFilename = await processUploadedAudio(voicemailInvalidOptionFile, campaignId, "voicemail-invalid-option");

      if (
        welcomeGreetingFilename ||
        afterhoursAudioFilename ||
        voicemailPromptAudioFilename ||
        afterhoursVoicemailPromptAudioFilename ||
        voicemailInvalidOptionAudioFilename
      ) {
        await db.execute(
          `
            UPDATE cmx_dialer.campaign_settings
            SET welcome_greeting_filename = COALESCE(?, welcome_greeting_filename),
                afterhours_audio_filename = COALESCE(?, afterhours_audio_filename),
                voicemail_prompt_audio_filename = COALESCE(?, voicemail_prompt_audio_filename),
                afterhours_voicemail_prompt_audio_filename = COALESCE(?, afterhours_voicemail_prompt_audio_filename),
                voicemail_invalid_option_audio_filename = COALESCE(?, voicemail_invalid_option_audio_filename)
            WHERE campaign_id = ?
          `,
          [
            welcomeGreetingFilename,
            afterhoursAudioFilename,
            voicemailPromptAudioFilename,
            afterhoursVoicemailPromptAudioFilename,
            voicemailInvalidOptionAudioFilename,
            campaignId,
          ]
        );
      }

      if (did) {
        await regenerateCampaignDialplanFile();
      }
    } catch (error) {
      console.error(`[campaignRoutes] Failed to process audio/dialplan for campaign ${campaignId}:`, error.message);
      reloadWarning =
        "Campaign was saved, but applying its audio/dialplan to Asterisk failed — it may not take calls correctly yet. Check server logs (this often means the sudoers rule for audio deployment isn't set up on this server yet).";
    }

    return res.json({ success: true, campaignId, reloadWarning });
  }
);

/*
==================================================
PUT /api/admin/campaigns/:campaignId
==================================================
Same field set as create; DID is treated as immutable once set (same
"delete + recreate" philosophy as extension/username elsewhere in this
app) — this route does NOT change the DID. Audio files are optional on
update — omit any file field entirely to keep the existing file.
==================================================
*/
router.put(
  "/:campaignId",
  requireAdmin,
  upload.fields([
    { name: "welcomeGreeting", maxCount: 1 },
    { name: "afterhoursAudio", maxCount: 1 },
    { name: "voicemailPromptAudio", maxCount: 1 },
    { name: "afterhoursVoicemailPromptAudio", maxCount: 1 },
    { name: "voicemailInvalidOptionAudio", maxCount: 1 },
  ]),
  async (req, res) => {
    const { campaignId } = req.params;
    const {
      campaignName,
      callerId,
      campaignType,
      dialMethod,
      recordingEnabled,
      businessHoursStart,
      businessHoursEnd,
      businessDays,
      active,
      blendedFallbackCampaignId,
      voicemailEnabled,
      voicemailWaitSeconds,
    } = req.body;

    if (!["OUTBOUND", "BLENDED"].includes(campaignType)) {
      return res.status(400).json({ success: false, message: "campaignType must be OUTBOUND or BLENDED." });
    }

    const [didRows] = await db.execute(
      `SELECT did_pattern FROM asterisk.vicidial_inbound_dids WHERE campaign_id = ? LIMIT 1`,
      [campaignId]
    );
    const did = didRows[0]?.did_pattern || null;

    const resolvedCallerId = (callerId || "").trim() || did || "0000000000";
    const resolvedDialMethod = dialMethod === "AUTO" ? "RATIO" : "MANUAL";
    const resolvedRecording = recordingEnabled === "false" ? "NEVER" : "ALLCALLS";

    // VOICEMAIL — same resolution/floor as the create route above.
    const resolvedVoicemailEnabled = voicemailEnabled === "true" ? "Y" : "N";
    const resolvedVoicemailWaitSeconds = Math.max(60, parseInt(voicemailWaitSeconds, 10) || 60);

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [result] = await connection.execute(
        `
          UPDATE asterisk.vicidial_campaigns
          SET campaign_name = ?, active = ?, campaign_cid = ?, dial_method = ?, campaign_recording = ?, campaign_allow_inbound = ?
          WHERE campaign_id = ?
        `,
        [
          campaignName,
          active === false ? "N" : "Y",
          resolvedCallerId,
          resolvedDialMethod,
          resolvedRecording,
          campaignType === "BLENDED" ? "Y" : "N",
          campaignId,
        ]
      );

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: "Campaign not found." });
      }

      if (did) {
        await connection.execute(
          `UPDATE asterisk.vicidial_inbound_dids SET record_call = ? WHERE campaign_id = ?`,
          [resolvedRecording === "NEVER" ? "N" : "Y", campaignId]
        );
      }

      // UPSERT, not a plain UPDATE — REAL BUG FIX: any campaign that
      // existed BEFORE this feature was built (CMXBSMSC, CMXBLND,
      // CMXBSM, CMXOUTB — everything predating campaignRoutes.js) has
      // NO row at all in cmx_dialer.campaign_settings yet, since it
      // was never created through POST /api/admin/campaigns. A plain
      // UPDATE against a nonexistent row silently affects 0 rows —
      // no error, no warning — so campaign_type/business-hours edits
      // on any legacy campaign appeared to save successfully but
      // never actually took effect. Confirmed via a real edit attempt
      // on CMXBSMSC (set to BLENDED, table kept showing OUTBOUND).
      await connection.execute(
        `
          INSERT INTO cmx_dialer.campaign_settings
            (campaign_id, campaign_type, business_hours_start, business_hours_end, business_days, blended_fallback_campaign_id, voicemail_enabled, voicemail_wait_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            campaign_type = VALUES(campaign_type),
            business_hours_start = VALUES(business_hours_start),
            business_hours_end = VALUES(business_hours_end),
            business_days = VALUES(business_days),
            blended_fallback_campaign_id = VALUES(blended_fallback_campaign_id),
            voicemail_enabled = VALUES(voicemail_enabled),
            voicemail_wait_seconds = VALUES(voicemail_wait_seconds)
        `,
        [
          campaignId,
          campaignType,
          businessHoursStart || "09:00",
          businessHoursEnd || "18:00",
          businessDays || "mon-fri",
          blendedFallbackCampaignId || null,
          resolvedVoicemailEnabled,
          resolvedVoicemailWaitSeconds,
        ]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      console.error(`PUT /api/admin/campaigns/${campaignId} failed:`, error);
      return res.status(500).json({ success: false, message: "Failed to update campaign." });
    } finally {
      connection.release();
    }

    let reloadWarning;
    try {
      const welcomeFile = req.files?.welcomeGreeting?.[0];
      const afterhoursFile = req.files?.afterhoursAudio?.[0];
      const voicemailPromptFile = req.files?.voicemailPromptAudio?.[0];
      const afterhoursVoicemailPromptFile = req.files?.afterhoursVoicemailPromptAudio?.[0];
      const voicemailInvalidOptionFile = req.files?.voicemailInvalidOptionAudio?.[0];

      let welcomeGreetingFilename = null;
      let afterhoursAudioFilename = null;
      let voicemailPromptAudioFilename = null;
      let afterhoursVoicemailPromptAudioFilename = null;
      let voicemailInvalidOptionAudioFilename = null;

      if (welcomeFile) welcomeGreetingFilename = await processUploadedAudio(welcomeFile, campaignId, "greeting");
      if (afterhoursFile) afterhoursAudioFilename = await processUploadedAudio(afterhoursFile, campaignId, "afterhours");
      if (voicemailPromptFile) voicemailPromptAudioFilename = await processUploadedAudio(voicemailPromptFile, campaignId, "voicemail-prompt");
      if (afterhoursVoicemailPromptFile)
        afterhoursVoicemailPromptAudioFilename = await processUploadedAudio(afterhoursVoicemailPromptFile, campaignId, "afterhours-voicemail-prompt");
      if (voicemailInvalidOptionFile)
        voicemailInvalidOptionAudioFilename = await processUploadedAudio(voicemailInvalidOptionFile, campaignId, "voicemail-invalid-option");

      if (
        welcomeGreetingFilename ||
        afterhoursAudioFilename ||
        voicemailPromptAudioFilename ||
        afterhoursVoicemailPromptAudioFilename ||
        voicemailInvalidOptionAudioFilename
      ) {
        await db.execute(
          `
            UPDATE cmx_dialer.campaign_settings
            SET welcome_greeting_filename = COALESCE(?, welcome_greeting_filename),
                afterhours_audio_filename = COALESCE(?, afterhours_audio_filename),
                voicemail_prompt_audio_filename = COALESCE(?, voicemail_prompt_audio_filename),
                afterhours_voicemail_prompt_audio_filename = COALESCE(?, afterhours_voicemail_prompt_audio_filename),
                voicemail_invalid_option_audio_filename = COALESCE(?, voicemail_invalid_option_audio_filename)
            WHERE campaign_id = ?
          `,
          [
            welcomeGreetingFilename,
            afterhoursAudioFilename,
            voicemailPromptAudioFilename,
            afterhoursVoicemailPromptAudioFilename,
            voicemailInvalidOptionAudioFilename,
            campaignId,
          ]
        );
      }

      if (did) {
        await regenerateCampaignDialplanFile();
      }
    } catch (error) {
      console.error(`[campaignRoutes] Failed to process audio/dialplan for campaign ${campaignId}:`, error.message);
      reloadWarning =
        "Campaign was updated, but applying its audio/dialplan to Asterisk failed. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  }
);

/*
==================================================
POST /api/admin/campaigns/:campaignId/deactivate
==================================================
Frees the campaign's DID (removes its vicidial_inbound_dids row) and
its cmx_dialer.campaign_settings row, and sets
vicidial_campaigns.active = 'N' — but does NOT remove the
vicidial_campaigns row itself. campaign_id stays reserved (a future
attempt to CREATE a new campaign reusing this exact ID will still fail
with a duplicate-entry error) and historical call/lead data referencing
this campaign_id remains intact and correctly named in reports.

This is what the old, single DELETE route used to do BEFORE it was
split into this + a true hard-delete below, per explicit request —
"Delete" and "Deactivate" are genuinely different operations with very
different consequences, and conflating them under one button/label was
misleading.
==================================================
*/
router.post("/:campaignId/deactivate", requireAdmin, async (req, res) => {
  const { campaignId } = req.params;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(`UPDATE asterisk.vicidial_campaigns SET active = 'N' WHERE campaign_id = ?`, [campaignId]);
    await connection.execute(`DELETE FROM asterisk.vicidial_inbound_dids WHERE campaign_id = ?`, [campaignId]);
    await connection.execute(`DELETE FROM cmx_dialer.campaign_settings WHERE campaign_id = ?`, [campaignId]);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error(`POST /api/admin/campaigns/${campaignId}/deactivate failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to deactivate campaign." });
  } finally {
    connection.release();
  }

  let reloadWarning;
  try {
    await regenerateCampaignDialplanFile();
  } catch (error) {
    console.error(`[campaignRoutes] Failed to regenerate dialplan after deactivating ${campaignId}:`, error.message);
    reloadWarning = "Campaign was deactivated, but Asterisk wasn't reloaded. Check server logs.";
  }

  return res.json({ success: true, reloadWarning });
});

/*
==================================================
DELETE /api/admin/campaigns/:campaignId
==================================================
TRUE, PERMANENT hard delete — removes the vicidial_campaigns row
itself, in addition to its DID and settings rows. campaign_id is freed
for reuse immediately after this.

REAL CONSEQUENCE, worth stating plainly: ViciDial's own schema does not
enforce a real foreign key from cmx_dialer.dialer_call_log/
inbound_call_log/agent_status_log's campaign_id columns back to
vicidial_campaigns — so this delete will NOT throw an error or get
blocked by historical call data referencing this campaign_id. It will,
however, leave that historical data "orphaned" in the sense that any
report/lookup joining back to vicidial_campaigns for this campaign_id's
name (see statsService.js's own campaign-name lookups) will find
nothing and show a blank/missing campaign name for those old calls
going forward. Deactivate (above) does not have this consequence —
use this only when truly permanent removal is intended.
==================================================
*/
router.delete("/:campaignId", requireAdmin, async (req, res) => {
  const { campaignId } = req.params;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // REAL BUG FIX: agent_campaign_assignments rows referencing this
    // campaign_id were never cleaned up here — confirmed via a real
    // delete where an agent's Users-table row kept showing the
    // deleted campaign's ID forever afterward, since nothing removed
    // the assignment row itself. Only done here (hard delete), NOT in
    // /deactivate above — a deactivated campaign might come back, and
    // agents should regain access automatically if it does; a
    // permanently deleted one never will, so its assignments are
    // genuinely orphaned data at that point, not just temporarily
    // inactive.
    await connection.execute(`DELETE FROM cmx_dialer.agent_campaign_assignments WHERE campaign_id = ?`, [campaignId]);
    await connection.execute(`DELETE FROM asterisk.vicidial_inbound_dids WHERE campaign_id = ?`, [campaignId]);
    await connection.execute(`DELETE FROM cmx_dialer.campaign_settings WHERE campaign_id = ?`, [campaignId]);
    const [result] = await connection.execute(`DELETE FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`, [campaignId]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error(`DELETE /api/admin/campaigns/${campaignId} failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to delete campaign." });
  } finally {
    connection.release();
  }

  let reloadWarning;
  try {
    await regenerateCampaignDialplanFile();
  } catch (error) {
    console.error(`[campaignRoutes] Failed to regenerate dialplan after deleting ${campaignId}:`, error.message);
    reloadWarning = "Campaign was deleted, but Asterisk wasn't reloaded. Check server logs.";
  }

  return res.json({ success: true, reloadWarning });
});

module.exports = router;