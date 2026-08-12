import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Header from "../components/Header";
import Setup2FAModal from "../modals/Setup2FAModal";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";

export default function LandingPage() {
  const { agent, setTotpEnabled } = useAuth();
  const [showSetupModal, setShowSetupModal] = useState(false);
  const navigate = useNavigate();

  // If the agent has an active call (IN_CALL) or is mid-wrap-up
  // (AFTER_CALL_WORK), send them straight back to the dialer instead of
  // showing this landing page — this is what makes "closed the app
  // mid-call, logged back in" land them back where they actually were.
  // DialerPage itself handles restoring the call/lead details once it
  // mounts; this just gets them to the right screen first.
  useEffect(() => {
    api
      .getStatus()
      .then((data) => {
        if (
          data.status &&
          (data.status.status === "IN_CALL" ||
            data.status.status === "AFTER_CALL_WORK" ||
            data.status.status === "ON_HOLD")
        ) {
          navigate("/dialer");
        }
      })
      .catch(() => {});
  }, [navigate]);

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
