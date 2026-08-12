import { useState } from "react";
import { Link } from "react-router-dom";
import Header from "../components/Header";
import Setup2FAModal from "../modals/Setup2FAModal";
import { useAuth } from "../context/AuthContext";

export default function LandingPage() {
  const { agent, setTotpEnabled } = useAuth();
  const [showSetupModal, setShowSetupModal] = useState(false);

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
