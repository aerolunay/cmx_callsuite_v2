import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN USERS SECTION
==================================================
Simplified back to "bind to an existing Phone Login only" — the inline
"create a brand new Phone Login" toggle that used to live here has
been REMOVED, per explicit request to separate that creation out into
its own standalone section (see AdminVicidialUsersSection.jsx). Create
a Phone Login there first, then it shows up in the dropdown below
exactly like any other unclaimed account.
==================================================
*/
export default function AdminUsersSection() {
  const [vicidialUsers, setVicidialUsers] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [users, setUsers] = useState([]);

  const [editingUserId, setEditingUserId] = useState(null); // null = create mode
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [accessLevel, setAccessLevel] = useState("agent");
  const [vicidialUser, setVicidialUser] = useState("");
  const [selectedCampaigns, setSelectedCampaigns] = useState([]);
  const [active, setActive] = useState(true);
  // Priority: default 1 (strict FIFO). 2 = skipped up to 3x in a row
  // (unless no other agent is available), 3 = skipped up to 5x. See
  // agentStatusService.js's getAnyReadyAgentWithExtension for the full
  // logic — this just sets the tier, the matching engine does the rest.
  const [priority, setPriority] = useState("1");
  // Multi-campaign selection — per explicit request, admin/WFM
  // controlled: whether THIS agent is allowed to select more than one
  // BLENDED campaign to work simultaneously (see
  // agentStatusService.js's getAnyReadyAgentWithExtension and
  // dialerRoutes.js's POST /dialer/working-campaigns for the actual
  // enforcement — this checkbox just sets the permission, the agent
  // still has to go make a real selection on their end).
  const [multiCampaignEnabled, setMultiCampaignEnabled] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function loadAll() {
    setLoading(true);
    Promise.all([api.getAvailableVicidialUsers(), api.getCampaigns(), api.getAdminUsers()])
      .then(([vicidialData, campaignData, usersData]) => {
        setVicidialUsers(vicidialData.vicidialUsers);
        setCampaigns(campaignData.campaigns);
        setUsers(usersData.users);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
  }, []);

  // Clears any stale campaign selection the moment WFM/Admin is picked
  // — those two roles get implicit all-campaign access (see
  // accessControlService.js), so a leftover checked box here would be
  // meaningless data written to agent_campaign_assignments for no
  // reason. Harmless no-op for every other access level.
  useEffect(() => {
    if (["wfm", "admin"].includes(accessLevel)) {
      setSelectedCampaigns([]);
    }
  }, [accessLevel]);

  function toggleCampaign(campaignId) {
    setSelectedCampaigns((prev) =>
      prev.includes(campaignId) ? prev.filter((c) => c !== campaignId) : [...prev, campaignId]
    );
  }

  function resetForm() {
    setEditingUserId(null);
    setEmail("");
    setFullName("");
    setAccessLevel("agent");
    setVicidialUser("");
    setSelectedCampaigns([]);
    setActive(true);
    setPriority("1");
    setMultiCampaignEnabled(false);
  }

  function handleStartEdit(u) {
    setEditingUserId(u.app_user_id);
    setEmail(u.email);
    setFullName(u.full_name);
    setAccessLevel(u.access_level);
    setVicidialUser(u.vicidial_user || "");
    setSelectedCampaigns(u.campaigns ? u.campaigns.split(", ") : []);
    setActive(Boolean(u.active));
    setPriority(String(u.priority ?? "1"));
    setMultiCampaignEnabled(Boolean(u.multi_campaign_enabled));
    setError("");
    setSuccess("");
  }

  async function handleDelete(u) {
    if (!window.confirm(`Permanently delete ${u.email}? This cannot be undone. Their Phone Login/phone will become available for a new account immediately.`)) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.deleteAdminUser(u.app_user_id);
      if (editingUserId === u.app_user_id) resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const payload = {
        email,
        fullName,
        accessLevel,
        vicidialUser: vicidialUser || null,
        campaignIds: selectedCampaigns,
        active,
        priority: Number(priority),
        multiCampaignEnabled,
      };

      if (editingUserId) {
        await api.updateAdminUser(editingUserId, payload);
        setSuccess(`User ${email} updated.`);
      } else {
        await api.createAdminUser(payload);
        setSuccess(`User ${email} created.`);
      }

      resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const vicidialOptions = (() => {
    if (!editingUserId) return vicidialUsers;
    const current = users.find((u) => u.app_user_id === editingUserId);
    if (!current || !current.vicidial_user) return vicidialUsers;
    if (vicidialUsers.some((vu) => vu.vicidial_user === current.vicidial_user)) return vicidialUsers;
    return [{ vicidial_user: current.vicidial_user, full_name: "(currently assigned)", phone_login: current.phone_login }, ...vicidialUsers];
  })();

  return (
    <>
      <h3>{editingUserId ? "Edit User" : "Create User"}</h3>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card">
              <form onSubmit={handleSubmit}>
                <label className="comments-label">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

                <label className="comments-label">Full Name</label>
                <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} required />

                <label className="comments-label">Access Level</label>
                <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value)}>
                  <option value="agent">Agent</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="training_quality">Training &amp; Quality</option>
                  <option value="account_manager">Account Manager</option>
                  <option value="wfm">WFM</option>
                  <option value="admin">Admin</option>
                </select>

                <label className="comments-label">Phone Login (phone binding)</label>
                <select value={vicidialUser} onChange={(e) => setVicidialUser(e.target.value)}>
                  <option value="">— None / Release —</option>
                  {vicidialOptions.map((vu) => (
                    <option key={vu.vicidial_user} value={vu.vicidial_user}>
                      {vu.vicidial_user} — {vu.full_name} (phone {vu.phone_login})
                    </option>
                  ))}
                </select>
                {vicidialOptions.length === 0 && (
                  <p style={{ fontSize: 13, color: "#888" }}>
                    No unclaimed Phone Logins available — create one under "Phone Login"
                    first, or every active one already has an app account.
                  </p>
                )}

                {/* WFM and Admin get implicit access to ALL campaigns
                    (see accessControlService.js's
                    UNRESTRICTED_CAMPAIGN_ROLES) — per explicit request,
                    no need to check individual campaigns to bind when
                    either of those is selected, so this section hides
                    itself entirely rather than showing a checkbox list
                    that wouldn't do anything meaningful for these two
                    roles. */}
                {!["wfm", "admin"].includes(accessLevel) && (
                  <>
                    <label className="comments-label">Campaign Access</label>
                    {campaigns.map((c) => (
                      <label key={c.campaign_id} className="disposition-row">
                        <input
                          type="checkbox"
                          checked={selectedCampaigns.includes(c.campaign_id)}
                          onChange={() => toggleCampaign(c.campaign_id)}
                        />
                        {c.campaign_name} ({c.campaign_id})
                      </label>
                    ))}

                    <label className="disposition-row" style={{ marginTop: 10 }}>
                      <input
                        type="checkbox"
                        checked={multiCampaignEnabled}
                        onChange={(e) => setMultiCampaignEnabled(e.target.checked)}
                      />
                      Allow Multiple Blended Campaigns
                    </label>
                    <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                      Lets this agent select more than one blended campaign to work on
                      simultaneously (receiving inbound calls from any of them while Ready).
                      Selecting an outbound campaign always stays exclusive, regardless of this
                      setting.
                    </p>
                  </>
                )}

                <label className="comments-label">Priority</label>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>

                <label className="disposition-row" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                  Active (unchecked = blocked from logging into the app entirely)
                </label>

                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button className="button-secondary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : editingUserId ? "Save Changes" : "Create User"}
                  </button>
                  {editingUserId && (
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
              <h3>Existing Users</h3>
              {users.length === 0 && <p>No users yet.</p>}
              {users.length > 0 && (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>Access</th>
                      <th>Active</th>
                      <th>Priority</th>
                      <th>Multi-Campaign</th>
                      <th>Phone Login</th>
                      <th>Phone</th>
                      <th>Campaigns</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr
                        key={u.app_user_id}
                        className="call-log-row"
                        onDoubleClick={() => handleStartEdit(u)}
                      >
                        <td>{u.email}</td>
                        <td className="admin-name-cell">{u.full_name}</td>
                        <td>{u.access_level}</td>
                        <td>{u.active ? "Yes" : "No"}</td>
                        <td>{u.priority ?? 1}</td>
                        <td>{u.multi_campaign_enabled ? "Yes" : "No"}</td>
                        <td>{u.vicidial_user || "—"}</td>
                        <td>{u.phone_login || "—"}</td>
                        <td>{u.campaigns || "—"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button type="button" className="link" onClick={() => handleStartEdit(u)} disabled={busy}>
                            Edit
                          </button>
                          {" · "}
                          <button type="button" className="link" onClick={() => handleDelete(u)} disabled={busy}>
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
