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
  getReportingSummary,
};