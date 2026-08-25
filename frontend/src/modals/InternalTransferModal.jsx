import { useEffect, useState } from "react";
import { api } from "../api";

/*
==================================================
INTERNAL TRANSFER MODAL
==================================================
Per explicit request — replaces the earlier TransferExtensionModal
(Transfer-only) with a version that supports BOTH actions: pick an
agent from the list, then choose Transfer or Conference. This is now
the ONLY way to target another agent's extension at all — the shared
manual number field in MiniPhone lost its "Ext" checkbox entirely
(per explicit request) once this existed, so it's phone-number-only
now; extension-targeting lives exclusively here.

Selection is just local UI state (radio-button-style row highlight) —
nothing is sent to the backend until Transfer or Conference is
actually clicked.
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

export default function InternalTransferModal({ campaignId, onClose, onTransfer, onConference }) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedExtension, setSelectedExtension] = useState(null);
  const [busyAction, setBusyAction] = useState(null); // null | "transfer" | "conference"

  useEffect(() => {
    api
      .getCampaignAgents(campaignId)
      .then((data) => setAgents(data.agents || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [campaignId]);

  async function handleAction(action) {
    if (!selectedExtension) return;
    setBusyAction(action);
    try {
      if (action === "transfer") {
        await onTransfer(selectedExtension);
      } else {
        await onConference(selectedExtension);
      }
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ width: "min(90vw, 480px)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Internal Transfer</h3>
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
                <th></th>
                <th>Name</th>
                <th>Extension</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr
                  key={a.appUserId}
                  onClick={() => setSelectedExtension(a.extension)}
                  style={{ cursor: "pointer", background: selectedExtension === a.extension ? "#eef4ff" : undefined }}
                >
                  <td>
                    <input
                      type="radio"
                      name="internal-transfer-target"
                      checked={selectedExtension === a.extension}
                      onChange={() => setSelectedExtension(a.extension)}
                    />
                  </td>
                  <td>{a.fullName}</td>
                  <td>{a.extension}</td>
                  <td>{STATUS_LABELS[a.status] || a.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            type="button"
            className="button-secondary"
            onClick={() => handleAction("transfer")}
            disabled={!selectedExtension || busyAction !== null}
          >
            {busyAction === "transfer" ? "Transferring…" : "Transfer"}
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => handleAction("conference")}
            disabled={!selectedExtension || busyAction !== null}
          >
            {busyAction === "conference" ? "Adding…" : "Conference"}
          </button>
        </div>
      </div>
    </div>
  );
}
