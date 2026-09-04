"use strict";

const db = require("../config/db");

/*
==================================================
CAMPAIGN DISPOSITION SERVICE
==================================================
Per explicit request — lets an admin modify, add, or remove
dispositions from the generic list on a PER-CAMPAIGN basis, for
Inbound and Outbound independently, through the Admin -> Campaigns UI
(see AdminCampaignsSection.jsx) rather than by editing
frontend/src/constants/dispositions.js and redeploying every time a
campaign needs a different set. "If the user chooses not to set
custom dispositions for the campaign, it uses the generic one" is
enforced by the two enabled flags below — a campaign with a custom
list saved but its flag off still falls back to generic, same as one
that's never touched this feature at all. The custom rows aren't
deleted when a flag is turned off, so re-enabling later restores
exactly what was there before, rather than making the admin re-type it.

Two tables, per direction, matching this app's existing "each concern
gets its own home in cmx_dialer.campaign_settings" pattern
(campaignRoutes.js's own header comment) rather than overloading an
existing column:
  - cmx_dialer.campaign_settings.custom_inbound_dispositions_enabled /
    custom_outbound_dispositions_enabled ('Y'/'N', default 'N') — the
    on/off switch itself, one column per direction.
  - cmx_dialer.campaign_dispositions — the actual custom rows, one row
    per (campaign_id, direction, value). Kept in its own table rather
    than a JSON column so each row has a real, independently-orderable
    identity — a straightforward DELETE-then-reinsert-in-order on save
    is simpler and safer than diffing a JSON blob, and matches this
    app's general preference for real relational tables over stuffing
    structured data into a single column (see agent_campaign_
    assignments, agent_working_campaigns, etc. elsewhere in this app).

NEITHER of these two tables/columns exist yet as of this feature
shipping — see the SQL migration note delivered alongside this file.
This service assumes they're already in place; every query here will
fail loudly (surfaced as a 500 from the calling route) until that
migration has been run on the target database.

"Generic" itself is NOT duplicated here on the backend — it's already
defined once, client-side, in frontend/src/constants/dispositions.js
(DISPOSITIONS / INBOUND_DISPOSITIONS + the BSMSC/BSCSR overrides). This
service only ever answers "does this campaign have a custom override,
and if so what is it" — the frontend is responsible for falling back
to its own existing getInboundDispositionsForCampaign/
getOutboundDispositionsForCampaign when the answer is no. This keeps
the two campaign-specific hardcoded overrides (BSMSC/BSCSR) working
exactly as they already do for any campaign that never touches this
new feature, and avoids maintaining the same generic list in two
places that could drift out of sync.
==================================================
*/

const DIRECTIONS = ["INBOUND", "OUTBOUND"];

function assertValidDirection(direction) {
  if (!DIRECTIONS.includes(direction)) {
    throw new Error(`direction must be one of ${DIRECTIONS.join(", ")}.`);
  }
}

// Same shape the admin editor and DialerPage's own fallback lists both
// already use elsewhere in this app: [{ value, label }, ...].
// Auto-derives `value` from `label` when the caller doesn't supply one
// (e.g. a plain-language label typed into the admin form) — uppercase
// snake_case, matching every hardcoded disposition value already in
// constants/dispositions.js (SCREENING_COMPLETED, NOT_ELIGIBLE, etc.),
// so a stored disposition value looks the same regardless of whether
// it came from the old hardcoded lists or this new per-campaign one.
function slugifyValue(label) {
  return String(label || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    const label = String(row?.label || "").trim();
    if (!label) continue; // silently drops fully-blank rows — the admin
    // editor never submits one on purpose, but a stray empty row from
    // a fast "add then immediately remove" click shouldn't 400 the
    // whole save.
    const value = String(row?.value || "").trim().toUpperCase().replace(/\s+/g, "_") || slugifyValue(label);
    if (seen.has(value)) continue; // last-one-wins would silently
    // overwrite a row order-dependent way; first-one-wins is simpler
    // to reason about and matches how the admin editor renders top to
    // bottom.
    seen.add(value);
    normalized.push({ value, label });
  }
  return normalized;
}

