"use strict";

/*
==================================================
EMAIL TEMPLATES
==================================================
Branded HTML for outbound emails — CallMax navy/cyan, matching the
app's own header (see BUILD_SPEC.md's pixel-sampled brand colors).
Every function returns { subject, text, html } — text is a real
plain-text fallback for clients that don't render HTML, not an
afterthought, since some corporate mail filters/screen readers still
prefer it.

FRONTEND_URL is reused from the same env var server.js already relies
on for CORS — one source of truth for "where does this app live",
not a second URL to keep in sync.
==================================================
*/

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

function wrapEmailHtml(bodyHtml) {
  return `
<div style="font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #f4f6fa;">
  <div style="background: #182d57; padding: 28px 24px; text-align: center;">
    <span style="font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: 1px;">
      CALLMAX
    </span>
  </div>
  <div style="padding: 32px 28px; background: #ffffff; color: #182d57;">
    ${bodyHtml}
  </div>
  <div style="padding: 16px 28px; text-align: center; color: #98a2b3; font-size: 12px;">
    CallMax Solutions &middot; CMX Dialer
  </div>
</div>
  `.trim();
}

/*
==================================================
buildOtpEmail
==================================================
Replaces the old plain `text: "Your login code is ${code}..."` —
same information, but the code itself is now visually unmissable
(large, bordered, letter-spaced) instead of buried in a sentence.
==================================================
*/
function buildOtpEmail({ fullName, code, expiryMinutes }) {
  const firstName = (fullName || "").split(" ")[0] || "there";

  const html = wrapEmailHtml(`
    <p style="margin: 0 0 16px; font-size: 15px;">Hi ${firstName},</p>
    <p style="margin: 0 0 24px; font-size: 15px;">Here's your CMX Dialer login code:</p>
    <div style="text-align: center; margin: 0 0 24px;">
      <span style="display: inline-block; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #182d57; background: #f4f6fa; border: 1px solid #d9dee6; border-radius: 8px; padding: 16px 24px;">
        ${code}
      </span>
    </div>
    <p style="margin: 0; font-size: 13px; color: #667085;">
      This code expires in ${expiryMinutes} minute${expiryMinutes === 1 ? "" : "s"}. If you didn't request this, you can safely ignore this email.
    </p>
  `);

  const text = `Hi ${firstName},\n\nYour CMX Dialer login code is: ${code}\n\nThis code expires in ${expiryMinutes} minute${expiryMinutes === 1 ? "" : "s"}. If you didn't request this, you can safely ignore this email.`;

  return { subject: "Your CMX Dialer login code", text, html };
}

/*
==================================================
buildWelcomeEmail
==================================================
Sent once, at account creation (adminRoutes.js's POST /users).
Deliberately doesn't mention a password anywhere — this app has never
been password-based (OTP + optional TOTP only, see authRoutes.js), so
a welcome email that implied otherwise would be actively misleading.
==================================================
*/
function buildWelcomeEmail({ fullName, email, accessLevel }) {
  const firstName = (fullName || "").split(" ")[0] || "there";
  const loginUrl = `${FRONTEND_URL}/login`;

  const html = wrapEmailHtml(`
    <p style="margin: 0 0 16px; font-size: 15px;">Hi ${firstName},</p>
    <p style="margin: 0 0 16px; font-size: 15px;">
      An account has been created for you on CMX Dialer as
      <strong>${accessLevel}</strong>.
    </p>
    <p style="margin: 0 0 24px; font-size: 15px;">
      There's no password to set up — every login is a one-time code sent to
      <strong>${email}</strong>. Head to the login page, enter your email, and
      we'll send you a code to get in.
    </p>
    <div style="text-align: center; margin: 0 0 24px;">
      <a href="${loginUrl}" style="display: inline-block; background: #182d57; color: #ffffff; font-weight: 700; font-size: 14px; text-decoration: none; padding: 12px 28px; border-radius: 6px;">
        Go to Login
      </a>
    </div>
    <p style="margin: 0; font-size: 13px; color: #667085;">
      Once you're in, we'd also recommend setting up an authenticator app for
      extra security — you'll see the option right after you log in.
    </p>
  `);

  const text = `Hi ${firstName},\n\nAn account has been created for you on CMX Dialer as ${accessLevel}.\n\nThere's no password to set up — every login is a one-time code sent to ${email}. Go to ${loginUrl}, enter your email, and we'll send you a code to get in.\n\nOnce you're in, we'd also recommend setting up an authenticator app for extra security.`;

  return { subject: "Welcome to CMX Dialer", text, html };
}

module.exports = { buildOtpEmail, buildWelcomeEmail };
