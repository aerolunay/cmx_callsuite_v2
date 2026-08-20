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
==================================================
*/
const RECORDING_DIR = "/var/spool/asterisk/monitor";
function recordingPathForCall(callId) {
  return `${RECORDING_DIR}/${callId}.wav`;
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

Throws a clear, specific error if the local file doesn't exist (e.g.
recording never actually started — AMI action failed, or this was
called for a non-BSMSC call that was never recording in the first
place) rather than letting a raw ENOENT bubble up from the AWS SDK.
==================================================
*/
async function uploadRecording(callId, campaignId) {
  const localPath = recordingPathForCall(callId);

  if (!fs.existsSync(localPath)) {
    throw new Error(`No local recording file found at ${localPath} for call ${callId} — recording may never have started.`);
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

module.exports = {
  uploadRecording,
  getPlaybackUrl,
  recordingPathForCall,
  recordingKeyForCall,
};
