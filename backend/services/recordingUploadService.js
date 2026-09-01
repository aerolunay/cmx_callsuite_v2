"use strict";

const fs = require("fs");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const AWS_REGION = process.env.AWS_REGION;
const S3_RECORDING_BUCKET = process.env.S3_RECORDING_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

if (!AWS_REGION || !S3_RECORDING_BUCKET || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  throw new Error(
    "Missing S3 recording configuration. Set AWS_REGION, S3_RECORDING_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY in backend/.env."
  );
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

/*
==================================================
RECORDING PATH — matches dialerService.js/inboundCallService.js
==================================================
Same convention, kept as its own small copy here rather than importing
from either service file — same reasoning as inboundCallService.js's
own local copy: genuinely a one-line function, and this file shouldn't
need to import from either call-handling service just for this.

Still used as the BASE filename requested when telling Asterisk where
to record (see ami.js's startRecording call sites) — Asterisk itself
decides the FINAL actual filename, see findLocalRecordingFile below.
==================================================
*/
const RECORDING_DIR = "/var/spool/asterisk/monitor";
function recordingPathForCall(callId) {
  return `${RECORDING_DIR}/${callId}.wav`;
}

/*
==================================================
findLocalRecordingFile — REAL BUG FIX
==================================================
Asterisk's ConfbridgeStartRecord/MixMonitor does NOT use the exact
filename it's given — it appends "-<unix-timestamp>" before the
extension regardless (confirmed directly: every real recording on this
server landed as "<callId>-<timestamp>.wav", never the plain
"<callId>.wav" this code was checking for). This is a genuine,
documented Asterisk behavior (uniqueness protection against re-
recording the same conference name), not a bug in how we call
ConfbridgeStartRecord — but this code was checking for an EXACT
filename match that could never exist, so every single upload attempt
failed with "recording may never have started," even though recording
was working correctly and every file was sitting right there the
whole time (confirmed: real recordings going back days, all under the
"-<timestamp>.wav" naming, never uploaded to S3 because of this exact
mismatch).

Since we don't know the exact timestamp Asterisk will pick in advance,
this globs the directory for any file starting with "<callId>-" and
ending in ".wav" instead of checking one fixed path.
==================================================
*/
function findLocalRecordingFile(callId) {
  const prefix = `${callId}-`;
  const files = fs.readdirSync(RECORDING_DIR);
  const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".wav"));
  return match ? `${RECORDING_DIR}/${match}` : null;
}

// S3 key format — organized by campaign folder within the bucket for
// tidiness. Deliberately an EXPLICIT mapping, not just campaignId used
// directly as the folder name — BSMSC needs a specific, human-chosen
// folder name ("bsmsc_call_recordings"), not whatever its internal
// campaign_id happens to be. Falls back to using campaignId itself as
// the folder name for any future campaign not yet added here — same
// "one central place to add a new campaign" pattern as
// inboundCallService.js's DID_TO_CAMPAIGN.
const CAMPAIGN_RECORDING_FOLDERS = {
  CMXBSMSC: "bsmsc_call_recordings",
};

function recordingKeyForCall(campaignId, callId) {
  const folder = CAMPAIGN_RECORDING_FOLDERS[campaignId] || campaignId;
  return `${folder}/${callId}.wav`;
}

/*
==================================================
uploadRecording
==================================================
Reads the local .wav file (written by Asterisk's ConfbridgeStartRecord/
StopRecord — see ami.js) and uploads it to S3. Returns the S3 key
(NOT a URL — the bucket is fully private, so there's no permanent
public URL to store; playback always goes through getPlaybackUrl()
below, generating a fresh, time-limited presigned URL on demand).

Deliberately does NOT delete the local file after a successful upload
— by explicit design, this app has NO deletion capability against
either the local recording or the S3 copy at all. A separate, external
process owns cleanup entirely.

Throws a clear, specific error if no matching local file is found
(genuinely never started recording — e.g. a campaign with recording
disabled) rather than letting a raw ENOENT bubble up from the AWS SDK.
==================================================
*/
async function uploadRecording(callId, campaignId) {
  const localPath = findLocalRecordingFile(callId);

  if (!localPath) {
    throw new Error(
      `No local recording file found for call ${callId} in ${RECORDING_DIR} (looked for ${callId}-*.wav) — recording may never have started.`
    );
  }

  const key = recordingKeyForCall(campaignId, callId);
  const fileStream = fs.createReadStream(localPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_RECORDING_BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: "audio/wav",
    })
  );

  return key;
}

