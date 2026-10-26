import { useEffect, useRef, useState } from "react";
import HorizontalBarChart from "./HorizontalBarChart";
import LoadingSpinner from "./LoadingSpinner";
import { api } from "../api";
import { downloadCsv } from "../utils/csv";

/*
==================================================
ConnectTrendsSection — NEW, for the Leads Calling Dashboard
==================================================
Answered vs answering machine vs no answer, per day of week, per day,
and per hour of day — so the business can see which weekdays connect
best and whether weekend calling is worth it. Same Human Answered
definition as the KPI cards above it (see statsService.getLeadsConnectTrends).

Fetches on its own whenever the range or campaign selection changes;
the backend returns plain daily + hourly rows and every rollup here
(day of week, weekday vs weekend) is a sum of those rows.
==================================================
*/

const OUTCOMES = [
  { key: "answered", label: "Human Answered", className: "connect-trends-answered" },
  { key: "machine", label: "Answering Machine / Voicemail", className: "connect-trends-machine" },
  { key: "noAnswer", label: "No Answer", className: "connect-trends-noanswer" },
  { key: "busy", label: "Busy", className: "connect-trends-busy" },
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const JS_DAY_TO_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A day of week with fewer days than this is shown faded — one unusual
// day shouldn't read as a pattern.
const MIN_DAYS_FOR_PATTERN = 3;

function weekdayOf(date) {
  // Noon UTC keeps the calendar date stable whatever the browser's timezone.
  return JS_DAY_TO_WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function isWeekend(weekday) {
  return weekday === "Sat" || weekday === "Sun";
}

function rate(part, whole) {
  return whole > 0 ? (part / whole) * 100 : null;
}

function fmtPct(value) {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function fmtCount(value) {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

function fmtAverage(value) {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

function fmtHour(hour) {
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

function fmtShortDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function emptyGroup() {
  return { days: 0, dials: 0, answered: 0, machine: 0, noAnswer: 0, busy: 0, agentDays: 0 };
}

function addDay(group, day) {
  group.days += 1;
  group.dials += day.dials;
  group.answered += day.answered;
  group.machine += day.machine;
  group.noAnswer += day.noAnswer;
  group.busy += day.busy;
  group.agentDays += day.agents;
}

function withRates(group) {
  return {
    ...group,
    answerRatePct: rate(group.answered, group.dials),
    machineRatePct: rate(group.machine, group.dials),
    answeredPerDay: group.days > 0 ? group.answered / group.days : null,
    answeredPerAgentDay: group.agentDays > 0 ? group.answered / group.agentDays : null,
  };
}

function summarize(days) {
  const byWeekday = new Map(WEEKDAYS.map((w) => [w, emptyGroup()]));
  const byPeriod = { Weekday: emptyGroup(), Weekend: emptyGroup() };
  for (const day of days) {
    const weekday = weekdayOf(day.date);
    addDay(byWeekday.get(weekday), day);
    addDay(byPeriod[isWeekend(weekday) ? "Weekend" : "Weekday"], day);
  }
  return {
    weekdays: WEEKDAYS.map((w) => ({ weekday: w, ...withRates(byWeekday.get(w)) })),
    periods: ["Weekday", "Weekend"].map((p) => ({ period: p, ...withRates(byPeriod[p]) })),
  };
}

function takeaway(weekdays, periods) {
  const solid = weekdays.filter((w) => !isWeekend(w.weekday) && w.days >= MIN_DAYS_FOR_PATTERN);
  const pool = solid.length >= 2 ? solid : weekdays.filter((w) => !isWeekend(w.weekday) && w.days > 0);
  const parts = [];
  if (pool.length >= 2) {
    const best = pool.reduce((a, b) => (b.answerRatePct > a.answerRatePct ? b : a));
    const worst = pool.reduce((a, b) => (b.answerRatePct < a.answerRatePct ? b : a));
    parts.push(
      `${WEEKDAY_NAMES[best.weekday]} connects best (${fmtPct(best.answerRatePct)} of dials answered by a person) and ${WEEKDAY_NAMES[worst.weekday]} worst (${fmtPct(worst.answerRatePct)}).`
    );
  }
  const weekend = periods.find((p) => p.period === "Weekend");
  const weekday = periods.find((p) => p.period === "Weekday");
  if (weekend.days === 0) {
    parts.push("No weekend dials in this range, so weekends can't be compared.");
  } else if (weekend.days < MIN_DAYS_FOR_PATTERN) {
    parts.push(
      `Only ${weekend.days} weekend ${weekend.days === 1 ? "day" : "days"} in this range — too few to call weekends better or worse yet.`
    );
  } else {
    parts.push(`Weekends answer ${fmtPct(weekend.answerRatePct)} of dials against ${fmtPct(weekday.answerRatePct)} on weekdays.`);
  }
  return parts.join(" ");
}

function outcomeTooltip(heading, row) {
  return [heading, ...OUTCOMES.map((o) => `${o.label}: ${fmtCount(row[o.key])} (${fmtPct(rate(row[o.key], row.dials))})`)].join("\n");
}

function OutcomeLegend() {
  return (
    <div className="connect-trends-legend">
      {OUTCOMES.map((o) => (
        <span key={o.key}>
          <i className={o.className} />
          {o.label}
        </span>
      ))}
    </div>
  );
}

export default function ConnectTrendsSection({ startDate, endDate, campaignIds }) {
  const [trends, setTrends] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);

  const campaignKey = campaignIds.join(",");

  useEffect(() => {
    if (!startDate || !endDate) return;
    const requestId = ++requestIdRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same load-on-filter-change pattern as the page around it.
    setLoading(true);
    setError("");
    api
      .getLeadsDashboardConnectTrends(startDate, endDate, campaignIds)
      .then((data) => {
        if (requestId === requestIdRef.current) setTrends(data.trends);
      })
      .catch((err) => {
        if (requestId === requestIdRef.current) setError(err.message);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, campaignKey]);

  const days = (trends?.days || []).map((d) => ({ ...d, weekday: weekdayOf(d.date), answerRatePct: rate(d.answered, d.dials) }));
  const hours = trends?.hours || [];
  const { weekdays, periods } = summarize(days);
  const total = withRates(days.reduce((group, day) => (addDay(group, day), group), emptyGroup()));
  const weekendPeriod = periods.find((p) => p.period === "Weekend");
  const maxDials = Math.max(1, ...days.map((d) => d.dials));

  function handleDownloadDaily() {
    downloadCsv(
      `cmx-dialer-connect-trends-daily_${startDate}_to_${endDate}.csv`,
      [
        { label: "Date", value: "date" },
        { label: "Day", value: "weekday" },
        { label: "Total Dialed", value: "dials" },
        { label: "Human Answered", value: "answered" },
        { label: "Answering Machine / Voicemail", value: "machine" },
        { label: "No Answer", value: "noAnswer" },
        { label: "Busy", value: "busy" },
        { label: "Answer Rate %", value: (r) => (r.answerRatePct === null ? "" : r.answerRatePct.toFixed(1)) },
        { label: "Agents Dialing", value: "agents" },
      ],
      days
    );
  }

  function handleDownloadHourly() {
    downloadCsv(
      `cmx-dialer-connect-trends-hourly_${startDate}_to_${endDate}.csv`,
      [
        { label: "Hour (ET)", value: (r) => fmtHour(r.hour) },
        { label: "Total Dialed", value: "dials" },
        { label: "Human Answered", value: "answered" },
        { label: "Answering Machine / Voicemail", value: "machine" },
        { label: "No Answer", value: "noAnswer" },
        { label: "Busy", value: "busy" },
        { label: "Answer Rate %", value: (r) => (r.dials > 0 ? ((r.answered / r.dials) * 100).toFixed(1) : "") },
      ],
      hours
    );
  }

  return (
    <section className="connect-trends">
      <div className="connect-trends-header">
        <div>
          <h3>Connect Trends — {startDate} to {endDate}</h3>
          <p className="connect-trends-note">
            Which days and hours get a person on the line. Regular outbound dials only (callbacks excluded); days and
            hours in Eastern time.
          </p>
        </div>
        <div className="connect-trends-actions">
          <button type="button" className="button-secondary" onClick={handleDownloadDaily} disabled={!trends || days.length === 0}>
            Download Daily CSV
          </button>
          <button type="button" className="button-secondary" onClick={handleDownloadHourly} disabled={!trends || hours.length === 0}>
            Download Hourly CSV
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !trends && <LoadingSpinner label="Loading connect trends…" />}

      {trends && days.length === 0 && (
        <div className="card">
          <p style={{ margin: 0 }}>No outbound dials in this range.</p>
        </div>
      )}

      {trends && days.length > 0 && (
        <div className={loading ? "connect-trends-body connect-trends-refreshing" : "connect-trends-body"}>
          <p className="connect-trends-takeaway">{takeaway(weekdays, periods)}</p>

          <div className="card stats-panel" style={{ marginBottom: 20 }}>
            <div className="stats-grid stats-grid-6">
              <div className="stats-cell">
                <div className="stats-cell-label">Dials</div>
                <div className="stats-cell-value">{fmtCount(total.dials)}</div>
              </div>
              <div className="stats-cell">
                <div className="stats-cell-label">Human Answered</div>
                <div className="stats-cell-value">{fmtCount(total.answered)}</div>
              </div>
              <div className="stats-cell">
                <div className="stats-cell-label">Answer Rate</div>
                <div className="stats-cell-value">{fmtPct(total.answerRatePct)}</div>
              </div>
              <div className="stats-cell">
                <div className="stats-cell-label">Machine / Voicemail</div>
                <div className="stats-cell-value">{fmtPct(total.machineRatePct)}</div>
              </div>
              <div className="stats-cell">
                <div className="stats-cell-label">No Answer</div>
                <div className="stats-cell-value">{fmtPct(rate(total.noAnswer, total.dials))}</div>
              </div>
              <div className="stats-cell">
                <div className="stats-cell-label">Days Dialed</div>
                <div className="stats-cell-value">{fmtCount(total.days)}</div>
              </div>
            </div>
          </div>

          <div className="leads-dashboard-charts-grid">
            <div className="card">
              <h3>Outcome Mix by Day of Week</h3>
              <p className="connect-trends-note">
                Share of dials per outcome. Faded rows have fewer than {MIN_DAYS_FOR_PATTERN} days of data.
              </p>
              <OutcomeLegend />
              <div className="connect-trends-dow">
                {weekdays.map((w) => (
                  <div
                    key={w.weekday}
                    className={`connect-trends-dow-row${w.days < MIN_DAYS_FOR_PATTERN ? " connect-trends-thin" : ""}`}
                    title={w.dials > 0 ? outcomeTooltip(`${WEEKDAY_NAMES[w.weekday]} — ${w.days} ${w.days === 1 ? "day" : "days"}`, w) : undefined}
                  >
                    <div className="connect-trends-dow-label">{w.weekday}</div>
                    <div className="connect-trends-stack">
                      {w.dials > 0 &&
                        OUTCOMES.map((o) =>
                          w[o.key] > 0 ? (
                            <div key={o.key} className={o.className} style={{ width: `${(w[o.key] / w.dials) * 100}%` }} />
                          ) : null
                        )}
                    </div>
                    <div className="connect-trends-dow-meta">
                      {w.dials > 0 ? (
                        <>
                          <strong>{fmtPct(w.answerRatePct)}</strong> answered · {fmtCount(w.dials)} dials over {w.days}{" "}
                          {w.days === 1 ? "day" : "days"}
                        </>
                      ) : (
                        "No dials"
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>Weekdays vs Weekends</h3>
              <p className="connect-trends-note">
                Answer rate shows how productive each dial is. Answered per agent-day shows how many live conversations
                one agent gets in a shift.
              </p>
              <table className="call-log-table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Days</th>
                    <th>Total Dialed</th>
                    <th>Human Answered</th>
                    <th>Answer Rate</th>
                    <th>Machine</th>
                    <th>Answered / Agent-Day</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.period}>
                      <td>{p.period}</td>
                      <td>{fmtCount(p.days)}</td>
                      <td>{fmtCount(p.dials)}</td>
                      <td>{fmtCount(p.answered)}</td>
                      <td>{fmtPct(p.answerRatePct)}</td>
                      <td>{fmtPct(p.machineRatePct)}</td>
                      <td>{fmtAverage(p.answeredPerAgentDay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {weekendPeriod.days > 0 && weekendPeriod.days < MIN_DAYS_FOR_PATTERN && (
                <p className="connect-trends-note" style={{ marginTop: 10 }}>
                  Too few weekend days to compare reliably.
                </p>
              )}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <h3>Daily Outcomes</h3>
            <p className="connect-trends-note">Dials per day, split by outcome. Weekend days are shaded. Hover a day for its numbers.</p>
            <OutcomeLegend />
            <div className="connect-trends-daily-scroll">
              <div className="connect-trends-daily" style={{ "--connect-trends-days": days.length }}>
                {days.map((d) => (
                  <div
                    key={d.date}
                    className={`connect-trends-day${isWeekend(d.weekday) ? " connect-trends-weekend" : ""}`}
                    title={outcomeTooltip(`${d.weekday} ${fmtShortDate(d.date)} — ${fmtCount(d.dials)} dials, ${fmtPct(d.answerRatePct)} answered`, d)}
                  >
                    <div className="connect-trends-day-bar" style={{ height: `${(d.dials / maxDials) * 100}%` }}>
                      {OUTCOMES.slice()
                        .reverse()
                        .map((o) =>
                          d[o.key] > 0 ? (
                            <div key={o.key} className={o.className} style={{ height: `${(d[o.key] / d.dials) * 100}%` }} />
                          ) : null
                        )}
                    </div>
                    <div className="connect-trends-day-label">
                      {d.weekday}
                      <br />
                      {fmtShortDate(d.date)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="leads-dashboard-charts-grid">
            <div className="card">
              <h3>Answer Rate by Hour of Day (ET)</h3>
              <HorizontalBarChart
                max={Math.max(1, ...hours.map((h) => rate(h.answered, h.dials) || 0))}
                color="var(--cmx-navy)"
                bars={hours.map((h) => ({
                  label: fmtHour(h.hour),
                  value: rate(h.answered, h.dials) ?? 0,
                  displayValue: `${fmtPct(rate(h.answered, h.dials))} of ${fmtCount(h.dials)}`,
                }))}
              />
            </div>

            <div className="card call-log-card">
              <h3>Day of Week Detail</h3>
              <table className="call-log-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Days</th>
                    <th>Total Dialed</th>
                    <th>Human Answered</th>
                    <th>Machine</th>
                    <th>No Answer</th>
                    <th>Busy</th>
                    <th>Answer Rate</th>
                    <th>Answered / Day</th>
                    <th>Answered / Agent-Day</th>
                  </tr>
                </thead>
                <tbody>
                  {weekdays.map((w) => (
                    <tr key={w.weekday} className={w.days < MIN_DAYS_FOR_PATTERN ? "connect-trends-thin" : undefined}>
                      <td>{WEEKDAY_NAMES[w.weekday]}</td>
                      <td>{fmtCount(w.days)}</td>
                      <td>{fmtCount(w.dials)}</td>
                      <td>{fmtCount(w.answered)}</td>
                      <td>{fmtCount(w.machine)}</td>
                      <td>{fmtCount(w.noAnswer)}</td>
                      <td>{fmtCount(w.busy)}</td>
                      <td>{fmtPct(w.answerRatePct)}</td>
                      <td>{fmtAverage(w.answeredPerDay)}</td>
                      <td>{fmtAverage(w.answeredPerAgentDay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="connect-trends-note">
            Human Answered uses the same rule as Connect Rate above: every disposition except No Answer, Busy, Answering
            Machine and Voicemail. It depends on what the agent picks, and calls closed without a disposition aren't
            counted. Callbacks are left out of this whole section, so Dials can be a little lower than Total Dialed
            above. Agent-days count each agent once per day they made any outbound call.
          </p>
        </div>
      )}
    </section>
  );
}
