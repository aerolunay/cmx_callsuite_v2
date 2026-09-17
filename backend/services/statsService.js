"use strict";

const { DateTime } = require("luxon");
const db = require("../config/db");

/*
==================================================
EST/EDT DAY BOUNDARY — SELF-CALIBRATING
==================================================
See earlier comments in project history for why this doesn't trust
that NOW()/CURRENT_TIMESTAMP on this MySQL server is in any particular
timezone — computes "today" in America/New_York in Node (DST-aware,
via Luxon), then shifts by a live-measured offset between MySQL's own
NOW() and UTC_TIMESTAMP() at query time, so it self-corrects regardless
of what timezone the MySQL server actually thinks it's in.
==================================================
*/
async function getEasternDayBoundsForServerClock() {
  const todayNY = DateTime.now().setZone("America/New_York").toISODate();
  return getEasternRangeBoundsForServerClock(todayNY, todayNY);
}

/*
==================================================
getEasternRangeBoundsForServerClock — Phase 8 addition
==================================================
Same self-calibrating technique as getEasternDayBoundsForServerClock
above (which now just calls this with today's date on both ends), but
generalized to an arbitrary [startDate, endDate] range for the Reports
feature's date-range filter. startDate/endDate are "yyyy-MM-dd"
strings, interpreted as calendar days in America/New_York — start of
startDate through end of endDate, inclusive.
==================================================
*/
async function getEasternRangeBoundsForServerClock(startDate, endDate) {
  const startNY = DateTime.fromISO(startDate, { zone: "America/New_York" }).startOf("day");
  const endNY = DateTime.fromISO(endDate, { zone: "America/New_York" }).endOf("day");

  if (!startNY.isValid || !endNY.isValid) {
    throw new Error("Invalid startDate/endDate — expected yyyy-MM-dd.");
  }

  const [rows] = await db.execute(
    `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offset_seconds`
  );
  const offsetSeconds = rows[0].offset_seconds;

  const start = startNY.toUTC().plus({ seconds: offsetSeconds }).toFormat("yyyy-MM-dd HH:mm:ss");
  const end = endNY.toUTC().plus({ seconds: offsetSeconds }).toFormat("yyyy-MM-dd HH:mm:ss");

  return { start, end };
}

/*
==================================================
getVoicemailDashboardWindowForServerClock — NEW, per explicit request
==================================================
Powers the Live Status Dashboard's Voicemails card specifically (see
voicemailRoutes.js's GET /voicemails?window=dashboard) — NOT the
standalone VoicemailsPage.jsx, which keeps its own explicit
startDate/endDate filter and its original "no filter = show
everything" default completely untouched.

Window: 5 PM of the PREVIOUS Eastern calendar day, through right now.
"Previous day" is anchored to TODAY's calendar date minus one — a
FIXED point that doesn't itself drift as the current time passes 5 PM
today; it only advances once the calendar date actually rolls over
into tomorrow. This means the window keeps growing all day (checked at
9 AM, it's "since 5 PM yesterday"; checked at 11 PM the same day, it's
STILL "since 5 PM yesterday," now a ~30-hour window) rather than
resetting at some other point — the intent, per the request, is that
an after-hours voicemail from last evening stays visible on the
dashboard all the way through the current day, not just until midnight.

No explicit upper bound is returned — end is simply "right now," same
convention as every other place in this app where an omitted upper
bound already means "up to the current moment" (see voicemailRoutes.js
itself, which never applies an end-date filter at all when endDate
isn't given).

Same self-calibrating server-clock-offset technique as
getEasternRangeBoundsForServerClock above — not duplicated logic by
coincidence, deliberately mirrors it so this stays consistent with
every other date-boundary calculation in this app if the server's own
clock/timezone setup ever changes.
==================================================
*/
async function getVoicemailDashboardWindowForServerClock() {
  const nowNY = DateTime.now().setZone("America/New_York");
  const startNY = nowNY.minus({ days: 1 }).set({ hour: 17, minute: 0, second: 0, millisecond: 0 });

  const [rows] = await db.execute(
    `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offset_seconds`
  );
  const offsetSeconds = rows[0].offset_seconds;

  const start = startNY.toUTC().plus({ seconds: offsetSeconds }).toFormat("yyyy-MM-dd HH:mm:ss");
  const end = nowNY.toUTC().plus({ seconds: offsetSeconds }).toFormat("yyyy-MM-dd HH:mm:ss");

  return { start, end };
}

