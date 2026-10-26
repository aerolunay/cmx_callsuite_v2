import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import HorizontalBarChart from "../components/HorizontalBarChart";
import ConnectTrendsSection from "../components/ConnectTrendsSection";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import LoadingSpinner from "../components/LoadingSpinner";

// Same role matrix as the Reports page — see adminRoutes.js's own
// LEADS_DASHBOARD_ROLES comment for why this dashboard follows
// Reports' access split rather than inventing a new one.
const LEADS_DASHBOARD_ROLES = ["supervisor", "account_manager", "wfm", "admin"];

// Same technique as ReportsPage.jsx's own todayNY() — Intl's en-CA
// locale formats as yyyy-MM-dd, so no need to pull luxon (a backend-
// only dependency) into the frontend bundle just for this one calc.
function todayNY() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
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

// Human-readable labels for the raw disposition codes stored on
// dialer_call_log (see dialerService.js's own DISPOSITION_TO_VICIDIAL_STATUS
// map for the full authoritative list of codes this app ever writes).
const DISPOSITION_LABELS = {
  CALL_ENDED: "Call Ended",
  CX_HUNG_UP: "Customer Hung Up",
  NO_ANSWER: "No Answer",
  VOICEMAIL: "Voicemail / Answering Machine",
  MACHINE: "Answering Machine (auto-detected)",
  BUSY: "Busy (auto-detected)",
  WRONG_NUMBER: "Wrong Number",
  NOT_INTERESTED: "Not Interested",
  DO_NOT_CALL: "Do Not Call",
  CALLBACK: "Callback",
  SCREENING_COMPLETED: "Screening Completed",
  NOT_ELIGIBLE: "Not Eligible",
  XFER_CONF: "Transferred / Conference",
};

function dispositionLabel(code) {
  return DISPOSITION_LABELS[code] || code;
}

// Per explicit request — two views. Near Real Time is always today (no date
// pickers) and refreshes itself every 20s; Historical has the date range and
// only reloads when the filters change. The chosen view is remembered per
// browser (a convenience only — falls back to Near Real Time).
const VIEW_STORAGE_KEY = "leadsDashboardView";
const REALTIME_REFRESH_MS = 20000;

function readSavedView() {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "historical" ? "historical" : "realtime";
  } catch {
    return "realtime";
  }
}

