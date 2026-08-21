import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN PHONES SECTION
==================================================
Second piece of the ViciDial-admin-migration project — see
adminRoutes.js's phones endpoints for the real schema reasoning
(composite unique key on extension+server_ip, server_ip always this
server's own fixed value, protocol always PJSIP).

NO password field at all — pass ("Login Password") and conf_secret
("Registration Password") are now FIXED, constant values read from
PHONE_LOGIN_PASSWORD/PHONE_REGISTRATION_PASSWORD in .env, applied by
the backend on every create/update. Confirmed directly against a real
production phone row, not assumed. Nothing to type here at all — the
.env file is the actual reference for whoever needs to know these
values to configure a physical/soft phone's SIP client.

Extension is treated as immutable once created, matching the backend —
editing a phone can change login/fullname/active, but not which
extension number it answers to. Changing that means delete + recreate.
==================================================
*/
export default function AdminPhonesSection() {
  const [phones, setPhones] = useState([]);
  const [editingExtension, setEditingExtension] = useState(null); // null = create mode

  const [extension, setExtension] = useState("");
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
    setExtension("");
    setLogin("");
    setFullname("");
    setActive(true);
  }

  function handleStartEdit(p) {
    setEditingExtension(p.extension);
    setExtension(p.extension);
    setLogin(p.login || "");
    setFullname(p.fullname || "");
    setActive(p.active === "Y");
    setError("");
    setSuccess("");
  }

  async function handleDelete(p) {
    if (
      !window.confirm(
        `Permanently delete extension ${p.extension}? Any ViciDial user currently bound to this phone will lose their phone login.`
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
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      if (editingExtension) {
        await api.updatePhone(editingExtension, { login, fullname, active });
        setSuccess(`Extension ${editingExtension} updated.`);
      } else {
        await api.createPhone({ extension, login, fullname, active });
        setSuccess(`Extension ${extension} created.`);
      }

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
      <h3>{editingExtension ? `Edit Extension ${editingExtension}` : "Create Phone Extension"}</h3>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card">
              <form onSubmit={handleSubmit}>
                <label className="comments-label">Extension</label>
                <input
                  type="text"
                  value={extension}
                  onChange={(e) => setExtension(e.target.value)}
                  placeholder="e.g. 90099"
                  required
                  disabled={Boolean(editingExtension)}
                />
                {editingExtension && (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    Extension can't be changed once created — delete and recreate instead.
                  </p>
                )}

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
                    {busy ? "Saving…" : editingExtension ? "Save Changes" : "Create Extension"}
                  </button>
                  {editingExtension && (
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