/*
==================================================
computeDirectionStats — the ONE shared calculation
==================================================
Used by getTodayStats, getTodayStatsAggregate, AND getReportingSummary
— previously three separate, INCONSISTENT implementations existed,
which is exactly why DialerPage's AHT (1:59) and the Live Status
Dashboard's AHT (1:43) disagreed for the same underlying data. Retired
the old "AVG(call_started_at to call_ended_at)" definition entirely —
that measured the whole call span (queue wait + ring + talk + hold,
but NOT ACW, since that happens after hangup) — in favor of this one,
confirmed-correct definition: Average Call/Hold/ACW Time, each summed
PER CALL FIRST (so a call held/unheld multiple times counts as one
call's worth of hold time, not several partial segments), then divided
by Total Calls — not by "however many calls happened to have that
specific segment type," which silently excludes zero-hold/zero-ACW
calls from the denominator and inflates the average.

appUserId/agentUser are optional — pass both to scope to one specific
agent (getTodayStats), or omit both for every agent (getTodayStatsAggregate,
getReportingSummary).
==================================================
*/
async function computeDirectionStats({ direction, campaignId, appUserId, agentUser, start, end }) {
  const table = direction === "inbound" ? "inbound_call_log" : "dialer_call_log";

  const countParams = [start, end];
  let countFilter = "";
  if (campaignId) {
    countFilter += " AND campaign_id = ?";
    countParams.push(campaignId);
  }
  if (agentUser) {
    countFilter += " AND agent_user = ?";
    countParams.push(agentUser);
  }
  const [[countRow]] = await db.execute(
    `SELECT COUNT(*) AS n FROM cmx_dialer.${table} WHERE call_started_at BETWEEN ? AND ? ${countFilter}`,
    countParams
  );
  const totalCalls = countRow.n;

  const segParams = [direction, start, end];
  let segFilter = "";
  if (campaignId) {
    segFilter += " AND related_campaign_id = ?";
    segParams.push(campaignId);
  }
  if (appUserId) {
    segFilter += " AND app_user_id = ?";
    segParams.push(appUserId);
  }
  const [segRows] = await db.execute(
    `
      SELECT related_call_id, status, SUM(duration_seconds) AS seg_seconds
      FROM cmx_dialer.agent_status_log
      WHERE related_call_direction = ?
        AND status IN ('IN_CALL', 'ON_HOLD', 'AFTER_CALL_WORK')
        AND ended_at IS NOT NULL
        AND related_call_id IS NOT NULL
        AND started_at BETWEEN ? AND ?
        ${segFilter}
      GROUP BY related_call_id, status
    `,
    segParams
  );

  const perCall = new Map();
  for (const r of segRows) {
    // REAL BUG FIXED HERE: mysql2 returns SUM() results as STRINGS (to
    // avoid precision loss on large aggregates) — accumulating with
    // "+=" against a raw driver value did STRING CONCATENATION instead
    // of addition (e.g. two calls' totals "83"/"84" became the literal
    // text "0083084", not the sum 167). Coercing explicitly the moment
    // this value is first read, so every downstream +/reduce is
    // guaranteed real arithmetic.
    const segSeconds = Number(r.seg_seconds) || 0;
    const entry = perCall.get(r.related_call_id) || { call: 0, hold: 0, acw: 0 };
    if (r.status === "IN_CALL") entry.call += segSeconds;
    else if (r.status === "ON_HOLD") entry.hold += segSeconds;
    else if (r.status === "AFTER_CALL_WORK") entry.acw += segSeconds;
    perCall.set(r.related_call_id, entry);
  }

  const calls = Array.from(perCall.values());
  const totalCallSeconds = calls.reduce((s, c) => s + c.call, 0);
  const totalHoldSeconds = calls.reduce((s, c) => s + c.hold, 0);
  const totalAcwSeconds = calls.reduce((s, c) => s + c.acw, 0);

  const avgCallSeconds = totalCalls > 0 ? totalCallSeconds / totalCalls : null;
  const avgHoldSeconds = totalCalls > 0 ? totalHoldSeconds / totalCalls : null;
  const avgAcwSeconds = totalCalls > 0 ? totalAcwSeconds / totalCalls : null;
  const ahtSeconds =
    avgCallSeconds !== null || avgHoldSeconds !== null || avgAcwSeconds !== null
      ? (avgCallSeconds || 0) + (avgHoldSeconds || 0) + (avgAcwSeconds || 0)
      : null;

  return {
    totalCalls,
    totalCallSeconds,
    totalHoldSeconds,
    totalAcwSeconds,
    avgCallSeconds,
    avgHoldSeconds,
    avgAcwSeconds,
    ahtSeconds,
  };
}

/*
==================================================
computeDirectionStatsGrouped — Phase 8 addition
==================================================
Same underlying definitions as computeDirectionStats (per-call
segment sums, then averaged over Total Calls — NOT over however many
calls happened to have that segment type), but grouped by
campaign+agent in ONE pass instead of one query per agent — needed for
the Reports page's campaign-level-down-to-agent-level breakdown
without an N+1 query per agent.

Returns raw grouped rows; getCampaignAgentBreakdown below is
responsible for resolving agent_user (vicidial username, always
present on the call-log tables) against app_users to attach a
app_user_id/full_name, and for merging inbound+outbound together.
==================================================
*/
async function computeDirectionStatsGrouped({ direction, campaignId, campaignIds, start, end }) {
  const table = direction === "inbound" ? "inbound_call_log" : "dialer_call_log";

  // campaignIds (array) takes priority over the older singular
  // campaignId — added to support "All (My Campaigns)" for scoped
  // roles on the Reports page (an IN-list of their real assignments,
  // never the full system-wide list) alongside the pre-existing
  // "exactly one campaign" and "no filter at all" cases. See
  // accessControlService.js's resolveCampaignScope for where this
  // array actually comes from.
  const countParams = [start, end];
  let countFilter = "";
  if (campaignIds && campaignIds.length > 0) {
    countFilter += ` AND campaign_id IN (${campaignIds.map(() => "?").join(",")})`;
    countParams.push(...campaignIds);
  } else if (campaignId) {
    countFilter += " AND campaign_id = ?";
    countParams.push(campaignId);
  }
  const [countRows] = await db.execute(
    `
      SELECT campaign_id, agent_user, COUNT(*) AS n
      FROM cmx_dialer.${table}
      WHERE call_started_at BETWEEN ? AND ? ${countFilter}
      GROUP BY campaign_id, agent_user
    `,
    countParams
  );

  const segParams = [direction, start, end];
  let segFilter = "";
  if (campaignIds && campaignIds.length > 0) {
    segFilter += ` AND related_campaign_id IN (${campaignIds.map(() => "?").join(",")})`;
    segParams.push(...campaignIds);
  } else if (campaignId) {
    segFilter += " AND related_campaign_id = ?";
    segParams.push(campaignId);
  }
  const [segRows] = await db.execute(
    `
      SELECT related_campaign_id, app_user_id, related_call_id, status, SUM(duration_seconds) AS seg_seconds
      FROM cmx_dialer.agent_status_log
      WHERE related_call_direction = ?
        AND status IN ('IN_CALL', 'ON_HOLD', 'AFTER_CALL_WORK')
        AND ended_at IS NOT NULL
        AND related_call_id IS NOT NULL
        AND started_at BETWEEN ? AND ?
        ${segFilter}
      GROUP BY related_call_id, related_campaign_id, app_user_id, status
    `,
    segParams
  );

  // Per-call totals first (same reasoning as computeDirectionStats: a
  // call held/unheld multiple times must count as ONE call's worth of
  // hold time), tagged with which campaign+agent that call belongs to.
  const perCall = new Map();
  for (const r of segRows) {
    const segSeconds = Number(r.seg_seconds) || 0; // mysql2 SUM() string-coercion, same fix as above
    const entry =
      perCall.get(r.related_call_id) ||
      { campaignId: r.related_campaign_id, appUserId: r.app_user_id, call: 0, hold: 0, acw: 0 };
    if (r.status === "IN_CALL") entry.call += segSeconds;
    else if (r.status === "ON_HOLD") entry.hold += segSeconds;
    else if (r.status === "AFTER_CALL_WORK") entry.acw += segSeconds;
    perCall.set(r.related_call_id, entry);
  }

  // Now aggregate per-call totals up to campaign+agent buckets.
  const byAgent = new Map(); // key: `${campaignId}||${appUserId}`
  for (const entry of perCall.values()) {
    const key = `${entry.campaignId}||${entry.appUserId}`;
    const agg =
      byAgent.get(key) ||
      { campaignId: entry.campaignId, appUserId: entry.appUserId, callSeconds: 0, holdSeconds: 0, acwSeconds: 0 };
    agg.callSeconds += entry.call;
    agg.holdSeconds += entry.hold;
    agg.acwSeconds += entry.acw;
    byAgent.set(key, agg);
  }

  return { countRows, byAgent };
}

