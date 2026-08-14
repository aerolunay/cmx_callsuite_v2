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
  const nowNY = DateTime.now().setZone("America/New_York");
  const startOfDayUtc = nowNY.startOf("day").toUTC();
  const endOfDayUtc = nowNY.endOf("day").toUTC();

  const [rows] = await db.execute(
    `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offset_seconds`
  );
  const offsetSeconds = rows[0].offset_seconds;

  const start = startOfDayUtc.plus({ seconds: offsetSeconds }).toFormat("yyyy-MM-dd HH:mm:ss");
  const end = endOfDayUtc.plus({ seconds: offsetSeconds }).toFormat("yyyy-MM-dd HH:mm:ss");

  return { start, end };
}

/*
==================================================
getTodayStats
==================================================
Now scoped to a specific campaign, not just "today, this agent" —
every query (counts, AHT, ACW, Hold) filters by campaignId. This
required tagging agent_status_log with related_campaign_id (mirroring
how related_call_direction already worked) — without that, ACW/Hold
would have stayed agent-wide even after counts/AHT became
campaign-scoped, a silent inconsistency worth closing rather than
leaving.
==================================================
*/
async function getTodayStats(appUserId, agentUser, campaignId) {
  const { start, end } = await getEasternDayBoundsForServerClock();

  const [outboundRows] = await db.execute(
    `
      SELECT
        COUNT(*) AS total_outbound,
        AVG(TIMESTAMPDIFF(SECOND, call_started_at, call_ended_at)) AS aht_outbound_seconds
      FROM cmx_dialer.dialer_call_log
      WHERE agent_user = ?
        AND campaign_id = ?
        AND call_started_at BETWEEN ? AND ?
        AND call_ended_at IS NOT NULL
    `,
    [agentUser, campaignId, start, end]
  );

  const [inboundRows] = await db.execute(
    `
      SELECT
        COUNT(*) AS total_inbound,
        AVG(TIMESTAMPDIFF(SECOND, call_started_at, call_ended_at)) AS aht_inbound_seconds
      FROM cmx_dialer.inbound_call_log
      WHERE agent_user = ?
        AND campaign_id = ?
        AND call_started_at BETWEEN ? AND ?
        AND call_ended_at IS NOT NULL
    `,
    [agentUser, campaignId, start, end]
  );

  const [acwRows] = await db.execute(
    `
      SELECT
        AVG(CASE WHEN related_call_direction = 'outbound' THEN duration_seconds END) AS avg_ob_acw_seconds,
        AVG(CASE WHEN related_call_direction = 'inbound' THEN duration_seconds END) AS avg_ib_acw_seconds
      FROM cmx_dialer.agent_status_log
      WHERE app_user_id = ?
        AND status = 'AFTER_CALL_WORK'
        AND related_campaign_id = ?
        AND ended_at IS NOT NULL
        AND started_at BETWEEN ? AND ?
    `,
    [appUserId, campaignId, start, end]
  );

  const [holdRows] = await db.execute(
    `
      SELECT
        AVG(CASE WHEN related_call_direction = 'outbound' THEN duration_seconds END) AS avg_ob_hold_seconds,
        AVG(CASE WHEN related_call_direction = 'inbound' THEN duration_seconds END) AS avg_ib_hold_seconds
      FROM cmx_dialer.agent_status_log
      WHERE app_user_id = ?
        AND status = 'ON_HOLD'
        AND related_campaign_id = ?
        AND ended_at IS NOT NULL
        AND started_at BETWEEN ? AND ?
    `,
    [appUserId, campaignId, start, end]
  );

  const totalOutbound = outboundRows[0].total_outbound || 0;
  const totalInbound = inboundRows[0].total_inbound || 0;
  const ahtOutboundSeconds = outboundRows[0].aht_outbound_seconds;
  const ahtInboundSeconds = inboundRows[0].aht_inbound_seconds;
  const avgObAcwSeconds = acwRows[0].avg_ob_acw_seconds;
  const avgIbAcwSeconds = acwRows[0].avg_ib_acw_seconds;
  const avgObHoldSeconds = holdRows[0].avg_ob_hold_seconds;
  const avgIbHoldSeconds = holdRows[0].avg_ib_hold_seconds;

  return {
    totalCalls: totalOutbound + totalInbound,
    totalInbound,
    totalOutbound,
    ahtInboundSeconds: ahtInboundSeconds !== null ? Math.round(ahtInboundSeconds) : null,
    ahtOutboundSeconds: ahtOutboundSeconds !== null ? Math.round(ahtOutboundSeconds) : null,
    avgIbAcwSeconds: avgIbAcwSeconds !== null ? Math.round(avgIbAcwSeconds) : null,
    avgObAcwSeconds: avgObAcwSeconds !== null ? Math.round(avgObAcwSeconds) : null,
    avgIbHoldSeconds: avgIbHoldSeconds !== null ? Math.round(avgIbHoldSeconds) : null,
    avgObHoldSeconds: avgObHoldSeconds !== null ? Math.round(avgObHoldSeconds) : null,
  };
}

