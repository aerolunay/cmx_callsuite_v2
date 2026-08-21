import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN USERS SECTION
==================================================
Simplified back to "bind to an existing ViciDial user only" — the
inline "create a brand new ViciDial user" toggle that used to live here
has been REMOVED, per explicit request to separate ViciDial user
creation out into its own standalone section (see
AdminVicidialUsersSection.jsx). Create a ViciDial user there first,
then it shows up in the dropdown below exactly like any other
unclaimed account.
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
  }

  function handleStartEdit(u) {
    setEditingUserId(u.app_user_id);
    setEmail(u.email);
    setFullName(u.full_name);
    setAccessLevel(u.access_level);
    setVicidialUser(u.vicidial_user || "");
    setSelectedCampaigns(u.campaigns ? u.campaigns.split(", ") : []);
    setActive(Boolean(u.active));
    setError("");
    setSuccess("");
  }

  async function handleDelete(u) {
    if (!window.confirm(`Permanently delete ${u.email}? This cannot be undone. Their ViciDial user/phone will become available for a new account immediately.`)) {
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
                  <option value="admin">Admin</option>
                </select>

                <label className="comments-label">ViciDial User (phone binding)</label>
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
                    No unclaimed ViciDial users available — create one under "ViciDial Users"
                    first, or every active one already has an app account.
                  </p>
                )}

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
                      <th>ViciDial User</th>
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