export default function LeadsCallingDashboardPage() {
  const { agent } = useAuth();

  const [campaigns, setCampaigns] = useState([]); // OUTBOUND campaigns with leads
  const [selectedCampaignIds, setSelectedCampaignIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef(null);

  const [view, setView] = useState(readSavedView); // "realtime" | "historical"
  const isRealtime = view === "realtime";

  // Historical view's own range; Near Real Time always uses today.
  const [startDate, setStartDate] = useState(todayNY());
  const [endDate, setEndDate] = useState(todayNY());

  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  // Only the newest request may update the page — a slow response from a
  // previous view/filter must never overwrite a newer one.
  const requestIdRef = useRef(0);

  const hasAccess = LEADS_DASHBOARD_ROLES.includes(agent?.accessLevel);

  // Campaign picker — load once, default to "select all outbound
  // campaigns" per explicit request. Re-selecting all on every reload
  // (rather than trying to remember a prior choice) keeps this simple
  // and matches what a fresh page load should show.
  useEffect(() => {
    if (!hasAccess) return;
    api
      .getLeadsDashboardCampaigns()
      .then((data) => {
        const list = data.campaigns || [];
        setCampaigns(list);
        setSelectedCampaignIds(list.map((c) => c.campaignId));
      })
      .catch((err) => setError(err.message));
  }, [hasAccess]);

  // Close the campaign picker panel on an outside click.
  useEffect(() => {
    function handleClickOutside(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // silent = a background Near Real Time refresh: keep the current numbers
  // on screen (no spinner), just swap them when the new ones arrive.
  function load({ silent = false } = {}) {
    const from = isRealtime ? todayNY() : startDate;
    const to = isRealtime ? todayNY() : endDate;
    if (!from || !to) return;
    const requestId = ++requestIdRef.current;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    api
      .getLeadsDashboardSummary(from, to, selectedCampaignIds)
      .then((data) => {
        if (requestId !== requestIdRef.current) return;
        setDashboard(data.dashboard);
        setLastUpdatedAt(new Date());
        setError("");
      })
      .catch((err) => {
        if (requestId === requestIdRef.current) setError(err.message);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load-on-mount-and-filter-change is this component's whole data-fetch pattern, same as every other list/table in this app.
    if (hasAccess && campaigns.length > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, campaigns, selectedCampaignIds, view, startDate, endDate]);

  // Near Real Time — refresh every 20s with the selected campaigns. Skipped
  // while the tab is hidden (nobody's looking); refreshes right away when
  // it's shown again.
  useEffect(() => {
    if (!isRealtime || !hasAccess || campaigns.length === 0) return;
    const interval = setInterval(() => {
      if (!document.hidden) load({ silent: true });
    }, REALTIME_REFRESH_MS);
    function onVisible() {
      if (!document.hidden) load({ silent: true });
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRealtime, hasAccess, campaigns, selectedCampaignIds]);

  function changeView(next) {
    if (next === view) return;
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // storage unavailable — the view just isn't remembered
    }
  }

  if (agent && !hasAccess) {
    return <Navigate to="/" replace />;
  }

  function toggleCampaign(campaignId) {
    setSelectedCampaignIds((prev) =>
      prev.includes(campaignId) ? prev.filter((id) => id !== campaignId) : [...prev, campaignId]
    );
  }

  function selectAll() {
    setSelectedCampaignIds(campaigns.map((c) => c.campaignId));
  }

  function selectNone() {
    setSelectedCampaignIds([]);
  }

  const allSelected = campaigns.length > 0 && selectedCampaignIds.length === campaigns.length;

  const pickerLabel =
    campaigns.length === 0
      ? "No outbound campaigns with leads"
      : allSelected
        ? `All Outbound Campaigns (${campaigns.length})`
        : selectedCampaignIds.length === 0
          ? "No campaigns selected"
          : `${selectedCampaignIds.length} of ${campaigns.length} campaigns`;

  const g = dashboard?.grandTotals;

  return (
    <>
      <Header />
      <div className="page-content page-content-wide">
        <h2>Leads Calling Dashboard</h2>

        <div className="view-toggle" role="tablist" aria-label="Dashboard view">
          <button
            type="button"
            role="tab"
            aria-selected={isRealtime}
            className={`view-toggle-option${isRealtime ? " view-toggle-option-active" : ""}`}
            onClick={() => changeView("realtime")}
          >
            Near Real Time
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isRealtime}
            className={`view-toggle-option${!isRealtime ? " view-toggle-option-active" : ""}`}
            onClick={() => changeView("historical")}
          >
            Historical
          </button>
        </div>

        <div className="leads-dashboard-filter-row">
          {isRealtime ? (
            <div>
              <label className="comments-label">Showing</label>
              <div className="leads-dashboard-realtime-note">
                Today ({todayNY()}) · refreshes every 20s
                {lastUpdatedAt && <> · updated {lastUpdatedAt.toLocaleTimeString()}</>}
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="comments-label">Start Date</label>
                <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div>
                <label className="comments-label">End Date</label>
                <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </>
          )}

          <div className="leads-dashboard-campaign-picker" ref={pickerRef}>
            <label className="comments-label">Campaigns</label>
            <button
              type="button"
              className="leads-dashboard-campaign-picker-toggle"
              onClick={() => setPickerOpen((v) => !v)}
            >
              {pickerLabel} {pickerOpen ? "▾" : "▸"}
            </button>

            {pickerOpen && (
              <div className="leads-dashboard-campaign-picker-panel">
                <label>
                  <input type="checkbox" checked={allSelected} onChange={() => (allSelected ? selectNone() : selectAll())} />
                  <strong>Select All Outbound Campaigns</strong>
                </label>
                <hr />
                {campaigns.length === 0 && <p style={{ color: "#888", margin: "4px 2px" }}>No outbound campaigns have leads uploaded yet.</p>}
                {campaigns.map((c) => (
                  <label key={c.campaignId}>
                    <input
                      type="checkbox"
                      checked={selectedCampaignIds.includes(c.campaignId)}
                      onChange={() => toggleCampaign(c.campaignId)}
                    />
                    {c.campaignName} ({c.campaignId})
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {loading && <LoadingSpinner label="Loading leads dashboard…" />}

        {!loading && dashboard && (
          <>
            {/* ===== KPI cards ===== */}
            <div className="card stats-panel" style={{ marginBottom: 20 }}>
              <div className="stats-grid stats-grid-4">
                <div
                  className="stats-cell"
                  title={`Unique numbers dialed that rang (${fmtCount(g?.contactedNumbers)}) ÷ unique numbers in the day's leads (${fmtCount(g?.totalNumbers)}). Someone answering is Connect Rate.`}
                >
                  <div className="stats-cell-label">Contact Rate</div>
                  <div className="stats-cell-value">{fmtPct(g?.contactRatePct)}</div>
                </div>
                <div className="stats-cell">
                  <div className="stats-cell-label">Connect Rate</div>
                  <div className="stats-cell-value">{fmtPct(g?.connectRatePct)}</div>
                </div>
                <div className="stats-cell" title="Never dialed yet and still callable.">
                  <div className="stats-cell-label">Remaining New Leads</div>
                  <div className="stats-cell-value">{fmtCount(g?.remainingNewLeads)}</div>
                </div>
                <div className="stats-cell" title="Not reached yet (No Answer, Answering Machine, Busy) and still due another attempt.">
                  <div className="stats-cell-label">Remaining for Redial</div>
                  <div className="stats-cell-value">{fmtCount(g?.remainingRedialLeads)}</div>
                </div>
                <div className="stats-cell" title="Leads whose number was closed out on an inbound call in this date range — removed from Remaining and Total.">
                  <div className="stats-cell-label">Resolved via Inbound</div>
                  <div className="stats-cell-value">{fmtCount(g?.resolvedViaInbound)}</div>
                </div>
                <div className="stats-cell" title="New leads + leads to be redialed at the start of the day, including those already dialed.">
                  <div className="stats-cell-label">Total Leads</div>
                  <div className="stats-cell-value">{fmtCount(g?.totalLeads)}</div>
                </div>
                <div className="stats-cell">
                  <div className="stats-cell-label">Total Dialed</div>
                  <div className="stats-cell-value">{fmtCount(g?.totalDialed)}</div>
                </div>
                <div className="stats-cell">
                  <div className="stats-cell-label">Human Answered</div>
                  <div className="stats-cell-value">{fmtCount(g?.humanAnswered)}</div>
                </div>
                <div className="stats-cell" title="Calls in this date range to a number that had already been called before.">
                  <div className="stats-cell-label">Total Redials</div>
                  <div className="stats-cell-value">{fmtCount(g?.totalRedials)}</div>
                </div>
                <div className="stats-cell" title="Total Redials divided by the number of different numbers that were redialed.">
                  <div className="stats-cell-label">Avg Redial Attempts per Number</div>
                  <div className="stats-cell-value">{fmtAverage(g?.avgRedialsPerNumber)}</div>
                </div>
              </div>
            </div>

            {/* ===== Charts ===== */}
            <div className="leads-dashboard-charts-grid">
              <div className="card">
                <h3>Contact Rate by Campaign</h3>
                <HorizontalBarChart
                  max={100}
                  color="var(--cmx-cyan)"
                  bars={(dashboard.campaigns || []).map((c) => ({
                    label: c.campaignName,
                    value: c.contactRatePct ?? 0,
                    displayValue: fmtPct(c.contactRatePct),
                  }))}
                />
              </div>

              <div className="card">
                <h3>Connect Rate by Campaign</h3>
                <HorizontalBarChart
                  max={100}
                  color="var(--cmx-navy)"
                  bars={(dashboard.campaigns || []).map((c) => ({
                    label: c.campaignName,
                    value: c.connectRatePct ?? 0,
                    displayValue: fmtPct(c.connectRatePct),
                  }))}
                />
              </div>

              <div className="card" style={{ gridColumn: "1 / -1" }}>
                <h3>Disposition Breakdown — % of Total Dialed</h3>
                <HorizontalBarChart
                  max={100}
                  color="var(--cmx-cyan-dark)"
                  bars={(g?.dispositionBreakdown || []).map((d) => ({
                    label: dispositionLabel(d.disposition),
                    value: d.pct ?? 0,
                    displayValue: `${fmtCount(d.count)} (${fmtPct(d.pct)})`,
                  }))}
                />
              </div>
            </div>

            {/* ===== Per-campaign table ===== */}
            <div className="card call-log-card" style={{ marginBottom: 20 }}>
              <h3>By Campaign</h3>
              {dashboard.campaigns.length === 0 ? (
                <p>No campaigns selected.</p>
              ) : (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Total Leads</th>
                      <th>Remaining New</th>
                      <th>Remaining Redial</th>
                      <th>Resolved via Inbound</th>
                      <th>Total Dialed</th>
                      <th>Total Redials</th>
                      <th>Avg Redials / Number</th>
                      <th>Human Answered</th>
                      <th>Contact Rate</th>
                      <th>Connect Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.campaigns.map((c) => (
                      <tr key={c.campaignId}>
                        <td>{c.campaignName}</td>
                        <td>{fmtCount(c.totalLeads)}</td>
                        <td>{fmtCount(c.remainingNewLeads)}</td>
                        <td>{fmtCount(c.remainingRedialLeads)}</td>
                        <td>{fmtCount(c.resolvedViaInbound)}</td>
                        <td>{fmtCount(c.totalDialed)}</td>
                        <td>{fmtCount(c.totalRedials)}</td>
                        <td>{fmtAverage(c.avgRedialsPerNumber)}</td>
                        <td>{fmtCount(c.humanAnswered)}</td>
                        <td>{fmtPct(c.contactRatePct)}</td>
                        <td>{fmtPct(c.connectRatePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ===== Per-agent table ===== */}
            <div className="card call-log-card">
              <h3>By Agent — {startDate} to {endDate}</h3>
              {dashboard.agents.length === 0 ? (
                <p>No dial activity in this range.</p>
              ) : (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Total Dialed</th>
                      <th>Human Answered</th>
                      <th>Connect Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.agents.map((a) => (
                      <tr key={a.vicidialUser}>
                        <td>{a.fullName}</td>
                        <td>{fmtCount(a.totalDialed)}</td>
                        <td>{fmtCount(a.humanAnswered)}</td>
                        <td>{fmtPct(a.connectRatePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {/* ===== Connect Trends — by day of week / day / hour. Historical
             only: Near Real Time is a single day, which can't show a
             day-of-week pattern. ===== */}
        {campaigns.length > 0 &&
          (isRealtime ? (
            <p className="connect-trends-note" style={{ marginTop: 20 }}>
              Switch to Historical and pick a date range to see Connect Trends: answer rates by day of week, weekday vs
              weekend, and hour of day.
            </p>
          ) : (
            <ConnectTrendsSection startDate={startDate} endDate={endDate} campaignIds={selectedCampaignIds} />
          ))}
      </div>
    </>
  );
}
