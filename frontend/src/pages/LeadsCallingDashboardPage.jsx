import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import HorizontalBarChart from "../components/HorizontalBarChart";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";

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

export default function LeadsCallingDashboardPage() {
  const { agent } = useAuth();

  const [campaigns, setCampaigns] = useState([]); // OUTBOUND campaigns with leads
  const [selectedCampaignIds, setSelectedCampaignIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef(null);

  const [startDate, setStartDate] = useState(todayNY());
  const [endDate, setEndDate] = useState(todayNY());

  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  function load() {
    if (!startDate || !endDate) return;
    setLoading(true);
    setError("");
    api
      .getLeadsDashboardSummary(startDate, endDate, selectedCampaignIds)
      .then((data) => setDashboard(data.dashboard))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (hasAccess && campaigns.length > 0) load();
  }, [hasAccess, campaigns, selectedCampaignIds, startDate, endDate]);

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

        <div className="leads-dashboard-filter-row">
          <div>
            <label className="comments-label">Start Date</label>
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="comments-label">End Date</label>
            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>

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
        {loading && <p>Loading…</p>}

        {!loading && dashboard && (
          <>
            {/* ===== KPI cards ===== */}
            <div className="card stats-panel" style={{ marginBottom: 20 }}>
              <div className="stats-grid stats-grid-4">
                <div className="stats-cell">
                  <div className="stats-cell-label">Contact Rate</div>
                  <div className="stats-cell-value">{fmtPct(g?.contactRatePct)}</div>
                </div>
                <div className="stats-cell">
                  <div className="stats-cell-label">Connect Rate</div>
                  <div className="stats-cell-value">{fmtPct(g?.connectRatePct)}</div>
                </div>
                <div className="stats-cell">
                  <div className="stats-cell-label">Remaining Leads</div>
                  <div className="stats-cell-value">{fmtCount(g?.remainingLeads)}</div>
                </div>
                <div className="stats-cell">
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
                      <th>Remaining</th>
                      <th>Total Dialed</th>
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
                        <td>{fmtCount(c.remainingLeads)}</td>
                        <td>{fmtCount(c.totalDialed)}</td>
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
      </div>
    </>
  );
}