/*
==================================================
getPlaybackUrl
==================================================
Generates a fresh, time-limited presigned GET URL for the Call Logs
page's play button — the bucket is fully private (Block Public Access
enabled on all four settings), so there is no way to play a recording
back without one of these. 1 hour expiry — long enough for a
supervisor to actually listen to a call in one sitting, short enough
that a URL copied/shared somewhere doesn't stay valid indefinitely.
==================================================
*/
async function getPlaybackUrl(recordingKey) {
  const command = new GetObjectCommand({
    Bucket: S3_RECORDING_BUCKET,
    Key: recordingKey,
  });

  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

/*
==================================================
getDownloadUrl
==================================================
Per explicit request — admin-only recording download. Same
presigned-URL mechanism as getPlaybackUrl above, but with
ResponseContentDisposition explicitly set to "attachment" — without
this, S3 serves the file with whatever Content-Type it was uploaded
as (audio/wav), which browsers play inline rather than prompting an
actual file save. This is what makes it a real download instead of
just another way to listen.
==================================================
*/
async function getDownloadUrl(recordingKey, filename) {
  const command = new GetObjectCommand({
    Bucket: S3_RECORDING_BUCKET,
    Key: recordingKey,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });

  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

/*
==================================================
VOICEMAIL — uploadVoicemailRecording / voicemailKeyForRecording
==================================================
Deliberately separate from uploadRecording/recordingKeyForCall above,
not a variant reusing the same code path — two real differences:

1. Asterisk's Record() app (what captures a voicemail — see
   campaignRoutes.js's buildCampaignDialplanBlock) writes the EXACT
   filename it's given, unlike ConfbridgeStartRecord/MixMonitor (what
   captures a normal call), which always appends "-<unix-timestamp>"
   regardless of what filename you ask for (see findLocalRecordingFile's
   own comment above for how that was actually confirmed). A voicemail
   file's exact path is already known in advance — no glob/prefix
   search needed at all.
2. inboundCallService.js already knows the exact local path (it
   computed it — see voicemailRecordingPath there) and the exact S3
   key it wants, rather than needing this file to derive either one
   from a callId the way uploadRecording does.

voicemailKeyForRecording nests under "voicemails/" inside the SAME
per-campaign folder convention as call recordings
(CAMPAIGN_RECORDING_FOLDERS) — reuses that existing map rather than
introducing a second, parallel one, so a voicemail and that same
campaign's call recordings land in sibling locations in S3, not
scattered across two unrelated naming schemes.

getPlaybackUrl/getDownloadUrl above already work on ANY recordingKey
regardless of which of these two upload paths produced it — no changes
needed there for voicemail playback/download.
==================================================
*/
function voicemailKeyForRecording(campaignId, recordingId) {
  const folder = CAMPAIGN_RECORDING_FOLDERS[campaignId] || campaignId;
  return `${folder}/voicemails/${recordingId}.wav`;
}

async function uploadVoicemailRecording(localPath, key) {
  if (!fs.existsSync(localPath)) {
    throw new Error(
      `No local voicemail recording found at ${localPath} — Record() may never have started, or the file was already cleaned up.`
    );
  }

  const fileStream = fs.createReadStream(localPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_RECORDING_BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: "audio/wav",
    })
  );

  return key;
}

module.exports = {
  uploadRecording,
  getPlaybackUrl,
  getDownloadUrl,
  recordingPathForCall,
  recordingKeyForCall,
  // VOICEMAIL — new exports
  uploadVoicemailRecording,
  voicemailKeyForRecording,
};