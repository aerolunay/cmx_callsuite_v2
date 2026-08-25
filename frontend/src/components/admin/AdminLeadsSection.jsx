import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN LEADS / AUTO-DIAL SECTION — Phase 1
==================================================
Three parts: Upload Leads (assigns to an outbound-only campaign —
Blended excluded per explicit request), Autodial Rules (per selected
campaign — max attempts per outcome, interval, calling hours), and
DNC Management (upload + count + pre-dial check already wired into
dialerService.js's getNextLead()).

This is Phase 1 only — data & rules. The actual engine that reads
these rules and dials leads unattended (Phase 2) does not exist yet;
nothing on this page originates a call.

Only outbound campaigns are ever selectable here — fetched via
getAdminCampaigns("type=OUTBOUND"), which filters server-side on
cmx_dialer.campaign_settings.campaign_type, not just hidden client-side.
==================================================
*/

const DAYS = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

// Same day-range<->array helpers already proven in
// AdminCampaignsSection.jsx for business hours — duplicated here
// rather than shared, since these two components have no other reason
// to be coupled together.
function daysStringToArray(str) {
  if (!str) return ["mon", "tue", "wed", "thu", "fri"];
  if (str.includes("-") && !str.includes(",")) {
    const order = DAYS.map((d) => d.key);
    const [start, end] = str.split("-");
    const startIdx = order.indexOf(start);
    const endIdx = order.indexOf(end);
    if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
      return order.slice(startIdx, endIdx + 1);
    }
  }
  return str.split(",").map((s) => s.trim());
}

function daysArrayToString(arr) {
  const order = DAYS.map((d) => d.key);
  const sorted = [...arr].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const indices = sorted.map((d) => order.indexOf(d));
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
  if (isContiguous && sorted.length > 1) {
    return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  }
  return sorted.join(",");
}

