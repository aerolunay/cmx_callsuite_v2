import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import logo from "../assets/cmxlogo_white.png";

export default function Header() {
  const { agent, logout } = useAuth();

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
              <Link to="/admin" className="header-admin-link">
                Admin
              </Link>
            </>
          )}
          <div className="header-user">
            <div className="name">{agent.fullName}</div>
            <div className="meta">
              {agent.email} · {agent.accessLevel}
            </div>
          </div>
          <button className="logout-btn" onClick={logout}>
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
