"use strict";

const nodemailer = require("nodemailer");

/*
==================================================
MAILER
==================================================
Moved out of authRoutes.js (where it originally lived, only used for
OTP emails) so adminRoutes.js can reuse the SAME configured transporter
for welcome emails, instead of a second SMTP config drifting out of
sync with this one over time.

SMTP_ALLOW_SELF_SIGNED is an explicit opt-in, not a default. It
disables TLS certificate validation on the SMTP connection —
appropriate ONLY if this really is an internal mail server on a
trusted network whose cert is self-signed/internally-signed, not a
workaround to reach for casually. Prefer fixing the actual cert trust
chain if possible instead of leaving this on indefinitely.
==================================================
*/
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== "true",
  },
});

module.exports = { transporter };