/*
==================================================
getCampaignAgentBreakdown — Reports page (Phase 8)
==================================================
Campaign-level-down-to-agent-level breakdown of the SAME call/agent
metrics computeDirectionStats already defines, over an arbitrary
[startDate, endDate] range instead of always "today", optionally
scoped to one campaign.

Grouping key is the agent's VICIDIAL USERNAME (agent_user), not
app_user_id — dialer_call_log/inbound_call_log only ever store the
username (never app_user_id), so that's the one identifier guaranteed
present on every call row. app_user_id (needed to attribute
agent_status_log's hold/ACW segments) is resolved from app_users by
that username; a call row whose agent_user has no matching app_users
row (e.g. a deleted/renamed account) still gets its own bucket keyed
by username, rather than silently merging with another such row under
a shared "null" key.
==================================================
*/
async function getCampaignAgentBreakdown({ startDate, endDate, campaignId, campaignIds }) {
  const { start, end } = await getEasternRangeBoundsForServerClock(startDate, endDate);

  const [inbound, outbound, [agentRows], [campaignRows]] = await Promise.all([
    computeDirectionStatsGrouped({ direction: "inbound", campaignId, campaignIds, start, end }),
    computeDirectionStatsGrouped({ direction: "outbound", campaignId, campaignIds, start, end }),
    db.execute(`SELECT app_user_id, vicidial_user, full_name FROM cmx_dialer.app_users WHERE vicidial_user IS NOT NULL`),
    db.execute(`SELECT campaign_id, campaign_name FROM vicidial_campaigns`),
  ]);

  const agentByUsername = new Map(agentRows.map((a) => [a.vicidial_user, a]));
  const agentByAppUserId = new Map(agentRows.map((a) => [a.app_user_id, a]));
  const campaignNameById = new Map(campaignRows.map((c) => [c.campaign_id, c.campaign_name]));

  // key: `${campaignId}||${vicidialUser}` — see comment above for why
  // vicidialUser (not app_user_id) is the grouping identity.
  const merged = new Map();

  function bucketFor(campId, vicidialUser, appUserId) {
    const key = `${campId}||${vicidialUser}`;
    let entry = merged.get(key);
    if (!entry) {
      entry = {
        campaignId: campId,
        vicidialUser,
        appUserId: appUserId ?? null,
        fullName: (appUserId != null && agentByAppUserId.get(appUserId)?.full_name) || vicidialUser,
        inbound: { totalCalls: 0, callSeconds: 0, holdSeconds: 0, acwSeconds: 0 },
        outbound: { totalCalls: 0, callSeconds: 0, holdSeconds: 0, acwSeconds: 0 },
      };
      merged.set(key, entry);
    } else if (entry.appUserId == null && appUserId != null) {
      entry.appUserId = appUserId;
      entry.fullName = agentByAppUserId.get(appUserId)?.full_name || entry.fullName;
    }
    return entry;
  }

  function applyCounts(rows, direction) {
    for (const row of rows) {
      const agentInfo = agentByUsername.get(row.agent_user);
      const entry = bucketFor(row.campaign_id, row.agent_user, agentInfo?.app_user_id);
      entry[direction].totalCalls += row.n;
    }
  }
  applyCounts(inbound.countRows, "inbound");
  applyCounts(outbound.countRows, "outbound");

  function applySegments(byAgent, direction) {
    for (const agg of byAgent.values()) {
      const agentInfo = agentByAppUserId.get(agg.appUserId);
      // Segments with no resolvable app_user_id (deleted account) or
      // no attributable campaign can't be placed in any bucket keyed
      // by username+campaign — skip rather than guess. This only
      // affects the hold/ACW seconds for that edge case; the call
      // COUNT itself (from applyCounts above, keyed by the guaranteed
      // agent_user string) is never affected.
      if (!agentInfo) continue;
      const entry = bucketFor(agg.campaignId, agentInfo.vicidial_user, agentInfo.app_user_id);
      entry[direction].callSeconds += agg.callSeconds;
      entry[direction].holdSeconds += agg.holdSeconds;
      entry[direction].acwSeconds += agg.acwSeconds;
    }
  }
  applySegments(inbound.byAgent, "inbound");
  applySegments(outbound.byAgent, "outbound");

  // Same average/AHT formula as computeDirectionStats: sum/Total Calls
  // for that direction, not sum/count-of-segments.
  function directionSummary(d) {
    const avgCallSeconds = d.totalCalls > 0 ? d.callSeconds / d.totalCalls : null;
    const avgHoldSeconds = d.totalCalls > 0 ? d.holdSeconds / d.totalCalls : null;
    const avgAcwSeconds = d.totalCalls > 0 ? d.acwSeconds / d.totalCalls : null;
    const ahtSeconds = d.totalCalls > 0 ? (avgCallSeconds || 0) + (avgHoldSeconds || 0) + (avgAcwSeconds || 0) : null;
    return { totalCalls: d.totalCalls, avgCallSeconds, avgHoldSeconds, avgAcwSeconds, ahtSeconds };
  }

  function agentRow(entry) {
    const ib = directionSummary(entry.inbound);
    const ob = directionSummary(entry.outbound);
    return {
      appUserId: entry.appUserId,
      fullName: entry.fullName,
      vicidialUser: entry.vicidialUser,
      totalCalls: ib.totalCalls + ob.totalCalls,
      totalInbound: ib.totalCalls,
      totalOutbound: ob.totalCalls,
      ahtInboundSeconds: ib.ahtSeconds !== null ? Math.round(ib.ahtSeconds) : null,
      ahtOutboundSeconds: ob.ahtSeconds !== null ? Math.round(ob.ahtSeconds) : null,
      avgIbHoldSeconds: ib.avgHoldSeconds !== null ? Math.round(ib.avgHoldSeconds) : null,
      avgObHoldSeconds: ob.avgHoldSeconds !== null ? Math.round(ob.avgHoldSeconds) : null,
      avgIbAcwSeconds: ib.avgAcwSeconds !== null ? Math.round(ib.avgAcwSeconds) : null,
      avgObAcwSeconds: ob.avgAcwSeconds !== null ? Math.round(ob.avgAcwSeconds) : null,
    };
  }

  // Roll agent rows up into campaigns, and roll campaigns up into a
  // grand total — by adding raw seconds/counts at each level BEFORE
  // dividing (never averaging averages), so a campaign's AHT is the
  // true campaign-wide figure, not the mean of its agents' individual
  // AHTs.
  const campaignBuckets = new Map(); // campaignId -> { inbound, outbound, agents: [] }
  for (const entry of merged.values()) {
    const campId = entry.campaignId;
    let bucket = campaignBuckets.get(campId);
    if (!bucket) {
      bucket = {
        campaignId: campId,
        campaignName: campId != null ? campaignNameById.get(campId) || campId : "Unassigned",
        inbound: { totalCalls: 0, callSeconds: 0, holdSeconds: 0, acwSeconds: 0 },
        outbound: { totalCalls: 0, callSeconds: 0, holdSeconds: 0, acwSeconds: 0 },
        agentEntries: [],
      };
      campaignBuckets.set(campId, bucket);
    }
    for (const dir of ["inbound", "outbound"]) {
      bucket[dir].totalCalls += entry[dir].totalCalls;
      bucket[dir].callSeconds += entry[dir].callSeconds;
      bucket[dir].holdSeconds += entry[dir].holdSeconds;
      bucket[dir].acwSeconds += entry[dir].acwSeconds;
    }
    bucket.agentEntries.push(entry);
  }

  const grandTotal = {
    inbound: { totalCalls: 0, callSeconds: 0, holdSeconds: 0, acwSeconds: 0 },
    outbound: { totalCalls: 0, callSeconds: 0, holdSeconds: 0, acwSeconds: 0 },
  };

  const campaigns = Array.from(campaignBuckets.values())
    .map((bucket) => {
      for (const dir of ["inbound", "outbound"]) {
        grandTotal[dir].totalCalls += bucket[dir].totalCalls;
        grandTotal[dir].callSeconds += bucket[dir].callSeconds;
        grandTotal[dir].holdSeconds += bucket[dir].holdSeconds;
        grandTotal[dir].acwSeconds += bucket[dir].acwSeconds;
      }
      return {
        campaignId: bucket.campaignId,
        campaignName: bucket.campaignName,
        totals: agentRow({
          appUserId: null,
          fullName: null,
          vicidialUser: null,
          inbound: bucket.inbound,
          outbound: bucket.outbound,
        }),
        agents: bucket.agentEntries
          .map(agentRow)
          .sort((a, b) => b.totalCalls - a.totalCalls || (a.fullName || "").localeCompare(b.fullName || "")),
      };
    })
    .sort((a, b) => (a.campaignName || "").localeCompare(b.campaignName || ""));

  const grandTotals = agentRow({
    appUserId: null,
    fullName: null,
    vicidialUser: null,
    inbound: grandTotal.inbound,
    outbound: grandTotal.outbound,
  });

  return { startDate, endDate, campaigns, grandTotals };
}

