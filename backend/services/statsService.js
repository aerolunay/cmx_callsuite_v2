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

module.exports = {
  getTodayStats,
  getTodayStatsAggregate,
  getEasternDayBoundsForServerClock,
};