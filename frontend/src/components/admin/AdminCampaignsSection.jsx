import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN CAMPAIGNS SECTION
==================================================
Creating a campaign here also auto-creates its DID routing
(asterisk.vicidial_inbound_dids), converts + deploys its two audio
prompts, and generates/reloads the dialplan that actually routes calls
for that DID — see campaignRoutes.js for the full chain. Nothing here
ever touches pjsip.conf or the shared outbound trunk (CMXSandbox) —
only the dialplan (extensions-campaigns-cmxdialer.conf) and the
database, so campaign management can never disrupt a live call on a
different campaign.

DID is treated as immutable once created — same "delete + recreate"
philosophy as Phone Login's username/extension elsewhere in this app.

Caller ID: leaving it blank means "spoof the DID as the outbound
Caller ID" — the backend does this substitution, not this component;
it's surfaced here only as a placeholder hint.

Business hours are NOT something the user explicitly asked for when
this feature was scoped, but the After Hours audio has no meaning
without a real hours/day window to gate on — defaults to 09:00-18:00,
Mon-Fri if left as-is.
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

function daysStringToArray(str) {
  if (!str) return ["mon", "tue", "wed", "thu", "fri"];
  // Supports both "mon-fri" range syntax and "mon,wed,fri" list syntax
  // — GotoIfTime() accepts either, so this just needs to expand a
  // range for the checkbox UI's sake; a plain list passes through as-is.
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
  // Collapses back to "mon-fri"-style range syntax when the selection
  // is a single contiguous block in calendar order — falls back to a
  // comma list otherwise. Both are valid GotoIfTime() syntax.
  const order = DAYS.map((d) => d.key);
  const sorted = [...arr].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const indices = sorted.map((d) => order.indexOf(d));
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
  if (isContiguous && sorted.length > 1) {
    return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  }
  return sorted.join(",");
}

