import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN VICIDIAL USERS SECTION — standalone
==================================================
Creates/manages asterisk.vicidial_users rows independently of app_users
entirely — matching admin.php's own separation, per explicit request.
A user created here is immediately available in AdminUsersSection's
"bind to an existing ViciDial user" dropdown, exactly like any
pre-existing account.

username is treated as immutable once created (same reasoning as
Phones' extension field) — renaming a live ViciDial username mid-use
risks orphaning whatever it's bound to elsewhere.
==================================================
*/
export default function AdminVicidialUsersSection() {
  const [vicidialUsers, setVicidialUsers] = useState([]);
  const [editingUsername, setEditingUsername] = useState(null); // null = create mode

  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [phoneLogin, setPhoneLogin] = useState("");
  const [phonePass, setPhonePass] = useState("");
  const [userLevel, setUserLevel] = useState("1");
  const [userGroup, setUserGroup] = useState("");
  const [email, setEmail] = useState("");
  const [active, setActive] = useState(true);

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

  function resetForm() {
    setEditingUsername(null);
    setUsername("");
    setFullName("");
    setPhoneLogin("");
    setPhonePass("");
    setUserLevel("1");
    setUserGroup("");
    setEmail("");
    setActive(true);
  }

  function handleStartEdit(vu) {
    setEditingUsername(vu.user);
    setUsername(vu.user);
    setFullName(vu.full_name || "");
    setPhoneLogin(vu.phone_login || "");
    // Password deliberately left blank on edit — same reasoning as
    // Phones: blank means "keep current," never pre-fill a real value.
    setPhonePass("");
    setUserLevel(String(vu.user_level ?? "1"));
    setUserGroup(vu.user_group || "");
    setEmail(vu.email || "");
    setActive(vu.active === "Y");
    setError("");
    setSuccess("");
  }

  async function handleDelete(vu) {
    if (
      !window.confirm(
        `Permanently delete ViciDial user ${vu.user}? This can't be undone. If it's still bound to an app user, this will be blocked until you unbind it first.`
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
        const payload = {
          fullName,
          phoneLogin: phoneLogin || null,
          userLevel: userLevel ? Number(userLevel) : 1,
          userGroup: userGroup || null,
          email: email || null,
          active,
        };
        if (phonePass.trim()) payload.phonePass = phonePass.trim();
        await api.updateVicidialUser(editingUsername, payload);
        setSuccess(`ViciDial user ${editingUsername} updated.`);
      } else {
        await api.createVicidialUser({
          username,
          fullName,
          phoneLogin: phoneLogin || null,
          phonePass: phonePass || null,
          userLevel: userLevel ? Number(userLevel) : 1,
          userGroup: userGroup || null,
          email: email || null,
          active,
        });
        setSuccess(`ViciDial user ${username} created.`);
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
      <h3>{editingUsername ? `Edit ViciDial User ${editingUsername}` : "Create ViciDial User"}</h3>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card">
              <form onSubmit={handleSubmit}>
                <label className="comments-label">Username</label>
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
                    Username can't be changed once created — delete and recreate instead.
                  </p>
                )}

                <label className="comments-label">Full Name</label>
                <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />

                <label className="comments-label">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

                <label className="comments-label">Phone Login (extension binding)</label>
                <input
                  type="text"
                  value={phoneLogin}
                  onChange={(e) => setPhoneLogin(e.target.value)}
                  placeholder="Matches an extension under Phone Extensions"
                />

                <label className="comments-label">
                  Phone Password {editingUsername && "(leave blank to keep current)"}
                </label>
                <input type="text" value={phonePass} onChange={(e) => setPhonePass(e.target.value)} />

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

                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button className="button-secondary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : editingUsername ? "Save Changes" : "Create ViciDial User"}
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
              <h3>Existing ViciDial Users</h3>
              {vicidialUsers.length === 0 && <p>No ViciDial users yet.</p>}
              {vicidialUsers.length > 0 && (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Username</th>
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
