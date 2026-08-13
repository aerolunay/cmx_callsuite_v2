import { useEffect, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import Header from "../components/Header";
import Setup2FAModal from "../modals/Setup2FAModal";
import { useAuth } from "../context/AuthContext";

export default function LandingPage() {
  const { agent, setTotpEnabled } = useAuth();
  const [showSetupModal, setShowSetupModal] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // This Welcome/2FA-setup content should only show right after a
  // GENUINE fresh login — LoginPage.jsx tags that specific navigation
  // with justLoggedIn via router state (see its navigate("/", ...)
  // calls). Any OTHER way of landing on "/" (typing the URL, reopening
  // a tab, a bookmark to the home page) means an existing, still-valid
  // session is already in place — whether mid-call, or resumed via
  // ws.js's within-window restore on the backend — so skip straight
  // back into the app instead of making the agent click "Start
  // working a campaign" again every single time they reopen the page.
  //
  // Deliberately always /dialer, never re-deriving status here:
  // DialerPage's own mount logic already handles both rehydrating an
  // in-progress call AND bouncing to /select-campaign if no campaign
  // is stored yet, so sending everyone there is safe regardless of
  // which case actually applies — this only needs to decide whether
  // to skip itself, not re-implement that logic.
  //
  // A session that was genuinely killed (past the reconnect window)
  // forces a real login through LoginPage again either way, which DOES
  // set justLoggedIn — so this content correctly still shows in
  // exactly that one case, matching the "only after the window passed"
  // requirement.
  useEffect(() => {
    if (!location.state?.justLoggedIn) {
      navigate("/dialer", { replace: true });
    }
  }, [location.state, navigate]);

  if (!location.state?.justLoggedIn) {
    return null; // redirecting — nothing to render
  }

  return (
    <>
      <Header />
      <div className="page-content">
        <h2>Welcome, {agent.fullName.split(" ")[0]}</h2>
        <span className="badge">{agent.accessLevel}</span>

        <div className="card" style={{ marginTop: 20 }}>
          {agent.extension ? (
            <>
              <p>
                Your phone extension: <strong>{agent.extension}</strong>
              </p>
              <Link to="/select-campaign">
                <button className="button-secondary">Start working a campaign</button>
              </Link>
            </>
          ) : (
            <p>
              Your account has no phone extension assigned — you're set up as an admin/support
              account without dialing access.
            </p>
          )}
        </div>

        <div className="card">
          {agent.totpEnabled ? (
            <p>Two-factor authentication is enabled on your account.</p>
          ) : (
            <>
              <p>Two-factor authentication is currently disabled on your account.</p>
              <button className="button-secondary" onClick={() => setShowSetupModal(true)}>
                Set up an authenticator app
              </button>
            </>
          )}
        </div>
      </div>

      {showSetupModal && (
        <Setup2FAModal
          onClose={() => setShowSetupModal(false)}
          onComplete={() => setTotpEnabled(true)}
        />
      )}
    </>
  );
}