/*
==================================================
getTodayStatsAggregate
==================================================
Same shape as getTodayStats, but across EVERY agent — no agent_user/
app_user_id filter at all. campaignId is optional here ("All
Campaigns" = no filter, not "no campaign has any calls"). Filters
directly by each row's own campaign_id/related_campaign_id (the call's
own tag), NOT by agent_campaign_assignments — correct here because
this aggregates CALLS, not agent state, so the call's own campaign tag
is the right, simpler filter (unlike live-status, which needed the
assignment-based approach since NOT_READY/READY/AUX_CB have no call to
tag at all).
==================================================
*/
async function getTodayStatsAggregate(campaignId) {
  const { start, end } = await getEasternDayBoundsForServerClock();

  const [outboundRows] = await db.execute(
    `
      SELECT
        COUNT(*) AS total_outbound,
        AVG(TIMESTAMPDIFF(SECOND, call_started_at, call_ended_at)) AS aht_outbound_seconds
      FROM cmx_dialer.dialer_call_log
      WHERE (? IS NULL OR campaign_id = ?)
        AND call_started_at BETWEEN ? AND ?
        AND call_ended_at IS NOT NULL
    `,
    [campaignId || null, campaignId || null, start, end]
  );

  const [inboundRows] = await db.execute(
    `
      SELECT
        COUNT(*) AS total_inbound,
        AVG(TIMESTAMPDIFF(SECOND, call_started_at, call_ended_at)) AS aht_inbound_seconds
      FROM cmx_dialer.inbound_call_log
      WHERE (? IS NULL OR campaign_id = ?)
        AND call_started_at BETWEEN ? AND ?
        AND call_ended_at IS NOT NULL
    `,
    [campaignId || null, campaignId || null, start, end]
  );

  const [acwRows] = await db.execute(
    `
      SELECT
        AVG(CASE WHEN related_call_direction = 'outbound' THEN duration_seconds END) AS avg_ob_acw_seconds,
        AVG(CASE WHEN related_call_direction = 'inbound' THEN duration_seconds END) AS avg_ib_acw_seconds
      FROM cmx_dialer.agent_status_log
      WHERE status = 'AFTER_CALL_WORK'
        AND (? IS NULL OR related_campaign_id = ?)
        AND ended_at IS NOT NULL
        AND started_at BETWEEN ? AND ?
    `,
    [campaignId || null, campaignId || null, start, end]
  );

  const [holdRows] = await db.execute(
    `
      SELECT
        AVG(CASE WHEN related_call_direction = 'outbound' THEN duration_seconds END) AS avg_ob_hold_seconds,
        AVG(CASE WHEN related_call_direction = 'inbound' THEN duration_seconds END) AS avg_ib_hold_seconds
      FROM cmx_dialer.agent_status_log
      WHERE status = 'ON_HOLD'
        AND (? IS NULL OR related_campaign_id = ?)
        AND ended_at IS NOT NULL
        AND started_at BETWEEN ? AND ?
    `,
    [campaignId || null, campaignId || null, start, end]
  );

  const totalOutbound = outboundRows[0].total_outbound || 0;
  const totalInbound = inboundRows[0].total_inbound || 0;
  const ahtOutboundSeconds = outboundRows[0].aht_outbound_seconds;
  const ahtInboundSeconds = inboundRows[0].aht_inbound_seconds;
  const avgObAcwSeconds = acwRows[0].avg_ob_acw_seconds;
  const avgIbAcwSeconds = acwRows[0].avg_ib_acw_seconds;
  const avgObHoldSeconds = holdRows[0].avg_ob_hold_seconds;
  const avgIbHoldSeconds = holdRows[0].avg_ib_hold_seconds;

  return {
    totalCalls: totalOutbound + totalInbound,
    totalInbound,
    totalOutbound,
    ahtInboundSeconds: ahtInboundSeconds !== null ? Math.round(ahtInboundSeconds) : null,
    ahtOutboundSeconds: ahtOutboundSeconds !== null ? Math.round(ahtOutboundSeconds) : null,
    avgIbAcwSeconds: avgIbAcwSeconds !== null ? Math.round(avgIbAcwSeconds) : null,
    avgObAcwSeconds: avgObAcwSeconds !== null ? Math.round(avgObAcwSeconds) : null,
    avgIbHoldSeconds: avgIbHoldSeconds !== null ? Math.round(avgIbHoldSeconds) : null,
    avgObHoldSeconds: avgObHoldSeconds !== null ? Math.round(avgObHoldSeconds) : null,
  };
}