/*
==================================================
LEADS CALLING DASHBOARD — NEW, per explicit request
==================================================
Powers a new dashboard, scoped to OUTBOUND campaigns that actually
have leads uploaded (see getLeadsCampaignsWithLeads below, and
leadRoutes.js for how leads get uploaded in the first place — this is
a read-only companion to that feature, not a new upload path).

Metrics, exactly as specified:
  - Contact Rate  = Total Dialed / Total Leads
  - Connect Rate  = Total Calls Answered By A Human / Total Dialed
  - Remaining Leads = leads never yet attempted
  - Per-agent aggregated table

DEFINITIONS — flagged explicitly since these are business-rule
ASSUMPTIONS, not something the request spelled out at the disposition
level. Adjust NON_HUMAN_DISPOSITIONS below if the business defines
"a human answered" differently (e.g. treating WRONG_NUMBER as a
non-contact):
  - "Total Leads" / "Remaining Leads" are LIVE INVENTORY snapshots
    (as of right now), not bounded by the dashboard's date filter —
    a lead uploaded last month and never called is still "remaining"
    today regardless of what date range is selected. This matches how
    dialer_call_log's getNextLead() logic already treats
    vicidial_list.status itself as the one source of truth for
    "still eligible to dial", not a date-scoped concept.
  - "Total Dialed" = one row in cmx_dialer.dialer_call_log per dial
    attempt in the selected date range — exactly the same definition
    computeDirectionStats already uses for outbound totalCalls, so
    this dashboard's numbers agree with Reports/Live Dashboard rather
    than inventing a second, inconsistent count (the exact class of
    bug already found and fixed once for AHT — see
    computeDirectionStats's own header comment).
  - "Answered by a human" = every dialer_call_log row in range whose
    disposition is NOT one of the auto/manually-confirmed non-human
    outcomes below. Everything else (CALL_ENDED, CX_HUNG_UP,
    NOT_INTERESTED, DO_NOT_CALL, CALLBACK, SCREENING_COMPLETED,
    NOT_ELIGIBLE, XFER_CONF, WRONG_NUMBER, ...) implies a live person
    was reached at some point during the call.
==================================================
*/
const NON_HUMAN_DISPOSITIONS = ["MACHINE", "BUSY", "NO_ANSWER", "VOICEMAIL"];

