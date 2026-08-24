import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import logo from "../assets/cmxlogo_white.png";

/*
==================================================
agentStatus prop — deliberately scoped to DialerPage only
==================================================
Header is shared across every page (DialerPage, Admin, Live Status,
Landing), but live call-state (READY/NOT_READY/IN_CALL/etc.) is only
ever tracked on DialerPage itself — no other page has a concept of it
at all. Rather than build a global status-tracking mechanism just for
this one button, DialerPage passes its already-known current status in
directly; every other page renders Header with no status prop at all,
so logout stays unrestricted there (there's no "mid-call" risk to
guard against on a page that was never tracking a call in the first
place). If this needs to apply more broadly later, that's a bigger
change (status would need to live somewhere shared, like AuthContext),
not just a Header tweak.

canLogout defaults to true when status is unknown (undefined) —
covers admin/no-extension accounts, which never go through these
states at all and shouldn't be blocked from logging out.
==================================================
*/
export default function Header({ agentStatus }) {
  const { agent, logout } = useAuth();

  const canLogout = agentStatus === undefined || agentStatus === "NOT_READY";

  return (
    <header className="header">
      <div className="header-logo">
        <img src={logo} alt="CallMax" />
      </div>

      {agent && (
        <div className="header-right">
          {agent.accessLevel === "admin" && (
            <>
              <Link to="/live-status" className="header-admin-link">
                Live Status
              </Link>
              <Link to="/reports" className="header-admin-link">
                Reports
              </Link>
              <Link to="/admin" className="header-admin-link">
                Admin
              </Link>
            </>
          )}
          {/* Recordings — deliberately its own condition, not folded
              into the admin-only block above, since Supervisors need
              this without the rest of what admin-only unlocks. Will
              need widening once Training & Quality/Account Manager
              roles exist. */}
          {(agent.accessLevel === "admin" || agent.accessLevel === "supervisor") && (
            <Link to="/recordings" className="header-admin-link">
              Recordings
            </Link>
          )}
          <div className="header-user">
            <div className="name">{agent.fullName}</div>
            <div className="meta">
              {agent.email} · {agent.accessLevel}
            </div>
          </div>
          <button
            className="logout-btn"
            onClick={logout}
            disabled={!canLogout}
            title={canLogout ? undefined : "Set your status to Not Ready before logging out."}
          >
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