/*
==================================================
getReportingSummary
==================================================
Powers the new Inbound/Outbound KPI summary cards on the Live Status
Dashboard. Deliberately a SEPARATE function from getTodayStats(Aggregate)
above rather than reusing their avg ACW/Hold fields — those average the
raw per-SEGMENT duration directly (fine for their purpose), whereas
every average here first SUMS all segments per call (so a call
held/unheld multiple times counts as ONE call's worth of hold time, not
several partial segments) before dividing — matching the same
"aggregate the duration, don't reset" principle already applied to the
live per-agent Duration column and Total Calls' Handle Time.

Average Call/Hold/ACW Time all share ONE denominator — Total Calls for
that direction — not "however many calls happened to have that
specific segment type." Real bug once fixed here: dividing by a
per-metric count (e.g. hold time ÷ only the calls that were actually
held) silently excludes every zero-hold call from the denominator,
inflating the average. A call with no hold time still needs to count
as a real 0 pulling the average down for these numbers to mean
anything as genuine per-call averages.

Occupancy and Service Level are INBOUND-only concepts (standard
call-center queue metrics) — outbound's section is deliberately
simpler, matching what was actually asked for.

Service Level's "answered within 20 seconds" wait time is measured
from inbound_call_log.call_started_at to the FIRST IN_CALL segment
tagged with that call's ID — this only works for calls that have a
related_call_id at all (i.e. everything after tonight's migration);
older calls are silently excluded from this one specific metric, same
known, accepted gap as everywhere else related_call_id was introduced.

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

  async function perCallDirectionTotals(direction) {
    const params = [direction, start, end];
    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = "AND related_campaign_id = ?";
      params.push(campaignId);
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
          ${campaignFilter}
        GROUP BY related_call_id, status
      `,
      params
    );

    const perCall = new Map();
    for (const r of segRows) {
      const entry = perCall.get(r.related_call_id) || { call: 0, hold: 0, acw: 0 };
      if (r.status === "IN_CALL") entry.call += r.seg_seconds;
      else if (r.status === "ON_HOLD") entry.hold += r.seg_seconds;
      else if (r.status === "AFTER_CALL_WORK") entry.acw += r.seg_seconds;
      perCall.set(r.related_call_id, entry);
    }

    const calls = Array.from(perCall.values());
    const total = (key) => calls.reduce((s, c) => s + c[key], 0);

    // Deliberately NOT averaging here anymore — see the caller
    // (getReportingSummary) for why. Returns raw totals only.
    return {
      totalCallSeconds: total("call"),
      totalHoldSeconds: total("hold"),
      totalAcwSeconds: total("acw"),
    };
  }

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

    const readyTotal = byStatus.READY?.total_seconds || 0;
    const readyN = byStatus.READY?.n || 0;
    const notReadyTotal = byStatus.NOT_READY?.total_seconds || 0;
    const notReadyN = byStatus.NOT_READY?.n || 0;

    return {
      avgReadySeconds: readyN ? readyTotal / readyN : null,
      avgNotReadySeconds: notReadyN ? notReadyTotal / notReadyN : null,
      totalReadySeconds: readyTotal,
    };
  }

  async function callCounts() {
    const inboundParams = [start, end];
    const abandonedParams = [start, end];
    const outboundParams = [start, end];
    let inboundCampaignFilter = "";
    let abandonedCampaignFilter = "";
    let outboundCampaignFilter = "";
    if (campaignId) {
      inboundCampaignFilter = "AND campaign_id = ?";
      inboundParams.push(campaignId);
      abandonedCampaignFilter = "AND campaign_id = ?";
      abandonedParams.push(campaignId);
      outboundCampaignFilter = "AND campaign_id = ?";
      outboundParams.push(campaignId);
    }

    const [[inboundRow]] = await db.execute(
      `SELECT COUNT(*) AS n FROM cmx_dialer.inbound_call_log WHERE call_started_at BETWEEN ? AND ? ${inboundCampaignFilter}`,
      inboundParams
    );
    const [[abandonedRow]] = await db.execute(
      `SELECT COUNT(*) AS n FROM cmx_dialer.abandoned_call_log WHERE call_started_at BETWEEN ? AND ? ${abandonedCampaignFilter}`,
      abandonedParams
    );
    const [[outboundRow]] = await db.execute(
      `SELECT COUNT(*) AS n FROM cmx_dialer.dialer_call_log WHERE call_started_at BETWEEN ? AND ? ${outboundCampaignFilter}`,
      outboundParams
    );

    return { totalInbound: inboundRow.n, totalAbandoned: abandonedRow.n, totalOutbound: outboundRow.n };
  }

  async function answeredWithin20Seconds() {
    const params = [start, end];
    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = "AND icl.campaign_id = ?";
      params.push(campaignId);
    }

    const [rows] = await db.execute(
      `
        SELECT icl.call_id, TIMESTAMPDIFF(SECOND, icl.call_started_at, MIN(asl.started_at)) AS wait_seconds
        FROM cmx_dialer.inbound_call_log icl
        JOIN cmx_dialer.agent_status_log asl
          ON asl.related_call_id = icl.call_id AND asl.status = 'IN_CALL'
        WHERE icl.call_started_at BETWEEN ? AND ?
          ${campaignFilter}
        GROUP BY icl.call_id
      `,
      params
    );

    return rows.filter((r) => r.wait_seconds !== null && r.wait_seconds < 20).length;
  }

  const [inboundSeg, outboundSeg, readyNotReady, counts, answeredFast] = await Promise.all([
    perCallDirectionTotals("inbound"),
    perCallDirectionTotals("outbound"),
    readyNotReadyStats(),
    callCounts(),
    answeredWithin20Seconds(),
  ]);

  // TEMPORARY DEBUG — remove once the Average Call Time investigation
  // is resolved. Prints the exact raw values this function is working
  // with, so we can see where a wrong number first appears instead of
  // guessing from the final displayed output.
  console.log("[getReportingSummary DEBUG]", {
    campaignId,
    start,
    end,
    inboundSeg,
    outboundSeg,
    counts,
  });

  /*
  REAL BUG FIXED HERE: each average used to divide by "how many calls
  had THAT SPECIFIC segment type" (e.g. hold average ÷ only the calls
  that were actually held) — which inflates every average, since it
  silently excludes every call with zero hold/ACW time from the
  denominator instead of counting it as a real 0. Fixed per explicit
  correction: all three averages share the SAME denominator, Total
  Calls for that direction — a call with no hold time still counts
  toward pulling the average down, which is what makes these numbers
  meaningful as "per call" averages at all.
  */
  const inboundAvgCall = counts.totalInbound > 0 ? inboundSeg.totalCallSeconds / counts.totalInbound : null;
  const inboundAvgHold = counts.totalInbound > 0 ? inboundSeg.totalHoldSeconds / counts.totalInbound : null;
  const inboundAvgAcw = counts.totalInbound > 0 ? inboundSeg.totalAcwSeconds / counts.totalInbound : null;

  const outboundAvgCall = counts.totalOutbound > 0 ? outboundSeg.totalCallSeconds / counts.totalOutbound : null;
  const outboundAvgHold = counts.totalOutbound > 0 ? outboundSeg.totalHoldSeconds / counts.totalOutbound : null;
  const outboundAvgAcw = counts.totalOutbound > 0 ? outboundSeg.totalAcwSeconds / counts.totalOutbound : null;

  const inboundAht =
    inboundAvgCall !== null || inboundAvgHold !== null || inboundAvgAcw !== null
      ? (inboundAvgCall || 0) + (inboundAvgHold || 0) + (inboundAvgAcw || 0)
      : null;

  const occupancyNumerator = inboundSeg.totalCallSeconds + inboundSeg.totalHoldSeconds + inboundSeg.totalAcwSeconds;
  const occupancyDenominator = occupancyNumerator + readyNotReady.totalReadySeconds;
  const occupancyPct = occupancyDenominator > 0 ? (occupancyNumerator / occupancyDenominator) * 100 : null;

  const serviceLevelDenominator = counts.totalInbound + counts.totalAbandoned;
  const serviceLevelPct = serviceLevelDenominator > 0 ? (answeredFast / serviceLevelDenominator) * 100 : null;

  return {
    inbound: {
      totalCalls: counts.totalInbound,
      totalAbandoned: counts.totalAbandoned,
      avgCallSeconds: inboundAvgCall,
      avgHoldSeconds: inboundAvgHold,
      avgAcwSeconds: inboundAvgAcw,
      ahtSeconds: inboundAht,
      avgReadySeconds: readyNotReady.avgReadySeconds,
      avgNotReadySeconds: readyNotReady.avgNotReadySeconds,
      occupancyPct,
      serviceLevelPct,
    },
    outbound: {
      totalCalls: counts.totalOutbound,
      avgCallSeconds: outboundAvgCall,
      avgHoldSeconds: outboundAvgHold,
      avgAcwSeconds: outboundAvgAcw,
    },
  };
}

module.exports = {
  getTodayStats,
  getTodayStatsAggregate,
  getEasternDayBoundsForServerClock,
  getReportingSummary,
};