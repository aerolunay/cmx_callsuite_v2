import { useEffect, useState } from "react";
import { api } from "../api";

/*
==================================================
TRANSFER EXTENSION MODAL
==================================================
Per explicit request: instead of blindly typing an extension number
into MiniPhone's shared number field, this shows real agents assigned
to the SAME campaign as the active call, with their live status, so
the transferring agent can pick someone rather than guess an
extension. Deliberately a separate component/file from MiniPhone
itself, per explicit request — MiniPhone stays focused on the actual
phone controls; this owns the picker UI on its own.

Reuses the app's existing .modal-overlay/.modal-card classes (see
Setup2FAModal.jsx) for visual consistency with every other modal
already in this app.

onSelect(extension) — called with the chosen agent's real extension
when "Transfer" is clicked on their row. The caller (MiniPhone) is
responsible for actually invoking onTransferBlind with it; this modal
only picks, it doesn't perform the transfer itself.
==================================================
*/
const STATUS_LABELS = {
  READY: "Ready",
  NOT_READY: "Not Ready",
  IN_CALL: "On a Call",
  ON_HOLD: "On Hold",
  AFTER_CALL_WORK: "After Call Work",
  MICROSIP_OUTBOUND: "On a Call",
  LOGGED_OUT: "Logged Out",
  AD_HOC: "Ad Hoc",
  LUNCH_BREAK: "Lunch/Break",
  BIO_BREAK: "Bio Break",
  ADMIN: "Admin",
  MEETING: "Meeting",
  TRAINING: "Training",
};

export default function TransferExtensionModal({ campaignId, onClose, onSelect }) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getCampaignAgents(campaignId)
      .then((data) => setAgents(data.agents || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [campaignId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ width: "min(90vw, 480px)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Transfer to Extension</h3>
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {loading ? (
          <p>Loading…</p>
        ) : agents.length === 0 ? (
          <p>No other agents are assigned to this campaign.</p>
        ) : (
          <table className="call-log-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Extension</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.appUserId}>
                  <td>{a.fullName}</td>
                  <td>{a.extension}</td>
                  <td>{STATUS_LABELS[a.status] || a.status}</td>
                  <td>
                    <button type="button" className="link" onClick={() => onSelect(a.extension)}>
                      Transfer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