export default function AdminCampaignsSection() {
  const [campaigns, setCampaigns] = useState([]);
  const [editingCampaignId, setEditingCampaignId] = useState(null); // null = create mode

  const [campaignId, setCampaignId] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [did, setDid] = useState("");
  const [callerId, setCallerId] = useState("");
  const [campaignType, setCampaignType] = useState("OUTBOUND");
  const [blendedFallbackCampaignId, setBlendedFallbackCampaignId] = useState("");
  const [dialMethod, setDialMethod] = useState("MANUAL");
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [businessHoursStart, setBusinessHoursStart] = useState("09:00");
  const [businessHoursEnd, setBusinessHoursEnd] = useState("18:00");
  const [selectedDays, setSelectedDays] = useState(["mon", "tue", "wed", "thu", "fri"]);
  const [active, setActive] = useState(true);

  const [welcomeGreetingFile, setWelcomeGreetingFile] = useState(null);
  const [afterhoursAudioFile, setAfterhoursAudioFile] = useState(null);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function loadAll() {
    setLoading(true);
    api
      .getAdminCampaigns()
      .then((data) => setCampaigns(data.campaigns))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
  }, []);

  function resetForm() {
    setEditingCampaignId(null);
    setCampaignId("");
    setCampaignName("");
    setDid("");
    setCallerId("");
    setCampaignType("OUTBOUND");
    setBlendedFallbackCampaignId("");
    setDialMethod("MANUAL");
    setRecordingEnabled(true);
    setBusinessHoursStart("09:00");
    setBusinessHoursEnd("18:00");
    setSelectedDays(["mon", "tue", "wed", "thu", "fri"]);
    setActive(true);
    setWelcomeGreetingFile(null);
    setAfterhoursAudioFile(null);
    setError("");
    setSuccess("");
  }

  function handleStartEdit(c) {
    setEditingCampaignId(c.campaign_id);
    setCampaignId(c.campaign_id);
    setCampaignName(c.campaign_name || "");
    setDid(c.did || "");
    setCallerId(c.campaign_cid && c.campaign_cid !== c.did ? c.campaign_cid : "");
    setCampaignType(c.campaign_type || "OUTBOUND");
    setBlendedFallbackCampaignId(c.blended_fallback_campaign_id || "");
    setDialMethod(c.dial_method === "MANUAL" ? "MANUAL" : "AUTO");
    setRecordingEnabled(c.campaign_recording !== "NEVER");
    setBusinessHoursStart(c.business_hours_start || "09:00");
    setBusinessHoursEnd(c.business_hours_end || "18:00");
    setSelectedDays(daysStringToArray(c.business_days));
    setActive(c.active === "Y");
    setWelcomeGreetingFile(null);
    setAfterhoursAudioFile(null);
    setError("");
    setSuccess("");
  }

  async function handleDeactivate(c) {
    if (
      !window.confirm(
        `Deactivate campaign ${c.campaign_id}? Its DID (${c.did || "none"}) will stop routing calls immediately, and its dialplan block will be removed. The campaign ID stays reserved and its historical call/lead data remains intact — this does NOT permanently erase it.`
      )
    ) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.deactivateCampaign(c.campaign_id);
      if (editingCampaignId === c.campaign_id) resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(c) {
    if (
      !window.confirm(
        `PERMANENTLY delete campaign ${c.campaign_id}? This cannot be undone. Its DID and dialplan block are removed immediately, the campaign ID itself is freed for reuse, and any historical call/lead reports referencing this campaign will no longer show its name (the underlying call records aren't deleted, just the name lookup). Use Deactivate instead if you're not sure.`
      )
    ) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.deleteCampaign(c.campaign_id);
      if (editingCampaignId === c.campaign_id) resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleDay(dayKey) {
    setSelectedDays((prev) => (prev.includes(dayKey) ? prev.filter((d) => d !== dayKey) : [...prev, dayKey]));
  }

  function buildFormData() {
    const formData = new FormData();
    formData.append("campaignName", campaignName);
    formData.append("callerId", callerId);
    formData.append("campaignType", campaignType);
    formData.append("dialMethod", campaignType === "OUTBOUND" ? dialMethod : "MANUAL");
    formData.append("blendedFallbackCampaignId", campaignType === "OUTBOUND" ? blendedFallbackCampaignId : "");
    formData.append("recordingEnabled", String(recordingEnabled));
    formData.append("businessHoursStart", businessHoursStart);
    formData.append("businessHoursEnd", businessHoursEnd);
    formData.append("businessDays", daysArrayToString(selectedDays));
    formData.append("active", String(active));
    if (!editingCampaignId) {
      formData.append("campaignId", campaignId);
      formData.append("did", did);
    }
    if (welcomeGreetingFile) formData.append("welcomeGreeting", welcomeGreetingFile);
    if (afterhoursAudioFile) formData.append("afterhoursAudio", afterhoursAudioFile);
    return formData;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const formData = buildFormData();
      let result;
      if (editingCampaignId) {
        result = await api.updateCampaign(editingCampaignId, formData);
        setSuccess(`Campaign ${editingCampaignId} updated.${result?.reloadWarning ? ` ${result.reloadWarning}` : ""}`);
      } else {
        result = await api.createCampaign(formData);
        setSuccess(`Campaign ${campaignId} created.${result?.reloadWarning ? ` ${result.reloadWarning}` : ""}`);
      }
      resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>{editingCampaignId ? `Edit Campaign ${editingCampaignId}` : "Create Campaign"}</h3>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card">
              <form onSubmit={handleSubmit}>
                <label className="comments-label">Campaign ID</label>
                <input
                  type="text"
                  value={campaignId}
                  onChange={(e) => setCampaignId(e.target.value.toUpperCase())}
                  placeholder="e.g. CMXSALES"
                  maxLength={8}
                  required
                  disabled={Boolean(editingCampaignId)}
                />
                {editingCampaignId && (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    Campaign ID can't be changed once created — delete and recreate instead.
                  </p>
                )}

                <label className="comments-label">Campaign Name</label>
                <input type="text" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} required />

                <label className="comments-label">DID</label>
                <input
                  type="text"
                  value={did}
                  onChange={(e) => setDid(e.target.value)}
                  placeholder="e.g. 6468016974"
                  disabled={Boolean(editingCampaignId)}
                />
                {editingCampaignId ? (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    DID can't be changed once created — delete and recreate instead.
                  </p>
                ) : (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    Leave blank for a campaign with no inbound routing at all (pure manual/outbound only).
                  </p>
                )}

                <label className="comments-label">Caller ID</label>
                <input
                  type="text"
                  value={callerId}
                  onChange={(e) => setCallerId(e.target.value)}
                  placeholder="Leave blank to spoof the DID as the outbound Caller ID"
                />

                <label className="comments-label">Campaign Type</label>
                <select value={campaignType} onChange={(e) => setCampaignType(e.target.value)}>
                  <option value="OUTBOUND">Outbound</option>
                  <option value="BLENDED">Blended</option>
                </select>

                {campaignType === "OUTBOUND" && (
                  <>
                    <label className="comments-label">Dial Method</label>
                    <select value={dialMethod} onChange={(e) => setDialMethod(e.target.value)}>
                      <option value="MANUAL">Manual Dial</option>
                      <option value="AUTO">Auto Dial</option>
                      {/* Predictive Dialing — UI placeholder only, per
                          explicit request. Deliberately NOT selectable
                          yet (disabled) until the real engine (ratio/
                          pacing across multiple agents, dialing ahead
                          of availability) is actually built — a
                          separate, larger piece of work than the
                          simple per-agent "auto-advance" that AUTO
                          currently means. Shown here now so admins can
                          see it's coming, without being able to
                          accidentally select something that doesn't
                          exist yet. */}
                      <option value="PREDICTIVE" disabled>
                        Predictive Dialing (coming soon)
                      </option>
                    </select>

                    {/* Per explicit request, confirmed as a real gap
                        via a live test call: outbound campaigns must
                        never receive inbound calls to their own
                        agents. If this campaign's DID is also used
                        as its outbound Caller ID ("spoofed number"),
                        a customer calling it back needs somewhere
                        real to go — this picks which BLENDED
                        campaign's own queue receives it instead.
                        Leaving this blank means the DID won't answer
                        at all if called back — the safest default. */}
                    <label className="comments-label" style={{ marginTop: 10 }}>
                      Inbound Callback Routes To (optional)
                    </label>
                    <select value={blendedFallbackCampaignId} onChange={(e) => setBlendedFallbackCampaignId(e.target.value)}>
                      <option value="">— None (callback won't be answered) —</option>
                      {campaigns
                        .filter((c) => c.campaign_type === "BLENDED")
                        .map((c) => (
                          <option key={c.campaign_id} value={c.campaign_id}>
                            {c.campaign_name} ({c.campaign_id})
                          </option>
                        ))}
                    </select>
                  </>
                )}

                <label className="disposition-row" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={recordingEnabled} onChange={(e) => setRecordingEnabled(e.target.checked)} />
                  Call Recording Enabled
                </label>

                <label className="comments-label" style={{ marginTop: 10 }}>
                  Business Hours (used for After Hours routing)
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="time" value={businessHoursStart} onChange={(e) => setBusinessHoursStart(e.target.value)} />
                  <span>to</span>
                  <input type="time" value={businessHoursEnd} onChange={(e) => setBusinessHoursEnd(e.target.value)} />
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                  {DAYS.map((d) => (
                    <label key={d.key} className="disposition-row" style={{ marginTop: 0 }}>
                      <input type="checkbox" checked={selectedDays.includes(d.key)} onChange={() => toggleDay(d.key)} />
                      {d.label}
                    </label>
                  ))}
                </div>

                <label className="comments-label" style={{ marginTop: 10 }}>
                  Welcome Greeting {editingCampaignId && "(leave blank to keep current)"}
                </label>
                <input type="file" accept="audio/*" onChange={(e) => setWelcomeGreetingFile(e.target.files?.[0] || null)} />

                <label className="comments-label" style={{ marginTop: 10 }}>
                  After Hours Audio {editingCampaignId && "(leave blank to keep current)"}
                </label>
                <input type="file" accept="audio/*" onChange={(e) => setAfterhoursAudioFile(e.target.files?.[0] || null)} />
                <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                  Any common audio format works — converted automatically to what Asterisk needs.
                </p>

                <label className="disposition-row" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                  Active
                </label>

                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button className="button-secondary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : editingCampaignId ? "Save Changes" : "Create Campaign"}
                  </button>
                  {editingCampaignId && (
                    <button type="button" className="link" onClick={resetForm} disabled={busy}>
                      Cancel Edit
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>

          <div className="dialer-side">
            <div className="card call-log-card">
              <h3>Existing Campaigns</h3>
              {campaigns.length === 0 && <p>No campaigns yet.</p>}
              {campaigns.length > 0 && (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Name</th>
                      <th>DID</th>
                      <th>Type</th>
                      <th>Recording</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => (
                      <tr key={c.campaign_id} className="call-log-row" onDoubleClick={() => handleStartEdit(c)}>
                        <td>{c.campaign_id}</td>
                        <td className="admin-name-cell">{c.campaign_name || "—"}</td>
                        <td>{c.did || "—"}</td>
                        <td>{c.campaign_type || "OUTBOUND"}</td>
                        <td>{c.campaign_recording === "NEVER" ? "Off" : "On"}</td>
                        <td>{c.active === "Y" ? "Yes" : "No"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button type="button" className="link" onClick={() => handleStartEdit(c)} disabled={busy}>
                            Edit
                          </button>
                          {" · "}
                          <button type="button" className="link" onClick={() => handleDeactivate(c)} disabled={busy}>
                            Deactivate
                          </button>
                          {" · "}
                          <button type="button" className="link" onClick={() => handleDelete(c)} disabled={busy}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
