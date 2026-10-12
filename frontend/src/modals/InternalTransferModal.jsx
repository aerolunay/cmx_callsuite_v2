import { useState } from "react";

/*
==================================================
INTERNAL TRANSFER MODAL
==================================================
Per explicit request — replaces the earlier TransferExtensionModal
with a version that shows real agents on the same campaign to pick
from, instead of typing an extension blind. This is now the ONLY way
to target another agent's extension at all — the shared manual number
field in MiniPhone lost its "Ext" checkbox entirely once this existed,
so it's phone-number-only now; extension-targeting lives exclusively
here.

UPDATED — Conference and Transfer are now the same underlying action
(add someone to the call, no auto-hangup — the agent's own later
choice to hang up or stay on is what actually distinguishes a handoff
from a true 3-way, not the button). This modal now has a single
Transfer action instead of two.

UPDATED, per explicit request — lists only agents who can actually
take the transfer right now (status READY), supplied by MiniPhone via
the shared useAvailableTransferAgents hook so this list and the
Internal Transfer button's enabled state always agree. agents is null
while the first load is still in flight. A note underneath points
agents to Line 2 for outside numbers, which this modal can't dial.

Selection is just local UI state (radio-button-style row highlight) —
nothing is sent to the backend until Transfer is actually clicked.
==================================================
*/
export default function InternalTransferModal({ agents, error, onClose, onTransfer }) {
  const [selectedExtension, setSelectedExtension] = useState(null);
  const [busy, setBusy] = useState(false);

  // The list refreshes while the modal is open — if the picked agent
  // stops being Ready in the meantime, their row disappears and the
  // selection no longer counts.
  const selectionAvailable = Boolean(agents?.some((a) => a.extension === selectedExtension));

  async function handleTransferClick() {
    if (!selectionAvailable) return;
    setBusy(true);
    try {
      await onTransfer(selectedExtension);
    } finally {
      setBusy(false);
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

        {agents === null ? (
          <p>Loading…</p>
        ) : agents.length === 0 ? (
          <p>No agents on this campaign are Ready right now.</p>
        ) : (
          <table className="call-log-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Extension</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            type="button"
            className="button-secondary"
            onClick={handleTransferClick}
            disabled={!selectionAvailable || busy}
          >
            {busy ? "Transferring…" : "Transfer"}
          </button>
        </div>

        <p style={{ fontSize: 13, color: "#667085", margin: "14px 0 0" }}>
          Transferring to an outside number? Use <strong>Line 2</strong> instead: put this call on hold, switch to Line
          2, dial the number, then use Connect Line 1.
        </p>
      </div>
    </div>
  );
}
