import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN PHONES SECTION — view/edit/delete only
==================================================
STANDALONE CREATION REMOVED, per explicit request: every phone
extension is now created ONLY as a side effect of creating a Phone
Login (see AdminVicidialUsersSection.jsx / POST /vicidial-users) —
extension/login/fullname all come from that flow's username, and
pass/conf_secret always come from .env there too. The backend's
POST /phones now returns 410 Gone if called directly.

This section still exists for viewing, editing (login/fullname/active
only — extension itself stays immutable), and deleting phones that
already exist — including any legacy standalone phones created before
this change. Deleting a Phone Login (AdminVicidialUsersSection) now
cascades to delete its phone automatically; deleting a phone directly
from HERE does NOT touch any vicidial_users row, so it's really only
meant for cleaning up orphaned/legacy phone rows.
==================================================
*/
export default function AdminPhonesSection() {
  const [phones, setPhones] = useState([]);
  const [editingExtension, setEditingExtension] = useState(null); // null = nothing selected

  const [login, setLogin] = useState("");
  const [fullname, setFullname] = useState("");
  const [active, setActive] = useState(true);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function loadPhones() {
    setLoading(true);
    api
      .getPhones()
      .then((data) => setPhones(data.phones))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadPhones();
  }, []);

  function resetForm() {
    setEditingExtension(null);
    setLogin("");
    setFullname("");
    setActive(true);
  }

  function handleStartEdit(p) {
    setEditingExtension(p.extension);
    setLogin(p.login || "");
    setFullname(p.fullname || "");
    setActive(p.active === "Y");
    setError("");
    setSuccess("");
  }

  async function handleDelete(p) {
    if (
      !window.confirm(
        `Permanently delete extension ${p.extension}? Any Phone Login currently bound to this phone will lose their phone login. This does NOT delete the Phone Login itself if one still points here — do that from the Phone Login section instead if it exists.`
      )
    ) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.deletePhone(p.extension);
      if (editingExtension === p.extension) resetForm();
      loadPhones();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!editingExtension) return;
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      await api.updatePhone(editingExtension, { login, fullname, active });
      setSuccess(`Extension ${editingExtension} updated.`);
      resetForm();
      loadPhones();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Phone Extensions</h3>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <p style={{ fontSize: 13, color: "#888" }}>
        Phone extensions are created automatically when you create a Phone Login — see the{" "}
        <strong>Phone Login</strong> section. This page is for reviewing existing extensions and
        editing or deleting them if needed.
      </p>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="dialer-layout">
          {editingExtension && (
            <div className="dialer-main">
              <div className="card">
                <form onSubmit={handleSubmit}>
                  <h4>Edit Extension {editingExtension}</h4>

                  <label className="comments-label">Login (SIP username)</label>
                  <input type="text" value={login} onChange={(e) => setLogin(e.target.value)} required />

                  <p style={{ fontSize: 13, color: "#888" }}>
                    Login and registration passwords are fixed for every phone — see
                    PHONE_LOGIN_PASSWORD / PHONE_REGISTRATION_PASSWORD in the server's .env for the
                    actual values to enter when configuring the SIP client itself.
                  </p>

                  <label className="comments-label">Full Name</label>
                  <input type="text" value={fullname} onChange={(e) => setFullname(e.target.value)} />

                  <label className="disposition-row" style={{ marginTop: 10 }}>
                    <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                    Active
                  </label>

                  <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                    <button className="button-secondary" type="submit" disabled={busy}>
                      {busy ? "Saving…" : "Save Changes"}
                    </button>
                    <button type="button" className="link" onClick={resetForm} disabled={busy}>
                      Cancel Edit
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          <div className="dialer-side">
            <div className="card call-log-card">
              <h3>Existing Phones</h3>
              {phones.length === 0 && <p>No phones yet.</p>}
              {phones.length > 0 && (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Extension</th>
                      <th>Login</th>
                      <th>Full Name</th>
                      <th>Protocol</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {phones.map((p) => (
                      <tr
                        key={p.extension}
                        className="call-log-row"
                        onDoubleClick={() => handleStartEdit(p)}
                      >
                        <td>{p.extension}</td>
                        <td>{p.login}</td>
                        <td className="admin-name-cell">{p.fullname || "—"}</td>
                        <td>{p.protocol}</td>
                        <td>{p.active === "Y" ? "Yes" : "No"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button type="button" className="link" onClick={() => handleStartEdit(p)} disabled={busy}>
                            Edit
                          </button>
                          {" · "}
                          <button type="button" className="link" onClick={() => handleDelete(p)} disabled={busy}>
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
