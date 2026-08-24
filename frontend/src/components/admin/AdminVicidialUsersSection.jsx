import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN PHONE LOGIN SECTION — standalone
==================================================
Creates/manages asterisk.vicidial_users rows (labeled "Phone Login" in
this UI, since that's what the value actually functions as — a login
that doubles as the phone extension/login/callerid) independently of
app_users entirely — matching admin.php's own separation, per explicit
request. A Phone Login created here is immediately available in
AdminUsersSection's "bind to an existing Phone Login" dropdown, exactly
like any pre-existing account.

Creating a Phone Login here also creates its matching phone extension
(asterisk.phones row) by default — see the checkbox below. Standalone
phone-extension creation has been removed entirely (see
AdminPhonesSection.jsx) — a phone now only ever comes from this flow.
Deleting a Phone Login here also deletes its phone extension.

username is treated as immutable once created (same reasoning as
Phones' extension field used to have) — renaming a live login mid-use
risks orphaning whatever it's bound to elsewhere.
==================================================
*/
export default function AdminVicidialUsersSection() {
  const [vicidialUsers, setVicidialUsers] = useState([]);
  const [editingUsername, setEditingUsername] = useState(null); // null = create mode

  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [userLevel, setUserLevel] = useState("1");
  const [userGroup, setUserGroup] = useState("");
  const [active, setActive] = useState(true);

  // Phone extension is created alongside the ViciDial user by default.
  // Checked + disabled unless userLevel is 7, 8, or 9 — those levels
  // are the only ones allowed to opt a user out of getting a phone.
  const [createPhoneExtension, setCreatePhoneExtension] = useState(true);
  const numericUserLevel = Number(userLevel) || 1;
  const canTogglePhoneExtension = [7, 8, 9].includes(numericUserLevel);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function loadAll() {
    setLoading(true);
    api
      .getVicidialUsers()
      .then((data) => setVicidialUsers(data.vicidialUsers))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (!canTogglePhoneExtension) {
      setCreatePhoneExtension(true);
    }
  }, [canTogglePhoneExtension]);

  function resetForm() {
    setEditingUsername(null);
    setUsername("");
    setFullName("");
    setUserLevel("1");
    setUserGroup("");
    setActive(true);
    setCreatePhoneExtension(true);
  }

  function handleStartEdit(vu) {
    setEditingUsername(vu.user);
    setUsername(vu.user);
    setFullName(vu.full_name || "");
    setUserLevel(String(vu.user_level ?? "1"));
    setUserGroup(vu.user_group || "");
    setActive(vu.active === "Y");
    setError("");
    setSuccess("");
  }

  async function handleDelete(vu) {
    if (
      !window.confirm(
        `Permanently delete Phone Login ${vu.user}? This also deletes its matching phone extension, if one exists. This can't be undone. If it's still bound to an app user, this will be blocked until you unbind it first.`
      )
    ) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.deleteVicidialUser(vu.user);
      if (editingUsername === vu.user) resetForm();
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
      if (editingUsername) {
        await api.updateVicidialUser(editingUsername, {
          fullName,
          userLevel: userLevel ? Number(userLevel) : 1,
          userGroup: userGroup || null,
          active,
        });
        setSuccess(`Phone Login ${editingUsername} updated.`);
      } else {
        const result = await api.createVicidialUser({
          username,
          fullName,
          userLevel: userLevel ? Number(userLevel) : 1,
          userGroup: userGroup || null,
          active,
          createPhoneExtension,
        });
        setSuccess(
          result?.phoneCreated
            ? `Phone Login ${username} created, with a matching phone extension.`
            : `Phone Login ${username} created (no phone extension, per selection).`
        );
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
      <h3>{editingUsername ? `Edit Phone Login ${editingUsername}` : "Create Phone Login"}</h3>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card">
              <form onSubmit={handleSubmit}>
                <label className="comments-label">Phone Login</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. 90099"
                  required
                  disabled={Boolean(editingUsername)}
                />
                {editingUsername && (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    Phone Login can't be changed once created — delete and recreate instead.
                  </p>
                )}

                <label className="comments-label">Full Name</label>
                <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />

                <p style={{ fontSize: 13, color: "#888", margin: "4px 0 10px" }}>
                  This Phone Login value also becomes the phone's extension, login, and caller
                  name (if a phone extension is created below) — no separate entry needed.
                </p>

                <label className="comments-label">User Level</label>
                <input
                  type="number"
                  value={userLevel}
                  onChange={(e) => setUserLevel(e.target.value)}
                  min="1"
                  max="9"
                />

                <label className="comments-label">User Group</label>
                <input type="text" value={userGroup} onChange={(e) => setUserGroup(e.target.value)} />

                <label className="disposition-row" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                  Active
                </label>

                {!editingUsername && (
                  <label className="disposition-row" style={{ marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={createPhoneExtension}
                      disabled={!canTogglePhoneExtension}
                      onChange={(e) => setCreatePhoneExtension(e.target.checked)}
                    />
                    Create Phone Extension for this account
                    {!canTogglePhoneExtension && (
                      <span style={{ fontSize: 12, color: "#888", marginLeft: 6 }}>
                        (only optional for User Level 7, 8, or 9)
                      </span>
                    )}
                  </label>
                )}

                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button className="button-secondary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : editingUsername ? "Save Changes" : "Create Phone Login"}
                  </button>
                  {editingUsername && (
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
              <h3>Existing Phone Logins</h3>
              {vicidialUsers.length === 0 && <p>No Phone Logins yet.</p>}
              {vicidialUsers.length > 0 && (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Phone Login</th>
                      <th>Full Name</th>
                      <th>Phone</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vicidialUsers.map((vu) => (
                      <tr key={vu.user} className="call-log-row" onDoubleClick={() => handleStartEdit(vu)}>
                        <td>{vu.user}</td>
                        <td className="admin-name-cell">{vu.full_name || "—"}</td>
                        <td>{vu.phone_login || "—"}</td>
                        <td>{vu.active === "Y" ? "Yes" : "No"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button type="button" className="link" onClick={() => handleStartEdit(vu)} disabled={busy}>
                            Edit
                          </button>
                          {" · "}
                          <button type="button" className="link" onClick={() => handleDelete(vu)} disabled={busy}>
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
