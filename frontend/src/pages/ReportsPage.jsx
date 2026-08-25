import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { formatDurationHMS } from "../utils/format";
import { downloadCsv } from "../utils/csv";

// Default range: today only, in America/New_York — matches every
// other "today" boundary already used elsewhere in this app, so the
// report's default view lines up with what the Live Status Dashboard
// already shows before anyone touches the date pickers. Uses the
// browser's own Intl support (en-CA locale formats as yyyy-MM-dd)
// rather than pulling in luxon just for this — luxon is a BACKEND
// dependency only; adding it to the frontend for one date calc isn't
// worth the extra bundle weight.
function todayNY() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function fmtSeconds(seconds) {
  return seconds !== null && seconds !== undefined ? formatDurationHMS(seconds) : "—";
}

export default function ReportsPage() {
  const { agent } = useAuth();

  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState("");
  const [startDate, setStartDate] = useState(todayNY());
  const [endDate, setEndDate] = useState(todayNY());

  // Two report types, per explicit request: the existing aggregated
  // campaign->agent breakdown, and a new "Raw Data" option — one row
  // per call, inbound+outbound combined, no aggregation at all.
  const [reportType, setReportType] = useState("aggregated");
  const [report, setReport] = useState(null);
  const [rawCalls, setRawCalls] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Reports roles: supervisor, account_manager, wfm, admin — NOT
  // training_quality (Reports isn't part of that role's access per the
  // finished matrix). admin/wfm get the full unscoped campaign list;
  // supervisor/account_manager get only their own assignments.
  const REPORTS_ROLES = ["supervisor", "account_manager", "wfm", "admin"];
  const isUnrestrictedCampaignAccess = agent?.accessLevel === "admin" || agent?.accessLevel === "wfm";

  useEffect(() => {
    if (isUnrestrictedCampaignAccess) {
      api.getCampaigns().then((data) => setCampaigns(data.campaigns)).catch(() => {});
    } else if (agent) {
      api
        .getMyCampaigns()
        .then((data) => {
          const list = data.campaigns || [];
          setCampaigns(list);
          if (list.length > 0) setCampaignId((prev) => prev || list[0].campaign_id);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  function load() {
    if (!startDate || !endDate) return;
    // Scoped roles must have a real campaignId before this can run at
    // all — the backend rejects an empty one for them.
    if (!isUnrestrictedCampaignAccess && !campaignId) return;
    setLoading(true);
    setError("");

    if (reportType === "raw") {
      api
        .getRawCallsReport(startDate, endDate, campaignId || undefined)
        .then((data) => setRawCalls(data.calls))
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    } else {
      api
        .getCampaignAgentBreakdown(startDate, endDate, campaignId || undefined)
        .then((data) => setReport(data.report))
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }

  useEffect(() => {
    if (REPORTS_ROLES.includes(agent?.accessLevel)) {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, campaignId, startDate, endDate, reportType]);

  if (agent && !REPORTS_ROLES.includes(agent.accessLevel)) {
    return <Navigate to="/" replace />;
  }

  function handleDownloadCsv() {
    if (!report) return;

    const flatRows = [];
    for (const camp of report.campaigns) {
      for (const a of camp.agents) {
        flatRows.push({ campaignName: camp.campaignName, campaignId: camp.campaignId, ...a });
      }
    }

    const columns = [
      { label: "Campaign", value: "campaignName" },
      { label: "Agent", value: "fullName" },
      { label: "ViciDial User", value: "vicidialUser" },
      { label: "Total Calls", value: "totalCalls" },
      { label: "Inbound Calls", value: "totalInbound" },
      { label: "Outbound Calls", value: "totalOutbound" },
      { label: "AHT Inbound (s)", value: "ahtInboundSeconds" },
      { label: "AHT Outbound (s)", value: "ahtOutboundSeconds" },
      { label: "Avg IB Hold (s)", value: "avgIbHoldSeconds" },
      { label: "Avg OB Hold (s)", value: "avgObHoldSeconds" },
      { label: "Avg IB ACW (s)", value: "avgIbAcwSeconds" },
      { label: "Avg OB ACW (s)", value: "avgObAcwSeconds" },
    ];

    downloadCsv(`cmx-dialer-report-aggregated_${startDate}_to_${endDate}.csv`, columns, flatRows);
  }

  function handleDownloadRawCsv() {
    if (!rawCalls) return;

    const columns = [
      { label: "Call ID", value: "call_id" },
      { label: "Campaign", value: "campaign_id" },
      { label: "Direction", value: (row) => (row.direction === "inbound" ? "Inbound" : "Outbound") },
      { label: "Agent", value: (row) => row.agent_name || row.agent_user || "" },
      { label: "Phone Number", value: "phone_number" },
      { label: "Call Started", value: "call_started_at" },
      { label: "Call Ended", value: "call_ended_at" },
      { label: "Disposition", value: "disposition" },
      { label: "Wait Seconds", value: "wait_seconds" },
      { label: "Comments", value: "comments" },
    ];

    downloadCsv(`cmx-dialer-report-raw-calls_${startDate}_to_${endDate}.csv`, columns, rawCalls);
  }

  return (
    <>
      <Header />
      <div className="page-content page-content-wide">
        <h2>Reports</h2>

        <div className="card" style={{ marginBottom: 20, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label className="comments-label">Report Type</label>
            <select value={reportType} onChange={(e) => setReportType(e.target.value)}>
              <option value="aggregated">Aggregated</option>
              <option value="raw">Raw Data (Inbound + Outbound, combined)</option>
            </select>
          </div>
          <div>
            <label className="comments-label">Start Date</label>
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="comments-label">End Date</label>
            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div>
            <label className="comments-label">Campaign</label>
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              {isUnrestrictedCampaignAccess && <option value="">— All Campaigns —</option>}
              {campaigns.map((c) => (
                <option key={c.campaign_id} value={c.campaign_id}>
                  {c.campaign_name} ({c.campaign_id})
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="button-secondary"
            onClick={reportType === "raw" ? handleDownloadRawCsv : handleDownloadCsv}
            disabled={reportType === "raw" ? !rawCalls : !report}
          >
            Download CSV
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {loading && <p>Loading…</p>}

        {!loading && reportType === "aggregated" && report && (
          <>
            <div className="card" style={{ marginBottom: 20 }}>
              <h3>All Campaigns — Totals</h3>
              <table className="call-log-table">
                <thead>
                  <tr>
                    <th>Total Calls</th>
                    <th>Inbound</th>
                    <th>Outbound</th>
                    <th>AHT Inbound</th>
                    <th>AHT Outbound</th>
                    <th>Avg IB Hold</th>
                    <th>Avg OB Hold</th>
                    <th>Avg IB ACW</th>
                    <th>Avg OB ACW</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{report.grandTotals.totalCalls}</td>
                    <td>{report.grandTotals.totalInbound}</td>
                    <td>{report.grandTotals.totalOutbound}</td>
                    <td>{fmtSeconds(report.grandTotals.ahtInboundSeconds)}</td>
                    <td>{fmtSeconds(report.grandTotals.ahtOutboundSeconds)}</td>
                    <td>{fmtSeconds(report.grandTotals.avgIbHoldSeconds)}</td>
                    <td>{fmtSeconds(report.grandTotals.avgObHoldSeconds)}</td>
                    <td>{fmtSeconds(report.grandTotals.avgIbAcwSeconds)}</td>
                    <td>{fmtSeconds(report.grandTotals.avgObAcwSeconds)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {report.campaigns.length === 0 && <p>No calls in this range.</p>}

            {report.campaigns.map((camp) => (
              <div className="card" key={camp.campaignId ?? "unassigned"} style={{ marginBottom: 20 }}>
                <h3>
                  {camp.campaignName} — {camp.totals.totalCalls} calls
                </h3>
                <table className="call-log-table" style={{ marginBottom: 14 }}>
                  <thead>
                    <tr>
                      <th>Total Calls</th>
                      <th>Inbound</th>
                      <th>Outbound</th>
                      <th>AHT Inbound</th>
                      <th>AHT Outbound</th>
                      <th>Avg IB Hold</th>
                      <th>Avg OB Hold</th>
                      <th>Avg IB ACW</th>
                      <th>Avg OB ACW</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{camp.totals.totalCalls}</td>
                      <td>{camp.totals.totalInbound}</td>
                      <td>{camp.totals.totalOutbound}</td>
                      <td>{fmtSeconds(camp.totals.ahtInboundSeconds)}</td>
                      <td>{fmtSeconds(camp.totals.ahtOutboundSeconds)}</td>
                      <td>{fmtSeconds(camp.totals.avgIbHoldSeconds)}</td>
                      <td>{fmtSeconds(camp.totals.avgObHoldSeconds)}</td>
                      <td>{fmtSeconds(camp.totals.avgIbAcwSeconds)}</td>
                      <td>{fmtSeconds(camp.totals.avgObAcwSeconds)}</td>
                    </tr>
                  </tbody>
                </table>

                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Total Calls</th>
                      <th>Inbound</th>
                      <th>Outbound</th>
                      <th>AHT Inbound</th>
                      <th>AHT Outbound</th>
                      <th>Avg IB Hold</th>
                      <th>Avg OB Hold</th>
                      <th>Avg IB ACW</th>
                      <th>Avg OB ACW</th>
                    </tr>
                  </thead>
                  <tbody>
                    {camp.agents.length === 0 ? (
                      <tr>
                        <td colSpan={10} style={{ color: "#888" }}>
                          No agent activity in this range.
                        </td>
                      </tr>
                    ) : (
                      camp.agents.map((a) => (
                        <tr key={`${camp.campaignId}-${a.vicidialUser}`}>
                          <td>{a.fullName}</td>
                          <td>{a.totalCalls}</td>
                          <td>{a.totalInbound}</td>
                          <td>{a.totalOutbound}</td>
                          <td>{fmtSeconds(a.ahtInboundSeconds)}</td>
                          <td>{fmtSeconds(a.ahtOutboundSeconds)}</td>
                          <td>{fmtSeconds(a.avgIbHoldSeconds)}</td>
                          <td>{fmtSeconds(a.avgObHoldSeconds)}</td>
                          <td>{fmtSeconds(a.avgIbAcwSeconds)}</td>
                          <td>{fmtSeconds(a.avgObAcwSeconds)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}

        {!loading && reportType === "raw" && rawCalls && (
          <div className="card call-log-card">
            <h3>Raw Call Data — {rawCalls.length} calls</h3>
            {rawCalls.length === 0 ? (
              <p>No calls in this range.</p>
            ) : (
              <table className="call-log-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Campaign</th>
                    <th>Direction</th>
                    <th>Agent</th>
                    <th>Phone Number</th>
                    <th>Disposition</th>
                    <th>Wait (s)</th>
                  </tr>
                </thead>
                <tbody>
                  {rawCalls.map((c) => (
                    <tr key={c.call_id}>
                      <td>{new Date(c.call_started_at).toLocaleString()}</td>
                      <td>{c.campaign_id || "—"}</td>
                      <td>{c.direction === "inbound" ? "Inbound" : "Outbound"}</td>
                      <td>{c.agent_name || c.agent_user || "—"}</td>
                      <td>{c.phone_number || "—"}</td>
                      <td>{c.disposition || "—"}</td>
                      <td>{c.wait_seconds ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </>
  );
}
