import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN TRUNKS SECTION — NEW, per explicit request
==================================================
Fills in the "DID / Trunk Setup" placeholder that's sat in AdminPage.jsx
since Campaigns first went live. Lets an admin add/edit/remove an
outbound SIP trunk (e.g. another Telpeer extension, each pre-configured
on Telpeer's own portal with a different Caller ID) directly through the
app — no more hand-writing pjsip.conf blocks over SSH every time one's
needed.

trunk_name is immutable once created (same reasoning as phone
extensions elsewhere in this app) — campaigns reference it directly via
their own Outbound Trunk setting, so renaming would silently orphan
anything already pointing at the old name. Password is optional on
edit — leave blank to keep the current one, same convention already
used for campaign audio uploads elsewhere in this app.

The built-in "CMXCallSuite" trunk (QuestBlue, hand-maintained,
pre-existing) deliberately never appears here — this page only manages
trunks created THROUGH it.
==================================================
*/
export default function AdminTrunksSection() {
  const [trunks, setTrunks] = useState([]);
  const [editingTrunkId, setEditingTrunkId] = useState(null); // null = create mode

  const [trunkName, setTrunkName] = useState("");
  const [sipUsername, setSipUsername] = useState("");
  const [sipPassword, setSipPassword] = useState("");
  const [sipServer, setSipServer] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function loadTrunks() {
    setLoading(true);
    api
      .getTrunks()
      .then((data) => setTrunks(data.trunks || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadTrunks();
  }, []);

  function resetForm() {
    setEditingTrunkId(null);
    setTrunkName("");
    setSipUsername("");
    setSipPassword("");
    setSipServer("");
    setDescription("");
    setActive(true);
    setError("");
    setSuccess("");
  }

  function handleStartEdit(t) {
    setEditingTrunkId(t.trunk_id);
    setTrunkName(t.trunk_name);
    setSipUsername(t.sip_username || "");
    setSipPassword(""); // never pre-filled — blank means "keep current" on save
    setSipServer(t.sip_server || "");
    setDescription(t.description || "");
    setActive(t.active === 1 || t.active === true);
    setError("");
    setSuccess("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const payload = { sipUsername, sipPassword, sipServer, description, active };
      let result;
      if (editingTrunkId) {
        result = await api.updateTrunk(editingTrunkId, payload);
      } else {
        result = await api.createTrunk({ trunkName, ...payload });
      }
      setSuccess(result.reloadWarning || "Trunk saved.");
      resetForm();
      loadTrunks();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(t) {
    if (!window.confirm(`Delete trunk "${t.trunk_name}"? This can't be undone.`)) return;
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const result = await api.deleteTrunk(t.trunk_id);
      setSuccess(result.reloadWarning || "Trunk deleted.");
      loadTrunks();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 style={{ marginTop: 0 }}>DID / Trunk Setup</h3>
      <p style={{ fontSize: 13, color: "#888" }}>
        The built-in QuestBlue trunk (CMXCallSuite) is hand-maintained and doesn't appear here.
        Add additional outbound trunks below — e.g. another Telpeer extension pre-configured with a
        different Caller ID on Telpeer's own portal.
      </p>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="live-status-grid">
          <div>
            <form onSubmit={handleSubmit}>
              <div className="card">
                <h4 style={{ marginTop: 0 }}>{editingTrunkId ? `Edit "${trunkName}"` : "Add a Trunk"}</h4>

                {!editingTrunkId && (
                  <>
                    <label className="comments-label">Trunk Name</label>
                    <input
                      type="text"
                      value={trunkName}
                      onChange={(e) => setTrunkName(e.target.value)}
                      placeholder="Letters, numbers, and dashes only"
                      required
                    />
                  </>
                )}

                <label className="comments-label">SIP Username / Extension</label>
                <input type="text" value={sipUsername} onChange={(e) => setSipUsername(e.target.value)} required />

                <label className="comments-label">SIP Password</label>
                <input
                  type="password"
                  value={sipPassword}
                  onChange={(e) => setSipPassword(e.target.value)}
                  placeholder={editingTrunkId ? "Leave blank to keep the current password" : ""}
                  required={!editingTrunkId}
                />

                <label className="comments-label">SIP Server</label>
                <input
                  type="text"
                  value={sipServer}
                  onChange={(e) => setSipServer(e.target.value)}
                  placeholder="e.g. callmaxmgmt.tekpeer.com"
                  required
                />

                <label className="comments-label">Description (optional)</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Sales line spoofing"
                />

                {editingTrunkId && (
                  <label className="disposition-row" style={{ marginTop: 10 }}>
                    <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                    Active
                  </label>
                )}

                <div style={{ marginTop: 16 }}>
                  <button className="button-secondary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : editingTrunkId ? "Save Changes" : "Add Trunk"}
                  </button>{" "}
                  {editingTrunkId && (
                    <button type="button" className="link" onClick={resetForm} disabled={busy}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>

          <div>
            <div className="card call-log-card">
              <h4 style={{ marginTop: 0 }}>Existing Trunks</h4>
              {trunks.length === 0 ? (
                <p>No trunks added yet.</p>
              ) : (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Username</th>
                      <th>Server</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trunks.map((t) => (
                      <tr key={t.trunk_id} className="call-log-row" onDoubleClick={() => handleStartEdit(t)}>
                        <td>{t.trunk_name}</td>
                        <td>{t.sip_username}</td>
                        <td>{t.sip_server}</td>
                        <td>{t.active ? "Yes" : "No"}</td>
                        <td>
                          <button type="button" className="link" onClick={() => handleStartEdit(t)} disabled={busy}>
                            Edit
                          </button>{" "}
                          <button type="button" className="link" onClick={() => handleDelete(t)} disabled={busy}>
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
