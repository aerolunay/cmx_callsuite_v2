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
  // REAL BUG FIX, confirmed via a real reproduction: this used to
  // unconditionally send EVERY role to /dialer here, on the assumption
  // ("DialerPage's own mount logic already handles... so sending
  // everyone there is safe regardless") that predates DialerPage.jsx
  // later being restricted to only agent/supervisor/training_quality.
  // For any OTHER role, that assumption became actively wrong:
  // DialerPage.jsx bounces them straight back to "/" with a fresh
  // <Navigate> (no justLoggedIn state on that bounce-back), which
  // immediately re-triggered THIS effect, which sent them back to
  // /dialer again — a genuine, confirmed infinite redirect loop,
  // reproduced live with an account_manager login, that Chrome's own
  // navigation-throttling protection eventually flooded the console
  // over ("Throttling navigation to prevent the browser from
  // hanging").
  //
  // Fixed by making this redirect role-aware, per explicit request:
  //   - agent/supervisor -> /dialer (they actively work campaigns —
  //     the dialer IS their default landing spot)
  //   - training_quality -> /live-status ("Agent Status" — lands here
  //     by default even though, per CampaignSelectPage.jsx's own new
  //     role guard below, they CAN still navigate to /dialer and
  //     select campaigns to work when needed; this only decides where
  //     they land automatically on login, not what they're allowed to
  //     do)
  //   - admin/wfm -> /admin
  //   - everyone else (account_manager, and any future role not yet
  //     covered above) -> /live-status (matches
  //     LiveStatusDashboard.jsx's own allow-list, which already
  //     explicitly includes account_manager)
  useEffect(() => {
    if (location.state?.justLoggedIn) return;
    if (!agent) return;

    if (["agent", "supervisor"].includes(agent.accessLevel)) {
      navigate("/dialer", { replace: true });
    } else if (["admin", "wfm"].includes(agent.accessLevel)) {
      navigate("/admin", { replace: true });
    } else {
      // training_quality, account_manager, and anything else not
      // covered above.
      navigate("/live-status", { replace: true });
    }
  }, [location.state, agent, navigate]);

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