/*
==================================================
getCampaignDispositions
==================================================
Used by BOTH the admin editor (campaignRoutes.js) and the agent-facing
read used by DialerPage to resolve the effective list for an active
call (dialerRoutes.js) — one query, one shape, no drift between what
an admin sees they saved and what an agent's dropdown actually shows.
==================================================
*/
async function getCampaignDispositions(campaignId) {
  const [[settingsRow], [dispositionRows]] = await Promise.all([
    db.execute(
      `
        SELECT custom_inbound_dispositions_enabled, custom_outbound_dispositions_enabled
        FROM cmx_dialer.campaign_settings
        WHERE campaign_id = ?
      `,
      [campaignId]
    ),
    db.execute(
      `
        SELECT direction, value, label
        FROM cmx_dialer.campaign_dispositions
        WHERE campaign_id = ?
        ORDER BY direction ASC, sort_order ASC
      `,
      [campaignId]
    ),
  ]);

  const settings = settingsRow[0] || {};
  const inbound = dispositionRows.filter((r) => r.direction === "INBOUND").map((r) => ({ value: r.value, label: r.label }));
  const outbound = dispositionRows.filter((r) => r.direction === "OUTBOUND").map((r) => ({ value: r.value, label: r.label }));

  return {
    inboundEnabled: settings.custom_inbound_dispositions_enabled === "Y",
    outboundEnabled: settings.custom_outbound_dispositions_enabled === "Y",
    inbound,
    outbound,
  };
}

/*
==================================================
saveCampaignDispositions
==================================================
Full replace per direction, in one transaction — same "delete then
reinsert in the new order" approach already used elsewhere in this
app for small ordered lists (e.g. business_days), rather than trying
to diff individual row adds/removes/reorders on the client. sort_order
is just each row's position in the array the admin editor submitted —
preserves whatever order they arranged the rows in.

Turning a direction's flag OFF does NOT delete its rows here — see
this file's own header comment for why (re-enabling later should
restore what was there, not force starting over). Turning it ON with
zero rows is rejected below: a campaign whose admin explicitly wants
"custom" dispositions but hasn't actually defined any yet is very
likely a mistake (e.g. they toggled the checkbox but didn't click
"Load Generic as Starting Point" first), and letting that save through
would leave the DialerPage.jsx call flow with an empty dropdown for
that direction — silently blocking every agent from being able to
disposition a real call. Toggling it OFF, however, is always allowed
even with zero saved rows — "no custom list yet" and "back to generic"
are the same state either way.
==================================================
*/
async function saveCampaignDispositions(campaignId, { inboundEnabled, outboundEnabled, inbound, outbound }) {
  const normalizedInbound = normalizeRows(inbound);
  const normalizedOutbound = normalizeRows(outbound);

  if (inboundEnabled && normalizedInbound.length === 0) {
    throw new Error("At least one inbound disposition is required when custom inbound dispositions are enabled.");
  }
  if (outboundEnabled && normalizedOutbound.length === 0) {
    throw new Error("At least one outbound disposition is required when custom outbound dispositions are enabled.");
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [settingsRows] = await connection.execute(
      `SELECT 1 FROM cmx_dialer.campaign_settings WHERE campaign_id = ?`,
      [campaignId]
    );
    if (settingsRows.length === 0) {
      throw new Error(`Campaign ${campaignId} has no campaign_settings row — cannot save dispositions.`);
    }

    await connection.execute(
      `
        UPDATE cmx_dialer.campaign_settings
        SET custom_inbound_dispositions_enabled = ?, custom_outbound_dispositions_enabled = ?
        WHERE campaign_id = ?
      `,
      [inboundEnabled ? "Y" : "N", outboundEnabled ? "Y" : "N", campaignId]
    );

    for (const direction of DIRECTIONS) {
      assertValidDirection(direction);
      await connection.execute(`DELETE FROM cmx_dialer.campaign_dispositions WHERE campaign_id = ? AND direction = ?`, [
        campaignId,
        direction,
      ]);
    }

    const rowsToInsert = [
      ...normalizedInbound.map((r, i) => ["INBOUND", r, i]),
      ...normalizedOutbound.map((r, i) => ["OUTBOUND", r, i]),
    ];
    for (const [direction, row, sortOrder] of rowsToInsert) {
      await connection.execute(
        `
          INSERT INTO cmx_dialer.campaign_dispositions (campaign_id, direction, value, label, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `,
        [campaignId, direction, row.value, row.label, sortOrder]
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return getCampaignDispositions(campaignId);
}

module.exports = { getCampaignDispositions, saveCampaignDispositions, slugifyValue };
