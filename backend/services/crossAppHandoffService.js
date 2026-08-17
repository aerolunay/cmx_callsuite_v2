"use strict";

const crypto = require("crypto");

/*
==================================================
CROSS-APP HANDOFF SERVICE
==================================================
Backs the "Open Screening Form" link on the DialerPage. This is
deliberately NOT a real session or a long-lived token — it's a
one-time, single-use code that exists only long enough to bridge the
redirect from this app to cmx_scn_suite (the screening app) and back
through its own /api/auth/cross-app/exchange -> our
POST /api/auth/cross-app/verify round trip. Once cmx_scn_suite
verifies it, IT creates its own session — this code has no further
purpose after that and is deleted immediately, whether verification
succeeds or fails.

60s is intentionally short: the whole round trip (browser opens the
link, cmx_scn_suite's frontend reads ?code=, POSTs to its own backend,
which POSTs to our /verify below) happens in well under a second in
practice — this window exists purely to tolerate a slow network, not
to function as a real session lifetime.
==================================================
*/

const HANDOFF_CODE_TTL_MS = 60 * 1000;

// code -> { agent, expiresAt }
const pendingCodes = new Map();

function generateHandoffCode(agent) {
  const code = crypto.randomBytes(24).toString("hex");
  pendingCodes.set(code, { agent, expiresAt: Date.now() + HANDOFF_CODE_TTL_MS });
  return code;
}

// Single-use: deletes the code the moment it's looked up, regardless
// of whether it turns out to be expired — a code should never be
// usable twice, whether the first use succeeded or not.
function consumeHandoffCode(code) {
  const entry = pendingCodes.get(code);
  if (!entry) return null;
  pendingCodes.delete(code);

  if (Date.now() > entry.expiresAt) return null;

  return entry.agent;
}

// Sweeps stale, never-redeemed codes (an agent who copies the link but
// never actually opens it, etc.) so this Map can't grow unbounded.
// .unref() so this timer never keeps the process alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pendingCodes.entries()) {
    if (now > entry.expiresAt) pendingCodes.delete(code);
  }
}, 60 * 1000).unref();

module.exports = { generateHandoffCode, consumeHandoffCode };