function pct(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/*
getLeadsCampaignsWithLeads(scopeCampaignIds) — powers the dashboard's
campaign picker. Only OUTBOUND campaigns (cmx_dialer.campaign_settings
.campaign_type = 'OUTBOUND' — same flag campaignRoutes.js's own
?type=OUTBOUND filter uses) that have at least one lead actually
uploaded (an INNER JOIN down to a non-empty vicidial_list, not just an
existing-but-empty vicidial_lists row from a past upload). Optionally
restricted to scopeCampaignIds (the caller's own real assignments, for
every role except admin/wfm — enforced by the ROUTE, not here; this
function trusts whatever list it's given).
*/
async function getLeadsCampaignsWithLeads(scopeCampaignIds) {
  const params = [];
  let scopeFilter = "";
  if (scopeCampaignIds && scopeCampaignIds.length > 0) {
    scopeFilter = ` AND c.campaign_id IN (${scopeCampaignIds.map(() => "?").join(",")})`;
    params.push(...scopeCampaignIds);
  }

  const [rows] = await db.execute(
    `
      SELECT
        c.campaign_id AS campaignId,
        c.campaign_name AS campaignName,
        COUNT(vl.lead_id) AS totalLeads,
        SUM(CASE WHEN vl.status = 'NEW' THEN 1 ELSE 0 END) AS remainingLeads
      FROM vicidial_campaigns c
      JOIN cmx_dialer.campaign_settings s ON s.campaign_id = c.campaign_id AND s.campaign_type = 'OUTBOUND'
      JOIN vicidial_lists vlt ON vlt.campaign_id = c.campaign_id
      JOIN vicidial_list vl ON vl.list_id = vlt.list_id
      WHERE c.active = 'Y' ${scopeFilter}
      GROUP BY c.campaign_id, c.campaign_name
      HAVING COUNT(vl.lead_id) > 0
      ORDER BY c.campaign_name ASC
    `,
    params
  );

  return rows.map((r) => ({
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    totalLeads: Number(r.totalLeads) || 0,
    remainingLeads: Number(r.remainingLeads) || 0,
  }));
}

/*
getLeadsCallingDashboard({ startDate, endDate, campaignIds }) —
campaignIds is REQUIRED and must be non-empty (the route resolves
"select all outbound campaigns" down to a real list before calling
this, via accessControlService.resolveCampaignScopeMulti — this
function never treats "no campaignIds" as "everything", to avoid
silently including campaigns without leads, or campaigns outside a
scoped role's assignments, if this were ever called incorrectly).

Returns per-campaign rows (for the cards/charts), a grand-total row,
and a single per-agent aggregated table across every selected campaign
combined — exactly the three pieces asked for, in one round trip.
*/
async function getLeadsCallingDashboard({ startDate, endDate, campaignIds }) {
  if (!campaignIds || campaignIds.length === 0) {
    return {
      startDate,
      endDate,
      campaigns: [],
      grandTotals: { totalLeads: 0, remainingLeads: 0, totalDialed: 0, humanAnswered: 0, contactRatePct: null, connectRatePct: null, dispositionBreakdown: [] },
      agents: [],
    };
  }

  const { start, end } = await getEasternRangeBoundsForServerClock(startDate, endDate);
  const campaignInClause = campaignIds.map(() => "?").join(",");

  // Lead inventory — NOT date-bounded, see header comment above.
  const [leadRows] = await db.execute(
    `
      SELECT
        vlt.campaign_id AS campaignId,
        COUNT(vl.lead_id) AS totalLeads,
        SUM(CASE WHEN vl.status = 'NEW' THEN 1 ELSE 0 END) AS remainingLeads
      FROM vicidial_lists vlt
      JOIN vicidial_list vl ON vl.list_id = vlt.list_id
      WHERE vlt.campaign_id IN (${campaignInClause})
      GROUP BY vlt.campaign_id
    `,
    campaignIds
  );

  // Dial attempts + human-answered, grouped by campaign+agent, in range.
  const nonHumanPlaceholders = NON_HUMAN_DISPOSITIONS.map(() => "?").join(",");
  const [dialRows] = await db.execute(
    `
      SELECT
        campaign_id AS campaignId,
        agent_user AS agentUser,
        COUNT(*) AS totalDialed,
        SUM(CASE WHEN disposition NOT IN (${nonHumanPlaceholders}) THEN 1 ELSE 0 END) AS humanAnswered
      FROM cmx_dialer.dialer_call_log
      WHERE call_started_at BETWEEN ? AND ? AND campaign_id IN (${campaignInClause})
      GROUP BY campaign_id, agent_user
    `,
    [...NON_HUMAN_DISPOSITIONS, start, end, ...campaignIds]
  );

  // Disposition breakdown — NEW, per explicit request ("% per
  // disposition"). Grouped by campaign+disposition in one pass so both
  // the per-campaign and grand-total breakdowns below come from the
  // exact same counts as totalDialed above (no separate, potentially
  // disagreeing query) — same "sum raw counts once, derive every view
  // from that" principle as the rest of this function.
  const [dispositionRows] = await db.execute(
    `
      SELECT campaign_id AS campaignId, disposition, COUNT(*) AS n
      FROM cmx_dialer.dialer_call_log
      WHERE call_started_at BETWEEN ? AND ? AND campaign_id IN (${campaignInClause})
      GROUP BY campaign_id, disposition
    `,
    [start, end, ...campaignIds]
  );

  const [campaignNameRows] = await db.execute(
    `SELECT campaign_id, campaign_name FROM vicidial_campaigns WHERE campaign_id IN (${campaignInClause})`,
    campaignIds
  );
  const [agentRows] = await db.execute(
    `SELECT app_user_id, vicidial_user, full_name FROM cmx_dialer.app_users WHERE vicidial_user IS NOT NULL`
  );

  const campaignNameById = new Map(campaignNameRows.map((c) => [c.campaign_id, c.campaign_name]));
  const agentByUsername = new Map(agentRows.map((a) => [a.vicidial_user, a]));

  // dispositionCountsByCampaign: campaignId -> { disposition -> count }
  // dispositionCountsOverall: disposition -> count (summed across every
  // selected campaign, for the grand-total breakdown).
  const dispositionCountsByCampaign = new Map();
  const dispositionCountsOverall = new Map();
  for (const row of dispositionRows) {
    const n = Number(row.n) || 0;
    const perCampaign = dispositionCountsByCampaign.get(row.campaignId) || new Map();
    perCampaign.set(row.disposition, (perCampaign.get(row.disposition) || 0) + n);
    dispositionCountsByCampaign.set(row.campaignId, perCampaign);
    dispositionCountsOverall.set(row.disposition, (dispositionCountsOverall.get(row.disposition) || 0) + n);
  }

  function breakdownFromCounts(countsMap, totalDialedForBreakdown) {
    return Array.from(countsMap.entries())
      .map(([disposition, count]) => ({
        disposition,
        count,
        pct: pct(count, totalDialedForBreakdown),
      }))
      .sort((a, b) => b.count - a.count);
  }


  // --- Per-campaign rows ---
  const leadsByCampaign = new Map(
    leadRows.map((r) => [
      r.campaignId,
      { totalLeads: Number(r.totalLeads) || 0, remainingLeads: Number(r.remainingLeads) || 0 },
    ])
  );

  const dialTotalsByCampaign = new Map(); // campaignId -> { totalDialed, humanAnswered }
  for (const row of dialRows) {
    const entry = dialTotalsByCampaign.get(row.campaignId) || { totalDialed: 0, humanAnswered: 0 };
    entry.totalDialed += row.totalDialed;
    entry.humanAnswered += Number(row.humanAnswered) || 0; // mysql2 SUM() string-coercion, same fix as computeDirectionStats
    dialTotalsByCampaign.set(row.campaignId, entry);
  }

  const campaigns = campaignIds
    .map((campaignId) => {
      const leads = leadsByCampaign.get(campaignId) || { totalLeads: 0, remainingLeads: 0 };
      const dial = dialTotalsByCampaign.get(campaignId) || { totalDialed: 0, humanAnswered: 0 };
      return {
        campaignId,
        campaignName: campaignNameById.get(campaignId) || campaignId,
        totalLeads: leads.totalLeads,
        remainingLeads: leads.remainingLeads,
        totalDialed: dial.totalDialed,
        humanAnswered: dial.humanAnswered,
        contactRatePct: pct(dial.totalDialed, leads.totalLeads),
        connectRatePct: pct(dial.humanAnswered, dial.totalDialed),
        // % per disposition, per explicit request — each disposition's
        // share of THIS campaign's own totalDialed in range.
        dispositionBreakdown: breakdownFromCounts(
          dispositionCountsByCampaign.get(campaignId) || new Map(),
          dial.totalDialed
        ),
      };
    })
    .sort((a, b) => a.campaignName.localeCompare(b.campaignName));

  // --- Grand totals — sum raw counts first, THEN divide (never
  // averaging per-campaign percentages), same principle
  // getCampaignAgentBreakdown already applies for AHT. ---
  const grandTotals = campaigns.reduce(
    (acc, c) => {
      acc.totalLeads += c.totalLeads;
      acc.remainingLeads += c.remainingLeads;
      acc.totalDialed += c.totalDialed;
      acc.humanAnswered += c.humanAnswered;
      return acc;
    },
    { totalLeads: 0, remainingLeads: 0, totalDialed: 0, humanAnswered: 0 }
  );
  grandTotals.contactRatePct = pct(grandTotals.totalDialed, grandTotals.totalLeads);
  grandTotals.connectRatePct = pct(grandTotals.humanAnswered, grandTotals.totalDialed);
  // % per disposition, per explicit request — each disposition's
  // share of Total Dialed across EVERY selected campaign combined.
  grandTotals.dispositionBreakdown = breakdownFromCounts(dispositionCountsOverall, grandTotals.totalDialed);

  // --- Per-agent table — aggregated ACROSS every selected campaign,
  // one row per agent (per explicit request: "a table showing
  // aggregated values per agent", not broken back out per campaign). ---
  const byAgent = new Map(); // vicidialUser -> { totalDialed, humanAnswered }
  for (const row of dialRows) {
    const entry = byAgent.get(row.agentUser) || { totalDialed: 0, humanAnswered: 0 };
    entry.totalDialed += row.totalDialed;
    entry.humanAnswered += Number(row.humanAnswered) || 0;
    byAgent.set(row.agentUser, entry);
  }

  const agents = Array.from(byAgent.entries())
    .map(([vicidialUser, totals]) => {
      const agentInfo = agentByUsername.get(vicidialUser);
      return {
        vicidialUser,
        appUserId: agentInfo?.app_user_id ?? null,
        fullName: agentInfo?.full_name || vicidialUser,
        totalDialed: totals.totalDialed,
        humanAnswered: totals.humanAnswered,
        connectRatePct: pct(totals.humanAnswered, totals.totalDialed),
      };
    })
    .sort((a, b) => b.totalDialed - a.totalDialed || a.fullName.localeCompare(b.fullName));

  return { startDate, endDate, campaigns, grandTotals, agents };
}

/*
==================================================
getTodayStats
==================================================
Scoped to one specific agent + campaign. Now just a thin wrapper
around computeDirectionStats — see that function's comment for why
this replaced the old, inconsistent-with-the-dashboard formula.
==================================================
*/
async function getTodayStats(appUserId, agentUser, campaignId) {
  const { start, end } = await getEasternDayBoundsForServerClock();

  const [inbound, outbound] = await Promise.all([
    computeDirectionStats({ direction: "inbound", campaignId, appUserId, agentUser, start, end }),
    computeDirectionStats({ direction: "outbound", campaignId, appUserId, agentUser, start, end }),
  ]);

  return {
    totalCalls: inbound.totalCalls + outbound.totalCalls,
    totalInbound: inbound.totalCalls,
    totalOutbound: outbound.totalCalls,
    ahtInboundSeconds: inbound.ahtSeconds !== null ? Math.round(inbound.ahtSeconds) : null,
    ahtOutboundSeconds: outbound.ahtSeconds !== null ? Math.round(outbound.ahtSeconds) : null,
    avgIbAcwSeconds: inbound.avgAcwSeconds !== null ? Math.round(inbound.avgAcwSeconds) : null,
    avgObAcwSeconds: outbound.avgAcwSeconds !== null ? Math.round(outbound.avgAcwSeconds) : null,
    avgIbHoldSeconds: inbound.avgHoldSeconds !== null ? Math.round(inbound.avgHoldSeconds) : null,
    avgObHoldSeconds: outbound.avgHoldSeconds !== null ? Math.round(outbound.avgHoldSeconds) : null,
  };
}

/*
==================================================
getTodayStatsAggregate
==================================================
Same as getTodayStats, but across EVERY agent — no appUserId/agentUser
filter passed to computeDirectionStats at all. campaignId is optional
("All Campaigns" = no filter, not "no campaign has any calls").
==================================================
*/
async function getTodayStatsAggregate(campaignId) {
  const { start, end } = await getEasternDayBoundsForServerClock();

  const [inbound, outbound] = await Promise.all([
    computeDirectionStats({ direction: "inbound", campaignId, start, end }),
    computeDirectionStats({ direction: "outbound", campaignId, start, end }),
  ]);

  return {
    totalCalls: inbound.totalCalls + outbound.totalCalls,
    totalInbound: inbound.totalCalls,
    totalOutbound: outbound.totalCalls,
    ahtInboundSeconds: inbound.ahtSeconds !== null ? Math.round(inbound.ahtSeconds) : null,
    ahtOutboundSeconds: outbound.ahtSeconds !== null ? Math.round(outbound.ahtSeconds) : null,
    avgIbAcwSeconds: inbound.avgAcwSeconds !== null ? Math.round(inbound.avgAcwSeconds) : null,
    avgObAcwSeconds: outbound.avgAcwSeconds !== null ? Math.round(outbound.avgAcwSeconds) : null,
    avgIbHoldSeconds: inbound.avgHoldSeconds !== null ? Math.round(inbound.avgHoldSeconds) : null,
    avgObHoldSeconds: outbound.avgHoldSeconds !== null ? Math.round(outbound.avgHoldSeconds) : null,
  };
}

/*
==================================================
getReportingSummary
==================================================
Powers the Inbound/Outbound KPI summary cards on the Live Status
Dashboard. Now reuses the SAME computeDirectionStats helper as
getTodayStats(Aggregate) above — guaranteeing Average Call/Hold/ACW
Time and AHT can never drift out of sync with what DialerPage shows
for the same data ever again, since there's only one implementation.

Occupancy and Service Level are INBOUND-only concepts (standard
call-center queue metrics) — outbound's section is deliberately
simpler, matching what was actually asked for.

Service Level = calls answered within 20s ÷ (Total Calls + Total
Abandoned), using the REAL, persisted inbound_call_log.wait_seconds
column (computed once, at the moment the agent connects — see
inboundCallService.js's ConfbridgeJoin handler) rather than a
re-derived join. Average Wait Time uses the same column.

Ready/Not Ready are NOT direction-specific (an agent is just generally
available or not — there's no "available for inbound only" concept in
this system), so both KPI sections show the SAME Ready/Not-Ready
numbers, scoped by campaign ASSIGNMENT (agent_campaign_assignments) —
matching how live-status's own campaign filter already works for
statuses with no call to tag — rather than by call direction, which
doesn't apply to them at all.
==================================================
*/
async function getReportingSummary(campaignId) {
  const { start, end } = await getEasternDayBoundsForServerClock();

  async function readyNotReadyStats() {
    const params = [start, end];
    let assignmentFilter = "";
    if (campaignId) {
      assignmentFilter = `
        AND app_user_id IN (
          SELECT app_user_id FROM cmx_dialer.agent_campaign_assignments
          WHERE campaign_id = ? AND active = 1
        )
      `;
      params.push(campaignId);
    }

    const [rows] = await db.execute(
      `
        SELECT status, SUM(duration_seconds) AS total_seconds, COUNT(*) AS n
        FROM cmx_dialer.agent_status_log
        WHERE status IN ('READY', 'NOT_READY')
          AND ended_at IS NOT NULL
          AND started_at BETWEEN ? AND ?
          ${assignmentFilter}
        GROUP BY status
      `,
      params
    );

    const byStatus = {};
    for (const r of rows) byStatus[r.status] = r;

    // Same coercion fix as computeDirectionStats — SUM() comes back as
    // a string from mysql2.
    const readyTotal = Number(byStatus.READY?.total_seconds) || 0;
    const readyN = byStatus.READY?.n || 0;
    const notReadyTotal = Number(byStatus.NOT_READY?.total_seconds) || 0;
    const notReadyN = byStatus.NOT_READY?.n || 0;

    return {
      avgReadySeconds: readyN ? readyTotal / readyN : null,
      avgNotReadySeconds: notReadyN ? notReadyTotal / notReadyN : null,
      totalReadySeconds: readyTotal,
    };
  }

  async function totalAbandonedCount() {
    const params = [start, end];
    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = "AND campaign_id = ?";
      params.push(campaignId);
    }
    const [[row]] = await db.execute(
      `SELECT COUNT(*) AS n FROM cmx_dialer.abandoned_call_log WHERE call_started_at BETWEEN ? AND ? ${campaignFilter}`,
      params
    );
    return row.n;
  }

  /*
  ==================================================
  waitTimeStats
  ==================================================
  Reads directly from inbound_call_log.wait_seconds — a real,
  persisted value computed once at the exact moment the agent
  connects (see inboundCallService.js's ConfbridgeJoin handler), not
  re-derived from a MIN(started_at) join every time this report runs.
  Powers both "Average Wait Time" and Service Level's answered-
  within-20s count.
  ==================================================
  */
  async function waitTimeStats() {
    const params = [start, end];
    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = "AND campaign_id = ?";
      params.push(campaignId);
    }

    const [rows] = await db.execute(
      `
        SELECT wait_seconds
        FROM cmx_dialer.inbound_call_log
        WHERE call_started_at BETWEEN ? AND ?
          AND wait_seconds IS NOT NULL
          ${campaignFilter}
      `,
      params
    );

    const waitSeconds = rows.map((r) => Number(r.wait_seconds) || 0);
    const answeredWithin20s = waitSeconds.filter((s) => s < 20).length;
    const avgWaitSeconds = waitSeconds.length
      ? waitSeconds.reduce((s, v) => s + v, 0) / waitSeconds.length
      : null;

    return { answeredWithin20s, avgWaitSeconds };
  }

  const [inbound, outbound, readyNotReady, totalAbandoned, waitStats] = await Promise.all([
    computeDirectionStats({ direction: "inbound", campaignId, start, end }),
    computeDirectionStats({ direction: "outbound", campaignId, start, end }),
    readyNotReadyStats(),
    totalAbandonedCount(),
    waitTimeStats(),
  ]);

  const occupancyNumerator = inbound.totalCallSeconds + inbound.totalHoldSeconds + inbound.totalAcwSeconds;
  const occupancyDenominator = occupancyNumerator + readyNotReady.totalReadySeconds;
  const occupancyPct = occupancyDenominator > 0 ? (occupancyNumerator / occupancyDenominator) * 100 : null;

  // Service Level = calls answered within 20s ÷ (Total Calls + Total
  // Abandoned) — exactly as specified.
  const serviceLevelDenominator = inbound.totalCalls + totalAbandoned;
  const serviceLevelPct =
    serviceLevelDenominator > 0 ? (waitStats.answeredWithin20s / serviceLevelDenominator) * 100 : null;

  return {
    inbound: {
      totalCalls: inbound.totalCalls,
      totalAbandoned,
      avgCallSeconds: inbound.avgCallSeconds,
      avgHoldSeconds: inbound.avgHoldSeconds,
      avgAcwSeconds: inbound.avgAcwSeconds,
      ahtSeconds: inbound.ahtSeconds,
      avgWaitSeconds: waitStats.avgWaitSeconds,
      avgReadySeconds: readyNotReady.avgReadySeconds,
      avgNotReadySeconds: readyNotReady.avgNotReadySeconds,
      occupancyPct,
      serviceLevelPct,
    },
    outbound: {
      totalCalls: outbound.totalCalls,
      avgCallSeconds: outbound.avgCallSeconds,
      avgHoldSeconds: outbound.avgHoldSeconds,
      avgAcwSeconds: outbound.avgAcwSeconds,
    },
  };
}

module.exports = {
  getTodayStats,
  getTodayStatsAggregate,
  getEasternDayBoundsForServerClock,
  getEasternRangeBoundsForServerClock,
  getVoicemailDashboardWindowForServerClock,
  getReportingSummary,
  getCampaignAgentBreakdown,
  getLeadsCampaignsWithLeads,
  getLeadsCallingDashboard,
};