export default function AdminLeadsSection() {
  const [outboundCampaigns, setOutboundCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);

  // Upload Leads
  const [uploadCampaignId, setUploadCampaignId] = useState("");
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadError, setUploadError] = useState("");

  // Autodial Rules
  const [rulesCampaignId, setRulesCampaignId] = useState("");
  const [maxAttemptsBusy, setMaxAttemptsBusy] = useState(3);
  const [maxAttemptsNoAnswer, setMaxAttemptsNoAnswer] = useState(3);
  const [maxAttemptsMachine, setMaxAttemptsMachine] = useState(3);
  const [attemptIntervalMinutes, setAttemptIntervalMinutes] = useState(60);
  const [selectedDays, setSelectedDays] = useState(["mon", "tue", "wed", "thu", "fri"]);
  const [callingStartTime, setCallingStartTime] = useState("09:00");
  const [callingEndTime, setCallingEndTime] = useState("18:00");
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesSuccess, setRulesSuccess] = useState("");
  const [rulesError, setRulesError] = useState("");

  // DNC
  const [dncCount, setDncCount] = useState(null);
  const [dncFile, setDncFile] = useState(null);
  const [dncBusy, setDncBusy] = useState(false);
  const [dncResult, setDncResult] = useState(null);
  const [dncError, setDncError] = useState("");

  useEffect(() => {
    setCampaignsLoading(true);
    api
      .getAdminCampaigns("type=OUTBOUND")
      .then((data) => setOutboundCampaigns(data.campaigns || []))
      .catch(() => {})
      .finally(() => setCampaignsLoading(false));

    api
      .getDncList()
      .then((data) => setDncCount(data.count))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!rulesCampaignId) return;
    setRulesLoading(true);
    setRulesError("");
    api
      .getAutodialRules(rulesCampaignId)
      .then((data) => {
        const r = data.rules;
        setMaxAttemptsBusy(r.maxAttemptsBusy);
        setMaxAttemptsNoAnswer(r.maxAttemptsNoAnswer);
        setMaxAttemptsMachine(r.maxAttemptsMachine);
        setAttemptIntervalMinutes(r.attemptIntervalMinutes);
        setSelectedDays(daysStringToArray(r.callingDays));
        setCallingStartTime(r.callingStartTime);
        setCallingEndTime(r.callingEndTime);
      })
      .catch((err) => setRulesError(err.message))
      .finally(() => setRulesLoading(false));
  }, [rulesCampaignId]);

  function toggleDay(dayKey) {
    setSelectedDays((prev) => (prev.includes(dayKey) ? prev.filter((d) => d !== dayKey) : [...prev, dayKey]));
  }

  async function handleUploadSubmit(e) {
    e.preventDefault();
    if (!uploadCampaignId || !uploadFile) return;
    setUploadBusy(true);
    setUploadError("");
    setUploadResult(null);
    try {
      const formData = new FormData();
      formData.append("campaignId", uploadCampaignId);
      formData.append("file", uploadFile);
      const result = await api.uploadLeads(formData);
      setUploadResult(result);
      setUploadFile(null);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleRulesSubmit(e) {
    e.preventDefault();
    if (!rulesCampaignId) return;
    setRulesBusy(true);
    setRulesError("");
    setRulesSuccess("");
    try {
      await api.updateAutodialRules(rulesCampaignId, {
        maxAttemptsBusy: Number(maxAttemptsBusy),
        maxAttemptsNoAnswer: Number(maxAttemptsNoAnswer),
        maxAttemptsMachine: Number(maxAttemptsMachine),
        attemptIntervalMinutes: Number(attemptIntervalMinutes),
        callingDays: daysArrayToString(selectedDays),
        callingStartTime,
        callingEndTime,
      });
      setRulesSuccess("Autodial rules saved.");
    } catch (err) {
      setRulesError(err.message);
    } finally {
      setRulesBusy(false);
    }
  }

  async function handleDncSubmit(e) {
    e.preventDefault();
    if (!dncFile) return;
    setDncBusy(true);
    setDncError("");
    setDncResult(null);
    try {
      const formData = new FormData();
      formData.append("file", dncFile);
      const result = await api.uploadDnc(formData);
      setDncResult(result);
      setDncFile(null);
      const refreshed = await api.getDncList();
      setDncCount(refreshed.count);
    } catch (err) {
      setDncError(err.message);
    } finally {
      setDncBusy(false);
    }
  }

  return (
    <>
      <h3>Leads &amp; Auto-Dial</h3>
      <p style={{ fontSize: 13, color: "#888", marginTop: -6 }}>
        Phase 1 — lead upload, autodial rule configuration, and DNC management. The automated
        dialing engine that actually enforces these rules is a separate, future phase; nothing
        here places a call on its own.
      </p>

      {/* ================= UPLOAD LEADS ================= */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h4>Upload Leads</h4>
        {uploadError && <div className="error">{uploadError}</div>}
        {uploadResult && (
          <div className="success">
            Imported {uploadResult.imported} lead{uploadResult.imported === 1 ? "" : "s"}
            {uploadResult.skipped > 0 ? ` (${uploadResult.skipped} row(s) skipped — missing phone number)` : ""}.
          </div>
        )}

        <p style={{ fontSize: 13 }}>
          <a href="/api/admin/leads/template?format=xlsx">Download XLSX template</a>
          {" · "}
          <a href="/api/admin/leads/template?format=csv">Download CSV template</a>
        </p>

        <form onSubmit={handleUploadSubmit}>
          <label className="comments-label">Campaign (Outbound only — Blended excluded)</label>
          <select value={uploadCampaignId} onChange={(e) => setUploadCampaignId(e.target.value)} required>
            <option value="">Select a campaign…</option>
            {outboundCampaigns.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>
                {c.campaign_name} ({c.campaign_id})
              </option>
            ))}
          </select>
          {!campaignsLoading && outboundCampaigns.length === 0 && (
            <p style={{ fontSize: 13, color: "#888" }}>
              No Outbound campaigns exist yet — create one under "Campaigns" (Campaign Type:
              Outbound) first.
            </p>
          )}

          <label className="comments-label">Lead File (CSV or XLSX)</label>
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
            required
          />

          <div style={{ marginTop: 14 }}>
            <button className="button-secondary" type="submit" disabled={uploadBusy}>
              {uploadBusy ? "Uploading…" : "Upload Leads"}
            </button>
          </div>
        </form>
      </div>

      {/* ================= AUTODIAL RULES ================= */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h4>Autodial Rules</h4>
        {rulesError && <div className="error">{rulesError}</div>}
        {rulesSuccess && <div className="success">{rulesSuccess}</div>}

        <label className="comments-label">Campaign</label>
        <select value={rulesCampaignId} onChange={(e) => setRulesCampaignId(e.target.value)}>
          <option value="">Select a campaign…</option>
          {outboundCampaigns.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>
              {c.campaign_name} ({c.campaign_id})
            </option>
          ))}
        </select>

        {rulesCampaignId && (
          <form onSubmit={handleRulesSubmit} style={{ marginTop: 14 }}>
            {rulesLoading ? (
              <p>Loading current rules…</p>
            ) : (
              <>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <div>
                    <label className="comments-label">Max Attempts — Busy</label>
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={maxAttemptsBusy}
                      onChange={(e) => setMaxAttemptsBusy(e.target.value)}
                      style={{ width: 80 }}
                    />
                  </div>
                  <div>
                    <label className="comments-label">Max Attempts — No Answer</label>
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={maxAttemptsNoAnswer}
                      onChange={(e) => setMaxAttemptsNoAnswer(e.target.value)}
                      style={{ width: 80 }}
                    />
                  </div>
                  <div>
                    <label className="comments-label">Max Attempts — Left VM</label>
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={maxAttemptsMachine}
                      onChange={(e) => setMaxAttemptsMachine(e.target.value)}
                      style={{ width: 80 }}
                    />
                  </div>
                </div>

                <label className="comments-label" style={{ marginTop: 10 }}>
                  Interval Between Attempts (minutes, resets daily)
                </label>
                <input
                  type="number"
                  min="1"
                  value={attemptIntervalMinutes}
                  onChange={(e) => setAttemptIntervalMinutes(e.target.value)}
                  style={{ width: 100 }}
                />

                <label className="comments-label" style={{ marginTop: 10 }}>
                  Calling Hours (America/New_York)
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="time" value={callingStartTime} onChange={(e) => setCallingStartTime(e.target.value)} />
                  <span>to</span>
                  <input type="time" value={callingEndTime} onChange={(e) => setCallingEndTime(e.target.value)} />
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                  {DAYS.map((d) => (
                    <label key={d.key} className="disposition-row" style={{ marginTop: 0 }}>
                      <input type="checkbox" checked={selectedDays.includes(d.key)} onChange={() => toggleDay(d.key)} />
                      {d.label}
                    </label>
                  ))}
                </div>

                <div style={{ marginTop: 14 }}>
                  <button className="button-secondary" type="submit" disabled={rulesBusy}>
                    {rulesBusy ? "Saving…" : "Save Rules"}
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </div>

      {/* ================= DNC MANAGEMENT ================= */}
      <div className="card">
        <h4>Do Not Call (DNC) List</h4>
        <p style={{ fontSize: 13, color: "#888" }}>
          {dncCount === null ? "Loading…" : `${dncCount.toLocaleString()} number(s) currently on the list.`}
          {" "}Every call disposed as "Do Not Call" is added here automatically. Numbers on this list
          are never eligible for auto-dial or manual "Dial Next Number."
        </p>
        {dncError && <div className="error">{dncError}</div>}
        {dncResult && (
          <div className="success">
            Added {dncResult.imported} number{dncResult.imported === 1 ? "" : "s"}
            {dncResult.duplicates > 0 ? ` (${dncResult.duplicates} already on the list)` : ""}
            {dncResult.skipped > 0 ? ` (${dncResult.skipped} row(s) skipped — missing phone number)` : ""}.
          </div>
        )}

        <p style={{ fontSize: 13 }}>
          <a href="/api/admin/dnc/template?format=xlsx">Download XLSX template</a>
          {" · "}
          <a href="/api/admin/dnc/template?format=csv">Download CSV template</a>
        </p>

        <form onSubmit={handleDncSubmit}>
          <label className="comments-label">DNC File (CSV or XLSX)</label>
          <input type="file" accept=".csv,.xlsx" onChange={(e) => setDncFile(e.target.files?.[0] || null)} required />
          <div style={{ marginTop: 14 }}>
            <button className="button-secondary" type="submit" disabled={dncBusy}>
              {dncBusy ? "Uploading…" : "Upload DNC List"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
