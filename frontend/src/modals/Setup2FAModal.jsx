import { useState } from "react";
import { api } from "../api";

// Reusable TOTP enrollment modal — used both right after a fresh OTP
// login (from LoginPage's "set up now?" prompt) and later from the
// landing page's "Set up an authenticator app" link. Kept as one
// component so both call sites share the same QR/confirm logic instead
// of drifting apart over time.
export default function Setup2FAModal({ onClose, onComplete }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function startSetup() {
    setError("");
    setBusy(true);
    try {
      const data = await api.totpSetup();
      setQrDataUrl(data.qrDataUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.totpConfirm(code);
      setDone(true);
      onComplete && onComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <h3>Set up an authenticator app</h3>

        {!qrDataUrl && !done && (
          <>
            <p>
              Scan a QR code with Google Authenticator, Authy, or a similar app, then confirm
              with the code it generates.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="modal-actions">
              <button className="button-secondary" onClick={startSetup} disabled={busy}>
                {busy ? "Starting…" : "Start setup"}
              </button>
              <button className="link" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {qrDataUrl && !done && (
          <>
            <img
              src={qrDataUrl}
              alt="Scan this QR code"
              style={{ display: "block", margin: "0 auto 16px" }}
            />
            {error && <div className="error">{error}</div>}
            <form onSubmit={confirmSetup}>
              <input
                type="text"
                inputMode="numeric"
                placeholder="6-digit code from your app"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={6}
                required
                autoFocus
              />
              <div className="modal-actions">
                <button className="button-secondary" type="submit" disabled={busy}>
                  {busy ? "Confirming…" : "Confirm"}
                </button>
                <button type="button" className="link" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}

        {done && (
          <>
            <p className="success">Authenticator enabled. You can sign in with it next time.</p>
            <div className="modal-actions">
              <button className="button-secondary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
